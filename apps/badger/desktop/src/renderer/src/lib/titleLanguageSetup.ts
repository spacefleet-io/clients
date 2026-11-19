/**
 * UX-SETUP-01 / UX-SETUP-10 / ACCT-PROF-03: where "Your profile" and "How should titles appear?" sit in this
 * computer's first setup. The library key is "Step 1 of N". When the key screen counted "Your profile", it is
 * "Step 2 of N". The title question comes next, when the key screen counted it. This computer's own questions
 * (FirstSetup) count on after the two. At any other time each one shows alone, without a step count, right after the
 * profile is picked.
 *
 * The key screen, the two profile questions and FirstSetup live under different gates (the title question needs the
 * open library, FirstSetup runs before it opens), so the run is shared through this small store.
 */
import { useSyncExternalStore } from "react";
import { TITLE_LANGUAGE_ASKED_SINCE } from "@space/shared/titleLanguage";

/** null while the question is still to come; true once asked and answered, false when it was not needed. */
type Settled = boolean | null;

type SetupRun = {
  /** The total the key screen showed ("Step 1 of total"). */
  total: number;
  profileCounted: boolean;
  profileAsked: Settled;
  titleCounted: boolean;
  titleAsked: Settled;
};

let run: SetupRun | null = null;
/**
 * "Your profile"'s answer is being saved. The profile store applies the saved profile before the save returns, so the
 * gate meanwhile reads a profile that no longer owes the step, as if set on another app: that reading must not settle
 * the step as not asked before the save settles it as asked.
 */
let profileSaving = false;
const listeners = new Set<() => void>();
const publish = () => {
  for (const listener of listeners) listener();
};

/**
 * Whether the key screen should count the title question: a profile created since the question exists. Its answer on
 * another app is not known before the library opens; such a profile is then not asked and the setup counts on.
 */
export const titleQuestionExpected = (profile: { createdAt: string } | null | undefined): boolean =>
  !!profile && profile.createdAt >= TITLE_LANGUAGE_ASKED_SINCE;

/** The key screen showed "Step 1 of `total`" and counted the profile step and/or the title question in it. */
export const noteSetupRun = ({ total, profileStep, titleStep }: { total: number; profileStep: boolean; titleStep: boolean }) => {
  if (!profileStep && !titleStep) return;
  if (
    run?.total === total &&
    run.profileCounted === profileStep &&
    run.titleCounted === titleStep &&
    run.profileAsked === null &&
    run.titleAsked === null
  )
    return;
  run = { total, profileCounted: profileStep, profileAsked: null, titleCounted: titleStep, titleAsked: null };
  publish();
};

const profileStillToCome = (current: SetupRun) => current.profileCounted && current.profileAsked === null;
const titleStillToCome = (current: SetupRun) => current.titleCounted && current.titleAsked === null;

/** "Your profile"'s step in this setup run (always 2, right after the key), or null outside one. */
export const profileSetupStep = (): { current: number; total: number } | null =>
  run && profileStillToCome(run) ? { current: 2, total: run.total } : null;

/** The title question's step in this setup run (after the key and "Your profile" when asked), or null outside one. */
export const titleQuestionStep = (): { current: number; total: number } | null =>
  run && titleStillToCome(run) ? { current: 2 + (run.profileAsked ? 1 : 0), total: run.total } : null;

/** "Your profile"'s answer is being saved (`true`), or its save failed (`false`: the step is still to come). */
export const noteProfileStepSaving = (saving: boolean) => {
  profileSaving = saving;
};

/** "Your profile" was answered (`asked`) or turned out not to be needed (set on another app). */
export const settleProfileStep = (asked: boolean) => {
  if (!run || !profileStillToCome(run)) return;
  if (!asked && profileSaving) return;
  profileSaving = false;
  run = { ...run, profileAsked: asked };
  publish();
};

/** The question was answered (`asked`) or turned out not to be needed for the profile. */
export const settleTitleQuestion = (asked: boolean) => {
  if (!run || !titleStillToCome(run)) return;
  run = { ...run, titleAsked: asked };
  publish();
};

type Step = { current: number; total: number } | null;

/**
 * The run as the screens read it: FirstSetup's step offset (the key, plus each profile question that was asked),
 * `waiting` while one of them is still to come so FirstSetup opens after them, and the step each profile question
 * shows. Screens read the steps from here, never from the getters above: the React Compiler memoizes a call that has
 * no reactive input, so a getter called in render would keep its first value after the run moves on.
 */
export type SetupRunState = { waiting: boolean; stepsBefore: number | null; profileStep: Step; titleStep: Step };

const sameStep = (a: Step, b: Step) => a?.current === b?.current && a?.total === b?.total;

let cachedState: SetupRunState = { waiting: false, stepsBefore: null, profileStep: null, titleStep: null };
/** The run's state now (the same object until it changes, as useSyncExternalStore needs). */
export const setupRunState = (): SetupRunState => {
  const next: SetupRunState = run
    ? {
        waiting: profileStillToCome(run) || titleStillToCome(run),
        stepsBefore: 1 + (run.profileAsked ? 1 : 0) + (run.titleAsked ? 1 : 0),
        profileStep: profileSetupStep(),
        titleStep: titleQuestionStep(),
      }
    : { waiting: false, stepsBefore: null, profileStep: null, titleStep: null };
  if (
    next.waiting !== cachedState.waiting ||
    next.stepsBefore !== cachedState.stepsBefore ||
    !sameStep(next.profileStep, cachedState.profileStep) ||
    !sameStep(next.titleStep, cachedState.titleStep)
  )
    cachedState = next;
  return cachedState;
};

export const useSetupRunState = (): SetupRunState =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setupRunState
  );

/** Tests only. */
export const resetSetupRunForTests = () => {
  run = null;
  profileSaving = false;
  cachedState = { waiting: false, stepsBefore: null, profileStep: null, titleStep: null };
};
