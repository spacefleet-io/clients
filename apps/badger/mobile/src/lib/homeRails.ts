import { continueWatchingTitles } from "@space/shared/continueWatching";
import type { MediaRow } from "@space/shared/libraryTypes";

/** Titles per Home rail. */
export const RAIL_LIMIT = 12;

export type HomeRailId = "continueWatching" | "recent" | "movies" | "shows" | "favorites";

export type HomeRails = Record<HomeRailId, MediaRow[]>;

/** One Home rail to render: its i18n title key, its titles (never empty) and whether cards show watch progress. */
export type HomeRailEntry = {
  id: HomeRailId;
  titleKey: string;
  items: MediaRow[];
  showProgress: boolean;
};

const RAIL_TITLE_KEYS: Record<HomeRailId, string> = {
  continueWatching: "home.sections.continueWatching",
  recent: "home.sections.recentlyAdded",
  movies: "home.sections.movies",
  shows: "home.sections.shows",
  favorites: "home.sections.favorites",
};

/** Home rails in display order. */
const RAIL_ORDER: readonly HomeRailId[] = ["continueWatching", "recent", "movies", "shows", "favorites"];

/**
 * The Home rails shared by the phone and the TV app: continue watching (started, not finished, latest first),
 * recently added, movies, TV shows (newest first) and the favorites playlist.
 */
export const selectHomeRails = (media: readonly MediaRow[], favoriteIds: ReadonlySet<string>): HomeRails => {
  const byAdded = [...media].sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1));
  return {
    continueWatching: continueWatchingTitles(media).slice(0, RAIL_LIMIT),
    recent: byAdded.slice(0, RAIL_LIMIT),
    movies: byAdded.filter((item) => item.type === "movie").slice(0, RAIL_LIMIT),
    shows: byAdded.filter((item) => item.type === "tv").slice(0, RAIL_LIMIT),
    favorites: media.filter((item) => favoriteIds.has(item.id)).slice(0, RAIL_LIMIT),
  };
};

/** The rails that have titles, in display order (an empty rail is not shown). */
export const homeRailEntries = (rails: HomeRails): HomeRailEntry[] =>
  RAIL_ORDER.filter((id) => rails[id].length > 0).map((id) => ({
    id,
    titleKey: RAIL_TITLE_KEYS[id],
    items: rails[id],
    showProgress: id === "continueWatching",
  }));
