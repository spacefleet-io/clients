/**
 * Feature-flagged "v2" runtime jobs engine. Net-new wiring; the legacy
 * engine.ts/scheduler.ts/store.ts remain the source of truth for the rest
 * of the runtime until Phase D cuts over Badger ingest.
 *
 * Composition:
 *   - {@link createSqliteRuntimeJobsStore}  durable jobs + steps
 *   - {@link createEventLog} + {@link createSqliteEventLogDeps}  event ring buffer
 *   - {@link cancelJobCascade} + per-job AbortController registry  cancellation
 *   - {@link tryReserveLane}  lane semaphore (source/format/upload)
 *
 * No I/O outside the supplied SQLite database. No HTTP. No module wiring.
 * The runtime command surface (badger module, IPC bridge) is Phase D and is
 * NOT touched here — engineV2 is purely callable from a host that owns its
 * lifecycle.
 */

import {
  isTerminalIngestJobStatus,
  resolveTerminalCAS,
  type IngestJobKind,
  type IngestJobLane,
  type IngestJobRecord,
  type IngestJobStatus,
} from "@space/runtime-jobs";
import { runtimeJobsEventSchema } from "@space/runtime-contracts/runtime/jobs";
import {
  cancelJobCascade,
  type CancelDeps,
} from "./cancellation";
import { createEventLog, type EventRow } from "./eventLog";
import { createSqliteEventLogDeps } from "./sqliteEventLogDeps";
import {
  abandonPreparedSqliteRuntimeJobsStore,
  createSqliteRuntimeJobsStore,
  prepareSqliteRuntimeJobsStore,
  type SqliteJobFilter,
  type SqliteRuntimeJobsStore,
} from "./sqliteStore";
import type { StoredStepRecord } from "./stepStore";
import {
  createLaneState,
  clampLaneCapsForHost,
  DEFAULT_LANE_CAPS,
  maxLaneCapsForHost,
  releaseLane,
  tryReserveLane,
  type LaneCaps,
  type LaneState,
} from "./engineV2Lanes";
import {
  createRunnableSet,
  type RunnableBucketKey,
  type RunnableSet,
  type RunnableSetStats,
} from "./engineV2Runnable";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export type RuntimeJobEvent = {
  eventId: number;
  jobId: string;
  event: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export interface EngineV2Config {
  dbPath: string;
  encodeCap?: number;
  uploadCap?: number;
  sourceCap?: number;
  /**
   * Effective CPUs usable by this process (`getEffectiveCpuCount()` from
   * `@space/ffmpeg/hostCpu`: availableParallelism, clamped on Linux by the
   * Cpus_allowed_list affinity mask and a cgroup v2 `cpu.max` quota). When set, the `format` and `source`
   * lane caps are clamped to what that many cores can run without starving
   * playback (see `maxLaneCapsForHost`), both at construction and on every
   * `setLaneCaps` call — a user setting of "3 parallel transcodes" on a
   * 4-core machine is honoured as 1. Omitted = no host clamp (tests).
   */
  hostCpuCount?: number;
  /** Where `hostCpuCount` came from (`availableParallelism` / `cpus-allowed-list` / `cgroup-cpu.max`); logged only. */
  hostCpuSource?: string;
  progressThrottleMs?: number;
  /**
   * How long finished jobs (with their steps) and job events are kept
   * (default {@link JOB_HISTORY_RETENTION_DAYS} days). Live jobs are never pruned.
   */
  historyRetentionMs?: number;
  /** Gap between retention passes (default one hour); a pass also runs at start. */
  historyPruneIntervalMs?: number;
  /**
   * When true, every emitted event is parsed through `runtimeJobsEventSchema`
   * at the emit boundary and a parse failure throws synchronously. Catches
   * drift between the engine's emit calls and the contract schemas during
   * development. Defaults to true outside `NODE_ENV === "production"`, false
   * in production. Pass an explicit value to override.
   */
  validateEvents?: boolean;
  /**
   * RT-JOBS-07: a job runs only while its account's session is the active one. A submitted job's payload is stamped
   * with the current `apiOrigin()` (when it carries none); a queued job whose `payload.userId` is not
   * `activeUserId()`, or whose `payload.apiOrigin` is not `apiOrigin()`, stays parked until `sessionChanged()`.
   * Jobs without a `payload.userId` are not gated. Omitted = no gate (tests, single-account embedders).
   */
  session?: { activeUserId: () => string | null; apiOrigin: () => string };
}

export type ListFilter = SqliteJobFilter;

export type StepHandlerCtx = {
  job: IngestJobRecord;
  step: StoredStepRecord;
  signal: AbortSignal;
  reportProgress(pct: number, stageLabel?: string, stageCode?: string): void;
  emitOutputs(outputs: Record<string, unknown>): void;
};

export type StepHandler = (ctx: StepHandlerCtx) => Promise<void>;

/** Chris 2026-10-20 (runtime audit, #671 R8): keep 30 days of job history. */
export const JOB_HISTORY_RETENTION_DAYS = 30;
const HISTORY_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
/** Rows deleted per statement; the pass yields to the event loop between batches. */
const HISTORY_PRUNE_JOB_BATCH = 200;
const HISTORY_PRUNE_EVENT_BATCH = 2000;

/**
 * Stage of a job that finished a step and waits for a slot in its next step's
 * lane (#2499). Sent with `status: "queued"` on `runtime.jobs.progress`.
 */
export const WAITING_STAGE_CODE = "waiting";
export const WAITING_STAGE_LABEL = "Waiting";

const ENGINE_SHUTDOWN_MESSAGE = "ENGINE_SHUTDOWN";

/**
 * True when a step's signal was aborted by `stop()` (app quit, guardian
 * SIGTERM): the step is requeued and resumes next boot, so its on-disk work
 * must be kept. Any other abort is a user/parent cancel — the job is terminal.
 */
export const isEngineShutdownAbort = (signal: AbortSignal): boolean =>
  signal.aborted &&
  signal.reason instanceof Error &&
  signal.reason.message === ENGINE_SHUTDOWN_MESSAGE;

/**
 * `runtime.jobs.cancelled` reason re-emitted at boot for a job that was
 * cancelled while a step ran and the process died before that step's handler
 * returned. The job was already cancelled; the event lets app layers clean up
 * what the dead handler left behind.
 */
export const CANCELLED_BEFORE_RESTART_REASON = "cancelled-before-restart";

/**
 * `runtime.jobs.cancelled` reason emitted at boot for a job left `running` by
 * the previous process. The job is NOT cancelled: hydration requeues and
 * resumes it right after, so app layers must keep its outputs.
 */
export const INTERRUPTED_BY_RESTART_REASON = "interrupted-by-restart";

/** How {@link EngineV2.retry} re-runs a job. */
export type RetryOptions = {
  /** `"unfinished"`: re-queue only the steps that did not succeed. `"all"`: re-run every step. */
  steps?: "unfinished" | "all";
  /** Merged onto the job payload before it is queued again. */
  payloadPatch?: Record<string, unknown>;
};

/** Why {@link EngineV2.retry} left a job alone. */
export type RetryRefusal = "not-found" | "not-retryable" | "duplicate-running";

export interface EngineV2 {
  start(): Promise<void>;
  stop(): Promise<void>;
  submit(job: IngestJobRecord): Promise<{ jobId: string }>;
  /**
   * Shallow-merge a payload patch onto an existing job. Used by
   * `badger.ingest.attach_metadata` to thread catalog hints onto a source job
   * mid-flight. Returns the post-merge record, or null if the job is unknown.
   */
  updateJobPayload(
    jobId: string,
    patch: Record<string, unknown>
  ): Promise<IngestJobRecord | null>;
  cancel(jobId: string, reason: string): Promise<{ cancelledIds: string[] }>;
  dismiss(
    jobId: string
  ): Promise<{ dismissed: boolean; errorCode?: string }>;
  /**
   * Run a failed (or parent-cancelled) job again IN PLACE: same jobId, so its
   * kept outputs dir (`<transcode base>/<userId>/<jobId>`) is reused
   * (UX-JOBS-03). `steps: "unfinished"` (default) re-queues only the steps
   * that did not succeed; `"all"` re-runs every step. `payloadPatch` is merged
   * onto the payload first (a moved source file). Children the job's failure
   * cancelled (`parent-cancelled`) are re-queued with every step. Never runs
   * on its own: only a user action calls it.
   */
  retry(
    jobId: string,
    options?: RetryOptions
  ): Promise<{ retried: boolean; newJobId?: string; reason?: RetryRefusal }>;
  list(
    filter?: ListFilter
  ): Promise<{ jobs: IngestJobRecord[]; maxEventId: number }>;
  get(
    jobId: string
  ): Promise<{ job: IngestJobRecord; steps: StoredStepRecord[] } | null>;
  /**
   * Look up an existing job by `(app, dedupeKey)`. Used by ingest handlers
   * to short-circuit duplicate submissions and reuse existing job rows.
   * Returns null when no matching row exists. See
   * `runtime_jobs_app_dedupe_unique_idx`.
   */
  getByDedupe(app: string, dedupeKey: string): Promise<IngestJobRecord | null>;
  registerHandler(kind: string, handler: StepHandler): void;
  subscribe(listener: (event: RuntimeJobEvent) => void): () => void;
  /**
   * Mutate the live lane caps after construction. Each provided value is
   * clamped to an integer `>= 1`; omitted lanes keep their current cap.
   * A `tick()` is run afterwards so a raised cap immediately dispatches any
   * queued jobs that were previously blocked on lane capacity.
   *
   * Used by `badger.ingest.configure_scheduling` to bind the desktop
   * `maxParallelTranscodes` (format lane) and `maxParallelExtractions`
   * (source lane) settings to the engine at runtime.
   *
   * Returns the EFFECTIVE caps after the host clamp (`hostCpuCount`), which
   * can be lower than what was requested.
   */
  setLaneCaps(partial: Partial<LaneCaps>): LaneCaps;
  /**
   * Scheduler diagnostics (#671 R6): how many scheduling passes ran, how many
   * `tick()` calls were folded into a pass already in flight, what sits in the
   * runnable set and what each lane is running. Read-only, cheap.
   */
  schedulerStats(): EngineSchedulerStats;
  /** The signed-in account or API server changed (RT-JOBS-07): parked jobs of the now-active session may start. */
  sessionChanged(): void;
}

export interface EngineSchedulerStats extends RunnableSetStats {
  /** Scheduling passes run (each one looks at the runnable set once). */
  tickPasses: number;
  /** `tick()` calls that arrived while a pass was running and were folded into one more pass. */
  coalescedTicks: number;
  /** Jobs holding a slot in each lane right now. */
  lanesRunning: LaneState;
}

// ---------------------------------------------------------------------------
// Step seeds — derive the canonical step list for each ingest job kind.
//
// Plan §6: source = probe → identify → extract → upload → commit;
//          format = transcode → upload.
// ---------------------------------------------------------------------------

const SOURCE_STEPS = ["probe", "identify", "extract", "upload", "commit"] as const;
const FORMAT_STEPS = ["transcode", "upload", "commit"] as const;
// Phase 7: post-ingest re-transcode jobs. The renderer-driven
// `badger.media.replan_qualities` handler submits a `kind: "format"` job
// with `payload.retranscode === true`. Instead of the ingest-style
// `transcode` step (which expects a local file path), the chain leads
// with `retranscode` — a step that streams encrypted DASH chunks from
// storage, decrypts, and feeds ffmpeg's stdin. After that the existing
// `upload` + `commit` steps are reused unchanged.
const RETRANSCODE_STEPS = ["retranscode", "upload", "commit"] as const;
// Offline downloads (Phase 2 of let-s-talk-about-offline). A single step
// runs the entire fetch-chunks → decrypt → concat-per-track → ffmpeg mux →
// atomic rename → DB insert pipeline. One step (not the source/format
// step ladder) because there is no intermediate state worth resuming across
// process restarts in v1: on cancel/fail the staging dir is wiped and the
// next attempt starts from chunk 0. Lane = "upload" — the step is
// network-heavy (chunk downloads dominate) and shares the upload lane's
// concurrency budget with ingest upload work, which is the right trade-off
// per the plan §B-7.
const OFFLINE_DOWNLOAD_STEPS = ["offline_download"] as const;
// Exports (OFFL-FILE-01 / ACCT-EXPORT-01): one `export_file` step fetches, decrypts, muxes and places a plain file in
// the folder the user picked. Network-heavy like offline saves, so the upload lane too.
const EXPORT_STEPS = ["export_file"] as const;

const stepLaneFor = (kind: string, jobLane: IngestJobLane): IngestJobLane => {
  if (kind === "upload") return "upload";
  if (kind === "offline_download" || kind === "export_file") return "upload";
  if (kind === "transcode" || kind === "retranscode") return "format";
  // probe/identify/extract/commit all share the source lane
  if (jobLane === "format") return "format";
  return "source";
};

/**
 * Step kinds that run without holding a lane slot. `commit` is a sub-second
 * library-DB write (serialised by the library-DB gate, not by the lanes). On
 * a host where the format lane is capped at 1, a finished encode's commit
 * used to queue behind the NEXT job's whole encode: the 2026-10-07 ultimate
 * confirm run (P23) shows 720p commits waiting 4–17 min for the format slot
 * after their encode and upload were already done.
 */
const LANE_EXEMPT_STEP_KINDS: Record<string, true> = { commit: true };

/**
 * Per-step parent gating (#25). A child step normally waits for every parent
 * JOB to succeed. The step kinds listed here only need the named step of each
 * parent to have succeeded, so CPU work does not sit idle behind the parent's
 * network work:
 *   - format `transcode` reads only the local input file. It needs the
 *     source's `extract` done (probe validated the file, local extraction
 *     finished), NOT the source upload — which can take hours on a home
 *     connection.
 *   - format `upload` pushes anonymous encrypted chunks (no media row is
 *     referenced until commit). It waits for the source `upload` so the
 *     source, which is what makes the media playable, keeps network priority.
 *   - everything else (format `commit`, which links to the source's committed
 *     file row) still waits for the whole parent job to succeed.
 * A parent without the named step (not a source job) falls back to the
 * whole-job rule.
 */
const PARENT_STEP_GATE: Record<string, string> = {
  transcode: "extract",
  upload: "upload",
};

/**
 * Parent failure codes that do NOT cascade to children. They are set by an
 * HMR'd engine instance ticking before handlers were registered, or by
 * hydration, and the parent can still recover (2026-05-04 round 4 evidence:
 * source flipped to failed/no-handler at 23:00:12.955, then the in-flight
 * prior instance wrote succeeded at 23:00:14.921). Cascade-cancelling format
 * children off such a parent permanently breaks the job even though the
 * parent ultimately succeeded.
 */
const TRANSIENT_PARENT_FAILURE_CODES: Record<string, true> = {
  "no-handler": true,
  "boot-not-ready": true,
  [INTERRUPTED_BY_RESTART_REASON]: true,
};

/**
 * Cascade only on *permanent* terminal parents. `interrupted` is transient
 * (hydration requeues it), and so is `failed` with a transient errorCode.
 */
const isPermanentlyFailedParent = (parent: IngestJobRecord): boolean => {
  if (parent.status === "cancelled") return true;
  if (parent.status !== "failed") return false;
  return TRANSIENT_PARENT_FAILURE_CODES[parent.errorCode ?? ""] !== true;
};

const isRetranscodeJob = (job: IngestJobRecord): boolean =>
  job.kind === "format" && (job.payload as { retranscode?: unknown })?.retranscode === true;

const seedStepsForJob = (job: IngestJobRecord): StoredStepRecord[] => {
  const now = new Date().toISOString();
  const kinds: readonly string[] =
    job.kind === "source"
      ? SOURCE_STEPS
      : job.kind === "download"
      ? OFFLINE_DOWNLOAD_STEPS
      : job.kind === "export"
      ? EXPORT_STEPS
      : isRetranscodeJob(job)
      ? RETRANSCODE_STEPS
      : FORMAT_STEPS;
  return kinds.map((kind, i): StoredStepRecord => {
    const dependsOn =
      i === 0 ? [] : [`${job.jobId}:${kinds[i - 1]}`];
    return {
      stepId: `${job.jobId}:${kind}`,
      jobId: job.jobId,
      ordinal: i,
      kind,
      status: "queued",
      progressPct: 0,
      errorCode: null,
      errorMessage: null,
      startedAt: null,
      finishedAt: null,
      app: job.app,
      lane: stepLaneFor(kind, job.lane),
      dependsOn,
      payload: {},
      outputs: {},
      createdAt: now,
      updatedAt: now,
    };
  });
};

/** The runnable-set key jobs of another session are parked behind (RT-JOBS-07); `sessionChanged()` wakes it. */
const SESSION_WAKE_KEY = "session:active";

// ---------------------------------------------------------------------------
// Engine factory
// ---------------------------------------------------------------------------

export function createEngineV2(config: EngineV2Config): EngineV2 {
  const caps: LaneCaps = {
    source: config.sourceCap ?? DEFAULT_LANE_CAPS.source,
    format: config.encodeCap ?? DEFAULT_LANE_CAPS.format,
    upload: config.uploadCap ?? DEFAULT_LANE_CAPS.upload,
  };
  const hostCpuCount = config.hostCpuCount;
  const hostMaxCaps = hostCpuCount != null ? maxLaneCapsForHost(hostCpuCount) : null;
  if (hostCpuCount != null) {
    Object.assign(caps, clampLaneCapsForHost(caps, hostCpuCount));
    console.info("[engineV2] host-aware lane caps", {
      hostCpuCount,
      hostCpuSource: config.hostCpuSource ?? "caller",
      caps: { ...caps },
    });
  }
  const progressThrottleMs = config.progressThrottleMs ?? 1000;
  const historyRetentionMs = config.historyRetentionMs ?? JOB_HISTORY_RETENTION_DAYS * 24 * 3_600_000;
  const historyPruneIntervalMs = config.historyPruneIntervalMs ?? HISTORY_PRUNE_INTERVAL_MS;
  const validateEvents =
    config.validateEvents ?? process.env.NODE_ENV !== "production";

  let store: SqliteRuntimeJobsStore | null = null;
  let eventLog: ReturnType<typeof createEventLog> | null = null;
  let started = false;
  let stopping = false;

  const lanes: LaneState = createLaneState();
  const controllers: Map<string, AbortController> = new Map();
  // Abort reason stamped by stop(). Lets a step's catch path tell a runtime
  // shutdown (requeue, resume next boot) apart from a user cancel (terminal).
  const shutdownAbortReason = Object.assign(new Error(ENGINE_SHUTDOWN_MESSAGE), {
    name: "AbortError",
  });
  const lastProgressAt: Map<
    string,
    { ts: number; stageCode: string | null; stageLabel: string | null }
  > = new Map();
  const handlers: Map<string, StepHandler> = new Map();
  const subscribers: Set<(event: RuntimeJobEvent) => void> = new Set();
  /** In-flight handler promises, used by stop() to drain. */
  const inflight: Set<Promise<unknown>> = new Set();
  /**
   * The queued jobs, kept in memory (#671 R6, RT-JOBS-06): ready ones in one
   * ordered bucket per lane, the rest parked behind the parent they wait for.
   * `tick()` reads this instead of listing and re-checking every queued job.
   */
  const runnable: RunnableSet = createRunnableSet();
  /**
   * Jobs a runner just moved to failed/cancelled. Their queued and running
   * children are cancelled on the next tick (a cancel through `cancel()`
   * already cascades by itself and is not listed here).
   */
  const failedParentIds: Set<string> = new Set();
  let ticking = false;
  let tickRequested = false;
  const tickCounters = { passes: 0, coalesced: 0 };

  const requireStore = (): SqliteRuntimeJobsStore => {
    if (!store) throw new Error("engineV2: not started — call start() first");
    return store;
  };

  let pruneTimer: ReturnType<typeof setInterval> | undefined;
  /** The retention pass in flight (single-flight); stop() awaits it before closing the store. */
  let pruning: Promise<void> | null = null;

  /**
   * Drop finished jobs and events older than the retention window, in small
   * batches with a yield between them so a first run over a years-old backlog
   * never blocks HTTP/SSE for long.
   */
  const pruneHistory = async (): Promise<void> => {
    const startedAt = Date.now();
    const cutoffIso = new Date(startedAt - historyRetentionMs).toISOString();
    let jobsDeleted = 0;
    let eventsDeleted = 0;
    try {
      for (;;) {
        if (!store || !eventLog || stopping) break;
        const jobs = store.purgeFinishedBefore(cutoffIso, HISTORY_PRUNE_JOB_BATCH);
        const events = eventLog.trimTerminalsOlderThan(
          historyRetentionMs / 3_600_000,
          HISTORY_PRUNE_EVENT_BATCH
        );
        jobsDeleted += jobs;
        eventsDeleted += events;
        if (jobs < HISTORY_PRUNE_JOB_BATCH && events < HISTORY_PRUNE_EVENT_BATCH) break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } catch (error) {
      console.warn("[engineV2] history prune failed", error);
    }
    if (jobsDeleted > 0 || eventsDeleted > 0) {
      console.info(
        JSON.stringify({
          event: "runtime.jobs.v2.history_pruned",
          retentionDays: Math.round(historyRetentionMs / 86_400_000),
          jobsDeleted,
          eventsDeleted,
          ms: Date.now() - startedAt,
        })
      );
    }
  };

  const runHistoryPrune = (): void => {
    pruning ??= pruneHistory().finally(() => {
      pruning = null;
    });
  };

  const fanoutEvent = (row: EventRow) => {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
    } catch {
      payload = {};
    }
    const event: RuntimeJobEvent = {
      eventId: row.eventId,
      jobId: row.jobId,
      event: row.event,
      payload,
      createdAt: row.createdAt,
    };
    for (const sub of subscribers) {
      try {
        sub(event);
      } catch {
        // Swallow subscriber errors — one bad listener should not poison the
        // bus or stall the engine. Subscribers are responsible for their own
        // error handling.
      }
    }
  };

  /**
   * Emit a canonical, schema-conforming event.
   *
   * `payload` is the per-event body: every field required by the matching
   * variant of `runtimeJobsEventSchema` EXCEPT the envelope fields
   * (`eventId`, `event`, `emittedAt`) which the eventLog row supplies. The
   * stored `payloadJson` therefore round-trips into the wire frame as
   * `{ eventId, emittedAt, event, ...payload }` — flat at the top level, the
   * shape `runtimeJobsEventSchema` parses.
   *
   * When `validateEvents` is enabled, the synthesized full event is parsed
   * through `runtimeJobsEventSchema` here so a bad shape fails fast in dev
   * and tests instead of surfacing later via the strict client.
   */
  const emit = (
    jobId: string,
    name: string,
    payload: Record<string, unknown>
  ) => {
    if (!eventLog) return;
    const row = eventLog.append(jobId, name, payload);
    if (validateEvents) {
      const candidate: Record<string, unknown> = {
        eventId: row.eventId,
        emittedAt: row.createdAt,
        event: row.event,
        ...payload,
      };
      const parsed = runtimeJobsEventSchema.safeParse(candidate);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
          .join("; ");
        throw new Error(
          `engineV2: emitted event '${row.event}' failed schema validation (${issues})`
        );
      }
    }
    fanoutEvent(row);
  };

  // -------------------------------------------------------------------------
  // Status mutation seam used by both the runner and the cancel cascade.
  //
  // CAS semantics: the write only happens when current status is in
  // `fromStatuses`. This is what makes the cancel-vs-success race resolvable
  // (plan §4): the loser of the race observes the terminal already written
  // and bails out without clobbering.
  // -------------------------------------------------------------------------
  const setStatusCAS = (
    jobId: string,
    fromStatuses: IngestJobStatus[],
    toStatus: IngestJobStatus,
    reason?: string,
    errorMessage?: string,
    /** The write comes from the cancel cascade, which already cancels the descendants. */
    viaCascade = false
  ): boolean => {
    const s = requireStore();
    const existing = s.getJob(jobId);
    if (!existing) return false;
    if (!fromStatuses.includes(existing.status)) return false;

    // Apply the resolveTerminalCAS rule so a runner trying to write
    // 'succeeded' after a cancel was requested will be honored only when
    // outputs are durable. Non-terminal targets pass through untouched.
    let effective = toStatus;
    if (
      toStatus === "succeeded" ||
      toStatus === "failed" ||
      toStatus === "cancelled"
    ) {
      const outputsDurable = Boolean(
        (existing.outputs as Record<string, unknown> | undefined)?.durable
      );
      effective = resolveTerminalCAS(
        existing.status,
        toStatus,
        existing.cancelRequested || toStatus === "cancelled",
        outputsDurable
      );
      if (effective === existing.status) return false;
    }

    const errorCode = reason && effective !== "succeeded" ? reason : undefined;
    // Mirror the failure message onto the row so DB-only consumers (logs,
    // diagnostic dumps) see why the job failed without joining against the
    // event log. Only persisted on terminal-failure transitions.
    const persistMessage =
      errorMessage !== undefined && effective !== "succeeded"
        ? errorMessage
        : undefined;
    s.updateJobStatus(jobId, effective, {
      errorCode: errorCode === undefined ? undefined : errorCode,
      errorMessage: persistMessage,
    });
    // Keep the runnable set in step with the row (#671 R6): a job that is
    // queued again must be picked up, a finished one is dropped, and the jobs
    // parked behind this one re-check whether they can start.
    if (effective === "queued") {
      runnable.enqueue(jobId);
    } else if (isTerminalIngestJobStatus(effective)) {
      runnable.forget(jobId);
      if (!viaCascade && (effective === "failed" || effective === "cancelled")) {
        failedParentIds.add(jobId);
      }
    }
    runnable.wake(jobId);
    return true;
  };

  /**
   * Queue a finished job again under its own jobId (UX-JOBS-03 retry). Steps
   * that succeeded keep their status and outputs unless `steps` is `"all"`.
   * Returns false when another live job holds the same dedupe key (the user
   * imported the file again meanwhile): that job does the work.
   */
  const requeueInPlace = (
    job: IngestJobRecord,
    steps: "unfinished" | "all",
    payloadPatch: Record<string, unknown> | undefined
  ): boolean => {
    const s = requireStore();
    const now = new Date().toISOString();
    const fresh: IngestJobRecord = {
      ...job,
      payload: payloadPatch ? { ...job.payload, ...payloadPatch } : job.payload,
      status: "queued",
      stageCode: "queued",
      stageLabel: "Queued",
      progressPct: 0,
      progress: { mode: "fraction", completed: 0, total: 100, unit: "percent" },
      errorCode: null,
      errorMessage: null,
      cancelRequested: false,
      outputs: steps === "all" ? {} : job.outputs,
      startedAt: null,
      finishedAt: null,
      dismissedAt: null,
      updatedAt: now,
      attemptCount: (job.attemptCount ?? 0) + 1,
    };
    const stored = s.upsertJob(fresh);
    if (stored.jobId !== job.jobId) {
      console.info(
        JSON.stringify({ event: "runtime.jobs.v2.retry_duplicate_running", jobId: job.jobId, runningJobId: stored.jobId })
      );
      return false;
    }
    const existing = s.steps.getSteps(job.jobId);
    const seeded = existing.length > 0 ? existing : seedStepsForJob(fresh);
    const kept: string[] = [];
    for (const step of seeded) {
      if (steps === "unfinished" && step.status === "succeeded") {
        kept.push(step.kind);
        continue;
      }
      s.steps.upsertStep({
        ...step,
        status: "queued",
        progressPct: 0,
        errorCode: null,
        errorMessage: null,
        startedAt: null,
        finishedAt: null,
        outputs: {},
        updatedAt: now,
      });
    }
    failedParentIds.delete(job.jobId);
    console.info(
      JSON.stringify({ event: "runtime.jobs.v2.requeued_in_place", jobId: job.jobId, kind: job.kind, steps, keptSteps: kept })
    );
    runnable.enqueue(job.jobId);
    runnable.wake(job.jobId);
    emit(job.jobId, "runtime.jobs.created", { job: s.getJob(job.jobId) ?? fresh });
    return true;
  };

  const buildCancelDeps = (): CancelDeps => ({
    loadJob: (id) => requireStore().getJob(id),
    findChildren: (id) => requireStore().findChildren(id),
    setStatusCAS: (id, from, to, reason) =>
      setStatusCAS(id, from, to, reason, undefined, true),
    abortRunner: (id) => {
      const ctrl = controllers.get(id);
      if (ctrl) ctrl.abort();
    },
  });

  // -------------------------------------------------------------------------
  // Runnable-job pickup (#671 R6, RT-JOBS-06). The legacy scheduler does
  // priority-aware ordering across many lanes; engineV2 keeps it minimal:
  // ready jobs are taken in (priority asc, createdAt asc) order, the order
  // sqliteStore.listJobs uses, from the in-memory runnable set. A job is
  // classified once when it becomes queued (or when a parent it waits for
  // changes), not on every tick.
  // -------------------------------------------------------------------------
  /** Cancel `jobId` (and its own descendants) because a parent failed/cancelled. */
  const cascadeParentCancel = (jobId: string) => {
    const result = cancelJobCascade(jobId, "parent-cancelled", buildCancelDeps());
    for (const id of result.cancelledIds) {
      const fresh = store?.getJob(id);
      if (!fresh) continue;
      emit(id, "runtime.jobs.cancelled", {
        job: fresh,
        reason: "parent-cancelled",
      });
    }
    return result;
  };

  /**
   * Is `parent` far enough along for the child's `stepKind` to run? See
   * {@link PARENT_STEP_GATE}.
   */
  const parentReadyForStep = (parent: IngestJobRecord, stepKind: string): boolean => {
    if (parent.status === "succeeded") return true;
    const gateKind = PARENT_STEP_GATE[stepKind];
    if (gateKind === undefined) return false;
    const gateStep = requireStore()
      .steps.getSteps(parent.jobId)
      .find((s) => s.kind === gateKind);
    return gateStep?.status === "succeeded";
  };

  /** What a queued job can do right now. */
  type JobVerdict =
    | {
        kind: "ready";
        nextStep: StoredStepRecord;
        lane: IngestJobLane;
        holdsLane: boolean;
      }
    | { kind: "wait"; waitsOn: string[] }
    | { kind: "idle" }
    | { kind: "cancelled" };

  /** Why `job` belongs to another session than the active one (RT-JOBS-07), or null. */
  const foreignSessionReason = (job: IngestJobRecord): string | null => {
    const session = config.session;
    if (!session) return null;
    const jobUserId = typeof job.payload?.userId === "string" ? job.payload.userId.trim() : "";
    if (!jobUserId) return null;
    const jobOrigin = typeof job.payload?.apiOrigin === "string" ? job.payload.apiOrigin : null;
    if (jobOrigin && jobOrigin !== session.apiOrigin()) return "other_server";
    if (jobUserId !== session.activeUserId()) return "other_account";
    return null;
  };

  const evaluateJob = (job: IngestJobRecord): JobVerdict => {
    const s = requireStore();
    // Parent-cancel propagation: cascade cancel only when a parent reached
    // a *permanent* terminal state (failed / cancelled). `interrupted` is
    // explicitly excluded — it's a transient state set by hydration when
    // the engine restarted mid-step, and the parent can recover from it
    // (either via the next hydration's interrupted→queued requeue below,
    // or by a CAS race where the still-in-flight runner lands its terminal
    // write after the restart). Cascading on `interrupted` permanently
    // cancelled format children whose source eventually succeeded — see
    // 2026-05-04 hands-on round, source 95209ca6 / format 6bdfa337.
    const parents = job.parentJobIds
      .map((pid) => s.getJob(pid))
      .filter((p): p is IngestJobRecord => p !== null);
    if (parents.some(isPermanentlyFailedParent)) {
      cascadeParentCancel(job.jobId);
      return { kind: "cancelled" };
    }
    if (parents.length < job.parentJobIds.length) {
      // A parent reference we cannot resolve. Treat as not-yet-runnable; it
      // is re-checked when that parent is submitted.
      return { kind: "wait", waitsOn: job.parentJobIds };
    }

    // Find the next runnable step. If none, the job is either fully done
    // (transition to succeeded) or blocked on a step that is already
    // running on another tick — in either case we let the step-completion
    // path drive the transition.
    const found = s.steps.findRunnableSteps(job.jobId);
    if (found.length === 0) return { kind: "idle" };
    const nextStep = found[0]!;
    if (!parents.every((p) => parentReadyForStep(p, nextStep.kind))) {
      // Parents not far enough along for this step.
      return { kind: "wait", waitsOn: job.parentJobIds };
    }
    const foreign = foreignSessionReason(job);
    if (foreign) {
      // RT-JOBS-07: another account's (or server's) job never runs on this session's token and key.
      console.info(
        JSON.stringify({ event: "runtime.jobs.v2.parked_other_session", jobId: job.jobId, kind: job.kind, reason: foreign })
      );
      return { kind: "wait", waitsOn: [SESSION_WAKE_KEY] };
    }
    return {
      kind: "ready",
      nextStep,
      lane: (nextStep.lane as IngestJobLane) ?? job.lane,
      holdsLane: LANE_EXEMPT_STEP_KINDS[nextStep.kind] !== true,
    };
  };

  /** Put a freshly queued (or woken) job where it belongs: a bucket, or behind its parent. */
  const classifyJob = (jobId: string): void => {
    const job = requireStore().getJob(jobId);
    if (!job || job.status !== "queued") {
      runnable.forget(jobId);
      return;
    }
    const verdict = evaluateJob(job);
    if (verdict.kind === "ready") {
      runnable.place(
        jobId,
        job.priority,
        job.createdAt,
        verdict.holdsLane ? verdict.lane : "exempt"
      );
    } else if (verdict.kind === "wait") {
      runnable.park(jobId, verdict.waitsOn);
    } else {
      runnable.forget(jobId);
    }
  };

  /**
   * Running and queued children of a job a runner just failed or cancelled.
   * With per-step gating a format transcode runs while its source is still
   * uploading; if that source then fails or is cancelled, cancel the child NOW
   * so its in-flight handler is aborted (encoder killed) instead of letting the
   * whole encode finish.
   */
  const cascadeFailedParents = (): void => {
    if (failedParentIds.size === 0) return;
    const s = requireStore();
    for (const parentId of [...failedParentIds]) {
      // Removed before it is handled so a cascade write can re-add it; a throw leaves the rest for the next pass.
      failedParentIds.delete(parentId);
      const parent = s.getJob(parentId);
      if (!parent || !isPermanentlyFailedParent(parent)) continue;
      for (const child of s.findChildren(parentId)) {
        if (child.status !== "queued" && child.status !== "running") continue;
        const result = cascadeParentCancel(child.jobId);
        if (child.status !== "running") continue;
        console.info(
          JSON.stringify({
            event: "runtime.jobs.v2.running_child_parent_cancelled",
            jobId: child.jobId,
            parentJobId: parent.jobId,
            parentStatus: parent.status,
            parentErrorCode: parent.errorCode ?? null,
            cancelledIds: result.cancelledIds,
          })
        );
      }
    }
  };

  /** A bucket is worth looking at only while its lane has a free slot. */
  const bucketOpen = (bucket: RunnableBucketKey): boolean =>
    bucket === "exempt" || lanes[bucket] < caps[bucket];

  /**
   * Put every queued job back in the runnable set from the database. Only used
   * after a pass threw: the ids the pass had already taken out of the set would
   * otherwise never be looked at again.
   */
  const resyncRunnable = (s: SqliteRuntimeJobsStore): void => {
    runnable.clear();
    for (const job of s.listJobs({ status: ["queued"] })) runnable.enqueue(job.jobId);
  };

  const tickPass = () => {
    if (!store || !eventLog || stopping) return;
    tickCounters.passes += 1;
    try {
      runPass(store);
    } catch (error) {
      resyncRunnable(store);
      throw error;
    }
  };

  const runPass = (store: SqliteRuntimeJobsStore) => {
    cascadeFailedParents();
    for (const jobId of runnable.drainIncoming()) classifyJob(jobId);

    // Start ready jobs, best first, until every lane is full (a full lane's
    // bucket is not even looked at) or nothing is ready.
    for (;;) {
      const entry = runnable.peek(bucketOpen);
      if (!entry) break;
      runnable.consume(entry);
      const job = store.getJob(entry.jobId);
      if (!job || job.status !== "queued") {
        runnable.forget(entry.jobId);
        continue;
      }
      // Re-check at dispatch: the classification may be a tick old.
      const verdict = evaluateJob(job);
      if (verdict.kind === "wait") {
        runnable.park(job.jobId, verdict.waitsOn);
        continue;
      }
      if (verdict.kind !== "ready") {
        runnable.forget(job.jobId);
        continue;
      }
      const { nextStep, lane, holdsLane } = verdict;
      if (holdsLane && !tryReserveLane(lanes, lane, caps)) {
        runnable.enqueue(job.jobId);
        continue;
      }
      const releaseStepLane = () => {
        if (holdsLane) releaseLane(lanes, lane);
      };

      // Mark running and dispatch.
      const wrote = setStatusCAS(job.jobId, ["queued"], "running");
      if (!wrote) {
        releaseStepLane();
        continue;
      }
      // setStatusCAS → store.updateJobStatus auto-stamps startedAt the first
      // time the job transitions to running. Re-read for the canonical event.
      const startedJob = store.getJob(job.jobId) ?? job;
      emit(job.jobId, "runtime.jobs.started", {
        jobId: startedJob.jobId,
        groupId: startedJob.groupId,
        kind: startedJob.kind,
        variant: startedJob.variant,
        startedAt: startedJob.startedAt ?? new Date().toISOString(),
      });

      const ctrl = new AbortController();
      controllers.set(job.jobId, ctrl);

      const handler = handlers.get(nextStep.kind);
      if (!handler) {
        // Known badger step kinds may legitimately have no handler if tick()
        // raced ahead of `registerBadgerStepHandlers()` during boot or HMR.
        // Roll the job back to queued (no terminal write) so a subsequent
        // tick — once handlers are registered — picks it up. Unknown kinds
        // are still hard-failed so genuine misconfig surfaces fast.
        const KNOWN_BADGER_KINDS = new Set([
          "probe",
          "identify",
          "extract",
          "transcode",
          "upload",
          "commit",
          "offline_download",
          "export_file",
        ]);
        if (KNOWN_BADGER_KINDS.has(nextStep.kind)) {
          console.warn(
            `[engineV2] handler for known step kind '${nextStep.kind}' not yet registered — leaving job ${job.jobId} queued`
          );
          setStatusCAS(job.jobId, ["running"], "queued");
          releaseStepLane();
          controllers.delete(job.jobId);
          continue;
        }
        store.steps.updateStepStatus(nextStep.stepId, "failed", {
          errorCode: "no-handler",
          errorMessage: `no handler registered for step kind '${nextStep.kind}'`,
          finishedAt: new Date().toISOString(),
        });
        setStatusCAS(job.jobId, ["running"], "failed", "no-handler");
        releaseStepLane();
        controllers.delete(job.jobId);
        const failedJob = store.getJob(job.jobId);
        if (failedJob) {
          emit(job.jobId, "runtime.jobs.failed", {
            job: failedJob,
            errorCode: "no-handler",
            errorMessage: `no handler registered for step kind '${nextStep.kind}'`,
          });
        }
        continue;
      }

      store.steps.updateStepStatus(nextStep.stepId, "running", {
        startedAt: new Date().toISOString(),
      });
      lastProgressAt.set(job.jobId, { ts: 0, stageCode: null, stageLabel: null });

      const ctx: StepHandlerCtx = {
        job,
        step: nextStep,
        signal: ctrl.signal,
        reportProgress: (pct, stageLabel, stageCode) => {
          if (!store) return;
          // CAS guard: a still-in-flight handler (e.g. ffmpeg runner) can
          // fire a progress emit AFTER the row has been written to a
          // terminal status by cancel / fail / succeed on another path.
          // Without this guard the progress write flips status back to
          // running and the user's cancel disappears from the UI.
          // (Bug E2 round 5: cancel followed by a 347ms-late ffmpeg
          //  progress event resurrected status=running, progress=99.)
          const current = store.getJob(job.jobId);
          if (
            current &&
            (current.status === "cancelled" ||
              current.status === "failed" ||
              current.status === "succeeded" ||
              current.status === "interrupted")
          ) {
            console.warn(
              `[engineV2] progress write rejected for job ${job.jobId} (terminal: ${current.status})`
            );
            return;
          }
          const clamped = Math.max(0, Math.min(100, Math.round(pct)));
          const last = lastProgressAt.get(job.jobId) ?? {
            ts: 0,
            stageCode: null,
            stageLabel: null,
          };
          const now = Date.now();
          const incomingStageCode = stageCode ?? null;
          const incomingStageLabel = stageLabel ?? null;
          // Bypass the throttle on ANY stage transition — `stageCode` change
          // (e.g. transcoding → uploading) AND `stageLabel` change within the
          // same code (e.g. "Uploading" → "Uploaded"). The label-only case
          // matters for the upload step's terminal
          // `reportProgress(100, "Uploaded", "uploading")`: with the no-op
          // upload step in deps-adapter (legacy processMediaJob has already
          // uploaded during transcode), the whole upload step runs in
          // microseconds, so the 100% emit was previously eaten by the
          // 1-second throttle and the UI stayed pinned on "Uploading 1%"
          // until commit eventually ran. Same shape applies to transcode's
          // terminal "Transcoded" emit.
          const stageCodeChanged =
            incomingStageCode !== null &&
            incomingStageCode !== last.stageCode;
          const stageLabelChanged =
            incomingStageLabel !== null &&
            incomingStageLabel !== last.stageLabel;
          const stageChanged = stageCodeChanged || stageLabelChanged;
          if (stageChanged || now - last.ts >= progressThrottleMs) {
            lastProgressAt.set(job.jobId, {
              ts: now,
              stageCode: incomingStageCode ?? last.stageCode,
              stageLabel: incomingStageLabel ?? last.stageLabel,
            });
            // Row writes ride the same throttle as the event (#671 R8): an
            // unthrottled write per ffmpeg tick cost ~32 KB of WAL each. The
            // terminal step write below does not depend on this one.
            store.steps.updateStepStatus(nextStep.stepId, "running", {
              progressPct: clamped,
            });
            store.updateJobStatus(job.jobId, "running", {
              progressPct: clamped,
              ...(stageLabel ? { stageLabel } : {}),
              ...(stageCode ? { stageCode } : {}),
            });
            const fresh = store.getJob(job.jobId);
            const resolvedStageCode =
              stageCode ?? fresh?.stageCode ?? job.stageCode;
            const resolvedStageLabel =
              stageLabel ?? fresh?.stageLabel ?? job.stageLabel;
            // Round 7: include the live status so a renderer that mounted
            // mid-flight (or missed the `started` event on the wire) can
            // refresh per-job badge state from progress alone. Schema
            // declares `status` optional, so consumers must preserve their
            // existing `status` when this is undefined.
            const resolvedStatus = fresh?.status ?? job.status;
            emit(job.jobId, "runtime.jobs.progress", {
              jobId: job.jobId,
              groupId: job.groupId,
              progressPct: clamped,
              stageCode: resolvedStageCode,
              stageLabel: resolvedStageLabel,
              uploadSpeedBytesPerSec:
                fresh?.uploadSpeedBytesPerSec ?? null,
              status: resolvedStatus,
            });
          }
        },
        emitOutputs: (outputs) => {
          if (!store) return;
          store.steps.updateStepStatus(nextStep.stepId, "running", {
            outputs,
          });
        },
      };

      const promise = (async () => {
        try {
          await handler(ctx);
          if (!store) return;
          // Mark step succeeded (terminal step transitions bypass throttle).
          store.steps.updateStepStatus(nextStep.stepId, "succeeded", {
            progressPct: 100,
            finishedAt: new Date().toISOString(),
          });
          // The jobs parked behind this one may now be able to start.
          runnable.wake(job.jobId);

          // Are all steps for this job done?
          const allSteps = store.steps.getSteps(job.jobId);
          const allTerminal = allSteps.every((s) =>
            isTerminalIngestJobStatus(s.status)
          );
          const anyFailed = allSteps.some((s) => s.status === "failed");
          const anyCancelled = allSteps.some((s) => s.status === "cancelled");

          if (allTerminal) {
            const target: IngestJobStatus = anyFailed
              ? "failed"
              : anyCancelled
                ? "cancelled"
                : "succeeded";
            const wrote = setStatusCAS(job.jobId, ["running"], target);
            if (wrote) {
              const fresh = store.getJob(job.jobId);
              if (fresh) {
                if (target === "succeeded") {
                  // Carry through `libraryVersionAtDone` from the commit
                  // step's outputs when present. The badger commit step
                  // records the library DB version after its coalesced
                  // snapshot publish so the renderer can close the
                  // cross-stream race between this `succeeded` event
                  // (jobs SSE) and the matching `library.updated` event
                  // (library SSE). Field is optional in the contract;
                  // engines without a commit step or non-badger jobs
                  // simply omit it.
                  const commitStep = allSteps.find((s) => s.kind === "commit");
                  const commitOutputs =
                    (commitStep?.outputs as Record<string, unknown> | undefined)
                      ?.commitResult as
                      | { libraryVersionAtDone?: unknown }
                      | undefined;
                  const libraryVersionAtDone =
                    typeof commitOutputs?.libraryVersionAtDone === "number"
                      ? commitOutputs.libraryVersionAtDone
                      : undefined;
                  emit(job.jobId, "runtime.jobs.succeeded", {
                    job: fresh,
                    ...(libraryVersionAtDone !== undefined
                      ? { libraryVersionAtDone }
                      : {}),
                  });
                } else if (target === "failed") {
                  emit(job.jobId, "runtime.jobs.failed", {
                    job: fresh,
                    errorCode: fresh.errorCode ?? "unknown",
                    errorMessage:
                      fresh.errorMessage ?? "job failed with no message",
                  });
                } else {
                  emit(job.jobId, "runtime.jobs.cancelled", {
                    job: fresh,
                    reason: fresh.errorCode ?? "cancelled",
                  });
                }
              }
            }
          } else {
            // More steps to run — flip back to queued so the next tick picks
            // it up. The step itself is already succeeded; the pending step
            // is queued and now runnable.
            //
            // @bugfix @regression-proof #2499 (INGS-QUEUE-01): the next step
            // may wait minutes for its lane (a 360p job's upload waits behind
            // every source upload). Say so on the wire: without this event
            // the UI kept the job "running" on its last label ("Transcoded
            // 360p") until the next step's `started` + 1 % arrived, so a batch
            // looked stuck. The UI shows `queued` as waiting with its place in
            // line.
            if (setStatusCAS(job.jobId, ["running"], "queued")) {
              const waiting =
                store.updateJobStatus(job.jobId, "queued", {
                  stageCode: WAITING_STAGE_CODE,
                  stageLabel: WAITING_STAGE_LABEL,
                }) ?? store.getJob(job.jobId);
              emit(job.jobId, "runtime.jobs.progress", {
                jobId: job.jobId,
                groupId: job.groupId,
                progressPct: waiting?.progressPct ?? 0,
                stageCode: WAITING_STAGE_CODE,
                stageLabel: WAITING_STAGE_LABEL,
                uploadSpeedBytesPerSec: null,
                status: "queued",
              });
            }
          }
        } catch (err) {
          if (!store) return;
          const isAbort =
            (err as { name?: string } | null)?.name === "AbortError" ||
            ctrl.signal.aborted;
          const finishedAt = new Date().toISOString();
          if (isAbort && ctrl.signal.reason === shutdownAbortReason) {
            // Graceful runtime stop (app quit, guardian SIGTERM) — NOT a user
            // cancel. The work is unfinished, not abandoned: put the step and
            // the job back to `queued` so the next boot resumes them. Pre-fix
            // the step was written `cancelled` while the job stayed live, so
            // findRunnableSteps never surfaced it again and the job sat
            // "queued" forever (#25 P4).
            store.steps.updateStepStatus(nextStep.stepId, "queued", {});
            const requeued = setStatusCAS(job.jobId, ["running"], "queued");
            console.info(
              JSON.stringify({
                event: "runtime.jobs.v2.step_requeued_on_shutdown",
                jobId: job.jobId,
                stepId: nextStep.stepId,
                stepKind: nextStep.kind,
                jobRequeued: requeued,
              })
            );
          } else if (isAbort) {
            store.steps.updateStepStatus(nextStep.stepId, "cancelled", {
              finishedAt,
            });
            // The cancel path already wrote the job's status via CAS. Nothing
            // more to do here besides the step record + lane release below.
          } else {
            const message = err instanceof Error ? err.message : String(err);
            // Surface the failure on stderr so operators inspecting the
            // runtime stdout see step failures alongside the structured
            // event log. Was previously silent — only the event log carried
            // the message and the row's error_message column was empty.
            console.error(
              `[engineV2] step '${nextStep.kind}' for job ${job.jobId} threw:`,
              err
            );
            store.steps.updateStepStatus(nextStep.stepId, "failed", {
              errorCode: "handler-error",
              errorMessage: message,
              finishedAt,
            });
            const wrote = setStatusCAS(
              job.jobId,
              ["running"],
              "failed",
              "handler-error",
              message
            );
            if (wrote) {
              const fresh = store.getJob(job.jobId);
              if (fresh) {
                emit(job.jobId, "runtime.jobs.failed", {
                  job: fresh,
                  errorCode: "handler-error",
                  errorMessage: message,
                });
              }
            }
          }
        } finally {
          releaseStepLane();
          controllers.delete(job.jobId);
          lastProgressAt.delete(job.jobId);
          // Re-tick — capacity may have opened up for queued siblings.
          tick();
        }
      })();
      inflight.add(promise);
      void promise.finally(() => {
        inflight.delete(promise);
      });
    }
  };

  /**
   * Run a scheduling pass. Single-flight: a call made while a pass is running
   * (a subscriber that submits from an event the pass emitted) only asks for
   * one more pass after the current one, however many calls arrive.
   */
  const tick = () => {
    if (ticking) {
      tickRequested = true;
      tickCounters.coalesced += 1;
      return;
    }
    ticking = true;
    try {
      do {
        tickRequested = false;
        tickPass();
      } while (tickRequested);
    } finally {
      ticking = false;
      tickRequested = false;
    }
  };

  // -------------------------------------------------------------------------
  // Public methods
  // -------------------------------------------------------------------------

  return {
    async start() {
      if (started) return;
      // #25 P10: the file's WAL setup syncs on the checkpoint worker.
      await prepareSqliteRuntimeJobsStore(config.dbPath);
      if (started) return;
      try {
        store = createSqliteRuntimeJobsStore(config.dbPath);
      } catch (error) {
        abandonPreparedSqliteRuntimeJobsStore(config.dbPath);
        throw error;
      }
      eventLog = createEventLog(createSqliteEventLogDeps(store.db));
      started = true;
      runnable.clear();
      failedParentIds.clear();
      stopping = false;

      // Hydrate: any rows left in `running` from a previous process were
      // interrupted by exit. Mark them as `interrupted` (audit trail), then
      // immediately transition back to `queued` so tick() picks them up and
      // re-dispatches the next-runnable step. Step handlers are written to
      // be idempotent on resume (extract/upload check for already-uploaded
      // chunks; transcode re-runs but skips already-finished outputs). Any
      // rows already in `interrupted` from prior boots get the same
      // treatment so they don't get stuck forever.
      //
      // Pre-fix: interrupted rows stayed interrupted, format children
      // queued behind them got cascade-cancelled, and the user's ingest
      // visibly broke (see cancel-cascade comment in tick()).
      const runningOnBoot = store.listJobs({ status: ["running"] });
      for (const job of runningOnBoot) {
        store.updateJobStatus(job.jobId, "interrupted", {
          errorCode: INTERRUPTED_BY_RESTART_REASON,
        });
        const fresh = store.getJob(job.jobId);
        if (!fresh) continue;
        emit(job.jobId, "runtime.jobs.cancelled", {
          job: fresh,
          reason: INTERRUPTED_BY_RESTART_REASON,
        });
      }
      const interruptedOnBoot = store.listJobs({ status: ["interrupted"] });
      for (const job of interruptedOnBoot) {
        // Clear in-flight step `running` markers so findRunnableSteps
        // surfaces the next dependency-eligible step rather than leaving
        // the partial step row stuck.
        const steps = store.steps.getSteps(job.jobId);
        for (const step of steps) {
          if (step.status === "running") {
            store.steps.updateStepStatus(step.stepId, "queued", {});
          }
        }
        store.updateJobStatus(job.jobId, "queued", {
          // Preserve the audit trail in errorMessage; clear errorCode so
          // tick's downstream cascade predicate (which uses status only)
          // treats the job as a normal queued job again.
          errorCode: null,
        });
      }
      // Repair rows stranded by a graceful stop BEFORE the shutdown-requeue
      // fix (#25 P4): the in-flight step was written `cancelled` while its
      // job stayed live, so after the hydration above the job is `queued`
      // but has no runnable step and tick() skips it forever. A step of a
      // live, non-cancel-requested job is only ever `cancelled` that way —
      // a user cancel writes the JOB terminal (cancelled) first — so put
      // those steps (and any stale `running` marker) back to `queued`.
      for (const job of store.listJobs({ status: ["queued"] })) {
        if (job.cancelRequested) continue;
        for (const step of store.steps.getSteps(job.jobId)) {
          if (step.status !== "cancelled" && step.status !== "running") continue;
          store.steps.updateStepStatus(step.stepId, "queued", {});
          console.info(
            JSON.stringify({
              event: "runtime.jobs.v2.hydrate.step_requeued",
              jobId: job.jobId,
              stepId: step.stepId,
              stepKind: step.kind,
              fromStatus: step.status,
              progressPct: step.progressPct,
            })
          );
        }
      }
      // A running job cancelled just before the process died (#137 review
      // P3): the job row is `cancelled` but its in-flight step is still
      // `running` (or `interrupted`), because the step's own catch never ran.
      // Cancelled is terminal, so nothing above touches it. Settle the step
      // and re-announce the cancel so app-layer subscribers (badger format
      // cleanup) can drop the outputs the dead handler never removed.
      for (const job of store.listJobs({ status: ["cancelled"] })) {
        const stale = store.steps
          .getSteps(job.jobId)
          .filter((s) => s.status === "running" || s.status === "interrupted");
        if (stale.length === 0) continue;
        for (const step of stale) {
          store.steps.updateStepStatus(step.stepId, "cancelled", {});
        }
        console.info(
          JSON.stringify({
            event: "runtime.jobs.v2.hydrate.cancelled_job_steps_settled",
            jobId: job.jobId,
            steps: stale.map((s) => ({ stepId: s.stepId, kind: s.kind, fromStatus: s.status })),
          })
        );
        emit(job.jobId, "runtime.jobs.cancelled", {
          job,
          reason: CANCELLED_BEFORE_RESTART_REASON,
        });
      }
      // Every queued job (including the ones just requeued above) goes in
      // the runnable set, in the order listJobs returns them.
      for (const job of store.listJobs({ status: ["queued"] })) {
        runnable.enqueue(job.jobId);
      }
      tick();
      runHistoryPrune();
      pruneTimer = setInterval(runHistoryPrune, historyPruneIntervalMs);
      pruneTimer.unref?.();
    },

    async stop() {
      stopping = true;
      clearInterval(pruneTimer);
      pruneTimer = undefined;
      // Abort any in-flight handlers and wait for their finally{} blocks.
      // Tag the abort as a shutdown so the step's catch path requeues the
      // work instead of recording a user cancel (#25 P4).
      for (const ctrl of controllers.values()) ctrl.abort(shutdownAbortReason);
      await Promise.allSettled([...inflight]);
      await pruning;
      controllers.clear();
      runnable.clear();
      failedParentIds.clear();
      lastProgressAt.clear();
      if (store) {
        try {
          store.close();
        } catch {
          // best-effort close
        }
      }
      store = null;
      eventLog = null;
      started = false;
    },

    async submit(submitted) {
      const s = requireStore();
      // RT-JOBS-07: the job remembers the API server it was queued against, so it never runs against another one.
      const job =
        config.session && typeof submitted.payload?.apiOrigin !== "string"
          ? { ...submitted, payload: { ...submitted.payload, apiOrigin: config.session.apiOrigin() } }
          : submitted;
      // upsertJob checks the (app, dedupe_key) slot and inserts in one
      // synchronous SQLite step, so it is the atomic arbiter between two
      // concurrent submits. On a dedupe hit it returns the live row instead
      // of inserting: report THAT job and seed nothing — seeding steps for
      // the never-inserted job id fails the step FK and would hand the
      // caller a phantom id.
      const stored = s.upsertJob(job);
      if (stored.jobId !== job.jobId) {
        console.info(
          JSON.stringify({
            event: "runtime.jobs.submit.dedupe_hit",
            app: job.app,
            dedupeKey: job.dedupeKey,
            requestedJobId: job.jobId,
            existingJobId: stored.jobId,
            existingStatus: stored.status,
          })
        );
        return { jobId: stored.jobId };
      }
      const steps = seedStepsForJob(job);
      for (const step of steps) s.steps.upsertStep(step);
      const fresh = s.getJob(job.jobId) ?? job;
      // In the set before the event goes out: a throwing emit (schema check in
      // dev) must not leave a stored, queued job that no pass can see.
      runnable.enqueue(job.jobId);
      runnable.wake(job.jobId);
      emit(job.jobId, "runtime.jobs.created", { job: fresh });
      tick();
      return { jobId: job.jobId };
    },

    async updateJobPayload(jobId, patch) {
      const s = requireStore();
      return s.updateJobPayload(jobId, patch);
    },

    async cancel(jobId, reason) {
      const s = requireStore();
      const result = cancelJobCascade(jobId, reason, buildCancelDeps());
      for (const id of result.cancelledIds) {
        const fresh = s.getJob(id);
        if (!fresh) continue;
        emit(id, "runtime.jobs.cancelled", { job: fresh, reason });
      }
      return { cancelledIds: result.cancelledIds };
    },

    async dismiss(jobId) {
      const s = requireStore();
      const job = s.getJob(jobId);
      if (!job) return { dismissed: false, errorCode: "not-found" };
      if (!isTerminalIngestJobStatus(job.status)) {
        return { dismissed: false, errorCode: "not-terminal" };
      }
      const dismissedAt = new Date().toISOString();
      s.dismissJob(jobId, dismissedAt);
      emit(jobId, "runtime.jobs.dismissed", {
        jobId,
        groupId: job.groupId,
        dismissedAt,
      });
      return { dismissed: true };
    },

    async retry(jobId, options) {
      const s = requireStore();
      const job = s.getJob(jobId);
      if (!job) return { retried: false, reason: "not-found" };
      // Failed, or cancelled only because its parent failed.
      if (!(job.status === "failed" || (job.status === "cancelled" && job.errorCode === "parent-cancelled"))) {
        console.info(
          JSON.stringify({ event: "runtime.jobs.v2.retry_refused", jobId, status: job.status, errorCode: job.errorCode ?? null })
        );
        return { retried: false, reason: "not-retryable" };
      }
      const requeued = requeueInPlace(job, options?.steps ?? "unfinished", options?.payloadPatch);
      if (!requeued) return { retried: false, reason: "duplicate-running" };
      // The children this job's failure cancelled run again with it; their
      // encode outputs were discarded on cancel, so every step re-runs.
      const childIds: string[] = [];
      const walk = (parentId: string) => {
        for (const child of s.findChildren(parentId)) {
          if (child.status !== "cancelled" || child.errorCode !== "parent-cancelled") continue;
          if (childIds.includes(child.jobId)) continue;
          if (requeueInPlace(child, "all", undefined)) {
            childIds.push(child.jobId);
            walk(child.jobId);
          }
        }
      };
      walk(jobId);
      console.info(
        JSON.stringify({
          event: "runtime.jobs.v2.retried_in_place",
          jobId,
          kind: job.kind,
          steps: options?.steps ?? "unfinished",
          payloadPatched: Boolean(options?.payloadPatch),
          attemptCount: (job.attemptCount ?? 0) + 1,
          previousErrorCode: job.errorCode ?? null,
          requeuedChildren: childIds,
        })
      );
      tick();
      return { retried: true, newJobId: jobId };
    },

    async list(filter) {
      const s = requireStore();
      const jobs = s.listJobs(filter);
      return { jobs, maxEventId: eventLog!.maxEventId() };
    },

    async get(jobId) {
      const s = requireStore();
      const job = s.getJob(jobId);
      if (!job) return null;
      const steps = s.steps.getSteps(jobId);
      return { job, steps };
    },

    async getByDedupe(app, dedupeKey) {
      const s = requireStore();
      return s.getJobByDedupe(app, dedupeKey);
    },

    registerHandler(kind, handler) {
      handlers.set(kind, handler);
    },

    subscribe(listener) {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },

    setLaneCaps(partial) {
      // Clamp each provided lane to an integer >= 1 and mutate the live `caps`
      // object IN PLACE — `tick()` reads `caps` by closure reference, so an
      // in-place mutation is what makes a raised cap visible to the dispatch
      // loop. A fresh object would not be seen.
      const clamp = (value: number): number =>
        Math.max(1, Math.trunc(value));
      let changed = false;
      for (const lane of ["source", "format", "upload"] as const) {
        const next = partial[lane];
        if (typeof next !== "number" || !Number.isFinite(next)) continue;
        const requested = clamp(next);
        const clamped = hostMaxCaps ? Math.min(requested, hostMaxCaps[lane]) : requested;
        if (clamped !== requested) {
          console.info("[engineV2] lane cap clamped to host capacity", {
            lane,
            requested,
            effective: clamped,
            hostCpuCount,
          });
        }
        if (caps[lane] !== clamped) {
          caps[lane] = clamped;
          changed = true;
        }
      }
      // Re-tick so a just-raised cap dispatches queued jobs immediately. Safe
      // when nothing changed too — tick() is idempotent — but skip the call
      // to avoid noise when the request was a no-op.
      if (changed) tick();
      return { ...caps };
    },
    schedulerStats() {
      return {
        tickPasses: tickCounters.passes,
        coalescedTicks: tickCounters.coalesced,
        ...runnable.stats(),
        lanesRunning: { ...lanes },
      };
    },
    sessionChanged() {
      const woken = runnable.wake(SESSION_WAKE_KEY);
      console.info(
        JSON.stringify({
          event: "runtime.jobs.v2.session_changed",
          woken,
          activeUserId: config.session?.activeUserId() ?? null,
          apiOrigin: config.session?.apiOrigin() ?? null,
        })
      );
      tick();
    },
  };
}

// Helper used by tests: kept here to keep IngestJobKind import warm without
// triggering a `noUnusedLocals` failure if the engine ever drops the type
// import. Pure passthrough.
export type { IngestJobKind, IngestJobRecord, IngestJobLane, IngestJobStatus };
