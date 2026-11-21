// Parrot TV's sign-in by pairing (PAR-TV-02, ACCT-PAIR-01): the TV shows a QR code and a short code, a signed-in Parrot
// approves it, and the approval brings both the session and the library key. The client is the family's TV client
// (`@space/mobile-shell/tv/pairingClient`, device type "tv", the session `parrot-tv`); the completion is the phone's
// (`../setup/pairing`), which stores the key in Parrot's key store.
import { useState } from "react";
import { getApiBaseUrl } from "@space/shared/api";
import { completePairing, type PairingState } from "@space/mobile-shell/pairing";
import { usePairing } from "@space/mobile-shell/pairing-hook";
import { scopeLogger } from "@space/mobile-shell/logger";
import { currentTvDeviceName } from "@space/mobile-shell/pairing-device";
import { createTvPairingClient } from "@space/mobile-shell/tv/pairingClient";
import { createParrotCompletionDeps } from "../setup/pairing";
import { useSession } from "../state/session";

/** Log prefix of every Parrot TV pairing line (client, controller, completion), so one grep follows a sign-in. */
export const PARROT_TV_PAIRING_LOG_TAG = "parrot.tv.pairing";

const log = scopeLogger(PARROT_TV_PAIRING_LOG_TAG);

export const createParrotTvPairingClient = () =>
  createTvPairingClient({ appId: "parrot", getApiBaseUrl, deviceName: currentTvDeviceName, log: (message, extra) => log.info(message, extra) });

/** Pairing state for the TV sign-in screen: the shared hook with Parrot's TV client and the phone's completion. */
export const useTvPairing = (): { state: PairingState; restart: () => void } => {
  const { signIn } = useSession();
  const [client] = useState(createParrotTvPairingClient);
  return usePairing({
    client,
    // Rebuilt each render so the latest `signIn` is used; the shared hook always calls the latest `complete`.
    complete: (approved) =>
      completePairing(
        createParrotCompletionDeps(async (token, user) => {
          log.info("signed_in", { userId: user.id });
          await signIn({ token, user: { id: user.id, email: user.email, emailVerified: !!user.emailVerified } });
        }),
        approved,
      ),
    logTag: PARROT_TV_PAIRING_LOG_TAG,
  });
};
