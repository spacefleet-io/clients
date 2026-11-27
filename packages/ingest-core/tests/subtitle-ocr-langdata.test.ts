import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type EnsureLangDataOptions,
  ensureTesseractLangData,
  type LangDataFetch,
  TESSERACT_LANG_DATA_USER_AGENT,
  tesseractLangDataUrl,
} from "../src/subtitleOcr/langData";
import { TESSERACT_LANG_DATA_SHA256 } from "../src/subtitleOcr/langDataHashes";
import { resolveTesseractLanguage, TESSERACT_LANGUAGE_CODES } from "../src/subtitleOcr/languages";

const SUITE = "subtitle-ocr-langdata";
const API = "https://api.example.test";
const PAYLOAD = gzipSync(Buffer.from("fake traineddata"));
const PAYLOAD_SHA256 = createHash("sha256").update(PAYLOAD).digest("hex");
/** The test payload pinned for the codes these tests fetch. */
const HASHES: Record<string, string> = Object.fromEntries(
  ["fra", "eng", "deu", "spa", "ita", "por", "pol", "nld"].map((code) => [code, PAYLOAD_SHA256])
);
const url = (code: string) => tesseractLangDataUrl(API, code);
const ensure = (options: Omit<EnsureLangDataOptions, "apiBaseUrl">) =>
  ensureTesseractLangData({ apiBaseUrl: API, expectedSha256: HASHES, ...options });

type Call = { url: string; userAgent: string | null; at: number };

const scriptedFetch = (responses: Array<() => Response | Promise<Response>>, calls: Call[]): LangDataFetch => {
  let i = 0;
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(input), userAgent: headers.get("user-agent"), at: Date.now() });
    const next = responses[Math.min(i++, responses.length - 1)];
    return next();
  };
};

