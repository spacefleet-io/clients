/**
 * @test-id PARROT-CORE-EDIT-SUGGEST-001
 * @level unit (in-memory library, canned lookup answers)
 * @req PAR-META-18[parrot]
 * @why PAR-META-18: the edit dialog's fields autocomplete together. Results that fit every filled field (typos
 *   included) come first, results matching only the typed text come in their own section, the library's come before
 *   the lookup's in each, a result found in both is shown once (the library's), and picking one fills every field it
 *   knows (artist, album, track number, disc, year) without touching the genre.
 */
import { describe, expect, it } from "bun:test";
import type { MusicSuggestion } from "@space/shared/api";
import type { ParrotEditFields } from "../src/editForm";
import {
  applyParrotEditSuggestion,
  mergeParrotEditSuggestions,
  parrotLibrarySuggestions,
  parrotLookupSuggestions,
  parrotMusicSuggestQuery,
  type ParrotEditSuggestQuery,
  type ParrotSuggestLibrary,
} from "../src/editSuggest";

const library: ParrotSuggestLibrary = {
  artists: [
    { id: "ar-lp", name: "Linkin Park" },
    { id: "ar-bonobo", name: "Bonobo" },
  ],
  albums: [
    { id: "al-meteora", title: "Meteora", artist: "Linkin Park", year: 2003, kind: "Album", musicId: "rg-meteora" },
    { id: "al-ht", title: "Hybrid Theory", artist: "Linkin Park", year: 2000, kind: "Album", musicId: "rg-ht" },
    { id: "al-shower", title: "Meteor Shower", artist: "Bonobo", year: 2011, kind: "Album", musicId: null },
  ],
  tracks: [
    { id: "t-numb", title: "Numb", artist: "Linkin Park", albumId: "al-meteora", album: "Meteora", number: 13, disc: 1, year: null },
    { id: "t-faint", title: "Faint", artist: "Linkin Park", albumId: "al-meteora", album: "Meteora", number: 7, disc: 1, year: null },
    { id: "t-crawl", title: "Crawling", artist: "Linkin Park", albumId: "al-ht", album: "Hybrid Theory", number: 5, disc: 1, year: null },
    { id: "t-kiara", title: "Kiara", artist: "Bonobo", albumId: "al-shower", album: "Meteor Shower", number: 2, disc: 1, year: null },
  ],
};

// The example Chris gave: artist typed with a typo, title right, "mete" typed in Album.
const meteQuery: ParrotEditSuggestQuery = { kind: "track", field: "album", text: "mete", fields: { title: "Numb", artist: "Pinkin Park", album: "Hybrid Theory" } };

const lookupResult = (over: Partial<MusicSuggestion>): MusicSuggestion => ({
  kind: "album",
  artist: { id: "mb-artist", name: "Someone" },
  album: { id: "mb-album", title: "Something", year: 2001, kind: "Album", trackNumber: null, disc: null },
  song: null,
  fits: { title: false, artist: false, album: true },
  ...over,
});

const trackValues: ParrotEditFields = { title: "Numb", artist: "Pinkin Park", album: "mete", number: null, disc: 1, year: null, genre: "Nu metal" };

