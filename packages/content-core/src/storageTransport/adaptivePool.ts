/**
 * storage transport Adaptive Pool
 * 
 * Manages concurrent upload tasks with:
 * 1. Adaptive concurrency (ramping up/down based on success).
 * 2. Exponential backoff with jitter.
 * 3. Circuit breaker for 5xx/timeouts.
 */
import { AsyncResource } from "node:async_hooks";
import { scopeLogger } from "../logger";
import type { UploadPlaybackGate } from "./uploadPlaybackGate";

export type Task<T> = () => Promise<T>;

type QueueEntry = {
  task: Task<any>;
  resolve: any;
  reject: any;
  retries: number;
  signal?: AbortSignal;
};

export type PoolRunOptions = {
  /** Aborting rejects a chunk that has not started yet with `CANCELLED` and drops it from the queue. */
  signal?: AbortSignal;
};

export interface PoolOptions {
  initialConcurrency?: number;
  minConcurrency?: number;
  maxConcurrency?: number;
  maxRetries?: number;
  debug?: boolean;
  label?: string;
  /**
   * Upload policy while a video plays (uploadPlaybackGate.ts). Consulted every
   * time a chunk could start: it can lower the in-flight cap (throttle), stop
   * new starts (pause) and add a pause after each finished chunk. Chunks
   * already running are never touched.
   */
  gate?: UploadPlaybackGate;
}

export class AdaptivePool {
  private queue: QueueEntry[] = [];
  private activeCount = 0;
  /** Slots resting after a finished chunk (throttle pacing); they count against the cap. */
  private coolingCount = 0;
  private gate: UploadPlaybackGate | undefined;
  private concurrency: number;
  private minConcurrency: number;
  private maxConcurrency: number;
  private maxRetries: number;
  private debug: boolean;
  private label: string;
  private logger: ReturnType<typeof scopeLogger>;

  private consecutiveErrors = 0;
  private circuitOpen = false;
  private circuitBreakerThreshold = 5;

  constructor(options: PoolOptions = {}) {
    this.concurrency = options.initialConcurrency ?? 4;
    this.minConcurrency = options.minConcurrency ?? 2;
    this.maxConcurrency = options.maxConcurrency ?? 16;
    this.maxRetries = options.maxRetries ?? 5;
    this.debug = options.debug ?? process.env.SF_STORAGE_TRANSPORT_DEBUG === "1";
    this.label = options.label ?? "pool";
    this.gate = options.gate;
    // A gate change (playback stopped, lease ran out, mode switched) can free slots.
    this.gate?.subscribe(() => void this.process());
    this.logger = scopeLogger("storage-transport").child({ label: this.label });
    if (this.debug) {
      this.logger.info({
        initialConcurrency: this.concurrency,
        minConcurrency: this.minConcurrency,
        maxConcurrency: this.maxConcurrency,
        maxRetries: this.maxRetries,
      }, "debug enabled");
    }
  }

