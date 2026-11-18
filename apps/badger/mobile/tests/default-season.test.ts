import { describe, expect, it } from "vitest";
import { defaultSeason } from "../src/lib/defaultSeason";

const all = new Set([0, 1, 2, 3]);

// @bugfix @regression-proof: the movie page opened shows on season 0 (extras) when the catalog lists it first.
describe("defaultSeason", () => {
  it("opens on the season being resumed, even season 0", () => {
    expect(defaultSeason([0, 1, 2], 2, all)).toBe(2);
    expect(defaultSeason([0, 1, 2], 0, all)).toBe(0);
  });

  it("opens on season 1, not the extras season 0", () => {
    expect(defaultSeason([0, 1, 2], null, all)).toBe(1);
  });

  it("falls back to the lowest regular season, then to extras", () => {
    expect(defaultSeason([0, 3, 2], null, all)).toBe(2);
    expect(defaultSeason([0], null, all)).toBe(0);
    expect(defaultSeason([], null, all)).toBe(1);
  });

  it("@req UX-TV-08[badger-tv] opens on the first season with a file, before seasons the library has no file for", () => {
    console.info("[UX-TV-08] default season", JSON.stringify({ seasons: [0, 1, 2, 3], withFiles: [3] }));
    expect(defaultSeason([0, 1, 2, 3], null, new Set([3]))).toBe(3);
    expect(defaultSeason([0, 1, 2], null, new Set([0]))).toBe(0);
    expect(defaultSeason([0, 1, 2], null, new Set())).toBe(1);
  });
});
