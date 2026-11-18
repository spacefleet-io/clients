/**
 * Reactive store wrapping the pure `playbackPhase` reducer.
 *
 * Phase 3.2e of the playback-engine hardening. The
 * pure reducer in `./playbackPhase` produces a new state on each
 * dispatch — this store gives React components a `useSyncExternalStore`-
 * compatible subscription so consumers re-render only when the phase
 * actually changes (the reducer returns the SAME reference for no-op
 * transitions, and the dispatcher's identity check bails before
 * notifying listeners).
 *
 * Mirrors the listener-set + pull-snapshot pattern from
 * `./useMpvLifecycleStore`. The store is intentionally simpler — it
 * owns its snapshot directly rather than caching a per-client cell —
 * because there is exactly one playback session in flight at a time.
 *
 * Why a store rather than `useState<PlaybackPhase>` in the engine hook:
 * the engine's launch flow dispatches several phase events in a single
 * synchronous burst (start_load → reload_branch → stream_loadfile_done
 * → load_settled, all within one async tick). A `useState` setter
 * would force every dispatch to be batched-safe and could tear during
 * the burst. The store's snapshot is updated synchronously inside
 * `dispatch`, and `useSyncExternalStore`'s tearing-safe path notifies
 * React when the burst settles.
 */

import { useCallback, useSyncExternalStore } from "react";

import {
  initialPhase,
  reducePhase,
  type PhaseEvent,
  type PlaybackPhase,
} from "./playbackPhase";

export type PlaybackPhaseStore = {
  /** Current phase snapshot. Stable identity across no-op dispatches. */
  getSnapshot(): PlaybackPhase;
  /** Register a listener. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /**
   * Dispatch a phase event. Runs the pure reducer and notifies
   * subscribers only when the resulting state differs by reference
   * (the reducer returns the SAME reference for events that don't
   * affect the relevant slice — e.g. `stream_loadfile_done` while
   * already in `playing`).
   */
  dispatch(event: PhaseEvent): void;
};

export const createPlaybackPhaseStore = (): PlaybackPhaseStore => {
  let snapshot: PlaybackPhase = initialPhase;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispatch: (event) => {
      const next = reducePhase(snapshot, event);
      if (next === snapshot) return;
      snapshot = next;
      for (const listener of listeners) listener();
    },
  };
};

/**
 * React hook: subscribe to a `PlaybackPhaseStore` and return its
 * current phase. Components re-render on EVERY phase reference change
 * (including cross-cutting field updates like stamp_launched_key,
 * set_intent_pending, set_reload_signature). Prefer
 * `usePlaybackPhaseSelector` when only a derived slice is needed.
 *
 * The store argument's identity must be stable across renders
 * (typically wrapped in `useMemo(() => createPlaybackPhaseStore(), [])`
 * at the engine's top scope).
 */
export const usePlaybackPhase = (store: PlaybackPhaseStore): PlaybackPhase =>
  useSyncExternalStore(store.subscribe, store.getSnapshot);

/**
 * React hook: subscribe to a slice of the phase via a selector.
 * Components re-render only when the selector's RESULT changes
 * (`Object.is` comparison, the same check `useSyncExternalStore` uses).
 *
 * Use this when a consumer needs a derived value (e.g. a boolean
 * predicate like `deriveIsReadyToReveal(phase)`) and shouldn't re-render
 * for unrelated phase mutations (e.g. `set_reload_signature` doesn't
 * change `deriveIsReadyToReveal`'s output).
 *
 * The selector argument's identity must be stable across renders
 * (wrap it in `useCallback` if it captures props/state).
 */
export const usePlaybackPhaseSelector = <T>(
  store: PlaybackPhaseStore,
  selector: (phase: PlaybackPhase) => T,
): T => {
  const getSnapshot = useCallback(
    () => selector(store.getSnapshot()),
    [store, selector],
  );
  return useSyncExternalStore(store.subscribe, getSnapshot);
};
