import { describe, expect, it } from "vitest";
import {
  listOfflineQualityChoices,
  resolveOfflineQuality,
  type OfflineQualityFile,
} from "../src/offlineQualityChoice";

const log = (id: string, phase: string, data?: unknown) =>
  console.info(`[offline-quality-choice:${id}] ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const file = (fileId: string, options: Array<[string, number]>): OfflineQualityFile => ({
  fileId,
  options: options.map(([quality, bytes]) => ({ quality, bytes })),
});

// @req OFFL-QUAL-01
describe("listOfflineQualityChoices (OFFL-QUAL-01)", () => {
  it("lists every quality of one title with its size, highest first, and asks", () => {
    const files = [file("movie", [["720p", 700], ["1080p", 1500], ["2160p", 6000]])];
    log("single-title", "input", files);
    const got = listOfflineQualityChoices(files);
    log("single-title", "result", got);
    expect(got.prompt).toBe(true);
    expect(got.choices).toEqual([
      { quality: "2160p", totalBytes: 6000, fallbacks: [] },
      { quality: "1080p", totalBytes: 1500, fallbacks: [] },
      { quality: "720p", totalBytes: 700, fallbacks: [] },
    ]);
  });

  it("does not ask when the title has a single quality", () => {
    const files = [file("movie", [["1080p", 1500]])];
    const got = listOfflineQualityChoices(files);
    log("one-quality", "result", got);
    expect(got.prompt).toBe(false);
    expect(got.choices).toEqual([{ quality: "1080p", totalBytes: 1500, fallbacks: [] }]);
  });

  it("does not ask when every episode of a batch has a single quality, even different ones", () => {
    const files = [file("e1", [["1080p", 1000]]), file("e2", [["720p", 500]])];
    const got = listOfflineQualityChoices(files);
    log("batch-single-each", "result", got);
    expect(got.prompt).toBe(false);
    // The highest choice resolves every episode to its only quality.
    expect(got.choices[0]).toEqual({ quality: "1080p", totalBytes: 1500, fallbacks: [{ quality: "720p", count: 1 }] });
  });

  it("sums a season per quality and reports the nearest-lower fallback ('3 episodes only have 720p')", () => {
    const files = [
      file("e1", [["1080p", 1000], ["720p", 500]]),
      file("e2", [["720p", 500]]),
      file("e3", [["720p", 500]]),
      file("e4", [["720p", 500], ["480p", 200]]),
    ];
    log("season", "input", files);
    const got = listOfflineQualityChoices(files);
    log("season", "result", got);
    expect(got.prompt).toBe(true);
    expect(got.choices.map((c) => c.quality)).toEqual(["1080p", "720p", "480p"]);
    expect(got.choices[0]).toEqual({ quality: "1080p", totalBytes: 2500, fallbacks: [{ quality: "720p", count: 3 }] });
    expect(got.choices[1]).toEqual({ quality: "720p", totalBytes: 2000, fallbacks: [] });
    // 480p: e1-e3 have nothing lower, so they get their nearest higher quality.
    expect(got.choices[2]).toEqual({ quality: "480p", totalBytes: 1700, fallbacks: [{ quality: "720p", count: 3 }] });
  });

  it("compares labels by height (non-preset heights such as 420p), ignores unusable labels and duplicate heights", () => {
    const files = [file("m", [["420p", 300], ["original", 9999], ["420p", 999], ["1080p", 1200]])];
    const got = listOfflineQualityChoices(files);
    log("labels", "result", got);
    expect(got.choices).toEqual([
      { quality: "1080p", totalBytes: 1200, fallbacks: [] },
      { quality: "420p", totalBytes: 300, fallbacks: [] },
    ]);
  });

  it("returns no choices when nothing is usable", () => {
    const got = listOfflineQualityChoices([file("x", []), file("y", [["source", 10]])]);
    log("empty", "result", got);
    expect(got).toEqual({ choices: [], prompt: false });
  });
});

// @req OFFL-QUAL-01
describe("resolveOfflineQuality (OFFL-QUAL-01)", () => {
  it("takes the chosen quality, else the nearest lower, else the nearest higher", () => {
    const cases: Array<[string[], string, string | null]> = [
      [["2160p", "1080p", "720p"], "1080p", "1080p"],
      [["2160p", "720p", "480p"], "1080p", "720p"],
      [["2160p", "1440p"], "1080p", "1440p"],
      [["1080p"], "480p", "1080p"],
      [[], "1080p", null],
    ];
    for (const [available, chosen, want] of cases) {
      const got = resolveOfflineQuality(available, chosen);
      log("resolve", "case", { available, chosen, got, want });
      expect(got).toBe(want);
    }
  });
});
