/**
 * Tier-5 — React hook that wraps `MpvClient.subscribeLifecycle()` in a
 * `useSyncExternalStore` so renderer components consume the lifecycle
 * state as a stable snapshot. Replaces the 7 lifecycle refs scattered
 * across `useMpvPlaybackEngine.ts` with one explicit subscription.
 *
 * Precedent: `useNotificationStore` at
 * `packages/desktop-shell/src/services/notifications.ts:131-136`.
 *
 * Snapshot identity: the underlying client caches the latest
 * `LifecycleState` object and re-delivers it by reference on no-op
 * transitions (duplicate socket_ready, out-of-order vo_configured), so
 * React's `Object.is` check bails out and no re-render fires.
 */

import { useCallback, useSyncExternalStore } from "react";

import type { LifecycleState, MpvClient } from "@space/mpv-protocol";

const IDLE_STATE: LifecycleState = { kind: "idle" };

/**
 * Per-client cache populated by the `subscribeLifecycle` synchronous-on-
 * register delivery. The same `subscribe` registration that drives
 * `useSyncExternalStore`'s notify path also updates this cache, so
 * `getSnapshot` reads the latest state.
 *
 * A `WeakMap` keyed by `MpvClient` instance keeps the cache scoped to
 * the client's lifetime — GC takes care of cleanup when the client is
 * disposed and no other references survive.
 */
const clientStateCache = new WeakMap<MpvClient, { current: LifecycleState }>();

const cellFor = (client: MpvClient): { current: LifecycleState } => {
  let cell = clientStateCache.get(client);
  if (cell) return cell;
  cell = { current: IDLE_STATE };
  clientStateCache.set(client, cell);
  // Bootstrap the cache by reading the client's current state via a
  // throwaway subscription. The client delivers the current state
  // synchronously on register, so the cell is populated before the
  // unsubscribe fires.
  const unsubscribe = client.subscribeLifecycle((state) => {
    cell!.current = state;
  });
  unsubscribe();
  return cell;
};

/**
 * Subscribe to `MpvClient` lifecycle state inside a React component.
 *
 * Pass `null` (e.g. before the client is constructed) to receive the
 * idle sentinel without subscribing. The hook re-subscribes when the
 * client identity changes so swapping clients across a strict-mode
 * remount is safe.
 */
export const useMpvLifecycleStore = (
  client: MpvClient | null,
): LifecycleState => {
  // `subscribe` and `getSnapshot` MUST be referentially stable across
  // renders. `useSyncExternalStore` re-runs `subscribe` whenever its
  // identity changes — and `subscribeLifecycle` delivers the current
  // state *synchronously during registration* (it calls the callback
  // before returning, see the bootstrap in `cellFor` above). An inline
  // closure rebuilt every render therefore causes:
  //
  //   render → new `subscribe` identity → React re-subscribes after the
  //   commit → `subscribeLifecycle` synchronously fires `notify()` →
  //   schedules another render → … (infinite render loop)
  //
  // Memoizing both closures on `client` collapses that to one
  // subscription for the client's lifetime; the synchronous on-register
  // delivery then fires `notify()` exactly once.
  const subscribe = useCallback(
    (notify: () => void) => {
      if (!client) return () => undefined;
      const cell = cellFor(client);
      return client.subscribeLifecycle((state) => {
        cell.current = state;
        notify();
      });
    },
    [client],
  );
  const getSnapshot = useCallback(
    (): LifecycleState => (client ? cellFor(client).current : IDLE_STATE),
    [client],
  );
  return useSyncExternalStore(subscribe, getSnapshot);
};
