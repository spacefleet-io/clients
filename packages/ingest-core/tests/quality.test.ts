import { describe, expect, it } from "vitest";
import { pickReTranscodeSource, QUALITY_ORDER, defaultCodecForQuality } from "../src/quality";

const SUITE = "quality";

const dumpQualitySnapshot = (
  label: string,
  ctx: {
    target?: string;
    available?: ReadonlyArray<string>;
    qualityOrder?: ReadonlyArray<string>;
    actual?: unknown;
    expected?: unknown;
    snapshotBefore?: ReadonlyArray<string>;
    snapshotAfter?: ReadonlyArray<string>;
  },
) => {
  try {
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    if (ctx.target !== undefined) {
      console.error(`target quality: ${JSON.stringify(ctx.target)}`);
    }
    if (ctx.available !== undefined) {
      console.error(`available sources: ${JSON.stringify(ctx.available)}`);
    }
    if (ctx.qualityOrder !== undefined) {
      console.error(`QUALITY_ORDER snapshot: ${JSON.stringify(ctx.qualityOrder)}`);
    }
    if (ctx.actual !== undefined) {
      console.error(`actual selected: ${JSON.stringify(ctx.actual)}`);
    }
    if (ctx.expected !== undefined) {
      console.error(`expected selected: ${JSON.stringify(ctx.expected)}`);
    }
    if (ctx.snapshotBefore !== undefined) {
      console.error(`available before call: ${JSON.stringify(ctx.snapshotBefore)}`);
    }
    if (ctx.snapshotAfter !== undefined) {
      console.error(`available after call: ${JSON.stringify(ctx.snapshotAfter)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("defaultCodecForQuality", () => {
  it("returns hevc for 2160p and h264 for everything else", () => {
    console.info(`[${SUITE}:setup] checking defaultCodecForQuality across all QUALITY_ORDER tiers`);
    const cases: Array<{ q: Parameters<typeof defaultCodecForQuality>[0]; expected: string }> = [
      { q: "2160p", expected: "hevc" },
      { q: "1080p", expected: "h264" },
      { q: "720p", expected: "h264" },
      { q: "480p", expected: "h264" },
      { q: "360p", expected: "h264" },
      { q: "240p", expected: "h264" },
      { q: "144p", expected: "h264" },
    ];
    const results = cases.map((c) => ({ q: c.q, actual: defaultCodecForQuality(c.q), expected: c.expected }));
    console.info(`[${SUITE}:exec] codec mapping: ${JSON.stringify(results)}`);

    try {
      for (const r of results) {
        expect(r.actual).toBe(r.expected);
      }
    } catch (err) {
      dumpQualitySnapshot("codec-default-mismatch", {
        actual: results.filter((r) => r.actual !== r.expected),
        expected: cases,
      });
      throw err;
    }
  });
});

describe("pickReTranscodeSource", () => {
  it("picks the closest higher resolution above target (1080p, 360p available; target 240p → 360p)", () => {
    const target = "240p";
    const available: ReadonlyArray<typeof QUALITY_ORDER[number]> = ["1080p", "360p"];
    console.info(`[${SUITE}:exec] target=${target} available=${JSON.stringify(available)}`);
    const actual = pickReTranscodeSource(target, available as never);
    console.info(`[${SUITE}:exec] picked=${JSON.stringify(actual)} expected="360p"`);
    try {
      expect(actual).toBe("360p");
    } catch (err) {
      dumpQualitySnapshot("closest-higher", { target, available, actual, expected: "360p" });
      throw err;
    }
  });

  it("returns the only available higher resolution when there is just one ([1080p], target 720p → 1080p)", () => {
    const target = "720p";
    const available: ReadonlyArray<typeof QUALITY_ORDER[number]> = ["1080p"];
    console.info(`[${SUITE}:exec] target=${target} available=${JSON.stringify(available)}`);
    const actual = pickReTranscodeSource(target, available as never);
    console.info(`[${SUITE}:exec] picked=${JSON.stringify(actual)} expected="1080p"`);
    try {
      expect(actual).toBe("1080p");
    } catch (err) {
      dumpQualitySnapshot("only-higher", { target, available, actual, expected: "1080p" });
      throw err;
    }
  });

  it("returns the single available source when it is the next step up ([360p], target 240p → 360p)", () => {
    const target = "240p";
    const available: ReadonlyArray<typeof QUALITY_ORDER[number]> = ["360p"];
    console.info(`[${SUITE}:exec] target=${target} available=${JSON.stringify(available)}`);
    const actual = pickReTranscodeSource(target, available as never);
    console.info(`[${SUITE}:exec] picked=${JSON.stringify(actual)} expected="360p"`);
    try {
      expect(actual).toBe("360p");
    } catch (err) {
      dumpQualitySnapshot("single-next-step", { target, available, actual, expected: "360p" });
      throw err;
    }
  });

  it("returns null when no higher-resolution source exists ([240p], target 360p → null — UI must already hide 360p)", () => {
    const target = "360p";
    const available: ReadonlyArray<typeof QUALITY_ORDER[number]> = ["240p"];
    console.info(`[${SUITE}:exec] target=${target} available=${JSON.stringify(available)}`);
    const actual = pickReTranscodeSource(target, available as never);
    console.info(`[${SUITE}:exec] picked=${JSON.stringify(actual)} expected=null`);
    try {
      expect(actual).toBeNull();
    } catch (err) {
      dumpQualitySnapshot("no-higher-source", { target, available, actual, expected: null });
      throw err;
    }
  });

  it("returns null when target equals an existing format ([1080p, 720p], target 720p → null — UI must already hide 720p)", () => {
    const target = "720p";
    const available: ReadonlyArray<typeof QUALITY_ORDER[number]> = ["1080p", "720p"];
    console.info(`[${SUITE}:exec] target=${target} available=${JSON.stringify(available)}`);
    const actual = pickReTranscodeSource(target, available as never);
    console.info(`[${SUITE}:exec] picked=${JSON.stringify(actual)} expected=null`);
    try {
      expect(actual).toBeNull();
    } catch (err) {
      dumpQualitySnapshot("target-equals-existing", { target, available, actual, expected: null });
      throw err;
    }
  });

  it("prefers the smallest viable source when multiple higher resolutions are available", () => {
    const target = "360p";
    const available: ReadonlyArray<typeof QUALITY_ORDER[number]> = ["2160p", "1080p", "720p", "480p"];
    console.info(`[${SUITE}:exec] target=${target} available=${JSON.stringify(available)}`);
    const actual = pickReTranscodeSource(target, available as never);
    console.info(`[${SUITE}:exec] picked=${JSON.stringify(actual)} expected="480p"`);
    try {
      expect(actual).toBe("480p");
    } catch (err) {
      dumpQualitySnapshot("smallest-viable-multi", { target, available, actual, expected: "480p" });
      throw err;
    }
  });

  it("returns null when target is not in QUALITY_ORDER", () => {
    const target = "999p";
    const available: ReadonlyArray<typeof QUALITY_ORDER[number]> = ["1080p"];
    console.info(`[${SUITE}:exec] target=${target} (not in QUALITY_ORDER) available=${JSON.stringify(available)}`);
    const actual = pickReTranscodeSource(target as never, available as never);
    console.info(`[${SUITE}:exec] picked=${JSON.stringify(actual)} expected=null`);
    try {
      expect(actual).toBeNull();
    } catch (err) {
      dumpQualitySnapshot("target-not-in-order", { target, available, qualityOrder: QUALITY_ORDER, actual, expected: null });
      throw err;
    }
  });

  it("ignores entries in `available` that are not in QUALITY_ORDER", () => {
    const target = "240p";
    const available = ["bogus", "360p"];
    console.info(`[${SUITE}:exec] target=${target} available=${JSON.stringify(available)} (contains junk)`);
    const actual = pickReTranscodeSource(target, available as never);
    console.info(`[${SUITE}:exec] picked=${JSON.stringify(actual)} expected="360p"`);
    try {
      expect(actual).toBe("360p");
    } catch (err) {
      dumpQualitySnapshot("ignores-bogus-entries", { target, available, qualityOrder: QUALITY_ORDER, actual, expected: "360p" });
      throw err;
    }
  });

  it("returns null when `available` is empty", () => {
    const target = "720p";
    const available: ReadonlyArray<typeof QUALITY_ORDER[number]> = [];
    console.info(`[${SUITE}:exec] target=${target} available=[]`);
    const actual = pickReTranscodeSource(target, available as never);
    console.info(`[${SUITE}:exec] picked=${JSON.stringify(actual)} expected=null`);
    try {
      expect(actual).toBeNull();
    } catch (err) {
      dumpQualitySnapshot("empty-available", { target, available, actual, expected: null });
      throw err;
    }
  });

  it("returns null when target is the highest preset and nothing is higher", () => {
    const target = "2160p";
    const available: ReadonlyArray<typeof QUALITY_ORDER[number]> = ["1080p", "720p"];
    console.info(`[${SUITE}:exec] target=${target} (max preset) available=${JSON.stringify(available)}`);
    const actual = pickReTranscodeSource(target, available as never);
    console.info(`[${SUITE}:exec] picked=${JSON.stringify(actual)} expected=null`);
    try {
      expect(actual).toBeNull();
    } catch (err) {
      dumpQualitySnapshot("max-preset-no-higher", { target, available, qualityOrder: QUALITY_ORDER, actual, expected: null });
      throw err;
    }
  });

  it("does not mutate the input `available` array", () => {
    const available: typeof QUALITY_ORDER = ["480p", "1080p", "720p"];
    const snapshot = [...available];
    console.info(`[${SUITE}:exec] target=360p available-before=${JSON.stringify(snapshot)} (mutation check)`);
    pickReTranscodeSource("360p", available);
    console.info(`[${SUITE}:exec] available-after=${JSON.stringify(available)}`);
    try {
      expect(available).toEqual(snapshot);
    } catch (err) {
      dumpQualitySnapshot("mutation-check-failed", {
        target: "360p",
        snapshotBefore: snapshot,
        snapshotAfter: available,
      });
      throw err;
    }
  });

});
