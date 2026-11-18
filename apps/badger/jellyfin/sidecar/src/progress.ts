/**
 * Resume / watched thresholds shared by the Kodi and Jellyfin integrations.
 *
 * INTG-SYNC-01: a resume position is kept only from 2% or 15 seconds
 * (PLAY-RESUME-01); a title counts as watched at 95% or once its credits
 * start (PLAY-RESUME-02). Same numbers as `packages/desktop-mpv-playback`
 * (`COMPLETED_PCT_THRESHOLD`, `RESUME_PROMPT_MIN_PCT`).
 */
export const RESUME_MIN_PCT = 2;
export const RESUME_MIN_SECONDS = 15;
export const WATCHED_PCT = 95;

export type ProgressInput = {
  positionSeconds: number;
  durationSeconds: number;
  /** Start of the end credits (media_skip_markers type "credits"), when known. */
  creditsStartSeconds?: number | null;
};

export type ProgressDecision =
  /** Too little watched (or unusable numbers): write nothing. */
  | { kind: "ignore"; reason: "invalid" | "below_resume_threshold" }
  /** Keep a resume position. */
  | { kind: "resume"; progressPct: number; positionSeconds: number; durationSeconds: number }
  /** Watched: stored as 100% like the desktop does at the end of a title. */
  | { kind: "watched"; progressPct: 100; positionSeconds: number; durationSeconds: number };

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export const progressPctOf = (positionSeconds: number, durationSeconds: number) =>
  Math.max(0, Math.min(100, (positionSeconds / durationSeconds) * 100));

export const decideProgress = (input: ProgressInput): ProgressDecision => {
  const { positionSeconds, durationSeconds } = input;
  if (!finite(positionSeconds) || !finite(durationSeconds) || positionSeconds < 0 || durationSeconds <= 0) {
    return { kind: "ignore", reason: "invalid" };
  }
  const pct = progressPctOf(positionSeconds, durationSeconds);
  const credits = finite(input.creditsStartSeconds) && input.creditsStartSeconds > 0 ? input.creditsStartSeconds : null;
  const pastCredits = credits !== null && positionSeconds >= credits && pct >= RESUME_MIN_PCT;
  if (pct >= WATCHED_PCT || pastCredits) {
    return { kind: "watched", progressPct: 100, positionSeconds, durationSeconds };
  }
  if (pct >= RESUME_MIN_PCT || positionSeconds >= RESUME_MIN_SECONDS) {
    return {
      kind: "resume",
      progressPct: Math.round(pct * 10000) / 10000,
      positionSeconds,
      durationSeconds,
    };
  }
  return { kind: "ignore", reason: "below_resume_threshold" };
};

/** Watched state of an already stored progress (same rule, no position needed). */
export const isWatchedProgress = (input: {
  progressPct: number;
  positionSeconds?: number | null;
  creditsStartSeconds?: number | null;
}) => {
  if (!finite(input.progressPct)) return false;
  if (input.progressPct >= WATCHED_PCT) return true;
  const credits = finite(input.creditsStartSeconds) && input.creditsStartSeconds > 0 ? input.creditsStartSeconds : null;
  return (
    credits !== null &&
    finite(input.positionSeconds) &&
    input.positionSeconds >= credits &&
    input.progressPct >= RESUME_MIN_PCT
  );
};