describe("ensureTesseractLangData", () => {
  let langDir: string;
  const logs: Array<[string, Record<string, unknown>]> = [];
  const log = (event: string, payload: Record<string, unknown>) => {
    logs.push([event, payload]);
    console.info(`[${SUITE}:log] ${event}`, JSON.stringify(payload));
  };
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };

  beforeEach(async () => {
    langDir = await mkdtemp(join(tmpdir(), "sf-ocr-langdata-"));
    logs.length = 0;
    sleeps.length = 0;
  });
  afterEach(async () => {
    await rm(langDir, { recursive: true, force: true });
  });

  it("backs off on 429 honouring Retry-After, then stores the gzip atomically with a SpaceFleet User-Agent", async () => {
    const calls: Call[] = [];
    const fetchImpl = scriptedFetch(
      [
        () => new Response("slow down", { status: 429, headers: { "Retry-After": "7" } }),
        () => new Response("unavailable", { status: 503 }),
        () => new Response(PAYLOAD, { status: 200 }),
      ],
      calls
    );
    const result = await ensure({ tesseractLang: "fra", langDir, log, fetchImpl, sleep });
    console.info(`[${SUITE}:state]`, JSON.stringify({ result, calls, sleeps }));
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.url === url("fra"))).toBe(true);
    expect(url("fra")).toBe("https://api.example.test/subtitle-ocr/langdata/fra.traineddata.gz");
    expect(tesseractLangDataUrl(`${API}/`, "fra")).toBe(url("fra"));
    expect(calls.every((c) => c.userAgent === TESSERACT_LANG_DATA_USER_AGENT)).toBe(true);
    expect(TESSERACT_LANG_DATA_USER_AGENT).toContain("SpaceFleet");
    // Retry-After: 7 s; then exponential backoff (2 s × 2^(attempt-1)) for the 503 without one.
    expect(sleeps).toEqual([7000, 4000]);
    expect(result).toMatchObject({ downloaded: true, retries: 2, bytes: PAYLOAD.length });
    expect(await readFile(join(langDir, "fra.traineddata.gz"))).toEqual(PAYLOAD);
    expect(await readdir(langDir)).toEqual(["fra.traineddata.gz"]);
    expect(logs.map(([e]) => e)).toContain("[subtitle-ocr] langdata.download.retry");
  });

  it("serves a cache hit without any request", async () => {
    await writeFile(join(langDir, "eng.traineddata.gz"), PAYLOAD);
    const calls: Call[] = [];
    const result = await ensure({
      tesseractLang: "eng",
      langDir,
      log,
      fetchImpl: scriptedFetch([() => new Response(PAYLOAD)], calls),
      sleep,
    });
    expect(calls).toHaveLength(0);
    expect(result).toMatchObject({ downloaded: false, retries: 0 });
    expect(logs.map(([e]) => e)).toEqual(["[subtitle-ocr] langdata.cache_hit"]);
  });

  it("single-flights concurrent asks for one file and serialises different files", async () => {
    const calls: Call[] = [];
    let active = 0;
    let maxActive = 0;
    const firstStarted = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const fetchImpl: LangDataFetch = async (input, init) => {
      calls.push({ url: String(input), userAgent: new Headers(init?.headers).get("user-agent"), at: Date.now() });
      active++;
      maxActive = Math.max(maxActive, active);
      if (calls.length === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      active--;
      return new Response(PAYLOAD);
    };
    console.info(`[${SUITE}:phase] deu x2 issued, deu download held open`);
    const deu = [
      ensure({ tesseractLang: "deu", langDir, log, fetchImpl, sleep }),
      ensure({ tesseractLang: "deu", langDir, log, fetchImpl, sleep }),
    ];
    await firstStarted.promise;
    console.info(`[${SUITE}:phase] spa issued while deu is downloading`);
    const spa = ensure({ tesseractLang: "spa", langDir, log, fetchImpl, sleep });
    // Let spa's cache check (an fs stat) complete so it reaches the queue before deu is released.
    await readdir(langDir);
    await readdir(langDir);
    console.info(`[${SUITE}:state] before release`, JSON.stringify({ calls: calls.map((c) => c.url), active }));
    expect(calls.map((c) => c.url)).toEqual([url("deu")]);
    releaseFirst.resolve();
    const results = await Promise.all([...deu, spa]);
    console.info(`[${SUITE}:state]`, JSON.stringify({ calls: calls.map((c) => c.url), maxActive, results }));
    expect(calls.map((c) => c.url)).toEqual([url("deu"), url("spa")]);
    expect(maxActive).toBe(1);
    expect(results[0]).toBe(results[1]);
    expect((await readdir(langDir)).sort()).toEqual(["deu.traineddata.gz", "spa.traineddata.gz"]);
  });

  it("gives up after bounded attempts and leaves no partial file", async () => {
    const calls: Call[] = [];
    const fetchImpl = scriptedFetch([() => new Response("busy", { status: 503 })], calls);
    await expect(ensure({ tesseractLang: "ita", langDir, log, fetchImpl, sleep })).rejects.toThrow(
      /gave up after 5 attempts \(HTTP 503\)/
    );
    expect(calls).toHaveLength(5);
    expect(sleeps).toEqual([2000, 4000, 8000, 16_000]);
    expect(await readdir(langDir)).toEqual([]);
  });

  it("fails at once on a 404 and on a non-gzip body", async () => {
    const calls: Call[] = [];
    await expect(
      ensure({
        tesseractLang: "por",
        langDir,
        log,
        fetchImpl: scriptedFetch([() => new Response("nope", { status: 404 })], calls),
        sleep,
      })
    ).rejects.toThrow(/HTTP 404/);
    await expect(
      ensure({
        tesseractLang: "pol",
        langDir,
        log,
        fetchImpl: scriptedFetch([() => new Response("<html>captive portal</html>")], calls),
        sleep,
      })
    ).rejects.toThrow(/not gzip/);
    expect(calls).toHaveLength(2);
    expect(await readdir(langDir)).toEqual([]);
  });

  it("retries network errors and recovers", async () => {
    const calls: Call[] = [];
    const fetchImpl = scriptedFetch(
      [
        () => {
          throw new TypeError("fetch failed");
        },
        () => new Response(PAYLOAD),
      ],
      calls
    );
    const result = await ensure({ tesseractLang: "nld", langDir, log, fetchImpl, sleep });
    expect(result).toMatchObject({ downloaded: true, retries: 1 });
    expect(sleeps).toEqual([2000]);
  });

  it("accepts a served file whose sha256 is the pinned one and logs its hash", async () => {
    const calls: Call[] = [];
    const result = await ensure({ tesseractLang: "fra", langDir, log, fetchImpl: scriptedFetch([() => new Response(PAYLOAD)], calls), sleep });
    expect(result).toMatchObject({ downloaded: true, bytes: PAYLOAD.length });
    expect(await readFile(join(langDir, "fra.traineddata.gz"))).toEqual(PAYLOAD);
    const done = logs.find(([e]) => e === "[subtitle-ocr] langdata.download.done");
    expect(done?.[1]).toMatchObject({ url: url("fra"), sha256: PAYLOAD_SHA256 });
  });

  it("refuses a valid gzip whose sha256 differs, at once, writing nothing", async () => {
    const calls: Call[] = [];
    const swapped = gzipSync(Buffer.from("some other traineddata"));
    await expect(
      ensure({ tesseractLang: "fra", langDir, log, fetchImpl: scriptedFetch([() => new Response(swapped)], calls), sleep })
    ).rejects.toThrow(/refused: sha256 [0-9a-f]{64} is not the pinned/);
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect(await readdir(langDir)).toEqual([]);
    expect(logs.map(([e]) => e)).toContain("[subtitle-ocr] langdata.download.hash_mismatch");
    // The next ask fetches again and takes the right file.
    const result = await ensure({ tesseractLang: "fra", langDir, log, fetchImpl: scriptedFetch([() => new Response(PAYLOAD)], calls), sleep });
    expect(result.downloaded).toBe(true);
  });

  it("never fetches a code without a pinned sha256", async () => {
    const calls: Call[] = [];
    await expect(
      ensure({ tesseractLang: "xxx", langDir, log, fetchImpl: scriptedFetch([() => new Response(PAYLOAD)], calls), sleep })
    ).rejects.toThrow(/no pinned sha256/);
    expect(calls).toHaveLength(0);
  });

  it("pins a sha256 for every language the resolver can pick, and nothing else", () => {
    expect(Object.keys(TESSERACT_LANG_DATA_SHA256).sort()).toEqual([...TESSERACT_LANGUAGE_CODES].sort());
    expect(TESSERACT_LANGUAGE_CODES).toHaveLength(108);
    for (const code of TESSERACT_LANGUAGE_CODES) {
      expect(resolveTesseractLanguage(code)).toMatchObject({ status: "ocr", code });
      expect(TESSERACT_LANG_DATA_SHA256[code]).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
