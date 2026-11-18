/**
 * Tesseract language data: `<code>.traineddata.gz` (4.0.0_best_int, the
 * integer-quantised LSTM models tesseract.js ships) fetched from our own API
 * (`<apiBaseUrl>/subtitle-ocr/langdata/<code>.traineddata.gz`) on first need
 * into a caller-owned cache dir and never fetched again.
 *
 * Every file must match the sha256 pinned in `langDataHashes.ts`: a code with
 * no pinned hash is never fetched, and a payload whose hash differs is refused
 * at once (no retry, nothing written), so a swapped file on the server or on
 * the way never reaches tesseract.
 *
 * Polite to the server: one download at a time per process (all requests share
 * one queue; concurrent asks for the same file share one promise), a
 * User-Agent naming SpaceFleet, exponential backoff on 429/503 honouring
 * Retry-After, bounded attempts. Writes are atomic (temp file + rename) and
 * the payload must gunzip cleanly before it lands.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { TESSERACT_LANG_DATA_SHA256 } from "./langDataHashes";
import type { SubtitleOcrLog } from "./types";

export const TESSERACT_LANG_DATA_USER_AGENT = "SpaceBadger/1.0 (SpaceFleet subtitle OCR; +https://spacebadger.io)";
export const tesseractLangDataUrl = (apiBaseUrl: string, code: string): string =>
  `${apiBaseUrl.replace(/\/+$/, "")}/subtitle-ocr/langdata/${code}.traineddata.gz`;
export const tesseractLangDataPath = (langDir: string, code: string): string => join(langDir, `${code}.traineddata.gz`);

const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 60_000;

/** The slice of `fetch` the downloader uses (test seam). */
export type LangDataFetch = (url: string, init: RequestInit) => Promise<Response>;

export type EnsureLangDataOptions = {
  tesseractLang: string;
  langDir: string;
  /** SpaceFleet API origin serving `/subtitle-ocr/langdata/*`. */
  apiBaseUrl: string;
  log: SubtitleOcrLog;
  fetchImpl?: LangDataFetch;
  /** Test seam: the pinned `{code: sha256}` list (default `TESSERACT_LANG_DATA_SHA256`). */
  expectedSha256?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  /** Test seam for backoff waits. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

export type LangDataResult = { path: string; downloaded: boolean; bytes: number; ms: number; retries: number };

const abortableSleep = (ms: number, signal?: AbortSignal): Promise<void> => {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  if (signal?.aborted) {
    reject(signal.reason);
    return promise;
  }
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  const onAbort = () => {
    clearTimeout(timer);
    reject(signal?.reason);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  return promise;
};

/** Retry-After as delta-seconds or HTTP date → ms; null when absent/unparseable. */
export const parseRetryAfterMs = (value: string | null, now = Date.now()): number | null => {
  if (!value) return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
};

const fileSize = async (path: string): Promise<number | null> => {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0 ? info.size : null;
  } catch {
    return null;
  }
};

/** One queue for every download in this process; per-file promises dedupe concurrent asks. */
let downloadQueue: Promise<unknown> = Promise.resolve();
const inflight = new Map<string, Promise<LangDataResult>>();

const download = async (options: EnsureLangDataOptions, path: string): Promise<LangDataResult> => {
  const { tesseractLang, langDir, log, signal } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? abortableSleep;
  const url = tesseractLangDataUrl(options.apiBaseUrl, tesseractLang);
  const expected = (options.expectedSha256 ?? TESSERACT_LANG_DATA_SHA256)[tesseractLang];
  if (!expected) throw new Error(`language data for ${tesseractLang} has no pinned sha256; not fetched`);
  const started = performance.now();
  // Re-check inside the queue: an earlier queued download may have produced it.
  const cached = await fileSize(path);
  if (cached !== null) return { path, downloaded: false, bytes: cached, ms: 0, retries: 0 };
  await mkdir(langDir, { recursive: true });
  let retries = 0;
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted();
    log("[subtitle-ocr] langdata.download.start", { tesseractLang, url, attempt });
    const backoffMs = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempt - 1));
    let response: Response | null = null;
    let body: Uint8Array | null = null;
    let reason: string;
    try {
      response = await fetchImpl(url, {
        headers: { "User-Agent": TESSERACT_LANG_DATA_USER_AGENT, Accept: "application/octet-stream" },
        signal,
      });
      if (response.ok) body = new Uint8Array(await response.arrayBuffer());
      reason = `HTTP ${response.status}`;
    } catch (error) {
      // Network failures are retried like a 503; an abort is final.
      if (signal?.aborted) throw error;
      reason = error instanceof Error ? error.message : String(error);
    }
    if (body) {
      if (body.length < 2 || body[0] !== 0x1f || body[1] !== 0x8b) {
        throw new Error(`language data for ${tesseractLang} is not gzip (${body.length} bytes from ${url})`);
      }
      try {
        gunzipSync(body);
      } catch (error) {
        throw new Error(`language data for ${tesseractLang} is a corrupt gzip: ${(error as Error).message}`);
      }
      const sha256 = createHash("sha256").update(body).digest("hex");
      if (sha256 !== expected) {
        log("[subtitle-ocr] langdata.download.hash_mismatch", { tesseractLang, url, bytes: body.length, sha256, expected });
        throw new Error(`language data for ${tesseractLang} refused: sha256 ${sha256} is not the pinned ${expected}`);
      }
      const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(tmp, body);
        await rename(tmp, path);
      } finally {
        await rm(tmp, { force: true });
      }
      const ms = Math.round(performance.now() - started);
      log("[subtitle-ocr] langdata.download.done", { tesseractLang, url, path, bytes: body.length, sha256, ms, retries });
      return { path, downloaded: true, bytes: body.length, ms, retries };
    }
    if (response && !response.ok && response.status !== 429 && response.status !== 503) {
      throw new Error(`language data download failed: HTTP ${response.status} for ${url}`);
    }
    const retryAfterMs = response ? parseRetryAfterMs(response.headers.get("retry-after")) : null;
    const retryDelayMs = Math.min(MAX_BACKOFF_MS, retryAfterMs ?? backoffMs);
    if (attempt >= MAX_ATTEMPTS) {
      throw new Error(`language data download for ${tesseractLang} gave up after ${attempt} attempts (${reason})`);
    }
    retries += 1;
    log("[subtitle-ocr] langdata.download.retry", { tesseractLang, attempt, reason, retryDelayMs });
    await sleep(retryDelayMs, signal);
  }
};

/**
 * Returns the local `<code>.traineddata.gz`, downloading it first if needed.
 * Cache hits never touch the network.
 */
export const ensureTesseractLangData = async (options: EnsureLangDataOptions): Promise<LangDataResult> => {
  const path = tesseractLangDataPath(options.langDir, options.tesseractLang);
  const cached = await fileSize(path);
  if (cached !== null) {
    options.log("[subtitle-ocr] langdata.cache_hit", { tesseractLang: options.tesseractLang, path, bytes: cached });
    return { path, downloaded: false, bytes: cached, ms: 0, retries: 0 };
  }
  const existing = inflight.get(path);
  if (existing) return existing;
  const queued = downloadQueue.then(() => download(options, path));
  downloadQueue = queued.catch(() => undefined);
  inflight.set(path, queued);
  try {
    return await queued;
  } finally {
    inflight.delete(path);
  }
};
