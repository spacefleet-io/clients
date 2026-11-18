/**
 * The shared best-to-worst order places a version whose label is outside the standard ladder ("420p", "1440p") by its
 * height, so every client (web player, ABR, the mobile and TV quality menu) shows one order. A label with no height
 * ("source") still ranks below every known one.
 */
import { describe, expect, it } from "vitest";
import { qualityRank, sortVariantsBestToWorst } from "../src/ladder";

const v = (quality: string, codec: string | null = "h264") => ({ quality, codec });

describe("quality order of labels outside the ladder — @req UX-TV-07[badger-tv]", () => {
  it("ranks a non-standard height between its neighbours", () => {
    expect(qualityRank("480p")).toBeLessThan(qualityRank("420p"));
    expect(qualityRank("420p")).toBeLessThan(qualityRank("360p"));
    expect(qualityRank("1440p")).toBeLessThan(qualityRank("1080p"));
    expect(qualityRank("2160p")).toBeLessThan(qualityRank("1440p"));
  });

  it("keeps the standard ranks and puts a label without a height last", () => {
    expect(qualityRank("2160p")).toBe(0);
    expect(qualityRank("144p")).toBe(6);
    expect(qualityRank("source")).toBe(7);
  });

  it("sorts the library's upload order highest first", () => {
    const sorted = sortVariantsBestToWorst([v("720p"), v("420p"), v("360p"), v("2160p", "hevc"), v("144p"), v("1080p")]);
    expect(sorted.map((x) => x.quality)).toEqual(["2160p", "1080p", "720p", "420p", "360p", "144p"]);
  });
});
