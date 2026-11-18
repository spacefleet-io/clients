import { runtimeJobEngine, type RuntimeJobEngine } from "./engine";

type RuntimeJobWorkerOptions = {
  intervalMs?: number;
  maxPassesPerDrain?: number;
  scheduleDrain?: (run: () => void) => ReturnType<typeof setTimeout>;
  clearScheduledDrain?: (timer: ReturnType<typeof setTimeout>) => void;
  beforeDrain?: () => void | Promise<unknown>;
};

const defaultScheduleDrain = (run: () => void) => setTimeout(run, 0);
const defaultClearScheduledDrain = (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer);

export class RuntimeJobWorker {
  private intervalMs: number;
  private readonly maxPassesPerDrain: number;
  private readonly scheduleDrain: (run: () => void) => ReturnType<typeof setTimeout>;
  private readonly clearScheduledDrain: (timer: ReturnType<typeof setTimeout>) => void;
  private beforeDrain: (() => void | Promise<unknown>) | null;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private pendingDrainHandle: ReturnType<typeof setTimeout> | null = null;
  private pendingResolve: ((value: boolean) => void) | null = null;
  private running = false;
  private rerunRequested = false;

  constructor(
    private readonly engine: RuntimeJobEngine = runtimeJobEngine,
    options: RuntimeJobWorkerOptions = {}
  ) {
    this.intervalMs = Math.max(250, options.intervalMs ?? 5_000);
    this.maxPassesPerDrain = Math.max(1, options.maxPassesPerDrain ?? 25);
    this.scheduleDrain = options.scheduleDrain ?? defaultScheduleDrain;
    this.clearScheduledDrain = options.clearScheduledDrain ?? defaultClearScheduledDrain;
    this.beforeDrain = options.beforeDrain ?? null;
  }

  start() {
    if (this.intervalHandle) return;
    this.intervalHandle = setInterval(() => {
      void this.kick();
    }, this.intervalMs);
    this.intervalHandle.unref?.();
  }

  stop() {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    if (this.pendingDrainHandle) {
      this.clearScheduledDrain(this.pendingDrainHandle);
      this.pendingDrainHandle = null;
    }
    this.pendingResolve?.(false);
    this.pendingResolve = null;
    this.rerunRequested = false;
  }

  setIntervalMs(intervalMs: number) {
    this.intervalMs = Math.max(250, intervalMs);
    if (this.intervalHandle) {
      this.stop();
      this.start();
    }
  }

  setBeforeDrain(beforeDrain: (() => void | Promise<unknown>) | null) {
    this.beforeDrain = beforeDrain;
  }

  async drainNow() {
    if (this.running) {
      this.rerunRequested = true;
      return false;
    }
    this.running = true;
    let ran = false;
    try {
      if (this.beforeDrain) {
        try {
          await this.beforeDrain();
        } catch {
          // Keep the worker draining eligible jobs even if background reconciliation fails.
        }
      }
      for (let pass = 0; pass < this.maxPassesPerDrain; pass += 1) {
        const result = await this.engine.runNext();
        if (!result) break;
        ran = true;
      }
      return ran;
    } finally {
      this.running = false;
      if (this.rerunRequested) {
        this.rerunRequested = false;
        void this.kick();
      }
    }
  }

  async kick() {
    if (this.running) {
      this.rerunRequested = true;
      return false;
    }
    if (this.pendingDrainHandle) {
      this.clearScheduledDrain(this.pendingDrainHandle);
      this.pendingDrainHandle = null;
      this.pendingResolve?.(false);
      this.pendingResolve = null;
    }
    return await new Promise<boolean>((resolve) => {
      this.pendingResolve = resolve;
      this.pendingDrainHandle = this.scheduleDrain(() => {
        this.pendingDrainHandle = null;
        const settle = this.pendingResolve;
        this.pendingResolve = null;
        void this.drainNow().then((result) => {
          settle?.(result);
        });
      });
    });
  }
}

export const runtimeJobWorker = new RuntimeJobWorker();