describe("parrotLibrarySuggestions", () => {
  it("@req PAR-META-18 puts Meteora by Linkin Park first among what fits the song, typo in the artist included", () => {
    const results = parrotLibrarySuggestions(library, meteQuery);
    const { all, field } = mergeParrotEditSuggestions(results, []);
    expect(all[0]).toMatchObject({
      kind: "song",
      inLibrary: true,
      scope: "all",
      artist: { id: "ar-lp", name: "Linkin Park" },
      album: { title: "Meteora", trackNumber: 13, disc: 1, year: 2003 },
      song: { id: "t-numb", title: "Numb" },
      fits: { title: true, artist: true, album: true },
      coverId: "rg-meteora",
    });
    // The bare Meteora album is not shown twice next to the song on it.
    expect(all.filter((s) => s.album?.title === "Meteora")).toHaveLength(1);
    // Bonobo's "Meteor Shower" matches only what is typed.
    expect(field.map((s) => [s.kind, s.album?.title, s.artist.name])).toEqual([["album", "Meteor Shower", "Bonobo"]]);
    expect(field[0]!.fits).toEqual({ title: false, artist: false, album: true });
    // "Hybrid Theory" (the old album value) does not match "mete" at all.
    expect(results.some((s) => s.album?.title === "Hybrid Theory")).toBe(false);
  });

  it("@req PAR-META-18 an artist typed suggests the artist and the song of theirs that fits the title", () => {
    const results = parrotLibrarySuggestions(library, { kind: "track", field: "artist", text: "linkn", fields: { title: "Crawling", artist: "", album: "" } });
    expect(results[0]).toMatchObject({ kind: "song", scope: "all", song: { title: "Crawling" }, album: { title: "Hybrid Theory", trackNumber: 5 } });
    expect(results.every((s) => s.artist.name === "Linkin Park")).toBe(true);
  });

  it("@req PAR-META-18 a title typed suggests the songs whose title starts with it, with their album", () => {
    const results = parrotLibrarySuggestions(library, { kind: "track", field: "title", text: "fai", fields: { title: "", artist: "linkin park", album: "" } });
    expect(results.map((s) => [s.song?.title, s.album?.title, s.scope])).toEqual([["Faint", "Meteora", "all"]]);
  });

  it("@req PAR-META-18 drops everything when the typed text matches nothing, and nothing is asked with nothing typed", () => {
    expect(parrotLibrarySuggestions(library, { ...meteQuery, text: "zzzz" })).toEqual([]);
    expect(parrotLibrarySuggestions(library, { ...meteQuery, text: "  " })).toEqual([]);
  });

  it("@req PAR-META-18 a song filed without a track or disc tag (kept as 0) has no track number, and a pick keeps the typed one", () => {
    const untagged: ParrotSuggestLibrary = {
      artists: [{ id: "ar-nobody", name: "Nobody Known" }],
      albums: [{ id: "al-nowhere", title: "Nowhere", artist: "Nobody Known", year: null, kind: null, musicId: null }],
      tracks: [{ id: "t-tone", title: "Unknown Tone", artist: "Nobody Known", albumId: "al-nowhere", album: "Nowhere", number: 0, disc: 0, year: null }],
    };
    const results = parrotLibrarySuggestions(untagged, { kind: "track", field: "album", text: "nowh", fields: { title: "Unknown Tone", artist: "Nobody Known", album: "" } });
    console.info("[SUITE:test] phase: untagged track suggestion", JSON.stringify(results[0]?.album));
    expect(results[0]).toMatchObject({ kind: "song", album: { title: "Nowhere", trackNumber: null, disc: null } });
    const values: ParrotEditFields = { title: "Unknown Tone", artist: "Nobody Known", album: "nowh", number: 4, disc: 1, year: null, genre: null };
    expect(applyParrotEditSuggestion("track", values, results[0]!)).toMatchObject({ album: "Nowhere", number: 4, disc: 1 });
  });
});

