import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireMediaBinary } from "@space/media-deps";
import { formatSrtTimestamp, type LangDataFetch, ocrPictureSubtitleFile, runSubtitleOcrProcess } from "../src/subtitleOcr";
import {
  SUBTITLE_OCR_TEST_LANG_DIR,
  SYNTHETIC_CUES,
  subtitleOcrFixture,
  testLangDataAvailable,
  VOBSUB_SAMPLES,
} from "./helpers/subtitleOcrFixtures";

const SUITE = "subtitle-ocr-ocr";
const OCR_TIMEOUT_MS = 120_000;

const ffprobeAvailable = requireMediaBinary("ffprobe", spawnSync("ffprobe", ["-version"]).status === 0);
const bunAvailable = Boolean(process.versions.bun) || spawnSync("bun", ["--version"]).status === 0;
const langDataAvailable = testLangDataAvailable(["eng", "fra"]);
const runnable = ffprobeAvailable && bunAvailable && langDataAvailable;
if (!runnable) {
  console.warn(`[${SUITE}:SKIPPED] OCR end-to-end did not run`, {
    ffprobeAvailable,
    bunAvailable,
    langDataAvailable,
    langDir: SUBTITLE_OCR_TEST_LANG_DIR,
    hint: "bun packages/ingest-core/scripts/generate-subtitle-ocr-fixtures.ts --lang-data",
  });
}

type ParsedCue = { start: string; end: string; text: string };

const parseSrt = (srt: string): ParsedCue[] =>
  srt
    .trim()
    .split(/\n\n+/)
    .filter(Boolean)
    .map((block) => {
      const [, timing, ...text] = block.split("\n");
      const [start, end] = timing.split(" --> ");
      return { start, end, text: text.join("\n") };
    });

const srtTimestampMs = (timestamp: string): number => {
  const [h, m, s, ms] = timestamp.split(/[:,]/).map(Number);
  return ((h * 60 + m) * 60 + s) * 1000 + ms;
};

