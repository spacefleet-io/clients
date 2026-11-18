import { EventEmitter } from "node:events";
import { type ChildProcess, type SpawnOptions, spawn as nodeSpawn } from "node:child_process";
import { mkdirSync, openSync, closeSync, unlinkSync } from "node:fs";
import { basename, join as joinPath } from "node:path";
import { getDesktopPlatform } from "@space/desktop-platform";
import { rotateLogIfLarge } from "./logRotation.ts";
import { httpHealthProbe, tcpProbe, tcpRefused, waitForHealth } from "./probe.ts";
import { acquireSpawnLock, forceReleaseSpawnLock, isSpawnLockStale } from "./lock.ts";
import { getLivePids, readRuntimePid, registerPid, unregisterPid, writeRuntimePid } from "./refs.ts";
import { createHostLoadSampler, type HostLoad, type HostLoadSampler } from "./load.ts";
import {
  createPortHoldersReader,
  createProcessDiagnosticsReader,
  type PortHoldersReader,
  type ProcessDiagnosticsReader,
} from "./diagnostics.ts";

export type SpawnCommand = {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  /** Spawn the runtime in a detached process group. Defaults to true.
   *  Set to false in dev mode so the runtime dies with its parent. */
  detached?: boolean;
};

export type RuntimeHostLog = (level: "info" | "warn" | "error" | "debug", message: string, meta?: Record<string, unknown>) => void;

export type RuntimeHostOptions = {
  appName: string;
  runtimeDataDir?: string;
  runtimePort?: number;
  runtimeHost?: string;
  spawnCommand: SpawnCommand;
  healthIntervalMs?: number;
  healthProbeTimeoutMs?: number;
  maxConsecutiveFailures?: number;
  maxRestartRetries?: number;
  restartBackoffBaseMs?: number;
  restartBackoffMaxMs?: number;
  /** How long a runtime WE spawned may take to answer health before it is
   *  terminated (and awaited) so a replacement can be started. Defaults to
   *  60 s: the product target is an old 4-core i5 with an HDD and no GPU,
   *  where a cold first boot (plus a Windows Defender first-run scan of the
   *  binary) can take tens of seconds. A child that exits early fails the
   *  boot at once, so a broken binary never pays this deadline. */
  spawnDeadlineMs?: number;
  /** How long to wait for a runtime we did NOT spawn (port already bound by
   *  another app's runtime) to answer health. Waiting on another app's
   *  in-progress spawn (lock held elsewhere) uses max(waitDeadlineMs,
   *  spawnDeadlineMs) so it covers that spawner's full boot deadline. */
  waitDeadlineMs?: number;
  /** Grace between SIGTERM and SIGKILL, and again after SIGKILL, when the
   *  guardian terminates its own runtime child before a respawn. */
  childKillGraceMs?: number;
  /** How long a deliberate stop (the last app quits, or a manual restart)
   *  waits for the runtime's own drain before SIGKILL (RT-LIFE-04). The
   *  runtime finishes within 3.5 s and its watchdog force-kills at 4.5 s, so
   *  the default is 4.5 s; the wait after SIGKILL uses `childKillGraceMs`. */
  shutdownGraceMs?: number;
  /** After a restart cycle gives up ('lost'), automatic restarts are disarmed
   *  (manual restart() re-arms them). After this cool-down one more cycle is
   *  attempted. 0 = never retry automatically. Defaults to 10 min. */
  lostCooldownMs?: number;
  /** Upper bound of the load-scaled health grace (#25 P1). The guardian only
   *  restarts an unhealthy runtime once BOTH maxConsecutiveFailures probes
   *  failed AND the failure streak lasted
   *  `(maxConsecutiveFailures − 1) × healthIntervalMs × loadFactor × killBackoff`,
   *  capped here. Defaults to 120 s. */
  healthGraceMaxMs?: number;
  /** Upper bound of the load-scaled per-probe timeout
   *  (`healthProbeTimeoutMs × loadFactor`). Defaults to 10 s. */
  healthProbeTimeoutMaxMs?: number;
  /** A runtime that stays healthy this long after a health-triggered restart
   *  resets the restart backoff. Defaults to 5 min. */
  healthKillBackoffResetMs?: number;
  /** Reads the runtime's current owner secret (RT-SEC-05). The login the
   *  guardian does to register its connection needs it; called on every login,
   *  never cached. Without it the login is refused and the guardian falls back
   *  to the PID refs. Hosts pass `readOwnerSecretFile(dataDir)` from
   *  `@space/runtime-client/ownerSecretFile`. */
  ownerSecret?: () => string | null;
  log?: RuntimeHostLog;
};

export type RuntimeHostEventMap = {
  ready: [];
  restarting: [];
  lost: [];
};

/** The one `child_process.spawn` overload the guardian calls (args + options, no stream-typed stdio). */
export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export type RuntimeHostDeps = {
  spawn?: SpawnFn;
  healthProbe?: (baseUrl: string, timeoutMs: number) => Promise<boolean>;
  waitForReady?: (baseUrl: string, deadlineMs: number, intervalMs: number) => Promise<boolean>;
  portProbe?: (host: string, port: number, timeoutMs?: number) => Promise<boolean>;
  processPid?: number;
  processKill?: (pid: number, signal?: string | number) => boolean;
  /** Graceful stop request for a pid (the runtime's drain); false when it
   *  could not be delivered. Defaults to the platform's
   *  `processes.gracefulStop.request`, because SIGTERM is a forced kill on
   *  Windows. `processKill` still carries liveness probes and SIGKILL. */
  requestStop?: (pid: number) => boolean;
  /** Host load sampler; the default reads loadavg, cgroup quota and CPU times. */
  hostLoad?: HostLoadSampler;
  /** Out-of-process runtime dump logged on a failed probe. Async: on Windows
   *  it is a PowerShell child, and the guardian lives in the Electron main
   *  process, whose event loop must keep turning while it runs (#928). */
  processDiagnostics?: ProcessDiagnosticsReader;
  /** Command line of a pid (NUL-separated argv joined by spaces), or null when
   *  the platform cannot tell. Used to make sure an orphan found through
   *  runtime.pid really is a runtime before it is killed. */
  processCmdline?: (pid: number) => Promise<string | null>;
  /** Who holds the runtime port, logged when the holder cannot be named
   *  through runtime.pid. */
  portHolders?: PortHoldersReader;
  /** True only when the port is provably free (connection refused); a probe
   *  timeout must not count. Defaults to `tcpRefused`, or to the inverse of an
   *  injected `portProbe`. */
  portReleased?: (host: string, port: number, timeoutMs?: number) => Promise<boolean>;
};

