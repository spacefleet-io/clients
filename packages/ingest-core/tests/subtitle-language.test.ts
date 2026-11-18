import { describe, expect, it } from "vitest";
import { detectSubtitleLanguage, detectSubtitleLanguageFromSamples } from "../src/subtitleLanguageDetection";

const SUITE = "subtitle-language";

const dumpSubtitleLangSnapshot = (
  label: string,
  ctx: {
    sourceLabel?: string;
    rawInput?: string | string[];
    sampleCount?: number;
    detected?: unknown;
    expectedLanguage?: string | null;
  },
) => {
  try {
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    if (ctx.sourceLabel) {
      console.error(`source label: ${ctx.sourceLabel}`);
    }
    if (ctx.sampleCount !== undefined) {
      console.error(`sample count: ${ctx.sampleCount}`);
    }
    if (ctx.rawInput !== undefined) {
      const preview = Array.isArray(ctx.rawInput)
        ? ctx.rawInput.map((s, i) => `[${i}] (len=${s.length}) ${s.slice(0, 120)}${s.length > 120 ? "..." : ""}`).join("\n")
        : `(len=${ctx.rawInput.length}) ${ctx.rawInput.slice(0, 240)}${ctx.rawInput.length > 240 ? "..." : ""}`;
      console.error(`raw input:\n${preview}`);
    }
    if (ctx.detected !== undefined) {
      console.error(`detected:\n${JSON.stringify(ctx.detected, null, 2)}`);
    }
    if (ctx.expectedLanguage !== undefined) {
      console.error(`expected language: ${JSON.stringify(ctx.expectedLanguage)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("subtitle language detection", () => {
  it("returns null for short/noisy samples", async () => {
    const input = "Hi";
    console.info(`[${SUITE}:setup] short-noise case: rawInput="${input}" expected=null`);

    console.info(`[${SUITE}:exec] calling detectSubtitleLanguage`);
    const detected = await detectSubtitleLanguage(input);
    console.info(`[${SUITE}:exec] detected=${JSON.stringify(detected)}`);

    try {
      expect(detected).toBeNull();
    } catch (err) {
      dumpSubtitleLangSnapshot("short-noise-not-null", {
        sourceLabel: "single short string ('Hi')",
        rawInput: input,
        detected,
        expectedLanguage: null,
      });
      throw err;
    }
  });

  it("detects english from realistic subtitle text", async () => {
    const sample = `
      1\n00:00:01,000 --> 00:00:03,000\nI can't do this anymore.\n
      2\n00:00:03,100 --> 00:00:07,500\nWe need to leave now, before it's too late.\n
      3\n00:00:08,000 --> 00:00:10,500\nPlease, trust me.\n    `;
    console.info(`[${SUITE}:setup] english-srt case: srt-style multi-cue sample, length=${sample.length}`);

    console.info(`[${SUITE}:exec] calling detectSubtitleLanguage`);
    const detected = await detectSubtitleLanguage(sample);
    console.info(`[${SUITE}:exec] detected=${JSON.stringify(detected)} expectedLanguage=en`);

    try {
      expect(detected?.language).toBe("en");
      expect((detected?.confidence ?? 0) > 0).toBe(true);
    } catch (err) {
      dumpSubtitleLangSnapshot("english-srt-mismatch", {
        sourceLabel: "english srt 3-cue sample",
        rawInput: sample,
        detected,
        expectedLanguage: "en",
      });
      throw err;
    }
  });

  it("aggregates multiple samples and keeps the strongest language", async () => {
    const samples = [
      "This is a long enough subtitle sentence to reliably detect English language content.",
      "Another subtitle line with vocabulary and syntax that should strongly look like English.",
      "Final line to increase confidence over a single fragment of text from subtitles.",
    ];
    console.info(`[${SUITE}:setup] aggregate-samples case: ${samples.length} long english samples`);

    console.info(`[${SUITE}:exec] calling detectSubtitleLanguageFromSamples`);
    const result = await detectSubtitleLanguageFromSamples(samples);
    console.info(`[${SUITE}:exec] result=${JSON.stringify(result)} expectedLanguage=en`);

    try {
      expect(result?.language).toBe("en");
    } catch (err) {
      dumpSubtitleLangSnapshot("aggregate-samples-mismatch", {
        sourceLabel: "3 long english samples (aggregation)",
        sampleCount: samples.length,
        rawInput: samples,
        detected: result,
        expectedLanguage: "en",
      });
      throw err;
    }
  });
});
