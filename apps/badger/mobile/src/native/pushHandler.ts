/**
 * Mobile push receiver. Wires `@react-native-firebase/messaging` for both
 * Android (FCM) and iOS (APNs-via-Firebase) into the library foreground-sync
 * scheduler. Fail-soft: if the native module isn't linked yet (fresh checkout,
 * Pod install not run, etc.) we log a single warning and disable push — the
 * existing AppState polling still works.
 *
 * Public surface:
 *   - `initializePushNotifications({ token, deviceId, onPushReceived, baseUrl })`
 *     called once after login; registers the device, listens for foreground +
 *     token-refresh, returns a teardown function.
 *   - `unregisterPushNotifications(...)` called on logout; deletes the device
 *     row server-side.
 *
 * Push payload contract (matches what the API's push notifications send):
 *   FCM:   data: { userId, appId, version }
 *   APNs:  aps + { userId, appId, version }  (apns-push-type "background")
 *
 * We never trust the payload contents — it's a "you have new data" signal and
 * the receiver re-fetches via `db.syncFromRemoteIfNewer()`.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import { ApiError, registerPushDevice, unregisterPushDevice } from "@space/shared/api";
import { announceNewDevice, parseNewDevicePush, requestOpenDevices } from "../lib/pairing/newDevice";

const DEVICE_ID_KEY = "sf_push_device_id";

/**
 * Stable per-install identifier. We can't ask the OS for a real hardware ID
 * on iOS (Apple denies it for privacy) and react-native-device-info isn't a
 * dep here yet — AsyncStorage + a UUID is the correct cross-platform pattern.
 */
export const getOrCreateDeviceId = async (): Promise<string> => {
  const existing = await AsyncStorage.getItem(DEVICE_ID_KEY);
  if (existing && existing.length > 0) return existing;
  const cryptoRef = globalThis.crypto as
    | { randomUUID?: () => string; getRandomValues?: (arr: Uint8Array) => Uint8Array }
    | undefined;
  let id: string;
  if (cryptoRef?.randomUUID) {
    id = cryptoRef.randomUUID();
  } else {
    const bytes = new Uint8Array(16);
    if (cryptoRef?.getRandomValues) cryptoRef.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
    id = `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex
      .slice(8, 10)
      .join("")}-${hex.slice(10, 16).join("")}`;
  }
  await AsyncStorage.setItem(DEVICE_ID_KEY, id);
  return id;
};

export type PushPlatform = "ios" | "android";

export type PushInitInput = {
  /** Auth bearer token for /push/register. */
  authToken: string;
  /** Stable per-install identifier. Same value used on every registration. */
  deviceId: string;
  /** API base URL (e.g. https://api.spacefleet.io). */
  baseUrl: string;
  /** Called when a push arrives (in any state). The library store wires this
   * to `scheduler.triggerFromPush()`. */
  onPushReceived: () => void;
};

export type PushTeardown = () => Promise<void>;

/** The messaging calls the receiver makes, bound to the default Firebase app. */
type MessagingApi = {
  requestPermission: () => Promise<number>;
  getToken: () => Promise<string>;
  onTokenRefresh: (cb: (token: string) => void) => () => void;
  onMessage: (cb: (msg: unknown) => void) => () => void;
  onNotificationOpenedApp: (cb: (msg: unknown) => void) => () => void;
  getInitialNotification: () => Promise<unknown>;
  setBackgroundMessageHandler: (cb: (msg: unknown) => Promise<void>) => void;
};

/** The modular API of `@react-native-firebase/messaging` (the only one since v27: the default export is gone). */
type FirebaseMessagingModule = {
  getMessaging: () => unknown;
  requestPermission: (messaging: unknown) => Promise<number>;
  getToken: (messaging: unknown) => Promise<string>;
  onTokenRefresh: (messaging: unknown, cb: (token: string) => void) => () => void;
  onMessage: (messaging: unknown, cb: (msg: unknown) => void) => () => void;
  onNotificationOpenedApp: (messaging: unknown, cb: (msg: unknown) => void) => () => void;
  getInitialNotification: (messaging: unknown) => Promise<unknown>;
  setBackgroundMessageHandler: (messaging: unknown, cb: (msg: unknown) => Promise<void>) => void;
};

let loggedMissingModule = false;

const warnPushDisabled = (reason: string): void => {
  if (loggedMissingModule) return;
  loggedMissingModule = true;
  console.warn("[pushHandler] @react-native-firebase/messaging unavailable — push disabled", reason);
};

const loadMessaging = async (): Promise<(() => MessagingApi) | null> => {
  try {
    // Dynamic import keeps the JS bundle valid even when the native module
    // is not linked (e.g. Vitest/Jest test bundles, fresh checkouts).
    const fb = (await import(
      "@react-native-firebase/messaging" as string
    )) as FirebaseMessagingModule | { notInThisBuild: true };
    // The Google-free build resolves Firebase to a stand-in that loads but carries no API (mobile-shell foss.cjs).
    if ("notInThisBuild" in fb) {
      warnPushDisabled("not part of the Google-free build");
      return null;
    }
    return () => {
      const m = fb.getMessaging();
      return {
        requestPermission: () => fb.requestPermission(m),
        getToken: () => fb.getToken(m),
        onTokenRefresh: (cb) => fb.onTokenRefresh(m, cb),
        onMessage: (cb) => fb.onMessage(m, cb),
        onNotificationOpenedApp: (cb) => fb.onNotificationOpenedApp(m, cb),
        getInitialNotification: () => fb.getInitialNotification(m),
        setBackgroundMessageHandler: (cb) => fb.setBackgroundMessageHandler(m, cb),
      };
    };
  } catch (err) {
    warnPushDisabled((err as Error).message);
    return null;
  }
};