export class RuntimeGuardian extends EventEmitter<RuntimeHostEventMap> {
  private readonly dataDir: string;
  /** No `runtimeDataDir` option: the dir comes from the platform, which prepares it (owner-only, legacy migration). */
  private readonly dataDirFromPlatform: boolean;
  private readonly readOwnerSecret: (() => string | null) | undefined;
  private readonly host: string;
  private readonly port: number;
  private readonly baseUrl: string;
  private readonly spawnCmd: SpawnCommand;
  private readonly healthIntervalMs: number;
  private readonly healthProbeTimeoutMs: number;
  private readonly maxFailures: number;
  private readonly maxRestartRetries: number;
  private readonly restartBackoffBaseMs: number;
  private readonly restartBackoffMaxMs: number;
  private readonly spawnDeadlineMs: number;
  private readonly waitDeadlineMs: number;
  private readonly childKillGraceMs: number;
  private readonly shutdownGraceMs: number;
  private readonly lostCooldownMs: number;
  private readonly healthGraceMaxMs: number;
  private readonly healthProbeTimeoutMaxMs: number;
  private readonly healthKillBackoffResetMs: number;

  private readonly lockDir: string;
  private readonly refsPath: string;
  private readonly pidPath: string;

  private readonly _spawn: SpawnFn;
  private readonly _healthProbe: (baseUrl: string, timeoutMs: number) => Promise<boolean>;
  private readonly _waitForReady: (baseUrl: string, deadlineMs: number, intervalMs: number) => Promise<boolean>;
  private readonly _portProbe: (host: string, port: number, timeoutMs?: number) => Promise<boolean>;
  private readonly _portReleased: (host: string, port: number, timeoutMs?: number) => Promise<boolean>;
  private readonly _pid: number;
  private readonly _kill: (pid: number, signal?: string | number) => boolean;
  private readonly _requestStop: (pid: number) => boolean;
  private readonly _hostLoad: HostLoadSampler;
  private readonly _diagnostics: ProcessDiagnosticsReader;
  private readonly _portHolders: PortHoldersReader;
  private readonly _cmdline: (pid: number) => Promise<string | null>;
  private readonly _log: RuntimeHostLog;

  private readonly appName: string;

  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private consecutiveFailures = 0;
  private child: ChildProcess | null = null;
  /** The child whose boot ensureRuntimeSpawned is awaiting; its exit is the
   *  waiter's to handle, not the crash-restart path's. */
  private bootingChild: ChildProcess | null = null;
  /** Children the guardian terminated on purpose: their exit is not a crash. */
  private readonly retiredChildren = new WeakSet<ChildProcess>();
  /** Resolves when the child is gone (exit, or spawn failure with no pid). */
  private readonly childGone = new WeakMap<ChildProcess, Promise<void>>();
  private readonly exitedChildren = new WeakSet<ChildProcess>();
  private stopped = false;
  /** start() ran (and created the data dir). Until then the guardian owns no
   *  runtime: stop()/killSync() must not touch the refs file (its dir may not
   *  exist) or kill a runtime someone else spawned. Set before the first spawn,
   *  so a quit during the boot wait still kills the runtime start() spawned. */
  private started = false;
  private healthy = false;
  private restartInFlight = false;
  private pendingExitEvent = false;
  /** Set when a restart cycle gave up: automatic restarts stay disarmed until
   *  restart() or the lost cool-down. */
  private lost = false;
  private lostCooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private restartBackoffTimer: ReturnType<typeof setTimeout> | null = null;
  private connectionId: string | null = null;
  private runtimeToken: string | null = null;
  private healthTickInFlight = false;
  /** When the current health-failure streak started (null = healthy). */
  private failureStreakStartedAt: number | null = null;
  /** Health-triggered restarts in a row without a healthy reset window;
   *  doubles the grace each time so a loaded host never kill-storms. */
  private healthKillStreak = 0;
  private lastHealthKillAt = 0;

  constructor(options: RuntimeHostOptions, deps?: RuntimeHostDeps) {
    super();
    this.appName = options.appName;
    this.dataDir = options.runtimeDataDir || getDesktopPlatform().paths.runtimeDataDir();
    this.dataDirFromPlatform = !options.runtimeDataDir;
    this.readOwnerSecret = options.ownerSecret;
    this.host = options.runtimeHost ?? "127.0.0.1";
    this.port = options.runtimePort ?? 3020;
    this.baseUrl = `http://${this.host}:${this.port}`;
    this.spawnCmd = options.spawnCommand;
    this.healthIntervalMs = options.healthIntervalMs ?? 5000;
    this.healthProbeTimeoutMs = options.healthProbeTimeoutMs ?? 2000;
    this.maxFailures = options.maxConsecutiveFailures ?? 3;
    this.maxRestartRetries = Math.max(1, options.maxRestartRetries ?? 5);
    this.restartBackoffBaseMs = Math.max(500, options.restartBackoffBaseMs ?? 2000);
    this.restartBackoffMaxMs = Math.max(this.restartBackoffBaseMs, options.restartBackoffMaxMs ?? 60_000);
    this.spawnDeadlineMs = options.spawnDeadlineMs ?? 60_000;
    this.waitDeadlineMs = options.waitDeadlineMs ?? 20_000;
    this.childKillGraceMs = Math.max(0, options.childKillGraceMs ?? 5_000);
    this.shutdownGraceMs = Math.max(0, options.shutdownGraceMs ?? 4_500);
    this.lostCooldownMs = Math.max(0, options.lostCooldownMs ?? 10 * 60_000);
    this.healthGraceMaxMs = Math.max(0, options.healthGraceMaxMs ?? 120_000);
    this.healthProbeTimeoutMaxMs = Math.max(this.healthProbeTimeoutMs, options.healthProbeTimeoutMaxMs ?? 10_000);
    this.healthKillBackoffResetMs = Math.max(0, options.healthKillBackoffResetMs ?? 5 * 60_000);

    this.lockDir = joinPath(this.dataDir, "runtime.spawn.lock");
    this.refsPath = joinPath(this.dataDir, "runtime.refs");
    this.pidPath = joinPath(this.dataDir, "runtime.pid");

    this._spawn = deps?.spawn ?? nodeSpawn;
    this._healthProbe = deps?.healthProbe ?? httpHealthProbe;
    this._waitForReady = deps?.waitForReady ?? waitForHealth;
    this._portProbe = deps?.portProbe ?? tcpProbe;
    // An injected portProbe is the test's whole view of the port: a released
    // port is one it reports unbound.
    const injectedPortProbe = deps?.portProbe;
    this._portReleased =
      deps?.portReleased ??
      (injectedPortProbe ? async (host, port, timeoutMs) => !(await injectedPortProbe(host, port, timeoutMs)) : tcpRefused);
    this._pid = deps?.processPid ?? process.pid;
    this._kill = deps?.processKill ?? ((pid, sig) => process.kill(pid, sig));
    this._requestStop = deps?.requestStop ?? ((pid) => getDesktopPlatform().processes.gracefulStop.request(pid));
    this._hostLoad = deps?.hostLoad ?? createHostLoadSampler();
    this._diagnostics = deps?.processDiagnostics ?? createProcessDiagnosticsReader();
    this._portHolders = deps?.portHolders ?? createPortHoldersReader();
    this._cmdline = deps?.processCmdline ?? ((pid) => getDesktopPlatform().processes.readCommandLine(pid));
    this._log = options.log ?? (() => {});
  }

