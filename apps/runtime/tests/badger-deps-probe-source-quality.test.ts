/**
 * @bugfix @regression-proof
 *
 * The probe step labelled a 1920×960 (2:1 scope) source `sourceQuality: "720p"`: it ranked height alone, while the
 * encode (mediaProcessor) stamps the source row with the width-aware `guessQualityLabel` → "1080p". Found in the
 * ingest audit of Chris's Ted Lasso / Silo import (2026-11-20). The probe now uses the same label as the encode.
 */
import { describe, expect, it, vi } from "vitest";
import type * as MediaProcessor from "@space/ingest-core/mediaProcessor";

const SUITE = "badger-deps-probe-source-quality";

const h = vi.hoisted(() => ({ streams: [] as Array<Record<string, unknown>> }));

vi.mock("@space/ingest-core/mediaProcessor", async (importOriginal) => ({
  ...(await importOriginal<typeof MediaProcessor>()),
  probeMediaFile: vi.fn(async () => ({ streams: h.streams, data: { format: { duration: "3108.8" }, chapters: [] } })),
}));

// Static import is impossible here: the module must load after vi.mock replaces probeMediaFile.
const { buildBadgerStepDeps } = await import("../src/modules/badger/steps/deps-adapter");

const probeFor = async (width: number | null, height: number | null) => {
  h.streams = [
    { codec_type: "video", codec_name: "h264", width, height },
    { codec_type: "audio", codec_name: "eac3", tags: { language: "eng" } },
  ];
  const deps = buildBadgerStepDeps({
    libraryDb: {} as never,
    processMediaJob: vi.fn() as never,
    resolveToken: () => "tok",
    resolveLibraryKey: () => "lk",
  });
  const result = await deps.probe("/tmp/Silo - S03E01.mkv", new AbortController().signal);
  console.info(`[${SUITE}:probe] ${width}x${height} → sourceQuality=${result.sourceQuality}`);
  return result;
};

describe("probe sourceQuality matches the encode's width-aware label", () => {
  it.each([
    [1920, 960, "1080p"], // the audited scope WEB-DL
    [1920, 800, "1080p"], // 2.40:1
    [1920, 1080, "1080p"],
    [1280, 720, "720p"],
    [3840, 1600, "2160p"],
    [3840, 2160, "2160p"],
    [720, 576, "480p"],
    [640, 360, "360p"],
  ])("%ix%i → %s", async (width, height, expected) => {
    const result = await probeFor(width, height);
    if (result.sourceQuality !== expected) {
      console.error(`[${SUITE}:mismatch] ${JSON.stringify({ width, height, expected, result }, null, 2)}`);
    }
    expect(result.sourceQuality).toBe(expected);
    expect(result.videoHeight).toBe(height);
  });

  it("no video height → null", async () => {
    expect((await probeFor(null, null)).sourceQuality).toBeNull();
    expect((await probeFor(1920, 0)).sourceQuality).toBeNull();
  });
});
