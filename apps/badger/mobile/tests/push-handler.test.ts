/**
 * @test-id MOBILE-PUSH-001
 * @level unit
 * Verifies the push receiver:
 *   - generates a stable deviceId on first call and reuses it
 *   - posts a registration to /push/register on init
 *   - calls onPushReceived when a foreground message arrives
 *   - DELETE /push/unregister on teardown
 * Fakes `@react-native-firebase/messaging` and global.fetch — no native.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeAsyncStorage } from "./harness";

const fakeStorage = createFakeAsyncStorage();

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: (key: string) => fakeStorage.getItem(key),
    setItem: (key: string, value: string) => fakeStorage.setItem(key, value),
    removeItem: (key: string) => fakeStorage.removeItem(key),
  },
}));

vi.mock("react-native", () => ({ Platform: { OS: "android" } }));

type MessageCb = (msg: unknown) => void;
const messagingState = {
  onMessageCb: null as MessageCb | null,
  onTokenRefreshCb: null as ((t: string) => void) | null,
  getTokenImpl: vi.fn(async () => "fake-fcm-token-xyz"),
  permissionImpl: vi.fn(async () => 1),
};

// The modular API only, as @react-native-firebase/messaging 27 ships it (no default export): a receiver still
// calling the removed namespaced `messaging()` gets no token and registers nothing here.
const FAKE_MESSAGING = { app: "[DEFAULT]" };
vi.mock("@react-native-firebase/messaging", () => ({
  getMessaging: () => FAKE_MESSAGING,
  getToken: (m: unknown) => {
    expect(m).toBe(FAKE_MESSAGING);
    return messagingState.getTokenImpl();
  },
  requestPermission: (_m: unknown) => messagingState.permissionImpl(),
  onTokenRefresh: (_m: unknown, cb: (t: string) => void) => {
    messagingState.onTokenRefreshCb = cb;
    return () => {
      messagingState.onTokenRefreshCb = null;
    };
  },
  onMessage: (_m: unknown, cb: MessageCb) => {
    messagingState.onMessageCb = cb;
    return () => {
      messagingState.onMessageCb = null;
    };
  },
  onNotificationOpenedApp: (_m: unknown, _cb: MessageCb) => () => undefined,
  getInitialNotification: async (_m: unknown) => null,
  setBackgroundMessageHandler: vi.fn(),
}));

// The first import of the receiver transforms its whole graph (@space/shared/api, the five i18n files, pairing): on a
// loaded CI runner that alone took over the 15 s test budget (run 52178), so the first test timed out before its first
// assertion. Load it once here, under its own budget. Dynamic, like every import of it below: each test re-evaluates a
// fresh copy after `resetModules`, which a static import cannot give.
beforeAll(async () => {
  const started = Date.now();
  await import("../src/native/pushHandler");
  console.info(`[push-handler:setup] first import of pushHandler took ${Date.now() - started} ms`);
}, 120_000);

beforeEach(() => {
  console.info("[push-handler:setup] clearing fake storage + resetting messaging mocks");
  fakeStorage._backing.clear();
  messagingState.onMessageCb = null;
  messagingState.onTokenRefreshCb = null;
  messagingState.getTokenImpl.mockReset();
  messagingState.getTokenImpl.mockResolvedValue("fake-fcm-token-xyz");
  messagingState.permissionImpl.mockReset();
  messagingState.permissionImpl.mockResolvedValue(1);
});

afterEach(() => {
  vi.resetModules();
});

// On assertion failure, dump the captured fetch calls + messaging-callback
// registration state so a registration/refresh regression is diagnosable from
// CI logs alone. Wrapped in try/catch so a dump failure can never mask the
// original assertion error.
const dumpPushHandlerSnapshot = (label: string, fetchMock: ReturnType<typeof vi.fn>) => {
  try {
    console.error(`=== [push-handler:${label}] snapshot ===`);
    console.error(`fetchMock.calls=${fetchMock.mock.calls.length}`);
    fetchMock.mock.calls.forEach((call, i) => {
      const [input] = call as [Request | string];
      const request = input instanceof Request ? input : null;
      console.error(`call[${i}]: url=${request?.url ?? String(input)} method=${request?.method}`);
    });
    console.error(
      `messaging: onMessageCb=${messagingState.onMessageCb ? "registered" : "null"} onTokenRefreshCb=${messagingState.onTokenRefreshCb ? "registered" : "null"} getToken.calls=${messagingState.getTokenImpl.mock.calls.length}`,
    );
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("pushHandler", () => {
  it("getOrCreateDeviceId returns same value on subsequent calls", async () => {
    console.info("[push-handler:device-id] importing pushHandler + calling getOrCreateDeviceId twice");
    const { getOrCreateDeviceId } = await import("../src/native/pushHandler");
    const id1 = await getOrCreateDeviceId();
    const id2 = await getOrCreateDeviceId();
    console.info(`[push-handler:device-id] id1=${id1} id2=${id2}`);
    try {
      expect(id1).toBe(id2);
      expect(id1.length).toBeGreaterThan(10);
    } catch (err) {
      console.error(`=== [push-handler:device-id-mismatch] id1=${JSON.stringify(id1)} id2=${JSON.stringify(id2)} ===`);
      throw err;
    }
  });

  it("registers on init and unregisters on teardown", async () => {
    console.info("[push-handler:register-teardown] initializing push notifications (deviceId=device-1)");
    const fetchMock = vi.fn(async (_request: Request) => Response.json({ ok: true }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { initializePushNotifications, unregisterPushNotifications } = await import(
      "../src/native/pushHandler"
    );
    const onPushReceived = vi.fn();
    const teardown = await initializePushNotifications({
      authToken: "tok-abc",
      deviceId: "device-1",
      baseUrl: "https://api.test",
      onPushReceived,
    });

    console.info(`[push-handler:register-teardown] after init: fetchMock.calls=${fetchMock.mock.calls.length}`);
    try {
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const registerRequest = fetchMock.mock.calls[0][0];
      expect(registerRequest.url).toBe("https://api.test/push/register");
      expect(registerRequest.method).toBe("POST");
      expect(registerRequest.headers.get("authorization")).toBe("Bearer tok-abc");
      expect(await registerRequest.json()).toEqual({
        deviceId: "device-1",
        platform: "android",
        token: "fake-fcm-token-xyz",
      });
    } catch (err) {
      dumpPushHandlerSnapshot("register-init-mismatch", fetchMock);
      throw err;
    }

    // Foreground push fires onPushReceived
    console.info("[push-handler:register-teardown] firing a foreground message — expect onPushReceived once");
    messagingState.onMessageCb?.({ data: { userId: "u1", appId: "badger", version: "5" } });
    try {
      expect(onPushReceived).toHaveBeenCalledTimes(1);
    } catch (err) {
      console.error(`=== [push-handler:onmessage-not-fired] onPushReceived.calls=${onPushReceived.mock.calls.length} onMessageCb=${messagingState.onMessageCb ? "registered" : "null"} ===`);
      throw err;
    }

    console.info("[push-handler:register-teardown] tearing down + unregistering");
    await teardown();
    await unregisterPushNotifications("https://api.test", "tok-abc", "device-1");

    const unregisterCall = fetchMock.mock.calls.find(([request]) => request.url === "https://api.test/push/unregister");
    try {
      expect(unregisterCall).toBeDefined();
      const request = unregisterCall![0];
      expect(request.method).toBe("DELETE");
      expect(request.headers.get("authorization")).toBe("Bearer tok-abc");
      expect(await request.json()).toEqual({ deviceId: "device-1" });
    } catch (err) {
      dumpPushHandlerSnapshot("unregister-call-mismatch", fetchMock);
      throw err;
    }
  });

  it("token refresh re-registers the new token", async () => {
    console.info("[push-handler:token-refresh] initializing push notifications, then rotating token");
    const fetchMock = vi.fn(async (_request: Request) => Response.json({ ok: true }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { initializePushNotifications } = await import("../src/native/pushHandler");
    await initializePushNotifications({
      authToken: "tok-abc",
      deviceId: "device-1",
      baseUrl: "https://api.test",
      onPushReceived: () => undefined,
    });
    try {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } catch (err) {
      dumpPushHandlerSnapshot("token-refresh-init-wrong-count", fetchMock);
      throw err;
    }

    console.info("[push-handler:token-refresh] invoking onTokenRefreshCb('rotated-fcm-token')");
    messagingState.onTokenRefreshCb?.("rotated-fcm-token");
    // Wait one microtask flush for the async refresh handler.
    const refreshStart = Date.now();
    await new Promise((r) => setTimeout(r, 0));
    console.info(`[push-handler:token-refresh] after microtask flush (${Date.now() - refreshStart}ms): fetchMock.calls=${fetchMock.mock.calls.length}`);
    try {
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const second = fetchMock.mock.calls[1][0];
      expect(await second.json()).toEqual({
        deviceId: "device-1",
        platform: "android",
        token: "rotated-fcm-token",
      });
    } catch (err) {
      dumpPushHandlerSnapshot("token-refresh-reregister-mismatch", fetchMock);
      throw err;
    }
  });

  it("returns a no-op teardown when the Firebase module is missing", async () => {
    console.info("[push-handler:missing-module] mocking firebase messaging to throw on import");
    vi.doMock("@react-native-firebase/messaging", () => {
      throw new Error("module not linked");
    });
    vi.resetModules();
    const { initializePushNotifications } = await import("../src/native/pushHandler");
    const teardown = await initializePushNotifications({
      authToken: "tok",
      deviceId: "device",
      baseUrl: "https://api.test",
      onPushReceived: () => undefined,
    });
    console.info(`[push-handler:missing-module] teardown type=${typeof teardown}`);
    expect(typeof teardown).toBe("function");
    await expect(teardown()).resolves.toBeUndefined();
  });

  it("@req PLAT-MOBILE-06 loads the Google-free build's Firebase stand-in without throwing and leaves push off", async () => {
    // The foss Metro resolver (mobile-shell foss.cjs) maps @react-native-firebase/messaging to this very file. In a release
    // bundle a module that throws while loading kills the app before any catch runs (issue #2497), so the stand-in must
    // load and the receiver must read its marker.
    console.info("[push-handler:foss-stub] resolving firebase messaging to the Google-free stand-in");
    vi.doMock("@react-native-firebase/messaging", () => import("@space/mobile-shell/foss/notInThisBuild"));
    vi.resetModules();
    const fetchMock = vi.fn(async (_request: Request) => Response.json({ ok: true }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const stub = await import("@space/mobile-shell/foss/notInThisBuild");
    expect(stub.notInThisBuild).toBe(true);

    const { initializePushNotifications, __pushHandlerTestSeam } = await import("../src/native/pushHandler");
    await expect(__pushHandlerTestSeam.loadMessaging()).resolves.toBeNull();
    const teardown = await initializePushNotifications({
      authToken: "tok",
      deviceId: "device",
      baseUrl: "https://api.test",
      onPushReceived: () => undefined,
    });
    console.info(`[push-handler:foss-stub] fetch calls=${fetchMock.mock.calls.length}`);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(teardown()).resolves.toBeUndefined();
  });

  it("@req LIB-SYNC-05[badger-tv] a TV never loads Firebase messaging and registers no push device", async () => {
    // The Apple TV target links no Firebase: in a release bundle loading the messaging module there is a fatal crash
    // right after sign-in, before any catch runs. Platform.OS is "ios" on tvOS, so the guard must read isTV.
    console.info("[push-handler:tv] Platform ios + isTV, messaging module records any load");
    const messagingLoaded = vi.fn();
    vi.doMock("react-native", () => ({ Platform: { OS: "ios", isTV: true } }));
    vi.doMock("@react-native-firebase/messaging", () => {
      messagingLoaded();
      throw new Error("NativeRNFBTurboApp is not registered");
    });
    vi.resetModules();
    const fetchMock = vi.fn(async (_request: Request) => Response.json({ ok: true }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const { initializePushNotifications } = await import("../src/native/pushHandler");
      const teardown = await initializePushNotifications({
        authToken: "tok",
        deviceId: "device",
        baseUrl: "https://api.test",
        onPushReceived: () => undefined,
      });
      console.info(
        `[push-handler:tv] messaging loads=${messagingLoaded.mock.calls.length} fetch calls=${fetchMock.mock.calls.length}`,
      );
      expect(messagingLoaded).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      await expect(teardown()).resolves.toBeUndefined();
    } finally {
      vi.doUnmock("react-native");
      vi.doUnmock("@react-native-firebase/messaging");
    }
  });
});
