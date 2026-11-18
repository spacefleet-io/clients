/**
 * @test-id PARROT-MOBILE-NOW-PLAYING-001
 * @level unit
 * @req PAR-LOOK-01[parrot]
 * @why The approved design marks what plays: the album's tile (green ring, equaliser badge), the song in its album
 *   (green title, equaliser) and the player's "Playing from album" header. All of them read the queued song and its
 *   album from the player's state through `nowPlayingOf`; paused, the marks stay but stand still.
 */
import { describe, expect, it } from "vitest";
import { nowPlayingOf, type NowPlayingTitles } from "../src/lib/nowPlaying";

const titles = new Map<string, NowPlayingTitles>([["t2", { title: "Apogee", artist: "Juniper Skies", album: "Low Orbit", albumId: "al-lo" }]]);

describe("nowPlayingOf", () => {
  it("names the queued song's album, and says whether the music moves", () => {
    const playing = nowPlayingOf({ mediaId: "t2", playing: true }, titles);
    const paused = nowPlayingOf({ mediaId: "t2", playing: false }, titles);
    console.info("[PARROT-MOBILE-NOW-PLAYING-001] playing/paused", JSON.stringify({ playing, paused }));
    expect(playing).toEqual({ trackId: "t2", albumId: "al-lo", album: "Low Orbit", playing: true });
    expect(paused).toEqual({ trackId: "t2", albumId: "al-lo", album: "Low Orbit", playing: false });
  });

  it("is null with nothing queued, and has no album for a song Parrot did not queue", () => {
    expect(nowPlayingOf(null, titles)).toBeNull();
    expect(nowPlayingOf({ mediaId: null, playing: false }, titles)).toBeNull();
    expect(nowPlayingOf({ mediaId: "other", playing: true }, titles)).toEqual({ trackId: "other", albumId: null, album: null, playing: true });
  });
});
