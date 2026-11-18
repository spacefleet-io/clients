/**
 * ACCT-DEV-01 / ACCT-PAIR-03: pure helpers for the signed-in device list and for spotting a device that was
 * added since this computer last looked.
 */
import type { Session } from "@space/shared/api";

export type DeviceKind = "desktop" | "mobile" | "tv" | "kodi" | "jellyfin" | "web" | "other";

const KNOWN_KINDS: readonly DeviceKind[] = ["desktop", "mobile", "tv", "kodi", "jellyfin", "web"];
const KNOWN_DEVICE_IDS_PREFIX = "sf_known_device_ids:";

/** Fired on `window` by the new-device check when it sees a device it has not seen before, so an open devices list reloads. */
export const DEVICES_CHANGED_EVENT = "sf:devices-changed";

/** Which kind of device a session belongs to: its declared type, else a guess from the client it signed in with. */
export const deviceKind = (session: Pick<Session, "deviceType" | "clientType">): DeviceKind => {
  const declared = (session.deviceType ?? "").toLowerCase();
  const known = KNOWN_KINDS.find((kind) => kind === declared);
  if (known) return known;
  const client = (session.clientType ?? "").toLowerCase();
  const fromBadger = KNOWN_KINDS.find((kind) => client === `badger-${kind}`);
  if (fromBadger) return fromBadger;
  if (client === "desktop") return "desktop";
  if (client === "client-mobile" || client === "mobile") return "mobile";
  if (client === "web" || client === "client-web") return "web";
  return "other";
};

/** Newest activity first; the device you are on stays on top. */
export const sortDevices = (sessions: Session[]): Session[] =>
  [...sessions].sort((a, b) => {
    if (Boolean(a.current) !== Boolean(b.current)) return a.current ? -1 : 1;
    return Date.parse(b.lastSeen ?? b.createdAt ?? "") - Date.parse(a.lastSeen ?? a.createdAt ?? "") || 0;
  });

/** Sessions the account has that this computer has not been told about yet (never the current one). */
export const findNewDevices = (known: ReadonlySet<string>, sessions: Session[]): Session[] =>
  sessions.filter((session) => !session.current && !known.has(session.id));

/** Ids of the sessions this computer has already shown; `null` the first time (nothing to compare with). */
export const readKnownDeviceIds = (
  userId: string,
  storage: Pick<Storage, "getItem"> = localStorage,
): Set<string> | null => {
  try {
    const raw = storage.getItem(`${KNOWN_DEVICE_IDS_PREFIX}${userId}`);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? new Set(parsed.filter((id): id is string => typeof id === "string")) : null;
  } catch {
    return null;
  }
};

export const writeKnownDeviceIds = (
  userId: string,
  sessions: Session[],
  storage: Pick<Storage, "setItem"> = localStorage,
) => {
  try {
    storage.setItem(`${KNOWN_DEVICE_IDS_PREFIX}${userId}`, JSON.stringify(sessions.map((session) => session.id)));
  } catch {
    // Quota / private mode: worst case a device is announced again after a restart.
  }
};

/** ACCT-PAIR-03: these sessions were announced but never seen (the window hid over their notice); the next look announces them again. */
export const forgetKnownDeviceIds = (
  userId: string,
  sessionIds: readonly string[],
  storage: Pick<Storage, "getItem" | "setItem"> = localStorage,
) => {
  const known = readKnownDeviceIds(userId, storage);
  if (known === null) return;
  for (const id of sessionIds) known.delete(id);
  try {
    storage.setItem(`${KNOWN_DEVICE_IDS_PREFIX}${userId}`, JSON.stringify([...known]));
  } catch {
    // Quota / private mode: the device stays recorded as seen.
  }
};

/**
 * ACCT-PAIR-03: reports every session this computer has not seen before and remembers the full list.
 * The first look at an account only records what is there, so signing in does not announce old devices.
 */
export const announceNewDevices = (
  userId: string,
  sessions: Session[],
  notify: (device: Session) => void,
  storage: Pick<Storage, "getItem" | "setItem"> = localStorage,
): Session[] => {
  const known = readKnownDeviceIds(userId, storage);
  const fresh = known === null ? [] : findNewDevices(known, sessions);
  for (const device of fresh) notify(device);
  writeKnownDeviceIds(userId, sessions, storage);
  return fresh;
};
