import { describe, expect, it } from "vitest";
import {
  buildSelectedVideoVariants,
  buildTrackSummary,
  normalizeFileIngestionLanguageCode,
  trackNeedsLanguageReview,
} from "../src/renderer/src/components/fileIngestionTracks";

// Dump-on-failure: surface the computed track summary / variant selection so a
// failing distinct-track or codec-selection assertion is diagnosable offline.
const dumpFileIngestionSnapshot = (label: string, value: unknown) => {
  try {
    console.error(`=== [file-ingestion-tracks:${label}] snapshot ===`);
    console.error(`computed value:\n${JSON.stringify(value, null, 2)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("fileIngestionTracks", () => {
  it("@bugfix @regression-proof normalizes common 3-letter subtitle/audio language codes", () => {
    const results = {
      eng: normalizeFileIngestionLanguageCode("eng"),
      jpn: normalizeFileIngestionLanguageCode("jpn"),
      empty: normalizeFileIngestionLanguageCode(""),
    };
    console.info(`[file-ingestion-tracks:normalize] codes=${JSON.stringify(results)}`);
    try {
      expect(normalizeFileIngestionLanguageCode("eng")).toBe("en");
      expect(normalizeFileIngestionLanguageCode("jpn")).toBe("ja");
      expect(normalizeFileIngestionLanguageCode("")).toBe("und");
    } catch (err) {
      dumpFileIngestionSnapshot("normalize", results);
      throw err;
    }
  });

  it("@bugfix @regression-proof keeps undefined-label tracks distinct so unresolved review rows do not collapse together", () => {
    console.info(`[file-ingestion-tracks:distinct-undefined] building summary for two und/undefined tracks`);
    const summary = buildTrackSummary(
      [
        {
          id: "video-1",
          kind: "video" as const,
          probe: {
            video: { codec: "h264", width: 1920, height: 1080 },
            chapters: { count: 0 },
            audioTracks: [
              { index: 0, language: "und", label: "undefined", codec: "aac", channels: 2 },
            ],
            subtitleTracks: [],
          },
        },
        {
          id: "video-2",
          kind: "video" as const,
          probe: {
            video: { codec: "h264", width: 1920, height: 1080 },
            chapters: { count: 0 },
            audioTracks: [
              { index: 0, language: "und", label: "undefined", codec: "aac", channels: 2 },
            ],
            subtitleTracks: [],
          },
        },
      ],
      (code) => code ?? "und"
    );
    console.info(
      `[file-ingestion-tracks:distinct-undefined] audioTracks.length=${summary.audioTracks.length} refs=[${summary.audioTracks.map((t) => t?.refs?.length).join(",")}]`,
    );

    try {
      expect(summary.audioTracks).toHaveLength(2);
      expect(summary.audioTracks[0]?.refs).toHaveLength(1);
      expect(summary.audioTracks[1]?.refs).toHaveLength(1);
    } catch (err) {
      dumpFileIngestionSnapshot("distinct-undefined", summary);
      throw err;
    }
  });

  it("@bugfix @regression-proof keeps one preferred codec per quality unless advanced codec selection is enabled", () => {
    console.info(`[file-ingestion-tracks:codec-selection] selecting variants with/without advanced codec selection`);
    const variants = [
      { candidate: "a", quality: "1080p", codec: "h264", hasChapters: false },
      { candidate: "b", quality: "1080p", codec: "hevc", hasChapters: false },
      { candidate: "c", quality: "360p", codec: "h264", hasChapters: false },
      { candidate: "d", quality: "360p", codec: "hevc", hasChapters: false },
    ];

    const selectedDefault = buildSelectedVideoVariants(variants, false).map((item) => item.candidate);
    const selectedAdvanced = buildSelectedVideoVariants(variants, true).map((item) => item.candidate);
    console.info(
      `[file-ingestion-tracks:codec-selection] default=${JSON.stringify(selectedDefault)} advanced=${JSON.stringify(selectedAdvanced)}`,
    );
    try {
      expect(selectedDefault).toEqual(["b", "d"]);
      expect(selectedAdvanced).toEqual(["a", "b", "c", "d"]);
    } catch (err) {
      dumpFileIngestionSnapshot("codec-selection", { selectedDefault, selectedAdvanced, variants });
      throw err;
    }
  });

  it("requires review only when the label is undefined-like and the language is still und", () => {
    const results = {
      undUndefined: trackNeedsLanguageReview({ language: "und", label: "undefined" }),
      enUndefined: trackNeedsLanguageReview({ language: "en", label: "undefined" }),
      undNamed: trackNeedsLanguageReview({ language: "und", label: "Director commentary" }),
    };
    console.info(`[file-ingestion-tracks:needs-review] results=${JSON.stringify(results)}`);
    try {
      expect(trackNeedsLanguageReview({ language: "und", label: "undefined" })).toBe(true);
      expect(trackNeedsLanguageReview({ language: "en", label: "undefined" })).toBe(false);
      expect(trackNeedsLanguageReview({ language: "und", label: "Director commentary" })).toBe(false);
    } catch (err) {
      dumpFileIngestionSnapshot("needs-review", results);
      throw err;
    }
  });
});
