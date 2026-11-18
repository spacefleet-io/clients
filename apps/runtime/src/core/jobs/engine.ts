import {
  backoffMsForRuntimeJobAttempt,
  canScheduleRuntimeJobRetry,
  type RuntimeJobProgress,
  type RuntimeJobRecord,
  type RuntimeJobSchedulerPolicy,
} from "@space/runtime-jobs";
import { runtimeJobsStore, type RuntimeJobsStore } from "./store";
import { getDefaultRuntimeSchedulerPolicy, listNextRunnableRuntimeJobs } from "./scheduler";
import { publishRuntimeJobLifecycle, type RuntimeJobsEventPublisher } from "./events";

type RuntimeJobHandlerResult = {
  status?: RuntimeJobRecord["status"];
  stageCode?: string;
  stageLabel?: string;
  progress?: RuntimeJobProgress;
  outputs?: Record<string, unknown>;
  errorCode?: string | null;
  errorMessage?: string | null;
  retryable?: boolean;
  retryAfterMs?: number | null;
  maxAttempts?: number | null;
};

type RuntimeJobHandlerContext = {
  signal: AbortSignal;
};

export type RuntimeJobHandler = (
  job: RuntimeJobRecord,
  context: RuntimeJobHandlerContext
) => Promise<RuntimeJobHandlerResult | void>;

type RuntimeJobExecutor = {
  canRun?: (job: RuntimeJobRecord) => boolean;
  recoverInterrupted?: boolean;
  handle: RuntimeJobHandler;
};

export class RuntimeJobEngine {
  private readonly handlers = new Map<string, RuntimeJobExecutor>();
  private readonly controllers = new Map<string, AbortController>();
  private eventPublisher: RuntimeJobsEventPublisher | null;
  private policyResolver: () => RuntimeJobSchedulerPolicy;

  constructor(
    private readonly store: RuntimeJobsStore = runtimeJobsStore,
    private readonly policy: RuntimeJobSchedulerPolicy = getDefaultRuntimeSchedulerPolicy(),
    publish: RuntimeJobsEventPublisher | null = null,
    private readonly now: () => string = () => new Date().toISOString()
  ) {
    this.eventPublisher = publish;
    this.policyResolver = () => policy;
  }

  getDispatchBatch(): RuntimeJobRecord[] {
    const jobs = this.store.list({ includeCompleted: true });
    return listNextRunnableRuntimeJobs({ jobs, policy: this.policyResolver(), nowIso: this.now() });
  }

  registerHandler(
    kind: string,
    handler: RuntimeJobHandler,
    options?: { canRun?: (job: RuntimeJobRecord) => boolean; recoverInterrupted?: boolean }
  ) {
    this.handlers.set(kind, {
      canRun: options?.canRun,
      recoverInterrupted: options?.recoverInterrupted ?? true,
      handle: handler,
    });
  }

  setEventPublisher(publish: RuntimeJobsEventPublisher | null) {
    this.eventPublisher = publish;
  }

  setPolicyResolver(resolve: (() => RuntimeJobSchedulerPolicy) | null) {
    this.policyResolver = resolve ?? (() => this.policy);
  }

  recoverInterruptedJobs() {
    const recovered: RuntimeJobRecord[] = [];
    const now = this.now();
    for (const job of this.store.list({ includeCompleted: true })) {
      if (job.status !== "running") continue;
      const executor = this.handlers.get(job.kind);
      if (!executor || executor.recoverInterrupted === false) continue;
      recovered.push(
        this.store.upsert({
          ...job,
          status: "queued",
          stageCode: "queued",
          stageLabel: "Queued",
          progress: { mode: "none", completed: null, total: null, unit: null },
          errorCode: null,
          errorMessage: null,
          cancelRequested: false,
          nextAttemptAt: null,
          updatedAt: now,
          startedAt: null,
          finishedAt: null,
        })
      );
    }
    return recovered;
  }

  requestCancel(jobId: string) {
    const job = this.store.get(jobId);
    if (!job) return null;
    if (job.status === "queued") {
      const cancelled = this.store.upsert({
        ...job,
        status: "cancelled",
        stageCode: "cancelled",
        stageLabel: "Cancelled",
        cancelRequested: false,
        retryable: false,
        updatedAt: this.now(),
        finishedAt: this.now(),
      });
      this.publishJobLifecycle("runtime.jobs", "runtime.jobs.cancel_requested", cancelled);
      return cancelled;
    }
    const updated = this.store.upsert({
      ...job,
      cancelRequested: true,
      updatedAt: this.now(),
    });
    this.controllers.get(jobId)?.abort();
    this.publishJobLifecycle("runtime.jobs", "runtime.jobs.cancel_requested", updated);
    return updated;
  }

  retry(jobId: string) {
    const job = this.store.get(jobId);
    if (!job || (job.status !== "failed" && job.status !== "cancelled")) return null;
    const retried = this.store.upsert({
      ...job,
      status: "queued",
      stageCode: "queued",
      stageLabel: "Queued",
      progress: { mode: "none", completed: null, total: null, unit: null },
      outputs: {},
      errorCode: null,
      errorMessage: null,
      cancelRequested: false,
      attemptCount: 0,
      maxAttempts: job.maxAttempts,
      nextAttemptAt: null,
      lastAttemptAt: null,
      updatedAt: this.now(),
      startedAt: null,
      finishedAt: null,
    });
    this.publishJobLifecycle("runtime.jobs", "runtime.jobs.retry", retried);
    return retried;
  }

