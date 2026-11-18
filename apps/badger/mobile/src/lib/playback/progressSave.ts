/**
 * Pure decision logic for the player's progress writer (see `PlayerScreen.saveProgress`).
 *
 * Two invariants live here so they can be tested without React:
 *  - `allowZero` ("Start over" may write position 0) is a ONE-SHOT armed only by the explicit user
 *    action and consumed by the first committed write. It must never be derived from render state:
 *    re-arming it on re-render let a later idle read (position 0) overwrite real progress on exit.
 *  - After a COMPLETED save (Next episode / EOF) the episode is finalized: the exit/background
 *    save that follows (the remount cleanup) must not overwrite the 100 % with the real position.
 *    Periodic playback saves are never blocked and un-finalize (the user is watching again).
 */
import { isEpisodeCompleted, progressPctFromPosition } from "@space/shared/playbackResume";
import { shouldPersistProgress } from "./resume";

export type ProgressGate = {
  allowZero: boolean;
  finalized: boolean;
};

export type ProgressSaveInput = {
  positionSeconds: number;
  durationSeconds: number;
  lastSavedPositionSeconds: number | null;
  /** Exit / background save (forces a write even when the position barely moved). */
  final: boolean;
  /** Mark the episode watched (Next episode, EOF). */
  completed: boolean;
  creditsStartSeconds: number | null;
};

export type ProgressSavePlan = {
  progressPct: number;
  positionSeconds: number;
  durationSeconds: number;
  completed: boolean;
};

export const createProgressGate = (): ProgressGate => ({ allowZero: false, finalized: false });

/** The user tapped "Start over": the next write may legitimately be position 0. */
export const armStartOver = (gate: ProgressGate): void => {
  gate.allowZero = true;
};

/** Decide whether and what to write. Pure: call `commitProgressSave` once the write is issued. */
export const planProgressSave = (gate: ProgressGate, input: ProgressSaveInput): ProgressSavePlan | null => {
  const { durationSeconds, creditsStartSeconds, completed } = input;
  if (input.final && !completed && gate.finalized) return null;
  if (completed && !(durationSeconds > 0)) return null;
  const positionSeconds = completed ? durationSeconds : input.positionSeconds;
  if (
    !completed &&
    !shouldPersistProgress({
      positionSeconds,
      durationSeconds,
      lastSavedPositionSeconds: input.lastSavedPositionSeconds,
      force: input.final,
      allowZero: gate.allowZero,
    })
  ) {
    return null;
  }
  let progressPct = progressPctFromPosition(positionSeconds, durationSeconds);
  if (isEpisodeCompleted({ progressPct, durationSeconds, creditsStartSeconds, positionSeconds })) progressPct = 100;
  // `completed` records the explicit request (Next episode / EOF), not "past the credits": a
  // periodic save at 96 % must not block the exit save.
  return { progressPct, positionSeconds, durationSeconds, completed };
};

export const commitProgressSave = (gate: ProgressGate, plan: ProgressSavePlan): void => {
  gate.allowZero = false;
  gate.finalized = plan.completed;
};
