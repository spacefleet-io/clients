// The phone setup walkthrough screens both phone apps show (UX-SETUP-08, UX-SETUP-02, UX-SETUP-03 Badger phone,
// UX-SETUP-06 Parrot, UX-SETUP-07): the language before the sign-in, from a menu that scrolls (UX-LIST-01); then, once
// signed in, the account's language settled (`reconcileLanguage`), notifications with the phone's permission prompt, and
// error reports, off unless chosen (REL-LOG-06). The numbered screens say "step N of M"; every screen has Back and Next,
// and every answer is saved through `save`, so a setup left partway reopens at the step left. The app passes in only
// what differs: how its language and error-reports answers are kept, the notifications text, and its own screens
// (Parrot's library key).
import React, { useEffect, useRef, useState } from "react";
import { getCurrentLanguage, isMobileUiLanguage, MOBILE_UI_LANGUAGES, useTranslation, type MobileUiLanguage } from "../i18n";
import { MobileChoiceMenu, MobileSetupChoices, MobileSetupStep } from "../components/mobile-setup-step";
import { MobileFlag } from "../components/mobile-flag";
import { MobileErrorReportsLink } from "../components/mobile-error-reports-link";
import { scopeLogger } from "../logger";
import { requestNotificationPermission } from "./notificationPermission";
import { phoneSetupMoves, phoneSetupPosition, type PhoneSetupProgress, type PhoneSetupStep } from "./phoneSetup";

const log = scopeLogger("setup");

export type PhoneSetupStepProps = {
  progress: PhoneSetupProgress;
  /** Saves the answers and shows the next step (or finishes on the last one). */
  advance: (answers?: Partial<PhoneSetupProgress>) => Promise<void>;
  back?: () => void;
  /** The top-right language button of every step (UX-SETUP-08): the same pick as the language list's. */
  onLanguage: (code: MobileUiLanguage) => void | Promise<void>;
};

export type PhoneSetupFlowProps = {
  /** The step to show, already resolved against the session by the caller. */
  progress: PhoneSetupProgress;
  save: (next: PhoneSetupProgress) => Promise<void>;
  /**
   * Settles the language picked before the sign-in with the account's (UX-I18N-01): called once, right after the
   * sign-in, before the first numbered step. Absent: nothing to settle.
   */
  reconcileLanguage?: () => Promise<void>;
  /** A language picked in the list: switched at once, so the rest of the setup is already in it. */
  onLanguage: (code: MobileUiLanguage) => void | Promise<void>;
  /** The notifications screen's text: what this app notifies about. */
  notificationsBodyKey: string;
  errorReports: { initial: () => boolean; save: (send: boolean) => void | Promise<void> };
  /** The app's own screens for steps the shared ones do not cover (Parrot: the library key). */
  screens?: Partial<Record<PhoneSetupStep, (props: PhoneSetupStepProps) => React.JSX.Element>>;
};

type SharedStepProps = PhoneSetupStepProps & Pick<PhoneSetupFlowProps, "onLanguage" | "notificationsBodyKey" | "errorReports">;

const LanguageStep = ({ progress, advance, onLanguage }: SharedStepProps) => {
  const { t } = useTranslation();
  const [language, setLanguage] = useState(() => getCurrentLanguage());
  const { step, total } = phoneSetupPosition(progress);
  return (
    <MobileSetupStep
      step={step}
      total={total}
      title={t("setup.language.title")}
      body={t("setup.language.body")}
      onNext={() => void advance({ language })}
      onLanguage={(code) => {
        setLanguage(code);
        void onLanguage(code);
      }}
    >
      <MobileChoiceMenu
        testID="setup-language-list"
        label={t("setup.language.title")}
        choices={MOBILE_UI_LANGUAGES.map((option) => ({ value: option.code, label: option.nativeName, lead: <MobileFlag code={option.code} /> }))}
        selected={language}
        onSelect={(code) => {
          setLanguage(code);
          if (isMobileUiLanguage(code)) void onLanguage(code);
        }}
      />
    </MobileSetupStep>
  );
};

