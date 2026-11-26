import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isTerminalIngestJobStatus, type IngestJobRecord, type IngestJobStatus } from "@space/runtime-jobs";
import { createEngineV2, type EngineV2, type StepHandlerCtx } from "@space/runtime-jobs-engine/engineV2";
import {
  createParrotImportSession,
  type ParrotImportOptions,
  type ParrotImportResult,
  type ParrotImportSession,
  type ParrotLightCopyMade,
  type ParrotSongProbe,
  type ParrotStoredOriginal,
} from "./importer";

type TrackFileChunkRow = Awaited<ReturnType<ParrotImportSession["uploadLight"]>>[number];

/**
 * PAR-UP-13: each picked song of an import is two jobs on the shared job engine (the one Badger's runtime runs,
 * `@space/runtime-jobs-engine`), with the same lanes, caps and host clamp (INGS-JOBS-01/02, RT-JOBS-02):
 * - its `source` job: probe → identify → extract → upload → commit (the song in the library, published);
 * - its `format` job, variant `light` (PAR-FMT-02), child of the source job: transcode → upload → commit. Its
 *   transcode starts once the song's extract is done and its upload once the song's own upload is done
 *   (PARENT_STEP_GATE); a light copy that fails never fails its song.
 * Songs run side by side within the lane caps, so one song's lookup, encode or slow upload no longer holds the next.
 */
export const PARROT_IMPORT_APP = "parrot" as const;
export const PARROT_LIGHT_VARIANT = "light";

/** What a Parrot import job carries: the picked file and the import (group) it belongs to. */
export type ParrotImportJobPayload = { userId: string; importId: string; file: string; index: number };

export const parrotImportJobPayload = (job: IngestJobRecord): ParrotImportJobPayload => job.payload as unknown as ParrotImportJobPayload;

const baseRecord = (now: string) => ({
  app: PARROT_IMPORT_APP,
  status: "queued" as IngestJobStatus,
  stageCode: "queued",
  stageLabel: "Queued",
  progress: { mode: "fraction" as const, completed: 0, total: 100, unit: "percent" as const },
  progressPct: 0,
  outputs: {},
  errorCode: null,
  errorMessage: null,
  retryable: false,
  cancelRequested: false,
  dedupeKey: null,
  createdAt: now,
  updatedAt: now,
  startedAt: null,
  finishedAt: null,
  dismissedAt: null,
  uploadSpeedBytesPerSec: null,
  priority: 0,
});

/** The source job of one picked song and, when `light`, its light-copy job. */
export const parrotImportJobs = (input: { userId: string; importId: string; file: string; index: number; light: boolean; now?: string }): IngestJobRecord[] => {
  const now = input.now ?? new Date().toISOString();
  const payload: ParrotImportJobPayload = { userId: input.userId, importId: input.importId, file: input.file, index: input.index };
  const sourceId = crypto.randomUUID();
  const source: IngestJobRecord = {
    ...baseRecord(now),
    jobId: sourceId,
    kind: "source",
    lane: "source",
    groupId: input.importId,
    mediaId: `${input.importId}:${input.index}`,
    variant: null,
    parentJobIds: [],
    payload: { ...payload },
  };
  if (!input.light) return [source];
  const light: IngestJobRecord = {
    ...baseRecord(now),
    jobId: crypto.randomUUID(),
    kind: "format",
    lane: "format",
    groupId: input.importId,
    mediaId: `${input.importId}:${input.index}`,
    variant: PARROT_LIGHT_VARIANT,
    parentJobIds: [sourceId],
    payload: { ...payload },
  };
  return [source, light];
};

const stepOutputs = async <T>(engine: EngineV2, jobId: string, kind: string, key: string): Promise<T> => {
  const found = await engine.get(jobId);
  const step = found?.steps.find((candidate) => candidate.kind === kind);
  const value = (step?.outputs as Record<string, unknown> | undefined)?.[key];
  if (value === undefined) throw new Error(`job ${jobId} has no ${kind} ${key}`);
  return value as T;
};

const probeOf = (engine: EngineV2, job: IngestJobRecord) =>
  stepOutputs<ParrotSongProbe>(engine, job.kind === "source" ? job.jobId : (job.parentJobIds[0] ?? ""), "probe", "probe");

/**
 * Runs Parrot import steps on `engine`. `sessionFor` answers the open import session of a job's import (the desktop
 * reopens it for jobs resumed after a restart, RT-LIFE-04); `lightCopyPath` is where a job's light copy waits for its upload.
 */
