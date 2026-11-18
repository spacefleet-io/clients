// The key screen's pairing (ACCT-PAIR-01): the shared panel, in key mode, brings only the library key. The sign-in
// by pairing is the shared `MobilePairSignIn` on the sign-in page (LoginScreen).
import React from "react";
import { useTranslation } from "@space/mobile-shell/i18n";
import { completePairing } from "@space/mobile-shell/pairing";
import { currentPhoneDeviceName } from "@space/mobile-shell/pairing-device";
import { MobilePairingPanel, MobilePairingText } from "@space/mobile-shell/pairing-panel";
import { useSession } from "../state/session";
import { createParrotCompletionDeps, createParrotPairingClient, PARROT_PAIRING_LOG_TAG } from "../setup/pairing";

/**
 * "Get the key from another device" on the key screen (ACCT-PAIR-01, PRIV-KEY-05): the phone, signed in by email,
 * keeps its session; the approval seals only the library key to it, which is checked and kept like a typed key.
 */
export const KeyPairingPanel = ({ onKeySaved }: { onKeySaved: () => void }) => {
  const { t } = useTranslation();
  const { session, saveLibraryKey } = useSession();
  return (
    <MobilePairingPanel
      createClient={() => createParrotPairingClient(() => session?.token ?? null)}
      complete={async (approved) => {
        // The shared completion stores the key in the key store; `saveLibraryKey` also opens the library with it.
        const completion = await completePairing(createParrotCompletionDeps(() => saveLibraryKey(approved.libraryKey), true), approved);
        if (completion.ok) onKeySaved();
        return completion;
      }}
      logTag={PARROT_PAIRING_LOG_TAG}
      app="parrot"
      purpose="key"
      deviceName={currentPhoneDeviceName("Parrot")}
      heading={<MobilePairingText tone="body">{t("phonePairing.keyTitle")}</MobilePairingText>}
      testIDPrefix="key-pairing"
    />
  );
};
