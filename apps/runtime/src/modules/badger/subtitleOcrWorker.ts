/**
 * Subtitle OCR worker (PLAY-TRACK-05): turns every picture subtitle row of the
 * library (PGS / VobSub / DVB) into an SRT "twin" row the Android TV loads in
 * its place under direct rendering, where mpv draws no picture subtitles.
 *
 * One code path serves both triggers:
 * - import: the commit step kicks the worker once it has written a picture
 *   row, so the twin follows the import within seconds;
 * - catch-up: a pass runs shortly after start and then on an idle timer, and
 *   works through every existing picture row still owed a twin.
 *
 * Work is strictly one track at a time and waits while ingest jobs run, so it
 * never slows an import: download the stored picture object, OCR it in a
 * low-priority child process, upload the SRT on the media's silo, store the
 * twin row. A track that fails, or holds no readable text, is noted in the
 * local-only `subtitle_ocr_attempts` table and retried after a window, so the
 * pass is resumable across restarts and never loops on a bad track.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  SubtitleOcrLanguageExcludedError,
  type OcrPictureSubtitleFileOptions,
  type OcrPictureSubtitleFileSummary,
  type SubtitleOcrLog,
} from "@space/ingest-core/subtitleOcr";
import {
  PGS_SUBTITLE_FORMATS,
  type AddOcrSubtitleTwinResult,
  type SubtitleOcrCandidate,
} from "@space/shared/libraryTypes";
import { parseMediaPlacementIdFromObjectKey } from "@space/shared/storagePlacement";

export type SubtitleOcrWorkerDeps = {
  libraryDb: {
    isOpen(): boolean;
    call(method: string, args?: unknown[]): Promise<unknown>;
  };
  resolveToken: () => string | null;
  resolveLibraryKey: () => string | null;
  downloadObject: (token: string, objectKey: string, libraryKeyBase64: string) => Promise<Buffer>;
  uploadFile: (input: {
    token: string;
    filePath: string;
    libraryKeyBase64: string;
    placementId?: string;
    signal?: AbortSignal;
  }) => Promise<{ key: string; sizeBytes: number }>;
  ocrFile: (options: OcrPictureSubtitleFileOptions) => Promise<OcrPictureSubtitleFileSummary>;
  /** Unfinished ingest jobs: the worker stands down while any run. */
  countBusyIngestJobs: () => Promise<number>;
  /** Cache of tesseract `<code>.traineddata.gz` files (downloaded once, never again). */
  langDir: string;
  /** SpaceFleet API origin serving the language data (`/subtitle-ocr/langdata/*`). */
  langDataBaseUrl: string;
  /** Parent of the per-track scratch dirs. */
  workDir: string;
  ffprobePath?: string;
  log: SubtitleOcrLog;
  now?: () => number;
  /** Delay before the first catch-up pass. Default 15 s. */
  startDelayMs?: number;
  /** Idle timer between catch-up passes. Default 5 min. */
  idleIntervalMs?: number;
  /** Debounce after a kick, so the commits of one import coalesce. Default 5 s. */
  kickDelayMs?: number;
  /** Retry window of a track whose OCR failed. Default 1 day. */
  failedRetryMs?: number;
  /** Retry window of a track that held no readable text. Default 30 days. */
  noTextRetryMs?: number;
  /** Failures in a row that end a pass (outage guard). Default 3. */
  maxConsecutiveFailures?: number;
};

export type SubtitleOcrPassReason = "startup" | "interval" | "import" | "manual";

export type SubtitleOcrPassResult = {
  reason: SubtitleOcrPassReason;
  /** Why the pass stopped before the list ran dry (null when it did). */
  stoppedBy: "already_running" | "library_closed" | "credentials_missing" | "ingest_busy" | "failures" | "stopped" | null;
  processed: number;
  created: number;
  noText: number;
  failed: number;
  ms: number;
};

