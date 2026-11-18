import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SUITE = "media-processor-fallback-segment-source";

const dumpFallbackSnapshot = (
  label: string,
  ctx: {
    sourcePath?: string;
    pattern?: string;
    matches?: ReadonlyArray<string> | null;
    fallbackDecision?: string;
    candidateSources?: ReadonlyArray<string>;
    pickedSource?: string;
  },
) => {
  try {
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    if (ctx.sourcePath) {
      console.error(`mediaProcessor.ts path: ${ctx.sourcePath}`);
    }
    if (ctx.pattern) {
      console.error(`pattern: ${ctx.pattern}`);
    }
    if (ctx.matches !== undefined) {
      console.error(`matches in source: ${JSON.stringify(ctx.matches)}`);
    }
    if (ctx.fallbackDecision) {
      console.error(`fallback decision: ${ctx.fallbackDecision}`);
    }
    if (ctx.candidateSources) {
      console.error(`candidate sources: ${JSON.stringify(ctx.candidateSources)}`);
    }
    if (ctx.pickedSource) {
      console.error(`picked source: ${ctx.pickedSource}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

/**
 * @bugfix @regression-proof
 *
 * Round-12 #6: 360p fallback segment duration must match the source path.
 *
 * Pre-fix: `SEGMENT_SECONDS_FALLBACK = 4` while `SEGMENT_SECONDS_SOURCE = 12`.
 * That asymmetry caused 3x over-chunking for the same content — a 622 MB
 * 360p had 3,422 chunks at 180 KB each vs the source's 879 chunks at 4 MB.
 * Hurts seek performance + HTTP overhead per chunk + library DB row count.
 *
 * Post-fix: `SEGMENT_SECONDS_FALLBACK` is aliased to `SEGMENT_SECONDS_SOURCE`.
 * 12s remains a clean multiple of the 4s GOP cadence in the fallback transcode,
 * so keyframe-boundary segmentation contracts are preserved.
 */
describe("@bugfix @regression-proof Round-12 #6 — fallback segment duration aligned to source", () => {
  const sourcePath = resolve(process.cwd(), "src/mediaProcessor.ts");
  console.info(`[${SUITE}:setup] reading mediaProcessor.ts from ${sourcePath}`);
  const source = readFileSync(sourcePath, "utf8");
  console.info(`[${SUITE}:setup] source length=${source.length} bytes`);

  it("does not hardcode SEGMENT_SECONDS_FALLBACK = 4 (the over-chunking cause)", () => {
    const pattern = /SEGMENT_SECONDS_FALLBACK\s*=\s*4\b/;
    console.info(`[${SUITE}:exec] negative check — pattern=${String(pattern)}`);
    const matches = source.match(new RegExp(pattern.source, "g"));
    const fallbackDecision = matches && matches.length > 0
      ? "OVER-CHUNK risk: literal '4' still present"
      : "aligned: literal '4' absent";
    console.info(`[${SUITE}:exec] fallback decision: ${fallbackDecision} (match count=${matches?.length ?? 0})`);

    try {
      expect(source).not.toMatch(pattern);
    } catch (err) {
      dumpFallbackSnapshot("hardcoded-4-still-present", {
        sourcePath,
        pattern: String(pattern),
        matches,
        fallbackDecision,
        candidateSources: ["SEGMENT_SECONDS_SOURCE (12)", "literal 4 (rejected)"],
        pickedSource: "literal 4",
      });
      throw err;
    }
  });

  it("aliases SEGMENT_SECONDS_FALLBACK to SEGMENT_SECONDS_SOURCE", () => {
    const pattern = /SEGMENT_SECONDS_FALLBACK\s*=\s*SEGMENT_SECONDS_SOURCE/;
    console.info(`[${SUITE}:exec] positive check — pattern=${String(pattern)}`);
    const matches = source.match(new RegExp(pattern.source, "g"));
    const fallbackDecision = matches && matches.length > 0
      ? "aliased: FALLBACK = SOURCE"
      : "MISSING alias: fallback drifts from source";
    console.info(`[${SUITE}:exec] fallback decision: ${fallbackDecision} (match count=${matches?.length ?? 0})`);

    try {
      expect(source).toMatch(pattern);
    } catch (err) {
      dumpFallbackSnapshot("missing-alias-to-source", {
        sourcePath,
        pattern: String(pattern),
        matches,
        fallbackDecision,
        candidateSources: ["SEGMENT_SECONDS_SOURCE", "literal value"],
        pickedSource: "unknown (alias missing)",
      });
      throw err;
    }
  });
});
