import type { MediaRow } from "@space/shared/libraryTypes";
import { GENRES_BY_CATEGORY } from "@space/shared/genres";
import {
  EMPTY_LIBRARY_FILTERS,
  filterLibraryItems,
  patchLibraryTabPrefs,
  sortLibraryItems,
  toggleLibraryFilterValue,
  type LibraryFilters,
  type LibraryTab,
  type LibraryTabPrefs,
} from "@space/shared/libraryView";
import { filterDownloadedMedia } from "./downloads/decisions";
import { genreLabelKey } from "./genreLabels";
import { getAppSettings, updateAppSettings } from "./appSettings";

/** The library screen's segmented tabs: films and shows (playlists are their own bottom tab, UX-PHONE-07). */
export type LibraryScope = "movies" | "tv";

export type LibraryFiltersAction =
  | { type: "query"; query: string }
  | { type: "toggleGenre"; key: string }
  | { type: "toggleActor"; name: string }
  | { type: "downloadedOnly"; value: boolean }
  /**
   * Moving to another tab: genres and actors belong to one tab, search text and "downloaded only" carry over.
   * Re-selecting the tab already showing changes nothing.
   */
  | { type: "switchTab"; from: LibraryScope; to: LibraryScope }
  /** The Filter sheet's Apply, or its Clear: every filter at once. */
  | { type: "set"; filters: LibraryFilters }
  /** Leaving the media library: search and every filter go back to empty. */
  | { type: "reset" };

export const libraryFiltersReducer = (state: LibraryFilters, action: LibraryFiltersAction): LibraryFilters => {
  switch (action.type) {
    case "query":
      return { ...state, query: action.query };
    case "toggleGenre":
      return { ...state, genres: toggleLibraryFilterValue(state.genres, action.key) };
    case "toggleActor":
      return { ...state, actors: toggleLibraryFilterValue(state.actors, action.name.toLowerCase()) };
    case "downloadedOnly":
      return { ...state, downloadedOnly: action.value };
    case "switchTab":
      return action.from === action.to || (state.genres.length === 0 && state.actors.length === 0)
        ? state
        : { ...state, genres: [], actors: [] };
    case "set":
      return action.filters;
    case "reset":
      return EMPTY_LIBRARY_FILTERS;
  }
};

/** Writes one tab's view / sort into the device settings (AsyncStorage); the other tab is untouched. */
export const updateLibraryTabPrefs = (tab: LibraryTab, patch: Partial<LibraryTabPrefs>): void => {
  updateAppSettings({ libraryView: patchLibraryTabPrefs(getAppSettings().libraryView, tab, patch) });
};

/** Genre filter options for a tab: only genres at least one title in it has (and that have a name), in the catalog list order. */
export const availableGenreIds = (media: readonly MediaRow[], tab: LibraryTab): number[] => {
  const present = new Set<number>();
  for (const item of media) {
    if (item.type !== tab) continue;
    for (const id of item.genres ?? []) present.add(id);
  }
  return GENRES_BY_CATEGORY[tab]
    .filter((genre) => present.has(genre.id) && genreLabelKey(tab, genre.id) !== null)
    .map((genre) => genre.id);
};

/** The titles the screen shows: tab -> downloaded-only -> search / genres / actors -> sort. */
export const selectLibraryItems = (params: {
  media: readonly MediaRow[];
  tab: LibraryTab;
  filters: LibraryFilters;
  prefs: LibraryTabPrefs;
  castLookup: Map<string, Set<string>>;
  downloadedMediaIds: ReadonlySet<string>;
}): MediaRow[] => {
  const { media, tab, filters, prefs, castLookup, downloadedMediaIds } = params;
  const inTab = media.filter((item) => item.type === tab);
  const pool = filters.downloadedOnly ? filterDownloadedMedia(inTab, downloadedMediaIds) : inTab;
  const filtered = filterLibraryItems({
    items: pool,
    query: filters.query.trim().toLowerCase(),
    selectedGenres: filters.genres,
    selectedActors: filters.actors,
    castLookup,
  });
  return sortLibraryItems(filtered, prefs.sortBy, prefs.sortDirection);
};
