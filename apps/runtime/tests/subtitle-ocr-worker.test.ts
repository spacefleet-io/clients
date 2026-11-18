/**
 * @req PLAY-TRACK-05[runtime]
 *
 * The subtitle OCR worker turns each picture subtitle row into an SRT twin,
 * one track at a time, on the picture's silo, and never loops on a bad track.
 * The library is a fake that models the candidate list the real
 * `listSubtitleOcrCandidates` returns (rows with no twin and no attempt in
 * the retry window); the real method is covered in library-db-runtime's
 * subtitle-ocr-twin.test.ts.
 */
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddOcrSubtitleTwinResult, SubtitleOcrCandidate } from "@space/shared/libraryTypes";
import {
  SubtitleOcrLanguageExcludedError,
  type OcrPictureSubtitleFileOptions,
  type OcrPictureSubtitleFileSummary,
} from "@space/ingest-core/subtitleOcr";
import { createSubtitleOcrWorker, type SubtitleOcrWorkerDeps } from "../src/modules/badger/subtitleOcrWorker";

const PLACEMENT = "silo_abc12345";

const candidate = (id: string, over: Partial<SubtitleOcrCandidate> = {}): SubtitleOcrCandidate => ({
  id,
  mediaId: `media-${id}`,
  fileId: null,
  episodeId: null,
  language: "fr",
  label: "Français",
  objectKey: `media/${PLACEMENT}/subs/${id}.mkv`,
  format: "dvd_subtitle",
  attempts: 0,
  ...over,
});

type Attempt = { subtitleId: string; mediaId: string; status: "failed" | "no_text"; error: string | null };

/** Fake library: a row leaves the list once it has a twin or an attempt. */
const fakeLibrary = (rows: SubtitleOcrCandidate[], opts: { refuseStore?: boolean; open?: () => boolean } = {}) => {
  const twins: Array<{ pictureSubtitleId: string; objectKey: string }> = [];
  const attempts: Attempt[] = [];
  const done = new Set<string>();
  const listCalls: unknown[] = [];
  const call = vi.fn(async (method: string, args: unknown[] = []): Promise<unknown> => {
    const arg = args[0];
    if (method === "listSubtitleOcrCandidates") {
      listCalls.push(arg);
      const { limit } = arg as { limit: number };
      return rows.filter((row) => !done.has(row.id)).slice(0, limit);
    }
    if (method === "addOcrSubtitleTwin") {
      const input = arg as { pictureSubtitleId: string; objectKey: string };
      if (opts.refuseStore) return { created: false, reason: "picture_missing", id: null } satisfies AddOcrSubtitleTwinResult;
      twins.push(input);
      done.add(input.pictureSubtitleId);
      return { created: true, reason: null, id: `twin-${input.pictureSubtitleId}` } satisfies AddOcrSubtitleTwinResult;
    }
    if (method === "recordSubtitleOcrAttempt") {
      const input = arg as Attempt;
      attempts.push(input);
      done.add(input.subtitleId);
      return undefined;
    }
    throw new Error(`unexpected libraryDb call ${method}`);
  });
  return { db: { isOpen: opts.open ?? (() => true), call }, twins, attempts, listCalls, call };
};

const summary = (cues: number): OcrPictureSubtitleFileSummary => ({
  codec: "dvd_subtitle",
  pictures: cues + 1,
  cues,
  empty: 1,
  failures: 0,
  ms: 12,
  tesseractLang: "fra",
  languageKnown: true,
  langDataDownloaded: false,
});

let workDir: string;
let events: Array<{ event: string; payload: Record<string, unknown> }>;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "sf-ocr-worker-test-"));
  events = [];
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(workDir, { recursive: true, force: true });
});

