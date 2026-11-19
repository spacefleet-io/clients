import { francAll as francAllLib } from "franc";
import { MEDIA_LANGUAGE_OPTIONS } from "@space/shared";

const FRANC_LANGUAGE_OVERRIDES: Record<string, string> = {
  eng: "en",
  fra: "fr",
  fre: "fr",
  spa: "es",
  por: "pt",
  deu: "de",
  ger: "de",
  ita: "it",
  rus: "ru",
  ukr: "uk",
  nld: "nl",
  dut: "nl",
  jpn: "ja",
  kor: "ko",
  ara: "ar",
  hin: "hi",
  tur: "tr",
  pol: "pl",
  swe: "sv",
  nor: "no",
  dan: "da",
  fin: "fi",
  ell: "el",
  gre: "el",
  hun: "hu",
  ron: "ro",
  rum: "ro",
  ces: "cs",
  cze: "cs",
  slk: "sk",
  slo: "sk",
  bul: "bg",
  hrv: "hr",
  srp: "sr",
  slv: "sl",
  lit: "lt",
  lav: "lv",
  est: "et",
  ind: "id",
  msa: "ms",
  vie: "vi",
  tha: "th",
  ben: "bn",
  fas: "fa",
  per: "fa",
  heb: "he",
  urd: "ur",
  tam: "ta",
  tel: "te",
  mar: "mr",
  yue: "cn",
  cmn: "zh",
  zho: "zh",
  tgl: "tl",
  fil: "tl",
};
const SUPPORTED_MEDIA_LANGUAGE_CODES = new Set(
  MEDIA_LANGUAGE_OPTIONS.map((entry) => entry.code).filter((code) => code !== "xx")
);
const MIN_SINGLE_CONFIDENCE = 0.12;
const MIN_SAMPLE_CONFIDENCE = 0.08;
const MIN_TOP_SCORE = 0.45;

type SubtitleLanguageDetection = {
  language: string;
  confidence: number;
};

type FrancAllAnyFn = (value: string, options: { minLength: number }) => Array<[string, number]>;

