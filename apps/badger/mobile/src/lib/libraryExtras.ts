/**
 * Per-title facts the media library list needs but `MediaRow` does not carry: the cast (actor filter), the season
 * count (TV details rows) and the runtime (movie details rows). They live in the metadata / playback databases, which
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
};

export const EMPTY_LIBRARY_EXTRAS: LibraryExtras = {
  castByMediaId: new Map(),
  actorNames: [],
  seasonsByMediaId: new Map(),
  runtimeMinutesByMediaId: new Map(),
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

/** Folds the three raw query results into `LibraryExtras`. Kept pure so it is testable without a database. */
export const buildLibraryExtras = (
  castRows: readonly CastRow[],
  seasonRows: readonly SeasonCountRow[],
  durationRows: readonly DurationRow[],
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
  return {
    castByMediaId,
    actorNames: Array.from(displayNames.entries())
      .sort(([keyA, nameA], [keyB, nameB]) => (titleCounts.get(keyB) ?? 0) - (titleCounts.get(keyA) ?? 0) || nameA.localeCompare(nameB))
      .map(([, name]) => name),
    seasonsByMediaId,
    runtimeMinutesByMediaId,
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