const NotificationsStep = ({ progress, advance, back, notificationsBodyKey, onLanguage }: SharedStepProps) => {
  const { t } = useTranslation();
  // "Yes" preselected (UX-SETUP-06; agent's reading for Badger phone, UX-SETUP-03 leaves it open).
  const [answer, setAnswer] = useState<"allow" | "decline">(progress.notifications === false ? "decline" : "allow");
  const [busy, setBusy] = useState(false);
  const { step, total } = phoneSetupPosition(progress);
  return (
    <MobileSetupStep
      step={step}
      onLanguage={(code) => void onLanguage(code)}
      total={total}
      title={t("setup.notifications.title")}
      body={t(notificationsBodyKey)}
      onBack={back}
      busy={busy}
      // The last step in a build without error reports (REL-LOG-06): Finish, not Next.
      last={step === total}
      onNext={async () => {
        setBusy(true);
        try {
          if (answer === "allow") {
            const outcome = await requestNotificationPermission();
            log.info("notifications.permission", { outcome });
          }
          await advance({ notifications: answer === "allow" });
        } finally {
          setBusy(false);
        }
      }}
    >
      <MobileSetupChoices
        choices={[
          { value: "allow", label: t("setup.notifications.allow"), detail: t("setup.notifications.allowDetail") },
          { value: "decline", label: t("setup.notifications.decline"), detail: t("setup.notifications.declineDetail") },
        ]}
        selected={answer}
        onSelect={setAnswer}
      />
    </MobileSetupStep>
  );
};

const ErrorReportsStep = ({ progress, advance, back, errorReports, onLanguage }: SharedStepProps) => {
  const { t } = useTranslation();
  // REL-LOG-06: off unless the user picks it.
  const [answer, setAnswer] = useState<"send" | "decline">(() => (errorReports.initial() ? "send" : "decline"));
  const [busy, setBusy] = useState(false);
  const { step, total } = phoneSetupPosition(progress);
  return (
    <MobileSetupStep
      step={step}
      onLanguage={(code) => void onLanguage(code)}
      total={total}
      title={t("errorReports.title")}
      body={t("errorReports.description")}
      onBack={back}
      busy={busy}
      last
      onNext={async () => {
        setBusy(true);
        try {
          log.info("error_reports.answered", { errorReports: answer === "send" });
          await errorReports.save(answer === "send");
          await advance();
        } finally {
          setBusy(false);
        }
      }}
    >
      <MobileErrorReportsLink testID="setup-error-reports-link" />
      <MobileSetupChoices
        choices={[
          { value: "decline", label: t("errorReports.decline") },
          { value: "send", label: t("errorReports.send") },
        ]}
        selected={answer}
        onSelect={setAnswer}
      />
    </MobileSetupStep>
  );
};

/** True while the language is being settled: once signed in (any step past the sign-in), before the first numbered step. */
const useLanguageReconcile = (progress: PhoneSetupProgress, save: PhoneSetupFlowProps["save"], reconcileLanguage: PhoneSetupFlowProps["reconcileLanguage"]) => {
  const pending = !progress.done && !progress.languageReconciled && progress.step !== "language" && progress.step !== "signIn";
  const started = useRef(false);
  useEffect(() => {
    if (!pending || started.current) return;
    started.current = true;
    void (async () => {
      try {
        await reconcileLanguage?.();
      } catch (error) {
        log.warn("language.reconcile_failed", { message: error instanceof Error ? error.message : String(error) });
      }
      log.info("language.reconciled", { step: progress.step });
      await save({ ...progress, languageReconciled: true });
    })();
  }, [pending, progress, reconcileLanguage, save]);
  return pending;
};

const SHARED_SCREENS: Partial<Record<PhoneSetupStep, (props: SharedStepProps) => React.JSX.Element>> = {
  language: LanguageStep,
  notifications: NotificationsStep,
  errorReports: ErrorReportsStep,
};

/** The walkthrough screen at `progress.step`. A step with no screen here (shown elsewhere by the app) falls back to the language. */
export const PhoneSetupFlow = ({ progress, save, reconcileLanguage, screens, ...shared }: PhoneSetupFlowProps) => {
  const reconciling = useLanguageReconcile(progress, save, reconcileLanguage);
  const moves = phoneSetupMoves(progress, save);
  const advance = async (answers?: Partial<PhoneSetupProgress>) => {
    const to = await moves.advance(answers);
    log.info("step.next", { from: progress.step, to: to ?? "done" });
  };
  const { back: moveBack } = moves;
  const back = moveBack ? () => void moveBack() : undefined;
  // The sky alone while the account's language is settled; the steps after it are already in that language.
  if (reconciling) return null;
  // An app screen takes the base props; the shared ones also take the app's answers.
  const Screen: (props: SharedStepProps) => React.JSX.Element = screens?.[progress.step] ?? SHARED_SCREENS[progress.step] ?? LanguageStep;
  log.info("step.show", { step: progress.step });
  return <Screen key={progress.step} progress={progress} advance={advance} back={back} {...shared} />;
};
