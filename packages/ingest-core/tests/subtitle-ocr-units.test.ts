import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ocrPictureSubtitleFile, SubtitleOcrLanguageExcludedError } from "../src/subtitleOcr";
import { resolveTesseractLanguage } from "../src/subtitleOcr/languages";
import { encodePgm, OCR_PADDING_PX, pictureToOcrImage } from "../src/subtitleOcr/preprocess";
import { resolveSubtitleOcrLauncher } from "../src/subtitleOcr/process";
import { buildSrt, formatSrtTimestamp } from "../src/subtitleOcr/srt";
import type { SubtitlePicture } from "../src/subtitleOcr/types";

const SUITE = "subtitle-ocr-units";

describe("resolveTesseractLanguage", () => {
  it.each([
    ["eng", null, "eng"],
    ["en", null, "eng"],
    ["en-US", null, "eng"],
    ["fre", null, "fra"],
    ["fra", null, "fra"],
    ["fr", null, "fra"],
    ["ger", null, "deu"],
    ["deu", null, "deu"],
    ["de", null, "deu"],
    ["spa", null, "spa"],
    ["es-419", null, "spa"],
    ["dut", null, "nld"],
    ["nl", null, "nld"],
    ["por", null, "por"],
    ["pt-BR", null, "por"],
    ["dan", null, "dan"],
    ["fin", null, "fin"],
    ["nob", null, "nor"],
    ["nno", null, "nor"],
    ["no", null, "nor"],
    ["swe", null, "swe"],
    ["ita", null, "ita"],
    ["pol", null, "pol"],
    ["cze", null, "ces"],
    ["ces", null, "ces"],
    ["hun", null, "hun"],
    ["rum", null, "ron"],
    ["ron", null, "ron"],
    ["rus", null, "rus"],
    ["ukr", null, "ukr"],
    ["gre", null, "ell"],
    ["ell", null, "ell"],
    ["tur", null, "tur"],
    ["heb", null, "heb"],
    ["ara", null, "ara"],
    ["hin", null, "hin"],
    ["tha", null, "tha"],
    ["vie", null, "vie"],
    ["ind", null, "ind"],
    ["may", null, "msa"],
    ["msa", null, "msa"],
    ["cat", null, "cat"],
    ["hrv", null, "hrv"],
    ["srp", null, "srp"],
    ["sr-Latn", null, "srp_latn"],
    ["slo", null, "slk"],
    ["slv", null, "slv"],
    ["bul", null, "bul"],
    ["est", null, "est"],
    ["lav", null, "lav"],
    ["lit", null, "lit"],
    ["ice", null, "isl"],
    ["isl", null, "isl"],
    ["French", null, "fra"],
    ["und", "Français", "fra"],
    ["geo", null, "kat"],
    ["ka", null, "kat"],
  ] as const)("%s (label %s) → %s", (language, label, code) => {
    expect(resolveTesseractLanguage(language, label)).toEqual({ status: "ocr", code, known: true });
  });

  it.each([[null], ["und"], [""], ["zxx"], ["qaa"]] as const)("unknown %s falls back to eng and says so", (language) => {
    expect(resolveTesseractLanguage(language, "Track 3")).toEqual({ status: "ocr", code: "eng", known: false });
  });

  it.each([
    ["chi", null],
    ["zho", "Chinese (Traditional)"],
    ["zh", null],
    ["zh-TW", null],
    ["zh-Hans", null],
    ["zh-CN", null],
    ["cmn", null],
    ["yue", null],
    ["chi_sim", null],
    ["chi_tra", null],
    ["jpn", null],
    ["ja", null],
    ["ja-JP", null],
    ["jpn_vert", null],
    ["kor", null],
    ["ko", null],
    ["ko-KR", null],
    ["Japanese", null],
    [null, "Chinese"],
    ["und", "Simplified Chinese"],
    [null, "简体中文"],
    ["und", "日本語"],
    [null, "한국어"],
    [null, "Korean (SDH)"],
  ] as const)("CJK %s (label %s) is excluded from OCR", (language, label) => {
    expect(resolveTesseractLanguage(language, label)).toEqual({ status: "excluded", reason: "cjk" });
  });

  it("a tagged non-CJK track stays OCR'd even when its label mentions a CJK language", () => {
    expect(resolveTesseractLanguage("eng", "English (Chinese songs)")).toEqual({ status: "ocr", code: "eng", known: true });
  });
});

