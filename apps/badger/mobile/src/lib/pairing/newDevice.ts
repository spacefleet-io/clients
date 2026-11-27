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

/** One notice per device: the push and the device-list check announcing the same session show it once. */
export const newDeviceKey = (info: NewDeviceInfo): string => info.sessionId ?? `${info.deviceType ?? ""}:${info.deviceName}`;

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
