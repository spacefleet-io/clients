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
 * Input, chosen when the run starts, read from the vault only: after a successful import the client never reads the
 * local original again (Chris 2026-11-24). Downloaded and decrypted next to the job dir (init + chunks):
 * - the previews are missing: the stored source, or its 360p copy when the source is heavier than
 *   `heavySourceBytes` (4 GiB);
 * - only the skip signature is missing: the smallest stored copy of the file (360p), which is good enough;
 * - a run that makes a skip signature also downloads the file's default audio track, since the stored video
 *   copies carry no sound.
 * A video whose synced signature already exists is not run again ("already-recorded"). Two computers may both make
 * one video's signature now and then; that is accepted rather than locked.
 *
 * A failed video is retried at most `maxAttempts` (3) times, at least `retryAfterMs` (1 h) apart. Three tries cover
 * a passing outage (gateway restart, expired session) an hour or more later, while a video that cannot work (an
 * unreadable or undecryptable source) stops costing a stored-source download after the third. The counts live in
 * `<transcode root>/<userId>/previews-catch-up.json`, so they survive a restart (RT-LIFE-04).
 *
 * A pass stopped by an outage (the backend check fails, or a run is cut by the network) does not wait for the idle
 * tick: the next pass is tried after `offlineRetryMs` (15 s), then twice as long each time it is still offline, up to
 * `idleIntervalMs` (5 min), so the work goes on within seconds of the network coming back. A video cut by an outage
 * keeps its count and is tried again by that next pass. Any pass that was not offline resets the wait.
 */
import { createWriteStream, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BadgerPreviewsCatchUp } from "@space/runtime-contracts/badger/previews";
import type { PreviewSheetCandidate, SkipCatchUpVideo } from "@space/shared/libraryTypes";
import {
  isBackendUnreachable,
  PreviewCatchUpSkip,
  skipJobFor,
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

/** The fields of a `getMediaDetails` audio track the source choice reads. */
export type PreviewCatchUpAudioTrack = {
  id: string;
  fileId: string | null;
  isDefault: boolean;
  initKey: string | null;
  totalSize: number | null;
  chunks: Array<{ key: string; sizeBytes: number | null }>;
};

/** One stored object list to download: init first, then the chunks in order. */
export type PreviewCatchUpObjects = { id: string; label: string; keys: string[]; bytes: number };

export type PreviewCatchUpSource = { video: PreviewCatchUpObjects; audio: PreviewCatchUpObjects | null };

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
  /** One stored object, decrypted; `signal` cuts it at its next chunk. */
  downloadObject: (token: string, objectKey: string, libraryKeyBase64: string, signal?: AbortSignal) => Promise<Buffer>;
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
  /** While a pass waits for the imports to finish, how often it looks. Default 2 s. */
  importWaitPollMs?: number;
  /** First wait after a pass stopped by an outage; doubles while still offline, up to `idleIntervalMs`. Default 15 s. */
  offlineRetryMs?: number;
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
  /**
   * Stored objects downloaded side by side for one video (each is its own storage session, about 0.7 s of round
   * trips for a 0.5 MB object on prod, 2026-11-24); written to the file in order. Default 6.
   */
  downloadConcurrency?: number;
};

export type PreviewCatchUpPassReason = "startup" | "interval" | "resume" | "manual" | "player_closed" | "library_opened" | "imports_done" | "offline_retry";

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
    | "interrupted"
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
  /**
   * MPV-PREV-07: the pass as the Jobs tab shows it ("Skip detection: N of M videos"). Counts come from the library
   * and the retry counts on disk, so a restart answers the same; `finishedAt` is this runtime's own memory.
   */
  catchUpStatus(): Promise<BadgerPreviewsCatchUp>;
  /**
   * MPV-PREV-07 "Try again": forget the failed tries of one video (`formatId`), or of every video (null), and ask
   * for a pass. Answers how many videos it reset.
   */
  retry(formatId: string | null): number;
  /**
   * MPV-PREV-07 (Chris 2026-11-24, skip detection as a Jobs queue type): `cancel` takes one video out of the pass (a
   * running one stops like a yield, never counted as a try) until "Try again" brings it back; `dismiss` hides a
   * finished video (done, failed or cancelled) from the Jobs history, leaving a failed or cancelled one left out until
   * "Try again" on its title's details (PLAY-SKIP-09). Answers whether the video was known to the state.
   */
  setVideo(formatId: string, action: "cancel" | "dismiss"): boolean;
};

