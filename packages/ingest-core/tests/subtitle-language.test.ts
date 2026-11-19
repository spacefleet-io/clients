import { describe, expect, it } from "vitest";
import {
  detectSubtitleFileLanguage,
  detectSubtitleLanguage,
  detectSubtitleLanguageFromSamples,
} from "../src/subtitleLanguageDetection";

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

const srt = (lines: string[]) =>
  lines.map((line, i) => `${i + 1}\n00:00:${String(i * 3).padStart(2, "0")},000 --> 00:00:${String(i * 3 + 2).padStart(2, "0")},000\n${line}`).join("\n\n");

describe("the language of a whole subtitle file (an added file, PLAY-SUBGET-23)", () => {
  const english = [
    "Where did you find this little dragon?",
    "She was hurt and alone in the snow.",
    "I will take care of her until her wing is healed,",
    "and then she can fly home.",
    "The mountains are dangerous at this time of the year.",
    "You should stay here with us.",
    "I have been looking for her for a very long time,",
    "and I am not going to give up now.",
  ];

  // @req PLAY-SUBGET-23[badger-desktop,badger-web-player]
  it("reads an English SRT of short cues as English, which one reading of the whole text leaves undecided", async () => {
    const file = srt(english);
    expect(await detectSubtitleLanguage(file)).toBeNull();
    expect((await detectSubtitleFileLanguage(file))?.language).toBe("en");
  });

  // @req PLAY-SUBGET-23[badger-desktop,badger-web-player]
  it("reads WebVTT and ASS dialogue, not their headers or timings", async () => {
    const french = [
      "Où as-tu trouvé ce petit dragon ? Elle était blessée et seule dans la neige.",
      "Je vais prendre soin d'elle jusqu'à ce que son aile soit guérie, puis elle pourra rentrer.",
    ];
    const vtt = `WEBVTT\n\n${french.map((line, i) => `00:0${i}.000 --> 00:0${i + 1}.000\n${line}`).join("\n\n")}\n`;
    expect((await detectSubtitleFileLanguage(vtt))?.language).toBe("fr");
    const ass = [
      "[Script Info]",
      "Title: Default Aegisub file",
      "[V4+ Styles]",
      "Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1",
      "[Events]",
      ...english.map((line, i) => `Dialogue: 0,0:00:0${i}.00,0:00:0${i + 1}.00,Default,,0,0,0,,{\\i1}${line}{\\i0}`),
    ].join("\n");
    expect((await detectSubtitleFileLanguage(ass))?.language).toBe("en");
  });

  // @req PLAY-SUBGET-23[badger-desktop,badger-web-player]
  it("is null for a file with too little text to tell", async () => {
    expect(await detectSubtitleFileLanguage(srt(["Hi.", "Ok."]))).toBeNull();
  });
});
