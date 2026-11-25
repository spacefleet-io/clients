/**
 * Seek-bar preview catch-up pass (MPV-PREV-03): the videos already in the library get their preview sheets
 * without a re-import (Chris 2026-10-30).
 *
 * A background pass on this computer's runtime goes through the signed-in user's source formats that have no
 * `preview_sheets`, newest first, one video at a time, through the same runner queue as the imports' runs
 * (MPV-PREV-02), so a single decode runs per runtime at the encoders' low priority under the playback setting.
 * It does not start a video while an import or a playback runs, and a running video gives way when one starts.
 * When the player closes, a pass starts after a short debounce (`afterPlaybackDelayMs`, 5 s) rather than at the
 * next idle tick; the player opening again within it cancels that pass (Chris 2026-11-02).
 *
 * Input, chosen when the run starts:
 * - the local file the source job imported, when the runtime still knows it and it is there at the same size;
 * - otherwise the stored source, downloaded and decrypted next to the job dir (init + chunks);
 * - the 360p copy instead when the stored source is heavier than `heavySourceBytes` (4 GiB).
 *
 * A failed video is retried at most `maxAttempts` (3) times, at least `retryAfterMs` (1 h) apart. Three tries cover
 * a passing outage (gateway restart, expired session) an hour or more later, while a video that cannot work (an
 * unreadable or undecryptable source) stops costing a stored-source download after the third. The counts live in
 * `<transcode root>/<userId>/previews-catch-up.json`, so they survive a restart (RT-LIFE-04).
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PreviewSheetCandidate } from "@space/shared/libraryTypes";
import {
  isBackendUnreachable,
  PreviewCatchUpSkip,
  type PreviewSheetsCatchUpOptions,
  type PreviewSheetsJob,
  type PreviewSheetsOutcome,
} from "./steps/previewSheetsAfterCommit";

const MiB = 1024 * 1024;
/** Room kept free beside a downloaded stored source: the decode's work dir and its frames. */
const FREE_SPACE_MARGIN_BYTES = 1024 * MiB;

/** The fields of a `listMediaFormats` row the source choice reads. */
export type PreviewCatchUpFormat = {
  id: string;
  fileId: string | null;
  quality: string;
  isSource: boolean;
  initKey: string | null;
  totalSize: number | null;
  chunks: Array<{ key: string; sizeBytes: number | null }>;
};

/** A local import file the runtime remembers: its path and size in MiB (rounded) at import. */
export type PreviewCatchUpLocalImport = { path: string; sizeMb: number };

export type PreviewCatchUpSource =
  | { kind: "local"; path: string }
  | { kind: "stored"; formatId: string; quality: string; keys: string[]; bytes: number };

export type PreviewCatchUpLog = (event: string, payload: Record<string, unknown>) => void;

export type PreviewCatchUpDeps = {
  libraryDb: { isOpen(): boolean; call(method: string, args?: unknown[]): Promise<unknown> };
  /** The runner's catch-up entry: queues one video behind the imports' runs and settles with how it ended. */
  runCatchUp: (job: PreviewSheetsJob, options: PreviewSheetsCatchUpOptions) => Promise<PreviewSheetsOutcome>;
  /** The signed-in user whose library is open; the pass works on that library only. */
  resolveUserId: () => string | null;
  resolveToken: () => string | null;
  resolveLibraryKey: () => string | null;
  /** Unfinished ingest jobs: no video starts while any run. */
  countBusyIngestJobs: () => Promise<number>;
  isPlaybackActive: () => boolean;
  /** The local file this runtime imported the candidate from, newest import first; null when unknown. */
  findLocalImport: (userId: string, candidate: PreviewSheetCandidate) => Promise<PreviewCatchUpLocalImport | null>;
  downloadObject: (token: string, objectKey: string, libraryKeyBase64: string) => Promise<Buffer>;
  /**
   * A cheap authenticated call to the backend before each video (`objectKey` is the video's init object). A network
   * error or a 401/403 stops the pass without touching any count; any other error is logged and the video runs.
   */
  probeBackend: (token: string, objectKey: string | null) => Promise<void>;
  /** Formats whose import's preview run is still queued or running: the import makes them, the pass skips them. */
  queuedImportFormatIds: () => string[];
  /** Free bytes on the disk holding `path`. Default `statfs`. */
  freeBytes?: (path: string) => number;
  /** The transcode root; the retry counts sit in `<root>/<userId>/previews-catch-up.json`. */
  stateRoot: () => string;
  log: PreviewCatchUpLog;
  now?: () => number;
  /** Delay before the first pass. Default 30 s. */
  startDelayMs?: number;
  /** Idle timer between passes (and after a pass gave way). Default 5 min. */
  idleIntervalMs?: number;
  /** Debounce after a kick. Default 5 s. */
  kickDelayMs?: number;
  /** Debounce between the player closing and the pass it starts. Default 5 s. */
  afterPlaybackDelayMs?: number;
  /** Minimum time between two tries of a failed video. Default 1 h. */
  retryAfterMs?: number;
  /** Tries of one video before the pass gives up on it. Default 3. */
  maxAttempts?: number;
  /** Failures in a row that end a pass (outage guard). Default 3. */
  maxConsecutiveFailures?: number;
  /** Stored sources heavier than this are read from their 360p copy. Default 4 GiB. */
  heavySourceBytes?: number;
};

