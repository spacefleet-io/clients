// What the phone's search (UX-PHONE-12) looks through on Badger: the whole library on the device, in three groups:
// TV shows, Movies and Episodes. Titles match by name (in the language shown) and by original title; episodes only by
// their own name, so "breaking bad" lists the show alone and "pilot" lists the episodes called Pilot.
import { createFuzzyIndex, type FuzzyIndex } from "@space/shared/fuzzySearch";
import type { MediaRow } from "@space/shared/libraryTypes";

/** One episode as the search reads it (`LibraryDb.listEpisodesForSearch`). */
export type SearchEpisode = {
  id: string;
  mediaId: string;
  seasonNumber: number;
  episodeNumber: number;
  title: string;
  stillPath: string | null;
};

export type BadgerSearchItem =
  | { kind: "title"; media: MediaRow }
  | { kind: "episode"; episode: SearchEpisode; show: MediaRow };

export type BadgerSearchGroupId = "shows" | "movies" | "episodes";

/** "S2 · E5": the episode's place in its show, as the episode list writes it. */
export const episodeCode = (episode: Pick<SearchEpisode, "seasonNumber" | "episodeNumber">): string =>
  `S${episode.seasonNumber} · E${episode.episodeNumber}`;

const titleFields = (item: BadgerSearchItem): string[] =>
  item.kind === "title"
    ? [item.media.title, ...(item.media.originalTitle && item.media.originalTitle !== item.media.title ? [item.media.originalTitle] : [])]
    : [item.episode.title];

/**
 * The three indexes, in the order the search shows them. Episodes whose show is not in `media` (a title being removed)
 * are left out. Built once per library change, never per keystroke.
 */
export const buildBadgerSearchGroups = (
  media: readonly MediaRow[],
  episodes: readonly SearchEpisode[],
): { id: BadgerSearchGroupId; index: FuzzyIndex<BadgerSearchItem> }[] => {
  const started = Date.now();
  const shows: BadgerSearchItem[] = [];
  const movies: BadgerSearchItem[] = [];
  const byId = new Map<string, MediaRow>();
  for (const item of media) {
    byId.set(item.id, item);
    (item.type === "tv" ? shows : movies).push({ kind: "title", media: item });
  }
  const episodeItems: BadgerSearchItem[] = [];
  for (const episode of episodes) {
    const show = byId.get(episode.mediaId);
    if (show) episodeItems.push({ kind: "episode", episode, show });
  }
  const groups = [
    { id: "shows" as const, index: createFuzzyIndex(shows, titleFields) },
    { id: "movies" as const, index: createFuzzyIndex(movies, titleFields) },
    { id: "episodes" as const, index: createFuzzyIndex(episodeItems, titleFields) },
  ];
  console.info(
    "phone-search.index",
    JSON.stringify({ shows: shows.length, movies: movies.length, episodes: episodeItems.length, ms: Date.now() - started }),
  );
  return groups;
};
