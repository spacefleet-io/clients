/**
 * UX-KEY-02 on a phone or TV: in place of "Loading key…" once the key step's meta read failed or ran out of time, the
 * step says the key could not be loaded, why in one sentence, and offers Retry, which reads the meta again. One
 * screen for Badger phone, Badger TV and Parrot phone, laid out as their other setup steps.
 */
import React, { type ReactNode } from "react";
import type { ClientUiLanguage } from "@space/shared/i18n";
import { keyStepLoadFailedText, type KeyStepMetaErrorClass } from "@space/shared/keyStepMetaRead";
import { MobileSetupStep } from "./mobile-setup-step";

export type MobileKeyLoadFailedStepProps = {
  language: ClientUiLanguage;
  /** Why the meta read failed: picks the sentence under the title. */
  errorClass: KeyStepMetaErrorClass;
  /** "STEP N OF M" of the default header; ignored when `header` is given. */
  step?: number;
  total?: number;
  /** The app's own header (Badger's step bar, the TV's numbering). */
  header?: ReactNode;
  /** Back: the key's previous step is the sign-in, so the apps sign out here. */
  onBack?: () => void;
  /** Reads the account's library meta again. */
  onRetry: () => void;
  retrying?: boolean;
};

export const MobileKeyLoadFailedStep = ({
  language,
  errorClass,
  step = 0,
  total = 0,
  header,
  onBack,
  onRetry,
  retrying,
}: MobileKeyLoadFailedStepProps) => {
  const text = keyStepLoadFailedText(language, errorClass);
  return (
    <MobileSetupStep
      step={step}
      total={total}
      title={text.title}
      body={text.body}
      header={header}
      onBack={onBack}
      onNext={onRetry}
      nextLabel={retrying ? text.retrying : text.retry}
      nextPreferredFocus
      busy={retrying}
    />
  );
};
