/**
 * @test-id PARROT-CORE-HISTORY-001
 * @level unit
 * @why Home's "Jump back in", "Recently played" and "Your artists" come from this device's listening history
 *   (PAR-HOME-01, PAR-HOME-02). A slip resumes the wrong song, at the wrong place, or loses the history on bad data.
 * @covers packages/parrot-core/src/history.ts
 */
import { describe, expect, it } from "bun:test";
import { artistsByPlays, emptyHistory, HISTORY_ALBUM_LIMIT, homeAlbumDetail, homeAlbumStart, homeJumpButton, homeView, parseHistory, recentAlbums, recordPlay, recordPosition } from "../src/history";

const song = (id: string, albumId: string, artistId = "art-1") => ({ id, albumId, artistId });

describe("listening history", () => {
  // @req PAR-HOME-01
  it("writes the card's line as artist · year · N songs on every surface, leaving out what is missing", () => {
    const line = homeAlbumDetail({ artistName: "Linnet Park", year: 2003 }, "Unknown artist", "13 songs");
    console.info("[PARROT-CORE-HISTORY-001] detail", line);
    expect(line).toBe("Linnet Park · 2003 · 13 songs");
    expect(homeAlbumDetail({ artistName: "", year: null }, "Unknown artist", "1 song")).toBe("Unknown artist · 1 song");
  });

  // @req PAR-HOME-01
  it("puts the last album played first, once, and remembers the song and how far it got", () => {
    let history = recordPlay(emptyHistory(), song("t1", "alb-1"), 1);
    history = recordPlay(history, song("t9", "alb-2", "art-2"), 2);
    history = recordPlay(history, song("t2", "alb-1"), 3);
    history = recordPosition(history, song("t2", "alb-1"), 78_400.7);
    expect(history.albums.map((entry) => [entry.albumId, entry.trackId, entry.positionMs])).toEqual([
      ["alb-1", "t2", 78_400],
      ["alb-2", "t9", 0],
    ]);
    expect(history.artistPlays).toEqual({ "art-1": 2, "art-2": 1 });
    // A position for an album not in the history changes nothing.
    expect(recordPosition(history, song("t5", "alb-9"), 10)).toBe(history);
  });

  // @req PAR-HOME-01
  it("keeps a bounded list and drops albums no longer in the library", () => {
    let history = emptyHistory();
    for (let i = 0; i < HISTORY_ALBUM_LIMIT + 5; i += 1) history = recordPlay(history, song(`t${i}`, `alb-${i}`), i);
    expect(history.albums).toHaveLength(HISTORY_ALBUM_LIMIT);
    const rows = recentAlbums(history, [{ id: "alb-3" }, { id: `alb-${HISTORY_ALBUM_LIMIT + 4}` }]);
    expect(rows.map((row) => row.album.id)).toEqual([`alb-${HISTORY_ALBUM_LIMIT + 4}`]);
  });

  // @req PAR-HOME-01
  it("orders artists by plays on this device, then by name", () => {
    const history = recordPlay(recordPlay(emptyHistory(), song("t1", "a", "zed"), 1), song("t2", "a", "zed"), 2);
    const artists = [{ id: "bee", name: "Bee" }, { id: "alba", name: "ALBA" }, { id: "zed", name: "Zed" }];
    expect(artistsByPlays(history, artists).map((artist) => artist.id)).toEqual(["zed", "alba", "bee"]);
  });

  // @req PAR-HOME-02
  it("reads back what it wrote and starts empty on missing or broken data", () => {
    const history = recordPlay(emptyHistory(), song("t1", "alb-1"), 5);
    expect(parseHistory(JSON.stringify(history))).toEqual(history);
    expect(parseHistory(null)).toEqual(emptyHistory());
    expect(parseHistory("{not json")).toEqual(emptyHistory());
    expect(parseHistory(JSON.stringify({ version: 7, albums: "x" }))).toEqual(emptyHistory());
  });
});

describe("homeView", () => {
  const albums = [{ id: "a1" }, { id: "a2" }];
  const artists = [{ id: "r1", name: "One" }, { id: "r2", name: "Two" }];
  const tracks = [{ id: "t1" }, { id: "t2" }];

  // @req PAR-HOME-01
  it("offers the library's first album when nothing was played", () => {
    const view = homeView(emptyHistory(), albums, artists, tracks);
    expect(view.jump).toEqual({ album: albums[0], entry: null });
    expect(view.played).toBe(false);
    expect(view.albums).toEqual(albums);
  });

  // @req PAR-HOME-01
  it("resumes the last album played with its song", () => {
    const history = recordPosition(recordPlay(emptyHistory(), { id: "t2", albumId: "a2", artistId: "r2" }, 1), { id: "t2", albumId: "a2" }, 78_000);
    const view = homeView(history, albums, artists, tracks);
    expect(view.jump?.album).toEqual(albums[1]);
    expect(view.jump?.entry?.positionMs).toBe(78_000);
    expect(view.jumpTrack).toEqual(tracks[1]);
    expect(view.played).toBe(true);
    expect(view.albums).toEqual([albums[1]]);
    expect(view.artists[0]).toEqual(artists[1]);
  });
});

