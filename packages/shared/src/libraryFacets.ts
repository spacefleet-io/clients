import { normalizeMediaLanguageCode } from "./mediaLanguageDisplay";
import { getProgressBand } from "./progressBand";

/**
 * UX-LIB-03: the library Filter modal's per-title facets beyond genres and actors — quality, director, audio
 * language, subtitle language and watch state. Shared by the Badger desktop app and the web player: each app reads
 * a title's raw values (its own way), this file turns them into facet keys and matches them against the picks, so a
 * title lands in the same buckets in both apps.
 */

export type LibraryFacet = "qualities" | "directors" | "audioLanguages" | "subtitleLanguages" | "watchStates";
export const LIBRARY_FACETS: readonly LibraryFacet[] = [
  "qualities",
  "directors",
  "audioLanguages",
  "subtitleLanguages",
  "watchStates",
];

/** A title's facet keys. */
export type LibraryFacetValues = Record<LibraryFacet, ReadonlySet<string>>;
/** The picked keys per facet; a facet with no pick does not filter. */
export type LibraryFacetSelection = Partial<Record<LibraryFacet, readonly string[]>>;

/**
 * Quality buckets, best first, named as INGS-NAME-04 names a version's quality (4K, 2K, 1080p, 720p); "sd" holds
 * every version at 480p or below.
 */
export const LIBRARY_QUALITY_BUCKETS = ["4k", "2k", "1080p", "720p", "sd"] as const;
export type LibraryQualityBucket = (typeof LIBRARY_QUALITY_BUCKETS)[number];

/**
 * A version's stored quality label as its bucket, or null when it is not a quality. Takes INGS-NAME-04's labels
 * ("4K", "2K", "1080p" …) and the height labels older ingests stored ("2160p", "1440p").
 */
export const libraryQualityBucket = (quality: string | null | undefined): LibraryQualityBucket | null => {
  const label = (quality ?? "").trim().toLowerCase();
  if (label === "4k") return "4k";
  if (label === "2k") return "2k";
  const lines = Number.parseInt(label.replace(/p$/, ""), 10);
  if (!/^\d+p?$/.test(label) || !Number.isFinite(lines) || lines <= 0) return null;
  if (lines >= 2160) return "4k";
  if (lines >= 1440) return "2k";
  if (lines >= 1080) return "1080p";
  if (lines >= 720) return "720p";
  return "sd";
};

export const LIBRARY_WATCH_STATES = ["unwatched", "in-progress", "watched"] as const;
export type LibraryWatchState = (typeof LIBRARY_WATCH_STATES)[number];

/** The watch state of a title from its progress, on the shared progress bands (below 2 % unwatched, 95 % watched). */
export const libraryWatchState = (progressPct: number | null | undefined): LibraryWatchState => {
  const band = getProgressBand(progressPct ?? 0);
  return band === "not-started" ? "unwatched" : band;
};

/** A director's facet key: the trimmed, lower-cased name (labels title-case it, as the Actors list does). */
export const libraryPersonKey = (name: string): string => name.trim().toLowerCase();

/** Builds one title's facet keys from its raw values. Unknown qualities and empty names are dropped. */
export const libraryFacetValues = (raw: {
  qualities?: ReadonlyArray<string | null | undefined>;
  directors?: ReadonlyArray<string | null | undefined>;
  audioLanguages?: ReadonlyArray<string | null | undefined>;
  subtitleLanguages?: ReadonlyArray<string | null | undefined>;
  progressPct?: number | null;
}): LibraryFacetValues => {
  const qualities = new Set<string>();
  for (const quality of raw.qualities ?? []) {
    const bucket = libraryQualityBucket(quality);
    if (bucket) qualities.add(bucket);
  }
  const directors = new Set<string>();
  for (const name of raw.directors ?? []) {
    const key = libraryPersonKey(name ?? "");
    if (key) directors.add(key);
  }
  const languages = (list: ReadonlyArray<string | null | undefined> | undefined) =>
    new Set((list ?? []).map((code) => normalizeMediaLanguageCode(code)));
  return {
    qualities,
    directors,
    audioLanguages: languages(raw.audioLanguages),
    subtitleLanguages: languages(raw.subtitleLanguages),
    watchStates: new Set([libraryWatchState(raw.progressPct)]),
  };
};

/** How many keys are picked across the facets (each counts toward the Filter button's badge). */
export const countLibraryFacetSelection = (selection: LibraryFacetSelection): number =>
  LIBRARY_FACETS.reduce((sum, facet) => sum + (selection[facet]?.length ?? 0), 0);

/** A facet matches when the title has any picked key; every facet with a pick must match. */
export const libraryFacetsMatch = (values: LibraryFacetValues | undefined, selection: LibraryFacetSelection): boolean => {
  for (const facet of LIBRARY_FACETS) {
    const picked = selection[facet];
    if (!picked || picked.length === 0) continue;
    if (!values) return false;
    const have = values[facet];
    if (!picked.some((key) => have.has(key))) return false;
  }
  return true;
};

/**
 * The keys present across `titles`, per facet: qualities and watch states in their fixed order, the rest sorted.
 * The Filter modal offers only these, so no pick ever empties the list by itself.
 */
export const libraryFacetOptions = (titles: Iterable<LibraryFacetValues>): Record<LibraryFacet, string[]> => {
  const seen = Object.fromEntries(LIBRARY_FACETS.map((facet) => [facet, new Set<string>()])) as Record<LibraryFacet, Set<string>>;
  for (const values of titles) {
    for (const facet of LIBRARY_FACETS) values[facet].forEach((key) => seen[facet].add(key));
  }
  const ordered = (order: readonly string[], set: Set<string>) => order.filter((key) => set.has(key));
  return {
    qualities: ordered(LIBRARY_QUALITY_BUCKETS, seen.qualities),
    directors: [...seen.directors].sort(),
    audioLanguages: [...seen.audioLanguages].sort(),
    subtitleLanguages: [...seen.subtitleLanguages].sort(),
    watchStates: ordered(LIBRARY_WATCH_STATES, seen.watchStates),
  };
};
