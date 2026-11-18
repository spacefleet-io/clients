import type { MediaDetails } from "@space/shared/libraryTypes";
import { COMPLETED_PCT_THRESHOLD, RESUME_PROMPT_MIN_PCT, isEpisodeCompleted, type EpisodeResume } from "@space/shared/playbackResume";
import { movieMediaBlock, runtimeParts } from "../tv/lib/detailsMedia";

/**
 * What the phone's title page (UX-PHONE-04) shows under its poster. Pure, unit tested in `tests/phone-details.test.ts`.
 * The quality labels and the runtime come from the TV's `detailsMedia`, so both form factors name a video the same way.
 */

/** One chip per quality a film plays in ("2160p HDR", "1080p"), the original first; none for a show (per episode). */
export const versionChips = (details: MediaDetails): string[] =>
  details.type === "movie" ? (movieMediaBlock(details)?.qualities ?? []).map((chip) => chip.label) : [];

/**
 * An episode row's mark (PLAY-RESUME-02): "watched" (a tick on the still) once past the watched threshold, "progress"
 * (a bar under the still) once started, else none.
 */
export const episodeRowMark = (resume: EpisodeResume | null | undefined): { kind: "watched" | "progress" | "none"; progressPct: number } => {
  const progressPct = Math.min(100, Math.max(0, resume?.progressPct ?? 0));
  if (resume && isEpisodeCompleted(resume)) return { kind: "watched", progressPct: 100 };
  return { kind: progressPct > 0 ? "progress" : "none", progressPct };
};

/** At most this many centred lines under an action button: "Chercher des sous-titres" needs three at 74 dp. */
export const ACTION_LABEL_LINES = 3;

/**
 * An action button's label, allowed to break after its hyphens (UX-PHONE-04). Android does not break a hyphenated word
 * at its hyphen while hyphenation is off, so "Bande-annonce" was cut mid-word ("Bande-anno" / "nce") in the 5-action row.
 */
export const actionLabelText = (label: string): string => label.replace(/-(?=\S)/g, "-\u200B");

export type FilmPlayLabelKey = "details.playAgain" | "details.resume" | "details.play";

/**
 * A film's Play button: "Play again" once watched (PLAY-RESUME-02), "Resume" once the player would offer to resume
 * (PLAY-RESUME-01's minimum), else "Play".
 */
export const filmPlayLabelKey = (progressPct: number): FilmPlayLabelKey =>
  progressPct >= COMPLETED_PCT_THRESHOLD ? "details.playAgain" : progressPct >= RESUME_PROMPT_MIN_PCT ? "details.resume" : "details.play";

/** A film's length, for "2 h 33 min"; null for a show or when no format knows it. */
export const filmRuntime = (details: MediaDetails): { hours: number; minutes: number } | null =>
  details.type === "movie" ? runtimeParts(movieMediaBlock(details)?.durationSeconds ?? null) : null;

/**
 * The picture behind the top of the title page: the poster, cropped to fill the screen's width (Chris kept the poster
 * over the backdrop, which belongs to playback's loading); the backdrop only for a title without a poster.
 */
export const heroArtwork = (posterUri: string | null, backdropUri: string | null): string | null => posterUri ?? backdropUri;

/**
 * How the edge-to-edge hero fades from the top (solid) to its bottom edge (see-through). The picture itself fades,
 * rather than a band of ground colour painted over it, so it melts into the sky (UX-SKY-04) behind the title.
 */
export const HERO_FADE_STOPS: ReadonlyArray<{ offset: number; opacity: number }> = [
  { offset: 0, opacity: 1 },
  { offset: 0.45, opacity: 0.95 },
  { offset: 0.75, opacity: 0.45 },
  { offset: 1, opacity: 0 },
];
