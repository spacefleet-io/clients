/**
 * The Library page's sorts and filters for each of its tabs, Albums, Artists and Songs (PAR-LIB-06), one model for
 * every browser-engine Parrot surface (desktop renderer, web player) so the same picks give the same lists everywhere.
 * Everything here reads what the library already stores (year, genre, the original file's format, stored lyrics, the
 * Liked songs playlist) or what this device remembers (the listening history, PAR-HOME-02); nothing is fetched.
 */
import type { ListeningHistory } from "./history";
import { foldSearch } from "./search";

export const PARROT_LIBRARY_TABS = ["albums", "artists", "songs"] as const;
export type ParrotLibraryTab = (typeof PARROT_LIBRARY_TABS)[number];

/** Each tab's orders behind its Sort button, the default first. */
export const PARROT_LIBRARY_SORTS = {
  albums: ["recent", "played", "title", "artist", "year"],
  artists: ["name", "plays", "albums", "songs"],
  songs: ["title", "artist", "album", "year", "duration"],
} as const satisfies Record<ParrotLibraryTab, readonly string[]>;
export type ParrotLibrarySortOf<T extends ParrotLibraryTab> = (typeof PARROT_LIBRARY_SORTS)[T][number];
export type ParrotLibrarySort = ParrotLibrarySortOf<ParrotLibraryTab>;

export type ParrotLibraryFilterKind = "liked" | "genre" | "decade" | "lyrics" | "lossless";

/** Each tab's filters, in the order the Filter panel shows them (the picks first, then the on / off filters). */
export const PARROT_LIBRARY_FILTERS = {
  albums: ["genre", "decade", "lossless"],
  artists: ["genre"],
  songs: ["liked", "genre", "decade", "lyrics", "lossless"],
} as const satisfies Record<ParrotLibraryTab, readonly ParrotLibraryFilterKind[]>;

/** The picks of one tab's filters; a filter left out is off. */
export type ParrotLibraryFilters = {
  /** One genre, compared without case or accents. */
  genre?: string;
  /** The first year of a decade: 1990 keeps 1990 to 1999. */
  decade?: number;
  liked?: boolean;
  lyrics?: boolean;
  lossless?: boolean;
};

export type ParrotLibraryTabPrefs<T extends ParrotLibraryTab = ParrotLibraryTab> = { sort: ParrotLibrarySortOf<T>; filters: ParrotLibraryFilters };
export type ParrotLibraryPrefs = { [T in ParrotLibraryTab]: ParrotLibraryTabPrefs<T> };

/** Where a browser-engine app keeps each tab's sort and filters, so the library opens on the user's last picks. */
export const PARROT_LIBRARY_PREFS_STORAGE_KEY = "parrot.libraryPrefs";

export const defaultParrotLibraryPrefs = (): ParrotLibraryPrefs => ({
  albums: { sort: "recent", filters: {} },
  artists: { sort: "name", filters: {} },
  songs: { sort: "title", filters: {} },
});

const parseFilters = (tab: ParrotLibraryTab, value: unknown): ParrotLibraryFilters => {
  if (!value || typeof value !== "object") return {};
  const raw: Record<string, unknown> = { ...value };
  const allowed: readonly string[] = PARROT_LIBRARY_FILTERS[tab];
  const filters: ParrotLibraryFilters = {};
  if (allowed.includes("genre") && typeof raw.genre === "string" && raw.genre.trim()) filters.genre = raw.genre;
  if (allowed.includes("decade") && typeof raw.decade === "number" && Number.isInteger(raw.decade) && raw.decade % 10 === 0) filters.decade = raw.decade;
  for (const flag of ["liked", "lyrics", "lossless"] as const) if (allowed.includes(flag) && raw[flag] === true) filters[flag] = true;
  return filters;
};

/** Reads stored picks back; an unknown sort or filter falls back to the tab's default, anything unreadable to all defaults. */
export const parseParrotLibraryPrefs = (raw: string | null | undefined): ParrotLibraryPrefs => {
  const prefs = defaultParrotLibraryPrefs();
  if (!raw) return prefs;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return prefs;
  }
  if (!value || typeof value !== "object") return prefs;
  const stored: Record<string, unknown> = { ...value };
  for (const tab of PARROT_LIBRARY_TABS) {
    const picks = stored[tab];
    if (!picks || typeof picks !== "object") continue;
    const sort = "sort" in picks ? picks.sort : undefined;
    const sorts: readonly string[] = PARROT_LIBRARY_SORTS[tab];
    const known = sorts.find((one) => one === sort);
    // The tab's sort union differs per tab; `known` came from that tab's own list.
    if (known) prefs[tab] = { ...prefs[tab], sort: known } as never;
    prefs[tab].filters = parseFilters(tab, "filters" in picks ? picks.filters : undefined);
  }
  return prefs;
};