export type PreviewStatus = { state: "pending" | "failed"; failures: number; maxAttempts: number };

/** `step`: where the last failed try stopped (MPV-PREV-07: the Jobs card says what happened). */
type RetryState = {
  version: 1;
  formats: Record<string, { failures: number; lastFailedAt: string; step?: "download" | "read" }>;
  /** Videos the user cancelled (formatId → when); the pass never picks them until "Try again". */
  cancelled?: Record<string, string>;
  /** Finished videos (done, failed, cancelled) the user removed from the Jobs history (formatId → when). */
  dismissed?: Record<string, string>;
};

const storedBytes = (stored: { totalSize: number | null; chunks: Array<{ sizeBytes: number | null }> }) =>
  stored.totalSize ?? stored.chunks.reduce((sum, chunk) => sum + (chunk.sizeBytes ?? 0), 0);

/** "360p" → 360; a label without a height ("source") sorts last. */
const qualityHeight = (quality: string) => {
  const match = /^(\d+)p$/.exec(quality);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
};

/**
 * What a catch-up run downloads from the vault. `signatureOnly`: the previews exist, so the smallest stored copy of
 * the file is enough; otherwise the stored source, or its 360p copy when the source is heavier than
 * `heavySourceBytes`. `withAudio`: the run makes a skip signature, so the file's default audio track comes too
 * (null when the file has none stored). Null when the format has nothing stored to read.
 */
export const chooseCatchUpSource = (input: {
  formatId: string;
  formats: PreviewCatchUpFormat[];
  audioTracks: PreviewCatchUpAudioTrack[];
  heavySourceBytes: number;
  signatureOnly: boolean;
  withAudio: boolean;
}): PreviewCatchUpSource | null => {
  const usable = (format: PreviewCatchUpFormat | undefined): format is PreviewCatchUpFormat & { initKey: string } =>
    !!format && !!format.initKey && format.chunks.length > 0;
  const source = input.formats.find((format) => format.id === input.formatId);
  if (!usable(source)) return null;
  const siblings = input.formats.filter((format) => format.fileId === source.fileId && usable(format));
  const pick = (): PreviewCatchUpFormat & { initKey: string } => {
    if (input.signatureOnly) {
      return [...siblings].sort((x, y) => qualityHeight(x.quality) - qualityHeight(y.quality) || storedBytes(x) - storedBytes(y))[0] as PreviewCatchUpFormat & { initKey: string };
    }
    if (storedBytes(source) > input.heavySourceBytes) {
      const light = siblings.find((format) => format.quality === "360p");
      if (light) return light as PreviewCatchUpFormat & { initKey: string };
    }
    return source;
  };
  const video = pick();
  const track = input.withAudio
    ? input.audioTracks
        .filter((entry) => entry.fileId === source.fileId && entry.initKey && entry.chunks.length > 0)
        .sort((x, y) => Number(y.isDefault) - Number(x.isDefault))[0]
    : undefined;
  return {
    video: { id: video.id, label: video.quality, keys: [video.initKey, ...video.chunks.map((chunk) => chunk.key)], bytes: storedBytes(video) },
    audio: track ? { id: track.id, label: "audio", keys: [track.initKey!, ...track.chunks.map((chunk) => chunk.key)], bytes: storedBytes(track) } : null,
  };
};

/** Where the running video is: downloading its stored copy, then reading its pictures, then its sound. */
export type CatchUpPhase = "download" | "pictures" | "sound";

export type CatchUpProgress = { phase: CatchUpPhase; doneBytes: number; totalBytes: number; signatureOnly: boolean };