  get isHealthy() {
    return this.healthy;
  }

  get state(): "running" | "restarting" | "stopped" | "lost" {
    if (this.stopped) return "stopped";
    if (this.restartInFlight) return "restarting";
    if (this.healthy) return "running";
    return "lost";
  }

  async start() {
    this.stopped = false;
    this.lost = false;
    // Before anything is written there: preparing may carry a previous default location's data over.
    if (this.dataDirFromPlatform) getDesktopPlatform().paths.prepareRuntimeDataDir({ env: process.env, log: this._log });
    else mkdirSync(this.dataDir, { recursive: true });
    this.started = true;
    this._log("info", "guardian start", { baseUrl: this.baseUrl, appName: this.appName });

    const alreadyUp = await this._healthProbe(this.baseUrl, this.healthProbeTimeoutMs);
    if (alreadyUp) {
      this._log("info", "runtime already running", { baseUrl: this.baseUrl });
    } else {
      this._log("info", "runtime not responding, spawning", { baseUrl: this.baseUrl });
      // Clean up stale state from crashed/killed processes before attempting spawn.
      // A dead PID in the pid file or a stale lock dir can block the spawn flow.
      this.cleanStaleState();
      try {
        await this.ensureRuntimeSpawned();
      } catch (err) {
        // F5 (ultimate stress, issue #25): a failed FIRST spawn/wait — e.g. the
        // previous app's runtime still holds the port while refusing health,
        // then exits — used to leave the guardian dead for the whole session
        // (no health monitor, no restart, every library call answering
        // LIBRARY_DB_NOT_READY). Hand over to the normal restart loop instead,
        // then still reject so the caller logs the initial failure.
        this._log("error", "initial runtime start failed, entering background recovery", {
          error: err instanceof Error ? err.message : String(err),
        });
        registerPid(this.refsPath, this._pid);
        this.healthy = false;
        this.resetHealthStreak();
        this.startHealthMonitor();
        this.emit("restarting");
        void this.attemptRestart();
        throw err;
      }
    }

    registerPid(this.refsPath, this._pid);
    this.healthy = true;
    this.resetHealthStreak();
    this.startHealthMonitor();
    await this.httpConnect();
    this._log("info", "guardian ready", { baseUrl: this.baseUrl });
    this.emit("ready");
  }

  async stop() {
    this.stopped = true;
    this.stopHealthMonitor();
    if (this.restartBackoffTimer) {
      clearTimeout(this.restartBackoffTimer);
      this.restartBackoffTimer = null;
    }
    clearTimeout(this.lostCooldownTimer ?? undefined);
    this.lostCooldownTimer = null;

    // Best-effort HTTP disconnect — don't rely on it for shutdown
    await this.httpDisconnect().catch(() => {});

    // Never started (external runtime / direct SQLite): nothing of ours to release.
    if (!this.started) return;
    const remaining = unregisterPid(this.refsPath, this._pid);
    // Kill the runtime when this is the last app. Don't rely on HTTP disconnect
    // + grace period — that path fails when the main process exits before the
    // disconnect completes, leaving orphaned runtime processes.
    if (remaining.length === 0) {
      await this.killRuntime();
    }
  }

  /**
   * Synchronous kill for use in process.on('exit') handlers where async
   * operations are not possible. Acts as a last-resort safety net to
   * prevent orphaned runtime processes.
   */
  killSync() {
    if (!this.started) return;
    const remaining = unregisterPid(this.refsPath, this._pid);
    if (remaining.length > 0) return;
    const pid = readRuntimePid(this.pidPath);
    if (pid) {
      try { this._requestStop(pid); } catch {}
    }
    if (this.child?.pid !== undefined && !this.child.killed) {
      try { this._requestStop(this.child.pid); } catch {}
    }
    try { unlinkSync(this.pidPath); } catch {}
  }

