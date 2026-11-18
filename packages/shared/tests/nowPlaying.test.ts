// @req MPV-OSC-04
import { describe, expect, it } from "vitest";
import { formatNowPlayingParts } from "../src/nowPlaying";

const film = { type: "movie", title: "Metropolis", year: "1927-01-10" } as const;
const show = { type: "series", title: "Sample series", year: "2023" } as const;
const ep = { seasonNumber: 1, episodeNumber: 3, name: "The Signal", airDate: "2024-03-01" };

describe("formatNowPlayingParts (MPV-OSC-04)", () => {
  it("film: title, then the year", () => {
    expect(formatNowPlayingParts(film as never, null)).toEqual({ title: "Metropolis", meta: "1927" });
  });
  it("episode: season, episode, name and air year", () => {
    expect(formatNowPlayingParts(show as never, ep)).toEqual({ title: "Sample series", meta: "S1 · E3 “The Signal” · 2024" });
  });
  it("episode without name or air date falls back to the show year", () => {
    expect(formatNowPlayingParts(show as never, { ...ep, name: " ", airDate: null }).meta).toBe("S1 · E3 · 2023");
  });
  it("nothing known yet", () => {
    expect(formatNowPlayingParts(null, null)).toEqual({ title: "", meta: "" });
  });
});