// TV clients have no push (LIB-SYNC-05): the Apple TV target links no Firebase (Podfile), and in a release bundle the
// messaging module's load failure is fatal before any catch runs, so a TV never loads it.
const resolvePlatform = (): PushPlatform | null => {
  if (Platform.isTV) return null;
  if (Platform.OS === "ios") return "ios";
  if (Platform.OS === "android") return "android";
  return null;
};

const registerToken = async (
  input: PushInitInput,
  platform: PushPlatform,
  token: string
): Promise<void> => {
  try {
    await registerPushDevice(input.baseUrl, input.authToken, { deviceId: input.deviceId, platform, token });
  } catch (err) {
    if (err instanceof ApiError) {
      console.warn("[pushHandler] /push/register failed", err.status, err.payload.error ?? "");
    } else {
      console.warn("[pushHandler] /push/register threw", (err as Error).message);
    }
  }
};

const unregisterToken = async (
  baseUrl: string,
  authToken: string,
  deviceId: string
): Promise<void> => {
  try {
    await unregisterPushDevice(baseUrl, authToken, deviceId);
  } catch (err) {
    // An answer other than 2xx was never reported here (best effort on logout); only a transport failure is.
    if (err instanceof ApiError) return;
    console.warn("[pushHandler] /push/unregister threw", (err as Error).message);
  }
};

/**
 * Initialize push receiver. Returns a teardown function that detaches all
 * listeners (call from useEffect cleanup or on logout BEFORE unregistering).
 */
export const initializePushNotifications = async (
  input: PushInitInput
): Promise<PushTeardown> => {
  const platform = resolvePlatform();
  if (!platform) return async () => undefined;

  const messagingFactory = await loadMessaging();
  if (!messagingFactory) return async () => undefined;

  const messaging = messagingFactory();

  // iOS prompts for notification permission. Android (API < 33) returns
  // granted by default; Android 13+ surfaces a runtime prompt that the app
  // shell handles before this runs.
  if (platform === "ios") {
    try {
      await messaging.requestPermission();
    } catch (err) {
      console.warn("[pushHandler] permission request failed", (err as Error).message);
      return async () => undefined;
    }
  }

  let initialToken: string;
  try {
    initialToken = await messaging.getToken();
  } catch (err) {
    console.warn("[pushHandler] getToken failed", (err as Error).message);
    return async () => undefined;
  }
  await registerToken(input, platform, initialToken);

  const unsubscribeRefresh = messaging.onTokenRefresh(async (next: string) => {
    await registerToken(input, platform, next);
  });

  const unsubscribeMessage = messaging.onMessage(async (message: unknown) => {
    // While the app is open the OS shows no banner, so a new-device push is announced in-app.
    const newDevice = parseNewDevicePush(message);
    if (newDevice) {
      console.warn("[pushHandler] new_device push", JSON.stringify({ deviceType: newDevice.deviceType }));
      announceNewDevice(newDevice);
    }
    input.onPushReceived();
  });

  // Background handler — runs in the JS context Firebase wakes for headless
  // pushes. We can't trigger a UI sync here; we just log so the scheduler can
  // sync on next foreground via `pushPending`. The scheduler already handles
  // that via the `lastReceivedAt` AsyncStorage seed on next foreground tick.
  // For now we no-op; foreground onMessage covers the active case.
  messaging.setBackgroundMessageHandler(async () => {
    // Intentionally no-op. Next AppState foreground will trigger sync via
    // the existing scheduler logic.
  });

  // ACCT-PAIR-03: tapping the "New device added" notification (app in background, or cold start
  // from it) opens the device list.
  const openedMessage = (message: unknown) => {
    if (parseNewDevicePush(message)) requestOpenDevices();
  };
  const unsubscribeOpened = messaging.onNotificationOpenedApp(openedMessage);
  void messaging
    .getInitialNotification()
    .then((message) => {
      if (message) openedMessage(message);
    })
    .catch((err: Error) => console.warn("[pushHandler] getInitialNotification failed", err.message));

  return async () => {
    unsubscribeRefresh();
    unsubscribeMessage();
    unsubscribeOpened();
  };
};

export const unregisterPushNotifications = async (
  baseUrl: string,
  authToken: string,
  deviceId: string
): Promise<void> => {
  await unregisterToken(baseUrl, authToken, deviceId);
};

// ---------------------------------------------------------------------------
// Test seam — exported so unit tests can swap the native module without going
// through the dynamic-import path.
// ---------------------------------------------------------------------------

type TestSeam = {
  loadMessaging: typeof loadMessaging;
};

export const __pushHandlerTestSeam: TestSeam = {
  loadMessaging,
};
