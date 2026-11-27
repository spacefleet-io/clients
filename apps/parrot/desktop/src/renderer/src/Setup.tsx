import { useEffect, useState, type ReactNode } from "react";
import { Button, LanguageMenu, Spinner } from "@space/ui";
import { Flag } from "@space/ui/flag";
import { MASCOT_GLOW } from "@space/ui/floating-mascot";
import { CLIENT_UI_LANGUAGES, isClientUiLanguage } from "@space/shared/i18n";
import {
  ChoiceList,
  DesktopStartupCard,
  DesktopStartupControls,
  ErrorReportsLink,
  LIBRARY_KEY_STEP_FIT,
  LibraryKeyStep,
  libraryKeyStepText,
  type LibraryKeyEraseOutcome,
  type LibraryKeyTyped,
} from "@space/desktop-shell/components";
import mascotUrl from "@space/parrot-core/mascot.webp";
import { needsProfileSetupStep } from "@space/desktop-shell/profile-setup";
import {
  parrotSetupSteps,
  type ParrotPairedSignIn,
  type ParrotSetupState,
  type ParrotSetupStep,
  type ParrotState,
} from "../../shared/ipc";
import { pickLanguage } from "./accountLanguage";
import { applyErrorReports } from "./errorReports";
import type { ParrotStringKey, Translate } from "./i18n";
import { useSignOutWithKeyCheck } from "./SignOutKeyCheck";
import { ParrotProfileSetupStep, useParrotCurrentProfile, useParrotDesktopProfileStore } from "./profiles";

type Props = { t: Translate; state: ParrotState; onState: (state: ParrotState) => void };

/**
 * UX-SETUP-06 on a computer: one question per screen, "step N of M", Back and Next, the recommended answer
 * preselected. Sign-in comes before, on its own screen (SignIn.tsx). Every Next saves the answer and the next step in
 * main, so a quit resumes here (UX-SETUP-07). "Your profile" (UX-SETUP-10) follows the key while the main profile
 * owes it; it saves to the profile, not to main.
 */
