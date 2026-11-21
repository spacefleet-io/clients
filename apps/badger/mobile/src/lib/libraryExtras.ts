/**
 * Per-title facts the media library list needs but `MediaRow` does not carry: the cast (actor filter), the season
 * count (TV details rows), the runtime (movie details rows) and the Filter sheet's facets (UX-LIB-03). They live in the metadata / playback databases, which
 * open after the core one, so the library screen loads them lazily and shows the plain list meanwhile.
 */
export type LibraryExtras = {
  /** Lower-cased cast names per media id (actor filter lookup). */
  castByMediaId: Map<string, Set<string>>;
  /** Actor display names, unique, most titles first then A-Z (actor filter options). */
  actorNames: string[];
  seasonsByMediaId: Map<string, number>;
  /** Longest known format duration, in whole minutes. */
  runtimeMinutesByMediaId: Map<string, number>;
  /**
   * UX-LIB-03: each title's raw facet values (format qualities, directors, audio and subtitle languages); the screen
   * adds its watch state and turns them into facet keys with `libraryFacetValues`.
   */
  facetsByMediaId: Map<string, LibraryFacetRaw>;
};

/** A title's raw facet values; a track with no language is null (shown as "Unknown language"), as on the web player. */
export type LibraryFacetRaw = Record<"qualities" | "directors" | "audioLanguages" | "subtitleLanguages", Array<string | null>>;

export const EMPTY_LIBRARY_EXTRAS: LibraryExtras = {
  castByMediaId: new Map(),
  actorNames: [],
  seasonsByMediaId: new Map(),
  runtimeMinutesByMediaId: new Map(),
  facetsByMediaId: new Map(),
};

/**
 * Seasons per show, counted exactly like the details screen (`details.seasons.length`) and desktop: every season row,
 * specials (season 0) included, so a list row and its details page never disagree.
 */
export const SEASON_COUNT_SQL =
  "SELECT media_id, COUNT(*) AS seasons FROM media_seasons GROUP BY media_id;";

type CastRow = { media_id: string; name: string };
type SeasonCountRow = { media_id: string; seasons: number };
type DurationRow = { media_id: string; duration_seconds: number };
/** One facet value of one title (a format's quality, a director's name, a track's language). */
type FacetRow = { media_id: string; value: string | null };
export type LibraryFacetRows = Record<keyof LibraryFacetRaw, readonly FacetRow[]>;

/** Folds the three raw query results into `LibraryExtras`. Kept pure so it is testable without a database. */
export const buildLibraryExtras = (
  castRows: readonly CastRow[],
  seasonRows: readonly SeasonCountRow[],
  durationRows: readonly DurationRow[],
  facetRows: LibraryFacetRows = { qualities: [], directors: [], audioLanguages: [], subtitleLanguages: [] },
): LibraryExtras => {
  const castByMediaId = new Map<string, Set<string>>();
  const displayNames = new Map<string, string>();
  const titleCounts = new Map<string, number>();
  for (const row of castRows) {
    const display = String(row.name ?? "").trim();
    if (!display) continue;
    const key = display.toLowerCase();
    let names = castByMediaId.get(row.media_id);
    if (!names) {
      names = new Set();
      castByMediaId.set(row.media_id, names);
    }
    if (names.has(key)) continue;
    names.add(key);
    titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1);
    if (!displayNames.has(key)) displayNames.set(key, display);
  }
  const seasonsByMediaId = new Map<string, number>();
  for (const row of seasonRows) {
    const seasons = Number(row.seasons);
    if (Number.isFinite(seasons) && seasons > 0) seasonsByMediaId.set(row.media_id, seasons);
  }
  const runtimeMinutesByMediaId = new Map<string, number>();
  for (const row of durationRows) {
    const minutes = Math.round(Number(row.duration_seconds) / 60);
    if (Number.isFinite(minutes) && minutes > 0) runtimeMinutesByMediaId.set(row.media_id, minutes);
  }
  const facetsByMediaId = new Map<string, LibraryFacetRaw>();
  for (const facet of ["qualities", "directors", "audioLanguages", "subtitleLanguages"] as const) {
    for (const row of facetRows[facet]) {
      let raw = facetsByMediaId.get(row.media_id);
      if (!raw) {
        raw = { qualities: [], directors: [], audioLanguages: [], subtitleLanguages: [] };
        facetsByMediaId.set(row.media_id, raw);
      }
      raw[facet].push(row.value);
    }
  }
  return {
    castByMediaId,
    actorNames: Array.from(displayNames.entries())
      .sort(([keyA, nameA], [keyB, nameB]) => (titleCounts.get(keyB) ?? 0) - (titleCounts.get(keyA) ?? 0) || nameA.localeCompare(nameB))
      .map(([, name]) => name),
    seasonsByMediaId,
    runtimeMinutesByMediaId,
    facetsByMediaId,
  };
};

/**
 * Starts one extras read and reports it to `onLoaded` (or the failure to `onError`) unless the returned cancel function
 * ran first, so a stale read never overwrites a newer one and a rejected read is never an unhandled rejection.
 */
export const fetchLibraryExtras = (
  load: () => Promise<LibraryExtras>,
  onLoaded: (extras: LibraryExtras) => void,
  onError: (error: unknown) => void,
): (() => void) => {
  let cancelled = false;
  load().then(
    (extras) => {
      if (!cancelled) onLoaded(extras);
    },
    (error: unknown) => {
      if (!cancelled) onError(error);
    },
  );
  return () => {
    cancelled = true;
  };
};