const baseDeps = (library: ReturnType<typeof fakeLibrary>, over: Partial<SubtitleOcrWorkerDeps> = {}): SubtitleOcrWorkerDeps => ({
  libraryDb: library.db,
  resolveToken: () => "token-1",
  resolveLibraryKey: () => "key-1",
  downloadObject: async (_token, objectKey) => Buffer.from(`picture:${objectKey}`),
  uploadFile: async ({ filePath }) => ({ key: `media/${PLACEMENT}/up/${filePath.split("/").at(-2)}.srt`, sizeBytes: 42 }),
  ocrFile: async (options: OcrPictureSubtitleFileOptions) => {
    await writeFile(options.outPath, "1\n00:00:01,000 --> 00:00:02,000\nBonjour\n");
    return summary(1);
  },
  countBusyIngestJobs: async () => 0,
  langDir: join(workDir, "tessdata"),
  langDataBaseUrl: "https://api.example.test",
  workDir: join(workDir, "work"),
  log: (event, payload) => events.push({ event, payload }),
  ...over,
});

describe("subtitle OCR worker (PLAY-TRACK-05)", () => {
  it("OCRs each picture track one at a time and stores the twin on the picture's silo", async () => {
    const library = fakeLibrary([candidate("a"), candidate("b", { format: "hdmv_pgs_subtitle", objectKey: "legacy/b.sup" })]);
    const uploads: Array<{ placementId?: string; token: string; libraryKeyBase64: string; srt: string }> = [];
    const ocrInputs: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const worker = createSubtitleOcrWorker(
      baseDeps(library, {
        ocrFile: async (options) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          ocrInputs.push(options.inputPath.split("/").at(-1) ?? "");
          expect(readFileSync(options.inputPath, "utf8")).toMatch(/^picture:/);
          expect(options.language).toBe("fr");
          expect(options.label).toBe("Français");
          expect(options.langDir).toBe(join(workDir, "tessdata"));
          expect(options.langDataBaseUrl).toBe("https://api.example.test");
          await writeFile(options.outPath, "1\n00:00:01,000 --> 00:00:02,000\nBonjour\n");
          inFlight -= 1;
          return summary(3);
        },
        uploadFile: async ({ token, filePath, libraryKeyBase64, placementId }) => {
          uploads.push({ token, libraryKeyBase64, placementId, srt: readFileSync(filePath, "utf8") });
          return { key: `media/${placementId ?? "fresh_place01"}/twin-${uploads.length}.srt`, sizeBytes: 40 };
        },
      })
    );

    const result = await worker.runPass("manual");

    expect(result).toMatchObject({ reason: "manual", stoppedBy: null, processed: 2, created: 2, noText: 0, failed: 0 });
    expect(maxInFlight).toBe(1);
    // VobSub/DVB rows are stored as Matroska; PGS rows as raw .sup.
    expect(ocrInputs).toEqual(["picture.mkv", "picture.sup"]);
    // Same silo as the picture; a legacy (unplaced) key lets the API pick one.
    expect(uploads.map((u) => u.placementId)).toEqual([PLACEMENT, undefined]);
    expect(uploads[0]).toMatchObject({ token: "token-1", libraryKeyBase64: "key-1" });
    expect(uploads[0].srt).toContain("Bonjour");
    expect(library.twins).toEqual([
      { pictureSubtitleId: "a", objectKey: `media/${PLACEMENT}/twin-1.srt` },
      { pictureSubtitleId: "b", objectKey: "media/fresh_place01/twin-2.srt" },
    ]);
    expect(library.attempts).toEqual([]);
    expect(events.filter((e) => e.event === "[subtitle-ocr] track.twin_created")).toHaveLength(2);
    expect(events.find((e) => e.event === "[subtitle-ocr] track.twin_created")?.payload).toMatchObject({
      subtitleId: "a",
      language: "fr",
      cues: 3,
      pictures: 4,
      placementId: PLACEMENT,
    });
    // Scratch dirs are removed after every track.
    expect(await readdir(join(workDir, "work"))).toEqual([]);
  });

  it("records no_text for a track with no readable text and uploads nothing", async () => {
    const library = fakeLibrary([candidate("a")]);
    const upload = vi.fn<SubtitleOcrWorkerDeps["uploadFile"]>();
    const worker = createSubtitleOcrWorker(baseDeps(library, { ocrFile: async () => summary(0), uploadFile: upload }));

    const result = await worker.runPass("manual");

    expect(result).toMatchObject({ processed: 1, created: 0, noText: 1, failed: 0, stoppedBy: null });
    expect(upload).not.toHaveBeenCalled();
    expect(library.attempts).toEqual([{ subtitleId: "a", mediaId: "media-a", status: "no_text", error: null }]);
  });

  it("records a failure with its stage and keeps going with the next track", async () => {
    const library = fakeLibrary([candidate("a"), candidate("b")]);
    const worker = createSubtitleOcrWorker(
      baseDeps(library, {
        downloadObject: async (_token, objectKey) => {
          if (objectKey.includes("/a.")) throw new Error("HTTP 404");
          return Buffer.from("picture");
        },
      })
    );

    const result = await worker.runPass("manual");

    expect(result).toMatchObject({ processed: 2, created: 1, failed: 1, stoppedBy: null });
    expect(library.attempts).toEqual([{ subtitleId: "a", mediaId: "media-a", status: "failed", error: "download: HTTP 404" }]);
    expect(library.twins.map((t) => t.pictureSubtitleId)).toEqual(["b"]);
    expect(events.find((e) => e.event === "[subtitle-ocr] track.failed")?.payload).toMatchObject({ subtitleId: "a", stage: "download" });
  });

  it("ends the pass after 3 failures in a row (outage guard)", async () => {
    const library = fakeLibrary(["a", "b", "c", "d", "e"].map((id) => candidate(id)));
    const ocr = vi.fn(async (): Promise<OcrPictureSubtitleFileSummary> => {
      throw new Error("tesseract crashed");
    });
    const worker = createSubtitleOcrWorker(baseDeps(library, { ocrFile: ocr }));

    const result = await worker.runPass("manual");

    expect(result).toMatchObject({ processed: 3, failed: 3, stoppedBy: "failures" });
    expect(ocr).toHaveBeenCalledTimes(3);
    expect(library.attempts.map((a) => a.error)).toEqual(Array(3).fill("ocr: tesseract crashed"));
  });

  it("asks the library for rows outside the failed (1 day) and no-text (30 days) retry windows", async () => {
    const library = fakeLibrary([]);
    const at = Date.parse("2026-10-28T12:00:00.000Z");
    const worker = createSubtitleOcrWorker(baseDeps(library, { now: () => at }));

    await worker.runPass("manual");

    expect(library.listCalls).toEqual([
      { limit: 1, failedRetryBefore: "2026-10-27T12:00:00.000Z", noTextRetryBefore: "2026-09-28T12:00:00.000Z" },
    ]);
  });

  it("stands down while ingest jobs run, without touching the library", async () => {
    const library = fakeLibrary([candidate("a")]);
    const worker = createSubtitleOcrWorker(baseDeps(library, { countBusyIngestJobs: async () => 2 }));

    const result = await worker.runPass("import");

    expect(result).toMatchObject({ stoppedBy: "ingest_busy", processed: 0 });
    expect(library.call).not.toHaveBeenCalled();
    expect(events.find((e) => e.event === "[subtitle-ocr] pass.ingest_busy")?.payload).toEqual({ reason: "import", busyJobs: 2 });
  });

  it("does nothing without credentials or with the library closed", async () => {
    const noToken = fakeLibrary([candidate("a")]);
    expect(await createSubtitleOcrWorker(baseDeps(noToken, { resolveToken: () => null })).runPass("manual")).toMatchObject({
      stoppedBy: "credentials_missing",
      processed: 0,
    });
    const noKey = fakeLibrary([candidate("a")]);
    expect(await createSubtitleOcrWorker(baseDeps(noKey, { resolveLibraryKey: () => null })).runPass("manual")).toMatchObject({
      stoppedBy: "credentials_missing",
    });
    const closed = fakeLibrary([candidate("a")], { open: () => false });
    expect(await createSubtitleOcrWorker(baseDeps(closed)).runPass("manual")).toMatchObject({ stoppedBy: "library_closed" });
    expect(noToken.call).not.toHaveBeenCalled();
    expect(closed.call).not.toHaveBeenCalled();
  });

  it("never loops on a track whose twin could not be stored", async () => {
    const library = fakeLibrary([candidate("a")], { refuseStore: true });
    const ocr = vi.fn(async (options: OcrPictureSubtitleFileOptions) => {
      await writeFile(options.outPath, "x");
      return summary(1);
    });
    const worker = createSubtitleOcrWorker(baseDeps(library, { ocrFile: ocr }));

    const result = await worker.runPass("manual");

    expect(ocr).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ processed: 1, stoppedBy: null });
    expect(events.some((e) => e.event === "[subtitle-ocr] track.twin_not_stored")).toBe(true);
  });

  it("parks a CJK track (Chris 2026-10-29: picture-only) without counting a failure", async () => {
    const library = fakeLibrary([candidate("zh", { language: "chi", label: "Chinese" })]);
    const upload = vi.fn<SubtitleOcrWorkerDeps["uploadFile"]>();
    const worker = createSubtitleOcrWorker(
      baseDeps(library, {
        uploadFile: upload,
        ocrFile: async (options) => {
          throw new SubtitleOcrLanguageExcludedError(options.language, options.label ?? null, "cjk");
        },
      })
    );

    const result = await worker.runPass("manual");

    expect(result).toMatchObject({ processed: 1, noText: 1, failed: 0, stoppedBy: null });
    expect(upload).not.toHaveBeenCalled();
    expect(library.attempts).toEqual([{ subtitleId: "zh", mediaId: "media-zh", status: "no_text", error: "excluded: cjk" }]);
    expect(events.some((e) => e.event === "[subtitle-ocr] track.excluded")).toBe(true);
  });

  it("a second pass while one runs is answered already_running and reruns afterwards", async () => {
    const library = fakeLibrary([candidate("a")]);
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const ocr = vi.fn(async (options: OcrPictureSubtitleFileOptions) => {
      await gate;
      await writeFile(options.outPath, "x");
      return summary(1);
    });
    const worker = createSubtitleOcrWorker(baseDeps(library, { ocrFile: ocr }));

    const first = worker.runPass("startup");
    await vi.waitFor(() => expect(ocr).toHaveBeenCalledTimes(1));
    expect(await worker.runPass("import")).toMatchObject({ stoppedBy: "already_running" });
    release();
    expect(await first).toMatchObject({ created: 1 });
    await vi.waitFor(() =>
      expect(events.filter((e) => e.event === "[subtitle-ocr] pass.done").map((e) => e.payload.reason)).toEqual(["startup", "import"])
    );
  });

  it("debounces kicks so the commits of one import share a pass", async () => {
    vi.useFakeTimers();
    const library = fakeLibrary([]);
    const worker = createSubtitleOcrWorker(baseDeps(library, { kickDelayMs: 5_000 }));

    worker.kick("import");
    worker.kick("import");
    worker.kick("import");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(library.listCalls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(library.listCalls).toHaveLength(1));
    expect(events.filter((e) => e.event === "[subtitle-ocr] worker.kick")).toHaveLength(1);
    await worker.stop();
  });

  it("runs a catch-up pass after start and on the idle timer, and stop ends both", async () => {
    vi.useFakeTimers();
    const library = fakeLibrary([]);
    const worker = createSubtitleOcrWorker(baseDeps(library, { startDelayMs: 15_000, idleIntervalMs: 300_000 }));

    worker.start();
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.waitFor(() => expect(library.listCalls).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(300_000);
    await vi.waitFor(() => expect(library.listCalls).toHaveLength(2));
    await worker.stop();
    worker.kick("import");
    await vi.advanceTimersByTimeAsync(600_000);
    expect(library.listCalls).toHaveLength(2);
    expect(events.map((e) => e.event)).toContain("[subtitle-ocr] worker.stopped");
  });

  it("stop aborts the running track without recording a failure", async () => {
    const library = fakeLibrary([candidate("a"), candidate("b")]);
    const ocr = vi.fn((options: OcrPictureSubtitleFileOptions) => {
      const { promise, reject } = Promise.withResolvers<OcrPictureSubtitleFileSummary>();
      options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      return promise;
    });
    const worker = createSubtitleOcrWorker(baseDeps(library, { ocrFile: ocr }));

    const pass = worker.runPass("manual");
    await vi.waitFor(() => expect(ocr).toHaveBeenCalledTimes(1));
    await worker.stop();

    expect(await pass).toMatchObject({ stoppedBy: "stopped", processed: 0 });
    expect(library.attempts).toEqual([]);
    expect(ocr).toHaveBeenCalledTimes(1);
  });
});
