/**
 * @test-id PARROT-CORE-LIBRARY-VIEW-001
 * @level unit
 * @why PAR-LIB-06 (Chris 2026-11-20): the library row's filters and sorts give the same lists on the desktop and in
 *      the browser, from stored facts only (genre, year, lossless file, lyrics, Liked songs, this device's plays), and
 *      each tab's picks come back as they were left, with anything unreadable falling back to the tab's default.
 * @covers packages/parrot-core/src/libraryView.ts
 * @req PAR-LIB-06[parrot,parrot-web-player]
 */
import { describe, expect, it } from "bun:test";
import {
  PARROT_LIBRARY_FILTERS,
  PARROT_LIBRARY_SORTS,
  countParrotLibraryFilters,
  defaultParrotLibraryPrefs,
  parrotDecade,
  parrotGenres,
  parrotLibraryDecadeOptions,
  parrotLibraryGenreOptions,
  parseHistory,
  parseParrotLibraryPrefs,
  shownParrotAlbums,
  shownParrotArtists,
  shownParrotSongs,
  type ParrotLibraryContext,
} from "../src";

const log = (label: string, payload: unknown) => console.info(`[PARROT-CORE-LIBRARY-VIEW] ${label}`, JSON.stringify(payload));

const albums = [
  { id: "al-meltway", title: "Meltway", artistName: "Linnet Park", artistId: "ar-lp", year: 2003, addedAt: 1_000, genre: "Rock; Pop" },
  { id: "al-hollow", title: "Hollow Signal", artistName: "Linnet Park", artistId: "ar-lp", year: 1998, addedAt: 3_000, genre: "Rock" },
  { id: "al-para", title: "Parasails", artistName: "Cloudline", artistId: "ar-cl", year: 1994, addedAt: 2_000, genre: "Electronic" },
  { id: "al-none", title: "Untagged", artistName: "Cloudline", artistId: "ar-cl", year: null, addedAt: 500, genre: null },
];
const song = (id: string, albumId: string, title: string, extra: { durationMs?: number; lossless?: boolean; hasLyrics?: boolean; year?: number | null; genre?: string | null }) => {
  const album = albums.find((one) => one.id === albumId)!;
  return { id, albumId, title, artistName: album.artistName, artistId: album.artistId, albumTitle: album.title, durationMs: extra.durationMs ?? 200_000, year: extra.year ?? album.year, genre: extra.genre ?? album.genre, lossless: extra.lossless ?? false, hasLyrics: extra.hasLyrics ?? false };
};
const songs = [
  song("s-nook", "al-meltway", "Nook", { lossless: true, hasLyrics: true, durationMs: 187_000 }),
  song("s-forecast", "al-meltway", "Forecast", { lossless: true, durationMs: 13_000 }),
  song("s-paper", "al-hollow", "Paperboat", { lossless: false, hasLyrics: true, durationMs: 301_000 }),
  song("s-saffron", "al-para", "Saffron", { lossless: true, genre: "Electronic; Ambient" }),
];
const artists = [
  { id: "ar-lp", name: "Linnet Park", albumCount: 2, trackCount: 3 },
  { id: "ar-cl", name: "Cloudline", albumCount: 2, trackCount: 1 },
];
const history = {
  ...parseHistory(null),
  albums: [
    { albumId: "al-para", trackId: "s-saffron", positionMs: 0, playedAt: 9_000 },
    { albumId: "al-meltway", trackId: "s-nook", positionMs: 0, playedAt: 5_000 },
  ],
  artistPlays: { "ar-cl": 7, "ar-lp": 2 },
};
const context: ParrotLibraryContext = { albums, songs, history, likedSongIds: new Set(["s-paper", "s-saffron"]) };
const ids = (rows: readonly { id: string }[]) => rows.map((row) => row.id);

