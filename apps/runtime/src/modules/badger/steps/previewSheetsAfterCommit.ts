/**
 * Seek-bar preview sheets after the source commit (MPV-PREV-02).
 *
 * The source commit kicks this and returns: the video is uploaded, committed and playable before the preview
 * decode starts, and nothing in the import waits on it. One run at a time per runtime (each decodes a whole source
 * file at the encoders' priority). The pictures come from the local file the source job imported; the sheets go on
 * the media's placement, read from the source format's init key; the record lands on the source format row.
 *
 * Previews are optional (provisional, pending a product decision, MPV-PREV-01): a failure is
 * logged and the import stays as it is. Whatever was uploaded and is not recorded (failure, or the format went away
 * meanwhile) is released at once.
 *
 * Restart-safe (RT-LIFE-04): each queued run is kept on disk as `<job dir>.previews.json` (the job, plus the sheet
 * keys uploaded so far) until it ends. A runtime that stops or dies mid-run leaves the file; the next start
 * (`resume`) releases the sheets the cut run had uploaded and runs it again, unless the source file is gone or the
 * format already has its record (or is gone), in which case the run is dropped.
 *
 * The catch-up pass (MPV-PREV-03, `previewSheetsCatchUp.ts`) runs videos already in the library through the same
 * queue (`runCatchUp`): its input is prepared per run (the local file, or the stored copy downloaded and decrypted
 * into `<job dir>.previews-source`), it gives way when an import or a playback starts, and a catch-up run cut by a
 * restart is released and dropped at the next start (the pass picks the video again).
 */
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { producePreviewSheets, produceSkipSignature } from "@space/ingest-core/mediaProcessor";
import type { SkipAudioAnalysisPayload, SkipSignature } from "@space/ingest-core/skipDetect";
import { parseMediaPlacementIdFromObjectKey } from "@space/shared/storagePlacement";
import { isTransientStorageTransportError, StorageTunnelError } from "@space/shared/storageTunnel";
import { previewSheetKeys, type MediaPreviewSheets } from "@space/shared/previewSheets";
import type { BadgerLibraryDbService } from "../../badgerLibraryDb";
import { produceBadgerPreviewSheets, produceBadgerSkipSignature } from "../../badgerIngest";
import { writeFileDurably } from "./skipDetectAfterCommit";

/**
 * Makes and uploads the sheets. The run is queued after the source commit, outside the import's library-key
 * context, so the producer gets the key itself and encrypts every sheet with it (default: badgerIngest's
 * `produceBadgerPreviewSheets`).
 */
export type ProducePreviewSheetsFn = (
  args: Parameters<typeof producePreviewSheets>[0] & { libraryKeyBase64: string }
) => Promise<MediaPreviewSheets>;

/** Makes and uploads a skip signature alone (a video whose previews predate signatures), encrypted like the sheets. */
export type ProduceSkipSignatureFn = (
  args: Parameters<typeof produceSkipSignature>[0] & { libraryKeyBase64: string }
) => Promise<NonNullable<MediaPreviewSheets["skipSignature"]>>;

/** The sound pass of a skip signature (the runtime's mpv); null when it has nothing to read. */
export type AnalyzeSkipAudioFn = (args: {
  inputPath: string;
  durationSeconds: number;
  workDir: string;
  signal?: AbortSignal;
}) => Promise<SkipAudioAnalysisPayload | null>;

export type PreviewSheetsJob = {
  userId: string;
  jobId: string;
  mediaId: string;
  /** The committed source format the record goes on. */
  formatId: string;
  /** The local file the source job imported (a catch-up run prepares its own input; empty here). */
  inputPath: string;
  durationSeconds: number | null;
  /** The source format's init key; its placement is the media's. */
  initKey: string | null;
  /** Set on runs of the catch-up pass (MPV-PREV-03); absent on a run queued by an import. */
  origin?: "catch-up";
  /** The skip signature made in the same pass (META-SKIP-04), for an episode. Absent: no signature (a film). */
  skip?: { season: number | null; episode: number | null };
};

/**
 * The skip part of a run for a file: an episode gets its signature; a film (a file with neither season nor episode)
 * gets none, since films have no intro or credits markers (Chris 2026-11-24, META-SKIP-04).
 */
