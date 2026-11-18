import { describe, expect, it } from "vitest";
import { hevcVerdicts, pickPlayVersion, versionChips, versionLabel } from "../src/versions";

// A title with two versions: the 4K HEVC source and its 1080p H.264 copy.
const versions = [
  { id: "f-1080", quality: "1080p", codec: "h264", bitrateKbps: 6000 },
  { id: "f-2160", quality: "2160p", codec: "hevc", bitrateKbps: 18000 },
];

// @req LIB-DETAIL-02
describe("[detail-versions] chips and Play's version", () => {
  it("labels every version as a chip, best first", () => {
    const chips = versionChips(versions);
    console.info("[detail-versions] chips", chips);
    expect(chips).toEqual([
      { id: "f-2160", label: "4K · HEVC" },
      { id: "f-1080", label: "1080p · H.264" },
    ]);
    expect(versionLabel({ quality: "720p", codec: "av1" })).toBe("720p · AV1");
    expect(versionLabel({ quality: "480p", codec: null })).toBe("480p");
  });

  it("shows one chip per distinct version (two cuts with the same ladder)", () => {
    const chips = versionChips([...versions, { id: "cut2-1080", quality: "1080p", codec: "h264" }]);
    expect(chips.map((chip) => chip.label)).toEqual(["4K · HEVC", "1080p · H.264"]);
  });

  it("desktop (no decoder caps): Play starts on the Settings quality, the best when Settings ask 4K", () => {
    const best = pickPlayVersion(versions, { quality: "2160p", force: false });
    const capped = pickPlayVersion(versions, { quality: "1080p", force: false });
    console.info("[detail-versions] desktop", { best: best?.id, capped: capped?.id });
    expect(best?.id).toBe("f-2160");
    expect(capped?.id).toBe("f-1080");
  });

  it("browser without HEVC: Play starts on the best version it can decode", () => {
    const pick = pickPlayVersion(versions, { quality: "2160p", force: false }, hevcVerdicts(versions, false), "any");
    console.info("[detail-versions] web no-hevc", pick?.id);
    expect(pick?.id).toBe("f-1080");
  });

  it("browser with HEVC: Play starts on the 4K HEVC version", () => {
    const pick = pickPlayVersion(versions, { quality: "2160p", force: false }, hevcVerdicts(versions, true), "any");
    expect(pick?.id).toBe("f-2160");
  });

  it("HEVC-only title in a browser without HEVC: nothing plays here (the desktop player is offered)", () => {
    const only = [versions[1]!];
    expect(pickPlayVersion(only, { quality: "2160p", force: false }, hevcVerdicts(only, false), "any")).toBeNull();
    expect(pickPlayVersion([], { quality: "2160p", force: false })).toBeNull();
  });
});
