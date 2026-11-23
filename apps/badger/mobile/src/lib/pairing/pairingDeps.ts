import { Platform } from "react-native";
import { approvePairing, denyPairing, lookupPairing } from "@space/shared/api";
import { getOrCreateDeviceId } from "../../native/pushHandler";
import { getStoredLibraryKey } from "../onboarding";
import { requireDeviceUnlock } from "@space/mobile-shell/pairing-approve/deviceUnlock";
import type { PairingDeps } from "@space/mobile-shell/pairing-approve";

/**
 * The real side effects behind the pairing flow: API, library key in the keychain, phone unlock. A TV has no
 * unlock (`requireUnlock: null`): its approver screen asks the account password, or a code when the account has
 * none (ACCT-AUTH-04), and the API checks it.
 */
export const pairingDeps: PairingDeps = {
  lookup: lookupPairing,
  // Telling the API which push device approved keeps this phone from being notified about the
  // device it just added itself (ACCT-PAIR-03).
  approve: async (token, requestId, sealedKey, password, twoFactorCode) =>
    approvePairing(token, requestId, sealedKey, await getOrCreateDeviceId().catch(() => undefined), password, twoFactorCode),
  deny: denyPairing,
  getLibraryKey: getStoredLibraryKey,
  requireUnlock: Platform.isTV ? null : requireDeviceUnlock,
  now: () => Date.now(),
};
