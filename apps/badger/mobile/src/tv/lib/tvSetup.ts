/**
 * Badger TV's setup order (UX-SETUP-08, UX-SETUP-04): "Choose your language" (step 0, before the sign-in, no count),
 * the sign-in (QR code and short code, or the password; not counted), then the numbered steps: the library key (only
 * after a password sign-in: pairing brings the key), "Your profile" (UX-SETUP-10, after "Who's watching?", when the
 * profile has not set up its name and avatar on any app) and "Send error reports". The numbering is the shared
 * `@space/shared/setupFlow`; the key and error reports stay on this TV (its copy of the key, its error reports), so
 * neither is skipped for an answer given on another client.
 *
 * The TV keeps its setup in the phone's progress record (`@space/mobile-shell/setup`, its own storage key), of which it
 * uses `step` ("language" until the language is chosen, then "signIn"), `pairedKey` and `profileSetupAnswered`. Pure:
 * no storage here.
 */
import type { PhoneSetupProgress } from "@space/mobile-shell/setup";
import { setupStepNumber, setupStepsToShow, type SetupStepSpec } from "@space/shared/setupFlow";
import { errorReportsOffered } from "@space/mobile-shell/error-reports-offered";

export type TvSetupStep = "libraryKey" | "profile" | "errorReports";

const TV_SETUP_STEPS: ReadonlyArray<SetupStepSpec<TvSetupStep>> = [
  { step: "libraryKey", scope: "device" },
  // Kept on the profile on the server (UX-SETUP-10): counted only while this profile still has it to do.
  { step: "profile", scope: "account" },
  { step: "errorReports", scope: "device" },
];

export type TvSetupProgress = Pick<PhoneSetupProgress, "step" | "pairedKey"> & {
  /**
   * "Your profile" was answered in this setup (UX-SETUP-10): the step keeps its place in the count, so error reports
   * do not renumber once the profile has its avatar. Optional: older saved progress has none.
   */
  profileSetupAnswered?: boolean;
};

type CountedProgress = Pick<TvSetupProgress, "pairedKey" | "profileSetupAnswered">;

/**
 * The numbered steps of this TV's setup, in order; the key only after a password sign-in, "Your profile" while the
 * profile has it to do (`profilePending`) or once answered in this setup, error reports only in a build that can send
 * them (REL-LOG-06: a build with no reporting address never asks).
 */
export const tvSetupNumberedSteps = (progress: CountedProgress, profilePending = false): TvSetupStep[] =>
  setupStepsToShow(
    TV_SETUP_STEPS.filter(
      (spec) => !(progress.pairedKey && spec.step === "libraryKey") && !(spec.step === "errorReports" && !errorReportsOffered()),
    ),
    progress.profileSetupAnswered || profilePending ? [] : ["profile"],
  );

/** "Step N of M" on a numbered TV step; step 0 when that step is not part of this TV's setup (the key after pairing). */
export const tvSetupPosition = (progress: CountedProgress, step: TvSetupStep, profilePending = false): { step: number; total: number } =>
  setupStepNumber(tvSetupNumberedSteps(progress, profilePending), step);

/**
 * Where "Your profile" sits: a numbered step while the TV's first setup is open (`setupOpen`: "Send error reports?"
 * not answered yet), so it reads "Step 2 of 3" after a password sign-in and "Step 1 of 2" after pairing; alone
 * (undefined, no count) at any other time, such as a profile picked later (UX-SETUP-10).
 */
export const tvProfileSetupPosition = (progress: CountedProgress, setupOpen: boolean): { current: number; total: number } | undefined => {
  if (!setupOpen) return undefined;
  const { step, total } = tvSetupPosition(progress, "profile", true);
  return step === 0 ? undefined : { current: step, total };
};

/** The TV still has to answer "Choose your language" (step 0): never once it chose, nor once it was signed in. */
export const tvLanguagePending = (progress: Pick<TvSetupProgress, "step">): boolean => progress.step === "language";

/**
 * What the TV's progress becomes for the session it sees: signed in marks the language as chosen (a TV that was ever
 * signed in never sees the language step after a sign-out, like the computer's per-device mark); signed out forgets a
 * pairing, so the next sign-in counts its own key step. Null: nothing to save.
 */
export const tvSetupForSession = <P extends TvSetupProgress>(progress: P, signedIn: boolean): P | null => {
  if (signedIn && progress.step === "language") return { ...progress, step: "signIn" };
  if (!signedIn && progress.pairedKey) return { ...progress, pairedKey: false };
  return null;
};
