/**
 * @test-id PARROT-CORE-TITLECLEANUP-001
 * @level unit
 * @why PAR-META-23: the import review proposes four clean-ups of a file album's names (the album artist at the front,
 *      a video site's tail, an ending every song shares, "(Full Album)"), each undoable on its own, and never empties
 *      or touches a name the rule does not clearly fit.
 * @covers packages/parrot-core/src/titleCleanup.ts
 */
import { describe, expect, it } from "bun:test";
import { cleanParrotTitles, type ParrotTitleCleanupRule } from "../src/titleCleanup";

const run = (artist: string, album: string, titles: string[], skipped: ParrotTitleCleanupRule[] = []) => cleanParrotTitles({ artist, album, titles }, new Set(skipped));

describe("cleanParrotTitles", () => {
  it("takes the album artist off the front, in any case, only before a spaced dash", () => {
    const out = run("Neon Pulse AI", "Midnight Synthetic", ["Neon Pulse AI - Chrome Horizon", "neon pulse ai \u2013 Wildfire", "Neon Pulse AI-Static", "Static Bloom"]);
    expect(out.titles).toEqual(["Chrome Horizon", "Wildfire", "Neon Pulse AI-Static", "Static Bloom"]);
    expect(out.applied).toEqual([{ rule: "artist-prefix", text: "Neon Pulse AI - ", count: 2 }]);
  });

  it("keeps a title that is only the artist and a dash, and an artist that is another word's start", () => {
    expect(run("Ane", "X", ["Ane - ", "Anemone - Bloom"]).applied).toEqual([]);
  });

  it("takes video tails off the end, several in a row, naming the commonest", () => {
    const out = run("A", "B", ["Chrome Horizon (Official Audio)", "Wildfire [Official Music Video] (Lyrics)", "Static (Official Audio)", "Live (Live)", "(Official Video)"]);
    expect(out.titles).toEqual(["Chrome Horizon", "Wildfire", "Static", "Live (Live)", "(Official Video)"]);
    expect(out.applied).toEqual([{ rule: "video-tail", text: "(Official Audio)", count: 3 }]);
  });

  it.each(["(Official Video)", "(official lyric video)", "[Lyric Video]", "(Visualizer)", "(Visualiser)", "(Audio)", "(Lyrics)", "[Official Audio]"])("knows %p", (tail) => {
    expect(run("A", "B", [`Song ${tail}`]).titles).toEqual(["Song"]);
  });

  it("takes off the longest ending every song shares, starting at a separator", () => {
    const out = run("A", "B", ["Rain | lofi hip hop", "Snow - Calm | lofi hip hop", "Tea | lofi hip hop"]);
    expect(out.titles).toEqual(["Rain", "Snow - Calm", "Tea"]);
    expect(out.applied).toEqual([{ rule: "shared-suffix", text: "| lofi hip hop", count: 3 }]);
  });

  it("finds no shared ending on one song, on an ending one song lacks, or one that would empty a name", () => {
    expect(run("A", "B", ["Rain | lofi"]).applied).toEqual([]);
    expect(run("A", "B", ["Rain | lofi", "Snow"]).applied).toEqual([]);
    expect(run("A", "B", ["Rain (Live)", "Snow (Live)"]).applied).toEqual([]);
  });

  it("takes (Full Album) off the album name", () => {
    for (const album of ["Midnight Synthetic (Full Album)", "Midnight Synthetic [FULL ALBUM]", "Midnight Synthetic - Full Album"]) {
      const out = run("A", album, ["Song"]);
      expect(out.album).toBe("Midnight Synthetic");
      expect(out.applied).toEqual([{ rule: "full-album", text: album.slice("Midnight Synthetic".length).trim(), count: 0 }]);
    }
    expect(run("A", "(Full Album)", ["Song"]).album).toBe("(Full Album)");
  });

  it("runs every rule in order, and leaves out the undone ones", () => {
    const titles = ["Neon Pulse AI - Chrome Horizon (Official Audio) | synthwave", "Neon Pulse AI - Wildfire (Official Audio) | synthwave"];
    const all = run("Neon Pulse AI", "Midnight Synthetic (Full Album)", titles);
    expect(all.titles).toEqual(["Chrome Horizon", "Wildfire"]);
    expect(all.album).toBe("Midnight Synthetic");
    expect(all.applied.map((applied) => applied.rule)).toEqual(["artist-prefix", "shared-suffix", "video-tail", "full-album"]);
    const undone = run("Neon Pulse AI", "Midnight Synthetic (Full Album)", titles, ["artist-prefix", "full-album"]);
    expect(undone.titles).toEqual(["Neon Pulse AI - Chrome Horizon", "Neon Pulse AI - Wildfire"]);
    expect(undone.album).toBe("Midnight Synthetic (Full Album)");
  });

  it("leaves clean names alone", () => {
    expect(run("Daft Punk", "Discovery", ["One More Time", "Aerodynamic", "Digital Love"])).toEqual({ album: "Discovery", titles: ["One More Time", "Aerodynamic", "Digital Love"], applied: [] });
  });
});