export const registerParrotImportHandlers = (
  engine: EngineV2,
  sessionFor: (job: IngestJobRecord) => Promise<ParrotImportSession>,
  lightCopyPath: (job: IngestJobRecord) => string
) => {
  const fileOf = (job: IngestJobRecord) => parrotImportJobPayload(job).file;
  const on = (kind: string, run: (ctx: StepHandlerCtx, session: ParrotImportSession) => Promise<void>) =>
    engine.registerHandler(kind, async (ctx) => {
      if (ctx.job.app !== PARROT_IMPORT_APP) throw new Error(`no ${kind} step for ${ctx.job.app} jobs here`);
      await run(ctx, await sessionFor(ctx.job));
    });

  on("probe", async (ctx, session) => {
    ctx.reportProgress(0, "Reading", "probe");
    ctx.emitOutputs({ probe: await session.probe(fileOf(ctx.job)) });
  });
  on("identify", async (ctx, session) => {
    await session.identify(fileOf(ctx.job), await probeOf(engine, ctx.job));
  });
  on("extract", async (ctx, session) => {
    await session.extract(fileOf(ctx.job), await probeOf(engine, ctx.job));
  });
  on("transcode", async (ctx, session) => {
    ctx.reportProgress(0, "Making the light copy", "transcode");
    const made = await session.transcodeLight(fileOf(ctx.job), await probeOf(engine, ctx.job), lightCopyPath(ctx.job), ctx.signal);
    ctx.emitOutputs({ made });
  });
  on("upload", async (ctx, session) => {
    const probe = await probeOf(engine, ctx.job);
    if (ctx.job.kind === "source") {
      ctx.reportProgress(0, "Uploading", "upload");
      const stored = await session.upload(fileOf(ctx.job), probe, ctx.signal, (fraction) => ctx.reportProgress(Math.round(fraction * 100), "Uploading", "upload"));
      ctx.emitOutputs({ stored });
      return;
    }
    const made = await stepOutputs<ParrotLightCopyMade | null>(engine, ctx.job.jobId, "transcode", "made");
    if (made) {
      ctx.reportProgress(0, "Uploading the light copy", "upload");
      ctx.emitOutputs({ chunks: await session.uploadLight(made, ctx.signal) });
    } else ctx.emitOutputs({ chunks: null });
    session.lightReady(ctx.job.jobId);
  });
  on("commit", async (ctx, session) => {
    const probe = await probeOf(engine, ctx.job);
    if (ctx.job.kind === "source") {
      ctx.reportProgress(0, "Adding to the library", "commit");
      const stored = await stepOutputs<ParrotStoredOriginal | null>(engine, ctx.job.jobId, "upload", "stored");
      ctx.emitOutputs({ outcome: await session.commit(ctx.job.jobId, fileOf(ctx.job), probe, stored, ctx.signal) });
      return;
    }
    const made = await stepOutputs<ParrotLightCopyMade | null>(engine, ctx.job.jobId, "transcode", "made");
    if (!made) {
      ctx.emitOutputs({ outcome: "none" });
      return;
    }
    ctx.reportProgress(0, "Adding the light copy", "commit");
    const chunks = await stepOutputs<TrackFileChunkRow[]>(engine, ctx.job.jobId, "upload", "chunks");
    await session.commitLight(ctx.job.jobId, fileOf(ctx.job), probe, made, chunks);
    ctx.emitOutputs({ outcome: "made" });
  });
};

const TERMINAL_EVENTS: Record<string, true> = { "runtime.jobs.succeeded": true, "runtime.jobs.failed": true, "runtime.jobs.cancelled": true };

/** What the import session keeps of one of its jobs. */
const sessionJobOf = (job: IngestJobRecord) => ({ file: parrotImportJobPayload(job).file, light: job.kind === "format", parentId: job.parentJobIds[0] ?? null });

/**
 * Follows the submitted jobs of one import on `engine` until each ends: tells the session, and for each song's own job counts
 * its outcome. A job that ended and is tried again (`engine.retry`, the row's "Try again", UX-JOBS-02) before the last
 * one ends is followed again, its failure no longer counted. Resolves once every job has ended.
 */
export const followParrotImportJobs = async (engine: EngineV2, session: ParrotImportSession, jobs: readonly IngestJobRecord[]): Promise<void> => {
  const live = new Set(jobs.map((job) => job.jobId));
  const byId = new Map(jobs.map((job) => [job.jobId, job]));
  const { promise: allEnded, resolve } = Promise.withResolvers<void>();
  let over = false;
  // Each job's last end, still being counted: a retry of it waits for that count first.
  const counting = new Map<string, Promise<void>>();
  const count = async (job: IngestJobRecord) => {
    const found = await engine.get(job.jobId);
    if (found && !isTerminalIngestJobStatus(found.job.status)) {
      // Tried again before its end was counted: it is running again, nothing to count.
      live.add(job.jobId);
      return;
    }
    session.jobEnded(job.jobId);
    if (job.kind === "source") {
      const outcome = (found?.steps.find((step) => step.kind === "commit")?.outputs as { outcome?: "imported" | "skipped" } | undefined)?.outcome;
      session.songEnded(
        parrotImportJobPayload(job).file,
        found?.job.status === "succeeded" && outcome ? outcome : { error: found?.job.errorMessage ?? found?.job.status ?? "the job is gone" }
      );
    } else if (found?.job.status === "failed") {
      session.log(`[parrot-light-copy] ${parrotImportJobPayload(job).file}: light copy not made (${found.job.errorMessage}); the backfill tries again`);
    }
    if (!live.size) {
      over = true;
      resolve();
    }
  };
  const ended = (jobId: string): Promise<void> | undefined => {
    if (!live.delete(jobId)) return;
    const counted = count(byId.get(jobId)!);
    counting.set(jobId, counted);
    return counted;
  };
  const triedAgain = async (jobId: string) => {
    const job = byId.get(jobId);
    if (!job || over || live.has(jobId)) return;
    live.add(jobId);
    await counting.get(jobId);
    session.track(jobId, sessionJobOf(job));
    if (job.kind === "source") session.songRetried(parrotImportJobPayload(job).file);
  };
  const unsubscribe = engine.subscribe((event) => {
    if (TERMINAL_EVENTS[event.event]) void ended(event.jobId);
    else if (event.event === "runtime.jobs.created") void triedAgain(event.jobId);
  });
  try {
    // Jobs that ended before the subscription (or a resumed import's jobs already done).
    for (const job of jobs) {
      const found = await engine.get(job.jobId);
      if (!found || isTerminalIngestJobStatus(found.job.status)) await ended(job.jobId);
    }
    if (live.size) await allEnded;
  } finally {
    unsubscribe();
  }
};

