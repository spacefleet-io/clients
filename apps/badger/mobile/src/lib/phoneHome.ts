import type { MediaDetails, MediaEpisode, MediaRow } from "@space/shared/libraryTypes";
import type { EpisodeResume } from "@space/shared/playbackResume";
import { minutesLeft } from "../tv/lib/detailsMedia";
import type { HomeRailEntry, HomeRailId } from "./homeRails";
import type { LibraryScope } from "./libraryScreenState";

/** The phone's Home (UX-PHONE-01): the latest started title as the hero card, then the rails below it. */
export type PhoneHomeLayout = { hero: MediaRow | null; rails: HomeRailEntry[] };

/**
 * The first "Continue watching" title becomes the hero; the rail keeps the others and is dropped when the hero was its
 * only title, so no title shows twice in a row of the page. The other rails are unchanged (shared with the TV).
 */
export const phoneHomeLayout = (entries: readonly HomeRailEntry[]): PhoneHomeLayout => {
  const continueWatching = entries.find((entry) => entry.id === "continueWatching");
  const hero = continueWatching?.items[0] ?? null;
  const rails = entries.flatMap((entry) => {
    if (entry.id !== "continueWatching") return [entry];
    const rest = entry.items.slice(1);
    return rest.length > 0 ? [{ ...entry, items: rest }] : [];
  });
  return { hero, rails };
};

/** Where a rail's "See all" goes: the Playlists tab or the Library on one of its scopes (UX-PHONE-01, UX-PHONE-07). */
export type SeeAllTarget = { tab: "library"; scope: LibraryScope } | { tab: "playlists" };

/** Favorites (a playlist) opens the Playlists tab; TV shows the Library's TV shows, every other rail its films. */
export const seeAllTarget = (railId: HomeRailId): SeeAllTarget =>
  railId === "favorites" ? { tab: "playlists" } : { tab: "library", scope: railId === "shows" ? "tv" : "movies" };

/**
 * Longest playable length of a film, or of one episode of a show, in seconds, from its formats; null when no format
 * knows it (or the show has no file for that episode).
 */
export const unitDurationSeconds = (
  details: Pick<MediaDetails, "type" | "files" | "formats"> | null,
  episode: Pick<MediaEpisode, "seasonNumber" | "episodeNumber"> | null,
): number | null => {
  if (!details) return null;
  const fileIds =
    details.type === "tv"
      ? new Set(details.files.filter((file) => episode && file.season === episode.seasonNumber && file.episode === episode.episodeNumber).map((file) => file.id))
      : null;
  const formats = fileIds ? details.formats.filter((format) => fileIds.has(format.fileId)) : details.formats;
  const longest = Math.max(0, ...formats.map((format) => format.durationSeconds ?? 0));
  return longest > 0 ? longest : null;
};

/** What the Continue-watching hero says about where the user is (UX-PHONE-01). */
export type ContinueHeroProgress = {
  /** "S1 E2" for a show's episode to resume; null for a film. */
  episodeCode: string | null;
  /** 0-100, for the bar and the "% watched" fallback. */
  progressPct: number;
  /** Whole minutes left; null only when no length is known for the film or episode. */
  minutesLeft: number | null;
};

/**
 * The hero's progress from the stored progress alone, so it reads the same before and after a restart: a show's
 * episode its Resume plays (its saved position and length), else the title's progress over its formats' length.
 */
export const continueHeroProgress = (
  item: Pick<MediaRow, "progressPct">,
  details: Pick<MediaDetails, "type" | "files" | "formats"> | null,
  episode: Pick<MediaEpisode, "seasonNumber" | "episodeNumber"> | null,
  resume: EpisodeResume | null,
): ContinueHeroProgress => {
  const progressPct = Math.min(100, Math.max(0, resume ? resume.progressPct : item.progressPct));
  const duration = resume?.durationSeconds && resume.durationSeconds > 0 ? resume.durationSeconds : unitDurationSeconds(details, episode);
  const position = resume?.positionSeconds;
  const left =
    duration !== null && typeof position === "number" && position >= 0
      ? Math.max(1, Math.round((duration - Math.min(position, duration)) / 60))
      : minutesLeft(progressPct, duration);
  return { episodeCode: episode ? `S${episode.seasonNumber} E${episode.episodeNumber}` : null, progressPct, minutesLeft: left };
};
