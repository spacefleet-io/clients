/**
 * ACCT-PAIR-01: IPC for the "Sign in with your phone" screen and the key screen's "Get the key from another device";
 * the logic is the shared @space/desktop-shell pairing client.
 */
import { hostname as osHostname } from "node:os";
import { ipcMain } from "electron";
import { pairingModeOf, type PairingPollResult, type PairingStartResult } from "@space/desktop-shell/pairing";
import {
  createDesktopPairingClient,
  pairingRefusalOf,
  resolveDeviceName,
  type DesktopPairingClient,
} from "@space/desktop-shell/pairing-main";
import { getApiBaseUrl } from "./apiHost";
import { scopeLogger } from "./logger";

const logger = scopeLogger("pairing");

export const registerPairingIpc = (): DesktopPairingClient => {
  // Key mode: the session the window signed in with, as it last pushed it to main (`sf-auth-set-token`).
  let windowSessionToken: string | null = null;
  const client = createDesktopPairingClient({
    getApiBaseUrl,
    appId: "badger",
    log: (message, extra) => logger.info(extra ?? {}, message),
    sessionToken: () => windowSessionToken,
  });
  ipcMain.handle("sf-pairing-start", async (_event, options: unknown): Promise<PairingStartResult> => {
    const mode = pairingModeOf(options);
    try {
      if (mode === "key") {
        // Loaded at startup already (index.ts): this import only hands back the module.
        windowSessionToken = (await import("./runtimeJobsIpc")).getRuntimeJobsBackendToken();
        logger.info({ hasSession: Boolean(windowSessionToken) }, "pairing: key-only request from the key screen");
      }
      return { ok: true, ...(await client.start({ mode })) };
    } catch (err) {
      logger.warn({ message: err instanceof Error ? err.message : String(err) }, "pairing start failed");
      return { ok: false, ...pairingRefusalOf(err) };
    }
  });
  ipcMain.handle("sf-pairing-poll", async (_event, requestId: unknown): Promise<PairingPollResult> => {
    if (typeof requestId !== "string" || !requestId) return { ok: false, error: "failed" };
    try {
      return { ok: true, ...(await client.poll(requestId)) };
    } catch (err) {
      logger.warn({ message: err instanceof Error ? err.message : String(err) }, "pairing poll failed");
      return { ok: false, ...pairingRefusalOf(err) };
    }
  });
  ipcMain.handle("sf-pairing-device-name", () => resolveDeviceName(osHostname()));
  ipcMain.handle("sf-pairing-cancel", () => client.cancel());
  return client;
};