export type ParrotImportEngineOptions = {
  /** Lane caps (`sourceCap`/`encodeCap`/`uploadCap`), as Badger's runtime defaults when omitted. */
  sourceCap?: number;
  encodeCap?: number;
  uploadCap?: number;
  /** Effective CPUs (the host clamp of the lane caps, as Badger's); omitted = `os.availableParallelism()`. */
  hostCpuCount?: number;
};

/**
 * Runs one import on `engine` to its end: submits each picked song's jobs (or follows `resumed`, the jobs of an import
 * Parrot quit in the middle of, RT-LIFE-04), tells `session` as each ends, then publishes what is left and closes the
 * session. Aborting `signal` (the user's stop) cancels every job of the import; stopping the engine (Parrot quitting)
 * does not: the jobs stay queued for the next start. The result lists files in the picked order.
 */
export const runParrotImport = async (input: {
  engine: EngineV2;
  session: ParrotImportSession;
  userId: string;
  importId: string;
  files: readonly string[];
  light: boolean;
  signal?: AbortSignal;
  resumed?: readonly IngestJobRecord[];
}): Promise<ParrotImportResult> => {
  const { engine, session, signal } = input;
  const jobs =
    input.resumed ?? input.files.flatMap((file, index) => parrotImportJobs({ userId: input.userId, importId: input.importId, file, index, light: input.light }));
  for (const job of jobs) session.track(job.jobId, sessionJobOf(job));
  const cancelAll = () => {
    for (const job of jobs) void engine.cancel(job.jobId, "import-cancelled").catch(() => undefined);
  };
  try {
    signal?.throwIfAborted();
    signal?.addEventListener("abort", cancelAll, { once: true });
    if (!input.resumed) for (const job of jobs) await engine.submit(job);
    await followParrotImportJobs(engine, session, jobs);
    signal?.throwIfAborted();
    const result = await session.finish(signal);
    const order = new Map(input.files.map((file, index) => [file, index]));
    const byIndex = (a: string, b: string) => (order.get(a) ?? 0) - (order.get(b) ?? 0);
    result.imported.sort(byIndex);
    result.skipped.sort(byIndex);
    result.failed.sort((a, b) => byIndex(a.file, b.file));
    return result;
  } finally {
    signal?.removeEventListener("abort", cancelAll);
    session.close();
  }
};

/**
 * Imports picked audio files into the account's Parrot library (PAR-UP-01): each song's jobs run on a job engine of
 * their own for this call (the desktop runs the import on its lasting engine instead, so it resumes after a restart).
 */
export const importParrotFiles = async (
  files: readonly string[],
  options: ParrotImportOptions & { engine?: ParrotImportEngineOptions }
): Promise<ParrotImportResult> => {
  options.signal?.throwIfAborted();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "parrot-import-"));
  const sizes = await Promise.all(files.map((file) => fs.stat(file).then((stat) => stat.size, () => 0)));
  const session = createParrotImportSession(files, { ...options, sizes });
  const engine = createEngineV2({
    dbPath: path.join(dir, "jobs.sqlite"),
    validateEvents: false,
    hostCpuCount: options.engine?.hostCpuCount ?? os.availableParallelism(),
    ...(options.engine?.sourceCap ? { sourceCap: options.engine.sourceCap } : {}),
    ...(options.engine?.encodeCap ? { encodeCap: options.engine.encodeCap } : {}),
    ...(options.engine?.uploadCap ? { uploadCap: options.engine.uploadCap } : {}),
  });
  try {
    await session.open();
    registerParrotImportHandlers(engine, async () => session, (job) => path.join(dir, `${job.jobId}.light`));
    await engine.start();
    return await runParrotImport({
      engine,
      session,
      userId: options.userId,
      importId: crypto.randomUUID(),
      files,
      light: Boolean(options.makeLightCopy),
      signal: options.signal,
    });
  } finally {
    session.close();
    await engine.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
};
