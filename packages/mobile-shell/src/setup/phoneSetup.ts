/**
 * The phone setup walkthrough, the same on both phone apps (UX-SETUP-08, UX-SETUP-02, UX-SETUP-03, UX-SETUP-06 phone,
 * UX-SETUP-07): the language first (step 0, before the sign-in), the sign-in (not counted), then the setup steps
 * numbered from 1: the library key only after a regular sign-in, "How should titles appear?" (Badger only, while the
 * profile picked never answered it, ACCT-PROF-03: `askTitleLanguageInSetup`), notifications, send error reports (only
 * in a build that can send them, REL-LOG-06: `errorReportsOffered`). One question per screen with Back and Next; the
 * numbered ones say "step N of M".
 *
 * Pure: the screens, the stores and the permission prompt are injected by the app, so the order, the resume and the
 * Back/Next moves are unit-tested (`packages/mobile-shell/tests/phone-setup.test.ts`).
 */
import { setupStepNumber, setupStepsToShow, type SetupStepSpec } from "@space/shared/setupFlow";
import { errorReportsOffered } from "../errorReportsOffered";

export type PhoneSetupStep = "language" | "signIn" | "libraryKey" | "titleLanguage" | "notifications" | "errorReports";

/** What is saved on this phone after every answer, so a setup left partway reopens at the step left (UX-SETUP-07). */
export type PhoneSetupProgress = {
  step: PhoneSetupStep;
  done: boolean;
  /** The sign-in brought the key (pairing): the key screen is not part of this phone's setup. */
  pairedKey: boolean;
  language: string | null;
  notifications: boolean | null;
  /** The language picked before the sign-in was settled with the account's (UX-I18N-01), once, right after it. */
  languageReconciled: boolean;
  /**
   * "How should titles appear?" was answered in this setup (ACCT-PROF-03): the step keeps its place in the count, so
   * the steps after it do not renumber once the profile has its answer. Optional: older saved progress has none.
   */
  titleLanguageAnswered?: boolean;
};

export const INITIAL_PHONE_SETUP: PhoneSetupProgress = {
  step: "language",
  done: false,
  pairedKey: false,
  language: null,
  notifications: null,
  languageReconciled: false,
};

/** The screens before the numbered steps: the language, then the sign-in. */
const BEFORE_STEPS: readonly PhoneSetupStep[] = ["language", "signIn"];

/**
 * The phone's setup steps after the sign-in and where each answer is kept: all of them stay on the phone (its copy of
 * the key, its notifications permission, its error reports, accounts.md), so none is skipped for an answer given on
 * another client.
 */
const PHONE_SETUP_STEPS: ReadonlyArray<SetupStepSpec<PhoneSetupStep>> = [
  { step: "libraryKey", scope: "device" },
  // Kept in the profile's settings (ACCT-PROF-03): skipped once the profile picked has an answer, from any client.
  { step: "titleLanguage", scope: "account" },
  { step: "notifications", scope: "device" },
  { step: "errorReports", scope: "device" },
];

/** Never asked unless the app asks it (Parrot shows no titles); the app's check runs on every count. */
let titleLanguageAsked: () => boolean = () => false;

/**
 * Badger phone's setup asks "How should titles appear?" right after the key and "Who's watching?" (ACCT-PROF-03,
 * UX-SETUP-03) while `asked()` holds (no profile picked yet, or the one picked never answered), or once answered in
 * this setup (`titleLanguageAnswered`).
 */
export const askTitleLanguageInSetup = (asked: () => boolean): void => {
  titleLanguageAsked = asked;
};

type CountedProgress = Pick<PhoneSetupProgress, "pairedKey" | "titleLanguageAnswered">;

/**
 * The numbered steps of this phone's setup, in order; the key only after a regular sign-in, the title language only
 * in the app that asks it, error reports only in a build that can send them (a build with no reporting address has a
 * two-step setup).
 */
export const phoneSetupNumberedSteps = (progress: CountedProgress): PhoneSetupStep[] =>
  setupStepsToShow(
    PHONE_SETUP_STEPS.filter(
      (spec) => !(progress.pairedKey && spec.step === "libraryKey") && !(spec.step === "errorReports" && !errorReportsOffered()),
    ),
    progress.titleLanguageAnswered || titleLanguageAsked() ? [] : ["titleLanguage"],
  );

/** Every screen of this phone's setup, in order: the language, the sign-in, then the numbered steps. */
export const phoneSetupSteps = (progress: CountedProgress): PhoneSetupStep[] => [...BEFORE_STEPS, ...phoneSetupNumberedSteps(progress)];

/** "Step N of M" (1-based) over the numbered steps; step 0 on the language and the sign-in, which are not counted. */
export const phoneSetupPosition = (progress: PhoneSetupProgress): { step: number; total: number } =>
  setupStepNumber(phoneSetupNumberedSteps(progress), progress.step);

/** What the account side holds right now: the walkthrough never shows a step whose answer is required but missing. */
export type PhoneSetupAccount = { hasKey: boolean; signedIn: boolean };

/**
 * The step to show: the saved one, moved back to the sign-in when signed out and to the key when it is gone, and past
 * the sign-in and the key screens when they are already done.
 */
