// @vitest-environment jsdom
/**
 * @bugfix @regression-proof
 *
 * Regression: `useMpvLifecycleStore` (Tier-5, commit 220b730c) passed
 * freshly-built `subscribe` / `getSnapshot` closures to
 * `useSyncExternalStore` on every render. `MpvClient.subscribeLifecycle`
 * delivers the current state SYNCHRONOUSLY during registration (it
 * invokes the callback before returning), and `useSyncExternalStore`
 * re-runs `subscribe` whenever its identity changes — so every render
 * produced:
 *
 *   render -> new `subscribe` identity -> React re-subscribes after the
 *   commit -> `subscribeLifecycle` synchronously fires `notify()` ->
 *   schedules another render -> ...   (infinite render loop)
 *
 * Observed live via Electron MCP: playing from the media modal pegged
 * the renderer with hundreds of `Controller.requestIdEffect` renders,
 * re-fired the launch pipeline several times (mpv stutter / restart),
 * and kept looping for 85+ seconds so the app was slow to close.
 *
 * Fix: memoize `subscribe` and `getSnapshot` with `useCallback` keyed on
 * `client`. A referentially-stable client then yields exactly one live
 * subscription (plus the one-shot bootstrap read inside `cellFor`), and
 * the synchronous on-register delivery fires `notify()` just once.
 *
 * This test renders the hook with a stable mock client whose
 * `subscribeLifecycle` delivers synchronously on register and asserts
 * the registration + render counts stay bounded. Pre-fix both explode
 * (React aborts the loop with "Maximum update depth exceeded").
 */
import React from "react";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";

import { useMpvLifecycleStore } from "@space/desktop-mpv-playback";
import type { LifecycleState, MpvClient } from "@space/mpv-protocol";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root && container) {
    act(() => root?.unmount());
  }
  root = null;
  container?.parentNode?.removeChild(container);
  container = null;
});

type LifecycleCb = (state: LifecycleState) => void;

/**
 * Minimal MpvClient stub — only `subscribeLifecycle` is exercised. It
 * mirrors the production contract precisely: the current state is
 * delivered SYNCHRONOUSLY during registration (before the function
 * returns). That synchronous delivery is what turns an unstable
 * `subscribe` closure into an infinite render loop.
 */
const makeStubClient = () => {
  let registrations = 0;
  const subscribers = new Set<LifecycleCb>();
  const client = {
    subscribeLifecycle(cb: LifecycleCb) {
      registrations += 1;
      subscribers.add(cb);
      cb({ kind: "idle" });
      return () => {
        subscribers.delete(cb);
      };
    },
  };
  return {
    client: client as unknown as MpvClient,
    getRegistrations: () => registrations,
  };
};

// On assertion failure, dump the subscribe-registration count + render count +
// last snapshot. Pre-fix these numbers explode (React aborts at the update-depth
// cap) so the dump immediately reveals the loop.
const dumpRenderLoopSnapshot = (
  label: string,
  ctx: { registrations?: number; renderCount?: number; snapshot?: unknown; afterMount?: number },
) => {
  try {
    console.error(`=== [mpv-lifecycle-store-render-loop:${label}] snapshot ===`);
    console.error(
      `registrations=${ctx.registrations} renderCount=${ctx.renderCount} afterMount=${ctx.afterMount} snapshot=${JSON.stringify(ctx.snapshot)}`,
    );
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("@bugfix @regression-proof useMpvLifecycleStore render loop", () => {
  it("@bugfix @regression-proof subscribes a bounded number of times for a stable client", async () => {
    console.info("[mpv-lifecycle-store-render-loop:bounded] mounting Probe with stable stub client");
    const { client, getRegistrations } = makeStubClient();
    let renderCount = 0;
    let snapshot: LifecycleState | null = null;

    const Probe = () => {
      renderCount += 1;
      snapshot = useMpvLifecycleStore(client);
      return null;
    };

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(React.createElement(Probe));
    });

    console.info(
      `[mpv-lifecycle-store-render-loop:bounded] settled registrations=${getRegistrations()} renderCount=${renderCount} snapshot=${JSON.stringify(snapshot)}`,
    );
    // A referentially-stable client must yield a bounded number of
    // `subscribeLifecycle` registrations: one one-shot bootstrap read in
    // `cellFor`, plus one live `useSyncExternalStore` subscription.
    // Pre-fix, the fresh-closure `subscribe` re-registers on every render
    // and the count climbs to React's update-depth cap (25+).
    try {
      expect(getRegistrations()).toBeLessThanOrEqual(4);
      // The component must settle, not re-render unboundedly. Post-fix this
      // is ~1-3 (mount + the single synchronous on-register notify).
      expect(renderCount).toBeLessThanOrEqual(6);
      expect(snapshot).toEqual({ kind: "idle" });
    } catch (err) {
      dumpRenderLoopSnapshot("bounded", {
        registrations: getRegistrations(),
        renderCount,
        snapshot,
      });
      throw err;
    }
  });

  it("@bugfix @regression-proof a re-render with the same client does not re-subscribe", async () => {
    console.info("[mpv-lifecycle-store-render-loop:no-resub] mounting Probe then re-rendering with same client");
    const { client, getRegistrations } = makeStubClient();

    const Probe = ({ tick }: { tick: number }) => {
      // `tick` forces a parent-driven re-render with an unchanged client.
      void tick;
      useMpvLifecycleStore(client);
      return null;
    };

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(React.createElement(Probe, { tick: 0 }));
    });
    const afterMount = getRegistrations();
    console.info(`[mpv-lifecycle-store-render-loop:no-resub] afterMount registrations=${afterMount}`);

    await act(async () => {
      root?.render(React.createElement(Probe, { tick: 1 }));
    });
    await act(async () => {
      root?.render(React.createElement(Probe, { tick: 2 }));
    });

    console.info(
      `[mpv-lifecycle-store-render-loop:no-resub] after 2 re-renders registrations=${getRegistrations()} (expected unchanged from afterMount=${afterMount})`,
    );
    // Re-rendering with the SAME client must not add subscriptions —
    // `subscribe` is memoized on `client`, so `useSyncExternalStore`
    // keeps the existing registration.
    try {
      expect(getRegistrations()).toBe(afterMount);
    } catch (err) {
      dumpRenderLoopSnapshot("no-resub", {
        registrations: getRegistrations(),
        afterMount,
      });
      throw err;
    }
  });
});
