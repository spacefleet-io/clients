/**
 * @test-id PARROT-TV-MODEL-001
 * @level unit
 * @req PAR-TV-03[parrot-tv]
 * @req PAR-TV-05[parrot-tv]
 * @req PAR-TV-07[parrot-tv]
 * @req PAR-TV-09[parrot-tv]
 * @req PAR-TV-12[parrot-tv]
 * @req PAR-TV-10[parrot-tv]
 * @req PAR-TV-13[parrot-tv]
 * @req PAR-TV-06[parrot-tv]
 * @why Parrot TV has no navigator: its shell keeps a stack of pages over the sections, the album, playlist and artist
 *   pages under the top bar and Now playing, the lyrics, Up next and the profiles over the whole screen (Chris
 *   2026-11-20 drafts). Back closes the topmost page, and opening a page already open goes back to it, so Back from a
 *   song played on Up next still lands where the user was. The remote's media keys act once per press. Now playing
 *   shows the line sung and the next one; Up next jumps to a song by stepping forward in the player's own order; the
 *   artist page plays the artist's songs album by album with each album's cover; the album caption, the grid's columns
 *   and the Settings groups (Privacy only where error reports are offered) are pinned here, with the Search grid's keys.
 * @covers apps/parrot/mobile/src/tv/tvModel.ts
 */
import { describe, expect, it } from "vitest";
import type { TrackRow } from "@space/parrot-core";
import type { AlbumWithCover } from "../src/lib/library";
import {
  artistSongs,
  LYRICS_EDGE_FADE,
  lyricsEdgeOpacity,
  lyricsPeek,
  pushTvPage,
  skipToUpNext,
  tvAlbumCaption,
  tvGridColumnsFor,
  tvPageHasTopBar,
  tvPageKeepsAwake,
  tvPageKey,
  tvRemoteAction,
  tvSettingsGroupIds,
  TV_SEARCH_CHARS,
  typeTvSearchKey,
  type TvPage,
} from "../src/tv/tvModel";

const SUITE = "[PARROT-TV-MODEL-001]";
const log = (phase: string, detail: unknown) => console.info(`${SUITE} ${phase}`, JSON.stringify(detail));

describe("@req PAR-TV-10[parrot-tv] the page stack: Back closes the topmost page; a page already open is gone back to", () => {
  it("album, playlist and artist keep the top bar; Now playing, lyrics, Up next and profiles fill the screen", () => {
    const pages: TvPage[] = [
      { kind: "album", albumId: "a1" },
      { kind: "playlist", playlistId: "p1", name: "Mix" },
      { kind: "artist", artistId: "r1", name: "Linkin Park" },
      { kind: "nowPlaying" },
      { kind: "lyrics" },
      { kind: "queue" },
      { kind: "profiles", mode: "pick" },
    ];
    const bar = pages.map((page) => [tvPageKey(page), tvPageHasTopBar(page)]);
    log("top bar", bar);
    expect(bar).toEqual([
      ["album:a1", true],
      ["playlist:p1", true],
      ["artist:r1", true],
      ["nowPlaying", false],
      ["lyrics", false],
      ["queue", false],
      ["profiles:pick", false],
    ]);
  });

  it("stacks a new page, and goes back to one already open instead of stacking it twice", () => {
    let stack: TvPage[] = [];
    stack = pushTvPage(stack, { kind: "artist", artistId: "r1", name: "LP" });
    stack = pushTvPage(stack, { kind: "album", albumId: "a1" });
    stack = pushTvPage(stack, { kind: "nowPlaying" });
    stack = pushTvPage(stack, { kind: "queue" });
    expect(stack.map(tvPageKey)).toEqual(["artist:r1", "album:a1", "nowPlaying", "queue"]);
    // A song played from Up next opens Now playing: the one under Up next, not a second one.
    stack = pushTvPage(stack, { kind: "nowPlaying" });
    log("stack", stack.map(tvPageKey));
    expect(stack.map(tvPageKey)).toEqual(["artist:r1", "album:a1", "nowPlaying"]);
    // Another album is a new page.
    expect(pushTvPage(stack, { kind: "album", albumId: "a2" }).map(tvPageKey)).toEqual(["artist:r1", "album:a1", "nowPlaying", "album:a2"]);
  });
});

