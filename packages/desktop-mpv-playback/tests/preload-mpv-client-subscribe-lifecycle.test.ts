/**
 * Tier-5 — exercises {@link PreloadMpvClient}.subscribeLifecycle() against
 * the same synthetic `window.sf.onMpvExternalMessage` bridge used by the
 * observe() tests. Validates the renderer-side half of the lifecycle
 * wiring: messages of type "lifecycle" pushed over the multiplexed IPC
 * channel update the cached state and fan out to all subscribers.
 *
 * The main-side dispatch (process spawn → launch_started, socket ready
 * → socket_ready, etc.) is exercised in the apps/badger/desktop suite;
 * here we only verify that the renderer client correctly observes
 * pre-computed lifecycle states.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  LifecycleState,
  MpvCommand,
  MpvExternalMessage,
  MpvResponse,
} from "@space/mpv-protocol";

import { PreloadMpvClient } from "../src/preloadMpvClient";

type BridgeStub = {
  listeners: Array<(msg: MpvExternalMessage) => void>;
  install(stub: { onRequest: (cmd: MpvCommand) => Promise<MpvResponse> }): void;
  pushLifecycle: (state: LifecycleState) => void;
  clear: () => void;
};

// On assertion failure, dump the bridge listener count + the observed
// lifecycle-state sequence so we can diagnose subscribe/unsubscribe drift
// offline. Body in try/catch so a dump failure can't mask the assertion.
const dumpLifecycleSnapshot = (
  label: string,
  bridge: BridgeStub | null,
  seen: LifecycleState[],
  extra?: Record<string, unknown>,
): void => {
  try {
    console.error(`=== [preload-mpv-client-subscribe-lifecycle:${label}] snapshot ===`);
    console.error(`bridge.listeners.length=${bridge ? bridge.listeners.length : "(no bridge)"}`);
    console.error(`seen states (${seen.length}):\n${JSON.stringify(seen, null, 2)}`);
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

describe("PreloadMpvClient subscribeLifecycle (tier-5)", () => {
  let bridge: BridgeStub;

  beforeEach(() => {
    console.info(`[preload-mpv-client-subscribe-lifecycle:setup] installing synthetic bridge`);
    bridge = installBridge();
    bridge.install({ onRequest: async () => ({ data: 0 }) });
  });

  afterEach(() => {
    console.info(
      `[preload-mpv-client-subscribe-lifecycle:teardown] clearing bridge, listeners=${bridge.listeners.length}`,
    );
    bridge.clear();
  });

  it("delivers the cached state synchronously on subscribe", () => {
    console.info(`[preload-mpv-client-subscribe-lifecycle:cached-on-subscribe] subscribing fresh client`);
    const client = new PreloadMpvClient();
    const seen: LifecycleState[] = [];
    const unsub = client.subscribeLifecycle((state) => seen.push(state));
    if (JSON.stringify(seen) !== JSON.stringify([{ kind: "idle" }])) {
      dumpLifecycleSnapshot("cached-on-subscribe", bridge, seen);
    }
    expect(seen).toEqual([{ kind: "idle" }]);
    unsub();
  });

  it("notifies subscribers when lifecycle messages arrive", () => {
    console.info(`[preload-mpv-client-subscribe-lifecycle:notify-on-arrival] pushing launching→socket-ready→playing`);
    const client = new PreloadMpvClient();
    const seen: LifecycleState[] = [];
    const unsub = client.subscribeLifecycle((state) => seen.push(state));
    bridge.pushLifecycle({ kind: "launching", launchId: 1, startedAt: 100 });
    bridge.pushLifecycle({ kind: "socket-ready", launchId: 1 });
    bridge.pushLifecycle({ kind: "playing", launchId: 1 });
    const expected = [
      { kind: "idle" },
      { kind: "launching", launchId: 1, startedAt: 100 },
      { kind: "socket-ready", launchId: 1 },
      { kind: "playing", launchId: 1 },
    ];
    console.info(`[preload-mpv-client-subscribe-lifecycle:notify-on-arrival] seen.length=${seen.length} expected.length=${expected.length}`);
    if (JSON.stringify(seen) !== JSON.stringify(expected)) {
      dumpLifecycleSnapshot("notify-on-arrival", bridge, seen, { expected });
    }
    expect(seen).toEqual(expected);
    unsub();
  });

  it("late subscribers see the most recent state on subscribe", () => {
    console.info(`[preload-mpv-client-subscribe-lifecycle:late-subscriber] advancing cached state before late subscribe`);
    const client = new PreloadMpvClient();
    // Eagerly install the upstream listener by subscribing once.
    const earlyUnsub = client.subscribeLifecycle(() => undefined);
    bridge.pushLifecycle({ kind: "launching", launchId: 1, startedAt: 100 });
    bridge.pushLifecycle({ kind: "playing", launchId: 1 });
    const seen: LifecycleState[] = [];
    const lateUnsub = client.subscribeLifecycle((state) => seen.push(state));
    const expected = [{ kind: "playing", launchId: 1 }];
    if (JSON.stringify(seen) !== JSON.stringify(expected)) {
      dumpLifecycleSnapshot("late-subscriber", bridge, seen, { expected });
    }
    expect(seen).toEqual(expected);
    earlyUnsub();
    lateUnsub();
  });

  it("multiple subscribers all receive each transition", () => {
    console.info(`[preload-mpv-client-subscribe-lifecycle:multi-subscriber] subscribing A+B`);
    const client = new PreloadMpvClient();
    const a: LifecycleState[] = [];
    const b: LifecycleState[] = [];
    const unsubA = client.subscribeLifecycle((state) => a.push(state));
    const unsubB = client.subscribeLifecycle((state) => b.push(state));
    bridge.pushLifecycle({ kind: "launching", launchId: 1, startedAt: 100 });
    const expected = [
      { kind: "idle" },
      { kind: "launching", launchId: 1, startedAt: 100 },
    ];
    console.info(`[preload-mpv-client-subscribe-lifecycle:multi-subscriber] a.length=${a.length} b.length=${b.length}`);
    if (JSON.stringify(a) !== JSON.stringify(expected)) dumpLifecycleSnapshot("multi-subscriber-A", bridge, a, { expected });
    expect(a).toEqual(expected);
    if (JSON.stringify(b) !== JSON.stringify(expected)) dumpLifecycleSnapshot("multi-subscriber-B", bridge, b, { expected });
    expect(b).toEqual(expected);
    unsubA();
    unsubB();
  });

  it("unsubscribe stops further deliveries", () => {
    console.info(`[preload-mpv-client-subscribe-lifecycle:unsub-stops] subscribe → push → unsub → push`);
    const client = new PreloadMpvClient();
    const seen: LifecycleState[] = [];
    const unsub = client.subscribeLifecycle((state) => seen.push(state));
    bridge.pushLifecycle({ kind: "launching", launchId: 1, startedAt: 100 });
    unsub();
    bridge.pushLifecycle({ kind: "playing", launchId: 1 });
    const expected = [
      { kind: "idle" },
      { kind: "launching", launchId: 1, startedAt: 100 },
    ];
    if (JSON.stringify(seen) !== JSON.stringify(expected)) {
      dumpLifecycleSnapshot("unsub-stops", bridge, seen, { expected, note: "playing should NOT appear after unsub" });
    }
    expect(seen).toEqual(expected);
  });

  it("unsubscribe is idempotent — calling it twice is safe", () => {
    console.info(`[preload-mpv-client-subscribe-lifecycle:unsub-idempotent] double-unsubscribe`);
    const client = new PreloadMpvClient();
    const seen: LifecycleState[] = [];
    const unsub = client.subscribeLifecycle((state) => seen.push(state));
    unsub();
    expect(() => unsub()).not.toThrow();
    bridge.pushLifecycle({ kind: "launching", launchId: 1, startedAt: 100 });
    if (JSON.stringify(seen) !== JSON.stringify([{ kind: "idle" }])) {
      dumpLifecycleSnapshot("unsub-idempotent", bridge, seen);
    }
    expect(seen).toEqual([{ kind: "idle" }]);
  });

  it("ignores property_change and other variants", () => {
    console.info(`[preload-mpv-client-subscribe-lifecycle:ignore-variants] pushing exit/osc_action/property_change`);
    const client = new PreloadMpvClient();
    const seen: LifecycleState[] = [];
    const unsub = client.subscribeLifecycle((state) => seen.push(state));
    for (const listener of [...bridge.listeners]) {
      listener({ type: "exit" });
      listener({
        type: "osc_action",
        action: { type: "next_episode", requestedAt: 1 },
      });
      listener({ type: "property_change", name: "time-pos", value: 12 });
    }
    if (JSON.stringify(seen) !== JSON.stringify([{ kind: "idle" }])) {
      dumpLifecycleSnapshot("ignore-variants", bridge, seen, {
        note: "non-lifecycle messages must not mutate seen",
      });
    }
    expect(seen).toEqual([{ kind: "idle" }]);
    unsub();
  });

  it("dispose clears lifecycle subscribers and stops further deliveries", async () => {
    console.info(`[preload-mpv-client-subscribe-lifecycle:dispose] subscribe → dispose → push`);
    const client = new PreloadMpvClient();
    const seen: LifecycleState[] = [];
    client.subscribeLifecycle((state) => seen.push(state));
    await client.dispose();
    bridge.pushLifecycle({ kind: "launching", launchId: 1, startedAt: 100 });
    console.info(`[preload-mpv-client-subscribe-lifecycle:dispose] post-dispose seen.length=${seen.length} client.state=${client.state}`);
    if (JSON.stringify(seen) !== JSON.stringify([{ kind: "idle" }]) || client.state !== "disposed") {
      dumpLifecycleSnapshot("dispose", bridge, seen, { clientState: client.state });
    }
    expect(seen).toEqual([{ kind: "idle" }]);
    expect(client.state).toBe("disposed");
  });
});
