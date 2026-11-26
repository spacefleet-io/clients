import { continueWatchingTitles } from "@space/shared/continueWatching";
import type { HomeSectionConfig } from "@space/shared/homeLayout";
import type { MediaDetails, MediaEpisode, MediaRow } from "@space/shared/libraryTypes";
import type { EpisodeResume } from "@space/shared/playbackResume";
import { minutesLeft } from "../tv/lib/detailsMedia";
import type { HomeRailEntry } from "./homeRails";
import type { LibraryScope } from "./libraryScreenState";

/** The phone's and the TV's Home (UX-PHONE-01, UX-TV-05, UX-HOME-06): the latest started title as the hero card, then the layout's rails. */
export type PhoneHomeLayout = { hero: MediaRow | null; rails: HomeRailEntry[] };

/**
 * The hero is every Badger app's Continue watching pick (UX-HOME-01), whatever the layout holds, as on the computer.
 * The layout's Continue watching rail leaves the hero out and is dropped when the hero was its only title, so no
 * title shows twice in a row of the page; the other rails keep the layout's order.
 */
export const phoneHomeLayout = (media: readonly MediaRow[], entries: readonly HomeRailEntry[]): PhoneHomeLayout => {
  const hero = continueWatchingTitles(media)[0] ?? null;
  const rails = entries.flatMap((entry) => {
    if (entry.section.type !== "continue" || !hero) return [entry];
    const rest = entry.items.filter((item) => item.id !== hero.id);
    return rest.length > 0 ? [{ ...entry, items: rest }] : [];
  });
  return { hero, rails };
};

/** Where a rail's "See all" goes: the Playlists tab or the Library on one of its scopes (UX-PHONE-01, UX-PHONE-07). */
export type SeeAllTarget = { tab: "library"; scope: LibraryScope } | { tab: "playlists" };

/**
 * Favorites and a playlist open the Playlists tab; a row of shows alone (a TV genre, or a section set to TV shows only)
 * the Library's TV shows; every other row its films.
 */
export const seeAllTarget = (section: Pick<HomeSectionConfig, "type" | "genreType" | "libraries">): SeeAllTarget => {
  if (section.type === "favorites" || section.type === "playlist") return { tab: "playlists" };
  const showsOnly = section.type === "genre" ? section.genreType === "tv" : !section.libraries.includes("movies");
  return { tab: "library", scope: showsOnly ? "tv" : "movies" };
};

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
