/**
 * @test-id MOBILE-LIB-OFFLINE-RECOVERY-001
 * @level unit
 * @req OFFL-PLAY-03
 * @why The phone's online state comes from the download engine's network state (`subscribeDeviceOnline` /
 *   `getDeviceOnline` in `@space/mobile-media-proxy/downloads`), the same signal Parrot uses. `useNetworkOnline` follows
 *   it, so offline the Library greys what is not downloaded, and `onNetworkRecover` reloads the library exactly once per
 *   offline → online transition.
 * @regression-proof
 *   Bug (phone test run, 2026-11-16): networkListener.ts loaded `@react-native-community/netinfo`, which the app never
 *   shipped ("networkListener.netinfo.unavailable ... Cannot find module"), so the phone always counted as online: in
 *   airplane mode nothing was greyed out and the library never reloaded on recovery. These tests drive the engine's
 *   state and fail against the NetInfo source (no listener ever registers there).
 *   A naive recovery that fires on every "online" notice would also reload on launch: registering while online must
 *   not fire.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { getNetworkOnline, onNetworkRecover, subscribeNetworkOnline } from "../src/lib/networkListener";

// ── Download engine network state mock ───────────────────────────────

const engine = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let online = true;
  const set = (next: boolean) => {
    online = next;
    listeners.forEach((listener) => listener());
  };
  const reset = () => {
    listeners.clear();
    online = true;
  };
  return {
    listeners,
    set,
    reset,
    getDeviceOnline: () => online,
    subscribeDeviceOnline: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
});

vi.mock("@space/mobile-media-proxy/downloads", () => ({
  getDeviceOnline: () => engine.getDeviceOnline(),
  subscribeDeviceOnline: (listener: () => void) => engine.subscribeDeviceOnline(listener),
}));

beforeEach(() => {
  console.info("[library-offline-recovery:setup] engine state online, no listeners");
  engine.reset();
});

afterEach(() => {
  console.info(`[library-offline-recovery:teardown] active listeners=${engine.listeners.size}`);
  vi.clearAllMocks();
});

// On assertion failure, dump the callback calls and the engine state. Wrapped in try/catch so a dump failure can never
// mask the original assertion error.
const dumpOfflineRecoverySnapshot = (label: string, cb: Mock) => {
  try {
    console.error(`=== [library-offline-recovery:${label}] snapshot ===`);
    console.error(`callback: calls=${cb.mock.calls.length} args=${JSON.stringify(cb.mock.calls)}`);
    console.error(`engine: online=${engine.getDeviceOnline()} activeListeners=${engine.listeners.size}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

const expectCalls = (label: string, cb: Mock, times: number) => {
  try {
    expect(cb).toHaveBeenCalledTimes(times);
  } catch (err) {
    dumpOfflineRecoverySnapshot(label, cb);
    throw err;
  }
};

// ── Tests ────────────────────────────────────────────────────────────

describe("useNetworkOnline source", () => {
  it("follows the download engine's network state", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeNetworkOnline(listener);
    console.info(`[library-offline-recovery:source] subscribed, engine listeners=${engine.listeners.size}`);
    expect(getNetworkOnline()).toBe(true);
    engine.set(false);
    expectCalls("source-offline", listener, 1);
    expect(getNetworkOnline()).toBe(false);
    engine.set(true);
    expect(getNetworkOnline()).toBe(true);
    unsubscribe();
    expect(engine.listeners.size).toBe(0);
  });
});

describe("onNetworkRecover — single-fire contract", () => {
  it("fires the callback exactly once on offline → online transition", async () => {
    const cb = vi.fn();
    const unsubscribe = onNetworkRecover(cb);
    engine.set(false);
    expectCalls("drop", cb, 0);
    engine.set(true);
    expectCalls("recover", cb, 1);
    // One-shot per recovery: later online notices do not fire again.
    engine.set(true);
    engine.set(true);
    expectCalls("online-noise", cb, 1);
    unsubscribe();
  });

  it("registering while already-online does NOT fire on the next online notice", async () => {
    const cb = vi.fn();
    const unsubscribe = onNetworkRecover(cb);
    console.info("[library-offline-recovery:already-online] online notice with no prior offline — expect no fire");
    engine.set(true);
    expectCalls("already-online-unexpected-fire", cb, 0);
    unsubscribe();
  });

  it("registering while already-offline + then going online fires once", async () => {
    engine.set(false);
    const cb = vi.fn();
    const unsubscribe = onNetworkRecover(cb);
    engine.set(true);
    expectCalls("already-offline-recover", cb, 1);
    unsubscribe();
  });

  it("unsubscribe before recovery prevents the callback from firing", async () => {
    const cb = vi.fn();
    const unsubscribe = onNetworkRecover(cb);
    console.info("[library-offline-recovery:unsub-before-recovery] offline → unsubscribe → online — expect no fire");
    engine.set(false);
    unsubscribe();
    engine.set(true);
    expectCalls("unsub-before-recovery-unexpected-fire", cb, 0);
    expect(engine.listeners.size).toBe(0);
  });
});

describe("offline → online drives reload exactly once", () => {
  it("simulated full flow: offline observation, then online → reload spy called once", async () => {
    const reload = vi.fn();
    const unsubscribe = onNetworkRecover(reload);
    engine.set(false);
    engine.set(false);
    engine.set(false);
    expectCalls("offline-noise", reload, 0);
    engine.set(true);
    expectCalls("recover", reload, 1);
    engine.set(true);
    engine.set(true);
    expectCalls("online-noise", reload, 1);
    unsubscribe();
  });
});
