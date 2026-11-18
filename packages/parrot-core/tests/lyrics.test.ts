/**
 * @test-id PARROT-CORE-LYRICS-001
 * @level unit
 * @why PAR-LYR-01, PAR-LOOK-01: every app reads the library's LRC text the same way (several times per line, ID tags
 *      and offset, untimed lines dropped) and lights the same line at a given moment; the album grid's sort button
 *      gives the same order everywhere, "Recently added" first as in the design.
 * @covers packages/parrot-core/src/lyrics.ts, packages/parrot-core/src/librarySort.ts
 * @req PAR-LYR-01[parrot]
 */
import { describe, expect, it } from "bun:test";
import { activeLyricIndex, parseLrc, parseParrotAlbumSort, sortParrotAlbums, toLrc, toParrotLyrics } from "../src";

describe("LRC lyrics", () => {
  it("reads timed lines in order, repeats multi-time lines and applies the offset", () => {
    const lines = parseLrc("[ti:Song]\n[offset:+500]\n[00:10.00][01:00.5] Chorus\nno time here\n[00:05.25]Verse\n[00:20.00]");
    expect(lines).toEqual([
      { ms: 4750, text: "Verse" },
      { ms: 9500, text: "Chorus" },
      { ms: 19_500, text: "" },
      { ms: 60_000, text: "Chorus" },
    ]);
    expect(parseLrc("plain words only")).toBeNull();
  });

  it("writes lines back as LRC that reads the same", () => {
    const lines = [{ ms: 1230, text: "One" }, { ms: 61_000, text: "Two" }];
    expect(toLrc(lines)).toBe("[00:01.23] One\n[01:01.00] Two");
    expect(parseLrc(toLrc(lines))).toEqual(lines);
  });

  it("lights the last line that has started", () => {
    const lines = parseLrc("[00:01.00] a\n[00:03.00] b\n[00:05.00] c")!;
    expect([0, 1000, 2999, 3000, 9999].map((ms) => activeLyricIndex(lines, ms))).toEqual([-1, 0, 0, 1, 2]);
  });

  it("shows synced lyrics over plain ones and nothing for an empty row", () => {
    expect(toParrotLyrics({ synced: "[00:01.00] a", plain: "a", source: "file" })).toEqual({ synced: [{ ms: 1000, text: "a" }], plain: "a", fetched: false });
    expect(toParrotLyrics({ synced: null, plain: "b", source: "fetched" })).toEqual({ synced: null, plain: "b", fetched: true });
    expect(toParrotLyrics({ synced: null, plain: "  ", source: "file" })).toBeNull();
    expect(toParrotLyrics(undefined)).toBeNull();
  });
});

describe("album sort", () => {
  const albums = [
    { title: "B", artistName: "Zed", year: 2001, addedAt: 1 },
    { title: "a", artistName: "Abe", year: 1999, addedAt: 3 },
    { title: "C", artistName: "Abe", year: 1990, addedAt: 3 },
  ];
  it("orders by recently added, title or artist", () => {
    expect(sortParrotAlbums(albums, "recent").map((a) => a.title)).toEqual(["a", "C", "B"]);
    expect(sortParrotAlbums(albums, "title").map((a) => a.title)).toEqual(["a", "B", "C"]);
    expect(sortParrotAlbums(albums, "artist").map((a) => a.title)).toEqual(["C", "a", "B"]);
    expect(parseParrotAlbumSort("bogus")).toBe("recent");
    expect(parseParrotAlbumSort("title")).toBe("title");
  });
});