describe("library row sorts and filters (PAR-LIB-06)", () => {
  it("offers these sorts and filters per tab, Recently added / Name / Title first", () => {
    log("sorts", PARROT_LIBRARY_SORTS);
    log("filters", PARROT_LIBRARY_FILTERS);
    expect(PARROT_LIBRARY_SORTS).toEqual({
      albums: ["recent", "played", "title", "artist", "year"],
      artists: ["name", "plays", "albums", "songs"],
      songs: ["title", "artist", "album", "year", "duration"],
    });
    expect(PARROT_LIBRARY_FILTERS).toEqual({ albums: ["genre", "decade", "lossless"], artists: ["genre"], songs: ["liked", "genre", "decade", "lyrics", "lossless"] });
    expect(defaultParrotLibraryPrefs()).toEqual({ albums: { sort: "recent", filters: {} }, artists: { sort: "name", filters: {} }, songs: { sort: "title", filters: {} } });
  });

  it("splits genre tags on ';' only and buckets years into decades", () => {
    expect(parrotGenres(" Rock ;  Pop;")).toEqual(["Rock", "Pop"]);
    expect(parrotGenres("R&B/Soul")).toEqual(["R&B/Soul"]);
    expect(parrotGenres(null)).toEqual([]);
    expect([parrotDecade(1998), parrotDecade(2003), parrotDecade(null), parrotDecade(0)]).toEqual([1990, 2000, null, null]);
  });

  it("albums: each sort's order, and Recently played puts this device's plays first", () => {
    const order = (sort: (typeof PARROT_LIBRARY_SORTS)["albums"][number]) => ids(shownParrotAlbums(albums, { sort, filters: {} }, context));
    const orders = { recent: order("recent"), played: order("played"), title: order("title"), artist: order("artist"), year: order("year") };
    log("album orders", orders);
    expect(orders.recent).toEqual(["al-hollow", "al-para", "al-meltway", "al-none"]);
    expect(orders.played).toEqual(["al-para", "al-meltway", "al-hollow", "al-none"]);
    expect(orders.title).toEqual(["al-hollow", "al-meltway", "al-para", "al-none"]);
    expect(orders.artist).toEqual(["al-none", "al-para", "al-hollow", "al-meltway"]);
    expect(orders.year).toEqual(["al-meltway", "al-hollow", "al-para", "al-none"]);
  });

  it("albums: Genre matches one of an album's genres, Decade its year, Lossless only albums whose every song is", () => {
    const rock = shownParrotAlbums(albums, { sort: "recent", filters: { genre: "rock" } }, context);
    const nineties = shownParrotAlbums(albums, { sort: "recent", filters: { decade: 1990 } }, context);
    const lossless = shownParrotAlbums(albums, { sort: "recent", filters: { lossless: true } }, context);
    const both = shownParrotAlbums(albums, { sort: "recent", filters: { genre: "Rock", decade: 2000 } }, context);
    log("album filters", { rock: ids(rock), nineties: ids(nineties), lossless: ids(lossless), both: ids(both) });
    expect(ids(rock)).toEqual(["al-hollow", "al-meltway"]);
    expect(ids(nineties)).toEqual(["al-hollow", "al-para"]);
    expect(ids(lossless)).toEqual(["al-para", "al-meltway"]);
    expect(ids(both)).toEqual(["al-meltway"]);
  });

  it("artists: sorted by name, plays on this device, albums or songs; Genre from their albums and songs", () => {
    const order = (sort: (typeof PARROT_LIBRARY_SORTS)["artists"][number]) => ids(shownParrotArtists(artists, { sort, filters: {} }, context));
    log("artist orders", { name: order("name"), plays: order("plays"), albums: order("albums"), songs: order("songs") });
    expect(order("name")).toEqual(["ar-cl", "ar-lp"]);
    expect(order("plays")).toEqual(["ar-cl", "ar-lp"]);
    expect(order("albums")).toEqual(["ar-lp", "ar-cl"]);
    expect(order("songs")).toEqual(["ar-lp", "ar-cl"]);
    expect(ids(shownParrotArtists(artists, { sort: "name", filters: { genre: "Ambient" } }, context))).toEqual(["ar-cl"]);
    expect(ids(shownParrotArtists(artists, { sort: "name", filters: { genre: "Pop" } }, context))).toEqual(["ar-lp"]);
  });

  it("songs: each sort's order, and Liked / With lyrics / Lossless / Genre / Decade keep only the matching songs", () => {
    const order = (sort: (typeof PARROT_LIBRARY_SORTS)["songs"][number]) => ids(shownParrotSongs(songs, { sort, filters: {} }, context));
    log("song orders", { title: order("title"), artist: order("artist"), album: order("album"), year: order("year"), duration: order("duration") });
    expect(order("title")).toEqual(["s-forecast", "s-nook", "s-paper", "s-saffron"]);
    expect(order("artist")).toEqual(["s-saffron", "s-paper", "s-forecast", "s-nook"]);
    expect(order("album")).toEqual(["s-paper", "s-forecast", "s-nook", "s-saffron"]);
    expect(order("year")).toEqual(["s-forecast", "s-nook", "s-paper", "s-saffron"]);
    expect(order("duration")).toEqual(["s-paper", "s-saffron", "s-nook", "s-forecast"]);
    const kept = (filters: Parameters<typeof shownParrotSongs>[1]["filters"]) => ids(shownParrotSongs(songs, { sort: "title", filters }, context));
    expect(kept({ liked: true })).toEqual(["s-paper", "s-saffron"]);
    expect(kept({ lyrics: true })).toEqual(["s-nook", "s-paper"]);
    expect(kept({ lossless: true })).toEqual(["s-forecast", "s-nook", "s-saffron"]);
    expect(kept({ genre: "Ambient" })).toEqual(["s-saffron"]);
    expect(kept({ decade: 1990 })).toEqual(["s-paper", "s-saffron"]);
    expect(kept({ liked: true, lossless: true })).toEqual(["s-saffron"]);
  });

  it("Genre and Decade offer only what the tab's rows carry", () => {
    const options = {
      albumGenres: parrotLibraryGenreOptions("albums", context),
      songGenres: parrotLibraryGenreOptions("songs", context),
      artistGenres: parrotLibraryGenreOptions("artists", context),
      albumDecades: parrotLibraryDecadeOptions("albums", context),
    };
    log("options", options);
    expect(options.albumGenres).toEqual(["Electronic", "Pop", "Rock"]);
    expect(options.songGenres).toEqual(["Ambient", "Electronic", "Pop", "Rock"]);
    expect(options.artistGenres).toEqual(["Ambient", "Electronic", "Pop", "Rock"]);
    expect(options.albumDecades).toEqual([2000, 1990]);
  });

  it("reads stored picks back per tab, dropping an unknown sort, a filter the tab lacks, and unreadable text", () => {
    const stored = JSON.stringify({
      albums: { sort: "year", filters: { genre: "Rock", liked: true, decade: 1995 } },
      artists: { sort: "duration", filters: { genre: "Pop" } },
      songs: { sort: "duration", filters: { liked: true, lyrics: "yes", decade: 1990 } },
    });
    const prefs = parseParrotLibraryPrefs(stored);
    log("parsed", prefs);
    expect(prefs).toEqual({
      albums: { sort: "year", filters: { genre: "Rock" } },
      artists: { sort: "name", filters: { genre: "Pop" } },
      songs: { sort: "duration", filters: { liked: true, decade: 1990 } },
    });
    expect(parseParrotLibraryPrefs("{not json")).toEqual(defaultParrotLibraryPrefs());
    expect(parseParrotLibraryPrefs(null)).toEqual(defaultParrotLibraryPrefs());
    expect(countParrotLibraryFilters(prefs.songs.filters)).toBe(2);
  });
});
