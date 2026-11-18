// The pairing half of the sign-in (UX-SETUP-06, ACCT-PAIR-01): the shared panel with a QR code and a short code that
// any signed-in Badger or Parrot app approves, a countdown and "Get a new code". The pairing brings the session and the
// library key. On the key screen the same panel, in key mode, brings only the key (`KeyPairingPanel`).
import React from "react";
import { useTranslation } from "@space/mobile-shell/i18n";
import { completePairing } from "@space/mobile-shell/pairing";
import { currentPhoneDeviceName } from "@space/mobile-shell/pairing-device";
import { MobilePairingPanel, type MobilePairingPanelLook } from "@space/mobile-shell/pairing-panel";
import { useSession } from "../state/session";
import { createParrotCompletionDeps, createParrotPairingClient, PARROT_PAIRING_LOG_TAG } from "../setup/pairing";
import { spacing } from "../theme";
import { Body, Button, ErrorText } from "./ui";

const ParrotPairingText: MobilePairingPanelLook["Text"] = ({ tone, children }) =>
  tone === "error" ? <ErrorText>{children}</ErrorText> : <Body muted={tone === "muted"}>{children}</Body>;

const ParrotPairingButton: MobilePairingPanelLook["Button"] = ({ label, onPress }) => <Button label={label} tone="plain" onPress={onPress} />;

const PARROT_PANEL_LOOK = {
  Text: ParrotPairingText,
  Button: ParrotPairingButton,
  gap: spacing.md,
  codeGap: spacing.sm,
  qrPadding: spacing.md,
} satisfies MobilePairingPanelLook;

/** Shows the code a signed-in Badger approves; the code is requested when this mounts and dropped when it unmounts. */
export const PairingPanel = ({ onPaired }: { onPaired: () => Promise<void> }) => {
  const { t } = useTranslation();
  const { signIn } = useSession();
  return (
    <MobilePairingPanel
      createClient={createParrotPairingClient}
      complete={(approved) =>
        completePairing(
          createParrotCompletionDeps(async (token, user) => {
            // The key is already stored: mark it so the key step is skipped, then sign in.
            await onPaired();
            await signIn({ token, user: { id: user.id, email: user.email, emailVerified: !!user.emailVerified } });
          }),
          approved
        )
      }
      logTag={PARROT_PAIRING_LOG_TAG}
      app="parrot"
      deviceName={currentPhoneDeviceName("Parrot")}
      heading={<Body>{t("setup.signIn.pairTitle")}</Body>}
      {...PARROT_PANEL_LOOK}
    />
  );
};

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
      heading={<Body>{t("phonePairing.keyTitle")}</Body>}
      testIDPrefix="key-pairing"
      {...PARROT_PANEL_LOOK}
    />
  );
};
