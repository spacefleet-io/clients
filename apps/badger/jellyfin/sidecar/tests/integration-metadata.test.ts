import { describe, expect, it } from "vitest";
import type { MediaDetails, MediaRow } from "@space/shared/libraryTypes";
import { buildIntegrationLibrary, type LibraryReader } from "../src/library";
import { localizedTextKey, serializeLocalizedText, type LocalizedTextRecord } from "@space/shared/localizedTexts";

/**
 * INTG-META-01 (badger-jellyfin, sidecar half): the library the plugin turns into `.nfo` files and local images carries
 * the Badger library's own titles, posters, backdrops, descriptions, years, seasons and episodes, and the TMDB id, read
 * from the library rows as they are. A match the user fixed by hand is simply the row's current values: the sidecar
 * never looks a title up again from the file name, so the fixed title, id and pictures are what Jellyfin gets.
 */

const T = "intg-meta-01";
const phase = (test: string, message: string, data?: unknown) =>
  console.info(`[${T}] ${test}: ${message}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const baseRow = (over: Partial<MediaRow> & Pick<MediaRow, "id" | "type" | "title">): MediaRow => ({
  tmdbId: null,
  externalIds: null,
  originalTitle: null,
  originalLanguage: null,
  overview: null,
  year: null,
  rating: null,
  posterPath: null,
  backdropPath: null,
  genres: [],
  addedAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  hasFiles: true,
  progressPct: 0,
  lastWatchedAt: null,
  totalEpisodes: null,
  episodeCount: 0,
  ...over,
});

const format = (mediaId: string, fileId: string) => ({
  id: `fmt-${fileId}`,
  mediaId,
  fileId,
  quality: "1080p",
  codec: "h264",
  bitrateKbps: 5000,
  sizeMb: 100,
  initKey: null,
  initSize: null,
  durationSeconds: 1000,
  totalSize: null,
  chunks: [],
});

// A movie whose file is called "wrong-guess.mkv": the user fixed the match by hand to "Arrival" (TMDB 329865).
const MOVIE = baseRow({
  id: "movie-fixed",
  type: "movie",
  title: "Arrival",
  originalTitle: "Arrival",
  tmdbId: 329865,
  externalIds: { imdb: "tt2543164" },
  overview: "A linguist works with the military to communicate with alien lifeforms.",
  year: "2016",
  rating: 7.6,
  posterPath: "/x2FJsf1ElAgr63Y3PNPtJrcmpoe.jpg",
  backdropPath: "/yIZ1xendyqKvY3FGeeUYUd5X9Mm.jpg",
  genres: [18, 878],
});

const SHOW = baseRow({
  id: "show-1",
  type: "tv",
  title: "Severance",
  tmdbId: 95396,
  overview: "Mark leads a team of office workers whose memories have been surgically divided.",
  year: "2022",
  posterPath: "/show-poster.jpg",
  backdropPath: "/show-backdrop.jpg",
  totalEpisodes: 3,
  episodeCount: 3,
});

const reader = (rows: MediaRow[], settings: Record<string, string> = {}): LibraryReader => ({
  getVersion: () => 3,
  listMedia: () => rows,
  getSetting: (key: string) => (key in settings ? { value: settings[key]!, updatedAt: "2026-11-16T10:00:00.000Z" } : null),
  getMediaDetails: (id: string) => {
    const r = rows.find((entry) => entry.id === id);
    if (!r) return null;
    const movie = r.type === "movie";
    return {
      ...r,
      cast: movie ? [{ id: "c1", personId: "p1", tmdbId: 1, name: "Amy Adams", role: "Louise Banks", profilePath: null }] : [],
      playlistIds: [],
      seasons: movie
        ? []
        : [
            { id: "s1", seasonNumber: 1, name: "Season 1", overview: "The first season.", posterPath: "/s1.jpg", episodeCount: 2, airDate: "2022-02-18" },
            { id: "s2", seasonNumber: 2, name: "Season 2", overview: null, posterPath: "/s2.jpg", episodeCount: 1, airDate: "2025-01-17" },
          ],
      episodes: movie
        ? []
        : [
            { id: "e1", seasonNumber: 1, episodeNumber: 1, name: "Good News About Hell", overview: "Mark is promoted.", stillPath: "/e1.jpg", airDate: "2022-02-18" },
            { id: "e2", seasonNumber: 1, episodeNumber: 2, name: "Half Loop", overview: "Helly tries to quit.", stillPath: "/e2.jpg", airDate: "2022-02-18" },
            { id: "e3", seasonNumber: 2, episodeNumber: 1, name: "Hello, Ms. Cobel", overview: null, stillPath: "/e3.jpg", airDate: "2025-01-17" },
          ],
      trailers: [],
      files: movie
        ? [{ id: "f-movie", filename: "wrong-guess.mkv", season: null, episode: null, desiredFormats: [] }]
        : [
            { id: "f-e1", filename: "sev.s01e01.mkv", season: 1, episode: 1, desiredFormats: [] },
            { id: "f-e2", filename: "sev.s01e02.mkv", season: 1, episode: 2, desiredFormats: [] },
            { id: "f-e3", filename: "sev.s02e01.mkv", season: 2, episode: 1, desiredFormats: [] },
          ],
      formats: movie ? [format(id, "f-movie")] : [format(id, "f-e1"), format(id, "f-e2"), format(id, "f-e3")],
      audioTracks: [],
      subtitleTracks: [],
      subtitles: [],
      chapters: [],
      skipMarkers: [],
      hasLocalFiles: false,
    } as unknown as MediaDetails;
  },
});

describe("integration library metadata (INTG-META-01)", () => {
  it("@req INTG-META-01[badger-jellyfin] carries the library's titles, pictures, descriptions, years, seasons, episodes and TMDB ids", () => {
    const test = "carries-metadata";
    phase(test, "build");
    const library = buildIntegrationLibrary(reader([MOVIE, SHOW]), "");
    phase(test, "state", library);

    expect(library.movies).toHaveLength(1);
    const movie = library.movies[0]!;
    expect(movie).toMatchObject({
      id: "movie-fixed",
      tmdbId: 329865,
      imdbId: "tt2543164",
      title: "Arrival",
      originalTitle: "Arrival",
      year: 2016,
      overview: MOVIE.overview,
      rating: 7.6,
      genres: ["Drama", "Science Fiction"],
      posterPath: MOVIE.posterPath,
      backdropPath: MOVIE.backdropPath,
      cast: [{ name: "Amy Adams", role: "Louise Banks" }],
    });

    expect(library.shows).toHaveLength(1);
    const show = library.shows[0]!;
    expect(show).toMatchObject({
      tmdbId: 95396,
      title: "Severance",
      year: 2022,
      overview: SHOW.overview,
      posterPath: "/show-poster.jpg",
      backdropPath: "/show-backdrop.jpg",
    });
    expect(show.seasons.map((s) => ({ n: s.seasonNumber, name: s.name, overview: s.overview, poster: s.posterPath }))).toEqual([
      { n: 1, name: "Season 1", overview: "The first season.", poster: "/s1.jpg" },
      { n: 2, name: "Season 2", overview: null, poster: "/s2.jpg" },
    ]);
    expect(show.seasons.flatMap((s) => s.episodes.map((e) => [e.seasonNumber, e.episodeNumber, e.title, e.overview, e.stillPath, e.airDate]))).toEqual([
      [1, 1, "Good News About Hell", "Mark is promoted.", "/e1.jpg", "2022-02-18"],
      [1, 2, "Half Loop", "Helly tries to quit.", "/e2.jpg", "2022-02-18"],
      [2, 1, "Hello, Ms. Cobel", null, "/e3.jpg", "2025-01-17"],
    ]);
  });

  it("@req INTG-META-01[badger-jellyfin] a match the user fixed by hand reaches the integration as the row now holds it, not as the file name suggests", () => {
    const test = "hand-fixed-match";
    const rows = [{ ...MOVIE }];
    phase(test, "before fix", { title: rows[0]!.title, tmdbId: rows[0]!.tmdbId });
    const before = buildIntegrationLibrary(reader(rows), "").movies[0]!;

    // The user picks another title for the same file (manual search): the row now names it.
    rows[0] = { ...rows[0]!, title: "Contact", originalTitle: "Contact", tmdbId: 686, externalIds: { imdb: "tt0118884" }, year: "1997", overview: "Dr. Ellie Arroway finds a signal.", posterPath: "/contact-poster.jpg", backdropPath: "/contact-backdrop.jpg" };
    const after = buildIntegrationLibrary(reader(rows), "").movies[0]!;
    phase(test, "after fix", { before: { title: before.title, tmdbId: before.tmdbId }, after: { title: after.title, tmdbId: after.tmdbId, poster: after.posterPath } });

    expect(before.title).toBe("Arrival");
    expect(after).toMatchObject({ id: "movie-fixed", title: "Contact", tmdbId: 686, imdbId: "tt0118884", year: 1997, overview: "Dr. Ellie Arroway finds a signal.", posterPath: "/contact-poster.jpg", backdropPath: "/contact-backdrop.jpg" });
    expect(JSON.stringify(after)).not.toContain("wrong-guess");
  });

  /**
   * @req LIB-LANG-01[badger-jellyfin]
   * Why: Jellyfin showed the library's stored synopses and episode names (English) whatever its interface language.
   * Building the library reads the kept rows of the interface language, English filling what it lacks field by field,
   * the stored text where neither row has one; the stored episode name stays the file name source.
   */
  it("@req LIB-LANG-01[badger-jellyfin] synopses and episode texts come from the kept rows of the interface language, English then the stored text filling gaps", () => {
    const test = "kept-texts";
    const row = (record: LocalizedTextRecord) => serializeLocalizedText(record);
    const settings = {
      [localizedTextKey("movie", 329865, "fr")]: row({ overview: "Une linguiste communique avec des extraterrestres.", episodes: [], absent: [], fetchedAt: "t" }),
      [localizedTextKey("tv", 95396, "fr")]: row({
        overview: null,
        episodes: [
          { seasonNumber: 1, episodeNumber: 1, name: "Bonne nouvelle de l'enfer", overview: "Mark est promu." },
          { seasonNumber: 1, episodeNumber: 2, name: "Demi-boucle", overview: null },
        ],
        absent: ["2:1"],
        fetchedAt: "t",
      }),
      [localizedTextKey("tv", 95396, "en")]: row({
        overview: "English synopsis from the row.",
        episodes: [{ seasonNumber: 1, episodeNumber: 2, name: "Half Loop", overview: "Helly tries to leave." }],
        absent: ["2:1"],
        fetchedAt: "t",
      }),
    };
    const library = buildIntegrationLibrary(reader([MOVIE, SHOW], settings), "", "fr");
    const show = library.shows[0]!;
    const episodes = show.seasons.flatMap((s) => s.episodes.map((e) => [e.seasonNumber, e.episodeNumber, e.title, e.shownTitle, e.overview]));
    phase(test, "built", { movie: library.movies[0]!.overview, show: show.overview, episodes });

    expect(library.movies[0]!.overview).toBe("Une linguiste communique avec des extraterrestres.");
    // No French synopsis for the show: the English row's.
    expect(show.overview).toBe("English synopsis from the row.");
    expect(episodes).toEqual([
      [1, 1, "Good News About Hell", "Bonne nouvelle de l'enfer", "Mark est promu."],
      // No French synopsis: English fills it.
      [1, 2, "Half Loop", "Demi-boucle", "Helly tries to leave."],
      // Neither row has the episode: the stored texts, no shown name.
      [2, 1, "Hello, Ms. Cobel", null, null],
    ]);

    phase(test, "english interface and no rows: the stored texts as before");
    const plain = buildIntegrationLibrary(reader([MOVIE, SHOW]), "", "en");
    expect(plain.movies[0]!.overview).toBe(MOVIE.overview);
    expect(plain.shows[0]!.overview).toBe(SHOW.overview);
    expect(plain.shows[0]!.seasons[0]!.episodes[0]).toMatchObject({ title: "Good News About Hell", shownTitle: null, overview: "Mark is promoted." });
  });
});