describe("@req PAR-TV-10[parrot-tv] the remote's media keys", () => {
  it("on Apple TV, play, pause, next, previous, fast-forward and rewind act once, on the key's release", () => {
    const cases = [
      [{ eventType: "playPause", eventKeyAction: 1 }, "playPause"],
      [{ eventType: "play", eventKeyAction: 1 }, "playPause"],
      [{ eventType: "pause" }, "playPause"],
      [{ eventType: "next", eventKeyAction: 1 }, "next"],
      [{ eventType: "fastForward", eventKeyAction: 1 }, "next"],
      [{ eventType: "previous", eventKeyAction: 1 }, "previous"],
      [{ eventType: "rewind", eventKeyAction: 1 }, "previous"],
      [{ eventType: "playPause", eventKeyAction: 0 }, null],
      [{ eventType: "right", eventKeyAction: 1 }, null],
      [{ eventType: "select", eventKeyAction: 1 }, null],
      [null, null],
    ] as const;
    for (const [event, expected] of cases) {
      log("key", { event, expected, got: tvRemoteAction(event, "ios") });
      expect(tvRemoteAction(event, "ios")).toBe(expected);
    }
  });

  it("on Android the media session answers the media keys, so the app does not act on them a second time", () => {
    for (const eventType of ["playPause", "play", "pause", "next", "fastForward", "previous", "rewind"]) {
      log("key_android", { eventType, got: tvRemoteAction({ eventType, eventKeyAction: 1 }, "android") });
      expect(tvRemoteAction({ eventType, eventKeyAction: 1 }, "android")).toBeNull();
    }
  });
});

describe("@req PAR-TV-07[parrot-tv] Now playing's two lines of lyrics", () => {
  const lines = [
    { ms: 0, text: "Intro" },
    { ms: 10_000, text: "First line" },
    { ms: 20_000, text: "Second line" },
  ];
  it("shows the line sung now and the next one, moving with the song", () => {
    const at = (positionMs: number) => lyricsPeek({ kind: "synced", lines, fetched: false }, positionMs);
    log("peek", { at5: at(5_000), at15: at(15_000), at25: at(25_000) });
    expect(at(5_000)).toEqual({ now: "Intro", next: "First line" });
    expect(at(15_000)).toEqual({ now: "First line", next: "Second line" });
    expect(at(25_000)).toEqual({ now: "Second line", next: "" });
  });
  it("shows nothing for plain lyrics, while searching, or with none", () => {
    expect(lyricsPeek({ kind: "plain", text: "words", fetched: false }, 0)).toBeNull();
    expect(lyricsPeek({ kind: "searching" }, 0)).toBeNull();
    expect(lyricsPeek({ kind: "none", found: true, body: "notFound", searchAgain: true }, 0)).toBeNull();
    expect(lyricsPeek({ kind: "synced", lines: [], fetched: false }, 0)).toBeNull();
  });
});

describe("@req PAR-TV-07[parrot-tv] the Lyrics view fades its lines toward the window's edges (draft 3a mask)", () => {
  it("shows lines fully in the middle band and fades them to nothing at the top and bottom", () => {
    const at = (center: number) => Number(lyricsEdgeOpacity(center, 350).toFixed(2));
    const seen = [-10, 0, 38.5, 77, 175, 273, 311.5, 350, 400].map(at);
    console.info(`${SUITE} edge fade`, JSON.stringify(seen));
    expect(seen).toEqual([0, 0, 0.5, 1, 1, 1, 0.5, 0, 0]);
    expect(LYRICS_EDGE_FADE).toBe(0.22);
    // Before the window is measured nothing is hidden.
    expect(lyricsEdgeOpacity(500, 0)).toBe(1);
  });
});

describe("@req PAR-TV-09[parrot-tv] OK on an Up next song plays it now", () => {
  it("steps forward in the player's own order up to that song", async () => {
    let steps = 0;
    await skipToUpNext(2, async () => void (steps += 1));
    log("skip", { index: 2, steps });
    expect(steps).toBe(3);
    steps = 0;
    await skipToUpNext(0, async () => void (steps += 1));
    expect(steps).toBe(1);
  });
});