export default function Setup({ t, state, onState }: Props) {
  const { setup } = state;
  // UX-SETUP-10: the account's profiles, read once signed in (main holds the token).
  const profileStore = useParrotDesktopProfileStore(
    state.user?.id ?? "anonymous",
    state.user && typeof window.parrot?.listProfiles === "function" ? window.parrot : null
  );
  const { ready: profilesReady, profile: setupProfile } = useParrotCurrentProfile(profileStore);
  const [profileAnswered, setProfileAnswered] = useState(false);
  // Counted while the list is still on its way, so the count does not grow once it is in; dropped when not owed.
  // SF_PROFILE_SETUP=off (test harnesses): never asked.
  const withProfile =
    !!profileStore &&
    window.parrot?.profileSetupOff !== true &&
    (!profilesReady || profileAnswered || (!!setupProfile && needsProfileSetupStep(setupProfile)));
  const steps = parrotSetupSteps(withProfile);
  const index = steps.indexOf(setup.step);
  const [draft, setDraft] = useState<ParrotSetupState>(setup);
  const [busy, setBusy] = useState(false);
  // UX-KEY-01, the shared key step Badger desktop shows too: an account with no key yet is shown a new one ("show"),
  // an account that has one is asked for it ("enter"); "checking" asks main which, on arriving at the step.
  const [keyMode, setKeyMode] = useState<"checking" | "show" | "enter">("checking");
  const [newKey, setNewKey] = useState<{ keyBase64: string; words: string[] } | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState(false);
  const onKeyStep = setup.step === "libraryKey" && !state.hasLibraryKey;

  const go = async (step: ParrotSetupStep, patch: Partial<ParrotSetupState> = {}) => {
    setBusy(true);
    try {
      const next = await window.parrot.saveSetup({ ...patch, step });
      setDraft(next.setup);
      onState(next);
    } finally {
      setBusy(false);
    }
  };
  const back = index > 0 ? () => go(steps[index - 1]!) : undefined;
  const nextStep = steps[index + 1];
  const next = (patch: Partial<ParrotSetupState>) => (nextStep ? go(nextStep, patch) : undefined);

  // A run resumed on "Your profile" (or a list that turned out not to owe it): setup moves on to the folders.
  const skipProfile = setup.step === "profile" && !withProfile && !busy;
  useEffect(() => {
    if (!skipProfile) return;
    console.info(`[parrot:setup] "Your profile" not owed (profile ${setupProfile?.id ?? "none"}): on to the folders`);
    void go("folders");
  }, [skipProfile]);

  // A new key, or the account's, once main has the key step's answer.
  const askKeyMode = async () => {
    setKeyMode("checking");
    setKeyError(null);
    const made = await window.parrot.createLibraryKey();
    console.info(`[parrot:key-step] ${made.ok ? "no key on the account yet: showing a new one" : `asking for the account's key (${made.error})`}`);
    if (made.ok) {
      setNewKey({ keyBase64: made.keyBase64, words: made.words });
      setKeyMode("show");
      return;
    }
    setNewKey(null);
    if (made.error === "network") setKeyError(t("key.error.network"));
    setKeyMode("enter");
  };
  useEffect(() => {
    if (onKeyStep && keyMode === "checking") void askKeyMode();
  }, [onKeyStep]);

  // The key is the account's (typed, written down, or from another device): main keeps it, setup moves on.
  const keyAccepted = async () => {
    onState(await window.parrot.getState());
    await go(steps[steps.indexOf("libraryKey") + 1]!);
  };
  const submitKey = async (keyBase64: string) => {
    setKeyError(null);
    const result = await window.parrot.setLibraryKey(keyBase64);
    console.info(`[parrot:key-step] key ${result.ok ? "accepted" : `refused (${result.error})`}`);
    if (!result.ok) {
      setKeyError(result.error === "wrongKey" ? libraryKeyStepText(setup.language, "parrot")("wrongKey") : t(`key.error.${result.error}`));
      return;
    }
    await keyAccepted();
  };
  const saveNewKey = async () => {
    if (!newKey) return;
    setSavingKey(true);
    try {
      await submitKey(newKey.keyBase64);
    } finally {
      setSavingKey(false);
    }
  };
  // PRIV-KEY-01: the account's whole vault is erased; main forgot this computer's key, and the step shows a fresh one.
  const eraseLibrary = async (password: string, twoFactorCode?: string): Promise<LibraryKeyEraseOutcome> => {
    const outcome = await window.parrot.eraseLibrary(password, twoFactorCode);
    console.info(`[parrot:key-step] erase ${JSON.stringify(outcome)}`);
    if (outcome.status === "erased") {
      onState(await window.parrot.getState());
      await askKeyMode();
    }
    return outcome;
  };

  const finish = async () => {
    setBusy(true);
    try {
      const done = await window.parrot.saveSetup({ errorReports: draft.errorReports, done: true });
      // REL-LOG-06: main stored the answer; this window starts (or keeps off) its reporting now, not at the next start.
      void applyErrorReports();
      // PAR-UP-05: setup only scans; the library shows what it found and uploads nothing until the user confirms.
      if (done.setup.folders.length > 0) await window.parrot.scanImport(done.setup.folders);
      onState(done);
    } finally {
      setBusy(false);
    }
  };

  let body: ReactNode;
  let canNext = !busy;
  switch (setup.step) {
    case "language":
      // A list that scrolls inside a fixed height, so more languages never push the screen (Chris 2026-11-09).
      body = (
        <ChoiceList
          name="language"
          value={draft.language}
          ariaLabel={t("language.title")}
          maxHeightClassName="max-h-64"
          options={CLIENT_UI_LANGUAGES.map((lang) => ({ value: lang.code, label: lang.nativeName, lead: <Flag code={lang.code} /> }))}
          onChange={(language) => {
            setDraft({ ...draft, language });
            // The screen speaks the picked language at once; signed in, it becomes the account's too (UX-I18N-07).
            void pickLanguage(window.parrot, language).then(onState);
          }}
        />
      );
      break;
    case "libraryKey": {
      const backButton = (
        <Button type="button" variant="ghost" disabled={!back || busy} onClick={back} data-testid="setup-back">
          {t("back")}
        </Button>
      );
      body = (
        // A short window (800x560): the account line sits closer and slimmer, so the key step fits with its mascot.
        <div
          className={
            onKeyStep
              ? "space-y-3 [@media(max-height:640px)]:space-y-2 [@media(max-height:640px)]:[&_[data-testid=setup-sign-out]]:h-7"
              : "space-y-4"
          }
        >
          <AccountLine t={t} state={state} onState={onState} />
          {state.hasLibraryKey ? (
            <p data-testid="key-ready">{t("key.ready")}</p>
          ) : keyMode === "show" && newKey ? (
            <LibraryKeyStep
              mode="show"
              language={setup.language}
              app="parrot"
              words={newKey.words}
              saving={savingKey}
              onSaved={() => void saveNewKey()}
              error={keyError}
              secondary={backButton}
            />
          ) : keyMode === "enter" ? (
            <LibraryKeyStep<ParrotPairedSignIn>
              mode="enter"
              language={setup.language}
              app="parrot"
              error={keyError}
              onSubmitKey={(typed: LibraryKeyTyped) => submitKey(typed.keyBase64)}
              pairing={{
                actions: window.parrot.pairing,
                onApproved: async (approved) => {
                  if (approved.check === "verified") await keyAccepted();
                  return approved.check;
                },
                log: keyPairLog,
              }}
              // Main could not tell whether the account has a key (offline): making one stays possible once it can.
              onCreateKey={keyError === t("key.error.network") ? askKeyMode : undefined}
              onErase={eraseLibrary}
              secondary={backButton}
            />
          ) : (
            <div className="flex justify-center py-6" data-testid="key-checking">
              <Spinner />
            </div>
          )}
        </div>
      );
      break;
    }
    case "folders":
      body = (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{t("folders.explain")}</p>
          <ul className="space-y-2" data-testid="folders-list">
            {draft.folders.map((folder) => (
              <li key={folder} className="flex items-center justify-between gap-3 rounded-md bg-card px-3 py-2 text-sm">
                <span className="truncate">{folder}</span>
                <Button size="sm" variant="ghost" onClick={() => setDraft({ ...draft, folders: draft.folders.filter((f) => f !== folder) })}>
                  {t("folders.remove")}
                </Button>
              </li>
            ))}
            {draft.folders.length === 0 && <li className="text-sm text-muted-foreground">{t("folders.none")}</li>}
          </ul>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              onClick={async () => {
                const picked = await window.parrot.pickFolders();
                setDraft({ ...draft, folders: [...new Set([...draft.folders, ...picked])] });
              }}
            >
              {t("folders.add")}
            </Button>
            {draft.folders.length > 0 && (
              <Button variant="ghost" onClick={() => setDraft({ ...draft, folders: [] })}>
                {t("folders.none")}
              </Button>
            )}
          </div>
        </div>
      );
      break;
    case "startAtLogin":
      body = (
        <Choices
          name="startAtLogin"
          value={draft.startAtLogin ? "on" : "off"}
          recommended="on"
          t={t}
          options={[
            { value: "on", label: t("startAtLogin.on") },
            { value: "off", label: t("startAtLogin.off") },
          ]}
          onChange={(value) => setDraft({ ...draft, startAtLogin: value === "on" })}
        />
      );
      break;
    case "errorReports":
      body = (
        <div className="space-y-3">
          {/* REL-LOG-06: one short line, details behind the privacy policy link. */}
          <p className="text-sm text-muted-foreground">
            {t("settings.errorReportsBody")}{" "}
            <ErrorReportsLink language={draft.language} label={t("settings.errorReportsLink")} testId="setup-errorReports-link" />
          </p>
          <Choices
            name="errorReports"
            value={draft.errorReports ? "on" : "off"}
            options={[
              { value: "off", label: t("errorReports.off") },
              { value: "on", label: t("errorReports.on") },
            ]}
            onChange={(value) => setDraft({ ...draft, errorReports: value === "on" })}
          />
        </div>
      );
      break;
  }

  // Language is step 0 and shows no count; the numbered steps start at the key (UX-SETUP-08).
  const numbered: readonly ParrotSetupStep[] = steps.filter((step) => step !== "language");
  const current = numbered.indexOf(setup.step) + 1;

  const languageMenu = (
    <LanguageMenu
      current={setup.language}
      languages={CLIENT_UI_LANGUAGES}
      ariaLabel={t("language.title")}
      onSelect={(language) => {
        if (!isClientUiLanguage(language)) return;
        // The same pick as the language step's list: the screen speaks it at once, the account keeps it (UX-I18N-07).
        setDraft({ ...draft, language });
        void pickLanguage(window.parrot, language).then(onState);
      }}
    />
  );

  // UX-SETUP-10: "Your profile" is the shared step's own card (name, the round avatar grid, Back and Next). A short
  // window gets less room around it, as the key step does, so it fits 800x560 with its mascot (UX-SETUP-08).
  if (setup.step === "profile") {
    return (
      <div
        className="flex min-h-screen items-center justify-center p-8 pt-32 [@media(min-height:641px)_and_(max-height:700px)]:pb-4 [@media(min-height:641px)_and_(max-height:700px)]:pt-16 [@media(max-height:640px)]:pb-1 [@media(max-height:640px)]:pt-14"
        data-testid="setup-profile"
      >
        <DesktopStartupControls>{languageMenu}</DesktopStartupControls>
        {profileStore && setupProfile && withProfile ? (
          <ParrotProfileSetupStep
            store={profileStore}
            profile={setupProfile}
            language={setup.language}
            t={t}
            progress={{ current, total: numbered.length }}
            onBack={back}
            onSaving={() => setProfileAnswered(true)}
            onDone={() => go("folders")}
          />
        ) : (
          <Spinner />
        )}
      </div>
    );
  }

  const answerOf = (step: ParrotSetupStep): Partial<ParrotSetupState> =>
    step === "language"
      ? { language: draft.language }
      : step === "folders"
        ? { folders: draft.folders }
        : step === "startAtLogin"
          ? { startAtLogin: draft.startAtLogin }
          : {};

  // The fleet's startup card with the Parrot mascot on it (UX-THEME-02, UX-SETUP-08), the same card Badger's first setup uses.
  // The key step (the shared LibraryKeyStep, Badger's too) is the tallest: with the shared tighter spacing it fits the
  // default and the smallest window (1240x780, 800x560) with no scrolling, its mascot on the card like every step's.
  // A short window gets less room around the cards, so the 5 languages show whole at 800x560 too.
  return (
    <div
      className={
        onKeyStep
          ? "flex min-h-screen items-center justify-center p-8 pt-32 [@media(min-height:641px)_and_(max-height:700px)]:pb-4 [@media(min-height:641px)_and_(max-height:700px)]:pt-16 [@media(max-height:640px)]:pb-1 [@media(max-height:640px)]:pt-14"
          : "flex min-h-screen items-center justify-center p-8 pt-32 [@media(max-height:700px)]:pb-4 [@media(max-height:700px)]:pt-16"
      }
    >
      {/* UX-SETUP-08: the language button keeps the window's top-right spot on every setup step, as on sign-in. */}
      <DesktopStartupControls>{languageMenu}</DesktopStartupControls>
      <div className={onKeyStep ? `w-full max-w-xl ${LIBRARY_KEY_STEP_FIT}` : "w-full max-w-xl"} data-testid={`setup-${setup.step}`}>
        <DesktopStartupCard
          progress={current > 0 ? { current, total: numbered.length, label: t("stepOf", { n: current, m: numbered.length }), testId: "setup-progress" } : undefined}
          // UX-KEY-01: typing a key in and being shown a new one never share a title.
          title={t(
            setup.step === "libraryKey"
              ? onKeyStep && keyMode === "enter"
                ? "key.enterTitle"
                : "key.title"
              : (`${setup.step}.title` as ParrotStringKey),
          )}
          description={onKeyStep && keyMode === "enter" ? t("key.explain") : undefined}
          mascotSrc={mascotUrl}
          mascotGlowClassName={MASCOT_GLOW.parrot}
          maxWidthClassName="max-w-xl"
          contentClassName={onKeyStep ? "pt-0 pb-5" : undefined}
        >
          <div className={onKeyStep ? "space-y-3" : "space-y-6"}>
            {body}
            {/* The key step has its own main button (Continue, or "I've written it down") until the key is set. */}
            {onKeyStep ? null : (
              <div className="flex items-center justify-between gap-2 pt-2">
                <Button variant="ghost" disabled={!back || busy} onClick={back} data-testid="setup-back">
                  {t("back")}
                </Button>
                {nextStep ? (
                  <Button disabled={!canNext} onClick={() => void next(answerOf(setup.step))} data-testid="setup-next">
                    {t("next")}
                  </Button>
                ) : (
                  <Button disabled={!canNext} onClick={finish} data-testid="setup-finish">
                    {t("finish")}
                  </Button>
                )}
              </div>
            )}
          </div>
        </DesktopStartupCard>
      </div>
    </div>
  );
}

function Choices<V extends string>(props: {
  name: string;
  value: V;
  options: { value: V; label: string }[];
  onChange: (value: V) => void;
  recommended?: V;
  t?: Translate;
}) {
  return (
    <div className="space-y-2" role="radiogroup">
      {props.options.map((option) => (
        <label
          key={option.value}
          className={`flex cursor-pointer items-center gap-3 rounded-md border px-4 py-3 ${props.value === option.value ? "border-primary" : "border-border"}`}
        >
          <input
            type="radio"
            name={props.name}
            value={option.value}
            checked={props.value === option.value}
            onChange={() => props.onChange(option.value)}
            data-testid={`setup-${props.name}-${option.value}`}
          />
          <span>{option.label}</span>
          {props.recommended === option.value && props.t && <span className="ml-auto text-xs text-primary">{props.t("recommended")}</span>}
        </label>
      ))}
    </div>
  );
}

/** Who is signed in, with "Use another account": it signs this computer out, asking first when the key is held (ACCT-DEV-03). */
function AccountLine({ t, state, onState }: Props) {
  const { requestSignOut, dialog: signOutKeyCheckDialog } = useSignOutWithKeyCheck({ t, state, onSignedOut: onState });
  if (!state.user) return null;
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      {/* One line: a long address is cut with an ellipsis (its whole text stays in the tooltip). */}
      <p className="min-w-0 truncate text-muted-foreground" title={state.user.email} data-testid="signed-in-as">
        {t("signIn.signedInAs", { email: state.user.email })}
      </p>
      <Button size="sm" variant="ghost" className="shrink-0" onClick={() => void requestSignOut()} data-testid="setup-sign-out">
        {t("signIn.signOut")}
      </Button>
      {signOutKeyCheckDialog}
    </div>
  );
}

const keyPairLog = {
  info: (message: string, extra?: Record<string, unknown>) => console.info(`[parrot:key-pairing] ${message}`, extra ?? ""),
  warn: (message: string, extra?: Record<string, unknown>) => console.warn(`[parrot:key-pairing] ${message}`, extra ?? ""),
  error: (message: string, extra?: Record<string, unknown>) => console.error(`[parrot:key-pairing] ${message}`, extra ?? ""),
};
