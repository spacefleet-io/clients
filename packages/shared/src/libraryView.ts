import { foldSearchText } from "./fuzzySearch";
import type { MediaRow } from "./libraryTypes";
import {
  countLibraryFacetSelection,
  libraryFacetsMatch,
  type LibraryFacetSelection,
  type LibraryFacetValues,
} from "./libraryFacets";

/**
 * Media library list state shared by desktop and mobile: how the Movies / TV tabs are viewed (poster grid, compact
 * list, details list), sorted and filtered. Each app keeps its own storage; this file owns the vocabulary, the
 * defaults, the sanitizer for stored values and the sort / filter functions, so both apps order a library the same way.
 */

/** The fields sort / filter read; every `MediaRow` (and desktop's grid rows) satisfies it. */
export type LibraryListItem = Pick<MediaRow, "id" | "type" | "title" | "year" | "addedAt" | "genres">;

export type LibraryTab = "movie" | "tv";
export const LIBRARY_TABS: readonly LibraryTab[] = ["movie", "tv"];

export type LibraryViewMode = "posters" | "compact" | "details";
export const LIBRARY_VIEW_MODES: readonly LibraryViewMode[] = ["posters", "compact", "details"];

export type LibrarySortBy = "name" | "added" | "release";
export const LIBRARY_SORT_KEYS: readonly LibrarySortBy[] = ["name", "added", "release"];

export type LibrarySortDirection = "asc" | "desc";

/** What is remembered per device and per Movies / TV tab. */
export type LibraryTabPrefs = {
  view: LibraryViewMode;
  sortBy: LibrarySortBy;
  sortDirection: LibrarySortDirection;
};

export type LibraryViewPrefs = Record<LibraryTab, LibraryTabPrefs>;

export const DEFAULT_LIBRARY_TAB_PREFS: LibraryTabPrefs = Object.freeze({
  view: "posters",
  sortBy: "name",
  sortDirection: "asc",
}) as LibraryTabPrefs;

export const DEFAULT_LIBRARY_VIEW_PREFS: LibraryViewPrefs = Object.freeze({
  movie: DEFAULT_LIBRARY_TAB_PREFS,
  tv: DEFAULT_LIBRARY_TAB_PREFS,
}) as LibraryViewPrefs;

const isViewMode = (value: unknown): value is LibraryViewMode =>
  typeof value === "string" && (LIBRARY_VIEW_MODES as readonly string[]).includes(value);

const isSortBy = (value: unknown): value is LibrarySortBy =>
  typeof value === "string" && (LIBRARY_SORT_KEYS as readonly string[]).includes(value);

const isSortDirection = (value: unknown): value is LibrarySortDirection => value === "asc" || value === "desc";

const sanitizeTabPrefs = (raw: unknown): LibraryTabPrefs => {
  if (!raw || typeof raw !== "object") return DEFAULT_LIBRARY_TAB_PREFS;
  const input = raw as Record<string, unknown>;
  return {
    view: isViewMode(input.view) ? input.view : DEFAULT_LIBRARY_TAB_PREFS.view,
    sortBy: isSortBy(input.sortBy) ? input.sortBy : DEFAULT_LIBRARY_TAB_PREFS.sortBy,
    sortDirection: isSortDirection(input.sortDirection) ? input.sortDirection : DEFAULT_LIBRARY_TAB_PREFS.sortDirection,
  };
};

/** Turns whatever storage returned (missing, corrupt, from an older build) into a complete, valid value. */
export const sanitizeLibraryViewPrefs = (raw: unknown): LibraryViewPrefs => {
  if (!raw || typeof raw !== "object") return DEFAULT_LIBRARY_VIEW_PREFS;
  const input = raw as Record<string, unknown>;
  return { movie: sanitizeTabPrefs(input.movie), tv: sanitizeTabPrefs(input.tv) };
};

