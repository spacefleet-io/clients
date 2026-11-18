/**
 * Tier-4 — exercises {@link PreloadMpvClient}.observe() against a
 * synthetic preload bridge. The renderer client subscribes to
 * `window.sf.onMpvExternalMessage` and dispatches `property_change`
 * variants to the registered callbacks; this test mounts that bridge,
 * pushes synthetic events, and asserts subscribe / unsubscribe / multi-
 * subscriber dispatch behavior matches the main-side implementation.
 *
 * Also runs the shared contract suite from `@space/mpv-protocol/tests`
 * via the observe-supporting code path (`supportsObserve: true`).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  runClientContractSuite,
  type ClientContractOptions,
  type ObserveTestHarness,
} from "@space/mpv-protocol/tests/client-contract";
import type {
  MpvCommand,
  MpvExternalMessage,
  MpvProperty,
  MpvResponse,
} from "@space/mpv-protocol";

import { PreloadMpvClient } from "../src/preloadMpvClient";

type BridgeStub = {
  listeners: Array<(msg: MpvExternalMessage) => void>;
  install(stub: { onRequest: (cmd: MpvCommand) => Promise<MpvResponse> }): void;
  pushPropertyChange: (property: MpvProperty, value: unknown) => void;
  clear: () => void;
};

// On assertion failure, dump the upstream listener count + the observed
// values so subscribe/unsubscribe registry drift is diagnosable offline.
// Body in try/catch so a dump failure can't mask the assertion failure.
const dumpObserveSnapshot = (
  label: string,
  bridge: BridgeStub | null,
  observed: Record<string, unknown[]>,
  extra?: Record<string, unknown>,
): void => {
  try {
    console.error(`=== [preload-mpv-client-observe:${label}] snapshot ===`);
    console.error(`bridge.listeners.length=${bridge ? bridge.listeners.length : "(no bridge)"}`);
    console.error(`observed:\n${JSON.stringify(observed, null, 2)}`);
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
    pushPropertyChange: (property, value) => {
      const msg: MpvExternalMessage = {
        type: "property_change",
        name: property,
        value,
      };
      for (const listener of [...listeners]) listener(msg);
    },
    clear: () => {
      listeners.length = 0;
      delete (globalThis as { window?: unknown }).window;
    },
  };
  return harness;
};

describe("PreloadMpvClient observe (tier-4)", () => {
  let bridge: BridgeStub;

  beforeEach(() => {
    console.info(`[preload-mpv-client-observe:setup] installing synthetic bridge`);
    bridge = installBridge();
  });

  afterEach(() => {
    console.info(`[preload-mpv-client-observe:teardown] clearing bridge, listeners=${bridge.listeners.length}`);
    bridge.clear();
  });

  it("delivers events to a subscribed callback", () => {
    console.info(`[preload-mpv-client-observe:delivers] observe time-pos → push 7,9`);
    bridge.install({ onRequest: async () => ({ data: 0 }) });
    const client = new PreloadMpvClient();
    const seen: unknown[] = [];
    const unsub = client.observe("time-pos", (v) => seen.push(v));
    bridge.pushPropertyChange("time-pos", 7);
    bridge.pushPropertyChange("time-pos", 9);
    if (JSON.stringify(seen) !== JSON.stringify([7, 9])) {
      dumpObserveSnapshot("delivers", bridge, { seen });
    }
    expect(seen).toEqual([7, 9]);
    unsub();
  });

  it("unsubscribe stops further deliveries and releases the upstream listener when the registry empties", () => {
    console.info(`[preload-mpv-client-observe:unsub-releases] observe pause → push → unsub → push`);
    bridge.install({ onRequest: async () => ({ data: 0 }) });
    const client = new PreloadMpvClient();
    const seen: unknown[] = [];
    const unsub = client.observe("pause", (v) => seen.push(v));
    bridge.pushPropertyChange("pause", true);
    if (JSON.stringify(seen) !== JSON.stringify([true]) || bridge.listeners.length !== 1) {
      dumpObserveSnapshot("unsub-releases-pre", bridge, { seen });
    }
    expect(seen).toEqual([true]);
    expect(bridge.listeners).toHaveLength(1);
    unsub();
    // No subscribers left → the shared listener is dropped.
    console.info(`[preload-mpv-client-observe:unsub-releases] post-unsub listeners=${bridge.listeners.length}`);
    if (bridge.listeners.length !== 0) {
      dumpObserveSnapshot("unsub-releases-post", bridge, { seen }, { note: "upstream listener should be released when registry empties" });
    }
    expect(bridge.listeners).toHaveLength(0);
    bridge.pushPropertyChange("pause", false);
    if (JSON.stringify(seen) !== JSON.stringify([true])) {
      dumpObserveSnapshot("unsub-releases-after-push", bridge, { seen });
    }
    expect(seen).toEqual([true]);
  });

  it("multiple subscribers per property all see the same event", () => {
    console.info(`[preload-mpv-client-observe:multi-subscriber] observe mute x2 → push true`);
    bridge.install({ onRequest: async () => ({ data: 0 }) });
    const client = new PreloadMpvClient();
    const a: unknown[] = [];
    const b: unknown[] = [];
    const unsubA = client.observe("mute", (v) => a.push(v));
    const unsubB = client.observe("mute", (v) => b.push(v));
    // Only ONE upstream listener even with two subscribers.
    if (bridge.listeners.length !== 1) {
      dumpObserveSnapshot("multi-subscriber-listener-count", bridge, { a, b }, { note: "two observers must share one upstream listener" });
    }
    expect(bridge.listeners).toHaveLength(1);
    bridge.pushPropertyChange("mute", true);
    if (JSON.stringify(a) !== JSON.stringify([true])) dumpObserveSnapshot("multi-subscriber-A", bridge, { a, b });
    expect(a).toEqual([true]);
    if (JSON.stringify(b) !== JSON.stringify([true])) dumpObserveSnapshot("multi-subscriber-B", bridge, { a, b });
    expect(b).toEqual([true]);
    unsubA();
    unsubB();
  });

  it("ignores non-property-change messages", () => {
    console.info(`[preload-mpv-client-observe:ignore-variants] pushing exit/osc_action raw to listeners`);
    bridge.install({ onRequest: async () => ({ data: 0 }) });
    const client = new PreloadMpvClient();
    const seen: unknown[] = [];
    client.observe("time-pos", (v) => seen.push(v));
    for (const listener of [...bridge.listeners]) {
      listener({ type: "exit" });
      listener({
        type: "osc_action",
        action: { type: "next_episode", requestedAt: 1 },
      });
    }
    if (JSON.stringify(seen) !== JSON.stringify([])) {
      dumpObserveSnapshot("ignore-variants", bridge, { seen }, { note: "non-property-change messages must not deliver values" });
    }
    expect(seen).toEqual([]);
  });

  it("dispose cancels pending throttled deliveries and releases the listener", async () => {
    console.info(`[preload-mpv-client-observe:dispose] observe time-pos → dispose`);
    bridge.install({ onRequest: async () => ({ data: 0 }) });
    const client = new PreloadMpvClient();
    client.observe("time-pos", () => undefined);
    if (bridge.listeners.length !== 1) {
      dumpObserveSnapshot("dispose-pre", bridge, {});
    }
    expect(bridge.listeners).toHaveLength(1);
    await client.dispose();
    console.info(`[preload-mpv-client-observe:dispose] post-dispose listeners=${bridge.listeners.length} client.state=${client.state}`);
    if (bridge.listeners.length !== 0 || client.state !== "disposed") {
      dumpObserveSnapshot("dispose-post", bridge, {}, { clientState: client.state });
    }
    expect(bridge.listeners).toHaveLength(0);
    expect(client.state).toBe("disposed");
  });
});

describe("PreloadMpvClient contract", () => {
  let bridge: BridgeStub;
  beforeEach(() => {
    bridge = installBridge();
  });
  afterEach(() => {
    bridge.clear();
  });

  runClientContractSuite(
    "PreloadMpvClient",
    async ({ stubTransport }: ClientContractOptions) => {
      console.info(`[preload-mpv-client-observe:contract] building client for shared contract suite (supportsObserve=true)`);
      bridge.install({ onRequest: stubTransport.onRequest });
      const client = new PreloadMpvClient();
      const observeHarness: ObserveTestHarness = {
        pushPropertyChange: (property, value) =>
          bridge.pushPropertyChange(property, value),
      };
      return { client, observeHarness };
    },
    { supportsObserve: true },
  );
});
