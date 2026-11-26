import { homeSectionLabel, homeSectionRows, type HomeSectionConfig, type HomeSectionType } from "@space/shared/homeLayout";
import type { MediaRow, PlaylistRow } from "@space/shared/libraryTypes";

/** Titles per Home rail. */
export const RAIL_LIMIT = 12;

/** One Home rail to render: its section, its heading, its titles (never empty) and whether cards show watch progress. */
export type HomeRailEntry = {
  id: string;
  section: HomeSectionConfig;
  title: string;
  items: MediaRow[];
  showProgress: boolean;
};

/** The phone's heading key of each section type (a playlist or genre row is headed by its own name). */
const TITLE_KEYS: Record<HomeSectionType, string> = {
  continue: "home.sections.continueWatching",
  recent: "home.sections.recentlyAdded",
  unwatched: "home.sections.unwatched",
  rewatch: "home.sections.rewatch",
  favorites: "home.sections.favorites",
  playlist: "home.sections.playlist",
  genre: "home.sections.genre",
};

export type HomeRailInputs = {
  /** The layout the computer saved (`parseHomeLayout`), the same sections in the same order on every app (UX-HOME-06). */
  layout: readonly HomeSectionConfig[];
  favoriteIds: ReadonlySet<string>;
  playlistItems: ReadonlyMap<string, ReadonlySet<string>>;
  playlists: readonly Pick<PlaylistRow, "id" | "name">[];
  language: string;
  t: (key: string) => string;
};

/** The phone's and the TV's Home rails: the layout's sections that have titles, in its order. */
export const homeRailEntries = (media: readonly MediaRow[], inputs: HomeRailInputs): HomeRailEntry[] =>
  homeSectionRows(inputs.layout, media, { favorites: inputs.favoriteIds, playlistItems: inputs.playlistItems, limit: RAIL_LIMIT }).map(
    ({ section, items }) => ({
      id: section.id,
      section,
      title: homeSectionLabel(section, inputs.playlists, inputs.language, (type) => inputs.t(TITLE_KEYS[type])),
      items,
      showProgress: section.type === "continue",
    }),
  );
