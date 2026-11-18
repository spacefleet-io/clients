// Parrot as a new device in pairing (ACCT-PAIR-01, UX-SETUP-06): the phone shows a QR code and a short code, a signed-in
// Badger approves it, and the approval brings both the session and the library key. The flow, the key check and the
// completion are the shared ones (`@space/mobile-shell/pairing`, also Badger TV's); only where the API lives, the
// device name, the library and the key store are here.
import { getApiBaseUrl } from "@space/shared/api";
import { createPairingClientCore } from "@space/pairing-crypto";
import { decryptBase64ToBytes } from "@space/mobile-shell/libraryEnvelope";
import { createPairingCompletionDeps, type PairingCompletionDeps } from "@space/mobile-shell/pairing";
import { scopeLogger } from "@space/mobile-shell/logger";
import { keptKeyOwnerStore, libraryKeyStore } from "../lib/stores";
import { currentPhoneDeviceName } from "@space/mobile-shell/pairing-device";

export const PARROT_PAIRING_LOG_TAG = "parrot.pairing";

const log = scopeLogger(PARROT_PAIRING_LOG_TAG);

/** `sessionToken`: key mode, the signed-in phone asks only for the library key with its own session (its key screen). */
export const createParrotPairingClient = (sessionToken?: () => string | null) =>
  createPairingClientCore({
    // The approver reads "Parrot on Parrot (Pixel 8) wants to sign in"; the session is `parrot-mobile` (ACCT-PAIR-05).
    appId: "parrot",
    getApiBaseUrl,
    deviceType: "mobile",
    deviceName: () => currentPhoneDeviceName("Parrot"),
    fallbackDeviceName: "Parrot (phone)",
    sessionToken,
    // Long polls: one request held open by the API instead of one every few seconds.
    pollWaitSeconds: 25,
    log: (message, extra) => log.info(message, extra),
  });

/** `keepSession`: key mode, a refused key never signs this phone out. */
export const createParrotCompletionDeps = (setSession: PairingCompletionDeps["setSession"], keepSession = false): PairingCompletionDeps =>
  createPairingCompletionDeps({
    library: "parrot",
    decrypt: decryptBase64ToBytes,
    logTag: PARROT_PAIRING_LOG_TAG,
    // The paired key is the signing-in account's own, so no kept key from a rejected session competes with it.
    setStoredLibraryKey: async (key) => {
      await libraryKeyStore.set(key);
      await keptKeyOwnerStore.forget();
    },
    setLibraryKeyAcknowledged: () => libraryKeyStore.acknowledge(),
    setSession,
    keepSession,
  });