describe("mergeParrotEditSuggestions", () => {
  it("@req PAR-META-18 shows the library first in each section and keeps the library copy of a result found in both", () => {
    const lib = parrotLibrarySuggestions(library, meteQuery);
    const lookup = parrotLookupSuggestions(
      [
        lookupResult({
          kind: "song",
          artist: { id: "mb-lp", name: "Linkin Park" },
          album: { id: "mb-meteora", title: "Meteora", year: 2003, kind: "Album", trackNumber: 13, disc: 1 },
          song: { id: "mb-numb", title: "Numb", durationMs: 185000 },
          fits: { title: true, artist: true, album: true },
        }),
        lookupResult({
          kind: "song",
          artist: { id: "mb-lp", name: "Linkin Park" },
          album: { id: "mb-live", title: "Meteora Live", year: 2004, kind: "Live", trackNumber: 2, disc: 1 },
          song: { id: "mb-numb-live", title: "Numb (Live)", durationMs: 190000 },
          fits: { title: true, artist: true, album: true },
        }),
        lookupResult({ kind: "album", artist: { id: "mb-x", name: "Meteor Men" }, album: { id: "mb-met", title: "Meteorite", year: 1999, kind: "Album", trackNumber: null, disc: null } }),
      ],
      meteQuery,
    );
    expect(lookup.every((s) => !s.inLibrary)).toBe(true);
    const { all, field } = mergeParrotEditSuggestions(lib, lookup);
    // The Numb on Meteora found by both is the library's one.
    const numb = all.filter((s) => s.song?.title === "Numb");
    expect(numb).toHaveLength(1);
    expect(numb[0]!.inLibrary).toBe(true);
    expect(numb[0]!.song?.id).toBe("t-numb");
    expect(all.map((s) => [s.inLibrary, s.album?.title])).toEqual([
      [true, "Meteora"],
      [false, "Meteora Live"],
    ]);
    expect(field.map((s) => [s.inLibrary, s.album?.title])).toEqual([
      [true, "Meteor Shower"],
      [false, "Meteorite"],
    ]);
    expect(field[1]!.coverId).toBe("mb-met");
  });

  it("@req PAR-META-18 corrects a badly tagged vault album with the lookup's spelling, year and cover, keeping its vault ids", () => {
    const sloppy: ParrotSuggestLibrary = {
      artists: [{ id: "a-lp", name: "linkin park" }],
      albums: [{ id: "al-met", title: "meteora", artist: "linkin park", year: null, kind: null, musicId: null }],
      tracks: [],
    };
    const query: ParrotEditSuggestQuery = { kind: "album", field: "title", text: "mete", fields: { title: "mete", artist: "linkin park" } };
    const lib = parrotLibrarySuggestions(sloppy, query);
    const lookup = parrotLookupSuggestions(
      [lookupResult({ kind: "album", artist: { id: "mb-lp", name: "Linkin Park" }, album: { id: "mb-meteora", title: "Meteora", year: 2003, kind: "Album", trackNumber: null, disc: null }, fits: { title: false, artist: true, album: true } })],
      query,
    );
    const { all, field } = mergeParrotEditSuggestions(lib, lookup);
    console.info(`[parrot-core-editSuggest] sloppy vault album: ${JSON.stringify({ all, field })}`);
    expect([...all, ...field]).toHaveLength(1);
    expect(all[0]).toMatchObject({ inLibrary: true, artist: { id: "a-lp", name: "Linkin Park" }, album: { id: "al-met", title: "Meteora", year: 2003 }, coverId: "mb-meteora" });
    expect(applyParrotEditSuggestion("album", { title: "mete", artist: "linkin park", album: "", number: null, disc: 1, year: null, genre: "Rock" }, all[0]!)).toMatchObject({ title: "Meteora", artist: "Linkin Park", year: 2003, genre: "Rock" });
  });

  it("@req PAR-META-18 a vault album the lookup's song stands for keeps its place and its in-your-library mark", () => {
    // The e2e's vault: Meteora is in the library (with Faint), but Numb is still filed as "pinkin park" / "unsorted".
    const vault: ParrotSuggestLibrary = {
      artists: [{ id: "a-lp", name: "Linkin Park" }],
      albums: [{ id: "al-met", title: "Meteora", artist: "Linkin Park", year: 2003, kind: null, musicId: null }],
      tracks: [{ id: "t-faint", title: "Faint", artist: "Linkin Park", albumId: "al-met", album: "Meteora", number: 7, disc: 1, year: 2003 }],
    };
    const lib = parrotLibrarySuggestions(vault, meteQuery);
    const lookup = parrotLookupSuggestions(
      [
        lookupResult({
          kind: "song",
          artist: { id: "mb-lp", name: "Linkin Park" },
          album: { id: "mb-meteora", title: "Meteora", year: 2003, kind: "Album", trackNumber: 13, disc: 1 },
          song: { id: "mb-numb", title: "Numb", durationMs: 185000 },
          fits: { title: true, artist: true, album: true },
        }),
      ],
      meteQuery,
    );
    const { all } = mergeParrotEditSuggestions(lib, lookup);
    console.info(`[SUITE:test] phase: vault album covered by a lookup song ${JSON.stringify(all)}`);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ kind: "song", inLibrary: true, song: { title: "Numb" }, album: { id: "al-met", title: "Meteora", trackNumber: 13 }, coverId: "mb-meteora" });
  });

  it("@req PAR-META-18 leaves out the song being edited as the library has it, so the lookup's correction comes first", () => {
    // The e2e's vault: Numb still filed as "pinkin park" / "unsorted"; Linkin Park's Faint on Meteora.
    const vault: ParrotSuggestLibrary = {
      artists: [
        { id: "a-pp", name: "pinkin park" },
        { id: "a-lp", name: "Linkin Park" },
      ],
      albums: [{ id: "al-uns", title: "unsorted", artist: "pinkin park", year: null, kind: null, musicId: null }],
      tracks: [{ id: "t-numb", title: "numb", artist: "pinkin park", albumId: "al-uns", album: "unsorted", number: 0, disc: 0, year: null }],
    };
    const values: ParrotEditFields = { title: "numb", artist: "pinkin park", album: "unsorted", number: null, disc: 1, year: null, genre: null };
    const query: ParrotEditSuggestQuery = { kind: "track", field: "artist", text: "pink", fields: { title: "numb", artist: "pink", album: "unsorted" } };
    const lib = parrotLibrarySuggestions(vault, query);
    const lookup = parrotLookupSuggestions(
      [
        lookupResult({
          kind: "song",
          artist: { id: "mb-lp", name: "Linkin Park" },
          album: { id: "mb-meteora", title: "Meteora", year: 2003, kind: "Album", trackNumber: 13, disc: 1 },
          song: { id: "mb-numb", title: "Numb", durationMs: 185000 },
          fits: { title: true, artist: true, album: false },
        }),
      ],
      query,
    );
    const before = mergeParrotEditSuggestions(lib, lookup);
    const after = mergeParrotEditSuggestions(lib, lookup, { kind: "track", values });
    console.info(`[SUITE:test] phase: self suggestion before ${JSON.stringify([...before.all, ...before.field].map((s) => s.artist.name))} after ${JSON.stringify([...after.all, ...after.field].map((s) => s.artist.name))}`);
    expect([...before.all, ...before.field][0]).toMatchObject({ inLibrary: true, artist: { name: "pinkin park" } });
    expect([...after.all, ...after.field][0]).toMatchObject({ artist: { name: "Linkin Park" }, song: { title: "Numb" } });
    expect([...after.all, ...after.field].some((s) => s.artist.name === "pinkin park")).toBe(false);
    // Title fits, Album ("unsorted") does not: fitting one other filled field is enough for "Fits this song".
    expect(after.all[0]).toMatchObject({ artist: { name: "Linkin Park" }, fits: { title: true, artist: true, album: false } });
  });
});