describe("ocrPictureSubtitleFile language exclusion", () => {
  // @req PLAY-TRACK-05
  it.each([
    ["chi", "Chinese"],
    ["jpn", null],
    ["kor", "Korean"],
  ] as const)("refuses %s before downloading language data or spawning the child", async (language, label) => {
    const langDir = await mkdtemp(join(tmpdir(), "sf-ocr-excluded-"));
    const logs: Array<[string, Record<string, unknown>]> = [];
    const requests: string[] = [];
    try {
      const run = ocrPictureSubtitleFile({
        inputPath: "/nonexistent/track.mkv",
        outPath: join(langDir, "out.srt"),
        language,
        label,
        langDir,
        langDataBaseUrl: "https://api.example.test",
        log: (event, payload) => {
          logs.push([event, payload]);
          console.info(`[${SUITE}:log] ${event}`, JSON.stringify(payload));
        },
        fetchImpl: async (url) => {
          requests.push(url);
          return new Response(null, { status: 500 });
        },
        launcher: { command: "/nonexistent/subtitle-ocr", args: [], env: {} },
      });
      await expect(run).rejects.toBeInstanceOf(SubtitleOcrLanguageExcludedError);
      await expect(run).rejects.toMatchObject({ language, label, reason: "cjk" });
      console.info(`[${SUITE}:state] excluded`, JSON.stringify({ logs, requests, files: await readdir(langDir) }));
      expect(requests).toEqual([]);
      expect(logs.map(([e]) => e)).toEqual(["[subtitle-ocr] language.excluded"]);
      expect(await readdir(langDir)).toEqual([]);
    } finally {
      await rm(langDir, { recursive: true, force: true });
    }
  });
});

const picture = (width: number, height: number, ink: (x: number, y: number) => boolean): SubtitlePicture => {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!ink(x, y)) continue;
      rgba.set([255, 255, 255, 255], (y * width + x) * 4);
    }
  }
  return { startMs: 0, endMs: 1000, width, height, rgba };
};

describe("pictureToOcrImage", () => {
  it("inverts white-on-transparent to dark-on-white, crops to ink and pads 20 px", () => {
    const image = pictureToOcrImage(picture(100, 50, (x, y) => x >= 10 && x < 30 && y >= 5 && y < 15));
    console.info(`[${SUITE}:state] image`, image && { width: image.width, height: image.height });
    expect(image).not.toBeNull();
    if (!image) return;
    expect(image.width).toBe(20 + 2 * OCR_PADDING_PX);
    expect(image.height).toBe(10 + 2 * OCR_PADDING_PX);
    expect(image.gray[0]).toBe(255);
    expect(image.gray[OCR_PADDING_PX * image.width + OCR_PADDING_PX]).toBe(0);
  });

  it("weights luminance by alpha (semi-transparent ink is lighter) and ignores colour-only transparency", () => {
    const p = picture(4, 1, () => false);
    p.rgba.set([255, 255, 255, 255], 0);
    p.rgba.set([255, 255, 255, 51], 4);
    p.rgba.set([255, 255, 255, 0], 8);
    const image = pictureToOcrImage(p);
    expect(image && Array.from(image.gray.subarray(OCR_PADDING_PX * image.width + OCR_PADDING_PX, OCR_PADDING_PX * image.width + OCR_PADDING_PX + 1))).toEqual([0]);
  });

  it("returns null for a picture with no ink", () => {
    expect(pictureToOcrImage(picture(10, 10, () => false))).toBeNull();
  });

  it("encodes binary PGM", () => {
    const pgm = encodePgm({ width: 2, height: 1, gray: Uint8Array.from([0, 255]) });
    expect(pgm.toString("latin1")).toBe("P5\n2 1\n255\n\u0000\u00ff");
  });
});

describe("SRT", () => {
  it("numbers cues from 1 with HH:MM:SS,mmm timings", () => {
    expect(formatSrtTimestamp(3_723_004.6)).toBe("01:02:03,005");
    expect(
      buildSrt([
        { startMs: 47_881, endMs: 49_746.96, text: "[CAR HORNS HONKING]" },
        { startMs: 49_967, endMs: 52_754.56, text: "There's nothing to tell.\nIt's just some guy I work with." },
      ])
    ).toBe(
      "1\n00:00:47,881 --> 00:00:49,747\n[CAR HORNS HONKING]\n\n2\n00:00:49,967 --> 00:00:52,755\nThere's nothing to tell.\nIt's just some guy I work with.\n"
    );
  });
});

describe("resolveSubtitleOcrLauncher", () => {
  it("runs the bundled CLI through the compiled runtime acting as bun when SF_SUBTITLE_OCR_DIR is set", () => {
    const dir = join("/opt", "SpaceBadger", "subtitle-ocr");
    expect(resolveSubtitleOcrLauncher({ SF_SUBTITLE_OCR_DIR: dir })).toEqual({
      command: process.execPath,
      args: [join(dir, "subtitle-ocr.js")],
      env: { BUN_BE_BUN: "1" },
    });
  });

  it("runs cli.ts from source in dev", () => {
    const launcher = resolveSubtitleOcrLauncher({});
    expect(launcher.args).toHaveLength(1);
    expect(launcher.args[0]).toMatch(/subtitleOcr[\\/]cli\.ts$/);
    expect(launcher.command).toBe(process.versions.bun ? process.execPath : "bun");
    expect(launcher.env).toEqual({});
  });
});