/** A copy of `prefs` with `patch` applied to one tab only; the other tab keeps its own choices. */
export const patchLibraryTabPrefs = (
  prefs: LibraryViewPrefs,
  tab: LibraryTab,
  patch: Partial<LibraryTabPrefs>,
): LibraryViewPrefs => ({ ...prefs, [tab]: sanitizeTabPrefs({ ...prefs[tab], ...patch }) });

/** Search + filters of the screen. Never persisted: they reset whenever the user leaves the library. */
export type LibraryFilters = {
  query: string;
  genres: string[];
  actors: string[];
  downloadedOnly: boolean;
};

export const EMPTY_LIBRARY_FILTERS: LibraryFilters = Object.freeze({
  query: "",
  genres: [],
  actors: [],
  downloadedOnly: false,
}) as LibraryFilters;

/** Filters behind the "Sort & filter" badge: genres, actors and downloaded-only. The search text has its own box. */
export const countActiveLibraryFilters = (filters: LibraryFilters): number =>
  filters.genres.length + filters.actors.length + (filters.downloadedOnly ? 1 : 0);

export const hasActiveLibraryFilters = (filters: LibraryFilters): boolean =>
  filters.query.trim().length > 0 || countActiveLibraryFilters(filters) > 0;

/** Adds `value` to `list`, or removes it when already there. */
export const toggleLibraryFilterValue = (list: readonly string[], value: string): string[] =>
  list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];

/** The library search every Badger app runs: the title contains the search text, ignoring case and accents (empty matches all). */
export const libraryTitleMatches = (item: { title: string }, query: string): boolean =>
  !query || foldSearchText(item.title).includes(foldSearchText(query));

export const filterLibraryItems = <T extends LibraryListItem>(params: {
  items: T[];
  /** Search text (trimmed); case and accents are ignored. */
  query: string;
  /** `<movie|tv>:<genre id>` keys. */
  selectedGenres: string[];
  /** Lower-cased actor names. */
  selectedActors: string[];
  /** Lower-cased cast names per media id. */
  castLookup: Map<string, Set<string>>;
  /** UX-LIB-03: the picked quality / director / language / watch-state keys and each title's facet keys. */
  facets?: { selection: LibraryFacetSelection; lookup: Map<string, LibraryFacetValues> };
}): T[] => {
  const { items, query, selectedGenres, selectedActors, castLookup, facets } = params;
  const facetFilter = facets && countLibraryFacetSelection(facets.selection) > 0 ? facets : null;
  return items.filter((item) => {
    if (!libraryTitleMatches(item, query)) return false;
    if (facetFilter && !libraryFacetsMatch(facetFilter.lookup.get(item.id), facetFilter.selection)) return false;
    if (selectedGenres.length > 0) {
      const genreKeys = (item.genres ?? []).map((id) => `${item.type}:${id}`);
      if (!genreKeys.some((key) => selectedGenres.includes(key))) return false;
    }

    if (selectedActors.length > 0) {
      const cast = castLookup.get(item.id);
      if (!cast) return false;
      const matched = selectedActors.some((name) => cast.has(name.toLowerCase()));
      if (!matched) return false;
    }
    return true;
  });
};

/** The release year, or null when the title has none (missing, blank or not a number). */
const releaseYear = (item: LibraryListItem): number | null => {
  const year = Number.parseInt(item.year ?? "", 10);
  return Number.isFinite(year) && year > 0 ? year : null;
};

export const sortLibraryItems = <T extends LibraryListItem>(
  items: T[],
  sortBy: LibrarySortBy,
  sortDirection: LibrarySortDirection,
): T[] => {
  const direction = sortDirection === "asc" ? 1 : -1;
  const sorted = [...items];
  sorted.sort((a, b) => {
    if (sortBy === "name") {
      return a.title.localeCompare(b.title) * direction;
    }
    if (sortBy === "release") {
      // Titles without a year go last in either direction.
      const yearA = releaseYear(a);
      const yearB = releaseYear(b);
      if (yearA === null || yearB === null) return Number(yearA === null) - Number(yearB === null);
      return (yearA - yearB) * direction;
    }
    return a.addedAt.localeCompare(b.addedAt) * direction;
  });
  return sorted;
};
