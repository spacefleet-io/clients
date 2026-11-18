import React, { useCallback } from "react";
import { useNavigation } from "@react-navigation/native";
import { completePairing } from "@space/mobile-shell/pairing";
import { MobilePairSignIn } from "@space/mobile-shell/pair-sign-in";
import { useAuth } from "../store/auth";
import { createPhoneCompletionDeps, createPhonePairingClient, currentPhoneDeviceName, PHONE_PAIRING_LOG_TAG } from "../lib/phonePairing";
import { markPhoneSetupPaired } from "../setup/phoneSetupStore";

/**
 * Sign in with another device (UX-PHONE-10, ACCT-PAIR-01): the page both phones share. This phone shows a code; a
 * signed-in app approves it and sends the session and the library key. Back returns to the sign-in form.
 */
export const PairSignInScreen = () => {
  const navigation = useNavigation();
  const { setSession } = useAuth();
  const onBack = useCallback(() => navigation.goBack(), [navigation]);
  return (
    <MobilePairSignIn
      app="badger"
      createClient={createPhonePairingClient}
      complete={async (approved) => {
        const completion = await completePairing(createPhoneCompletionDeps(setSession), approved);
        // Pairing brought the key: the setup's key screen does not apply (UX-SETUP-03 screen 3).
        if (completion.ok) await markPhoneSetupPaired();
        return completion;
      }}
      logTag={PHONE_PAIRING_LOG_TAG}
      deviceName={currentPhoneDeviceName()}
      onBack={onBack}
    />
  );
};