const cleanSubtitleText = (value: string) =>
  value
    .normalize("NFKC")
    .replace(/\r/g, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:[a-z]+|#\d+|#x[0-9a-f]+);/gi, " ")
    .replace(/\{[^}]*\}/g, " ")
    .replace(/\[[^\]]*]/g, " ")
    .replace(/\\N/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\p{M}\s']/gu, " ")
    .split(/\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !/^\d+$/.test(line))
    .filter((line) => !/^\d{1,2}:\d{2}:\d{2}([,.]\d{1,3})?/.test(line))
    .join(" ");

const mapFrancCodeToMediaLanguage = (code: string): string | null => {
  const normalized = code.trim().toLowerCase();
  if (!normalized || normalized === "und") return null;
  const direct = FRANC_LANGUAGE_OVERRIDES[normalized];
  if (direct && SUPPORTED_MEDIA_LANGUAGE_CODES.has(direct)) return direct;

  try {
    const resolved = new Intl.Locale(normalized).language.toLowerCase();
    if (SUPPORTED_MEDIA_LANGUAGE_CODES.has(resolved)) return resolved;
  } catch {
    return null;
  }
  return null;
};

const analyzeCandidateText = (francAll: FrancAllAnyFn, value: string) => {
  const cleaned = cleanSubtitleText(value);
  const letterCount = cleaned.match(/\p{L}/gu)?.length ?? 0;
  if (letterCount < 40) return null;

  const ranked = francAll(cleaned, {
    minLength: 30,
  });
  if (!ranked.length) return null;

  const mapped = ranked
    .map(([rawCode, score]) => ({
      language: mapFrancCodeToMediaLanguage(rawCode),
      score,
    }))
    .filter((entry): entry is { language: string; score: number } => Boolean(entry.language))
    .reduce<Array<{ language: string; score: number }>>((acc, entry) => {
      if (acc.some((existing) => existing.language === entry.language)) return acc;
      acc.push(entry);
      return acc;
    }, []);

  if (mapped.length === 0) return null;

  const top = mapped[0];
  const secondScore = mapped[1]?.score;
  if (!Number.isFinite(top.score) || top.score < MIN_TOP_SCORE) return null;
  const confidence =
    typeof secondScore === "number"
      ? Math.max(0, Math.min(1, top.score - secondScore))
      : Math.max(0, Math.min(1, top.score));
  if (confidence < MIN_SINGLE_CONFIDENCE) return null;

  return {
    language: top.language,
    confidence,
    letterCount,
  };
};

export const detectSubtitleLanguage = async (value: string): Promise<SubtitleLanguageDetection | null> => {
  const detection = analyzeCandidateText(francAllLib as FrancAllAnyFn, value);
  if (!detection) return null;

  return {
    language: detection.language,
    confidence: detection.confidence,
  };
};

export const detectSubtitleLanguageFromSamples = async (
  samples: string[]
): Promise<SubtitleLanguageDetection | null> => {
  const votes = new Map<string, { count: number; confidenceSum: number; letterCount: number }>();
  for (const sample of samples) {
    const result = analyzeCandidateText(francAllLib as FrancAllAnyFn, sample);
    if (!result) continue;
    const entry = votes.get(result.language) ?? { count: 0, confidenceSum: 0, letterCount: 0 };
    entry.count += 1;
    entry.confidenceSum += result.confidence;
    entry.letterCount += result.letterCount;
    votes.set(result.language, entry);
  }

  if (!votes.size) return null;
  const ranked = Array.from(votes.entries()).sort((a, b) => {
    if (b[1].count !== a[1].count) return b[1].count - a[1].count;
    if (b[1].confidenceSum !== a[1].confidenceSum) return b[1].confidenceSum - a[1].confidenceSum;
    return b[1].letterCount - a[1].letterCount;
  });
  const [bestLanguage, best] = ranked[0];
  const averageConfidence = best.confidenceSum / Math.max(best.count, 1);
  if (averageConfidence < MIN_SAMPLE_CONFIDENCE) return null;

  return {
    language: bestLanguage,
    confidence: averageConfidence,
  };
};

const FILE_SAMPLE_CHARS = 200;
const FILE_SAMPLE_LIMIT = 24;

/**
 * The language of a whole subtitle file (SRT, WebVTT, ASS/SSA), such as one the user adds from disk (PLAY-SUBGET-23).
 * Its dialogue is cut into chunks that vote like ingest's samples, spread over the file; when they don't agree, the
 * dialogue is read as one text. One short reading of a whole file confuses close languages (English with Scots).
 */
export const detectSubtitleFileLanguage = async (content: string): Promise<SubtitleLanguageDetection | null> => {
  const raw = content.split(/\r?\n/);
  const ass = raw.some((line) => /^\s*Dialogue\s*:/i.test(line));
  const lines = (ass ? raw.flatMap((line) => /^\s*Dialogue\s*:(?:[^,]*,){9}(.*)$/i.exec(line)?.[1] ?? []) : raw)
    .map(cleanSubtitleText)
    .filter((line) => line.length > 0 && line !== "WEBVTT");
  const chunks: string[] = [];
  let chunk = "";
  for (const line of lines) {
    chunk = chunk ? `${chunk} ${line}` : line;
    if (chunk.length >= FILE_SAMPLE_CHARS) {
      chunks.push(chunk);
      chunk = "";
    }
  }
  if (chunk) chunks.push(chunk);
  const step = Math.max(1, chunks.length / FILE_SAMPLE_LIMIT);
  const samples = Array.from({ length: Math.min(chunks.length, FILE_SAMPLE_LIMIT) }, (_, i) => chunks[Math.floor(i * step)]);
  return (await detectSubtitleLanguageFromSamples(samples)) ?? (await detectSubtitleLanguage(lines.join("\n")));
};
