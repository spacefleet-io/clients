// Parrot's phone approves a new device (ACCT-PAIR-01, ACCT-PAIR-02) with the shared approver
// (`@space/mobile-shell/pairing-approve`, Badger's too). Only the side effects are Parrot's: the signed-in session's
// library key, and no push device id to send (Parrot has no push, so there is no "new device" notice to skip).
import { approvePairing, approvePairingLocal, denyPairing, lookupPairing } from "@space/shared/api";
import type { PairingDeps } from "@space/mobile-shell/pairing-approve";
import type { SiblingApproveDeps } from "@space/pairing-crypto";
import { requireDeviceUnlock } from "@space/mobile-shell/pairing-approve/deviceUnlock";
import { pairingCheckDeps } from "@space/mobile-shell/pairing-approve/checkDeps";

export const createParrotPairingDeps = (getLibraryKey: () => Promise<string | null>): PairingDeps => ({
  lookup: lookupPairing,
  approve: (token, requestId, sealedKey, password) => approvePairing(token, requestId, sealedKey, undefined, password),
  deny: denyPairing,
  getLibraryKey,
  requireUnlock: requireDeviceUnlock,
  now: () => Date.now(),
  // sf-pair-v2 (PRIV-PAIR-01, PRIV-PAIR-02): the key probe check and the random-number exchange.
  ...pairingCheckDeps("parrot"),
});

/**
 * Badger on this phone asks to sign in with Parrot's account (ACCT-PAIR-07): the API is told only to approve; the key,
 * sealed to Badger, goes back over the local channel. No unlock: the user answered on this unlocked phone.
 */
export const createParrotSiblingDeps = (getLibraryKey: () => Promise<string | null>): SiblingApproveDeps => ({
  lookup: lookupPairing,
  approveLocal: (token, requestId) => approvePairingLocal(token, requestId),
  deny: denyPairing,
  getLibraryKey,
  now: () => Date.now(),
});