describe("@req PAR-TV-05[parrot-tv] the artist page plays every song of the artist's albums", () => {
  it("lists the songs album by album, each with its album's title and cover", () => {
    const album = (id: string, title: string): AlbumWithCover => ({ id, title, coverObjectKey: `cover-${id}`, coverThumbObjectKey: `thumb-${id}` }) as AlbumWithCover;
    const track = (id: string, albumId: string): TrackRow => ({ id, albumId, title: id }) as TrackRow;
    const songs = artistSongs([album("a1", "Hybrid Theory"), album("a2", "Meteora"), album("a3", "Empty")], new Map([
      ["a2", [track("t3", "a2")]],
      ["a1", [track("t1", "a1"), track("t2", "a1")]],
    ]));
    log("songs", songs.map((song) => [song.id, song.albumTitle, song.coverObjectKey]));
    expect(songs.map((song) => [song.id, song.albumTitle, song.coverObjectKey, song.coverThumbObjectKey])).toEqual([
      ["t1", "Hybrid Theory", "cover-a1", "thumb-a1"],
      ["t2", "Hybrid Theory", "cover-a1", "thumb-a1"],
      ["t3", "Meteora", "cover-a2", "thumb-a2"],
    ]);
  });
});

describe("@req PAR-TV-03[parrot-tv] @req PAR-TV-13[parrot-tv] cards, grid and Settings", () => {
  it("an album card's second line is artist · year, the unknown artist named", () => {
    expect(tvAlbumCaption({ artistName: "Linkin Park", year: 2003 }, "Unknown artist")).toBe("Linkin Park · 2003");
    expect(tvAlbumCaption({ artistName: "", year: null }, "Unknown artist")).toBe("Unknown artist");
  });
  it("the Library and Playlists grids fit as many cards as the screen holds between its margins", () => {
    // 960 dp wide, 36 dp margins, 118 dp cards 19 dp apart: (960 - 72 + 19) / 137 = 6.6.
    expect(tvGridColumnsFor(960, 118, 19, 36)).toBe(6);
    expect(tvGridColumnsFor(1920, 236, 38, 72)).toBe(6);
    expect(tvGridColumnsFor(100, 118, 19, 36)).toBe(1);
  });
  it("Settings has Profiles, Account, Playback, Language and About, and Privacy only where error reports are offered; no pairing", () => {
    log("groups", { offered: tvSettingsGroupIds(true), notOffered: tvSettingsGroupIds(false) });
    expect(tvSettingsGroupIds(true)).toEqual(["profiles", "account", "playback", "privacy", "language", "about"]);
    expect(tvSettingsGroupIds(false)).toEqual(["profiles", "account", "playback", "language", "about"]);
  });
});

describe("@req PAR-TV-06[parrot-tv] the Search grid types the query", () => {
  it("has a to z then 0 to 9, six keys to a row", () => {
    expect(TV_SEARCH_CHARS.join("")).toBe("abcdefghijklmnopqrstuvwxyz1234567890");
    expect(TV_SEARCH_CHARS.length % 6).toBe(0);
  });
  it("adds letters, one space between words, and Delete takes off the last character", () => {
    const typed = [
      { kind: "space" },
      { kind: "char", char: "n" },
      { kind: "char", char: "u" },
      { kind: "space" },
      { kind: "space" },
      { kind: "char", char: "e" },
      { kind: "delete" },
    ] as const;
    const steps = typed.reduce<string[]>((acc, key) => [...acc, typeTvSearchKey(acc[acc.length - 1] ?? "", key)], []);
    log("search_keys", steps);
    expect(steps).toEqual(["", "n", "nu", "nu ", "nu ", "nu e", "nu "]);
    expect(typeTvSearchKey("", { kind: "delete" })).toBe("");
  });
});

describe("@req PAR-TV-12[parrot-tv] the TV stays awake only under Now playing and the lyrics", () => {
  it("Now playing and the lyrics keep it awake; the sections, pages under the bar, Up next and profiles do not", () => {
    const tops: Array<TvPage | null> = [
      null,
      { kind: "album", albumId: "a1" },
      { kind: "artist", artistId: "r1", name: "LP" },
      { kind: "nowPlaying" },
      { kind: "lyrics" },
      { kind: "queue" },
      { kind: "profiles", mode: "manage" },
    ];
    const awake = tops.map((top) => [top ? tvPageKey(top) : "section", tvPageKeepsAwake(top)]);
    log("keep awake", awake);
    expect(awake).toEqual([
      ["section", false],
      ["album:a1", false],
      ["artist:r1", false],
      ["nowPlaying", true],
      ["lyrics", true],
      ["queue", false],
      ["profiles:manage", false],
    ]);
  });
});
