import { describe, expect, it } from "vitest";
import type { MediaDetails, MediaRow } from "@space/shared/libraryTypes";
import { serializeTitleVariants, titleVariantsKey, type TitleVariantSet } from "@space/shared/titleLanguage";
import { buildIntegrationLibrary, type IntegrationLibrary, type LibraryReader } from "../src/library";

/**
 * ACCT-PROF-03 (badger-jellyfin): the followed profile's `titleLanguage` picks the titles and pictures the plugin turns
 * into `.nfo` files and local images. "Original version" shows each title's original set from its
 * `title_variants_v1:<media id>` row, a picture only once copied into the user's storage (a TMDB path keeps the row's);
 * "App language everywhere", an unset option or a title without an original set show the library row as stored.
 */

const T = "acct-prof-03";
const phase = (test: string, message: string, data?: unknown) =>
  console.info(`[${T}] ${test}: ${message}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const row = (over: Partial<MediaRow> & Pick<MediaRow, "id" | "type" | "title">): MediaRow => ({
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

const HATE = row({ id: "m-hate", type: "movie", title: "Hate", originalTitle: "La Haine", originalLanguage: "fr", tmdbId: 406, posterPath: "vault/hate-en.jpg", backdropPath: "vault/hate-bd-en.jpg" });
const DBZ = row({ id: "m-dbz", type: "movie", title: "Dragon Ball Z: Battle of Gods", originalLanguage: "ja", tmdbId: 126963, posterPath: "vault/dbz.jpg" });
const DARK = row({ id: "s-dark", type: "tv", title: "Dark", originalLanguage: "de", tmdbId: 70523, posterPath: "vault/dark-en.jpg", backdropPath: "vault/dark-bd-en.jpg" });

const reader = (rows: MediaRow[], settings: Record<string, string>): LibraryReader => ({
  getVersion: () => 1,
  listMedia: () => rows,
  getSetting: (key: string) => (key in settings ? { value: settings[key]!, updatedAt: "2026-11-16T10:00:00.000Z" } : null),
  getMediaDetails: (id: string) => {
    const r = rows.find((entry) => entry.id === id);
    if (!r) return null;
    const movie = r.type === "movie";
    const fileId = movie ? `f-${id}` : `f-${id}-e1`;
    return {
      ...r,
      cast: [],
      playlistIds: [],
      seasons: movie ? [] : [{ id: "s1", seasonNumber: 1, name: "Season 1", overview: null, posterPath: null, episodeCount: 1, airDate: null }],
      episodes: movie ? [] : [{ id: `${id}-e1`, seasonNumber: 1, episodeNumber: 1, name: "Secrets", overview: null, stillPath: null, airDate: null }],
      trailers: [],
      files: [{ id: fileId, filename: "x.mkv", season: movie ? null : 1, episode: movie ? null : 1, desiredFormats: [] }],
      formats: [{ id: `fmt-${fileId}`, mediaId: id, fileId, quality: "1080p", codec: "h264", bitrateKbps: 5000, sizeMb: 100, initKey: null, initSize: null, durationSeconds: 1000, totalSize: null, chunks: [] }],
      audioTracks: [],
      subtitleTracks: [],
      subtitles: [],
      chapters: [],
      skipMarkers: [],
      hasLocalFiles: false,
    } as unknown as MediaDetails;
  },
});

const variants = (rowTitle: string, original: TitleVariantSet | null) =>
  serializeTitleVariants({ rowLanguage: "en", rowTitle, original, fetchedAt: "2026-11-16T00:00:00.000Z" });

const settings = (titleLanguage: string) =>
  JSON.stringify({ titleLanguage, fieldUpdatedAt: { titleLanguage: "2026-11-16T00:00:00.000Z" }, updatedAt: "2026-11-16T00:00:00.000Z" });

const VARIANTS: Record<string, string> = {
  [titleVariantsKey(HATE.id)]: variants("Hate", { language: "fr", title: "La Haine", posterPath: "vault/hate-fr.jpg", backdropPath: "/tmdbHateBackdrop.jpg" }),
  // Non-Latin original: the background pass keeps no original set, the English row is shown with both options.
  [titleVariantsKey(DBZ.id)]: variants(DBZ.title, null),
  [titleVariantsKey(DARK.id)]: variants("Dark", { language: "de", title: "Dark", posterPath: "/tmdbDarkPoster.jpg", backdropPath: "vault/dark-bd-de.jpg" }),
};

const shown = (library: IntegrationLibrary) =>
  Object.fromEntries([...library.movies, ...library.shows].map((item) => [item.id, [item.title, item.posterPath, item.backdropPath]]));

describe("how titles appear for the followed profile (ACCT-PROF-03)", () => {
  it("@req ACCT-PROF-03[badger-jellyfin] Original version shows the original title, and its pictures once copied", () => {
    const test = "original";
    const library = buildIntegrationLibrary(reader([HATE, DBZ, DARK], { ...VARIANTS, profile_settings_v1: settings("original") }), "");
    phase(test, "built", shown(library));
    expect(shown(library)).toEqual({
      // The copied French poster replaces the row's; the backdrop is still a TMDB path, the row's stays.
      [HATE.id]: ["La Haine", "vault/hate-fr.jpg", "vault/hate-bd-en.jpg"],
      [DBZ.id]: ["Dragon Ball Z: Battle of Gods", "vault/dbz.jpg", null],
      [DARK.id]: ["Dark", "vault/dark-en.jpg", "vault/dark-bd-de.jpg"],
    });
    // Synopsis, original title and the rest stay the row's.
    expect(library.movies.find((movie) => movie.id === HATE.id)).toMatchObject({ originalTitle: "La Haine", tmdbId: 406 });
  });

  it("@req ACCT-PROF-03[badger-jellyfin] App language everywhere, unset or unreadable options show the library row", () => {
    const test = "app";
    for (const option of [settings("app"), null, "", "{oops", settings("klingon")]) {
      const stored: Record<string, string> = { ...VARIANTS };
      if (option !== null) stored.profile_settings_v1 = option;
      const library = buildIntegrationLibrary(reader([HATE, DARK], stored), "");
      phase(test, "built", { option, shown: shown(library) });
      expect(shown(library)).toEqual({
        [HATE.id]: ["Hate", "vault/hate-en.jpg", "vault/hate-bd-en.jpg"],
        [DARK.id]: ["Dark", "vault/dark-en.jpg", "vault/dark-bd-en.jpg"],
      });
    }
  });

  it("@req ACCT-PROF-03[badger-jellyfin] each profile reads its own option; a missing or malformed variant row keeps the row", () => {
    const test = "per-profile";
    const stored = { ...VARIANTS, "p:kid:profile_settings_v1": settings("original"), [titleVariantsKey(DARK.id)]: "{broken" };
    const kid = shown(buildIntegrationLibrary(reader([HATE, DBZ, DARK], stored), "p:kid:"));
    const main = shown(buildIntegrationLibrary(reader([HATE, DBZ, DARK], stored), ""));
    phase(test, "built", { kid, main });
    expect(kid[HATE.id]![0]).toBe("La Haine");
    expect(kid[DARK.id]).toEqual(["Dark", "vault/dark-en.jpg", "vault/dark-bd-en.jpg"]);
    expect(main[HATE.id]![0]).toBe("Hate");
  });
});
