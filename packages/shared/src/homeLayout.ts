/**
 * Badger's Home layout (UX-HOME-06): which sections Home shows and in what order, and which titles each one holds.
 * The desktop app edits the layout and saves it as the library-wide `dashboard_layout_v1` setting (synced as a
 * `setting.set` op); the desktop, phone, TV and web player all read that setting and draw it through this module, so
 * every app shows the same sections in the same order. Each app keeps its own hero card and its own row length.
 */
import { getProgressBand } from "./progressBand";
import { localizedGenreName } from "./genreNames";

/** The library-wide setting that holds the layout (the desktop's "Edit Home" saves it). */
export const HOME_LAYOUT_KEY = "dashboard_layout_v1";

export type HomeSectionType = "continue" | "recent" | "unwatched" | "rewatch" | "favorites" | "playlist" | "genre";
export type HomeLibraryScope = "movies" | "tv";

export type HomeSectionConfig = {
  id: string;
  type: HomeSectionType;
  playlistId?: string | null;
  genreId?: number | null;
  genreType?: "movie" | "tv" | null;
  libraries: HomeLibraryScope[];
  /** The desktop's row colour; an app without row colours ignores it. */
  styleId: number;
};

/** What the layout needs to know about a playlist: its id, and its slug to find the watchlist. */
export type HomeLayoutPlaylist = { id: string; slug: string | null };

/** The section types that are neither a playlist nor a genre. */
const BUILT_IN_TYPES: readonly HomeSectionType[] = ["continue", "recent", "unwatched", "rewatch", "favorites"];

export const ensureHomeLibraries = (libraries: unknown): HomeLibraryScope[] => {
  const values = Array.isArray(libraries) ? libraries : [];
  const filtered = values.filter((value): value is HomeLibraryScope => value === "movies" || value === "tv");
  return filtered.length ? filtered : ["movies", "tv"];
};

export const createHomeSection = (type: HomeSectionType, playlistId?: string | null, fixedId?: string): HomeSectionConfig => ({
  id: fixedId ?? (playlistId ? `section-playlist-${playlistId}` : `section-${type}`),
  type,
  playlistId: playlistId ?? null,
  genreId: null,
  genreType: null,
  libraries: ["movies", "tv"],
  styleId: 0,
});

export const createHomeGenreSection = (genreType: "movie" | "tv", genreId: number): HomeSectionConfig => ({
  id: `section-genre-${genreType}-${genreId}`,
  type: "genre",
  playlistId: null,
  genreId,
  genreType,
  libraries: [genreType === "tv" ? "tv" : "movies"],
  styleId: 0,
});

/** Home before anyone edited it: Continue watching, Recently added, Unwatched picks, Favorites, then the watchlist. */
export const buildDefaultHomeLayout = (playlists: readonly HomeLayoutPlaylist[]): HomeSectionConfig[] => {
  const watchlistId = playlists.find((playlist) => playlist.slug === "watchlist")?.id ?? null;
  const base: HomeSectionConfig[] = [
    createHomeSection("continue"),
    createHomeSection("recent"),
    createHomeSection("unwatched"),
    createHomeSection("favorites"),
  ];
  if (watchlistId) base.push(createHomeSection("playlist", watchlistId));
  return base;
};

/**
 * The saved layout (`{ updatedAt, sections }` JSON), cleaned: the old "watchlist" type becomes the watchlist playlist,
 * a section whose playlist is gone, a genre section without its genre and an unknown type are dropped. Nothing saved,
 * unreadable JSON or nothing left gives the default layout. A section saved without an id gets `newId()`.
 */
