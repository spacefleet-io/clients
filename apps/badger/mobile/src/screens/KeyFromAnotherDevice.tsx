import React from "react";
import { useTranslation } from "@space/mobile-shell/i18n";
import { completePairing } from "@space/mobile-shell/pairing";
import { MobilePairingPanel, MobilePairingText } from "@space/mobile-shell/pairing-panel";
import { useAuth } from "../store/auth";
import { useLibrary } from "../store/library";
import { createPhoneCompletionDeps, createPhonePairingClient, currentPhoneDeviceName, PHONE_PAIRING_LOG_TAG } from "../lib/phonePairing";
import { IS_TV } from "../tv/lib/tvRuntime";
import { TV_PAIRING_LOG_TAG, createRuntimeCompletionDeps, createRuntimePairingClient } from "../tv/lib/pairingRuntime";
import { currentTvDeviceName } from "@space/mobile-shell/pairing-device";

/**
 * The key screen's "Get the key from another device" (ACCT-PAIR-01, PRIV-KEY-05): the phone or TV, already signed in
 * by email, shows a code; a signed-in Badger or Parrot approves it and seals the library key to it. Its own session
 * is kept, so the key is checked, stored and acknowledged as if it had been typed.
 */
export const KeyFromAnotherDevice = () => {
  const { t } = useTranslation();
  const { token } = useAuth();
  const { acknowledgeKey } = useLibrary();
  const sessionToken = () => token ?? null;
  return (
    <MobilePairingPanel
      createClient={() => (IS_TV ? createRuntimePairingClient(sessionToken) : createPhonePairingClient(sessionToken))}
      complete={(approved) =>
        // The session stays as it is: only the library reloads with the key.
        completePairing(IS_TV ? createRuntimeCompletionDeps(acknowledgeKey, true) : createPhoneCompletionDeps(acknowledgeKey, true), approved)
      }
      logTag={IS_TV ? TV_PAIRING_LOG_TAG : PHONE_PAIRING_LOG_TAG}
      deviceName={IS_TV ? currentTvDeviceName() : currentPhoneDeviceName()}
      app="badger"
      purpose="key"
      heading={<MobilePairingText tone="body">{t("phonePairing.keyTitle")}</MobilePairingText>}
      testIDPrefix="key-pairing"
    />
  );
};
