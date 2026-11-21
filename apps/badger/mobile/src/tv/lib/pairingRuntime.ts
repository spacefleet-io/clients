/**
 * App wiring for the TV pairing logic: where the API lives, what this TV is called, and which library, decrypt
 * function and key store the shared completion (`@space/mobile-shell/pairing`, also Parrot's) uses.
 * Imported by the screens only; the logic modules stay free of native imports.
 */
import { getApiBaseUrl } from "@space/shared/api";
import { READ_OP_STREAM_VERSION } from "@space/library-db-definition/ops";
import { decryptBase64ToBytes } from "../../lib/crypto";
import { scopeLogger } from "@space/mobile-shell/logger";
import { setLibraryKeyAcknowledged, setStoredLibraryKey } from "../../lib/onboarding";
import {
  createPairingCompletionDeps,
  type PairingCompletionDeps,
  type PairingRuntimeOptions,
} from "@space/mobile-shell/pairing";
import { createTvPairingClient } from "@space/mobile-shell/tv/pairingClient";
import { currentTvDeviceName } from "@space/mobile-shell/pairing-device";

/** Log prefix of every TV pairing line (client, controller, completion), so one grep follows a sign-in. */
export const TV_PAIRING_LOG_TAG = "tv.pairing";

/** What the shared key check and completion need from Badger TV: its library, its decrypt function, its log tag. */
export const TV_PAIRING_RUNTIME: PairingRuntimeOptions = {
  library: "badger",
  decrypt: decryptBase64ToBytes,
  logTag: TV_PAIRING_LOG_TAG,
  readOpStreamVersion: READ_OP_STREAM_VERSION, // op-stream: read
};

const log = scopeLogger(TV_PAIRING_LOG_TAG);

/** `sessionToken`: key mode, the signed-in TV asks only for the library key (its key screen). */
export const createRuntimePairingClient = (sessionToken?: () => string | null) =>
  createTvPairingClient({ appId: "badger", getApiBaseUrl, deviceName: currentTvDeviceName, sessionToken, log: (message, extra) => log.info(message, extra) });

/** `keepSession`: key mode, a refused key never signs this TV out. */
export const createRuntimeCompletionDeps = (setSession: PairingCompletionDeps["setSession"], keepSession = false): PairingCompletionDeps =>
  createPairingCompletionDeps({ ...TV_PAIRING_RUNTIME, setStoredLibraryKey, setLibraryKeyAcknowledged, setSession, keepSession });