export const skipJobFor = (season: number | null | undefined, episode: number | null | undefined): PreviewSheetsJob["skip"] =>
  season == null && episode == null ? undefined : { season: season ?? null, episode: episode ?? null };

/**
 * How a run ended. The catch-up pass counts `failed` toward a video's tries; `unreachable` (the backend could not
 * be reached or refused the session) ends the pass with only the hour's wait; `skipped` (no room for the stored
 * copy) and `already-recorded` are not failures.
 */
export type PreviewSheetsOutcome =
  | "recorded"
  | "already-recorded"
  | "failed"
  | "skipped"
  | "unreachable"
  | "format-gone"
  | "stopped"
  | "yielded"
  | "interrupted"
  | "no-credentials";

/** Thrown by a catch-up run's `prepareInput` to skip the video this pass without counting a failure. */
export class PreviewCatchUpSkip extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreviewCatchUpSkip";
  }
}

/** A network outage or a refused session: not the video's fault, so not one of its tries. */
export const isBackendUnreachable = (err: unknown): boolean =>
  isTransientStorageTransportError(err) || (err instanceof StorageTunnelError && (err.status === 401 || err.status === 403));

/**
 * A catch-up download cut because the storage session it ran in was replaced (a sign-in again or a library re-open
 * mid-run): the gateway no longer knows the download (`download_not_open`). Nothing is wrong with the video
 * (MPV-PREV-07).
 */
export const isSessionCut = (err: unknown): boolean => err instanceof StorageTunnelError && err.code === "download_not_open";

export type PreviewSheetsCatchUpOptions = {
  /**
   * Download the input from the vault under `dir` and answer its paths; throws on failure. `audioPath`: the audio
   * track, stored apart from the video, for the sound half of the skip signature (null: the sound is read from
   * `inputPath`). `signatureOnly`: the video already has its previews and the run makes its skip signature alone.
   */
  prepareInput: (dir: string, signal: AbortSignal, need: { signatureOnly: boolean }) => Promise<{ inputPath: string; audioPath: string | null }>;
  /** Checked with the format check: true when an import or a playback started, and the run gives way. */
  shouldYield: () => boolean | Promise<boolean>;
  /** The run reached its next step once the input is ready: reading the pictures, then the sound (MPV-PREV-07). */
  onStep?: (step: "pictures" | "sound") => void;
};

/** What `<job dir>.previews.json` holds while a run is pending. */
type PendingPreviewRun = { version: 1; job: PreviewSheetsJob; uploaded: string[] };

const PENDING_SUFFIX = ".previews.json";
const WORK_DIR_SUFFIX = ".previews";
const SOURCE_DIR_SUFFIX = ".previews-source";

const writePending = (path: string, pending: PendingPreviewRun) => writeFileDurably(path, JSON.stringify(pending));

const readPending = (path: string): PendingPreviewRun | null => {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PendingPreviewRun>;
    if (parsed?.version !== 1 || !parsed.job || !Array.isArray(parsed.uploaded)) return null;
    return parsed as PendingPreviewRun;
  } catch {
    return null;
  }
};