  async run<T>(task: Task<T>, options: PoolRunOptions = {}): Promise<T> {
    const { signal } = options;
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("CANCELLED"));
        return;
      }
      // The task runs in the async context of whoever queued it, not of whoever
      // frees the slot later (a finishing chunk, a gate change, a retry timer):
      // callers keep per-job state there (the ingest library key).
      const entry: QueueEntry = { task: AsyncResource.bind(task), resolve, reject, retries: 0, signal };
      signal?.addEventListener(
        "abort",
        () => {
          // Only a chunk that never started can be dropped: a running one is
          // the task's own business (it holds the same signal).
          const at = this.queue.indexOf(entry);
          if (at === -1) return;
          this.queue.splice(at, 1);
          reject(new Error("CANCELLED"));
        },
        { once: true },
      );
      this.queue.push(entry);
      this.process();
    });
  }

  /** Slots the pool may fill right now: its own adaptive cap, lowered by the playback gate. */
  private slotLimit() {
    const gateLimit = this.gate?.maxConcurrency() ?? Number.POSITIVE_INFINITY;
    return Math.min(this.concurrency, gateLimit);
  }

  private async process() {
    while (
      !this.circuitOpen &&
      this.activeCount + this.coolingCount < this.slotLimit() &&
      this.queue.length > 0
    ) {
      const entry = this.queue.shift()!;
      this.execute(entry);
    }
  }

  private async execute(entry: QueueEntry) {
    this.activeCount++;
    try {
      const result = await entry.task();
      this.handleSuccess();
      entry.resolve(result);
    } catch (err) {
      this.handleFailure(err, entry);
    } finally {
      this.activeCount--;
      const pacingMs = this.gate?.pacingMs() ?? 0;
      if (pacingMs > 0 && this.queue.length > 0) {
        // Throttle: the slot rests before it takes the next chunk.
        this.coolingCount++;
        setTimeout(() => {
          this.coolingCount--;
          this.process();
        }, pacingMs);
      } else {
        this.process();
      }
    }
  }

  private handleSuccess() {
    this.consecutiveErrors = 0;
    
    // Adaptive: slowly ramp up concurrency
    if (this.concurrency < this.maxConcurrency && Math.random() > 0.8) {
      this.concurrency++;
    }
  }

  private classifyError(err: any): {
    retryable: boolean;
    shouldCountForCircuit: boolean;
  } {
    const message = err instanceof Error ? err.message : String(err ?? "");
    const normalized = message.trim().toLowerCase();
    const status = Number((err as { status?: unknown })?.status);
    if (!message) {
      return { retryable: true, shouldCountForCircuit: true };
    }
    if (
      normalized === "cancelled" ||
      normalized === "abort_err" ||
      normalized === "this operation was aborted" ||
      normalized === "the operation was aborted." ||
      normalized.includes("operation was aborted")
    ) {
      return { retryable: false, shouldCountForCircuit: false };
    }
    if (normalized.includes("enoent") || normalized.includes("no such file or directory")) {
      return { retryable: false, shouldCountForCircuit: false };
    }
    if (normalized.includes("upload_quota_exceeded") || normalized.includes("quota_exceeded")) {
      return { retryable: false, shouldCountForCircuit: false };
    }
    if (Number.isFinite(status)) {
      if (status >= 500) return { retryable: true, shouldCountForCircuit: true };
      if (status >= 400) return { retryable: false, shouldCountForCircuit: false };
    }
    const uploadStatusMatch = message.match(/CHUNK_UPLOAD_FAILED_(\d{3})/);
    if (uploadStatusMatch) {
      const status = Number(uploadStatusMatch[1]);
      if (status >= 500) return { retryable: true, shouldCountForCircuit: true };
      if (status >= 400) return { retryable: false, shouldCountForCircuit: false };
    }
    return { retryable: true, shouldCountForCircuit: true };
  }

  private handleFailure(err: any, entry: QueueEntry) {
    const { retries, signal } = entry;
    const classification = this.classifyError(err);
    const verboseDebug = process.env.SF_STORAGE_TRANSPORT_DEBUG_VERBOSE === "1";
    const shouldLog = classification.shouldCountForCircuit || (this.debug && (verboseDebug || classification.retryable));
    if (shouldLog) {
      const message = err instanceof Error ? err.message : String(err ?? "unknown_error");
      this.logger.warn({
        retryable: classification.retryable,
        shouldCountForCircuit: classification.shouldCountForCircuit,
        retries,
        concurrency: this.concurrency,
        queueDepth: this.queue.length,
        message,
      }, "task failure");
    }

    if (classification.shouldCountForCircuit) {
      this.consecutiveErrors++;
      // Adaptive: aggressively ramp down concurrency on real storage/network errors
      this.concurrency = Math.max(this.minConcurrency, Math.floor(this.concurrency * 0.5));
      if (this.consecutiveErrors >= this.circuitBreakerThreshold) {
        this.openCircuit();
      }
    }

    if (!classification.retryable) {
      entry.reject(err);
      return;
    }

    if (retries < this.maxRetries) {
      const delay = Math.pow(2, retries) * 1000 + Math.random() * 1000; // Exponential backoff with jitter
      setTimeout(() => {
        if (signal?.aborted) {
          entry.reject(new Error("CANCELLED"));
          return;
        }
        // Same object, so the abort listener registered in run() still finds it in the queue.
        entry.retries = retries + 1;
        this.queue.push(entry);
        this.process();
      }, delay);
    } else {
      entry.reject(err);
    }
  }

  private openCircuit() {
    if (this.circuitOpen) return;
    this.circuitOpen = true;
    this.logger.warn({
      concurrency: this.concurrency,
      queueDepth: this.queue.length,
      active: this.activeCount,
      consecutiveErrors: this.consecutiveErrors,
    }, "circuit breaker opened");
    
    // Try to close circuit after a cooling period
    setTimeout(() => {
      this.circuitOpen = false;
      this.consecutiveErrors = 0;
      this.process();
    }, 30000); // 30s cooling
  }

  getStats() {
    return {
      active: this.activeCount,
      queued: this.queue.length,
      cooling: this.coolingCount,
      currentConcurrency: this.concurrency,
      circuitOpen: this.circuitOpen
    };
  }
}
