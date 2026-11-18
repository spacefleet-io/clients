import { formatNowPlaying } from "@space/shared/nowPlaying";
import { describe, expect, it } from "vitest";
import { getNextPlayableEpisode, getPreviousPlayableEpisode } from "@space/shared/playableEpisodes";
import { formatEpisodeLabel, selectMarkersForPlayback } from "../src/lib/playback/nextEpisode";

const ep = (id: string, s: number, e: number) => ({ id, seasonNumber: s, episodeNumber: e, name: `Ep ${e}` }) as never;
const file = (id: string, season: number, episode: number) => ({ id, season, episode });
const media = {
  type: "tv",
  episodes: [ep("a", 1, 1), ep("b", 1, 2), ep("c", 2, 1), ep("d", 2, 2)],
  files: [file("fa", 1, 1), file("fb", 1, 2), file("fc", 2, 1), file("fd", 2, 2)],
  // "d" has a file but no playable audio -> not playable
  formats: ["fa", "fb", "fc", "fd"].map((fileId) => ({ fileId, initKey: "k", chunks: [{}] })),
  audioTracks: ["a", "b", "c"].map((episodeId) => ({ episodeId, initKey: "k", chunks: [{}] })),
} as never;

describe("next episode", () => {
  it("returns the next playable episode, crossing seasons and skipping files-less ones", () => {
    expect(getNextPlayableEpisode(media, "a")?.id).toBe("b");
    expect(getNextPlayableEpisode(media, "b")?.id).toBe("c");
    expect(getNextPlayableEpisode(media, "c")).toBeNull();
    expect(getNextPlayableEpisode(media, null)).toBeNull();
  });
  it("labels episodes", () => {
    expect(formatEpisodeLabel(ep("a", 1, 2))).toBe("S1E02 - Ep 2");
  });
});

// @req PLAY-OVL-03[badger-mobile,badger-tv]
describe("previous episode", () => {
  it("[PLAY-OVL-03] returns the previous playable episode, crossing seasons; none before the first playable one", () => {
    const picks = ["a", "b", "c", "d", null].map((id) => [id, getPreviousPlayableEpisode(media, id)?.id ?? null]);
    console.info("[PLAY-OVL-03] previous of", JSON.stringify(picks));
    expect(getPreviousPlayableEpisode(media, "b")?.id).toBe("a");
    expect(getPreviousPlayableEpisode(media, "c")?.id).toBe("b");
    // S1E1: no previous episode, so the player shows no previous button.
    expect(getPreviousPlayableEpisode(media, "a")).toBeNull();
    // "d" is not playable (no audio): it has no place in the playable order.
    expect(getPreviousPlayableEpisode(media, "d")).toBeNull();
    expect(getPreviousPlayableEpisode(media, null)).toBeNull();
  });

  it("[PLAY-OVL-03] skips an episode that is not uploaded", () => {
    const gappy = {
      ...(media as object),
      // S1E2 has no playable audio: previous of S2E1 is S1E1, next of S1E1 is S2E1.
      audioTracks: ["a", "c"].map((episodeId) => ({ episodeId, initKey: "k", chunks: [{}] })),
    } as never;
    console.info("[PLAY-OVL-03] gappy", getPreviousPlayableEpisode(gappy, "c")?.id, getNextPlayableEpisode(gappy, "a")?.id);
    expect(getPreviousPlayableEpisode(gappy, "c")?.id).toBe("a");
    expect(getNextPlayableEpisode(gappy, "a")?.id).toBe("c");
  });

  it("[PLAY-OVL-03] a movie has neither a previous nor a next episode", () => {
    const movie = { ...(media as object), type: "movie" } as never;
    expect(getPreviousPlayableEpisode(movie, "b")).toBeNull();
    expect(getNextPlayableEpisode(movie, "b")).toBeNull();
  });

  it("[PLAY-OVL-03] specials (season 0) stay out unless a special is playing: S1E1 has no previous even with S0E1 uploaded", () => {
    const withSpecials = {
      type: "tv",
      episodes: [ep("s1", 0, 1), ep("s2", 0, 2), ep("a", 1, 1), ep("b", 1, 2)],
      files: [file("fs1", 0, 1), file("fs2", 0, 2), file("fa", 1, 1), file("fb", 1, 2)],
      formats: ["fs1", "fs2", "fa", "fb"].map((fileId) => ({ fileId, initKey: "k", chunks: [{}] })),
      audioTracks: ["s1", "s2", "a", "b"].map((episodeId) => ({ episodeId, initKey: "k", chunks: [{}] })),
    } as never;
    const picks = ["s1", "s2", "a", "b"].map((id) => [id, getPreviousPlayableEpisode(withSpecials, id)?.id ?? null, getNextPlayableEpisode(withSpecials, id)?.id ?? null]);
    console.info("[PLAY-OVL-03] specials previous / next", JSON.stringify(picks));
    expect(getPreviousPlayableEpisode(withSpecials, "a")).toBeNull();
    expect(getPreviousPlayableEpisode(withSpecials, "b")?.id).toBe("a");
    // A special playing: its neighbours are the other uploaded specials (and the regular order after them, unchanged).
    expect(getPreviousPlayableEpisode(withSpecials, "s2")?.id).toBe("s1");
    expect(getPreviousPlayableEpisode(withSpecials, "s1")).toBeNull();
    // Next (shared with autoplay / up-next) is unchanged: never a special after a regular episode.
    expect(getNextPlayableEpisode(withSpecials, "b")).toBeNull();
    expect(getNextPlayableEpisode(withSpecials, "s2")?.id).toBe("a");
  });
});