export const createPreviewSheetsRunner = (deps: {
  libraryDb: BadgerLibraryDbService;
  resolveToken?: (userId: string) => string | null;
  deleteStorageKeys?: (token: string, keys: string[]) => Promise<{ deleted: number; reclaimedBytes: number }>;
  produce?: ProducePreviewSheetsFn;
  produceSignature?: ProduceSkipSignatureFn;
  /** The sound pass of the skip signature; absent: signatures without sound. */
  analyzeSkipAudio?: AnalyzeSkipAudioFn;
  /** A recorded skip signature (cache it, match its show); not awaited by the queue. */
  onSkipSignature?: (job: PreviewSheetsJob, objectKey: string, signature: SkipSignature) => Promise<void>;
  /** The transcode root: `<root>/<userId>/<jobId>` is a job dir. */
  transcodeRoot: () => string;
  /** Bounded wait for what a resumed run needs (backend token, open library DB); false when it expired. */
  awaitReady?: (job: PreviewSheetsJob) => Promise<boolean>;
  /**
   * The user of the runtime's open session, or null when nobody is signed in. A run starts only for that user:
   * another user's run, or any run while it is null, is kept pending (the token and key resolvers answer the
   * session's, whoever the run belongs to).
   */
  activeUserId?: () => string | null;
  /** The library key the sheets are encrypted with; the run waits pending while it is missing. */
  resolveLibraryKey?: (userId: string) => string | null;
  /** How often a running decode checks that its format still exists (media deleted or replaced). Default 5 s. */
  formatCheckMs?: number;
  /**
   * How often a running catch-up video asks whether it must give way (MPV-PREV-07: an import or a playback
   * started). Default 500 ms, so it stops within 2 s inside any step.
   */
  yieldCheckMs?: number;
}) => {
  const produce = deps.produce ?? produceBadgerPreviewSheets;
  const produceSignature = deps.produceSignature ?? produceBadgerSkipSignature;
  const jobDir = (job: Pick<PreviewSheetsJob, "userId" | "jobId">) => join(deps.transcodeRoot(), job.userId, job.jobId);
  const pendingPath = (job: PreviewSheetsJob) => `${jobDir(job)}${PENDING_SUFFIX}`;
  /** Set on shutdown: a run cut by it keeps its pending file so the next start runs it again. */
  const stopping = new AbortController();
  /** Pending files of runs queued or running in this process; `resume` leaves them (and their work dirs) alone. */
  const active = new Set<string>();
  const formatCheckMs = deps.formatCheckMs ?? 5_000;
  const yieldCheckMs = deps.yieldCheckMs ?? 500;
  /** Cuts the catch-up video running now; set only while one runs. An import's run queued behind it calls it. */
  let yieldRunningCatchUp: (() => void) | null = null;
  /** Whether the format still exists; a failed read counts as present (the record step decides). */
  const formatExists = async (job: PreviewSheetsJob): Promise<boolean> => {
    try {
      return (await deps.libraryDb.call("getMediaFormatPreviewSheets", [job.formatId])) !== null;
    } catch {
      return true;
    }
  };

  const release = async (job: PreviewSheetsJob, token: string, keys: string[]) => {
    if (keys.length === 0) return;
    const context = JSON.stringify({ jobId: job.jobId, mediaId: job.mediaId, keys });
    if (!deps.deleteStorageKeys) {
      console.warn(`[preview-sheets] release.unavailable (storage GC reclaims them) ${context}`);
      return;
    }
    try {
      const result = await deps.deleteStorageKeys(token, keys);
      console.info(`[preview-sheets] released ${JSON.stringify({ jobId: job.jobId, deleted: result.deleted })}`);
    } catch (err) {
      console.warn(`[preview-sheets] release.failed (storage GC reclaims them) ${context}`, err instanceof Error ? err.message : String(err));
    }
  };

  const run = async (job: PreviewSheetsJob, catchUp?: PreviewSheetsCatchUpOptions): Promise<PreviewSheetsOutcome> => {
    if (stopping.signal.aborted) return "stopped";
    const path = pendingPath(job);
    // Checked before the token and the key are read: those are the open session's, so after a user switch they
    // are the next user's, and while nobody is signed in the loaded key may be any user's replayed key.
    if (deps.activeUserId) {
      const activeUserId = deps.activeUserId();
      if (activeUserId !== job.userId) {
        console.info(
          `[preview-sheets] skipped: not the signed-in user's run, kept pending ${JSON.stringify({ jobId: job.jobId, mediaId: job.mediaId, signedIn: activeUserId !== null })}`
        );
        if (catchUp) rmSync(path, { force: true });
        return "no-credentials";
      }
    }
    const token = deps.resolveToken?.(job.userId) ?? "";
    const libraryKeyBase64 = deps.resolveLibraryKey?.(job.userId)?.trim() ?? "";
    if (!token || !libraryKeyBase64) {
      // An import's run is kept pending: the next start runs it once the session is back. A catch-up run has
      // uploaded nothing yet; the pass picks the video again.
      console.warn(
        `[preview-sheets] skipped: no ${token ? "library key" : "backend token"} ${JSON.stringify({ jobId: job.jobId, mediaId: job.mediaId })}`
      );
      if (catchUp) rmSync(path, { force: true });
      return "no-credentials";
    }
    const uploaded: string[] = [];
    const startedAt = Date.now();
    const sourceDir = `${jobDir(job)}${SOURCE_DIR_SUFFIX}`;
    // One signal for the decode and the uploads: shutdown, the format went away (media deleted or replaced), or
    // (catch-up) an import or a playback started.
    const abort = new AbortController();
    const onStop = () => abort.abort(new Error("PREVIEW_SHEETS_SHUTDOWN"));
    stopping.signal.addEventListener("abort", onStop, { once: true });
    let formatGone = false;
    let yielded = false;
    const checkFormat = async () => {
      if (abort.signal.aborted) return;
      if (catchUp && (await catchUp.shouldYield())) {
        if (abort.signal.aborted) return;
        yielded = true;
        abort.abort(new Error("PREVIEW_SHEETS_YIELD"));
        return;
      }
      if (abort.signal.aborted || (await formatExists(job))) return;
      formatGone = true;
      abort.abort(new Error("PREVIEW_SHEETS_FORMAT_GONE"));
    };
    const timer = setInterval(() => void checkFormat(), formatCheckMs);
    const yieldNow = () => {
      if (abort.signal.aborted) return;
      yielded = true;
      abort.abort(new Error("PREVIEW_SHEETS_YIELD"));
    };
    let yieldChecking = false;
    const yieldTimer = catchUp
      ? setInterval(() => {
          if (yieldChecking || abort.signal.aborted) return;
          yieldChecking = true;
          void Promise.resolve(catchUp.shouldYield())
            .then((must) => {
              if (must) yieldNow();
            })
            .catch(() => {})
            .finally(() => {
              yieldChecking = false;
            });
        }, yieldCheckMs)
      : null;
    if (catchUp) yieldRunningCatchUp = yieldNow;
    let outcome: PreviewSheetsOutcome;
    /** The signature the pass made, handed over once its record lands. */
    let signature: SkipSignature | null = null;
    const workDir = `${jobDir(job)}${WORK_DIR_SUFFIX}`;
    const skipRequest = (inputPath: string, audioPath: string | null) =>
      job.skip
        ? {
            analyzeAudio:
              deps.analyzeSkipAudio && job.durationSeconds
                ? (signal?: AbortSignal) => {
                    catchUp?.onStep?.("sound");
                    return deps.analyzeSkipAudio!({ inputPath: audioPath ?? inputPath, durationSeconds: job.durationSeconds!, workDir: join(workDir, "skip-audio"), signal });
                  }
                : undefined,
            onSignature: (made: SkipSignature) => {
              signature = made;
            },
          }
        : null;
    const onSheetUploaded = (key: string) => {
      uploaded.push(key);
      writePending(path, { version: 1, job, uploaded });
      void checkFormat();
    };
    const handOver = (record: MediaPreviewSheets) => {
      const objectKey = record.skipSignature?.objectKey;
      if (!objectKey || !signature || !deps.onSkipSignature) return;
      void deps.onSkipSignature(job, objectKey, signature).catch((err: unknown) =>
        console.warn(`[skip-detect] signature hand-over failed ${JSON.stringify({ mediaId: job.mediaId })}`, err instanceof Error ? err.message : String(err))
      );
    };
    try {
      /** Previews recorded before signatures existed: the catch-up makes the signature alone. */
      let signatureOnlyOf: MediaPreviewSheets | null = null;
      if (catchUp) {
        // The pass listed the video a while ago: an import's run (or another runtime) may have recorded it since.
        const stored = (await deps.libraryDb.call("getMediaFormatPreviewSheets", [job.formatId])) as {
          previewSheets: MediaPreviewSheets | null;
        } | null;
        if (stored === null) {
          console.info(`[preview-sheets] catch-up: format gone before the decode ${JSON.stringify({ jobId: job.jobId, formatId: job.formatId })}`);
          rmSync(path, { force: true });
          return "format-gone";
        }
        if (stored.previewSheets && (stored.previewSheets.skipSignature || !job.skip)) {
          console.info(`[preview-sheets] catch-up: already recorded, not decoded again ${JSON.stringify({ jobId: job.jobId, formatId: job.formatId })}`);
          rmSync(path, { force: true });
          return "already-recorded";
        }
        if (stored.previewSheets && !job.durationSeconds) throw new PreviewCatchUpSkip("no duration for the skip signature");
        signatureOnlyOf = stored.previewSheets;
      }
      const { inputPath, audioPath } = catchUp
        ? await catchUp.prepareInput(sourceDir, abort.signal, { signatureOnly: signatureOnlyOf !== null })
        : { inputPath: job.inputPath, audioPath: null };
      if (abort.signal.aborted) throw abort.signal.reason;
      catchUp?.onStep?.("pictures");
      const common = {
        token,
        libraryKeyBase64,
        inputPath,
        workDir,
        placementId: (job.initKey && parseMediaPlacementIdFromObjectKey(job.initKey)) || undefined,
        signal: abort.signal,
        onLog: (line: string) => console.info(line),
        onSheetUploaded,
      };
      const record: MediaPreviewSheets = signatureOnlyOf
        ? {
            ...signatureOnlyOf,
            skipSignature: await produceSignature({ ...common, durationSeconds: job.durationSeconds!, skip: skipRequest(inputPath, audioPath)! }),
          }
        : await produce({ ...common, durationSeconds: job.durationSeconds, skip: skipRequest(inputPath, audioPath) });
      if (abort.signal.aborted) throw abort.signal.reason;
      const recorded = await deps.libraryDb.call("setMediaFormatPreviewSheets", [job.formatId, record]);
      if (recorded === true) {
        console.info(
          `[preview-sheets] recorded ${JSON.stringify({ jobId: job.jobId, mediaId: job.mediaId, formatId: job.formatId, origin: job.origin ?? "import", sheets: record.sheets.length, signatureOnly: signatureOnlyOf !== null, skipSignature: record.skipSignature?.sizeBytes ?? null, ms: Date.now() - startedAt })}`
        );
        rmSync(path, { force: true });
        handOver(record);
        return "recorded";
      }
      console.warn(`[preview-sheets] format gone, releasing sheets ${JSON.stringify({ jobId: job.jobId, formatId: job.formatId })}`);
      outcome = "format-gone";
    } catch (err) {
      if (stopping.signal.aborted) {
        console.info(`[preview-sheets] cut by shutdown, kept pending ${JSON.stringify({ jobId: job.jobId, uploaded: uploaded.length })}`);
        return "stopped";
      }
      if (yielded) {
        console.info(`[preview-sheets] catch-up gave way to an import or a playback, releasing sheets ${JSON.stringify({ jobId: job.jobId, formatId: job.formatId, uploaded: uploaded.length })}`);
        outcome = "yielded";
      } else if (formatGone) {
        console.warn(`[preview-sheets] format gone mid-run, decode stopped, releasing sheets ${JSON.stringify({ jobId: job.jobId, formatId: job.formatId, uploaded: uploaded.length })}`);
        outcome = "format-gone";
      } else if (catchUp && err instanceof PreviewCatchUpSkip) {
        console.info(`[preview-sheets] catch-up skipped: ${err.message} ${JSON.stringify({ jobId: job.jobId, formatId: job.formatId })}`);
        outcome = "skipped";
      } else if (catchUp && isSessionCut(err)) {
        console.info(
          `[preview-sheets] catch-up cut by a session change: ${err instanceof Error ? err.message : String(err)} ${JSON.stringify({ jobId: job.jobId, formatId: job.formatId, uploaded: uploaded.length })}`
        );
        outcome = "interrupted";
      } else if (catchUp && isBackendUnreachable(err)) {
        console.warn(
          `[preview-sheets] catch-up cut by an outage: ${err instanceof Error ? err.message : String(err)} ${JSON.stringify({ jobId: job.jobId, formatId: job.formatId, uploaded: uploaded.length })}`
        );
        outcome = "unreachable";
      } else {
        console.warn(
          `[preview-sheets] failed: ${err instanceof Error ? err.message : String(err)} ${JSON.stringify({ jobId: job.jobId, mediaId: job.mediaId, origin: job.origin ?? "import", uploaded: uploaded.length })}`
        );
        outcome = "failed";
      }
    } finally {
      clearInterval(timer);
      clearInterval(yieldTimer ?? undefined);
      if (yieldRunningCatchUp === yieldNow) yieldRunningCatchUp = null;
      stopping.signal.removeEventListener("abort", onStop);
      // The stored copy is decrypted video: never left behind.
      if (catchUp) rmSync(sourceDir, { recursive: true, force: true });
    }
    await release(job, token, uploaded);
    rmSync(path, { force: true });
    return outcome;
  };

  let queue: Promise<unknown> = Promise.resolve();
  /** Runs queued per pending file in this process (a few bytes per import); `resumeOne` spots a live schedule. */
  const enqueueCount = new Map<string, number>();
  /** Formats with an import's run queued or running: the catch-up pass leaves them to it. */
  const importFormats = new Map<string, number>();
  const enqueue = (job: PreviewSheetsJob, catchUp?: PreviewSheetsCatchUpOptions): Promise<PreviewSheetsOutcome> => {
    const path = pendingPath(job);
    active.add(path);
    enqueueCount.set(path, (enqueueCount.get(path) ?? 0) + 1);
    if (!catchUp) {
      importFormats.set(job.formatId, (importFormats.get(job.formatId) ?? 0) + 1);
      // MPV-PREV-07, imports always first: the catch-up video running now gives way at once, so this run is next.
      yieldRunningCatchUp?.();
    }
    const next = queue
      .then(() => run(job, catchUp))
      .catch((err: unknown): PreviewSheetsOutcome => {
        console.warn(`[preview-sheets] failed: ${err instanceof Error ? err.message : String(err)} ${JSON.stringify({ jobId: job.jobId })}`);
        return "failed";
      })
      .finally(() => {
        active.delete(path);
        if (catchUp) return;
        const left = (importFormats.get(job.formatId) ?? 1) - 1;
        if (left > 0) importFormats.set(job.formatId, left);
        else importFormats.delete(job.formatId);
      });
    queue = next;
    return next;
  };

  /** Re-queue one pending run found at start, drop it, or keep it for a later start. */
  const resumeOne = async (path: string): Promise<void> => {
    // A run this process queued meanwhile (a resumed job's commit) owns the file now.
    if (active.has(path)) return;
    const pending = readPending(path);
    if (!pending) {
      console.warn(`[preview-sheets] resume: unreadable pending run dropped ${JSON.stringify({ path })}`);
      rmSync(path, { force: true });
      return;
    }
    // A run written before films lost their markers carries a film's skip part: dropped, so it makes previews only.
    const job = { ...pending.job, skip: pending.job.skip ? skipJobFor(pending.job.skip.season, pending.job.skip.episode) : undefined };
    const context = { jobId: job.jobId, mediaId: job.mediaId, formatId: job.formatId };
    // Another user's run: their token and library are not this session's. Kept for when they are back. Before the
    // session wait an unknown user is waited for (at boot it is often unknown until the session attaches); after
    // it, the run goes on only for the signed-in user, since the token and key it reads are that session's.
    const otherUsersRun = (afterWait: boolean) => {
      if (!deps.activeUserId) return false;
      const activeUserId = deps.activeUserId();
      if (activeUserId === job.userId || (!afterWait && activeUserId === null)) return false;
      console.info(`[preview-sheets] resume: ${activeUserId ? "another user's run" : "nobody signed in"}, kept ${JSON.stringify(context)}`);
      return true;
    };
    if (otherUsersRun(false)) return;
    if (deps.awaitReady && !(await deps.awaitReady(job))) {
      console.warn(`[preview-sheets] resume: session not ready, kept for the next start ${JSON.stringify(context)}`);
      return;
    }
    if (otherUsersRun(true)) return;
    if (active.has(path)) {
      console.info(`[preview-sheets] resume: queued meanwhile by this runtime, skipped ${JSON.stringify(context)}`);
      return;
    }
    // A live `schedule` of the same job from here on (its commit landing while this reads and releases) owns the
    // run: it is spotted below, before this touches the pending file or queues anything.
    const enqueuedBefore = enqueueCount.get(path) ?? 0;
    const token = deps.resolveToken?.(job.userId) ?? "";
    if (!token) {
      console.warn(`[preview-sheets] resume: no backend token, kept for the next start ${JSON.stringify(context)}`);
      return;
    }
    // Read the record first: a run cut after it recorded its sheets must not release them.
    const stored = (await deps.libraryDb.call("getMediaFormatPreviewSheets", [job.formatId])) as {
      previewSheets: MediaPreviewSheets | null;
    } | null;
    const recordedKeys = new Set(previewSheetKeys(stored?.previewSheets));
    await release(job, token, pending.uploaded.filter((key) => !recordedKeys.has(key)));
    // No await from here to `enqueue`, which marks the path active synchronously.
    if ((enqueueCount.get(path) ?? 0) !== enqueuedBefore) {
      console.info(`[preview-sheets] resume: queued meanwhile by this runtime, skipped ${JSON.stringify(context)}`);
      return;
    }
    writePending(path, { version: 1, job, uploaded: [] });
    const reason =
      job.origin === "catch-up"
        ? "catch-up run, the pass picks the video again"
        : !stored
          ? "format gone"
          : stored.previewSheets
            ? "already recorded"
            : !existsSync(job.inputPath)
              ? "source file gone"
              : null;
    if (reason) {
      console.info(`[preview-sheets] resume: dropped (${reason}) ${JSON.stringify(context)}`);
      rmSync(path, { force: true });
      return;
    }
    console.info(`[preview-sheets] resume: re-queued ${JSON.stringify(context)}`);
    await enqueue(job);
  };

  return {
    /**
     * Queue a run after a source commit. Its pending file is written before this returns (a few hundred bytes),
     * so a restart from here on runs it again; the run itself is not awaited by the caller.
     */
    schedule: (job: PreviewSheetsJob): Promise<PreviewSheetsOutcome> => {
      try {
        writePending(pendingPath(job), { version: 1, job, uploaded: [] });
      } catch (err) {
        console.warn(`[preview-sheets] pending file not written (a restart will not redo this run) ${JSON.stringify({ jobId: job.jobId })}`, err instanceof Error ? err.message : String(err));
      }
      return enqueue(job);
    },
    /**
     * Run one video of the catch-up pass (MPV-PREV-03) in the same queue as the imports' runs and settle with how
     * it ended. Its pending file lets the next start release what a cut run uploaded; the run is not redone then.
     */
    runCatchUp: (job: PreviewSheetsJob, options: PreviewSheetsCatchUpOptions): Promise<PreviewSheetsOutcome> => {
      const catchUpJob: PreviewSheetsJob = { ...job, origin: "catch-up" };
      writePending(pendingPath(catchUpJob), { version: 1, job: catchUpJob, uploaded: [] });
      return enqueue(catchUpJob, options);
    },
    /** The formats with an import's run queued or running, which the catch-up pass does not list. */
    queuedImportFormatIds: (): string[] => [...importFormats.keys()],
    /**
     * At runtime start: remove the work dirs a cut run left (they hold unencrypted frames) and the stored copies a
     * cut catch-up run downloaded, then re-queue every pending import run left by a stopped or crashed runtime
     * (catch-up runs are released and dropped). Runs queued by this process are left alone. Settles when all ran.
     */
    resume: async (): Promise<void> => {
      const root = deps.transcodeRoot();
      const paths: string[] = [];
      for (const user of existsSync(root) ? readdirSync(root, { withFileTypes: true }) : []) {
        if (!user.isDirectory()) continue;
        for (const entry of readdirSync(join(root, user.name), { withFileTypes: true })) {
          const path = join(root, user.name, entry.name);
          if (entry.isFile() && entry.name.endsWith(PENDING_SUFFIX) && !active.has(path)) paths.push(path);
          const cutDir =
            entry.isDirectory() && entry.name.endsWith(WORK_DIR_SUFFIX)
              ? path.slice(0, -WORK_DIR_SUFFIX.length)
              : entry.isDirectory() && entry.name.endsWith(SOURCE_DIR_SUFFIX)
                ? path.slice(0, -SOURCE_DIR_SUFFIX.length)
                : null;
          if (cutDir !== null && !active.has(`${cutDir}${PENDING_SUFFIX}`)) {
            console.info(`[preview-sheets] resume: removing a cut run's work dir ${JSON.stringify({ path })}`);
            rmSync(path, { recursive: true, force: true });
          }
        }
      }
      if (paths.length > 0) console.info(`[preview-sheets] resume: ${paths.length} pending run(s)`);
      for (const path of paths) {
        try {
          await resumeOne(path);
        } catch (err) {
          console.warn(`[preview-sheets] resume failed, kept for the next start ${JSON.stringify({ path })}`, err instanceof Error ? err.message : String(err));
        }
      }
    },
    /** On shutdown: abort the running decode and keep its pending file for the next start. */
    stop: (): void => stopping.abort(),
  };
};
