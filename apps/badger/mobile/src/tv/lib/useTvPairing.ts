import { useState } from "react";
import { completePairing, type PairingState } from "@space/mobile-shell/pairing";
import { usePairing } from "@space/mobile-shell/pairing-hook";
import { useAuth } from "../../store/auth";
import { TV_PAIRING_LOG_TAG, createRuntimeCompletionDeps, createRuntimePairingClient } from "./pairingRuntime";
import { markTvSetupPaired } from "./tvSetupStore";

/** Pairing state for the TV sign-in screen: the shared pairing hook with the TV's client and completion. */
export const useTvPairing = (): { state: PairingState; restart: () => void } => {
  const { setSession } = useAuth();
  const [client] = useState(createRuntimePairingClient);
  return usePairing({
    client,
    // Rebuilt each render so the latest session setter is used; the shared hook always calls the latest `complete`.
    complete: async (approved) => {
      const completion = await completePairing(createRuntimeCompletionDeps(setSession), approved);
      // Pairing brought the key: the key step is not part of this TV's setup (UX-SETUP-04, UX-SETUP-08).
      if (completion.ok) await markTvSetupPaired();
      return completion;
    },
    logTag: TV_PAIRING_LOG_TAG,
  });
};
