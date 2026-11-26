import type { ReactNode } from "react";
import { Button } from "@space/ui";
import type { ClientUiLanguage } from "@space/shared/i18n";
import { keyStepLoadFailedText, type KeyStepMetaErrorClass } from "@space/shared/keyStepMetaRead";
import { DesktopStartupCard, type DesktopStartupProgress } from "./desktop-startup-card";

type DesktopKeyLoadFailedRetryProps = {
  language: ClientUiLanguage;
  /** Why the meta read failed (kept on the element for the logs and tests). */
  errorClass: KeyStepMetaErrorClass;
  /** Reads the account's library meta again (the key step's load). */
  onRetry: () => void;
  retrying?: boolean;
  /** A quiet way back, on the left of Retry. */
  back?: ReactNode;
};

/**
 * UX-KEY-02: the failed key load's Retry row, for a setup whose own card already shows the title and sentence
 * ({@link keyStepLoadFailedText}), as Parrot's setup does.
 */
export const DesktopKeyLoadFailedRetry = ({ language, errorClass, onRetry, retrying = false, back }: DesktopKeyLoadFailedRetryProps) => {
  const text = keyStepLoadFailedText(language, errorClass);
  return (
    <div className={back ? "flex items-center justify-between gap-2" : "flex justify-end"} data-testid="key-load-failed" data-error-class={errorClass}>
      {back}
      <Button type="button" disabled={retrying} onClick={onRetry} data-testid="key-load-retry">
        {retrying ? text.retrying : text.retry}
      </Button>
    </div>
  );
};

type DesktopKeyLoadFailedStepProps = Omit<DesktopKeyLoadFailedRetryProps, "back"> & {
  progress?: DesktopStartupProgress;
  mascotSrc?: string | null;
  mascotAlt?: string;
  mascotGlowClassName?: string;
  /** A quiet way out, like the account line's Sign out. */
  secondary?: ReactNode;
  maxWidthClassName?: string;
};

/**
 * UX-KEY-02 on a computer: in place of "Loading key…" once the key step's meta read failed or ran out of time, the
 * step says the key could not be loaded, why in one sentence, and offers Retry.
 */
export const DesktopKeyLoadFailedStep = ({
  language,
  errorClass,
  onRetry,
  retrying = false,
  progress,
  mascotSrc,
  mascotAlt,
  mascotGlowClassName,
  secondary,
  maxWidthClassName = "max-w-xl",
}: DesktopKeyLoadFailedStepProps) => {
  const text = keyStepLoadFailedText(language, errorClass);
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
      <DesktopKeyLoadFailedRetry language={language} errorClass={errorClass} onRetry={onRetry} retrying={retrying} />
    </DesktopStartupCard>
  );
};