// @req PLAY-OVL-01[badger-mobile,badger-tv]
describe("what's playing line", () => {
  const lodgers = { type: "tv", title: "Lodgers", year: "1994" } as never;
  it("[PLAY-OVL-01] an episode reads show · season and episode · episode name", () => {
    const line = formatNowPlaying(lodgers, { seasonNumber: 1, episodeNumber: 1, name: "The New Lodger" } as never);
    console.info("[PLAY-OVL-01] episode line", line);
    expect(line).toBe("Lodgers · S1 E1 · The New Lodger");
  });
  it("[PLAY-OVL-01] an episode without a name drops the name part", () => {
    expect(formatNowPlaying(lodgers, { seasonNumber: 2, episodeNumber: 10, name: "" } as never)).toBe("Lodgers · S2 E10");
    expect(formatNowPlaying(lodgers, { seasonNumber: 2, episodeNumber: 10, name: "  " } as never)).toBe("Lodgers · S2 E10");
  });
  it("[PLAY-OVL-01] a movie reads title (year), or the title alone without a year", () => {
    const movie = (year: string | null) => ({ type: "movie", title: "Slow Burn", year }) as never;
    const lines = [formatNowPlaying(movie("1995"), null), formatNowPlaying(movie("1995-12-15"), null), formatNowPlaying(movie(null), null), formatNowPlaying(movie(""), null)];
    console.info("[PLAY-OVL-01] movie lines", JSON.stringify(lines));
    expect(lines).toEqual(["Slow Burn (1995)", "Slow Burn (1995)", "Slow Burn", "Slow Burn"]);
  });
  it("[PLAY-OVL-01] nothing to say before the details are loaded", () => {
    expect(formatNowPlaying(null, null)).toBe("");
  });
});

describe("selectMarkersForPlayback", () => {
  const markers = [
    { type: "intro", startSeconds: 5, endSeconds: 60, episodeId: "a" },
    { type: "credits", startSeconds: 900, endSeconds: 960, episodeId: "a" },
    { type: "intro", startSeconds: 7, endSeconds: 40, episodeId: "b" },
    { type: "intro", startSeconds: 9, endSeconds: 9, episodeId: "a" },
    { type: "intro", startSeconds: 1, endSeconds: 20, episodeId: null },
  ] as never;
  it("scopes by episode, drops degenerate ranges and sorts", () => {
    expect(selectMarkersForPlayback(markers, "a").map((m) => m.type)).toEqual(["intro", "credits"]);
    expect(selectMarkersForPlayback(markers, null).map((m) => m.startSeconds)).toEqual([1]);
    expect(selectMarkersForPlayback(undefined, "a")).toEqual([]);
  });
});
