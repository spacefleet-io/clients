/**
 * Event-loop lag monitor + in-flight work registry (#25, ultimate stress P1).
 *
 * The guardian in the desktop app restarts the runtime when `/runtime/health`
 * stops answering. In the stress run the runtime stopped answering while it
 * sat at 0-2 % CPU, and nothing in its log said why. This module makes the
 * runtime say it itself:
 *
 * - A drift timer measures how late the event loop runs a periodic tick. A
 *   tick that lands `stallLogMs` or more late is logged as
 *   `[runtime] event-loop stall` with the lag and every piece of tracked work
 *   that was in flight across the stall (command name + age), so the log names
 *   the blocker (a sync SQLite commit stuck in fsync, a spawnSync, ...).
 * - `snapshot()` feeds `/runtime/health` and the periodic memory line, so the
 *   guardian and the logs see the current lag, the worst lag of the last
 *   window, and the last stall.
 *
 * Kept permanently on: it costs one timer tick every `intervalMs`.
 */

export type InflightWork = { label: string; startedAt: number };

export type EventLoopStall = {
  at: string;
  lagMs: number;
  inflight: Array<{ label: string; ageMs: number }>;
};

export type EventLoopSnapshot = {
  lagMs: number;
  maxLagMs: number;
  windowMs: number;
  stalls: number;
  lastStall: EventLoopStall | null;
  inflight: number;
};

export type EventLoopMonitorOptions = {
  /** Tick period. Default 500 ms. */
  intervalMs?: number;
  /** A tick this late (or later) is logged as a stall. Default 1000 ms. */
  stallLogMs?: number;
  /** Width of the rolling max-lag window. Default 60 s. */
  windowMs?: number;
  now?: () => number;
  log?: (message: string, data: Record<string, unknown>) => void;
};

const defaultLog = (message: string, data: Record<string, unknown>) => {
  // One JSON line so line-based captures keep it whole and greppable.
  console.warn(`[runtime] ${message} ${JSON.stringify(data)}`);
};

export class EventLoopMonitor {
  private readonly intervalMs: number;
  private readonly stallLogMs: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly log: (message: string, data: Record<string, unknown>) => void;

  private timer: NodeJS.Timeout | null = null;
  private expectedAt = 0;
  private lagMs = 0;
  private windowMax = 0;
  private prevWindowMax = 0;
  private windowStartedAt = 0;
  private stalls = 0;
  private lastStall: EventLoopStall | null = null;
  private nextId = 1;
  private readonly inflight = new Map<number, InflightWork>();

  constructor(options: EventLoopMonitorOptions = {}) {
    this.intervalMs = Math.max(10, options.intervalMs ?? 500);
    this.stallLogMs = Math.max(1, options.stallLogMs ?? 1000);
    this.windowMs = Math.max(this.intervalMs, options.windowMs ?? 60_000);
    this.now = options.now ?? Date.now;
    this.log = options.log ?? defaultLog;
  }

  start(): void {
    if (this.timer) return;
    const now = this.now();
    this.expectedAt = now + this.intervalMs;
    this.windowStartedAt = now;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer ?? undefined);
    this.timer = null;
  }

  /** Track one unit of work (a module command, a DB call). Call the returned
   *  function when it settles. */
  track(label: string): () => void {
    const id = this.nextId++;
    this.inflight.set(id, { label, startedAt: this.now() });
    return () => {
      this.inflight.delete(id);
    };
  }

  snapshot(): EventLoopSnapshot {
    return {
      lagMs: this.lagMs,
      maxLagMs: Math.max(this.windowMax, this.prevWindowMax),
      windowMs: this.windowMs,
      stalls: this.stalls,
      lastStall: this.lastStall,
      inflight: this.inflight.size,
    };
  }

  /** Exposed for tests; the timer calls it. */
  tick(): void {
    const now = this.now();
    const lag = Math.max(0, now - this.expectedAt);
    this.expectedAt = now + this.intervalMs;
    this.lagMs = lag;
    if (now - this.windowStartedAt >= this.windowMs) {
      this.prevWindowMax = this.windowMax;
      this.windowMax = 0;
      this.windowStartedAt = now;
    }
    if (lag > this.windowMax) this.windowMax = lag;
    if (lag < this.stallLogMs) return;
    this.stalls += 1;
    const stallStartedAt = now - lag;
    const inflight = [...this.inflight.values()]
      // Work that started after the loop stopped could not have blocked it.
      .filter((w) => w.startedAt <= stallStartedAt + this.intervalMs)
      .sort((a, b) => a.startedAt - b.startedAt)
      .slice(0, 20)
      .map((w) => ({ label: w.label, ageMs: now - w.startedAt }));
    this.lastStall = { at: new Date(now).toISOString(), lagMs: lag, inflight };
    this.log("event-loop stall", {
      lagMs: lag,
      stalls: this.stalls,
      inflightCount: this.inflight.size,
      inflight,
    });
  }
}

export const runtimeEventLoopMonitor = new EventLoopMonitor({
  intervalMs: Number(process.env.RUNTIME_EVENT_LOOP_INTERVAL_MS ?? 500) || 500,
  stallLogMs: Number(process.env.RUNTIME_EVENT_LOOP_STALL_LOG_MS ?? 1000) || 1000,
});
