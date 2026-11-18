/**
 * Resume offer and watched decision, shared by every Badger player (desktop, phone, TV).
 *
 * PLAY-RESUME-01: a stored progress is worth a "Resume / Start over" offer only when BOTH thresholds are reached:
 * at least RESUME_PROMPT_MIN_PCT of the title AND at least RESUME_PROMPT_MIN_SECONDS watched. Below either one
 * there is no offer: 20 s into a 2 h film (0.3%) is a quick look, and 8 s of a 10 s clip is not real watching
 * either. This also drops the near-zero "00:00:00" values written while playback briefly sits at ~0.
 *
 * PLAY-RESUME-02: a title counts as watched at COMPLETED_PCT_THRESHOLD, or earlier once the watched position
 * passes the start of the end credits when that start is known (the metadata service's skip markers, fetched client-side).
 * A watched title gets no resume offer: Play restarts it from 0.
 *
 * Every input is optional-tolerant: NaN / null / undefined degrade to the next available fallback.
 */

import { EPISODE_RESUME_KEY_PREFIX, normalizeProgressPct } from "./profileViewing";

export const RESUME_PROMPT_MIN_PCT = 2;
export const RESUME_PROMPT_MIN_SECONDS = 15;
export const COMPLETED_PCT_THRESHOLD = 95;

export type EpisodeCompletionInputs = {
  progressPct: number | null | undefined;
  positionSeconds?: number | null;
  durationSeconds?: number | null;
  creditsStartSeconds?: number | null;
};

const finiteOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * Absolute position (seconds) watched to: the saved `positionSeconds` when present, else
 * `progressPct * durationSeconds`. Null when neither is computable.
 */
export const resolveWatchedPositionSeconds = (
  inputs: Pick<EpisodeCompletionInputs, "progressPct" | "positionSeconds" | "durationSeconds">,
): number | null => {
  const position = finiteOrNull(inputs.positionSeconds);
  if (position !== null && position >= 0) return position;
  const pct = finiteOrNull(inputs.progressPct);
  const duration = finiteOrNull(inputs.durationSeconds);
  if (pct === null || duration === null || duration <= 0) return null;
  return (pct / 100) * duration;
};

/**
 * Watched (PLAY-RESUME-02): past the credits start when known, else at or past COMPLETED_PCT_THRESHOLD.
 * A known credits start never makes a progress below it look watched: it only moves the boundary earlier.
 */
export const isEpisodeCompleted = (inputs: EpisodeCompletionInputs): boolean => {
  const creditsStart = finiteOrNull(inputs.creditsStartSeconds);
  if (creditsStart !== null && creditsStart > 0) {
    const watched = resolveWatchedPositionSeconds(inputs);
    if (watched !== null && watched >= creditsStart) return true;
  }
  const pct = finiteOrNull(inputs.progressPct);
  if (pct === null) return false;
  return pct >= COMPLETED_PCT_THRESHOLD;
};

/**
 * Seconds to offer "Resume at …" for, or null when there is nothing to offer: no or invalid progress, a watched
 * title (PLAY-RESUME-02), or a progress below either PLAY-RESUME-01 threshold. Prefers the saved
 * `positionSeconds`; falls back to `progressPct * durationSeconds`.
 */
export const resolveResumeCandidateSeconds = (
  progressPct: number | null | undefined,
  durationSeconds: number | null | undefined,
  creditsStartSeconds?: number | null,
  positionSeconds?: number | null,
): number | null => {
  if (
    typeof progressPct !== "number" ||
    !Number.isFinite(progressPct) ||
    progressPct <= 0 ||
    typeof durationSeconds !== "number" ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0
  ) {
    return null;
  }
  if (isEpisodeCompleted({ progressPct, durationSeconds, creditsStartSeconds, positionSeconds })) return null;
  const persisted = finiteOrNull(positionSeconds);
  const resumeSeconds = persisted !== null && persisted >= 0 ? persisted : (progressPct / 100) * durationSeconds;
  if (progressPct >= RESUME_PROMPT_MIN_PCT && resumeSeconds >= RESUME_PROMPT_MIN_SECONDS) return resumeSeconds;
  return null;
};

/**
 * How the next or previous episode starts when the phone switches to it while the app is not in front (a press on the
 * lock screen or the notification, PLAY-OSMEDIA-01 item 4): it resumes at its PLAY-RESUME-01 offer, since nobody is
 * there to answer "Resume at … / Start over". In front (`active`, or a platform without app states): null, the player
 * asks as usual.
 */
export const episodeSwitchStartAt = (appState: string | null | undefined): "resume" | null =>
  appState === "background" || appState === "inactive" ? "resume" : null;

// ── Episode resume storage (identical on desktop, phone, TV and web) ──────────────────────────
// app_settings key   `[p:<profileId>:]episode_resume_v1:<episodeId>`
// app_settings value JSON `{ progressPct, updatedAt, positionSeconds?, durationSeconds? }`
// Movies have no per-item setting: the main profile's lives in `media_items.progress_pct`.

export const episodeResumeKey = (episodeId: string) => `${EPISODE_RESUME_KEY_PREFIX}${episodeId}`;

export type EpisodeResume = {
  progressPct: number;
  positionSeconds: number | null;
  durationSeconds: number | null;
  updatedAt: string | null;
};

export const progressPctFromPosition = (positionSeconds: number, durationSeconds: number): number => {
  if (!Number.isFinite(positionSeconds) || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  return normalizeProgressPct((positionSeconds / durationSeconds) * 100);
};

/** The JSON desktop writes into `episode_resume_v1:<id>` (additive timing fields only when valid). */
export const buildEpisodeResumeValue = (input: {
  progressPct: number;
  updatedAt: string;
  positionSeconds?: number | null;
  durationSeconds?: number | null;
}): string => {
  const payload: Record<string, unknown> = {
    progressPct: normalizeProgressPct(input.progressPct),
    updatedAt: input.updatedAt,
  };
  const position = finiteOrNull(input.positionSeconds);
  if (position !== null && position >= 0) payload.positionSeconds = position;
  const duration = finiteOrNull(input.durationSeconds);
  if (duration !== null && duration > 0) payload.durationSeconds = duration;
  return JSON.stringify(payload);
};

export const parseEpisodeResumeValue = (raw: string | null | undefined): EpisodeResume | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const pct = Number(parsed.progressPct);
    if (!Number.isFinite(pct)) return null;
    const position = finiteOrNull(parsed.positionSeconds);
    const duration = finiteOrNull(parsed.durationSeconds);
    return {
      progressPct: Math.max(0, Math.min(100, pct)),
      positionSeconds: position !== null && position >= 0 ? position : null,
      durationSeconds: duration !== null && duration > 0 ? duration : null,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
    };
  } catch {
    return null;
  }
};

/**
 * Resume entries of one show's episodes, keyed by episode id, from the `app_settings` rows under `prefix`
 * (`scopedEpisodeResumeKey(scope, "")`). Rows of episodes the show does not list are ignored.
 */
export const collectEpisodeResume = (
  prefix: string,
  episodeIds: ReadonlySet<string>,
  rows: ReadonlyArray<{ key: string; value: string | null }>,
): Record<string, EpisodeResume> => {
  const result: Record<string, EpisodeResume> = {};
  for (const row of rows) {
    const key = String(row.key);
    if (!key.startsWith(prefix)) continue;
    const episodeId = key.slice(prefix.length);
    if (!episodeIds.has(episodeId)) continue;
    const parsed = parseEpisodeResumeValue(row.value);
    if (parsed) result[episodeId] = parsed;
  }
  return result;
};
