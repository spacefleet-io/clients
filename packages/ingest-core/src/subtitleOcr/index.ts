import { ensureTesseractLangData, type LangDataFetch } from "./langData";
import { resolveTesseractLanguage } from "./languages";
import { runSubtitleOcrProcess, type SubtitleOcrLauncher, type SubtitleOcrProcessSummary } from "./process";
import type { SubtitleOcrLog } from "./types";

export { decodePictureSubtitleFile } from "./decode";
export { decodeDvbPackets } from "./dvb";
export { parseFfprobeHexDump, probeSubtitlePackets } from "./ffprobePackets";
export {
  ensureTesseractLangData,
  type LangDataFetch,
  parseRetryAfterMs,
  TESSERACT_LANG_DATA_USER_AGENT,
  tesseractLangDataPath,
  tesseractLangDataUrl,
} from "./langData";
export { TESSERACT_LANG_DATA_SHA256 } from "./langDataHashes";
export { resolveTesseractLanguage, type TesseractLanguage } from "./languages";
export { decodePgsSup } from "./pgs";
export { encodePgm, pictureToOcrImage } from "./preprocess";
export {
  resolveSubtitleOcrLauncher,
  runSubtitleOcrProcess,
  type RunSubtitleOcrProcessOptions,
  type SubtitleOcrLauncher,
  type SubtitleOcrProcessSummary,
} from "./process";
export { buildSrt, formatSrtTimestamp, type SubtitleCue } from "./srt";
export type {
  DecodedPictureSubtitles,
  PictureSubtitleCodec,
  SubtitleOcrChildMessage,
  SubtitleOcrLog,
  SubtitlePicture,
} from "./types";
export { decodeVobSubPacket, parseVobSubIdx } from "./vobsub";

export type OcrPictureSubtitleFileOptions = {
  inputPath: string;
  outPath: string;
  /** Track language tag as stored (ISO 639-1/2, BCP-47, name, null). */
  language: string | null;
  label?: string | null;
  /** Cache dir for `<code>.traineddata.gz`. */
  langDir: string;
  /** SpaceFleet API origin the language data is fetched from (`/subtitle-ocr/langdata/*`). */
  langDataBaseUrl: string;
  ffprobePath?: string;
  signal?: AbortSignal;
  log: SubtitleOcrLog;
  fetchImpl?: LangDataFetch;
  launcher?: SubtitleOcrLauncher;
};

export type OcrPictureSubtitleFileSummary = SubtitleOcrProcessSummary & {
  tesseractLang: string;
  languageKnown: boolean;
  langDataDownloaded: boolean;
};

/**
 * Thrown by ocrPictureSubtitleFile for a track whose language is never OCR'd
 * (Chinese, Japanese, Korean). Nothing was downloaded or spawned; callers
 * record the track as not OCR-able instead of retrying.
 */
export class SubtitleOcrLanguageExcludedError extends Error {
  readonly language: string | null;
  readonly label: string | null;
  readonly reason: "cjk";

  constructor(language: string | null, label: string | null, reason: "cjk") {
    super(`subtitle OCR refused: ${reason} language (language=${language ?? "null"}, label=${label ?? "null"})`);
    this.name = "SubtitleOcrLanguageExcludedError";
    this.language = language;
    this.label = label;
    this.reason = reason;
  }
}

/**
 * Picture subtitle object → SRT file: resolve the OCR language (CJK →
 * SubtitleOcrLanguageExcludedError before any download), make sure its
 * traineddata is cached (download happens here, in the caller's process),
 * then OCR in a low-priority child that never touches the network.
 */
export const ocrPictureSubtitleFile = async (options: OcrPictureSubtitleFileOptions): Promise<OcrPictureSubtitleFileSummary> => {
  const { inputPath, language, label, log } = options;
  const resolved = resolveTesseractLanguage(language, label);
  if (resolved.status === "excluded") {
    log("[subtitle-ocr] language.excluded", { inputPath, language, label: label ?? null, reason: resolved.reason });
    throw new SubtitleOcrLanguageExcludedError(language, label ?? null, resolved.reason);
  }
  log(resolved.known ? "[subtitle-ocr] language" : "[subtitle-ocr] language.unknown", {
    inputPath,
    language,
    label: label ?? null,
    tesseractLang: resolved.code,
    known: resolved.known,
  });
  const langData = await ensureTesseractLangData({
    tesseractLang: resolved.code,
    langDir: options.langDir,
    apiBaseUrl: options.langDataBaseUrl,
    log,
    fetchImpl: options.fetchImpl,
    signal: options.signal,
  });
  const summary = await runSubtitleOcrProcess({
    inputPath,
    outPath: options.outPath,
    tesseractLang: resolved.code,
    langDir: options.langDir,
    ffprobePath: options.ffprobePath,
    signal: options.signal,
    log,
    launcher: options.launcher,
  });
  const result = {
    ...summary,
    tesseractLang: resolved.code,
    languageKnown: resolved.known,
    langDataDownloaded: langData.downloaded,
  };
  log("[subtitle-ocr] done", { inputPath, outPath: options.outPath, language, ...result });
  return result;
};
