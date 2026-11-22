/**
 * #25: IPC for the main-process session copy (see sessionStore.ts).
 *
 * `sf-session-snapshot` is a SYNCHRONOUS channel on purpose: the preload reads
 * it once at load so `window.sf.session.snapshot` is available before any
 * renderer module (AuthProvider reads localStorage in a useState initializer)
 * runs. It is registered before the window is created, and it serves the copy
 * `store.load()` decrypted (async safeStorage), so main awaits `load()` before
 * creating the first window.
 */
import { secretSafeStorage } from "@space/desktop-platform/secret-file";
import { app, ipcMain, safeStorage } from "electron";
import { join } from "node:path";
import { SESSION_REPLACE_CHANNEL, SESSION_SNAPSHOT_CHANNEL, type SessionEntries } from "../shared/sessionKeys";
import { scopeLogger } from "./logger";
import { createSessionStore, type SessionStore } from "./sessionStore";

const logger = scopeLogger("session-store");

/** `onReplace`: every time the window saves its session (sign-in, sign-out, key change), with the stored copy. */
export const registerSessionIpc = (options: { onReplace?: (entries: SessionEntries) => void } = {}): SessionStore => {
  // `secretSafeStorage` passes Electron's sync `decryptString` only while Electron
  // has it (46 removes it), so the login migration simply turns off once it is gone.
  const store = createSessionStore({
    filePath: join(app.getPath("userData"), "session.json"),
    safeStorage: secretSafeStorage(safeStorage),
    log: (line) => logger.info(line),
  });
  ipcMain.on(SESSION_SNAPSHOT_CHANNEL, (event) => {
    try {
      event.returnValue = store.read();
    } catch (err) {
      logger.error({ err: String(err) }, "[session-store] snapshot failed");
      event.returnValue = {};
    }
  });
  ipcMain.handle(SESSION_REPLACE_CHANNEL, async (_event, entries: unknown) => {
    try {
      await store.replace(entries);
      options.onReplace?.(store.read());
      return { ok: true };
    } catch (err) {
      logger.error({ err: String(err) }, "[session-store] persist failed");
      throw err;
    }
  });
  return store;
};