export type PreviewCatchUpPassReason = "startup" | "interval" | "resume" | "manual" | "player_closed";

export type PreviewCatchUpPassResult = {
  reason: PreviewCatchUpPassReason;
  /** Why the pass stopped before the list ran dry (null when it did). */
  stoppedBy:
    | "already_running"
    | "stopped"
    | "library_closed"
    | "credentials_missing"
    | "ingest_busy"
    | "playback"
    | "yielded"
    | "failures"
    | "offline"
    | null;
  processed: number;
  recorded: number;
  failed: number;
  /** Videos skipped this pass without counting a failure (no room for the stored copy). */
  skipped: number;
  ms: number;
};

export type PreviewCatchUp = {
  start(): void;
  /** Ask for a pass soon (debounced; a newer kick restarts the debounce with its reason). */
  kick(reason: PreviewCatchUpPassReason): void;
  /**
   * The player opened (`true`) or closed (`false`). Closing kicks a `player_closed` pass after
   * `afterPlaybackDelayMs`; opening cancels a kick that has not fired yet. Repeats of the same state are ignored.
   */
  playbackChanged(active: boolean): void;
  runPass(reason: PreviewCatchUpPassReason): Promise<PreviewCatchUpPassResult>;
  stop(): Promise<void>;
  /**
   * MPV-PREV-06: whether the player may promise previews for this source format. `failed` once the pass has used
   * all its tries on it (it is never picked again); `pending` otherwise (not tried yet, waiting the hour, or nobody
   * signed in). Reads the retry counts from disk, so a restart answers the same.
   */
  previewStatus(formatId: string): PreviewStatus;
};

export type PreviewStatus = { state: "pending" | "failed"; failures: number; maxAttempts: number };

type RetryState = { version: 1; formats: Record<string, { failures: number; lastFailedAt: string }> };

const formatBytes = (format: PreviewCatchUpFormat) =>
  format.totalSize ?? format.chunks.reduce((sum, chunk) => sum + (chunk.sizeBytes ?? 0), 0);

/**
 * Where a catch-up run reads the video from. `local.actualBytes` is the file's size now (null when it is gone);
 * the import recorded its size in MiB, rounded.
 */
export const chooseCatchUpSource = (input: {
  formatId: string;
  local: (PreviewCatchUpLocalImport & { actualBytes: number | null }) | null;
  formats: PreviewCatchUpFormat[];
  heavySourceBytes: number;
}): PreviewCatchUpSource | null => {
  const { local } = input;
  if (local && local.actualBytes !== null && Math.round(local.actualBytes / MiB) === local.sizeMb) {
    return { kind: "local", path: local.path };
  }
  const usable = (format: PreviewCatchUpFormat | undefined): format is PreviewCatchUpFormat & { initKey: string } =>
    !!format && !!format.initKey && format.chunks.length > 0;
  const source = input.formats.find((format) => format.id === input.formatId);
  if (!usable(source)) return null;
  const stored = (format: PreviewCatchUpFormat & { initKey: string }): PreviewCatchUpSource => ({
    kind: "stored",
    formatId: format.id,
    quality: format.quality,
    keys: [format.initKey, ...format.chunks.map((chunk) => chunk.key)],
    bytes: formatBytes(format),
  });
  if (formatBytes(source) > input.heavySourceBytes) {
    const light = input.formats.find((format) => format.quality === "360p" && format.fileId === source.fileId);
    if (usable(light)) return stored(light);
  }
  return stored(source);
};