export type SubtitleOcrWorker = {
  start(): void;
  /** Ask for a pass soon (debounced); a running pass picks the new rows up itself. */
  kick(reason: SubtitleOcrPassReason): void;
  runPass(reason: SubtitleOcrPassReason): Promise<SubtitleOcrPassResult>;
  stop(): Promise<void>;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export const createSubtitleOcrWorker = (deps: SubtitleOcrWorkerDeps): SubtitleOcrWorker => {
  const now = deps.now ?? Date.now;
  const startDelayMs = deps.startDelayMs ?? 15_000;
  const idleIntervalMs = deps.idleIntervalMs ?? 5 * 60_000;
  const kickDelayMs = deps.kickDelayMs ?? 5_000;
  const failedRetryMs = deps.failedRetryMs ?? DAY_MS;
  const noTextRetryMs = deps.noTextRetryMs ?? 30 * DAY_MS;
  const maxConsecutiveFailures = deps.maxConsecutiveFailures ?? 3;
  const { log } = deps;

  let stopped = false;
  let abort = new AbortController();
  let current: Promise<SubtitleOcrPassResult> | null = null;
  let rerunReason: SubtitleOcrPassReason | null = null;
  let startTimer: ReturnType<typeof setTimeout> | null = null;
  let kickTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setInterval> | null = null;

  const processOne = async (
    candidate: SubtitleOcrCandidate,
    token: string,
    libraryKey: string
  ): Promise<"created" | "no_text" | "failed" | "stopped"> => {
    const startedAt = now();
    const base = { subtitleId: candidate.id, mediaId: candidate.mediaId, language: candidate.language, format: candidate.format, attempts: candidate.attempts };
    log("[subtitle-ocr] track.start", { ...base, label: candidate.label, objectKey: candidate.objectKey });
    let stage = "workdir";
    let dir: string | null = null;
    try {
      await mkdir(deps.workDir, { recursive: true });
      dir = await mkdtemp(join(deps.workDir, "track-"));
      stage = "download";
      const bytes = await deps.downloadObject(token, candidate.objectKey, libraryKey);
      const inputPath = join(dir, PGS_SUBTITLE_FORMATS[candidate.format] ? "picture.sup" : "picture.mkv");
      await writeFile(inputPath, bytes);
      log("[subtitle-ocr] track.downloaded", { ...base, bytes: bytes.length, ms: now() - startedAt });
      stage = "ocr";
      const outPath = join(dir, "twin.srt");
      const summary = await deps.ocrFile({
        inputPath,
        outPath,
        language: candidate.language,
        label: candidate.label,
        langDir: deps.langDir,
        langDataBaseUrl: deps.langDataBaseUrl,
        ffprobePath: deps.ffprobePath,
        signal: abort.signal,
        log,
      });
      if (summary.cues === 0) {
        await deps.libraryDb.call("recordSubtitleOcrAttempt", [
          { subtitleId: candidate.id, mediaId: candidate.mediaId, status: "no_text", error: null },
        ]);
        log("[subtitle-ocr] track.no_text", { ...base, ...summary, totalMs: now() - startedAt });
        return "no_text";
      }
      stage = "upload";
      const placementId = parseMediaPlacementIdFromObjectKey(candidate.objectKey) ?? undefined;
      const uploaded = await deps.uploadFile({ token, filePath: outPath, libraryKeyBase64: libraryKey, placementId, signal: abort.signal });
      stage = "store";
      const stored = (await deps.libraryDb.call("addOcrSubtitleTwin", [
        { pictureSubtitleId: candidate.id, objectKey: uploaded.key },
      ])) as AddOcrSubtitleTwinResult;
      log(stored.created ? "[subtitle-ocr] track.twin_created" : "[subtitle-ocr] track.twin_not_stored", {
        ...base,
        twinId: stored.id,
        reason: stored.reason,
        twinKey: uploaded.key,
        twinBytes: uploaded.sizeBytes,
        placementId: placementId ?? null,
        pictures: summary.pictures,
        cues: summary.cues,
        empty: summary.empty,
        failures: summary.failures,
        tesseractLang: summary.tesseractLang,
        languageKnown: summary.languageKnown,
        langDataDownloaded: summary.langDataDownloaded,
        ocrMs: summary.ms,
        totalMs: now() - startedAt,
      });
      return "created";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof SubtitleOcrLanguageExcludedError) {
        // Chris 2026-10-29: CJK picture tracks stay picture-only; parked like a no-text track (30-day window).
        await deps.libraryDb.call("recordSubtitleOcrAttempt", [
          { subtitleId: candidate.id, mediaId: candidate.mediaId, status: "no_text", error: `excluded: ${error.reason}` },
        ]);
        log("[subtitle-ocr] track.excluded", { ...base, reason: error.reason, totalMs: now() - startedAt });
        return "no_text";
      }
      if (stopped || abort.signal.aborted) {
        log("[subtitle-ocr] track.stopped", { ...base, stage, error: message, totalMs: now() - startedAt });
        return "stopped";
      }
      log("[subtitle-ocr] track.failed", { ...base, stage, error: message, totalMs: now() - startedAt });
      try {
        await deps.libraryDb.call("recordSubtitleOcrAttempt", [
          { subtitleId: candidate.id, mediaId: candidate.mediaId, status: "failed", error: `${stage}: ${message}` },
        ]);
      } catch (recordError) {
        log("[subtitle-ocr] track.attempt_not_recorded", {
          ...base,
          error: recordError instanceof Error ? recordError.message : String(recordError),
        });
      }
      return "failed";
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  };

  const pass = async (reason: SubtitleOcrPassReason): Promise<SubtitleOcrPassResult> => {
    const startedAt = now();
    const result: SubtitleOcrPassResult = { reason, stoppedBy: null, processed: 0, created: 0, noText: 0, failed: 0, ms: 0 };
    const tried = new Set<string>();
    let failuresInARow = 0;
    log("[subtitle-ocr] pass.start", { reason });
    while (true) {
      if (stopped) {
        result.stoppedBy = "stopped";
        break;
      }
      if (!deps.libraryDb.isOpen()) {
        result.stoppedBy = "library_closed";
        break;
      }
      const token = deps.resolveToken();
      const libraryKey = deps.resolveLibraryKey();
      if (!token || !libraryKey) {
        result.stoppedBy = "credentials_missing";
        break;
      }
      const busy = await deps.countBusyIngestJobs();
      if (busy > 0) {
        log("[subtitle-ocr] pass.ingest_busy", { reason, busyJobs: busy });
        result.stoppedBy = "ingest_busy";
        break;
      }
      const at = now();
      const candidates = (await deps.libraryDb.call("listSubtitleOcrCandidates", [
        {
          limit: tried.size + 1,
          failedRetryBefore: new Date(at - failedRetryMs).toISOString(),
          noTextRetryBefore: new Date(at - noTextRetryMs).toISOString(),
        },
      ])) as SubtitleOcrCandidate[];
      // A track this pass already handled is still listed only when its outcome could not be stored: stop, never loop.
      const candidate = candidates.find((row) => !tried.has(row.id));
      if (!candidate) break;
      tried.add(candidate.id);
      const outcome = await processOne(candidate, token, libraryKey);
      if (outcome === "stopped") {
        result.stoppedBy = "stopped";
        break;
      }
      result.processed += 1;
      if (outcome === "created") result.created += 1;
      if (outcome === "no_text") result.noText += 1;
      if (outcome === "failed") {
        result.failed += 1;
        failuresInARow += 1;
        if (failuresInARow >= maxConsecutiveFailures) {
          result.stoppedBy = "failures";
          break;
        }
      } else {
        failuresInARow = 0;
      }
    }
    result.ms = now() - startedAt;
    log("[subtitle-ocr] pass.done", { ...result });
    return result;
  };

  const runPass = (reason: SubtitleOcrPassReason): Promise<SubtitleOcrPassResult> => {
    if (current) {
      // The running pass re-reads the list after every track; a follow-up pass covers rows it already skipped.
      rerunReason = reason;
      return Promise.resolve({ reason, stoppedBy: "already_running", processed: 0, created: 0, noText: 0, failed: 0, ms: 0 });
    }
    current = pass(reason)
      .catch((error: unknown): SubtitleOcrPassResult => {
        log("[subtitle-ocr] pass.error", { reason, error: error instanceof Error ? error.message : String(error) });
        return { reason, stoppedBy: null, processed: 0, created: 0, noText: 0, failed: 0, ms: 0 };
      })
      .finally(() => {
        current = null;
        const next = rerunReason;
        rerunReason = null;
        if (next && !stopped) void runPass(next);
      });
    return current;
  };

  return {
    start() {
      if (startTimer || idleTimer) return;
      log("[subtitle-ocr] worker.start", {
        startDelayMs,
        idleIntervalMs,
        failedRetryMs,
        noTextRetryMs,
        langDir: deps.langDir,
        workDir: deps.workDir,
      });
      startTimer = setTimeout(() => {
        startTimer = null;
        void runPass("startup");
      }, startDelayMs);
      idleTimer = setInterval(() => void runPass("interval"), idleIntervalMs);
      startTimer.unref?.();
      idleTimer.unref?.();
    },
    kick(reason) {
      if (stopped || kickTimer) return;
      log("[subtitle-ocr] worker.kick", { reason, kickDelayMs });
      kickTimer = setTimeout(() => {
        kickTimer = null;
        void runPass(reason);
      }, kickDelayMs);
      kickTimer.unref?.();
    },
    runPass,
    async stop() {
      stopped = true;
      clearTimeout(startTimer ?? undefined);
      clearTimeout(kickTimer ?? undefined);
      clearInterval(idleTimer ?? undefined);
      startTimer = kickTimer = idleTimer = null;
      abort.abort();
      await current;
      abort = new AbortController();
      log("[subtitle-ocr] worker.stopped", {});
    },
  };
};
