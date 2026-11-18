/**
 * tesseract.js recognition (runs in the OCR child process only).
 *
 * The worker reads `<langDir>/<code>.traineddata.gz` from disk
 * (`langPath` = local dir, `gzip: true`) and never caches or fetches:
 * `cacheMethod: "none"` skips both the cache read and the cache write, and a
 * non-URL `langPath` makes tesseract.js read the file with fs instead of fetch.
 */
import { createWorker, OEM, PSM, type Worker } from "tesseract.js";
import { encodePgm, type GrayImage, pictureToOcrImage } from "./preprocess";
import type { SubtitleCue } from "./srt";
import type { SubtitlePicture } from "./types";

export type RecognitionSummary = { cues: SubtitleCue[]; empty: number; failures: number };

export const createOcrWorker = async (tesseractLang: string, langDir: string): Promise<Worker> => {
  // tesseract.js never settles createWorker when the language data fails to load
  // (no errorHandler: it throws from a message handler; with one: the promise stays
  // pending), so the first reported error rejects the race instead.
  const failed = Promise.withResolvers<never>();
  const worker = await Promise.race([
    createWorker(tesseractLang, OEM.LSTM_ONLY, {
      langPath: langDir,
      gzip: true,
      cacheMethod: "none",
      errorHandler: (data: unknown) => failed.reject(new Error(`tesseract: ${String(data)}`)),
    }),
    failed.promise,
  ]);
  await worker.setParameters({ tessedit_char_blacklist: "|" });
  return worker;
};

/** Lines of recognised words, each line's words joined by a space. */
const recognizeImage = async (worker: Worker, image: GrayImage, psm: PSM): Promise<string[]> => {
  await worker.setParameters({ tessedit_pageseg_mode: psm });
  const { data } = await worker.recognize(encodePgm(image), {}, { text: false, blocks: true });
  const lines: string[] = [];
  for (const block of data.blocks ?? []) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        const text = line.words
          .map((w) => w.text.trim())
          .filter(Boolean)
          .join(" ");
        if (text) lines.push(text);
      }
    }
  }
  return lines;
};

/** PSM 6 (uniform block), falling back to PSM 7 (single line) when nothing came out. */
export const recognizePicture = async (worker: Worker, picture: SubtitlePicture): Promise<string> => {
  const image = pictureToOcrImage(picture);
  if (!image) return "";
  const lines = await recognizeImage(worker, image, PSM.SINGLE_BLOCK);
  return (lines.length > 0 ? lines : await recognizeImage(worker, image, PSM.SINGLE_LINE)).join("\n");
};

export const recognizePictures = async (options: {
  pictures: SubtitlePicture[];
  tesseractLang: string;
  langDir: string;
  onProgress: (done: number, total: number) => void;
  onPictureError: (index: number, error: unknown) => void;
}): Promise<RecognitionSummary> => {
  const { pictures, tesseractLang } = options;
  const worker = await createOcrWorker(tesseractLang, options.langDir);
  const cues: SubtitleCue[] = [];
  let empty = 0;
  let failures = 0;
  try {
    for (const [i, picture] of pictures.entries()) {
      try {
        const text = await recognizePicture(worker, picture);
        if (text) cues.push({ startMs: picture.startMs, endMs: picture.endMs, text });
        else empty += 1;
      } catch (error) {
        failures += 1;
        options.onPictureError(i, error);
      }
      options.onProgress(i + 1, pictures.length);
    }
  } finally {
    await worker.terminate();
  }
  return { cues, empty, failures };
};