export const createPreviewSheetsCatchUp = (deps: PreviewCatchUpDeps): PreviewCatchUp => {
  const now = deps.now ?? Date.now;
  const startDelayMs = deps.startDelayMs ?? 30_000;
  const idleIntervalMs = deps.idleIntervalMs ?? 5 * 60_000;
  const kickDelayMs = deps.kickDelayMs ?? 5_000;
  const afterPlaybackDelayMs = deps.afterPlaybackDelayMs ?? 5_000;
  const retryAfterMs = deps.retryAfterMs ?? 60 * 60_000;
  const maxAttempts = deps.maxAttempts ?? 3;
  const maxConsecutiveFailures = deps.maxConsecutiveFailures ?? 3;
  const heavySourceBytes = deps.heavySourceBytes ?? 4 * 1024 * MiB;
  const { log } = deps;

  let stopped = false;
  let current: Promise<PreviewCatchUpPassResult> | null = null;
  let startTimer: ReturnType<typeof setTimeout> | null = null;
  let kickTimer: ReturnType<typeof setTimeout> | null = null;
  let kickReason: PreviewCatchUpPassReason | null = null;
  let idleTimer: ReturnType<typeof setInterval> | null = null;
  let playbackActive = deps.isPlaybackActive();

  const statePath = (userId: string) => join(deps.stateRoot(), userId, "previews-catch-up.json");
  const readState = (userId: string): RetryState => {
    try {
      const parsed = JSON.parse(readFileSync(statePath(userId), "utf8")) as RetryState;
      if (parsed?.version === 1 && parsed.formats && typeof parsed.formats === "object") return parsed;
    } catch {
      // No state yet, or unreadable: start over (at worst a failed video gets its tries again).
    }
    return { version: 1, formats: {} };
  };
  const writeState = (userId: string, state: RetryState) => {
    const path = statePath(userId);
    mkdirSync(join(deps.stateRoot(), userId), { recursive: true });
    writeFileSync(`${path}.tmp`, JSON.stringify(state));
    renameSync(`${path}.tmp`, path);
  };

  const freeBytes = deps.freeBytes ?? ((path: string) => {
    const stats = statfsSync(path);
    return stats.bavail * stats.bsize;
  });

  /** Gives way when an import or a playback starts, or when the signed-in user is no longer the run's. */
  const shouldYieldFor = (userId: string) => async () =>
    deps.resolveUserId() !== userId || deps.isPlaybackActive() || (await deps.countBusyIngestJobs()) > 0;

  /**
   * Settle with `promise`, or reject with the signal's reason once it aborts. The storage tunnel's download takes
   * no signal, so an aborted object is abandoned (its bytes are dropped when they arrive), not cut on the wire.
   */
  const untilAborted = <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> => {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (err: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(err);
        }
      );
    });
  };

  /** Write the stored copy (init + chunks, decrypted, in order) to `dir/source.mp4`. */
  const downloadStored = async (
    source: Extract<PreviewCatchUpSource, { kind: "stored" }>,
    dir: string,
    signal: AbortSignal,
    credentials: { token: string; libraryKey: string }
  ): Promise<string> => {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "source.mp4");
    const out = createWriteStream(path);
    try {
      for (const key of source.keys) {
        if (signal.aborted) throw signal.reason;
        const bytes = await untilAborted(deps.downloadObject(credentials.token, key, credentials.libraryKey), signal);
        if (!out.write(bytes)) await new Promise<void>((resolve) => out.once("drain", () => resolve()));
      }
    } finally {
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
    }
    return path;
  };

  const prepareInput =
    (userId: string, candidate: PreviewSheetCandidate, credentials: { token: string; libraryKey: string }) =>
    async (dir: string, signal: AbortSignal): Promise<string> => {
      const known = await deps.findLocalImport(userId, candidate);
      const actualBytes = known && existsSync(known.path) ? statSync(known.path).size : null;
      const formats = (await deps.libraryDb.call("listMediaFormats", [candidate.mediaId])) as PreviewCatchUpFormat[];
      const source = chooseCatchUpSource({
        formatId: candidate.formatId,
        local: known ? { ...known, actualBytes } : null,
        formats,
        heavySourceBytes,
      });
      const base = { formatId: candidate.formatId, mediaId: candidate.mediaId };
      if (!source) throw new Error("PREVIEW_CATCH_UP_NO_SOURCE");
      if (source.kind === "local") {
        log("[preview-catch-up] source.local", { ...base, path: source.path });
        return source.path;
      }
      mkdirSync(dir, { recursive: true });
      const free = freeBytes(dir);
      if (free < source.bytes + FREE_SPACE_MARGIN_BYTES) {
        log("[preview-catch-up] source.no_room", { ...base, bytes: source.bytes, free, marginBytes: FREE_SPACE_MARGIN_BYTES });
        throw new PreviewCatchUpSkip(`no room for the stored copy (${source.bytes} bytes, ${free} free)`);
      }
      log("[preview-catch-up] source.stored", { ...base, from: source.formatId, quality: source.quality, bytes: source.bytes, objects: source.keys.length });
      return downloadStored(source, dir, signal, credentials);
    };

  const pass = async (reason: PreviewCatchUpPassReason): Promise<PreviewCatchUpPassResult> => {
    const startedAt = now();
    const result: PreviewCatchUpPassResult = { reason, stoppedBy: null, processed: 0, recorded: 0, failed: 0, skipped: 0, ms: 0 };
    const tried = new Set<string>();
    let failuresInARow = 0;
    /** The video waits the hour like a failed one, without using a try. */
    const waitWithoutTry = (userId: string, state: RetryState, formatId: string): number => {
      const failures = state.formats[formatId]?.failures ?? 0;
      state.formats[formatId] = { failures, lastFailedAt: new Date(now()).toISOString() };
      writeState(userId, state);
      return failures;
    };
    log("[preview-catch-up] pass.start", { reason });
    while (true) {
      if (stopped) {
        result.stoppedBy = "stopped";
        break;
      }
      if (!deps.libraryDb.isOpen()) {
        result.stoppedBy = "library_closed";
        break;
      }
      const userId = deps.resolveUserId();
      const token = deps.resolveToken();
      const libraryKey = deps.resolveLibraryKey();
      if (!userId || !token || !libraryKey) {
        result.stoppedBy = "credentials_missing";
        break;
      }
      const busy = await deps.countBusyIngestJobs();
      if (busy > 0) {
        result.stoppedBy = "ingest_busy";
        break;
      }
      if (deps.isPlaybackActive()) {
        result.stoppedBy = "playback";
        break;
      }
      const state = readState(userId);
      const at = now();
      const excluded = new Set(tried);
      for (const [formatId, entry] of Object.entries(state.formats)) {
        if (entry.failures >= maxAttempts || at - Date.parse(entry.lastFailedAt) < retryAfterMs) excluded.add(formatId);
      }
      for (const formatId of deps.queuedImportFormatIds()) excluded.add(formatId);
      const [candidate] = (await deps.libraryDb.call("listPreviewSheetCandidates", [
        { limit: 1, excludeFormatIds: [...excluded] },
      ])) as PreviewSheetCandidate[];
      if (!candidate) break;
      tried.add(candidate.formatId);
      const base = { formatId: candidate.formatId, mediaId: candidate.mediaId, addedAt: candidate.addedAt };
      // Offline (or the session refused), a local file would still decode and its sheets fail to upload: check first.
      // Only what a run counts as an outage stops the pass; any other refusal is this one key's, and the run decides.
      try {
        await deps.probeBackend(token, candidate.initKey);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        if (isBackendUnreachable(err)) {
          log("[preview-catch-up] pass.offline", { ...base, error });
          result.stoppedBy = "offline";
          break;
        }
        log("[preview-catch-up] probe.refused_key", { ...base, error });
      }
      log("[preview-catch-up] video.start", { ...base, attempt: (state.formats[candidate.formatId]?.failures ?? 0) + 1 });
      const outcome = await deps.runCatchUp(
        {
          userId,
          jobId: `catch-up-${candidate.formatId}`,
          mediaId: candidate.mediaId,
          formatId: candidate.formatId,
          inputPath: "",
          durationSeconds: candidate.durationSeconds,
          initKey: candidate.initKey,
        },
        { prepareInput: prepareInput(userId, candidate, { token, libraryKey }), shouldYield: shouldYieldFor(userId) }
      );
      if (outcome === "stopped") {
        result.stoppedBy = "stopped";
        break;
      }
      if (outcome === "no-credentials") {
        result.stoppedBy = "credentials_missing";
        break;
      }
      if (outcome === "yielded") {
        // Not a failure: the video starts over on a later pass.
        log("[preview-catch-up] video.yielded", base);
        result.stoppedBy = "yielded";
        break;
      }
      if (outcome === "unreachable") {
        // An outage, not the video's fault: it waits the hour, and its count stays.
        const failures = waitWithoutTry(userId, state, candidate.formatId);
        log("[preview-catch-up] video.unreachable", { ...base, failures });
        result.stoppedBy = "offline";
        break;
      }
      if (outcome === "skipped") {
        // No room for the stored copy: retried after the hour, so a full disk costs nothing on the passes between.
        result.skipped += 1;
        const failures = waitWithoutTry(userId, state, candidate.formatId);
        log("[preview-catch-up] video.skipped", { ...base, failures });
        continue;
      }
      result.processed += 1;
      if (outcome === "recorded" || outcome === "format-gone" || outcome === "already-recorded") {
        failuresInARow = 0;
        if (outcome === "recorded") result.recorded += 1;
        if (state.formats[candidate.formatId]) {
          delete state.formats[candidate.formatId];
          writeState(userId, state);
        }
        continue;
      }
      result.failed += 1;
      failuresInARow += 1;
      const failures = (state.formats[candidate.formatId]?.failures ?? 0) + 1;
      state.formats[candidate.formatId] = { failures, lastFailedAt: new Date(now()).toISOString() };
      writeState(userId, state);
      log("[preview-catch-up] video.failed", { ...base, failures, maxAttempts, giveUp: failures >= maxAttempts });
      if (failuresInARow >= maxConsecutiveFailures) {
        // Each counts (outages are caught by the backend check and the run itself); the rest wait for a later pass.
        result.stoppedBy = "failures";
        break;
      }
    }
    result.ms = now() - startedAt;
    log("[preview-catch-up] pass.done", { ...result });
    return result;
  };

  const runPass = (reason: PreviewCatchUpPassReason): Promise<PreviewCatchUpPassResult> => {
    if (current) {
      return Promise.resolve({ reason, stoppedBy: "already_running", processed: 0, recorded: 0, failed: 0, skipped: 0, ms: 0 });
    }
    current = pass(reason)
      .catch((error: unknown): PreviewCatchUpPassResult => {
        log("[preview-catch-up] pass.error", { reason, error: error instanceof Error ? error.message : String(error) });
        return { reason, stoppedBy: null, processed: 0, recorded: 0, failed: 0, skipped: 0, ms: 0 };
      })
      .finally(() => {
        current = null;
      });
    return current;
  };

  /** Arm (or re-arm) the one pending kick; the newest reason wins and its debounce starts over. */
  const scheduleKick = (reason: PreviewCatchUpPassReason, delayMs: number) => {
    if (stopped) return;
    const replaced = kickReason;
    clearTimeout(kickTimer ?? undefined);
    kickReason = reason;
    log("[preview-catch-up] kick.scheduled", { reason, delayMs, replaced });
    kickTimer = setTimeout(() => {
      kickTimer = null;
      kickReason = null;
      void runPass(reason);
    }, delayMs);
    kickTimer.unref?.();
  };

  return {
    start() {
      if (stopped || startTimer || idleTimer) return;
      log("[preview-catch-up] worker.start", { startDelayMs, idleIntervalMs, kickDelayMs, afterPlaybackDelayMs, retryAfterMs, maxAttempts, heavySourceBytes, playbackActive });
      startTimer = setTimeout(() => {
        startTimer = null;
        void runPass("startup");
      }, startDelayMs);
      idleTimer = setInterval(() => void runPass("interval"), idleIntervalMs);
      startTimer.unref?.();
      idleTimer.unref?.();
    },
    kick(reason) {
      scheduleKick(reason, kickDelayMs);
    },
    playbackChanged(active) {
      if (stopped || active === playbackActive) return;
      playbackActive = active;
      log("[preview-catch-up] playback.changed", { active, pendingKick: kickReason, passRunning: current !== null });
      if (!active) {
        scheduleKick("player_closed", afterPlaybackDelayMs);
        return;
      }
      if (kickTimer) {
        log("[preview-catch-up] kick.cancelled", { reason: kickReason, by: "playback_started" });
        clearTimeout(kickTimer);
        kickTimer = null;
        kickReason = null;
      }
    },
    runPass,
    previewStatus(formatId) {
      const userId = deps.resolveUserId();
      const failures = userId ? (readState(userId).formats[formatId]?.failures ?? 0) : 0;
      return { state: failures >= maxAttempts ? "failed" : "pending", failures, maxAttempts };
    },
    async stop() {
      stopped = true;
      clearTimeout(startTimer ?? undefined);
      clearTimeout(kickTimer ?? undefined);
      clearInterval(idleTimer ?? undefined);
      startTimer = kickTimer = idleTimer = null;
      kickReason = null;
      await current;
      log("[preview-catch-up] worker.stopped", {});
    },
  };
};
