/**
 * @test-id PARROT-CORE-EDIT-LYRICS-001
 * @level unit
 * @why PAR-LYR-05, PAR-META-20: the edit panel's Lyrics section shimmers while the lyrics are read or looked up (or the
 *   song was never looked up: the panel asks at once), shows the first lines once found, and says "No lyrics found"
 *   only once a lookup came back empty, never while one runs; an album counts its songs with words.
 * @req PAR-LYR-05[parrot]
 * @req PAR-META-20[parrot]
 */
import { describe, expect, it } from "bun:test";
import {
  PARROT_EDIT_LYRICS_PREVIEW_LINES,
  parrotEditAlbumLyricsState,
  parrotEditAlbumLyricsToAsk,
  parrotEditLyricsNeedsLookup,
  parrotEditLyricsState,
} from "../src/editLyrics";
import { PARROT_LYRICS_SEARCHING, type ParrotLyrics } from "../src/lyrics";

const T = "[PARROT-CORE-EDIT-LYRICS]";
const FABLE: ParrotLyrics = {
  synced: [
    { ms: 0, text: "I am a lantern in the fog" },
    { ms: 2000, text: "A pocket full of pebbles" },
    { ms: 4000, text: "Handful of seashells" },
    { ms: 6000, text: "But I can't find the map" },
    { ms: 8000, text: "That leads us to the shore" },
  ],
  plain: null,
  fetched: true,
};
const NOT_FOUND: ParrotLyrics = { synced: null, plain: null, fetched: true, notFound: true };

describe("parrotEditLyricsState", () => {
  it("shimmers while reading, while searching and for a song never looked up", () => {
    for (const lyrics of [undefined, null, PARROT_LYRICS_SEARCHING]) expect(parrotEditLyricsState(lyrics).status).toBe("loading");
    expect(parrotEditLyricsState(NOT_FOUND, { status: "busy" }).status).toBe("loading");
  });

  it("shows the first lines of the found words", () => {
    const state = parrotEditLyricsState(FABLE);
    console.info(T, "found", JSON.stringify(state));
    expect(state).toEqual({ status: "found", synced: true, preview: FABLE.synced!.slice(0, PARROT_EDIT_LYRICS_PREVIEW_LINES).map((line) => line.text) });
    expect(parrotEditLyricsState({ synced: null, plain: "Fable\n\nI wander", fetched: false })).toEqual({ status: "found", synced: false, preview: ["Fable", "I wander"] });
  });

  it("says none only once the lookup came back empty, and failed with its reason", () => {
    expect(parrotEditLyricsState(NOT_FOUND).status).toBe("none");
    expect(parrotEditLyricsState(NOT_FOUND, { status: "failed", reason: "offline" })).toEqual({ status: "failed", reason: "offline" });
  });

  it("asks only for a song never looked up", () => {
    expect([null, undefined, NOT_FOUND, PARROT_LYRICS_SEARCHING, FABLE].map(parrotEditLyricsNeedsLookup)).toEqual([true, false, false, false, false]);
  });
});

describe("parrotEditAlbumLyricsState", () => {
  it("shimmers while any song is read or looked up, then counts the songs with words", () => {
    expect(parrotEditAlbumLyricsState([FABLE, undefined]).status).toBe("loading");
    expect(parrotEditAlbumLyricsState([FABLE, PARROT_LYRICS_SEARCHING]).status).toBe("loading");
    expect(parrotEditAlbumLyricsState([FABLE, NOT_FOUND], true).status).toBe("loading");
    const counted = parrotEditAlbumLyricsState([FABLE, NOT_FOUND, null]);
    console.info(T, "album", JSON.stringify(counted));
    expect(counted).toEqual({ status: "counted", found: 1, count: 3, missing: 2 });
  });

  it("asks for the album's songs never looked up", () => {
    expect(parrotEditAlbumLyricsToAsk([{ id: "fable", lyrics: FABLE }, { id: "nook", lyrics: null }, { id: "nobody", lyrics: NOT_FOUND }])).toEqual(["nook"]);
  });
});