/** How much of the running video's stored copy has arrived, 0..1. */
export const catchUpVideoDownloaded = (progress: Omit<CatchUpProgress, "signatureOnly"> | null): number => {
  if (!progress) return 0;
  if (progress.phase !== "download") return 1;
  return progress.totalBytes > 0 ? Math.min(1, progress.doneBytes / progress.totalBytes) : 0;
};

/**
 * How far one video is, 0..1, for the Jobs card's bar. The download is most of a signature-only video's time (its
 * reading takes seconds) and about half of one that also makes its preview pictures, whose picture step is most of
 * the rest; the steps report no progress of their own, so each holds its starting point until the next one.
 */
export const catchUpVideoProgress = (progress: CatchUpProgress | null): number => {
  if (!progress) return 0;
  const downloadShare = progress.signatureOnly ? 0.9 : 0.5;
  if (progress.phase === "sound") return downloadShare + (1 - downloadShare) * (progress.signatureOnly ? 0.5 : 0.8);
  return catchUpVideoDownloaded(progress) * downloadShare;
};

export const createPreviewSheetsCatchUp = (deps: PreviewCatchUpDeps): PreviewCatchUp => {
  const now = deps.now ?? Date.now;
  const startDelayMs = deps.startDelayMs ?? 30_000;
  const idleIntervalMs = deps.idleIntervalMs ?? 5 * 60_000;
  const kickDelayMs = deps.kickDelayMs ?? 5_000;
  const offlineRetryMs = deps.offlineRetryMs ?? 15_000;
  const importWaitPollMs = deps.importWaitPollMs ?? 2_000;
  const afterPlaybackDelayMs = deps.afterPlaybackDelayMs ?? 5_000;
  const retryAfterMs = deps.retryAfterMs ?? 60 * 60_000;
  const maxAttempts = deps.maxAttempts ?? 3;
  /**
   * When a video that failed a try (or found no disk room) may run again, while that is still ahead of `at`; null when
   * it may run now or used all its tries. The pass and the Jobs status both read it, so the status never names as next
   * a video the pass leaves out.
   */
  const heldUntil = (entry: RetryState["formats"][string] | undefined, at: number): number | null => {
    if (!entry || entry.failures >= maxAttempts) return null;
    const until = Date.parse(entry.lastFailedAt) + retryAfterMs;
    return until > at ? until : null;
  };
  const maxConsecutiveFailures = deps.maxConsecutiveFailures ?? 3;
  const heavySourceBytes = deps.heavySourceBytes ?? 4 * 1024 * MiB;
  const downloadConcurrency = Math.max(1, deps.downloadConcurrency ?? 6);
  const { log } = deps;

  let stopped = false;
  let current: Promise<PreviewCatchUpPassResult> | null = null;
  let startTimer: ReturnType<typeof setTimeout> | null = null;
  let kickTimer: ReturnType<typeof setTimeout> | null = null;
  let kickReason: PreviewCatchUpPassReason | null = null;
  let idleTimer: ReturnType<typeof setInterval> | null = null;
  /** Set while a pass that gave way to an import waits for every import to finish. */
  let importWaitTimer: ReturnType<typeof setInterval> | null = null;
  let playbackActive = deps.isPlaybackActive();
  /** MPV-PREV-07: the video a pass is making now, how the last pass ended, when the list last ran dry. */
  let runningCandidate: PreviewSheetCandidate | null = null;
  /**
   * Where the running video is: null while it waits in the runner's queue, then downloading its stored copy (bytes
   * so far of the copy's stored size), then analysing it. The Jobs card moves its bar through it.
   */
  let runningProgress: CatchUpProgress | null = null;
  let lastStoppedBy: PreviewCatchUpPassResult["stoppedBy"] = null;
  /** Passes in a row stopped by an outage; sets the wait before the next try. */
  let offlineStreak = 0;
  let finishedAt: string | null = null;
  /** The running video the user cancelled: its run yields at the next check and the pass goes on to the next one. */
  let cancelRequested: string | null = null;

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

  /**
   * An import is unfinished (MPV-PREV-07, imports always first): an ingest job queued, running or interrupted (its
   * transcode and upload included), or an import's own preview and signature run still queued or running.
   */
  const importsBusy = async () => deps.queuedImportFormatIds().length > 0 || (await deps.countBusyIngestJobs()) > 0;

  /** Gives way when an import or a playback starts, or when the signed-in user is no longer the run's. */
  const shouldYieldFor = (userId: string) => async () =>
    deps.resolveUserId() !== userId ||
    (cancelRequested !== null && cancelRequested === runningCandidate?.formatId) ||
    deps.isPlaybackActive() ||
    (await importsBusy());

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

  /**
   * Write one stored object list (init + chunks, decrypted, in order) to `dir/<name>`. Up to `downloadConcurrency`
   * objects are fetched at once; each is written as soon as the ones before it are. `onBytes` hears each object.
   */
  const downloadStored = async (
    objects: PreviewCatchUpObjects,
    dir: string,
    name: string,
    signal: AbortSignal,
    credentials: { token: string; libraryKey: string },
    onBytes: (bytes: number) => void
  ): Promise<string> => {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    const out = createWriteStream(path);
    const fetches: Array<Promise<Buffer> | null> = [];
    try {
      for (let index = 0; index < objects.keys.length; index += 1) {
        if (signal.aborted) throw signal.reason;
        while (fetches.length < objects.keys.length && fetches.length < index + downloadConcurrency) {
          const fetch = deps.downloadObject(credentials.token, objects.keys[fetches.length]!, credentials.libraryKey, signal);
          // One left behind by an abort or an earlier failure settles unobserved; never an unhandled rejection.
          fetch.catch(() => undefined);
          fetches.push(fetch);
        }
        const bytes = await untilAborted(fetches[index]!, signal);
        fetches[index] = null;
        onBytes(bytes.length);
        if (!out.write(bytes)) await new Promise<void>((resolve) => out.once("drain", () => resolve()));
      }
    } finally {
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
    }
    return path;
  };

  const prepareInput =
    (candidate: PreviewSheetCandidate, withAudio: boolean, credentials: { token: string; libraryKey: string }) =>
    async (dir: string, signal: AbortSignal, need: { signatureOnly: boolean }): Promise<{ inputPath: string; audioPath: string | null }> => {
      const formats = (await deps.libraryDb.call("listMediaFormats", [candidate.mediaId])) as PreviewCatchUpFormat[];
      const details = withAudio
        ? ((await deps.libraryDb.call("getMediaDetails", [candidate.mediaId])) as { audioTracks?: PreviewCatchUpAudioTrack[] } | null)
        : null;
      const source = chooseCatchUpSource({
        formatId: candidate.formatId,
        formats,
        audioTracks: details?.audioTracks ?? [],
        heavySourceBytes,
        signatureOnly: need.signatureOnly,
        withAudio,
      });
      const base = { formatId: candidate.formatId, mediaId: candidate.mediaId };
      if (!source) throw new Error("PREVIEW_CATCH_UP_NO_SOURCE");
      const bytes = source.video.bytes + (source.audio?.bytes ?? 0);
      mkdirSync(dir, { recursive: true });
      const free = freeBytes(dir);
      if (free < bytes + FREE_SPACE_MARGIN_BYTES) {
        log("[preview-catch-up] source.no_room", { ...base, bytes, free, marginBytes: FREE_SPACE_MARGIN_BYTES });
        throw new PreviewCatchUpSkip(`no room for the stored copy (${bytes} bytes, ${free} free)`);
      }
      log("[preview-catch-up] source.stored", {
        ...base,
        signatureOnly: need.signatureOnly,
        from: source.video.id,
        quality: source.video.label,
        audioTrack: source.audio?.id ?? null,
        bytes,
        objects: source.video.keys.length + (source.audio?.keys.length ?? 0),
      });
      const progress: CatchUpProgress = { phase: "download", doneBytes: 0, totalBytes: bytes, signatureOnly: need.signatureOnly };
      if (runningCandidate === candidate) runningProgress = progress;
      const onBytes = (received: number) => {
        progress.doneBytes += received;
      };
      const inputPath = await downloadStored(source.video, dir, "source.mp4", signal, credentials, onBytes);
      const audioPath = source.audio
        ? await downloadStored(source.audio, dir, "audio.mp4", signal, credentials, onBytes)
        : null;
      return { inputPath, audioPath };
    };

  /**
   * The Jobs card's detailed list (MPV-PREV-07): the running video, the ones the pass gave up on (with the step that
   * failed), the queue in the pass's order, the ones waiting out their hour (with when they run again), then the done
   * ones with what was found.
   */
  const listVideos = (input: {
    library: SkipCatchUpVideo[];
    owed: PreviewSheetCandidate[];
    failedIds: Set<string>;
    running: PreviewSheetCandidate | null;
    retry: RetryState["formats"];
    cancelledIds: Set<string>;
    dismissedIds: Set<string>;
    /** Videos waiting out their hour after a failed try or a full disk (formatId → when they may run again). */
    heldUntil: Map<string, number>;
  }): BadgerPreviewsCatchUp["videos"] => {
    const owedFiles = new Map(input.owed.map((row) => [row.fileId, row]));
    const signedPerMedia = new Map<string, number>();
    for (const row of input.library) if (row.signed) signedPerMedia.set(row.mediaId, (signedPerMedia.get(row.mediaId) ?? 0) + 1);
    type Row = BadgerPreviewsCatchUp["videos"][number];
    const entry = (row: { formatId: string; mediaId: string; season: number | null; episode: number | null }, status: Row["status"]): Row => ({
      formatId: row.formatId,
      mediaId: row.mediaId,
      season: row.season,
      episode: row.episode,
      status,
      result: null,
      failedStep: null,
      retryAt: null,
    });
    const running = input.running ? [entry(input.running, "running")] : [];
    // A finished video the user removed from the Jobs history (`dismiss`) is not listed, whatever its status.
    const failed = input.owed
      .filter((row) => input.failedIds.has(row.formatId) && !input.dismissedIds.has(row.formatId))
      .map((row) => ({ ...entry(row, "failed"), failedStep: input.retry[row.formatId]?.step ?? "download" }));
    const cancelled = input.owed
      .filter(
        (row) =>
          input.cancelledIds.has(row.formatId) &&
          !input.failedIds.has(row.formatId) &&
          !input.dismissedIds.has(row.formatId) &&
          row.fileId !== input.running?.fileId
      )
      .map((row) => entry(row, "cancelled"));
    const waiting = input.owed.filter(
      (row) =>
        !input.failedIds.has(row.formatId) && !input.cancelledIds.has(row.formatId) && row.fileId !== input.running?.fileId
    );
    const queued = waiting.filter((row) => !input.heldUntil.has(row.formatId)).map((row) => entry(row, "queued"));
    const held = waiting
      .filter((row) => input.heldUntil.has(row.formatId))
      .map((row): Row => ({
        ...entry(row, "retry_waiting"),
        failedStep: input.retry[row.formatId]?.step ?? "room",
        retryAt: new Date(input.heldUntil.get(row.formatId)!).toISOString(),
      }));
    const done = input.library
      .filter((row) => !owedFiles.has(row.fileId) && row.fileId !== input.running?.fileId && !input.dismissedIds.has(row.formatId))
      .map((row): Row => {
        // A film gets no skip markers (Chris 2026-11-24): its seek-bar previews are all the pass makes for it.
        const film = row.season === null && row.episode === null;
        const result: Row["result"] = film
          ? "previews_made"
          : row.intro && row.credits
            ? "found_both"
            : row.intro
              ? "found_intro"
              : row.credits
                ? "found_credits"
                : (signedPerMedia.get(row.mediaId) ?? 0) < 2
                  ? "waiting_other_episode"
                  : "nothing_found";
        return { ...entry(row, "done"), result };
      });
    // A cancelled video goes to the bottom: cancelling one never moves the rest of the list (Chris 2026-11-24). A video
    // waiting out its hour comes after the queue: the pass takes every queued one first.
    return [...running, ...failed, ...queued, ...held, ...done, ...cancelled];
  };

  const pass = async (reason: PreviewCatchUpPassReason): Promise<PreviewCatchUpPassResult> => {
    const startedAt = now();
    lastStoppedBy = null;
    const result: PreviewCatchUpPassResult = { reason, stoppedBy: null, processed: 0, recorded: 0, failed: 0, skipped: 0, ms: 0 };
    const tried = new Set<string>();
    let failuresInARow = 0;
    /** The video waits the hour like a failed one, without using a try; no step is kept, so Jobs reads it as no room. */
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
      if (await importsBusy()) {
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
        if (entry.failures >= maxAttempts || heldUntil(entry, at) !== null) excluded.add(formatId);
      }
      for (const formatId of Object.keys(state.cancelled ?? {})) excluded.add(formatId);
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
      const skip = skipJobFor(candidate.season, candidate.episode);
      runningCandidate = candidate;
      runningProgress = null;
      /** The step the run reached (MPV-PREV-07): a failure before the input was ready is the download's. */
      let reached: "pictures" | "sound" | null = null;
      /** When each step began, for the per-video timings in `video.recorded`. */
      const videoStartedAt = now();
      const stepAt: { pictures?: number; sound?: number } = {};
      const outcome = await deps.runCatchUp(
        {
          userId,
          jobId: `catch-up-${candidate.formatId}`,
          mediaId: candidate.mediaId,
          formatId: candidate.formatId,
          inputPath: "",
          durationSeconds: candidate.durationSeconds,
          initKey: candidate.initKey,
          skip,
        },
        {
          prepareInput: prepareInput(candidate, skip !== undefined, { token, libraryKey }),
          shouldYield: shouldYieldFor(userId),
          onStep: (step) => {
            reached = step;
            stepAt[step] ??= now();
            if (runningCandidate === candidate && runningProgress) runningProgress = { ...runningProgress, phase: step };
          },
        }
      );
      const stoppedIn = reached;
      runningCandidate = null;
      runningProgress = null;
      if (outcome === "stopped") {
        result.stoppedBy = "stopped";
        break;
      }
      if (outcome === "no-credentials") {
        result.stoppedBy = "credentials_missing";
        break;
      }
      // The library closed or the session was replaced under the run (a re-open, a sign-in again): the download was
      // cut, not the video's fault. Nothing counts and nothing waits; the same video comes first on the next pass,
      // kicked by the library opening again (or shortly, when it already has).
      const libraryClosed = !deps.libraryDb.isOpen();
      if (outcome === "interrupted" || (outcome === "failed" && (libraryClosed || deps.resolveToken() !== token))) {
        log("[preview-catch-up] video.interrupted", { ...base, outcome, libraryClosed, step: stoppedIn });
        result.stoppedBy = libraryClosed ? "library_closed" : "interrupted";
        if (!libraryClosed) scheduleKick("resume", kickDelayMs);
        break;
      }
      if (outcome === "yielded" && cancelRequested === candidate.formatId) {
        // The user cancelled it (MPV-PREV-07): not a failure and not a try; the pass goes on with the next video.
        cancelRequested = null;
        log("[preview-catch-up] video.cancelled", { ...base, step: stoppedIn });
        continue;
      }
      if (outcome === "yielded") {
        // Not a failure: the video starts over on a later pass.
        log("[preview-catch-up] video.yielded", base);
        result.stoppedBy = "yielded";
        break;
      }
      if (outcome === "unreachable") {
        // An outage, not the video's fault: its count stays, and the next pass after the offline wait tries it again.
        log("[preview-catch-up] video.unreachable", { ...base, failures: state.formats[candidate.formatId]?.failures ?? 0 });
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
        if (outcome === "recorded") {
          result.recorded += 1;
          const endedAt = now();
          const picturesAt = stepAt.pictures;
          const soundAt = stepAt.sound;
          log("[preview-catch-up] video.recorded", {
            ...base,
            downloadMs: (picturesAt ?? soundAt ?? endedAt) - videoStartedAt,
            picturesMs: picturesAt === undefined ? 0 : (soundAt ?? endedAt) - picturesAt,
            soundMs: soundAt === undefined ? 0 : endedAt - soundAt,
            totalMs: endedAt - videoStartedAt,
          });
        }
        if (state.formats[candidate.formatId]) {
          delete state.formats[candidate.formatId];
          writeState(userId, state);
        }
        continue;
      }
      result.failed += 1;
      failuresInARow += 1;
      const failures = (state.formats[candidate.formatId]?.failures ?? 0) + 1;
      const step = stoppedIn === null ? "download" : "read";
      state.formats[candidate.formatId] = { failures, lastFailedAt: new Date(now()).toISOString(), step };
      writeState(userId, state);
      log("[preview-catch-up] video.failed", { ...base, failures, maxAttempts, step, giveUp: failures >= maxAttempts });
      if (failuresInARow >= maxConsecutiveFailures) {
        // Each counts (outages are caught by the backend check and the run itself); the rest wait for a later pass.
        result.stoppedBy = "failures";
        break;
      }
    }
    result.ms = now() - startedAt;
    lastStoppedBy = result.stoppedBy;
    // The list ran dry: the first time, or again after this pass made new videos (a later import).
    if (result.stoppedBy === null && (finishedAt === null || result.processed > 0)) {
      finishedAt = new Date(now()).toISOString();
    }
    log("[preview-catch-up] pass.done", { ...result });
    if (result.stoppedBy === "offline") {
      offlineStreak += 1;
      const delayMs = Math.min(offlineRetryMs * 2 ** (offlineStreak - 1), idleIntervalMs);
      // A kick armed meanwhile (the player closed, a manual retry) already brings the next pass.
      if (!kickTimer) scheduleKick("offline_retry", delayMs);
    } else {
      offlineStreak = 0;
    }
    if (result.stoppedBy === "ingest_busy" || (result.stoppedBy === "yielded" && (await importsBusy()))) waitForImports();
    return result;
  };

  /**
   * MPV-PREV-07, imports always first: a pass that gave way to an import resumes as soon as every import is done
   * (its ingest jobs and its own preview run) and no playback runs, rather than at the next idle tick.
   */
  const waitForImports = () => {
    if (stopped || importWaitTimer) return;
    log("[preview-catch-up] imports.waiting", { pollMs: importWaitPollMs });
    let checking = false;
    importWaitTimer = setInterval(() => {
      if (checking) return;
      checking = true;
      void importsBusy()
        .then((busy) => {
          if (busy || stopped || deps.isPlaybackActive() || !importWaitTimer) return;
          clearInterval(importWaitTimer);
          importWaitTimer = null;
          scheduleKick("imports_done", kickDelayMs);
        })
        .catch((error: unknown) => log("[preview-catch-up] imports.check_failed", { error: error instanceof Error ? error.message : String(error) }))
        .finally(() => {
          checking = false;
        });
    }, importWaitPollMs);
    importWaitTimer.unref?.();
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
        runningCandidate = null;
        runningProgress = null;
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
      log("[preview-catch-up] worker.start", { startDelayMs, idleIntervalMs, kickDelayMs, offlineRetryMs, afterPlaybackDelayMs, retryAfterMs, maxAttempts, heavySourceBytes, playbackActive });
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
    async catchUpStatus() {
      const userId = deps.resolveUserId();
      if (!userId || !deps.libraryDb.isOpen()) {
        return { state: "done", retryAt: null, handled: 0, total: 0, current: null, failed: [], cancelled: [], videos: [], finishedAt };
      }
      const owed = (await deps.libraryDb.call("listPreviewSheetCandidates", [
        { limit: Number.MAX_SAFE_INTEGER, excludeFormatIds: [] },
      ])) as PreviewSheetCandidate[];
      const total = (await deps.libraryDb.call("countPreviewSheetVideos")) as number;
      const library = (await deps.libraryDb.call("listSkipCatchUpVideos")) as SkipCatchUpVideo[];
      const stored = readState(userId);
      const retry = stored.formats;
      const cancelledIds = new Set(Object.keys(stored.cancelled ?? {}));
      const dismissedIds = new Set(Object.keys(stored.dismissed ?? {}));
      const video = (row: PreviewSheetCandidate) => ({
        formatId: row.formatId,
        mediaId: row.mediaId,
        season: row.season,
        episode: row.episode,
      });
      const failed = owed.filter((row) => (retry[row.formatId]?.failures ?? 0) >= maxAttempts).map(video);
      const failedIds = new Set(failed.map((row) => row.formatId));
      const remaining = owed.filter((row) => !failedIds.has(row.formatId) && !cancelledIds.has(row.formatId));
      // A video waiting out its hour stays owed but is not next: the pass leaves it out until then.
      const at = now();
      const heldUntilById = new Map<string, number>();
      for (const row of remaining) {
        const until = heldUntil(retry[row.formatId], at);
        if (until !== null) heldUntilById.set(row.formatId, until);
      }
      const eligible = remaining.filter((row) => !heldUntilById.has(row.formatId));
      const running = runningCandidate;
      const progress = running ? runningProgress : null;
      const next = running ?? eligible[0] ?? null;
      const state: BadgerPreviewsCatchUp["state"] =
        remaining.length === 0
          ? "done"
          : !next
            ? "retry_wait"
            : playbackActive
              ? "paused_playback"
              : await importsBusy()
                ? "paused_import"
                : lastStoppedBy === "offline"
                  ? "offline"
                  : "running";
      return {
        state,
        retryAt: state === "retry_wait" ? new Date(Math.min(...heldUntilById.values())).toISOString() : null,
        handled: Math.max(0, total - remaining.length),
        total,
        current:
          next && state !== "done"
            ? {
                ...video(next),
                running: running !== null,
                phase: progress?.phase ?? null,
                downloaded: catchUpVideoDownloaded(progress),
                downloadedBytes: progress ? Math.min(progress.doneBytes, progress.totalBytes) : 0,
                totalBytes: progress?.totalBytes ?? 0,
                progress: catchUpVideoProgress(progress),
              }
            : null,
        failed,
        cancelled: owed.filter((row) => cancelledIds.has(row.formatId) && !failedIds.has(row.formatId)).map(video),
        videos: listVideos({ library, owed, failedIds, running, retry, cancelledIds, dismissedIds, heldUntil: heldUntilById }),
        finishedAt: remaining.length === 0 ? finishedAt : null,
      };
    },
    retry(formatId) {
      const userId = deps.resolveUserId();
      if (!userId) return 0;
      const state = readState(userId);
      const pick = (record: Record<string, unknown>) =>
        formatId === null ? Object.keys(record) : Object.keys(record).filter((id) => id === formatId);
      const ids = pick(state.formats);
      for (const id of ids) delete state.formats[id];
      const uncancelled = pick(state.cancelled ?? {});
      for (const id of uncancelled) delete state.cancelled![id];
      // A video tried again shows in the Jobs history again, even if it was removed from it while left out.
      const undismissed = [...ids, ...uncancelled].filter((id) => state.dismissed?.[id] !== undefined);
      for (const id of undismissed) delete state.dismissed![id];
      if (ids.length + uncancelled.length > 0) writeState(userId, state);
      log("[preview-catch-up] retry", { formatId, reset: ids.length, uncancelled: uncancelled.length });
      scheduleKick("manual", kickDelayMs);
      return new Set([...ids, ...uncancelled]).size;
    },
    setVideo(formatId, action) {
      const userId = deps.resolveUserId();
      if (!userId) return false;
      const state = readState(userId);
      const at = new Date(now()).toISOString();
      if (action === "cancel") {
        state.cancelled = { ...state.cancelled, [formatId]: at };
        if (runningCandidate?.formatId === formatId) cancelRequested = formatId;
      } else {
        state.dismissed = { ...state.dismissed, [formatId]: at };
      }
      writeState(userId, state);
      log("[preview-catch-up] video.set", { formatId, action, running: runningCandidate?.formatId === formatId });
      return true;
    },
    async stop() {
      stopped = true;
      clearTimeout(startTimer ?? undefined);
      clearTimeout(kickTimer ?? undefined);
      clearInterval(idleTimer ?? undefined);
      clearInterval(importWaitTimer ?? undefined);
      startTimer = kickTimer = idleTimer = importWaitTimer = null;
      kickReason = null;
      await current;
      log("[preview-catch-up] worker.stopped", {});
    },
  };
};
