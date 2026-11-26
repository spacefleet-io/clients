/**
 * ACCT-UNPAID-06 on a phone or TV: in place of the library step, an unpaid account is told plainly that its plan has
 * ended and that the library can be set up once it is renewed. It only informs (ACCT-PAY-02): no Renew, no link, no
 * word about paying. "Try again" runs the library step again, so setup goes on from here once the plan is renewed
 * elsewhere. One screen for Badger phone, Badger TV and Parrot phone, laid out as their other setup steps.
 */
import React, { type ReactNode } from "react";
import { StyleSheet, Text } from "react-native";
import type { ClientUiLanguage } from "@space/shared/i18n";
import type { KeySavedWarningApp } from "@space/shared/keySavedWarning";
import { unpaidLibrarySetupText } from "@space/shared/unpaidLibrarySetup";
import { useMobileShellTheme } from "../theme";
import { MobileSetupStep } from "./mobile-setup-step";

export type MobileUnpaidSetupStepProps = {
  language: ClientUiLanguage;
  app: KeySavedWarningApp;
  /** "STEP N OF M" of the default header; ignored when `header` is given. */
  step?: number;
  total?: number;
  /** The app's own header (Badger's step bar, the TV's numbering). */
  header?: ReactNode;
  /** Back: the key's previous step is the sign-in, so the apps sign out here. */
  onBack?: () => void;
  /** Runs the library step again. */
  onTryAgain: () => void;
  tryingAgain?: boolean;
  /** "Not renewed yet" after a Try again that was refused again. */
  message?: string | null;
};

export const MobileUnpaidSetupStep = ({
  language,
  app,
  step = 0,
  total = 0,
  header,
  onBack,
  onTryAgain,
  tryingAgain,
  message,
}: MobileUnpaidSetupStepProps) => {
  const theme = useMobileShellTheme();
  const text = unpaidLibrarySetupText(language, app, "phone");
  return (
    <MobileSetupStep
      step={step}
      total={total}
      title={text.title}
      body={text.body}
      header={header}
      onBack={onBack}
      onNext={onTryAgain}
      nextLabel={text.tryAgain}
      nextPreferredFocus
      busy={tryingAgain}
    >
      {message ? (
        <Text testID="unpaid-setup-message" accessibilityRole="alert" style={[styles.message, { color: theme.colors.warning }]}>
          {message}
        </Text>
      ) : null}
    </MobileSetupStep>
  );
};

const styles = StyleSheet.create({
  message: {
    fontSize: 14,
    lineHeight: 20,
  },
});
