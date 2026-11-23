// Parrot's phone approves a new device (ACCT-PAIR-01, ACCT-PAIR-02) with the shared approver
// (`@space/mobile-shell/pairing-approve`, Badger's too). Only the side effects are Parrot's: the signed-in session's
// library key, and no push device id to send (Parrot has no push, so there is no "new device" notice to skip).
import { approvePairing, denyPairing, lookupPairing } from "@space/shared/api";
import type { PairingDeps } from "@space/mobile-shell/pairing-approve";
import { requireDeviceUnlock } from "@space/mobile-shell/pairing-approve/deviceUnlock";

export const createParrotPairingDeps = (getLibraryKey: () => Promise<string | null>): PairingDeps => ({
  lookup: lookupPairing,
  approve: (token, requestId, sealedKey, password) => approvePairing(token, requestId, sealedKey, undefined, password),
  deny: denyPairing,
  getLibraryKey,
  requireUnlock: requireDeviceUnlock,
  now: () => Date.now(),
});