/** How many filters are on. */
export const countParrotLibraryFilters = (filters: ParrotLibraryFilters): number =>
  (filters.genre ? 1 : 0) + (filters.decade !== undefined ? 1 : 0) + (filters.liked ? 1 : 0) + (filters.lyrics ? 1 : 0) + (filters.lossless ? 1 : 0);

/** What the filters and sorts read off an album (desktop `ParrotLibraryAlbum`, web `AlbumRow`). */
export type ParrotLibraryAlbumFacts = {
  id: string;
  title: string;
  artistName: string;
  artistId?: string | null;
  year: number | null;
  addedAt: number;
  genre?: string | null;
};
export type ParrotLibraryArtistFacts = { id: string; name: string; albumCount: number; trackCount: number };
/** A song's year and genre are the ones it shows (its own, else its album's); `lossless` is its original file's. */
export type ParrotLibrarySongFacts = {
  id: string;
  albumId: string;
  title: string;
  artistName: string;
  artistId?: string | null;
  albumTitle: string;
  durationMs: number | null;
  year?: number | null;
  genre?: string | null;
  lossless?: boolean | number | null;
  hasLyrics?: boolean | number | null;
};

/** The whole library and this device's history, which some filters and sorts look across. */
export type ParrotLibraryContext = {
  albums: readonly ParrotLibraryAlbumFacts[];
  songs: readonly ParrotLibrarySongFacts[];
  history: ListeningHistory;
  /** The songs in the Liked songs playlist (PAR-PL-04). */
  likedSongIds: ReadonlySet<string>;
};

/**
 * A genre tag split into its genres: tags often hold several ("Rock; Pop"). Only ";" separates: "/" and "," appear
 * inside genre names ("R&B/Soul", "Folk, World, & Country").
 */
export const parrotGenres = (genre: string | null | undefined): string[] =>
  (genre ?? "")
    .split(";")
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean);

const hasGenre = (genre: string | null | undefined, wanted: string) => {
  const folded = foldSearch(wanted.trim());
  return parrotGenres(genre).some((one) => foldSearch(one) === folded);
};

export const parrotDecade = (year: number | null | undefined): number | null => (year && year > 0 ? Math.floor(year / 10) * 10 : null);

const byText = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
/** Newest first; a missing value last. */
const byNewest = (a: number | null | undefined, b: number | null | undefined) => (b ?? -Infinity) - (a ?? -Infinity) || 0;

/** Per album: true when it has songs and every one's original file is lossless. */
const losslessAlbums = (songs: readonly ParrotLibrarySongFacts[]): Set<string> => {
  const seen = new Map<string, boolean>();
  for (const song of songs) seen.set(song.albumId, (seen.get(song.albumId) ?? true) && !!song.lossless);
  return new Set([...seen].filter(([, lossless]) => lossless).map(([id]) => id));
};

/** Per artist: the genres of their albums and songs. */
const artistGenres = (context: ParrotLibraryContext): Map<string, string[]> => {
  const genres = new Map<string, string[]>();
  const add = (artistId: string | null | undefined, genre: string | null | undefined) => {
    if (!artistId || !genre) return;
    const list = genres.get(artistId) ?? [];
    list.push(genre);
    genres.set(artistId, list);
  };
  for (const album of context.albums) add(album.artistId, album.genre);
  for (const song of context.songs) add(song.artistId, song.genre);
  return genres;
};

/** The genres a tab's Genre filter offers: every genre its rows carry, once each (first spelling kept), A to Z. */
export const parrotLibraryGenreOptions = (tab: ParrotLibraryTab, context: ParrotLibraryContext): string[] => {
  const tags = tab === "songs" ? context.songs.map((song) => song.genre) : [...context.albums.map((album) => album.genre), ...(tab === "artists" ? context.songs.map((song) => song.genre) : [])];
  const found = new Map<string, string>();
  for (const tag of tags) for (const genre of parrotGenres(tag)) if (!found.has(foldSearch(genre))) found.set(foldSearch(genre), genre);
  return [...found.values()].sort(byText);
};

