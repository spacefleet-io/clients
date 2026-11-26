/**
 * "A new device was added" (ACCT-PAIR-03), phone side.
 *
 * Two paths tell the phone, so it never depends on push alone:
 *  1. the push the API sends on approve (FCM notification + data `kind: "new_device"`), and
 *  2. a device-list check when the app comes to the foreground: any signed-in session the phone
 *     has not seen before is announced.
 */

import { translate } from "@space/mobile-shell/i18n";
import { deviceTypeLabel, sessionDeviceType } from "@space/mobile-shell/pairing-approve";
import type { Notice } from "@space/notify-core/kinds";
import { notifyTexts } from "@space/notify-core/texts";

export type NewDeviceInfo = {
  sessionId: string | null;
  deviceName: string;
  deviceType: string | null;
};

type SessionLike = {
  id: string;
  current?: boolean;
  deviceName?: string | null;
  deviceType?: string | null;
  clientType?: string | null;
};

export const newDeviceMessage = (info: Pick<NewDeviceInfo, "deviceName" | "deviceType">): string =>
  translate("pairing.newDevice.message", { name: info.deviceName, type: deviceTypeLabel(info.deviceType) });

/**
 * One notice per device: the push and the device-list check announcing the same session show it once, and the key is
 * the one the account's news gives that sign-in (UX-NOTICE-05), so the phone's own entry and the news are one entry.
 */
export const newDeviceKey = (info: NewDeviceInfo): string =>
  info.sessionId ? `new-device-${info.sessionId}` : `${info.deviceType ?? ""}:${info.deviceName}`;

/** The device's kind as a text key, so the entry names it in the language the history is read in (UX-NOTICE-13). */
const deviceTypeKey = (deviceType: string | null): string =>
  `notify.account.deviceType.${deviceType && Object.hasOwn(notifyTexts.en.account.deviceType, deviceType) ? deviceType : "other"}`;

/** Where a new-device entry in the notice history leads: Settings, at "Your devices". */
export const DEVICES_TARGET = "devices";

/**
 * The new device as a notice-history entry (UX-NOTICE-04), the same on the phone and the TV: the same device again
 * replaces its entry (UX-NOTICE-11), and its texts are keys, so the entry follows a change of language (UX-NOTICE-13).
 */
export const newDeviceHistoryNotice = (info: NewDeviceInfo): Notice => ({
  key: newDeviceKey(info),
  kind: "headsUp",
  level: "info",
  scope: "account",
  title: { key: "notify.account.newDevice" },
  message: { key: "notify.account.newDeviceMessage", vars: { name: info.deviceName, type: { key: deviceTypeKey(info.deviceType) } } },
  action: { label: { key: "account.devices.title" }, target: DEVICES_TARGET },
});

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : null;

/** Reads a Firebase remote message (or an APNs payload) and returns the new device, if it is that kind of push. */
export const parseNewDevicePush = (message: unknown): NewDeviceInfo | null => {
  const root = asRecord(message);
  if (!root) return null;
  // @react-native-firebase delivers custom keys under `data`; APNs custom keys can arrive at the top level.
  const data = asRecord(root.data) ?? root;
  if (data.kind !== "new_device") return null;
  const deviceName = typeof data.deviceName === "string" ? data.deviceName.trim() : "";
  if (!deviceName) return null;
  return {
    sessionId: typeof data.sessionId === "string" ? data.sessionId : null,
    deviceName,
    deviceType: typeof data.deviceType === "string" ? data.deviceType : null,
  };
};

/**
 * Sessions that appeared since the phone last looked. `known === null` means this is the first
 * look: nothing is announced, the list is just remembered. The phone's own session never counts.
 */
export const diffNewSessions = (known: readonly string[] | null, sessions: readonly SessionLike[]): NewDeviceInfo[] => {
  if (known === null) return [];
  const seen = new Set(known);
  return sessions
    .filter((session) => !session.current && !seen.has(session.id))
    .map((session) => ({
      sessionId: session.id,
      deviceName: session.deviceName?.trim() || deviceTypeLabel(sessionDeviceType(session)),
      deviceType: sessionDeviceType(session),
    }));
};

type Listener = (info: NewDeviceInfo) => void;
type OpenListener = () => void;

const newDeviceListeners = new Set<Listener>();
const openListeners = new Set<OpenListener>();
let pendingOpen = false;

export const subscribeNewDevice = (listener: Listener): (() => void) => {
  newDeviceListeners.add(listener);
  return () => newDeviceListeners.delete(listener);
};

export const announceNewDevice = (info: NewDeviceInfo): void => {
  for (const listener of newDeviceListeners) listener(info);
};

const devicesChangedListeners = new Set<() => void>();

/** The account's device list changed on this phone (it approved a device): open device lists reload. No banner. */
export const subscribeDevicesChanged = (listener: () => void): (() => void) => {
  devicesChangedListeners.add(listener);
  return () => devicesChangedListeners.delete(listener);
};

export const announceDevicesChanged = (): void => {
  for (const listener of devicesChangedListeners) listener();
};

/** The user tapped the notification: the device list should open. Remembered until someone listens. */
export const subscribeOpenDevices = (listener: OpenListener): (() => void) => {
  openListeners.add(listener);
  if (pendingOpen) {
    pendingOpen = false;
    listener();
  }
  return () => openListeners.delete(listener);
};

export const requestOpenDevices = (): void => {
  if (openListeners.size === 0) {
    pendingOpen = true;
    return;
  }
  for (const listener of openListeners) listener();
};
