import AsyncStorage from "@react-native-async-storage/async-storage";
import { listDevices } from "@space/shared/api";
import { scopeLogger } from "@space/mobile-shell/logger";
import { announceDevicesChanged, announceNewDevice, diffNewSessions, type NewDeviceInfo } from "./newDevice";

const log = scopeLogger("pairing.watch");

const KNOWN_SESSIONS_KEY = "sf_known_session_ids";

const loadKnown = async (): Promise<string[] | null> => {
  const raw = await AsyncStorage.getItem(KNOWN_SESSIONS_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : null;
  } catch {
    return null;
  }
};

const saveKnown = (ids: string[]) => AsyncStorage.setItem(KNOWN_SESSIONS_KEY, JSON.stringify(ids));

/**
 * Records a device this phone approved itself: it is not "new" the next time the list is checked, and any open
 * devices list reloads so it shows the new device at once.
 */
export const rememberSession = async (sessionId: string): Promise<void> => {
  const known = (await loadKnown()) ?? [];
  if (!known.includes(sessionId)) await saveKnown([...known, sessionId]);
  log.warn("approved.remembered", { sessionId });
  announceDevicesChanged();
};

/**
 * The new-device notice for `sessionId` went away (timed out, opened or closed): the device is seen and the next check
 * never announces it again (ACCT-PAIR-03). The device-list check already records what it announces; this covers the push
 * path. Before the first look there is no list to add to: that first look records every device without announcing any.
 */
export const markDeviceSeen = async (sessionId: string | null): Promise<void> => {
  if (!sessionId) return;
  const known = await loadKnown();
  if (known === null || known.includes(sessionId)) return;
  await saveKnown([...known, sessionId]);
  log.warn("notice.seen", { sessionId });
};

export const forgetKnownSessions = (): Promise<void> => AsyncStorage.removeItem(KNOWN_SESSIONS_KEY);

/**
 * Compares the account's signed-in devices with the ones this phone has seen and announces any
 * new one (ACCT-PAIR-03). Safe to call whenever the app comes to the foreground; a failed check is
 * logged and ignored, the push path or the next check will catch it.
 */
export const checkForNewDevices = async (token: string): Promise<NewDeviceInfo[]> => {
  try {
    const { sessions } = await listDevices(token);
    const known = await loadKnown();
    const fresh = diffNewSessions(known, sessions);
    await saveKnown(sessions.map((session) => session.id));
    log.warn("check.done", { sessions: sessions.length, firstLook: known === null, newDevices: fresh.length });
    for (const info of fresh) announceNewDevice(info);
    return fresh;
  } catch (error) {
    log.warn("check.failed", { error: error instanceof Error ? error.message : String(error) });
    return [];
  }
};
