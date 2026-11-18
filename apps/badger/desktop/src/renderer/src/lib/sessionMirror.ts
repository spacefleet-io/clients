/**
 * #25: keeps the signed-in session (see shared/sessionKeys.ts) in the main
 * process too, because Chromium's localStorage alone does not survive an abrupt
 * kill / crash reliably (about 30% of relaunches rendered the Login page with an
 * empty localStorage). Main fsyncs its copy before `replace` resolves
 * (main/sessionStore.ts).
 *
 * - `hydrateSessionFromMain()` runs once, before the first render, and refills
 *   ONLY keys localStorage lacks (a present value is the fresher copy).
 * - `persistSessionToMain()` mirrors the session keys currently in localStorage
 *   as a full replacement, so logout / a 401 (which remove them) clear main's
 *   copy too and a cleared session can never be resurrected.
 */
import { isSessionStorageKey, sanitizeSessionEntries, type SessionEntries } from "../../../shared/sessionKeys";
import { rendererLogger } from "@/logger";

const log = rendererLogger.child({ scope: "session-mirror" });

const readLocalSessionEntries = (): SessionEntries => {
  const entries: SessionEntries = {};
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key === null || !isSessionStorageKey(key)) continue;
      const value = localStorage.getItem(key);
      if (value !== null) entries[key] = value;
    }
  } catch (err) {
    log.warn({ err: String(err) }, "[session-mirror] could not read localStorage");
  }
  return entries;
};

/** Refill missing session keys from main's copy. Returns the keys restored. */
export const hydrateSessionFromMain = (): string[] => {
  const restored: string[] = [];
  try {
    const snapshot = sanitizeSessionEntries(window.sf?.session?.snapshot);
    for (const [key, value] of Object.entries(snapshot)) {
      if (localStorage.getItem(key) !== null) continue;
      localStorage.setItem(key, value);
      restored.push(key);
    }
  } catch (err) {
    log.warn({ err: String(err) }, "[session-mirror] hydrate failed");
    return restored;
  }
  if (restored.length > 0) {
    // Chromium handed us an empty localStorage for a session main still has: exactly the bug.
    log.warn({ restored }, "[session-mirror] localStorage was missing session keys; restored from main process");
  }
  return restored;
};

/** Mirror the session keys in localStorage to main (full replacement). Never throws. */
export const persistSessionToMain = async (): Promise<void> => {
  try {
    const session = window.sf?.session;
    if (!session) return;
    await session.replace(readLocalSessionEntries());
  } catch (err) {
    log.error({ err: String(err) }, "[session-mirror] persisting the session to main failed");
  }
};
