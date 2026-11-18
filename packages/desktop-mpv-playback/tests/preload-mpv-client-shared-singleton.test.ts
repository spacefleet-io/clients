/**
 * @bugfix preloadmpvclient-remount-idle-race
 * @regression-proof
 *
 * Each `new PreloadMpvClient()` starts with `lifecycleState = { kind: "idle" }`
 * (preloadMpvClient.ts ~line 92). Main only emits lifecycle events on actual
 * state transitions — it does NOT replay past events for fresh subscribers.
 * So a per-component-instance client constructed AFTER mpv reached
 * `playing` reads "idle" forever and engine gate predicates short-circuit,
 * producing the mpv respawn loop ("plays 3 times before stabilizing").
 *
 * The fix is the module-scope singleton `getSharedPreloadMpvClient()`. This
 * test pins the contract: repeated calls return the same instance, and a
 * lifecycle pushed via the bridge before a NEW subscriber registers is
 * still delivered to that subscriber via the cached state.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  LifecycleState,
  MpvCommand,
  MpvExternalMessage,
  MpvResponse,
} from "@space/mpv-protocol";

import {
  __resetSharedPreloadMpvClientForTests,
  getSharedPreloadMpvClient,
} from "../src/preloadMpvClient";

type BridgeStub = {
  listeners: Array<(msg: MpvExternalMessage) => void>;
  install(stub: { onRequest: (cmd: MpvCommand) => Promise<MpvResponse> }): void;
  pushLifecycle: (state: LifecycleState) => void;
  clear: () => void;
};

// On assertion failure, dump the bridge listener count + the lifecycle-state
// sequences observed by each subscriber so singleton-cache regressions (fresh
// subscriber seeing "idle" instead of cached state) are diagnosable offline.
// Body in try/catch so a dump failure can't mask the assertion failure.
const dumpSingletonSnapshot = (
  label: string,
  bridge: BridgeStub | null,
  seenByLabel: Record<string, LifecycleState[]>,
  extra?: Record<string, unknown>,
): void => {
  try {
    console.error(`=== [preload-mpv-client-shared-singleton:${label}] snapshot ===`);
    console.error(`bridge.listeners.length=${bridge ? bridge.listeners.length : "(no bridge)"}`);
    console.error(`seen states:\n${JSON.stringify(seenByLabel, null, 2)}`);
    if (extra) console.error(`extra: ${JSON.stringify(extra)}`);
  } catch (err) {
    console.error(
      `(snapshot failed: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
};

const installBridge = (): BridgeStub => {
  const listeners: Array<(msg: MpvExternalMessage) => void> = [];
  const harness: BridgeStub = {
    listeners,
    install(stub) {
      (globalThis as { window?: unknown }).window = {
        sf: {
          sendExternalMpvCommand: stub.onRequest,
          sendExternalMpvRequest: stub.onRequest,
          onMpvExternalMessage: (cb: (msg: MpvExternalMessage) => void) => {
            listeners.push(cb);
            return () => {
              const index = listeners.indexOf(cb);
              if (index >= 0) listeners.splice(index, 1);
            };
          },
        },
      };
    },
    pushLifecycle: (state) => {
      const msg: MpvExternalMessage = { type: "lifecycle", state };
      for (const listener of [...listeners]) listener(msg);
    },
    clear: () => {
      listeners.length = 0;
      delete (globalThis as { window?: unknown }).window;
    },
  };
  return harness;
};

describe("getSharedPreloadMpvClient — module singleton survives mounts", () => {
  let bridge: BridgeStub;

  beforeEach(() => {
    console.info(`[preload-mpv-client-shared-singleton:setup] installing bridge + resetting shared client`);
    bridge = installBridge();
    bridge.install({ onRequest: async () => ({ data: 0 }) });
    __resetSharedPreloadMpvClientForTests();
  });

  afterEach(() => {
    console.info(`[preload-mpv-client-shared-singleton:teardown] clearing bridge + resetting shared client, listeners=${bridge.listeners.length}`);
    bridge.clear();
    __resetSharedPreloadMpvClientForTests();
  });

  it("returns the same client instance on repeated calls", () => {
    console.info(`[preload-mpv-client-shared-singleton:same-instance] calling getSharedPreloadMpvClient twice`);
    const first = getSharedPreloadMpvClient();
    const second = getSharedPreloadMpvClient();
    if (second !== first) {
      dumpSingletonSnapshot("same-instance", bridge, {}, { sameRef: second === first });
    }
    expect(second).toBe(first);
  });

  it("preserves cached lifecycle state across simulated component remounts", () => {
    // Initial mount: subscribe + immediate unsubscribe (mimics
    // useMpvLifecycleStore's cellFor bootstrap path in
    // packages/desktop-mpv-playback/src/useMpvLifecycleStore.ts).
    console.info(`[preload-mpv-client-shared-singleton:remount] initial mount: subscribe`);
    const client = getSharedPreloadMpvClient();
    const initialSeen: LifecycleState[] = [];
    const unsubInitial = client.subscribeLifecycle((state) => initialSeen.push(state));
    if (JSON.stringify(initialSeen) !== JSON.stringify([{ kind: "idle" }])) {
      dumpSingletonSnapshot("remount-initial-subscribe", bridge, { initialSeen });
    }
    expect(initialSeen).toEqual([{ kind: "idle" }]);

    // Main pushes a lifecycle transition — mpv is now playing.
    console.info(`[preload-mpv-client-shared-singleton:remount] pushing playing(launchId=7)`);
    bridge.pushLifecycle({ kind: "playing", launchId: 7 });
    const expectedInitial = [
      { kind: "idle" },
      { kind: "playing", launchId: 7 },
    ];
    if (JSON.stringify(initialSeen) !== JSON.stringify(expectedInitial)) {
      dumpSingletonSnapshot("remount-after-playing", bridge, { initialSeen }, { expected: expectedInitial });
    }
    expect(initialSeen).toEqual(expectedInitial);
    unsubInitial();

    // Simulate component remount — old subscriber gone, new subscriber
    // attaches. The shared singleton must replay the cached `playing` state
    // synchronously instead of starting back at `idle`. This is what the
    // pre-fix renderer was missing: the new client had `lifecycleState =
    // idle` and engine gate predicates short-circuited until the next
    // transition fired from main.
    console.info(`[preload-mpv-client-shared-singleton:remount] simulating remount: fetch shared client again + subscribe`);
    const remountedClient = getSharedPreloadMpvClient();
    if (remountedClient !== client) {
      dumpSingletonSnapshot("remount-not-same-ref", bridge, { initialSeen }, { sameRef: remountedClient === client });
    }
    expect(remountedClient).toBe(client);

    const remountedSeen: LifecycleState[] = [];
    const unsubRemounted = remountedClient.subscribeLifecycle((state) =>
      remountedSeen.push(state),
    );
    console.info(`[preload-mpv-client-shared-singleton:remount] remountedSeen=${JSON.stringify(remountedSeen)}`);
    if (JSON.stringify(remountedSeen) !== JSON.stringify([{ kind: "playing", launchId: 7 }])) {
      dumpSingletonSnapshot("remount-fresh-subscriber", bridge, { initialSeen, remountedSeen }, {
        note: "fresh subscriber must see cached 'playing', not 'idle'",
      });
    }
    expect(remountedSeen).toEqual([{ kind: "playing", launchId: 7 }]);
    unsubRemounted();
  });

  it("delivers fresh subscribers the latest cached state, not the construction-time default", () => {
    console.info(`[preload-mpv-client-shared-singleton:fresh-cached] advancing cached state via transient subscriber`);
    const client = getSharedPreloadMpvClient();

    // Push a "playing" transition through a transient subscriber so the
    // singleton's cached state advances.
    const transient: LifecycleState[] = [];
    const stop = client.subscribeLifecycle((state) => transient.push(state));
    bridge.pushLifecycle({ kind: "playing", launchId: 12 });
    stop();

    // A LATER subscriber (e.g. a remounted MediaPlaybackController) reads
    // the latest cached state, not "idle".
    console.info(`[preload-mpv-client-shared-singleton:fresh-cached] late subscribe after transient state advance`);
    const lateSeen: LifecycleState[] = [];
    const stopLate = client.subscribeLifecycle((state) => lateSeen.push(state));
    console.info(`[preload-mpv-client-shared-singleton:fresh-cached] lateSeen=${JSON.stringify(lateSeen)}`);
    if (JSON.stringify(lateSeen) !== JSON.stringify([{ kind: "playing", launchId: 12 }])) {
      dumpSingletonSnapshot("fresh-cached", bridge, { transient, lateSeen }, {
        note: "late subscriber must read cached 'playing', not construction-time 'idle'",
      });
    }
    expect(lateSeen).toEqual([{ kind: "playing", launchId: 12 }]);
    stopLate();
  });
});