export const resolvePhoneSetupStep = (progress: PhoneSetupProgress, account: PhoneSetupAccount): PhoneSetupStep => {
  const steps = phoneSetupSteps(progress);
  const at = steps.indexOf(progress.step);
  // The title question answered meanwhile (another client, or a profile that is never asked): the step after it.
  if (at < 0 && progress.step === "titleLanguage") return resolvePhoneSetupStep({ ...progress, step: "notifications" }, account);
  if (at < 0) return "language";
  const signInAt = steps.indexOf("signIn");
  if (!account.signedIn && at > signInAt) return "signIn";
  if (account.signedIn && progress.step === "signIn") return resolvePhoneSetupStep({ ...progress, step: steps[signInAt + 1]! }, account);
  const keyAt = steps.indexOf("libraryKey");
  if (keyAt >= 0 && !account.hasKey && at > keyAt) return "libraryKey";
  if (account.hasKey && progress.step === "libraryKey") return steps[keyAt + 1]!;
  return progress.step;
};

/**
 * The progress after a sign-out during the setup (Back from the key step): the next sign-in settles its language again
 * (UX-SETUP-08), so the question comes before step 1 rather than over it. The same object when nothing changes.
 */
export const phoneSetupSignedOut = (progress: PhoneSetupProgress): PhoneSetupProgress =>
  !progress.done && progress.languageReconciled ? { ...progress, languageReconciled: false } : progress;

/** Next from `step`; null when the setup is finished. */
export const nextPhoneSetupStep = (progress: PhoneSetupProgress): PhoneSetupStep | null => {
  const steps = phoneSetupSteps(progress);
  return steps[steps.indexOf(progress.step) + 1] ?? null;
};

/**
 * Back from `step`; null on the language, the first screen. The sign-in and the key are done once passed and are not
 * undone by Back, so Back past them goes to the language, the previous screen that still asks something; Back on the
 * key screen itself is the app's (it signs out, back to the sign-in).
 */
export const previousPhoneSetupStep = (progress: PhoneSetupProgress): PhoneSetupStep | null => {
  const steps = phoneSetupSteps(progress);
  const at = steps.indexOf(progress.step);
  if (at <= 0) return null;
  const previous = steps[at - 1]!;
  return progress.step !== "signIn" && progress.step !== "libraryKey" && (previous === "signIn" || previous === "libraryKey") ? "language" : previous;
};

/**
 * Next and Back on a walkthrough screen, for both phone apps: Next saves the answers and moves on (or finishes on the
 * last screen); Back saves the step before (`previousPhoneSetupStep`). No Back on the first screen.
 */
export const phoneSetupMoves = (
  progress: PhoneSetupProgress,
  save: (next: PhoneSetupProgress) => Promise<void>,
): {
  /** Saves and resolves to the step moved to (null: finished). */
  advance: (answers?: Partial<PhoneSetupProgress>) => Promise<PhoneSetupStep | null>;
  back?: () => Promise<void>;
} => {
  const previous = previousPhoneSetupStep(progress);
  return {
    advance: async (answers = {}) => {
      const answered = { ...progress, ...answers };
      const to = nextPhoneSetupStep(answered);
      await save(to ? { ...answered, step: to } : { ...answered, done: true });
      return to;
    },
    back: previous ? () => save({ ...progress, step: previous }) : undefined,
  };
};

type KeyValueStorage = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
};

const STEPS: readonly PhoneSetupStep[] = ["language", "signIn", "libraryKey", "titleLanguage", "notifications", "errorReports"];

/** Reads anything unreadable as "never started". */
export const parsePhoneSetupProgress = (raw: string | null): PhoneSetupProgress => {
  if (!raw) return INITIAL_PHONE_SETUP;
  try {
    const value = JSON.parse(raw) as Partial<PhoneSetupProgress>;
    return {
      step: STEPS.includes(value.step as PhoneSetupStep) ? (value.step as PhoneSetupStep) : "language",
      done: value.done === true,
      pairedKey: value.pairedKey === true,
      language: typeof value.language === "string" ? value.language : null,
      notifications: typeof value.notifications === "boolean" ? value.notifications : null,
      languageReconciled: value.languageReconciled === true,
      ...(value.titleLanguageAnswered === true ? { titleLanguageAnswered: true } : {}),
    };
  } catch {
    return INITIAL_PHONE_SETUP;
  }
};

export type PhoneSetupStore = {
  read: () => Promise<PhoneSetupProgress>;
  /** The saved progress, or null when this phone never saved any (a phone set up before the walkthrough existed). */
  readSaved: () => Promise<PhoneSetupProgress | null>;
  write: (progress: PhoneSetupProgress) => Promise<void>;
};

export const createPhoneSetupStore = (input: { asyncStorage: KeyValueStorage; key: string }): PhoneSetupStore => {
  const readSaved = async () => {
    const raw = await input.asyncStorage.getItem(input.key);
    return raw ? parsePhoneSetupProgress(raw) : null;
  };
  return {
    read: async () => (await readSaved()) ?? INITIAL_PHONE_SETUP,
    readSaved,
    write: (progress) => input.asyncStorage.setItem(input.key, JSON.stringify(progress)),
  };
};