// @bugfix @regression-proof: Home's Play on the phone started Shoreline at its 2nd song. The phone took the album's
// songs from the library-wide Songs list, which is in title order, so "Driftwood" (track 2) came first.
describe("homeAlbumStart", () => {
  // Shoreline's songs in title order, as the phone's Songs view lists them.
  const byTitle = [
    { id: "s2", albumId: "shore", disc: 1, number: 2, title: "Driftwood" },
    { id: "x1", albumId: "orbit", disc: 1, number: 1, title: "Low Orbit" },
    { id: "s3", albumId: "shore", disc: 1, number: 3, title: "Salt Glass" },
    { id: "s1", albumId: "shore", disc: 1, number: 1, title: "Shoreline" },
  ];

  // @req PAR-HOME-01
  it("plays the album from its first song when nothing was played", () => {
    const start = homeAlbumStart(byTitle, "shore", null, false);
    console.info("[homeAlbumStart] fresh play", start);
    expect(start.tracks.map((track) => track.id)).toEqual(["s1", "s2", "s3"]);
    expect(start.index).toBe(0);
    expect(start.startMs).toBe(0);
  });

  // @req PAR-HOME-01
  it("resumes the song and position the history names, in album order", () => {
    const entry = { albumId: "shore", trackId: "s3", positionMs: 78_000, playedAt: 1 };
    const start = homeAlbumStart(byTitle, "shore", entry, false);
    console.info("[homeAlbumStart] resume", start);
    expect(start.tracks[start.index]?.id).toBe("s3");
    expect(start.index).toBe(2);
    expect(start.startMs).toBe(78_000);
  });

  // @req PAR-HOME-01
  it("starts from the first song when the remembered one left the library, and shuffles from a random one", () => {
    const gone = { albumId: "shore", trackId: "nope", positionMs: 5_000, playedAt: 1 };
    expect(homeAlbumStart(byTitle, "shore", gone, false)).toMatchObject({ index: 0, startMs: 0 });
    const shuffled = homeAlbumStart(byTitle, "shore", gone, true, () => 0.99);
    console.info("[homeAlbumStart] shuffle", shuffled);
    expect(shuffled).toMatchObject({ index: 2, startMs: 0 });
    expect(homeAlbumStart(byTitle, "none", null, false).tracks).toEqual([]);
  });
});

describe("homeJumpButton", () => {
  const entry = { albumId: "meltway", trackId: "fable", positionMs: 20_000, playedAt: 1 };

  // @req PAR-HOME-01
  // @bugfix @regression-proof Chris 2026-11-16: the card said "Resume 0:20" while Meltway was playing.
  it("follows the player while the card's album is queued: Pause while it plays, Resume at the live place once paused", () => {
    const playingNow = homeJumpButton("meltway", entry, { albumId: "meltway", trackId: "nook", positionMs: 95_000, playing: true });
    const pausedNow = homeJumpButton("meltway", entry, { albumId: "meltway", trackId: "nook", positionMs: 95_000, playing: false });
    console.info("[homeJumpButton] live", { playingNow, pausedNow });
    expect(playingNow).toEqual({ kind: "pause", trackId: "nook", positionMs: 95_000, live: true });
    expect(pausedNow).toEqual({ kind: "resume", trackId: "nook", positionMs: 95_000, live: true });
    expect(homeJumpButton("meltway", entry, { albumId: "meltway", trackId: "nook", positionMs: 0, playing: false })).toMatchObject({ kind: "play", live: true });
  });

  // @req PAR-HOME-01
  it("starts from the history when nothing or another album is queued: Resume at the saved place, else Play", () => {
    const stopped = homeJumpButton("meltway", entry, null);
    const other = homeJumpButton("meltway", entry, { albumId: "hybrid", trackId: "end", positionMs: 5_000, playing: true });
    console.info("[homeJumpButton] history", { stopped, other });
    expect(stopped).toEqual({ kind: "resume", trackId: "fable", positionMs: 20_000, live: false });
    expect(other).toEqual(stopped);
    expect(homeJumpButton("meltway", null, null)).toEqual({ kind: "play", trackId: null, positionMs: 0, live: false });
  });
});