describe("applyParrotEditSuggestion", () => {
  it("@req PAR-META-18 picking a song fills artist, album, track number, disc and year, and leaves the genre", () => {
    const [pick] = mergeParrotEditSuggestions(parrotLibrarySuggestions(library, meteQuery), []).all;
    expect(applyParrotEditSuggestion("track", trackValues, pick!)).toEqual({
      title: "Numb",
      artist: "Linkin Park",
      album: "Meteora",
      number: 13,
      disc: 1,
      year: 2003,
      genre: "Nu metal",
    });
  });

  it("@req PAR-META-18 picking an album keeps the song's own title and number", () => {
    const shower = parrotLibrarySuggestions(library, meteQuery).find((s) => s.kind === "album")!;
    expect(applyParrotEditSuggestion("track", { ...trackValues, number: 4 }, shower)).toEqual({
      title: "Numb",
      artist: "Bonobo",
      album: "Meteor Shower",
      number: 4,
      disc: 1,
      year: 2011,
      genre: "Nu metal",
    });
  });
});

describe("album dialog", () => {
  const albumQuery: ParrotEditSuggestQuery = { kind: "album", field: "title", text: "hybrd", fields: { title: "hybrd", artist: "Linkn Park" } };

  it("@req PAR-META-18 the album title typed suggests albums fitting the album artist, in music terms", () => {
    const results = parrotLibrarySuggestions(library, albumQuery);
    expect(results[0]).toMatchObject({ kind: "album", scope: "all", album: { title: "Hybrid Theory", year: 2000 }, coverId: "rg-ht", fits: { title: false, artist: true, album: true } });
    expect(parrotMusicSuggestQuery(albumQuery, 10)).toEqual({ field: "album", text: "hybrd", artist: "Linkn Park", limit: 10 });
  });

  it("@req PAR-META-18 the album artist typed suggests artists", () => {
    const results = parrotLibrarySuggestions(library, { kind: "album", field: "artist", text: "bono", fields: { title: "", artist: "bono" } });
    expect(results.map((s) => [s.kind, s.artist.name])).toEqual([["artist", "Bonobo"]]);
  });

  it("@req PAR-META-18 picking an album fills title, album artist and year, and leaves the genre", () => {
    const [pick] = parrotLibrarySuggestions(library, albumQuery);
    const values: ParrotEditFields = { title: "hybrd", artist: "Linkn Park", year: null, genre: "Rock" };
    expect(applyParrotEditSuggestion("album", values, pick!)).toEqual({ title: "Hybrid Theory", artist: "Linkin Park", year: 2000, genre: "Rock" });
  });
});
