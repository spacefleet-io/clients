import { isEpisodeCompleted } from "./playbackResume";

const clampProgress = (value: number) => Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));

// Visible-progress bands: shared single source of truth so the dialog, the
// dashboard, and the resume prompt agree on what counts as "in progress". The
// lower bound matches RESUME_PROMPT_MIN_PCT and the upper bound matches the
// picker's COMPLETED_PCT_THRESHOLD in @space/shared/playbackResume /
// mediaDetailsProcessing.ts. Keep them in sync if either side moves.
export const PROGRESS_FLOOR_PCT = 2;
export const PROGRESS_CEILING_PCT = 95;

export type ProgressBand = "not-started" | "in-progress" | "watched";

// Phase 2: credits-aware inputs for the band classifier. When provided AND
// the watched absolute time is past the credits-start, the band is
// "watched" regardless of pct. When omitted, the classifier falls back to
// the flat PROGRESS_CEILING_PCT (95 %). All numeric inputs gracefully
// degrade through finite checks — a null/NaN/undefined never elevates an
// in-progress item to watched.
export type ProgressBandInputs = {
  positionSeconds?: number | null;
  durationSeconds?: number | null;
  creditsStartSeconds?: number | null;
};

export const getProgressBand = (
  value: number | null | undefined,
  // Optional positional Phase 2 inputs. Callers that don't pass it stay on
  // the legacy pct-only path; episode-row + movie-pill callers with
  // credits data can pass it to upgrade the boundary.
  inputs?: ProgressBandInputs
): ProgressBand => {
  if (typeof value !== "number" || !Number.isFinite(value)) return "not-started";
  const pct = clampProgress(value);
  // Floor is pct-only — credits data never DEMOTES an in-progress item to
  // not-started; it only upgrades the watched boundary.
  if (pct < PROGRESS_FLOOR_PCT) return "not-started";
  // Phase 2: credits-aware ceiling. isEpisodeCompleted handles the
  // fallback-to-95% path when creditsStartSeconds is null/undefined.
  if (
    isEpisodeCompleted({
      progressPct: pct,
      positionSeconds: inputs?.positionSeconds ?? null,
      durationSeconds: inputs?.durationSeconds ?? null,
      creditsStartSeconds: inputs?.creditsStartSeconds ?? null,
    })
  ) {
    return "watched";
  }
  return "in-progress";
};

export const getVisibleProgressPct = (value: number) => {
  const normalized = clampProgress(value);
  if (normalized > 0 && normalized < 1) return 1;
  return normalized;
};

export const getProgressLabelPct = (value: number) => {
  const normalized = getVisibleProgressPct(value);
  return Math.round(normalized);
};

