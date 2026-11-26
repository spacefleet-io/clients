import type { ReactNode } from "react";
import { Button } from "@space/ui";
import type { ClientUiLanguage } from "@space/shared/i18n";
import type { KeySavedWarningApp } from "@space/shared/keySavedWarning";
import { unpaidLibrarySetupText } from "@space/shared/unpaidLibrarySetup";
import { DesktopStartupCard, type DesktopStartupProgress } from "./desktop-startup-card";

type DesktopUnpaidSetupStepProps = {
  language: ClientUiLanguage;
  app: KeySavedWarningApp;
  progress?: DesktopStartupProgress;
  mascotSrc?: string | null;
  mascotAlt?: string;
  mascotGlowClassName?: string;
  /** Renews the plan (ACCT-UNPAID-04); the computer always offers it. */
  onRenew: () => void;
  renewing?: boolean;
  /** Runs the library step again; setup goes on from it once the plan is renewed. */
  onTryAgain: () => void;
  tryingAgain?: boolean;
  /** A renewal's outcome, or "not renewed yet" after Try again. */
  message?: string | null;
  /** A quiet way out, like the account line's Sign out. */
  secondary?: ReactNode;
  maxWidthClassName?: string;
};

/**
 * ACCT-UNPAID-06 on a computer: in place of the library step, an unpaid account is told plainly that its plan has
 * ended and that the library can be set up once it is renewed, with Renew right here and Try again to go on from the
 * step afterwards. Both desktops show it, in their own words for the library (UX-NAME-03).
 */
export const DesktopUnpaidSetupStep = ({
  language,
  app,
  progress,
  mascotSrc,
  mascotAlt,
  mascotGlowClassName,
  onRenew,
  renewing = false,
  onTryAgain,
  tryingAgain = false,
  message,
  secondary,
  maxWidthClassName = "max-w-xl",
}: DesktopUnpaidSetupStepProps) => {
  const text = unpaidLibrarySetupText(language, app, "computer");
  const busy = renewing || tryingAgain;
  return (
    <DesktopStartupCard
      maxWidthClassName={maxWidthClassName}
      progress={progress}
      title={text.title}
      titleAs="h1"
      description={text.body}
      mascotSrc={mascotSrc}
      mascotAlt={mascotAlt}
      mascotGlowClassName={mascotGlowClassName}
      secondary={secondary}
    >
      <div className="space-y-4" data-testid="unpaid-setup-step">
        {message ? (
          <p className="text-sm text-amber-200" role="status" data-testid="unpaid-setup-message">
            {message}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="secondary" disabled={busy} onClick={onTryAgain} data-testid="unpaid-setup-try-again">
            {text.tryAgain}
          </Button>
          <Button type="button" disabled={busy} onClick={onRenew} data-testid="unpaid-setup-renew">
            {renewing ? text.renewing : text.renew}
          </Button>
        </div>
      </div>
    </DesktopStartupCard>
  );
};
