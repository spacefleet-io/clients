/**
 * Subtitle OCR child process.
 *
 *   subtitle-ocr --input <file> --out <srt> --lang <tesseract code> --lang-dir <dir> [--ffprobe <path>]
 *
 * stdout carries one JSON object per line: `{type:"progress",done,total}`,
 * `{type:"log",event,payload}`, then `{type:"result",…}` (exit 0) or
 * `{type:"error",message}` (exit 1). The SRT is written atomically.
 * Never touches the network: language data must already sit in --lang-dir.
 */
import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { decodePictureSubtitleFile } from "./decode";
import { recognizePictures } from "./recognize";
import { buildSrt } from "./srt";
import type { SubtitleOcrChildMessage } from "./types";

const PROGRESS_EVERY = 10;

const emit = (message: SubtitleOcrChildMessage): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const main = async (): Promise<void> => {
  const started = performance.now();
  const { values } = parseArgs({
    options: {
      input: { type: "string" },
      out: { type: "string" },
      lang: { type: "string" },
      "lang-dir": { type: "string" },
      ffprobe: { type: "string" },
    },
    strict: true,
  });
  const { input, out, lang } = values;
  const langDir = values["lang-dir"];
  if (!input || !out || !lang || !langDir) {
    throw new Error("usage: subtitle-ocr --input <file> --out <srt> --lang <code> --lang-dir <dir> [--ffprobe <path>]");
  }
  const decoded = await decodePictureSubtitleFile(input, { ffprobePath: values.ffprobe ?? "ffprobe" });
  emit({
    type: "log",
    event: "[subtitle-ocr] child.decoded",
    payload: { input, codec: decoded.codec, pictures: decoded.pictures.length, decodeFailures: decoded.failures, ms: Math.round(performance.now() - started) },
  });
  const recognition = await recognizePictures({
    pictures: decoded.pictures,
    tesseractLang: lang,
    langDir,
    onProgress: (done, total) => {
      if (done % PROGRESS_EVERY === 0 || done === total) emit({ type: "progress", done, total });
    },
    onPictureError: (index, error) => {
      emit({
        type: "log",
        event: "[subtitle-ocr] child.picture_failed",
        payload: { index, message: error instanceof Error ? error.message : String(error) },
      });
    },
  });
  const tmp = `${out}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, buildSrt(recognition.cues), "utf8");
    await rename(tmp, out);
  } finally {
    await rm(tmp, { force: true });
  }
  emit({
    type: "result",
    codec: decoded.codec,
    pictures: decoded.pictures.length,
    cues: recognition.cues.length,
    empty: recognition.empty,
    failures: decoded.failures + recognition.failures,
    ms: Math.round(performance.now() - started),
  });
};

try {
  await main();
  // Natural exit (no process.exit) so buffered stdout reaches the parent on every OS.
} catch (error) {
  emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
  // A tesseract worker thread that failed to load keeps the process alive; exit once the error line is flushed.
  process.stdout.write("", () => process.exit());
}