export const parseHomeLayout = (
  raw: string | null | undefined,
  playlists: readonly HomeLayoutPlaylist[],
  newId: () => string = () => crypto.randomUUID(),
): HomeSectionConfig[] => {
  const fallback = buildDefaultHomeLayout(playlists);
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as { sections?: Partial<HomeSectionConfig>[] };
    if (!parsed?.sections || !Array.isArray(parsed.sections)) return fallback;
    const playlistIds = new Set(playlists.map((playlist) => playlist.id));
    const watchlistId = playlists.find((playlist) => playlist.slug === "watchlist")?.id ?? null;
    const sections = parsed.sections
      .filter((section) => section && typeof section === "object")
      .map((section): HomeSectionConfig => {
        const rawType = String(section.type ?? "");
        const normalizedType = rawType === "watchlist" ? "playlist" : rawType;
        const playlistId =
          normalizedType === "playlist" ? (rawType === "watchlist" ? watchlistId : (section.playlistId ?? null)) : null;
        return {
          id: typeof section.id === "string" ? section.id : newId(),
          type: normalizedType as HomeSectionType,
          playlistId,
          genreId: Number.isFinite(Number(section.genreId)) ? Number(section.genreId) : null,
          genreType: section.genreType === "tv" ? "tv" : section.genreType === "movie" ? "movie" : null,
          libraries: normalizedType === "genre" ? [section.genreType === "tv" ? "tv" : "movies"] : ensureHomeLibraries(section.libraries),
          styleId: Number.isFinite(Number(section.styleId)) ? Number(section.styleId) : 0,
        };
      })
      .filter((section) => {
        if (section.type === "playlist") return Boolean(section.playlistId && playlistIds.has(section.playlistId));
        if (section.type === "genre") return section.genreId !== null && section.genreType !== null;
        return BUILT_IN_TYPES.includes(section.type);
      });
    return sections.length ? sections : fallback;
  } catch {
    return fallback;
  }
};

