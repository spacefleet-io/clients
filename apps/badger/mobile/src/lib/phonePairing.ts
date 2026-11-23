/**
 * ACCT-PAIR-01, Badger phone side: the phone shows a QR + short code and a signed-in Badger (computer, TV or phone)
 * approves it. Signed out, that signs it in; on the key screen, already signed in by email, it only brings the library
 * key (key mode). The protocol is the shared `createPairingClientCore`, the completion the shared one
 * (`@space/mobile-shell/pairing`, also the TV's and Parrot's); this file fixes only what is phone specific.
 */
import { getApiBaseUrl } from "@space/shared/api";
import { createPairingClientCore } from "@space/pairing-crypto";
import { scopeLogger } from "@space/mobile-shell/logger";
import { createPairingCompletionDeps, type PairingCompletionDeps } from "@space/mobile-shell/pairing";
import { currentPhoneDeviceName as currentDeviceName, phoneDeviceName as appPhoneDeviceName } from "@space/mobile-shell/pairing-device";
import { decryptBase64ToBytes } from "./crypto";
import { setLibraryKeyAcknowledged, setStoredLibraryKey } from "./onboarding";

export const PHONE_PAIRING_LOG_TAG = "phone.pairing";
const FALLBACK_NAME = "Badger (phone)";
const log = scopeLogger(PHONE_PAIRING_LOG_TAG);

/** "Badger (Pixel 8)": the approver asks "Add <name>?", so the name says which app asks and on which phone. */
export const phoneDeviceName = (model: string | null | undefined): string => appPhoneDeviceName("Badger", model);

export const currentPhoneDeviceName = (): string => currentDeviceName("Badger");

/** `sessionToken`: key mode, the signed-in phone asks only for the library key with its own session. */
export const createPhonePairingClient = (sessionToken?: () => string | null) =>
  createPairingClientCore({
    appId: "badger",
    getApiBaseUrl,
    deviceType: "mobile",
    deviceName: currentPhoneDeviceName,
    fallbackDeviceName: FALLBACK_NAME,
    pollWaitSeconds: 25,
    sessionToken,
    log: (message, extra) => log.info(message, extra),
  });

/** `keepSession`: key mode, a refused key never signs this phone out. */
export const createPhoneCompletionDeps = (setSession: PairingCompletionDeps["setSession"], keepSession = false): PairingCompletionDeps =>
  createPairingCompletionDeps({
    library: "badger",
    decrypt: decryptBase64ToBytes,
    logTag: PHONE_PAIRING_LOG_TAG,
    setStoredLibraryKey,
    setLibraryKeyAcknowledged,
    setSession,
    keepSession,
  });
