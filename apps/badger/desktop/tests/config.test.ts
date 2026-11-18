import { describe, expect, it } from "vitest";
import { coerceClientConfig, defaultClientConfig } from "../src/renderer/src/lib/config";

// Dump-on-failure: surface the coerced config so a normalization mismatch is
// diagnosable without rerun. Wrapped in try/catch so a dump failure can never
// mask the real assertion.
const dumpConfigSnapshot = (label: string, coerced: unknown, input?: unknown) => {
  try {
    console.error(`=== [config:${label}] snapshot ===`);
    if (input !== undefined) console.error(`input:\n${JSON.stringify(input, null, 2)}`);
    console.error(`coerced:\n${JSON.stringify(coerced, null, 2)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("desktop client config coercion", () => {
  it("falls back to defaults for non-object values", () => {
    console.info(`[config:non-object] coercing null + undefined`);
    const fromNull = coerceClientConfig(null);
    const fromUndefined = coerceClientConfig(undefined);
    console.info(`[config:non-object] nullIsDefault=${fromNull === defaultClientConfig} undefinedIsDefault=${fromUndefined === defaultClientConfig}`);
    if (fromNull !== defaultClientConfig || fromUndefined !== defaultClientConfig) {
      dumpConfigSnapshot("non-object", { fromNull, fromUndefined });
    }
    expect(coerceClientConfig(null)).toBe(defaultClientConfig);
    expect(coerceClientConfig(undefined)).toBe(defaultClientConfig);
  });

  it("normalizes legacy output codec and quality fields", () => {
    console.info(`[config:legacy-codecs] coercing legacy quality/codec/theme input`);
    const coerced = coerceClientConfig({
      playbackQuality: "invalid",
      preferredQuality: "720p",
      transcodeOutputs: [{ quality: "1080p", codec: "both" }],
      maxParallelTranscodes: 7,
      trailerLanguages: { extras: ["fr", "", "es"] },
      enableCodecSelection: true,
      uiTheme: "github",
    });

    console.info(
      `[config:legacy-codecs] playbackQuality=${coerced.playbackQuality} maxParallelTranscodes=${coerced.maxParallelTranscodes} transcodeOutputs=${JSON.stringify(coerced.transcodeOutputs)} extras=${JSON.stringify(coerced.trailerLanguages.extras)} uiTheme=${coerced.uiTheme}`,
    );
    try {
      expect(coerced.playbackQuality).toBe("720p");
      expect(coerced.maxParallelTranscodes).toBe(3);
      expect(coerced.transcodeOutputs).toEqual([
        { quality: "1080p", codec: "h264" },
        { quality: "1080p", codec: "hevc" },
      ]);
      expect(coerced.trailerLanguages.extras).toEqual(["fr", "es"]);
      // Product choice currently hard-pins space theme.
      expect(coerced.uiTheme).toBe("space");
    } catch (err) {
      dumpConfigSnapshot("legacy-codecs", coerced);
      throw err;
    }
  });

  // @bugfix @regression-proof: library view/sort is per device (localStorage), never part of the synced client config.
  it("@bugfix @regression-proof keeps the library view out of the synced client config", () => {
    expect(defaultClientConfig).not.toHaveProperty("libraryView");
    expect(coerceClientConfig({})).not.toHaveProperty("libraryView");
  });
});
