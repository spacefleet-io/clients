/**
 * ACCT-PROF-03 / UX-SETUP-01: where "How should titles appear?" sits in this computer's first setup. The library key
 * is "Step 1 of N"; when the key screen counted the title question, the question is "Step 2 of N" and this
 * computer's own questions (FirstSetup) count on from 3, after it. At any other time the question shows alone,
 * without a step count, right after the profile is picked.
 *
 * The key screen and the question live under different gates (the question needs the open library, FirstSetup runs
 * before it opens), so the run is shared through this small store.
 */
import { useSyncExternalStore } from "react";
import { TITLE_LANGUAGE_ASKED_SINCE } from "@space/shared/titleLanguage";

type SetupRun = {
  /** The total the key screen showed ("Step 1 of total"). */
  total: number;
  /** null while the question is still to come; true once asked and answered, false when it was not needed. */
  asked: boolean | null;
};

let run: SetupRun | null = null;
const listeners = new Set<() => void>();
const publish = () => {
  for (const listener of listeners) listener();
};

/**
 * Whether the key screen should count the question: a profile created since the question exists. Its answer on
 * another app is not known before the library opens; such a profile is then not asked and FirstSetup counts on.
 */
export const titleQuestionExpected = (profile: { createdAt: string } | null | undefined): boolean =>
  !!profile && profile.createdAt >= TITLE_LANGUAGE_ASKED_SINCE;

/** The key screen showed "Step 1 of `total`" and counted the question in it. */
export const noteSetupRunCountsTitle = (total: number) => {
  if (run?.total === total && run.asked === null) return;
  run = { total, asked: null };
  publish();
};

/** The question's step in this setup run, or null outside one (it then shows without a step count). */
export const titleQuestionStep = (): { current: number; total: number } | null =>
  run && run.asked === null ? { current: 2, total: run.total } : null;

/** The question was answered (`asked`) or turned out not to be needed for the profile. */
export const settleTitleQuestion = (asked: boolean) => {
  if (!run || run.asked !== null) return;
  run = { ...run, asked };
  publish();
};

/**
 * FirstSetup's step offset in this run: the key, plus the question when it was asked. `waiting` while the question
 * is still to come, so FirstSetup opens after it.
 */
export type SetupRunState = { waiting: boolean; stepsBefore: number | null };

let cachedState: SetupRunState = { waiting: false, stepsBefore: null };
const runState = (): SetupRunState => {
  const next: SetupRunState = run
    ? { waiting: run.asked === null, stepsBefore: 1 + (run.asked ? 1 : 0) }
    : { waiting: false, stepsBefore: null };
  if (next.waiting !== cachedState.waiting || next.stepsBefore !== cachedState.stepsBefore) cachedState = next;
  return cachedState;
};

export const useSetupRunState = (): SetupRunState =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    runState
  );

/** Tests only. */
export const resetSetupRunForTests = () => {
  run = null;
  cachedState = { waiting: false, stepsBefore: null };
};
