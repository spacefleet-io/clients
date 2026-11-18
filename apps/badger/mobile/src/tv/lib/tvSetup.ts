/**
 * Badger TV's setup order (UX-SETUP-08, UX-SETUP-04): "Choose your language" (step 0, before the sign-in, no count),
 * the sign-in (QR code and short code, or the password; not counted), then the numbered steps: the library key (only
 * after a password sign-in: pairing brings the key) and "Send error reports". The numbering is the shared
 * `@space/shared/setupFlow`; both numbered steps stay on this TV (its copy of the key, its error reports), so neither is
 * skipped for an answer given on another client.
 *
 * The TV keeps its setup in the phone's progress record (`@space/mobile-shell/setup`, its own storage key), of which it
 * uses `step` ("language" until the language is chosen, then "signIn") and `pairedKey`. Pure: no storage here.
 */
import type { PhoneSetupProgress } from "@space/mobile-shell/setup";
import { setupStepNumber, setupStepsToShow, type SetupStepSpec } from "@space/shared/setupFlow";
import { errorReportsOffered } from "@space/mobile-shell/error-reports-offered";

export type TvSetupStep = "libraryKey" | "errorReports";

const TV_SETUP_STEPS: ReadonlyArray<SetupStepSpec<TvSetupStep>> = [
  { step: "libraryKey", scope: "device" },
  { step: "errorReports", scope: "device" },
];

export type TvSetupProgress = Pick<PhoneSetupProgress, "step" | "pairedKey">;

/**
 * The numbered steps of this TV's setup, in order; the key only after a password sign-in, error reports only in a build
 * that can send them (REL-LOG-06: a build with no reporting address never asks).
 */
export const tvSetupNumberedSteps = (progress: Pick<TvSetupProgress, "pairedKey">): TvSetupStep[] =>
  setupStepsToShow(
    TV_SETUP_STEPS.filter(
      (spec) => !(progress.pairedKey && spec.step === "libraryKey") && !(spec.step === "errorReports" && !errorReportsOffered()),
    ),
  );

/** "Step N of M" on a numbered TV step; step 0 when that step is not part of this TV's setup (the key after pairing). */
export const tvSetupPosition = (progress: Pick<TvSetupProgress, "pairedKey">, step: TvSetupStep): { step: number; total: number } =>
  setupStepNumber(tvSetupNumberedSteps(progress), step);

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