  async restart(): Promise<void> {
    if (this.restartInFlight) {
      this._log("warn", "restart already in flight, ignoring");
      return;
    }
    this._log("info", "manual restart requested", { wasLost: this.lost });
    this.restartInFlight = true;
    this.lost = false;
    clearTimeout(this.lostCooldownTimer ?? undefined);
    this.lostCooldownTimer = null;
    this.stopHealthMonitor();
    if (this.restartBackoffTimer) {
      clearTimeout(this.restartBackoffTimer);
      this.restartBackoffTimer = null;
    }
    this.healthy = false;
    this.emit("restarting");
    try {
      await this.killRuntime();
      this.cleanStaleState();
      await this.ensureRuntimeSpawned();
      this.healthy = true;
      this.resetHealthStreak();
      this.startHealthMonitor();
      await this.httpConnect();
      this._log("info", "manual restart complete");
      this.emit("ready");
    } catch (err) {
      this._log("error", "manual restart failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      this.startHealthMonitor();
      throw err;
    } finally {
      this.restartInFlight = false;
    }
  }

  private cleanStaleState() {
    // If the PID file points to a dead process, remove it so the spawn flow doesn't get confused.
    const pid = readRuntimePid(this.pidPath);
    if (pid) {
      try {
        this._kill(pid, 0);
        // Process is alive — don't clean up
      } catch {
        // Process is dead — clean up stale PID file
        try { unlinkSync(this.pidPath); } catch {}
      }
    }
    // Clean up stale spawn lock if the holder is dead
    if (isSpawnLockStale(this.lockDir)) {
      forceReleaseSpawnLock(this.lockDir);
    }
  }

  private async ensureRuntimeSpawned() {
    // #25 (Opus review of #38): at most ONE runtime. A child we spawned that
    // is still alive — a slow boot, or a hung runtime holding the port — is
    // awaited, and if it still does not answer it is terminated AND its exit
    // awaited before anything else is spawned. Two runtimes on the same jobs
    // DB fail in-flight jobs and one of them crashes on EADDRINUSE.
    const previous = this.child;
    if (previous && this.isChildAlive(previous)) {
      this._log("warn", "previous runtime child still alive — awaiting it before any respawn", {
        pid: previous.pid ?? null,
        deadlineMs: this.spawnDeadlineMs,
      });
      const outcome = await this.awaitChildReady(previous, this.spawnDeadlineMs);
      this._log("info", "previous runtime child wait finished", { pid: previous.pid ?? null, outcome });
      if (outcome === "ready") return;
      if (outcome === "timeout" && !(await this.terminateChild(previous, "unresponsive_before_respawn", this.childKillGraceMs))) {
        throw new Error("runtime_previous_child_alive");
      }
    }

    // Round-12 #5: pre-spawn TCP probe. If port is already bound, another
    // runtime is alive — spawning a new bun process would just hit round-11
    // L1's port-probe, exit cleanly, and trigger the child-exit handler back
    // into attemptRestart, putting us in a 2s respawn loop. Skip the spawn
    // and just wait for the existing runtime to respond on health.
    if (await this._portProbe(this.host, this.port, 150)) {
      const load = this._hostLoad();
      // A loaded host answers late; give an adopted runtime more time, but
      // never more than twice the base wait (#25 P1: the app is unusable
      // until this resolves).
      const waitMs = Math.round(Math.min(this.waitDeadlineMs * load.loadFactor, 2 * this.waitDeadlineMs));
      this._log("info", "port already bound — skipping spawn, waiting for health", {
        host: this.host,
        port: this.port,
        waitMs,
        load,
      });
      const outcome = await this.awaitPortHolder(waitMs);
      if (outcome === "ready") return;
      if (outcome === "timeout") {
        // #25 P1: an orphan runtime (its app was killed) that holds the port
        // but never answers used to block every restart attempt until 'lost'.
        // Reclaim the port when the holder is provably an ownerless runtime;
        // its exit is observed before anything is spawned (#53 invariant).
        if (!(await this.reclaimPortFromOrphan())) throw new Error("runtime_external_wait_timeout");
      }
    }

    let lock = acquireSpawnLock(this.lockDir, this._pid);
    if (!lock && isSpawnLockStale(this.lockDir)) {
      forceReleaseSpawnLock(this.lockDir);
      lock = acquireSpawnLock(this.lockDir, this._pid);
    }

    if (lock) {
      let child: ChildProcess | null = null;
      try {
        child = this.spawnRuntimeProcess();
        this.bootingChild = child;
        const bootStartedAt = Date.now();
        const outcome = await this.awaitChildReady(child, this.spawnDeadlineMs);
        const bootMs = Date.now() - bootStartedAt;
        if (outcome === "ready") {
          this._log("info", "runtime boot answered health", { pid: child.pid ?? null, bootMs, deadlineMs: this.spawnDeadlineMs });
          return;
        }
        if (outcome === "exited") {
          this._log("warn", "runtime exited before answering health", {
            pid: child.pid ?? null,
            bootMs,
            exitCode: child.exitCode ?? null,
            signal: child.signalCode ?? null,
          });
          // L1 self-refusal: another runtime grabbed the port meanwhile.
          if (await this._portProbe(this.host, this.port, 150)) {
            this._log("info", "port bound by another runtime after our child exited — waiting for its health");
            const holder = await this.awaitPortHolder(this.waitDeadlineMs);
            if (holder === "ready") return;
            // A released port is retried by the background recovery.
            throw new Error(holder === "port-released" ? "runtime_exited_before_ready" : "runtime_external_wait_timeout");
          }
          throw new Error("runtime_exited_before_ready");
        }
        this._log("error", "runtime boot exceeded deadline — terminating it before any respawn", {
          pid: child.pid ?? null,
          bootMs,
          deadlineMs: this.spawnDeadlineMs,
        });
        if (!(await this.terminateChild(child, "boot_timeout", this.childKillGraceMs))) {
          this._log("error", "timed-out runtime child survived SIGKILL — no respawn until it exits", { pid: child.pid ?? null });
        }
        throw new Error("runtime_spawn_timeout");
      } finally {
        if (this.bootingChild === child) this.bootingChild = null;
        lock.release();
      }
    } else {
      // Another process is spawning — wait for it, for at least its own boot deadline.
      const deadlineMs = Math.max(this.waitDeadlineMs, this.spawnDeadlineMs);
      this._log("info", "spawn lock held elsewhere — waiting for that runtime", { deadlineMs });
      const ready = await this._waitForReady(this.baseUrl, deadlineMs, 500);
      if (!ready) throw new Error("runtime_wait_timeout");
    }
  }

  private isPidAlive(pid: number): boolean {
    try {
      this._kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Proof the runtime process is gone (#25 P20): procfs has no entry for it, or
   * `kill(pid, 0)` says ESRCH. EPERM (alive under another uid) and any other
   * error are not proof — the load grace still applies.
   */
  private isPidProvablyDead(pid: number, diagnostics: Record<string, unknown> | null): boolean {
    if (diagnostics?.alive === false) return true;
    try {
      this._kill(pid, 0);
      return false;
    } catch (err) {
      return (err as NodeJS.ErrnoException | null)?.code === "ESRCH";
    }
  }

  /**
   * The runtime dump, never throwing and never holding the health loop past
   * `healthProbeTimeoutMaxMs`: a cold PowerShell on a saturated 2-core box
   * can take seconds, and a wedged reader must not wedge the restart decision
   * (#928). A timed-out dump is no proof of death; `isPidProvablyDead` falls
   * back to `kill(pid, 0)`.
   */
  private async readDiagnostics(pid: number): Promise<Record<string, unknown>> {
    const timeoutMs = this.healthProbeTimeoutMaxMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Not Promise.withResolvers: the desktop typecheck compiles against a pre-ES2024 lib.
    const timedOut = new Promise<Record<string, unknown>>((resolve) => {
      timer = setTimeout(() => resolve({ error: `diagnostics timed out after ${timeoutMs} ms` }), timeoutMs);
    });
    try {
      return await Promise.race([
        this._diagnostics(pid).catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) })),
        timedOut,
      ]);
    } catch (err) {
      // A reader that throws synchronously.
      return { error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Waits for whoever holds the port (#25 P4): "ready" once health answers,
   * "port-released" as soon as a re-probe proves the port free (a quitting
   * app's runtime finishing its drain — spawn now instead of waiting out the
   * whole deadline for a health answer that will never come), "timeout" when
   * the holder neither answers nor lets go. Only a refused connection proves
   * release: a probe timeout is what a stalled live holder looks like.
   */
  private async awaitPortHolder(deadlineMs: number): Promise<"ready" | "port-released" | "timeout"> {
    const intervalMs = 500;
    const deadline = Date.now() + deadlineMs;
    let settled = false;
    const health = this._waitForReady(this.baseUrl, deadlineMs, intervalMs).then((ok) => (ok ? ("ready" as const) : ("timeout" as const)));
    const released = (async () => {
      while (!settled && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, intervalMs));
        if (settled) break;
        if (await this._portReleased(this.host, this.port, 150).catch(() => false)) return "port-released" as const;
      }
      // Never released: the health wait decides.
      return health;
    })();
    const startedAt = Date.now();
    const outcome = await Promise.race([health, released]);
    settled = true;
    if (outcome === "port-released") {
      this._log("info", "port released while waiting for its holder — spawning", { host: this.host, port: this.port, waitedMs: Date.now() - startedAt });
    }
    return outcome;
  }

  /**
   * The port is bound but nothing answers health. Kill the holder only when it
   * is provably an ownerless runtime: runtime.pid names a live process that is
   * not ours, no other live app holds a ref on it, and (where the platform can
   * tell) its command line is our runtime command. Resolves true once its
   * exit was observed, false when it must be left alone.
   */
  private async reclaimPortFromOrphan(): Promise<boolean> {
    const pid = readRuntimePid(this.pidPath);
    const ctx = { pid, host: this.host, port: this.port };
    if (!pid || pid === this._pid) {
      this._log("warn", "port bound but no runtime.pid — holder unknown, not killing", { ...ctx, portHolders: await this._portHolders(this.port) });
      return false;
    }
    if (this.child?.pid === pid && this.isChildAlive(this.child)) {
      this._log("warn", "port held by our own runtime child — handled by the child path, not here", ctx);
      return false;
    }
    if (!this.isPidAlive(pid)) {
      this._log("warn", "runtime.pid process is dead but the port is still bound — holder unknown, not killing", {
        ...ctx,
        portHolders: await this._portHolders(this.port),
      });
      return false;
    }
    const owners = getLivePids(this.refsPath).filter((p) => p !== this._pid);
    if (owners.length > 0) {
      this._log("warn", "unresponsive runtime is still referenced by another live app — not killing it", { ...ctx, owners });
      return false;
    }
    const cmdline = await this._cmdline(pid);
    const expected = [basename(this.spawnCmd.command), ...this.spawnCmd.args];
    if (cmdline !== null && !expected.every((part) => cmdline.includes(part))) {
      this._log("warn", "runtime.pid points at a process that is not our runtime — not killing", { ...ctx, cmdline, expected });
      return false;
    }
    const diagnostics = await this.readDiagnostics(pid);
    this._log("warn", "orphan runtime holds the port and does not answer health — terminating it", {
      ...ctx,
      cmdline,
      graceMs: this.childKillGraceMs,
      diagnostics,
    });
    const gone = await this.terminatePid(pid, this.childKillGraceMs);
    if (!gone) {
      this._log("error", "orphan runtime survived SIGKILL — not spawning a second runtime", ctx);
      return false;
    }
    if (readRuntimePid(this.pidPath) === pid) {
      try { unlinkSync(this.pidPath); } catch {}
    }
    this._log("info", "orphan runtime terminated — port reclaimed", ctx);
    return true;
  }

  /** Graceful stop request, poll, SIGKILL, poll — for a runtime that is not our child, so
   *  its exit can only be observed by polling the pid. */
  private async terminatePid(pid: number, graceMs: number): Promise<boolean> {
    try { this._requestStop(pid); } catch {}
    if (await this.waitPidGone(pid, graceMs)) return true;
    this._log("warn", "orphan runtime ignored the stop request — sending SIGKILL", { pid, graceMs });
    try { this._kill(pid, "SIGKILL"); } catch {}
    return this.waitPidGone(pid, graceMs);
  }

  /** Resolves true once `pid` is gone (polled: it may not be our child), false if `ms` elapses first. */
  private async waitPidGone(pid: number, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (!this.isPidAlive(pid)) return true;
      // Executor form: consumers typecheck with lib ES2022 (no Promise.withResolvers).
      await new Promise((r) => setTimeout(r, 100));
    }
    return !this.isPidAlive(pid);
  }

  private isChildAlive(child: ChildProcess): boolean {
    return !this.exitedChildren.has(child) && child.exitCode == null && child.signalCode == null;
  }

  /** Waits until health answers, the child is gone, or the deadline passes. */
  private async awaitChildReady(child: ChildProcess, deadlineMs: number): Promise<"ready" | "exited" | "timeout"> {
    const gone = this.childGone.get(child);
    if (!gone || !this.isChildAlive(child)) return "exited";
    // The losing waitForReady keeps polling health until its own deadline;
    // its result is ignored.
    return Promise.race([
      this._waitForReady(this.baseUrl, deadlineMs, 250).then((ok) => (ok ? ("ready" as const) : ("timeout" as const))),
      gone.then(() => "exited" as const),
    ]);
  }

  /** Resolves true once the child is gone, false if `ms` elapses first. */
  private async waitChildGone(child: ChildProcess, ms: number): Promise<boolean> {
    const gone = this.childGone.get(child);
    if (!gone || !this.isChildAlive(child)) return true;
    // Executor form: consumers typecheck with lib ES2022 (no Promise.withResolvers).
    let timer: ReturnType<typeof setTimeout> | undefined;
    const elapsed = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    });
    try {
      return await Promise.race([gone.then(() => true), elapsed]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Graceful stop request, wait, SIGKILL, wait — and only report success once the child's
   * exit was actually observed, so the caller can never overlap two runtimes.
   */
  private async terminateChild(child: ChildProcess, reason: string, graceMs: number): Promise<boolean> {
    if (!this.isChildAlive(child)) return true;
    this.retiredChildren.add(child);
    const pid = child.pid ?? null;
    this._log("warn", "terminating runtime child", { pid, reason, graceMs });
    if (pid !== null) {
      try { this._requestStop(pid); } catch {}
    }
    let exited = await this.waitChildGone(child, graceMs);
    if (!exited) {
      this._log("warn", "runtime child ignored the stop request — sending SIGKILL", { pid, reason, graceMs });
      try { child.kill("SIGKILL"); } catch {}
      exited = await this.waitChildGone(child, graceMs);
    }
    if (exited) {
      if (pid !== null && readRuntimePid(this.pidPath) === pid) {
        try { unlinkSync(this.pidPath); } catch {}
      }
      this._log("info", "runtime child terminated", { pid, reason });
    } else {
      this._log("error", "runtime child still alive after SIGKILL", { pid, reason });
    }
    return exited;
  }

  get logPath() {
    return joinPath(this.dataDir, "runtime.log");
  }

  private spawnRuntimeProcess(): ChildProcess {
    this._log("info", "spawning runtime", {
      command: this.spawnCmd.command,
      args: this.spawnCmd.args,
      cwd: this.spawnCmd.cwd,
      logPath: this.logPath,
    });
    if (rotateLogIfLarge(this.logPath)) this._log("info", "rotated runtime.log", { logPath: this.logPath });
    const logFd = openSync(this.logPath, "a");
    const detached = this.spawnCmd.detached !== false;
    const env = { ...process.env, ...this.spawnCmd.env };
    // The runtime outlives this process, so it cannot use childLifetime.wrap; it still must not keep the fds Electron leaks (DevTools port).
    const argv = getDesktopPlatform().processes.withoutInheritedHandles(this.spawnCmd.command, this.spawnCmd.args, env);
    const child = this._spawn(argv.command, argv.args, {
      cwd: this.spawnCmd.cwd,
      stdio: ["ignore", logFd, logFd],
      ...getDesktopPlatform().processes.spawnOptions({ detached }),
      env,
    });
    closeSync(logFd);
    if (detached) child.unref();
    if (child.pid) writeRuntimePid(this.pidPath, child.pid);
    this._log("info", "runtime process spawned", { pid: child.pid ?? null });
    this.child = child;
    let markGone = () => {};
    this.childGone.set(child, new Promise<void>((resolve) => { markGone = resolve; }));
    child.on("exit", (code, signal) => {
      this.exitedChildren.add(child);
      markGone();
      this._log("warn", "runtime process exited", { pid: child.pid ?? null, code, signal });
      if (this.child === child) this.child = null;
      if (this.stopped) return;
      if (this.retiredChildren.has(child)) {
        this._log("info", "exit of a runtime child the guardian terminated — not a crash", { pid: child.pid ?? null });
        return;
      }
      if (this.bootingChild === child) {
        this._log("info", "runtime exited during boot — the boot waiter handles it", { pid: child.pid ?? null });
        return;
      }
      void this.handleRuntimeExit(code, signal);
    });
    child.on("error", (err) => {
      // Without a listener a spawn failure (ENOENT, EACCES) is an uncaught
      // 'error' event. With no pid there is no process, and 'exit' may never come.
      this._log("error", "runtime process error", { pid: child.pid ?? null, error: err.message });
      if (child.pid === undefined) {
        this.exitedChildren.add(child);
        markGone();
        if (this.child === child) this.child = null;
      }
    });
    return child;
  }

  private async handleRuntimeExit(code?: number | null, signal?: NodeJS.Signals | null) {
    // Round-12 #5: a clean exit (code 0, no signal) while the port is still
    // bound by another runtime is the L1 port-probe self-refusal — NOT a
    // crash. If we restarted on this we'd just spawn another bun that exits
    // the same way, looping every 2s. Suppress the restart and rely on the
    // health monitor to confirm the surviving runtime stays healthy.
    if (code === 0 && (signal === null || signal === undefined)) {
      const portBound = await this._portProbe(this.host, this.port, 150).catch(() => false);
      if (portBound) {
        this._log("info", "runtime exited 0 but port still bound — likely L1 self-refusal, not a crash", {
          host: this.host,
          port: this.port,
        });
        return;
      }
    }
    if (this.restartInFlight) {
      this._log("debug", "exit event queued (restart in flight)");
      this.pendingExitEvent = true;
      return;
    }
    if (this.lost) {
      this._log("warn", "runtime exit while lost — automatic restarts disarmed until manual restart or cool-down");
      return;
    }
    this._log("warn", "runtime exit detected, attempting restart");
    this.healthy = false;
    this.emit("restarting");
    await this.attemptRestart();
  }

  private startHealthMonitor() {
    this.stopHealthMonitor();
    this.healthTimer = setInterval(() => void this.healthTick(), this.healthIntervalMs);
  }

  private stopHealthMonitor() {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  private async healthTick() {
    // Bound the log of a runtime that stays up for months (issue #671 R8).
    if (rotateLogIfLarge(this.logPath)) this._log("info", "rotated runtime.log", { logPath: this.logPath });
    if (this.stopped || this.restartInFlight || this.healthTickInFlight) return;
    // A load-scaled probe can outlast the interval; never stack probes.
    this.healthTickInFlight = true;
    try {
      await this.runHealthTick();
    } finally {
      this.healthTickInFlight = false;
    }
  }

  private resetHealthStreak() {
    this.consecutiveFailures = 0;
    this.failureStreakStartedAt = null;
  }

  /** Probe timeout and failure grace for the current host load (#25 P1). */
  private healthBudget(load: HostLoad) {
    const probeTimeoutMs = Math.round(
      Math.min(this.healthProbeTimeoutMaxMs, this.healthProbeTimeoutMs * load.loadFactor),
    );
    const killBackoff = 2 ** Math.min(this.healthKillStreak, 3);
    // Idle host, first kill: the old behaviour (maxFailures probes = the
    // streak spans maxFailures-1 intervals). Loaded host or repeat kills:
    // scaled up, capped by healthGraceMaxMs.
    const baseMs = Math.max(1, this.maxFailures - 1) * this.healthIntervalMs;
    const graceMs = Math.round(
      Math.min(Math.max(this.healthGraceMaxMs, baseMs), baseMs * load.loadFactor * killBackoff),
    );
    return { probeTimeoutMs, graceMs, killBackoff };
  }

  private runtimePidForDiagnostics(): number | null {
    const child = this.child;
    if (child?.pid && this.isChildAlive(child)) return child.pid;
    return readRuntimePid(this.pidPath);
  }

  private async runHealthTick() {
    const load = this._hostLoad();
    const budget = this.healthBudget(load);
    if (this.lost) {
      // Restarts are disarmed after 'lost'; keep watching so a runtime that
      // comes back on its own (or another app's) is still picked up.
      if (await this._healthProbe(this.baseUrl, budget.probeTimeoutMs)) {
        this._log("info", "runtime answered health while lost — recovered");
        this.lost = false;
        clearTimeout(this.lostCooldownTimer ?? undefined);
        this.lostCooldownTimer = null;
        this.healthy = true;
        this.resetHealthStreak();
        this.emit("ready");
      }
      return;
    }
    const probeStartedAt = Date.now();
    const ok = await this._healthProbe(this.baseUrl, budget.probeTimeoutMs);
    const probeMs = Date.now() - probeStartedAt;
    if (this.stopped || this.restartInFlight) return;
    if (ok) {
      if (!this.healthy || this.consecutiveFailures > 0) {
        this._log("info", "runtime recovered", {
          consecutiveFailures: this.consecutiveFailures,
          streakMs: this.failureStreakStartedAt === null ? 0 : Date.now() - this.failureStreakStartedAt,
          probeMs,
          load,
        });
      }
      if (!this.healthy) {
        this.healthy = true;
        this.emit("ready");
      }
      this.resetHealthStreak();
      if (
        this.healthKillStreak > 0 &&
        Date.now() - this.lastHealthKillAt >= this.healthKillBackoffResetMs
      ) {
        this._log("info", "runtime stayed healthy — health restart backoff reset", {
          healthKillStreak: this.healthKillStreak,
        });
        this.healthKillStreak = 0;
      }
      return;
    }
    const now = Date.now();
    this.consecutiveFailures += 1;
    if (this.failureStreakStartedAt === null) this.failureStreakStartedAt = now - probeMs;
    const streakMs = now - this.failureStreakStartedAt;
    const runtimePid = this.runtimePidForDiagnostics();
    // #25 P1: say WHY the runtime does not answer — the kernel's view of its
    // main thread (R/D/S, wchan, syscall + file), CPU since the last dump,
    // thread states and host pressure. Permanent; runs only on a failure.
    const diagnostics = runtimePid ? await this.readDiagnostics(runtimePid) : null;
    // The dump is a child process: stop() or a restart may have landed meanwhile.
    if (this.stopped || this.restartInFlight) return;
    this._log("warn", "health check failed", {
      consecutiveFailures: this.consecutiveFailures,
      maxFailures: this.maxFailures,
      streakMs,
      graceMs: budget.graceMs,
      probeTimeoutMs: budget.probeTimeoutMs,
      probeMs,
      healthKillStreak: this.healthKillStreak,
      load,
      runtimePid,
      diagnostics,
    });
    // #25 P20: the load grace is for a live runtime that answers late. A dead
    // pid never answers — and an adopted runtime raises no exit event — so
    // restart now instead of waiting out up to healthGraceMaxMs.
    if (runtimePid !== null && this.isPidProvablyDead(runtimePid, diagnostics)) {
      this._log("error", "runtime pid is dead — restarting now, no load grace", {
        runtimePid,
        consecutiveFailures: this.consecutiveFailures,
        streakMs,
        probeMs,
        loadFactor: load.loadFactor,
        graceSkippedMs: budget.graceMs,
      });
      this.failureStreakStartedAt = null;
      this.healthy = false;
      this.emit("restarting");
      await this.attemptRestart();
      return;
    }
    if (this.consecutiveFailures < this.maxFailures) return;
    // Half an interval of slack: timer jitter must not push an idle-host
    // restart to the next tick.
    if (streakMs + this.healthIntervalMs / 2 < budget.graceMs) {
      this._log("warn", "runtime unhealthy but within load grace — not restarting yet", {
        consecutiveFailures: this.consecutiveFailures,
        streakMs,
        graceMs: budget.graceMs,
        loadFactor: load.loadFactor,
        killBackoff: budget.killBackoff,
      });
      return;
    }
    this._log("error", "max health failures reached, restarting", {
      consecutiveFailures: this.consecutiveFailures,
      streakMs,
      graceMs: budget.graceMs,
      load,
      healthKillStreak: this.healthKillStreak,
      runtimePid,
      diagnostics,
    });
    this.healthKillStreak += 1;
    this.lastHealthKillAt = now;
    this.failureStreakStartedAt = null;
    this.healthy = false;
    this.emit("restarting");
    await this.attemptRestart();
  }

  private async attemptRestart() {
    if (this.restartInFlight) return;
    this.restartInFlight = true;
    try {
      for (let attempt = 0; attempt <= this.maxRestartRetries; attempt++) {
        if (this.stopped) return;
        this._log("info", "restart attempt", { attempt: attempt + 1, maxRetries: this.maxRestartRetries + 1 });
        try {
          this.cleanStaleState();
          await this.ensureRuntimeSpawned();
          this.healthy = true;
          this.resetHealthStreak();
          await this.httpConnect();
          this._log("info", "restart succeeded", { attempt: attempt + 1 });
          this.emit("ready");
          return;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this._log("warn", "restart attempt failed", { attempt: attempt + 1, error: message });
          if (attempt < this.maxRestartRetries && !this.stopped) {
            const delayMs = Math.min(
              this.restartBackoffBaseMs * 2 ** attempt,
              this.restartBackoffMaxMs
            );
            this._log("debug", "backoff before next attempt", { delayMs });
            await new Promise<void>((resolve) => {
              this.restartBackoffTimer = setTimeout(() => {
                this.restartBackoffTimer = null;
                resolve();
              }, delayMs);
            });
          }
        }
      }
      this.lost = true;
      this.pendingExitEvent = false;
      this._log("error", "all restart attempts exhausted, runtime lost — automatic restarts disarmed", {
        lostCooldownMs: this.lostCooldownMs,
      });
      this.armLostCooldown();
      this.emit("lost");
    } finally {
      this.restartInFlight = false;
      if (this.pendingExitEvent && !this.lost) {
        this.pendingExitEvent = false;
        void this.handleRuntimeExit();
      }
    }
  }

  private armLostCooldown() {
    clearTimeout(this.lostCooldownTimer ?? undefined);
    this.lostCooldownTimer = null;
    if (this.lostCooldownMs === 0) return;
    this.lostCooldownTimer = setTimeout(() => {
      this.lostCooldownTimer = null;
      if (this.stopped || !this.lost || this.restartInFlight) return;
      this._log("info", "lost cool-down elapsed — one more restart cycle", { lostCooldownMs: this.lostCooldownMs });
      this.lost = false;
      this.resetHealthStreak();
      this.emit("restarting");
      void this.attemptRestart();
    }, this.lostCooldownMs);
    this.lostCooldownTimer.unref?.();
  }

  private async httpLogin(): Promise<string | null> {
    try {
      // RT-SEC-05: read fresh on every login, a restarted runtime issues a new secret.
      const ownerSecret = this.readOwnerSecret?.() ?? null;
      const response = await fetch(`${this.baseUrl}/runtime/session/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(ownerSecret ? { "X-Runtime-Owner": ownerSecret } : {}),
        },
        body: JSON.stringify({ backendToken: "guardian-local", apps: [] }),
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 429) {
          this._log("warn", "runtime refused the guardian login (owner secret)", { status: response.status });
        }
        return null;
      }
      const data = (await response.json()) as { token?: string };
      return data.token ?? null;
    } catch {
      return null;
    }
  }

  private async httpConnect(): Promise<void> {
    try {
      const token = await this.httpLogin();
      if (!token) return;
      this.runtimeToken = token;
      const response = await fetch(`${this.baseUrl}/runtime/connect`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ appName: this.appName, pid: this._pid }),
      });
      if (!response.ok) return;
      const data = (await response.json()) as { connectionId?: string };
      this.connectionId = data.connectionId ?? null;
    } catch {
      // Non-fatal: PID refs remain as fallback
    }
  }

  private async httpDisconnect(): Promise<boolean> {
    if (!this.connectionId || !this.runtimeToken) return false;
    try {
      const response = await fetch(`${this.baseUrl}/runtime/disconnect`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.runtimeToken}`,
        },
        body: JSON.stringify({ connectionId: this.connectionId }),
      });
      this.connectionId = null;
      this.runtimeToken = null;
      return response.ok;
    } catch {
      this.connectionId = null;
      this.runtimeToken = null;
      return false;
    }
  }

  /**
   * Deliberate stop (last app quits, manual restart): ask the runtime to stop and WAIT for
   * its own drain (RT-LIFE-04: jobs requeued, Badger module shut down, library DB closed),
   * SIGKILL only once `shutdownGraceMs` has passed. A fixed 0.5 s wait here used to kill the
   * runtime halfway through that drain.
   */
  private async killRuntime() {
    const pid = readRuntimePid(this.pidPath);
    const child = this.child;
    const startedAt = Date.now();
    this._log("info", "stopping runtime process", {
      pid: pid ?? null,
      childPid: child?.pid ?? null,
      graceMs: this.shutdownGraceMs,
    });
    // Deliberate stop: its exit must not re-enter the crash-restart path.
    if (child) this.retiredChildren.add(child);
    // Stop by pid first (covers a runtime spawned by an earlier session or
    // another app instance), then make sure our own child's exit is observed.
    if (pid) {
      const ownChild = child && child.pid === pid ? child : null;
      try {
        this._requestStop(pid);
      } catch {}
      let exited = ownChild
        ? await this.waitChildGone(ownChild, this.shutdownGraceMs)
        : await this.waitPidGone(pid, this.shutdownGraceMs);
      if (!exited) {
        this._log("warn", "runtime did not finish its shutdown drain in time — sending SIGKILL", {
          pid,
          graceMs: this.shutdownGraceMs,
        });
        try {
          this._kill(pid, "SIGKILL");
        } catch {}
        exited = ownChild
          ? await this.waitChildGone(ownChild, this.childKillGraceMs)
          : await this.waitPidGone(pid, this.childKillGraceMs);
      }
      this._log(exited ? "info" : "error", exited ? "runtime process exited" : "runtime process still alive after SIGKILL", {
        pid,
        elapsedMs: Date.now() - startedAt,
      });
    }
    if (child && this.isChildAlive(child)) {
      await this.terminateChild(child, "kill_runtime", this.shutdownGraceMs);
    }
    try {
      unlinkSync(this.pidPath);
    } catch {}
    try {
      unlinkSync(this.refsPath);
    } catch {}
    this._log("info", "runtime process stopped", { elapsedMs: Date.now() - startedAt });
  }
}
