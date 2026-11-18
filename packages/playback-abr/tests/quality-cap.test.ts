/**
 * @req PLAY-QUAL-07
 * @req STOR-BW-07
 *
 * While the silo is saturated a free account plays at 480p or under, Starter and Standard at 1080p or under. The pure
 * part every client shares: which rung to step to (or whether to stop), and the ceiling Auto may not climb back above.
 */
import { describe, expect, it } from "vitest";
import { capCeilingRank, capTarget } from "../src/qualityCap";
import { qualityRank, type Variant } from "../src/ladder";

const v = (quality: string, bitrateKbps: number | null = null, id = quality): Variant => ({
  id,
  quality,
  codec: "h264",
  bitrateKbps,
});
const LADDER = [v("2160p"), v("1080p"), v("720p"), v("480p"), v("360p"), v("240p")];

describe("480p cap (free account)", () => {
  it("steps a higher rung down to the best rung at or under 480p", () => {
    expect(capTarget(LADDER, "2160p", "480p")).toEqual({ kind: "switch", id: "480p" });
    expect(capTarget(LADDER, "720p", "480p")).toEqual({ kind: "switch", id: "480p" });
  });

  it("does nothing at or under 480p", () => {
    expect(capTarget(LADDER, "480p", "480p")).toBeNull();
    expect(capTarget(LADDER, "360p", "480p")).toBeNull();
  });

  it("takes the best rung under 480p when the ladder has no 480p", () => {
    expect(capTarget([v("1080p"), v("360p"), v("240p")], "1080p", "480p")).toEqual({ kind: "switch", id: "360p" });
  });

  it("stops when every rung is above 480p", () => {
    expect(capTarget([v("2160p"), v("1080p"), v("720p")], "2160p", "480p")).toEqual({ kind: "stop" });
    expect(capTarget([v("1080p")], "1080p", "480p")).toEqual({ kind: "stop" });
  });

  it("prefers the lighter of two rungs of the same quality", () => {
    const ladder = [v("1080p"), v("480p", 3000, "480-hevc"), v("480p", 1200, "480-h264")];
    expect(capTarget(ladder, "1080p", "480p")).toEqual({ kind: "switch", id: "480-h264" });
  });

  it("treats a current rung missing from the ladder as above the cap", () => {
    expect(capTarget(LADDER, "gone", "480p")).toEqual({ kind: "switch", id: "480p" });
  });
});

describe("1080p cap (Starter, Standard)", () => {
  it("steps a 2160p rung down to the best rung at or under 1080p", () => {
    expect(capTarget(LADDER, "2160p", "1080p")).toEqual({ kind: "switch", id: "1080p" });
    expect(capTarget([v("2160p"), v("720p"), v("480p")], "2160p", "1080p")).toEqual({ kind: "switch", id: "720p" });
  });

  it("does nothing at or under 1080p", () => {
    expect(capTarget(LADDER, "1080p", "1080p")).toBeNull();
    expect(capTarget(LADDER, "480p", "1080p")).toBeNull();
  });

  it("keeps playing when the ladder only has rungs above 1080p (a paying viewer is never stopped)", () => {
    expect(capTarget([v("2160p")], "2160p", "1080p")).toBeNull();
  });
});

describe("cap ceiling rank", () => {
  it("never lets Auto climb above the cap", () => {
    expect(capCeilingRank(qualityRank("2160p"), "480p")).toBe(qualityRank("480p"));
    expect(capCeilingRank(qualityRank("2160p"), "1080p")).toBe(qualityRank("1080p"));
    expect(capCeilingRank(qualityRank("1080p"), "480p")).toBe(qualityRank("480p"));
  });

  it("keeps a Settings ceiling that is already lower than the cap", () => {
    expect(capCeilingRank(qualityRank("360p"), "480p")).toBe(qualityRank("360p"));
    expect(capCeilingRank(qualityRank("720p"), "1080p")).toBe(qualityRank("720p"));
    expect(capCeilingRank(qualityRank("480p"), "480p")).toBe(qualityRank("480p"));
  });
});
