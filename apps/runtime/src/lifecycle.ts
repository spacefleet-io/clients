import type { RuntimeState } from "./state";
import type { AppId } from "./types";

const defaultIsPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Reason handed to the runtime's shutdown() once no app is left. */
export const LIFECYCLE_ORPHANED_REASON = "lifecycle-orphaned";

export type DepartedApp = {
  connectionId: string;
  pid: number | null;
  cause: "app-disconnected" | "app-pid-dead";
};

export type LifecycleShutdownBinding = {
  /** The runtime's normal shutdown path (index.ts `shutdown`): drains
   *  engineV2 so in-flight jobs requeue and their encoders are aborted, then
   *  exits. It ignores a second call while a drain is already running. */
  shutdown: (reason: string) => void;
  /** Job ids still in flight, logged with the shutdown decision. */
  getActiveJobIds?: () => string[] | Promise<string[]>;
};

export type LifecycleManagerOptions = {
  shutdownGraceMs: number;
  sweepIntervalMs?: number;
  publishEvent: (app: AppId, channel: string, event: string, payload: Record<string, unknown>) => void;
  /** Test seam: liveness probe for connected app pids. */
  isPidAlive?: (pid: number) => boolean;
  /** Test seam: structured log sink. */
  log?: (message: string, data: Record<string, unknown>) => void;
};

export class LifecycleManager {
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private readonly shutdownGraceMs: number;
  private readonly sweepIntervalMs: number;
  private readonly publishEvent: LifecycleManagerOptions["publishEvent"];
  private readonly isPidAlive: (pid: number) => boolean;
  private readonly log: (message: string, data: Record<string, unknown>) => void;
  private binding: LifecycleShutdownBinding | null = null;
  /** Apps that left since the last connect; logged with the shutdown decision. */
  private departed: DepartedApp[] = [];

  constructor(options: LifecycleManagerOptions) {
    this.shutdownGraceMs = options.shutdownGraceMs;
    this.sweepIntervalMs = options.sweepIntervalMs ?? 15_000;
    this.publishEvent = options.publishEvent;
    this.isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
    this.log =
      options.log ?? ((message, data) => console.info(`[runtime] ${message} ${JSON.stringify(data)}`));
  }

  /**
   * Wire the runtime's shutdown path. The orphan exit used to be a bare
   * `process.exit(0)`, which skipped the drain: in-flight jobs were never
   * requeued, encoders were orphaned, and nothing was logged (#25). Until a
   * binding exists, an orphaned runtime logs the decision and stays up.
   */
  bindShutdown(binding: LifecycleShutdownBinding) {
    this.binding = binding;
  }

  onAppConnected(state: RuntimeState, token: string, appName: string, pid: number) {
    this.cancelGrace();
    this.departed = [];
    const result = state.connect(token, appName, pid);
    this.publishEvent("badger", "runtime.lifecycle", "runtime.lifecycle.app_connected", {
      appName,
      connectionId: result.connectionId,
    });
    return result;
  }

  onAppDisconnected(state: RuntimeState, connectionId: string) {
    const pid = state.getConnectionsWithPids().find((c) => c.connectionId === connectionId)?.pid ?? null;
    const result = state.disconnect(connectionId);
    if (!result.found) return result;
    this.departed.push({ connectionId, pid, cause: "app-disconnected" });
    this.publishEvent("badger", "runtime.lifecycle", "runtime.lifecycle.app_disconnected", {
      connectionId,
      remainingCount: result.remaining,
    });
    if (result.remaining === 0) {
      this.startGrace();
    }
    return result;
  }

  cancelGrace() {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
  }

  private startGrace() {
    this.cancelGrace();
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      void this.shutdownOrphaned();
    }, this.shutdownGraceMs);
  }

  private async shutdownOrphaned() {
    const binding = this.binding;
    let activeJobIds: string[] = [];
    let activeJobIdsError: string | undefined;
    try {
      activeJobIds = (await binding?.getActiveJobIds?.()) ?? [];
    } catch (err) {
      activeJobIdsError = err instanceof Error ? err.message : String(err);
    }
    this.log("lifecycle: no app connected after grace", {
      reason: LIFECYCLE_ORPHANED_REASON,
      decision: binding ? "shutdown" : "stay-up-no-shutdown-binding",
      graceMs: this.shutdownGraceMs,
      appPids: this.departed.map((d) => d.pid),
      departedApps: this.departed,
      activeJobIds,
      ...(activeJobIdsError ? { activeJobIdsError } : {}),
    });
    if (!binding) return;
    this.publishEvent("badger", "runtime.lifecycle", "runtime.lifecycle.shutting_down", {
      reason: LIFECYCLE_ORPHANED_REASON,
    });
    // Small delay to let the WS event flush before the drain starts.
    setTimeout(() => binding.shutdown(LIFECYCLE_ORPHANED_REASON), 200);
  }

  get isGracePending() {
    return this.graceTimer !== null;
  }

  /**
   * Periodically check if connected app PIDs are still alive.
   * If all connections have dead PIDs, start the grace shutdown.
   * This handles the case where apps exit without sending HTTP disconnect
   * (crash, kill -9, or async stop() not completing in time).
   */
  startConnectionSweep(state: RuntimeState) {
    this.stopConnectionSweep();
    this.sweepTimer = setInterval(() => {
      const connections = state.getConnectionsWithPids();
      if (connections.length === 0) return;
      let removed = 0;
      for (const conn of connections) {
        if (!this.isPidAlive(conn.pid)) {
          state.disconnect(conn.connectionId);
          this.departed.push({ connectionId: conn.connectionId, pid: conn.pid, cause: "app-pid-dead" });
          removed++;
        }
      }
      if (removed > 0 && state.getConnectionCount() === 0) {
        this.startGrace();
      }
    }, this.sweepIntervalMs);
  }

  stopConnectionSweep() {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }
}