  async runNext() {
    const job = this.getDispatchBatch().find((candidate) => {
      const executor = this.handlers.get(candidate.kind);
      return Boolean(executor && (executor.canRun?.(candidate) ?? true));
    });
    if (!job) return null;
    const executor = this.handlers.get(job.kind);
    if (!executor) return null;

    const startedAt = job.startedAt ?? this.now();
    const controller = new AbortController();
    this.controllers.set(job.jobId, controller);
    const running = this.store.upsert({
      ...job,
      status: "running",
      stageCode: job.stageCode === "queued" ? "running" : job.stageCode,
      stageLabel: job.stageCode === "queued" ? "Running" : job.stageLabel,
      updatedAt: this.now(),
      startedAt,
    });
    this.publishJobLifecycle("runtime.jobs", "runtime.jobs.started", running);

    try {
      const result = await executor.handle(running, { signal: controller.signal });
      const current = this.store.get(job.jobId) ?? running;
      const cancelled = current.cancelRequested || controller.signal.aborted;
      const scheduledRetry =
        !cancelled && this.scheduleRetryIfNeeded(current, {
          retryable: result?.retryable ?? current.retryable,
          retryAfterMs: result?.retryAfterMs,
          errorCode: result?.errorCode ?? null,
          errorMessage: result?.errorMessage ?? null,
          maxAttempts: result?.maxAttempts,
        });
      if (scheduledRetry) {
        this.publishJobLifecycle("runtime.jobs", "runtime.jobs.retry_scheduled", scheduledRetry);
        return scheduledRetry;
      }
      const nextStatus = cancelled ? "cancelled" : result?.status ?? "succeeded";
      const finished = this.store.upsert({
        ...current,
        status: nextStatus,
        stageCode: cancelled ? "cancelled" : result?.stageCode ?? current.stageCode,
        stageLabel: cancelled ? "Cancelled" : result?.stageLabel ?? current.stageLabel,
        progress: cancelled ? current.progress : result?.progress ?? current.progress,
        outputs: cancelled ? current.outputs : result?.outputs ? { ...current.outputs, ...result.outputs } : current.outputs,
        errorCode: cancelled ? null : result?.errorCode ?? null,
        errorMessage: cancelled ? null : result?.errorMessage ?? null,
        retryable: cancelled ? false : result?.retryable ?? current.retryable,
        updatedAt: this.now(),
        finishedAt: nextStatus === "running" || nextStatus === "queued" ? null : this.now(),
      });
      this.publishJobLifecycle("runtime.jobs", "runtime.jobs.settled", finished);
      return finished;
    } catch (cause) {
      const current = this.store.get(job.jobId) ?? running;
      const cancelled = current.cancelRequested || controller.signal.aborted;
      const scheduledRetry =
        !cancelled &&
        this.scheduleRetryIfNeeded(current, {
          retryable: true,
          errorCode: "handler_failed",
          errorMessage: cause instanceof Error ? cause.message : "Runtime job handler failed",
        });
      if (scheduledRetry) {
        this.publishJobLifecycle("runtime.jobs", "runtime.jobs.retry_scheduled", scheduledRetry);
        return scheduledRetry;
      }
      const failed = this.store.upsert({
        ...current,
        status: cancelled ? "cancelled" : "failed",
        stageCode: cancelled ? "cancelled" : "failed",
        stageLabel: cancelled ? "Cancelled" : "Failed",
        errorCode: cancelled ? null : "handler_failed",
        errorMessage: cancelled ? null : cause instanceof Error ? cause.message : "Runtime job handler failed",
        retryable: cancelled ? false : true,
        updatedAt: this.now(),
        finishedAt: this.now(),
      });
      this.publishJobLifecycle("runtime.jobs", "runtime.jobs.settled", failed);
      return failed;
    } finally {
      this.controllers.delete(job.jobId);
    }
  }

  private publishJobLifecycle(sourceChannel: string, sourceEvent: string, job: RuntimeJobRecord) {
    if (!this.eventPublisher) return;
    publishRuntimeJobLifecycle(this.eventPublisher, {
      app: job.app,
      sourceChannel,
      sourceEvent,
      job,
    });
  }

  private scheduleRetryIfNeeded(
    job: RuntimeJobRecord,
    args: {
      retryable: boolean;
      retryAfterMs?: number | null;
      errorCode?: string | null;
      errorMessage?: string | null;
      maxAttempts?: number | null;
    }
  ) {
    const maxAttempts = args.maxAttempts !== undefined ? args.maxAttempts : job.maxAttempts;
    if (args.retryAfterMs === undefined || args.retryAfterMs === null || args.retryAfterMs < 0) return null;
    const retryCandidate: RuntimeJobRecord = {
      ...job,
      retryable: args.retryable,
      maxAttempts,
    };
    if (!canScheduleRuntimeJobRetry(retryCandidate)) return null;
    const attemptCount = (job.attemptCount ?? 0) + 1;
    const delayMs = Number.isFinite(args.retryAfterMs)
      ? Math.max(0, Math.floor(args.retryAfterMs))
      : backoffMsForRuntimeJobAttempt(attemptCount - 1);
    const now = this.now();
    return this.store.upsert({
      ...job,
      status: "queued",
      stageCode: "retry_scheduled",
      stageLabel: "Retry scheduled",
      retryable: args.retryable,
      attemptCount,
      maxAttempts,
      nextAttemptAt: new Date(Date.parse(now) + delayMs).toISOString(),
      lastAttemptAt: now,
      errorCode: args.errorCode ?? null,
      errorMessage: args.errorMessage ?? null,
      updatedAt: now,
      finishedAt: null,
    });
  }
}

export const runtimeJobEngine = new RuntimeJobEngine();