/** OCR punctuation noise is not what these tests prove; letters, digits, line breaks and order are. */
const normalise = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.replace(/[^\p{L}\p{N}' ]/gu, "").replace(/\s+/g, " ").trim())
    .join("\n");

const collectLog = (sink: Array<[string, Record<string, unknown>]>) => (event: string, payload: Record<string, unknown>) => {
  sink.push([event, payload]);
  console.info(`[${SUITE}:log] ${event}`, JSON.stringify(payload));
};

/** A fetch that must never be called: tests read language data from the local cache only. */
const noNetwork: LangDataFetch = async (input) => {
  throw new Error(`[${SUITE}] unexpected network request: ${input}`);
};

describe.skipIf(!runnable)("picture subtitle OCR end to end", () => {
  let outDir: string;
  beforeAll(async () => {
    outDir = await mkdtemp(join(tmpdir(), "sf-subtitle-ocr-e2e-"));
  });
  afterAll(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  // @req PLAY-TRACK-05
  it.each([
    ["ocr-synthetic.sup", "hdmv_pgs_subtitle"],
    ["ocr-synthetic-pgs.mkv", "hdmv_pgs_subtitle"],
    ["ocr-synthetic-dvdsub.mkv", "dvd_subtitle"],
    ["ocr-synthetic-dvbsub.mkv", "dvb_subtitle"],
  ] as const)(
    "OCRs %s (%s) into an SRT with the rendered text and timing",
    async (file, codec) => {
      const logs: Array<[string, Record<string, unknown>]> = [];
      const outPath = join(outDir, `${file}.srt`);
      console.info(`[${SUITE}:phase] ocr ${file}`);
      const summary = await ocrPictureSubtitleFile({
        inputPath: subtitleOcrFixture(file),
        outPath,
        language: "en",
        label: "English",
        langDir: SUBTITLE_OCR_TEST_LANG_DIR,
        langDataBaseUrl: "https://api.example.test",
        ffprobePath: "ffprobe",
        log: collectLog(logs),
        fetchImpl: noNetwork,
      });
      const cues = parseSrt(await readFile(outPath, "utf8"));
      console.info(`[${SUITE}:state] ${file}`, JSON.stringify({ summary, cues }));
      expect(summary).toMatchObject({
        codec,
        pictures: 3,
        cues: 3,
        empty: 0,
        failures: 0,
        tesseractLang: "eng",
        languageKnown: true,
        langDataDownloaded: false,
      });
      expect(cues.map((c) => normalise(c.text))).toEqual(SYNTHETIC_CUES.map((c) => normalise(c.text)));
      cues.forEach((cue, i) => {
        expect(cue.start).toBe(formatSrtTimestamp(SYNTHETIC_CUES[i].startMs));
        // dvd_subtitle stop delays tick in 1024/90 ms units; the others are exact.
        const endMs = srtTimestampMs(cue.end);
        expect(endMs).toBeLessThanOrEqual(SYNTHETIC_CUES[i].endMs);
        expect(endMs).toBeGreaterThanOrEqual(SYNTHETIC_CUES[i].endMs - 12);
      });
      expect(logs.map(([e]) => e)).toEqual(
        expect.arrayContaining(["[subtitle-ocr] langdata.cache_hit", "[subtitle-ocr] child.decoded", "[subtitle-ocr] child.done"])
      );
      expect(await readdir(outDir)).not.toContain(expect.stringMatching(/\.tmp/));
    },
    OCR_TIMEOUT_MS
  );

  // @req PLAY-TRACK-05
  it.each(Object.entries(VOBSUB_SAMPLES))(
    "OCRs the DVD-style %s VobSub sample back to the rendered text",
    async (lang, sample) => {
      const logs: Array<[string, Record<string, unknown>]> = [];
      const outPath = join(outDir, `vobsub-${lang}.srt`);
      console.info(`[${SUITE}:phase] ocr ${sample.file}`);
      const summary = await ocrPictureSubtitleFile({
        inputPath: subtitleOcrFixture(sample.file),
        outPath,
        language: sample.language,
        label: null,
        langDir: SUBTITLE_OCR_TEST_LANG_DIR,
        langDataBaseUrl: "https://api.example.test",
        ffprobePath: "ffprobe",
        log: collectLog(logs),
        fetchImpl: noNetwork,
      });
      const cues = parseSrt(await readFile(outPath, "utf8"));
      console.info(`[${SUITE}:state] ${sample.file}`, JSON.stringify({ summary, cues, expected: sample.cues }));
      expect(summary).toMatchObject({
        codec: "dvd_subtitle",
        pictures: sample.cues.length,
        cues: sample.cues.length,
        empty: 0,
        failures: 0,
        tesseractLang: sample.tesseractLang,
        languageKnown: true,
      });
      expect(cues.map(({ start, end }) => ({ start, end }))).toEqual(sample.cues.map(({ start, end }) => ({ start, end })));
      expect(cues.map((c) => normalise(c.text))).toEqual(sample.cues.map((c) => normalise(c.text)));
    },
    OCR_TIMEOUT_MS
  );

  it(
    "rejects with the child's own error when the input is missing",
    async () => {
      const logs: Array<[string, Record<string, unknown>]> = [];
      const outPath = join(outDir, "missing.srt");
      const run = runSubtitleOcrProcess({
        inputPath: join(outDir, "does-not-exist.sup"),
        outPath,
        tesseractLang: "eng",
        langDir: SUBTITLE_OCR_TEST_LANG_DIR,
        ffprobePath: "ffprobe",
        log: collectLog(logs),
      });
      await expect(run).rejects.toThrow(/subtitle OCR child exited 1: .*does-not-exist\.sup/);
      console.info(`[${SUITE}:state] missing input`, JSON.stringify(logs.map(([e]) => e)));
      expect(logs.map(([e]) => e)).toContain("[subtitle-ocr] child.failed");
      expect(existsSync(outPath)).toBe(false);
    },
    OCR_TIMEOUT_MS
  );

  it(
    "exits with an error instead of hanging when the language data is missing",
    async () => {
      const logs: Array<[string, Record<string, unknown>]> = [];
      const outPath = join(outDir, "no-lang.srt");
      const emptyLangDir = await mkdtemp(join(tmpdir(), "sf-ocr-nolang-"));
      try {
        const run = runSubtitleOcrProcess({
          inputPath: subtitleOcrFixture(VOBSUB_SAMPLES.eng.file),
          outPath,
          tesseractLang: "eng",
          langDir: emptyLangDir,
          ffprobePath: "ffprobe",
          log: collectLog(logs),
        });
        await expect(run).rejects.toThrow(/subtitle OCR child exited 1: .*eng\.traineddata/);
      } finally {
        await rm(emptyLangDir, { recursive: true, force: true });
      }
      console.info(`[${SUITE}:state] missing language data`, JSON.stringify(logs.map(([e]) => e)));
      expect(logs.map(([e]) => e)).toContain("[subtitle-ocr] child.failed");
      expect(existsSync(outPath)).toBe(false);
    },
    OCR_TIMEOUT_MS
  );

  it(
    "kills the running child and rejects when aborted",
    async () => {
      const logs: Array<[string, Record<string, unknown>]> = [];
      const outPath = join(outDir, "aborted.srt");
      const controller = new AbortController();
      let childPid: number | null = null;
      const log = (event: string, payload: Record<string, unknown>) => {
        collectLog(logs)(event, payload);
        // Abort right after spawn: the child is alive and has produced nothing yet.
        if (event === "[subtitle-ocr] child.priority" || event === "[subtitle-ocr] child.priority_failed") {
          childPid = typeof payload.pid === "number" ? payload.pid : null;
          controller.abort(new Error("test abort"));
        }
      };
      await expect(
        runSubtitleOcrProcess({
          inputPath: subtitleOcrFixture(VOBSUB_SAMPLES.eng.file),
          outPath,
          tesseractLang: "eng",
          langDir: SUBTITLE_OCR_TEST_LANG_DIR,
          ffprobePath: "ffprobe",
          signal: controller.signal,
          log,
        })
      ).rejects.toThrow("test abort");
      const events = logs.map(([e]) => e);
      console.info(`[${SUITE}:state] aborted`, JSON.stringify({ childPid, events }));
      expect(childPid).not.toBeNull();
      expect(events).toContain("[subtitle-ocr] child.abort");
      expect(events).not.toContain("[subtitle-ocr] child.done");
      // The child has exited (rejection waits for its close event), so the pid is gone.
      expect(() => process.kill(childPid ?? -1, 0)).toThrow();
      expect(existsSync(outPath)).toBe(false);
    },
    OCR_TIMEOUT_MS
  );
});