/** The decades a tab's Decade filter offers, newest first. */
export const parrotLibraryDecadeOptions = (tab: ParrotLibraryTab, context: ParrotLibraryContext): number[] => {
  const years = tab === "songs" ? context.songs.map((song) => song.year) : context.albums.map((album) => album.year);
  return [...new Set(years.map(parrotDecade).filter((decade): decade is number => decade !== null))].sort((a, b) => b - a);
};

/** The Albums tab's grid: `filters` applied, then `sort`. */
export const shownParrotAlbums = <A extends ParrotLibraryAlbumFacts>(
  albums: readonly A[],
  prefs: ParrotLibraryTabPrefs<"albums">,
  context: ParrotLibraryContext
): A[] => {
  const { filters, sort } = prefs;
  const lossless = filters.lossless ? losslessAlbums(context.songs) : null;
  const kept = albums.filter(
    (album) =>
      (!filters.genre || hasGenre(album.genre, filters.genre)) &&
      (filters.decade === undefined || parrotDecade(album.year) === filters.decade) &&
      (!lossless || lossless.has(album.id))
  );
  const playedAt = new Map<string, number>();
  for (const entry of context.history.albums) if (!playedAt.has(entry.albumId)) playedAt.set(entry.albumId, entry.playedAt);
  return kept.sort((a, b) => {
    switch (sort) {
      case "played":
        // Played on this device first, last played first; then the rest as "Recently added".
        return byNewest(playedAt.get(a.id), playedAt.get(b.id)) || b.addedAt - a.addedAt || byText(a.title, b.title);
      case "title":
        return byText(a.title, b.title) || byText(a.artistName, b.artistName);
      case "artist":
        return byText(a.artistName, b.artistName) || (a.year ?? 0) - (b.year ?? 0) || byText(a.title, b.title);
      case "year":
        return byNewest(a.year, b.year) || byText(a.artistName, b.artistName) || byText(a.title, b.title);
      default:
        // "recent": one import adds a whole folder at once, so the title breaks ties.
        return b.addedAt - a.addedAt || byText(a.title, b.title);
    }
  });
};

/** The Artists tab's grid: `filters` applied, then `sort`. */
export const shownParrotArtists = <R extends ParrotLibraryArtistFacts>(
  artists: readonly R[],
  prefs: ParrotLibraryTabPrefs<"artists">,
  context: ParrotLibraryContext
): R[] => {
  const { filters, sort } = prefs;
  const genres = filters.genre ? artistGenres(context) : null;
  const kept = artists.filter((artist) => !genres || (genres.get(artist.id) ?? []).some((genre) => hasGenre(genre, filters.genre!)));
  const plays = context.history.artistPlays;
  return kept.sort((a, b) => {
    switch (sort) {
      case "plays":
        return (plays[b.id] ?? 0) - (plays[a.id] ?? 0) || byText(a.name, b.name);
      case "albums":
        return b.albumCount - a.albumCount || b.trackCount - a.trackCount || byText(a.name, b.name);
      case "songs":
        return b.trackCount - a.trackCount || byText(a.name, b.name);
      default:
        return byText(a.name, b.name);
    }
  });
};

/** The Songs tab's list: `filters` applied, then `sort`. */
export const shownParrotSongs = <S extends ParrotLibrarySongFacts>(songs: readonly S[], prefs: ParrotLibraryTabPrefs<"songs">, context: ParrotLibraryContext): S[] => {
  const { filters, sort } = prefs;
  const kept = songs.filter(
    (song) =>
      (!filters.liked || context.likedSongIds.has(song.id)) &&
      (!filters.genre || hasGenre(song.genre, filters.genre)) &&
      (filters.decade === undefined || parrotDecade(song.year) === filters.decade) &&
      (!filters.lyrics || !!song.hasLyrics) &&
      (!filters.lossless || !!song.lossless)
  );
  return kept.sort((a, b) => {
    switch (sort) {
      case "artist":
        return byText(a.artistName, b.artistName) || byText(a.albumTitle, b.albumTitle) || byText(a.title, b.title);
      case "album":
        return byText(a.albumTitle, b.albumTitle) || byText(a.title, b.title);
      case "year":
        return byNewest(a.year, b.year) || byText(a.artistName, b.artistName) || byText(a.title, b.title);
      case "duration":
        return byNewest(a.durationMs, b.durationMs) || byText(a.title, b.title);
      default:
        return byText(a.title, b.title) || byText(a.artistName, b.artistName);
    }
  });
};