const hashSeed = (seed: string) => {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

/** The same shuffle for the same seed (xorshift over an FNV hash), so a "picks" row stays put between renders. */
export const seededShuffle = <T>(items: readonly T[], seed: string): T[] => {
  const result = [...items];
  let state = hashSeed(seed) || 1;
  for (let i = result.length - 1; i > 0; i -= 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const idx = Math.abs(state) % (i + 1);
    [result[i], result[idx]] = [result[idx], result[i]];
  }
  return result;
};

const pickRandom = <T>(items: readonly T[], count: number, seed: string) => seededShuffle(items, seed).slice(0, count);

/** What a section needs to know about a title. */
export type HomeLayoutItem = {
  id: string;
  type: "movie" | "tv";
  progressPct: number;
  lastWatchedAt: string | null;
  addedAt: string;
  updatedAt: string;
  genres: readonly number[];
  /** false: the title has no stored file yet and shows in no section; absent counts as having files. */
  hasFiles?: boolean;
};

/** Changes when a title is added, removed or updated: part of the seed of the "picks" rows. */
export const homeMediaVersion = (items: readonly Pick<HomeLayoutItem, "updatedAt">[]): string => {
  let latest = "";
  for (const item of items) if (item.updatedAt && item.updatedAt > latest) latest = item.updatedAt;
  return `${items.length}:${latest}`;
};

export type HomeSectionSources = {
  /** Ids of the titles in the favorites playlist. */
  favorites: ReadonlySet<string>;
  /** Ids of the titles in each playlist a section shows, by playlist id. */
  playlistItems: ReadonlyMap<string, ReadonlySet<string>>;
  /** `homeMediaVersion` of the library. */
  mediaVersion: string;
  /** Titles per row (the desktop 10, the phone and TV 12, the web player 7). */
  limit: number;
};

/** A section's candidates in one library (films or shows), at most `limit`, before the two are merged. */
export const selectHomeSectionLibrary = <T extends HomeLayoutItem>(
  section: HomeSectionConfig,
  library: HomeLibraryScope,
  items: readonly T[],
  sources: HomeSectionSources,
): T[] => {
  const { limit } = sources;
  const source = items.filter((item) => item.hasFiles !== false);
  const seedBase = `${section.id}:${section.type}:${library}:${sources.mediaVersion}:${section.genreId ?? ""}`;
  switch (section.type) {
    case "continue":
      return source.filter((item) => getProgressBand(item.progressPct) === "in-progress").slice(0, limit);
    case "recent":
      return [...source].sort((a, b) => -a.addedAt.localeCompare(b.addedAt)).slice(0, limit);
    case "unwatched":
      return pickRandom(source.filter((item) => getProgressBand(item.progressPct) === "not-started"), limit, seedBase);
    case "rewatch":
      return pickRandom(source.filter((item) => getProgressBand(item.progressPct) === "watched"), limit, seedBase);
    case "favorites":
      return source.filter((item) => sources.favorites.has(item.id)).slice(0, limit);
    case "playlist": {
      if (!section.playlistId) return [];
      const set = sources.playlistItems.get(section.playlistId);
      return set ? source.filter((item) => set.has(item.id)).slice(0, limit) : [];
    }
    case "genre": {
      if (section.genreId === null || section.genreId === undefined || !section.genreType) return [];
      if ((section.genreType === "tv") !== (library === "tv")) return [];
      const genreId = section.genreId;
      return pickRandom(source.filter((item) => item.genres.includes(genreId)), limit, seedBase);
    }
    default:
      return [];
  }
};

/**
 * One row's titles from its films and shows: a genre row keeps its one library's picks; Unwatched picks is shuffled
 * again over both; Recently added is newest first, Continue watching watched last first, the others updated last first.
 * Not cut to the row length: the desktop puts importing titles first and cuts after (UX-HOME-03).
 */
export const mergeHomeSectionItems = <T extends HomeLayoutItem>(
  section: HomeSectionConfig,
  movieItems: readonly T[],
  tvItems: readonly T[],
  mediaVersion: string,
): T[] => {
  if (section.type === "genre") return [...(section.genreType === "tv" ? tvItems : movieItems)];
  const merged = [...movieItems, ...tvItems];
  if (section.type === "unwatched") return seededShuffle(merged, `${section.id}:${section.type}:merged:${mediaVersion}`);
  return merged.sort((a, b) => {
    if (section.type === "recent") return b.addedAt.localeCompare(a.addedAt);
    if (section.type === "continue") return (b.lastWatchedAt ?? b.updatedAt).localeCompare(a.lastWatchedAt ?? a.updatedAt);
    return b.updatedAt.localeCompare(a.updatedAt);
  });
};

/** One row Home draws. */
export type HomeSectionRow<T> = { section: HomeSectionConfig; items: T[] };

/** The layout's rows that have titles, in the layout's order: an empty section shows on no app. */
export const homeSectionRows = <T extends HomeLayoutItem>(
  layout: readonly HomeSectionConfig[],
  items: readonly T[],
  sources: Omit<HomeSectionSources, "mediaVersion"> & { mediaVersion?: string },
): HomeSectionRow<T>[] => {
  const full: HomeSectionSources = { ...sources, mediaVersion: sources.mediaVersion ?? homeMediaVersion(items) };
  const movies = items.filter((item) => item.type !== "tv");
  const tv = items.filter((item) => item.type === "tv");
  return layout.flatMap((section) => {
    const wantsMovies = section.type === "genre" ? section.genreType !== "tv" : section.libraries.includes("movies");
    const wantsTv = section.type === "genre" ? section.genreType === "tv" : section.libraries.includes("tv");
    const movieItems = wantsMovies ? selectHomeSectionLibrary(section, "movies", movies, full) : [];
    const tvItems = wantsTv ? selectHomeSectionLibrary(section, "tv", tv, full) : [];
    const rowItems = mergeHomeSectionItems(section, movieItems, tvItems, full.mediaVersion).slice(0, full.limit);
    return rowItems.length ? [{ section, items: rowItems }] : [];
  });
};

/** The playlists the layout's sections show (to load their titles). */
export const homeLayoutPlaylistIds = (layout: readonly HomeSectionConfig[]): string[] => [
  ...new Set(layout.flatMap((section) => (section.type === "playlist" && section.playlistId ? [section.playlistId] : []))),
];

/**
 * A section's heading: a playlist's own name, a genre's name in `language`, else the app's translation of the type
 * (`label("continue")`, `label("playlist")`, `label("genre")`, …).
 */
export const homeSectionLabel = (
  section: HomeSectionConfig,
  playlists: readonly { id: string; name: string }[],
  language: string | null | undefined,
  label: (type: HomeSectionType) => string,
): string => {
  if (section.type === "playlist") {
    const playlist = section.playlistId ? playlists.find((entry) => entry.id === section.playlistId) : null;
    return playlist ? playlist.name : label("playlist");
  }
  if (section.type === "genre" && section.genreId && section.genreType) {
    return localizedGenreName(section.genreType, section.genreId, language) ?? label("genre");
  }
  return label(section.type);
};
