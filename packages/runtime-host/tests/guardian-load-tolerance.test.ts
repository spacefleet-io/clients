/**
 * @bugfix @regression-proof — #25 ultimate stress P1: runtime guardian kill loop.
 *
 * The full low-end stress run logged 41 "max health failures reached,
 * restarting": on a loaded 4-core box the guardian killed a runtime that was
 * merely slow after 3 failed probes (~10 s), over and over, and an orphan
 * runtime that held the port while not answering blocked every restart until
 * the guardian gave up. These tests pin:
 *   1. load-scaled grace: a loaded host tolerates a long unhealthy streak;
 *   2. idle parity: an idle host still restarts after maxFailures probes;
 *   3. backoff: every health-triggered restart doubles the next grace;
 *   4. orphan reclaim: an ownerless runtime on the port is terminated (exit
 *      observed) before exactly one replacement is spawned — and it is left
 *      alone when another live app references it or it is not our runtime;
 *   5. every failed probe logs the out-of-process diagnostics dump.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeGuardian as ProductionRuntimeGuardian, type RuntimeHostDeps, type RuntimeHostOptions, type SpawnCommand } from "../src/guardian";

/** Fake runtimes in these tests often never exit when asked to stop, so the
 *  production stop waits (4.5 s drain + 5 s after SIGKILL) would blow the test
 *  timeout. A test of those waits passes its own values. */
class RuntimeGuardian extends ProductionRuntimeGuardian {
  constructor(options: RuntimeHostOptions, deps?: RuntimeHostDeps) {
    super({ shutdownGraceMs: 100, childKillGraceMs: 100, ...options }, deps);
  }
}
import type { HostLoad } from "../src/load";

const SUITE = "runtime-host-load-tolerance";
const dummySpawn: SpawnCommand = { command: "/usr/bin/bun", args: ["src/index.ts"], cwd: "/tmp" };

const loadOf = (loadFactor: number): HostLoad => ({
  loadFactor,
  source: "loadavg",
  cpuPressure: null,
  loadavg1: loadFactor * 4,
  effectiveCpus: 4,
  cpuBusy: 1,
});

type LogLine = { at: number; level: string; message: string; meta?: Record<string, unknown> };
/** Graceful stop for tests: the platform's request would signal a real pid, so it
 *  goes through the injected kill mock as SIGTERM (the Linux mechanism). */
const stopVia =
  (processKill?: RuntimeHostDeps["processKill"]): NonNullable<RuntimeHostDeps["requestStop"]> =>
  (pid) => {
    try {
      processKill?.(pid, "SIGTERM");
      return true;
    } catch {
      return false;
    }
  };


const makeLog = (label: string, sink: LogLine[]) => (level: string, message: string, meta?: Record<string, unknown>) => {
  sink.push({ at: Date.now(), level, message, meta });
  console.info(`[${SUITE}:${label}] guardian ${level} ${message} ${meta ? JSON.stringify(meta).slice(0, 400) : ""}`);
};

const fakeChild = (pid: number) =>
  Object.assign(new EventEmitter(), { pid, killed: false, kill: vi.fn(() => true), unref: vi.fn() }) as never;

// Fake timers drive the guardian's setInterval/setTimeout and Date.now, so the
// grace/backoff arithmetic is exact and the suite pays no wall-clock waits.
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
/** Advance the clock while `p` is pending, then settle it. */
const drive = async <T>(p: Promise<T>, ms = 3_000): Promise<T> => {
  await advance(ms);
  return p;
};

const dump = (label: string, ctx: Record<string, unknown>) => {
  console.error(`=== [${SUITE}:${label}] snapshot ===\n${JSON.stringify(ctx, null, 2)}`);
};

describe("@bugfix @regression-proof guardian load tolerance (#25 P1)", () => {
  const dirs: string[] = [];
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tmp = () => {
    const d = mkdtempSync(joinPath(tmpdir(), "rt-load-"));
    dirs.push(d);
    return d;
  };

  /** Healthy start, then health flips per `healthy()`. Counts spawns. */
  const healthScenario = (
    label: string,
    opts: {
      load: () => HostLoad;
      healthy: () => boolean;
      diagnostics?: RuntimeHostDeps["processDiagnostics"];
      processKill?: RuntimeHostDeps["processKill"];
    },
  ) => {
    const dir = tmp();
    // The guardian attaches to an already-healthy runtime; runtime.pid names it.
    writeFileSync(joinPath(dir, "runtime.pid"), "70000");
    const logs: LogLine[] = [];
    const spawn = vi.fn(() => fakeChild(70_000 + spawn.mock.calls.length));
    const events: string[] = [];
    const guardian = new RuntimeGuardian(
      {
        appName: "test",
        spawnCommand: dummySpawn,
        runtimeDataDir: dir,
        runtimePort: 39999,
        healthIntervalMs: 30,
        healthProbeTimeoutMs: 20,
        maxConsecutiveFailures: 3,
        healthGraceMaxMs: 5_000,
        spawnDeadlineMs: 1000,
        waitDeadlineMs: 300,
        log: makeLog(label, logs),
      },
      {
        spawn,
        healthProbe: async () => opts.healthy(),
        waitForReady: async () => true,
        portProbe: async () => false,
        processPid: 44444,
        processKill: opts.processKill ?? vi.fn(),
        requestStop: stopVia(opts.processKill),
        hostLoad: opts.load,
        processDiagnostics: opts.diagnostics ?? (async () => ({ fake: true })),
      },
    );
    for (const e of ["ready", "restarting", "lost"] as const) guardian.on(e, () => events.push(e));
    return { dir, logs, spawn, events, guardian };
  };

  it("does not restart a slow runtime on a loaded host while its unhealthy streak is within the load grace", async () => {
    const label = "loaded-no-kill";
    let healthy = true;
    // factor 8: grace = (3-1) × 30 ms × 8 = 480 ms. The runtime is unhealthy for ~250 ms.
    const s = healthScenario(label, { load: () => loadOf(8), healthy: () => healthy });
    try {
      await drive(s.guardian.start(), 0);
      const spawnsAfterStart = s.spawn.mock.calls.length;
      healthy = false;
      console.info(`[${SUITE}:${label}] runtime unhealthy for 250 ms (grace 480 ms)`);
      await advance(250);
      healthy = true;
      await advance(120);
      const failures = s.logs.filter((l) => l.message === "health check failed").length;
      console.info(`[${SUITE}:${label}] failures=${failures} events=${JSON.stringify(s.events)} spawns=${s.spawn.mock.calls.length}`);
      expect(failures).toBeGreaterThanOrEqual(3);
      expect(s.logs.some((l) => l.message.startsWith("runtime unhealthy but within load grace"))).toBe(true);
      expect(s.events).toEqual(["ready"]);
      expect(s.spawn.mock.calls.length).toBe(spawnsAfterStart);
      expect(s.logs.some((l) => l.message === "runtime recovered")).toBe(true);
    } catch (err) {
      dump(label, { events: s.events, spawns: s.spawn.mock.calls.length, logs: s.logs.slice(-30) });
      throw err;
    } finally {
      await drive(s.guardian.stop());
    }
  });

  it("still restarts after maxConsecutiveFailures on an idle host", async () => {
    const label = "idle-parity";
    let healthy = true;
    const s = healthScenario(label, { load: () => loadOf(1), healthy: () => healthy });
    try {
      await drive(s.guardian.start(), 0);
      healthy = false;
      const t0 = Date.now();
      let ms = -1;
      s.guardian.once("restarting", () => { ms = Date.now() - t0; });
      await advance(400);
      console.info(`[${SUITE}:${label}] restarting after ${ms} ms events=${JSON.stringify(s.events)}`);
      const kill = s.logs.find((l) => l.message === "max health failures reached, restarting");
      expect(kill?.meta?.consecutiveFailures).toBe(3);
      // Probes at +30/+60/+90 ms; the third failure ends a 60 ms streak = grace.
      expect(ms).toBe(90);
    } catch (err) {
      dump(label, { events: s.events, logs: s.logs.slice(-30) });
      throw err;
    } finally {
      await drive(s.guardian.stop());
    }
  });

  it("doubles the grace after each health-triggered restart (no kill storm)", async () => {
    const label = "kill-backoff";
    let healthy = true;
    const s = healthScenario(label, { load: () => loadOf(1), healthy: () => healthy });
    try {
      await drive(s.guardian.start(), 0);
      healthy = false;
      // The runtime never comes back: kill #1 after a 60 ms streak, the
      // replacement then gets 120 ms, the next one 240 ms.
      await advance(400);
      const kills = s.logs.filter((l) => l.message === "max health failures reached, restarting");
      const graces = kills.map((k) => k.meta?.graceMs);
      console.info(`[${SUITE}:${label}] kill graces=${JSON.stringify(graces)} streaks=${JSON.stringify(kills.map((k) => k.meta?.streakMs))}`);
      expect(graces).toEqual([60, 120]);
      expect(kills.map((k) => k.meta?.streakMs)).toEqual([60, 120]);
    } catch (err) {
      dump(label, { events: s.events, logs: s.logs.slice(-40) });
      throw err;
    } finally {
      await drive(s.guardian.stop());
    }
  });

  it("logs the out-of-process diagnostics dump of the runtime on every failed probe", async () => {
    const label = "diagnostics-on-failure";
    let healthy = true;
    const diagnostics = vi.fn(async (pid: number) => ({ pid, state: "D", wchan: "wait_dev_flush", syscall: "fsync /data/runtime_jobs.db-wal" }));
    const s = healthScenario(label, { load: () => loadOf(1), healthy: () => healthy, diagnostics });
    try {
      await drive(s.guardian.start(), 0);
      healthy = false;
      await advance(80);
      const failed = s.logs.find((l) => l.message === "health check failed");
      console.info(`[${SUITE}:${label}] first failure meta=${JSON.stringify(failed?.meta)}`);
      expect(diagnostics).toHaveBeenCalledWith(70_000);
      expect(failed?.meta?.diagnostics).toMatchObject({ state: "D", syscall: "fsync /data/runtime_jobs.db-wal" });
      expect(failed?.meta?.load).toMatchObject({ loadFactor: 1 });
    } catch (err) {
      dump(label, { logs: s.logs.slice(-20) });
      throw err;
    } finally {
      await drive(s.guardian.stop());
    }
  });

  it("@regression-proof a diagnostics read that never returns does not wedge the health loop (#928)", async () => {
    const label = "diagnostics-hang";
    let healthy = true;
    // A cold PowerShell on a saturated box, at worst never answering.
    const diagnostics = vi.fn((_pid: number) => new Promise<Record<string, unknown>>(() => {}));
    const s = healthScenario(label, { load: () => loadOf(1), healthy: () => healthy, diagnostics });
    try {
      await drive(s.guardian.start(), 0);
      const spawnsAfterStart = s.spawn.mock.calls.length;
      healthy = false;
      // First failed probe at +30 ms; its dump is abandoned at the 10 s cap.
      await advance(30);
      expect(diagnostics).toHaveBeenCalledTimes(1);
      expect(s.logs.some((l) => l.message === "health check failed")).toBe(false);
      await advance(10_000);
      const failed = s.logs.find((l) => l.message === "health check failed");
      console.info(`[${SUITE}:${label}] first failure meta=${JSON.stringify(failed?.meta)}`);
      expect(failed?.meta?.diagnostics).toEqual({ error: "diagnostics timed out after 10000 ms" });
      // Each later tick waits out the cap too, yet the restart decision still lands.
      await advance(25_000);
      expect(s.logs.some((l) => l.message === "max health failures reached, restarting")).toBe(true);
      expect(s.events).toContain("restarting");
      expect(s.spawn.mock.calls.length).toBeGreaterThan(spawnsAfterStart);
    } catch (err) {
      dump(label, { events: s.events, logs: s.logs.slice(-20) });
      throw err;
    } finally {
      await drive(s.guardian.stop());
    }
  });

  // #25 P20 (ultimate confirm run, c053): the harness killed runtime pid
  // 260099; the guardian saw `alive:false` and a 2 ms refused probe, yet logged
  // "within load grace" ×22 at loadFactor 24.77 and respawned 125 s later.
  it("@bugfix @regression-proof restarts a dead runtime pid within one tick even at loadFactor 24 (#25 P20)", async () => {
    const label = "dead-pid-no-grace";
    let healthy = true;
    let runtimeDead = false;
    const kills: Array<{ pid: number; signal: unknown; result: string }> = [];
    const processKill = vi.fn((pid: number, signal?: string | number) => {
      const dead = runtimeDead && pid === 70_000;
      kills.push({ pid, signal, result: dead ? "ESRCH" : "ok" });
      if (dead) throw Object.assign(new Error(`kill ESRCH ${pid}`), { code: "ESRCH" });
      return true;
    }) as unknown as RuntimeHostDeps["processKill"];
    const diagnostics = vi.fn(async (pid: number) => (runtimeDead && pid === 70_000 ? { pid, alive: false } : { pid, alive: true, state: "R" }));
    // factor 24: the load grace would be min(5 000, 60 × 24) = 1 440 ms.
    const s = healthScenario(label, { load: () => loadOf(24), healthy: () => healthy, diagnostics, processKill });
    try {
      await drive(s.guardian.start(), 0);
      const spawnsAfterStart = s.spawn.mock.calls.length;
      healthy = false;
      runtimeDead = true;
      const t0 = Date.now();
      let ms = -1;
      s.guardian.once("restarting", () => { ms = Date.now() - t0; });
      console.info(`[${SUITE}:${label}] runtime pid 70000 killed at t0=${t0}; interval 30 ms, load grace 1440 ms`);
      // One health interval plus slack for the probe/restart microtasks.
      await advance(45);
      const failed = s.logs.filter((l) => l.message === "health check failed");
      console.info(
        `[${SUITE}:${label}] restarting after ${ms} ms; failures=${failed.length} events=${JSON.stringify(s.events)} ` +
          `spawns=${s.spawn.mock.calls.length - spawnsAfterStart} kills=${JSON.stringify(kills.slice(-4))}`,
      );
      expect(ms).toBeGreaterThanOrEqual(0);
      expect(ms).toBeLessThanOrEqual(30);
      expect(failed).toHaveLength(1);
      expect(s.logs.some((l) => l.message.startsWith("runtime unhealthy but within load grace"))).toBe(false);
      const fast = s.logs.find((l) => l.message.startsWith("runtime pid is dead"));
      expect(fast?.meta).toMatchObject({ runtimePid: 70_000, loadFactor: 24, graceSkippedMs: 1_440 });
      await advance(30);
      expect(s.spawn.mock.calls.length).toBe(spawnsAfterStart + 1);
      expect(s.events).toEqual(["ready", "restarting", "ready"]);
    } catch (err) {
      dump(label, { events: s.events, kills: kills.slice(-10), spawns: s.spawn.mock.calls.length, logs: s.logs.slice(-30) });
      throw err;
    } finally {
      await drive(s.guardian.stop());
    }
  });

  it("@bugfix @regression-proof still gives a live but slow runtime the full load grace at loadFactor 24 (#25 P20)", async () => {
    const label = "live-slow-keeps-grace";
    let healthy = true;
    const diagnostics = vi.fn(async (pid: number) => ({ pid, alive: true, state: "R", wchan: "0" }));
    const s = healthScenario(label, { load: () => loadOf(24), healthy: () => healthy, diagnostics });
    try {
      await drive(s.guardian.start(), 0);
      healthy = false;
      const t0 = Date.now();
      let ms = -1;
      s.guardian.once("restarting", () => { ms = Date.now() - t0; });
      await advance(1_000);
      const graceLogs = s.logs.filter((l) => l.message.startsWith("runtime unhealthy but within load grace"));
      console.info(`[${SUITE}:${label}] after 1000 ms: restarting=${ms} graceLogs=${graceLogs.length} events=${JSON.stringify(s.events)}`);
      expect(ms).toBe(-1);
      expect(graceLogs.length).toBeGreaterThan(0);
      expect(graceLogs.at(-1)?.meta).toMatchObject({ graceMs: 1_440, loadFactor: 24 });
      expect(s.logs.some((l) => l.message.startsWith("runtime pid is dead"))).toBe(false);
      await advance(800);
      console.info(`[${SUITE}:${label}] restarting after ${ms} ms events=${JSON.stringify(s.events)}`);
      // The streak must reach the grace (minus half an interval of jitter slack).
      expect(ms).toBeGreaterThanOrEqual(1_440 - 15);
      expect(ms).toBeLessThanOrEqual(1_440 + 60);
    } catch (err) {
      dump(label, { events: s.events, logs: s.logs.slice(-30) });
      throw err;
    } finally {
      await drive(s.guardian.stop());
    }
  });

  /** An orphan runtime (pid 4242) holds the port and never answers health. */
  const orphanScenario = (label: string, opts: { refs?: number[]; cmdline?: string | null; ignoresSigterm?: boolean }) => {
    const dir = tmp();
    const logs: LogLine[] = [];
    const ORPHAN = 4242;
    writeFileSync(joinPath(dir, "runtime.pid"), String(ORPHAN));
    if (opts.refs) writeFileSync(joinPath(dir, "runtime.refs"), opts.refs.join("\n") + "\n");
    let orphanAlive = true;
    let spawned = false;
    const signals: Array<string | number | undefined> = [];
    const processKill = vi.fn((pid: number, signal?: string | number) => {
      if (pid !== ORPHAN || !orphanAlive) {
        if (signal === 0) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
        return true;
      }
      if (signal !== 0) signals.push(signal);
      if (signal === "SIGKILL" || (signal === "SIGTERM" && !opts.ignoresSigterm)) orphanAlive = false;
      return true;
    });
    const spawn = vi.fn(() => {
      spawned = true;
      console.info(`[${SUITE}:${label}] spawn called; orphanAlive=${orphanAlive}`);
      return fakeChild(5151);
    });
    const guardian = new RuntimeGuardian(
      {
        appName: "test",
        spawnCommand: dummySpawn,
        runtimeDataDir: dir,
        runtimePort: 39999,
        healthIntervalMs: 100_000,
        healthProbeTimeoutMs: 20,
        spawnDeadlineMs: 500,
        waitDeadlineMs: 100,
        childKillGraceMs: 250,
        maxRestartRetries: 1,
        restartBackoffBaseMs: 500,
        log: makeLog(label, logs),
      },
      {
        spawn,
        healthProbe: async () => false,
        waitForReady: async () => spawned,
        portProbe: async () => orphanAlive || spawned,
        processPid: 44444,
        processKill,
        requestStop: stopVia(processKill),
        hostLoad: () => loadOf(1),
        processDiagnostics: async (pid) => ({ pid, state: "D" }),
        processCmdline: async () => (opts.cmdline === undefined ? "/usr/bin/bun src/index.ts" : opts.cmdline),
      },
    );
    return { dir, logs, spawn, guardian, signals, isOrphanAlive: () => orphanAlive, ORPHAN };
  };

  it("terminates an ownerless orphan runtime that holds the port, observes its exit, then spawns exactly one", async () => {
    const label = "orphan-reclaim";
    const s = orphanScenario(label, { ignoresSigterm: true });
    try {
      await drive(s.guardian.start());
      console.info(`[${SUITE}:${label}] started; signals=${JSON.stringify(s.signals)} spawns=${s.spawn.mock.calls.length}`);
      expect(s.signals).toEqual(["SIGTERM", "SIGKILL"]);
      expect(s.isOrphanAlive()).toBe(false);
      expect(s.spawn).toHaveBeenCalledTimes(1);
      expect(s.guardian.isHealthy).toBe(true);
      const order = s.logs.map((l) => l.message);
      expect(order.indexOf("orphan runtime terminated — port reclaimed")).toBeLessThan(order.indexOf("spawning runtime"));
      expect(s.logs.find((l) => l.message.startsWith("orphan runtime holds the port"))?.meta?.diagnostics).toMatchObject({ pid: 4242, state: "D" });
    } catch (err) {
      dump(label, { signals: s.signals, spawns: s.spawn.mock.calls.length, logs: s.logs.slice(-30) });
      throw err;
    } finally {
      await drive(s.guardian.stop());
    }
  });

  it("leaves an unresponsive runtime alone while another live app references it", async () => {
    const label = "orphan-owned-elsewhere";
    // process.pid is alive and is not the guardian's (44444) pid.
    const s = orphanScenario(label, { refs: [process.pid] });
    try {
      await drive(expect(s.guardian.start()).rejects.toThrow("runtime_external_wait_timeout"), 200);
      console.info(`[${SUITE}:${label}] signals=${JSON.stringify(s.signals)} spawns=${s.spawn.mock.calls.length}`);
      expect(s.signals).toEqual([]);
      expect(s.spawn).not.toHaveBeenCalled();
      expect(s.logs.some((l) => l.message.startsWith("unresponsive runtime is still referenced by another live app"))).toBe(true);
    } catch (err) {
      dump(label, { signals: s.signals, logs: s.logs.slice(-30) });
      throw err;
    } finally {
      await drive(s.guardian.stop());
    }
  });

  it("never kills a runtime.pid process whose command line is not our runtime (pid reuse)", async () => {
    const label = "orphan-not-runtime";
    const s = orphanScenario(label, { cmdline: "/usr/lib/firefox/firefox" });
    try {
      await drive(expect(s.guardian.start()).rejects.toThrow("runtime_external_wait_timeout"), 200);
      expect(s.signals).toEqual([]);
      expect(s.spawn).not.toHaveBeenCalled();
      expect(s.logs.some((l) => l.message.startsWith("runtime.pid points at a process that is not our runtime"))).toBe(true);
    } catch (err) {
      dump(label, { signals: s.signals, logs: s.logs.slice(-30) });
      throw err;
    } finally {
      await drive(s.guardian.stop());
    }
  });

  // #25 P4 (stress baseline b51ea3c4, x023): the quitting app's runtime logged a
  // clean drain and released runtime.pid, but kept the port bound while its
  // process wound down. The reopened app's guardian saw the port bound, waited
  // the full 20 s for a health answer that could never come (no re-probe of the
  // port), then refused to reclaim a holder it could not name — 20 s of
  // "waiting for the runtime" before its background recovery finally spawned.
  it("@bugfix @regression-proof spawns as soon as a draining runtime releases the port instead of waiting out the full wait (#25 P4)", async () => {
    const label = "draining-port-release";
    const dir = tmp();
    const logs: LogLine[] = [];
    const startedAt = Date.now();
    // The draining runtime holds the port for 1.2 s and never answers health.
    const RELEASE_AFTER_MS = 1_200;
    let spawnedAt: number | null = null;
    const portProbe = vi.fn(async () => spawnedAt !== null || Date.now() - startedAt < RELEASE_AFTER_MS);
    const spawn = vi.fn(() => {
      spawnedAt = Date.now() - startedAt;
      console.info(`[${SUITE}:${label}] spawn at +${spawnedAt} ms`);
      return fakeChild(6161);
    });
    const healthy = () => spawnedAt !== null;
    // Polls the fake health on the (fake) clock until the deadline, like probe.ts.
    const waitForReady = async (_baseUrl: string, deadlineMs: number, intervalMs: number) => {
      const deadline = Date.now() + deadlineMs;
      while (Date.now() < deadline) {
        if (healthy()) return true;
        await new Promise((r) => setTimeout(r, intervalMs));
      }
      return false;
    };
    const portHolders = vi.fn(async (port: number) => ({ port, listening: true, holders: [] }));
    const guardian = new RuntimeGuardian(
      {
        appName: "test",
        spawnCommand: dummySpawn,
        runtimeDataDir: dir,
        runtimePort: 39999,
        healthIntervalMs: 100_000,
        healthProbeTimeoutMs: 20,
        spawnDeadlineMs: 5_000,
        waitDeadlineMs: 20_000,
        maxRestartRetries: 1,
        log: makeLog(label, logs),
      },
      {
        spawn,
        healthProbe: async () => healthy(),
        waitForReady,
        portProbe,
        processPid: 44444,
        processKill: vi.fn(() => true),
        requestStop: stopVia(),
        hostLoad: () => loadOf(1),
        processDiagnostics: async (pid) => ({ pid }),
        processCmdline: async () => null,
        portHolders,
      },
    );
    try {
      // Past the whole 20 s wait, so the unfixed guardian settles (rejects) too.
      await drive(guardian.start(), 25_000);
      console.info(`[${SUITE}:${label}] started; spawnedAt=+${spawnedAt} ms portProbes=${portProbe.mock.calls.length} healthy=${guardian.isHealthy}`);
      expect(guardian.isHealthy).toBe(true);
      expect(spawn).toHaveBeenCalledTimes(1);
      // Within two re-probe intervals of the release, not after the 20 s wait.
      expect(spawnedAt).not.toBeNull();
      expect(spawnedAt as unknown as number).toBeGreaterThanOrEqual(RELEASE_AFTER_MS);
      expect(spawnedAt as unknown as number).toBeLessThanOrEqual(RELEASE_AFTER_MS + 1_000);
      const order = logs.map((l) => l.message);
      expect(order).toContain("port released while waiting for its holder — spawning");
      expect(order.indexOf("port released while waiting for its holder — spawning")).toBeLessThan(order.indexOf("spawning runtime"));
    } catch (err) {
      dump(label, { spawnedAt, portProbes: portProbe.mock.calls.length, logs: logs.slice(-30) });
      throw err;
    } finally {
      await drive(guardian.stop());
    }
  });

  it("@bugfix @regression-proof logs who holds the port when the holder cannot be named (#25 P4)", async () => {
    const label = "holder-unknown-dump";
    const dir = tmp();
    const logs: LogLine[] = [];
    const portHolders = vi.fn(async (port: number) => ({ port, listening: true, holders: [{ pid: 777, comm: "bun", cmdline: "bun src/index.ts" }] }));
    const guardian = new RuntimeGuardian(
      {
        appName: "test",
        spawnCommand: dummySpawn,
        runtimeDataDir: dir,
        runtimePort: 39999,
        healthIntervalMs: 100_000,
        healthProbeTimeoutMs: 20,
        spawnDeadlineMs: 500,
        waitDeadlineMs: 100,
        maxRestartRetries: 1,
        log: makeLog(label, logs),
      },
      {
        spawn: vi.fn(() => fakeChild(1)),
        healthProbe: async () => false,
        waitForReady: async () => false,
        portProbe: async () => true,
        processPid: 44444,
        processKill: vi.fn(() => true),
        requestStop: stopVia(),
        hostLoad: () => loadOf(1),
        processDiagnostics: async (pid) => ({ pid }),
        processCmdline: async () => null,
        portHolders,
      },
    );
    try {
      await drive(expect(guardian.start()).rejects.toThrow("runtime_external_wait_timeout"), 200);
      const unknown = logs.find((l) => l.message.startsWith("port bound but no runtime.pid — holder unknown"));
      console.info(`[${SUITE}:${label}] holder-unknown log meta=${JSON.stringify(unknown?.meta)}`);
      expect(portHolders).toHaveBeenCalledWith(39999);
      expect(unknown?.meta?.portHolders).toMatchObject({ holders: [{ pid: 777, comm: "bun" }] });
    } catch (err) {
      dump(label, { logs: logs.slice(-30) });
      throw err;
    } finally {
      await drive(guardian.stop());
    }
  });

  it("@bugfix @regression-proof never spawns beside a stalled holder whose re-probes merely time out (#25 P4)", async () => {
    const label = "stalled-holder-no-spawn";
    const dir = tmp();
    const logs: LogLine[] = [];
    const spawn = vi.fn(() => fakeChild(7171));
    // The connect probe times out (reads "not bound"), but the port is never
    // refused: the holder is alive, just stalled.
    const portReleased = vi.fn(async () => false);
    const guardian = new RuntimeGuardian(
      {
        appName: "test",
        spawnCommand: dummySpawn,
        runtimeDataDir: dir,
        runtimePort: 39999,
        healthIntervalMs: 100_000,
        healthProbeTimeoutMs: 20,
        spawnDeadlineMs: 500,
        waitDeadlineMs: 2_000,
        maxRestartRetries: 1,
        log: makeLog(label, logs),
      },
      {
        spawn,
        healthProbe: async () => false,
        waitForReady: async (_baseUrl, deadlineMs) => {
          await new Promise((r) => setTimeout(r, deadlineMs));
          return false;
        },
        // First probe sees the bound port; every later connect probe times out.
        portProbe: vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false),
        portReleased,
        processPid: 44444,
        processKill: vi.fn(() => true),
        requestStop: stopVia(),
        hostLoad: () => loadOf(1),
        processDiagnostics: async (pid) => ({ pid }),
        processCmdline: async () => null,
        portHolders: async (port) => ({ port }),
      },
    );
    try {
      await drive(expect(guardian.start()).rejects.toThrow("runtime_external_wait_timeout"), 3_000);
      // Only the wait itself is under test: the background recovery that
      // follows start()'s failure has its own (pre-existing) spawn path.
      const order = logs.map((l) => l.message);
      const gaveUp = order.indexOf("initial runtime start failed, entering background recovery");
      const firstSpawn = order.indexOf("spawning runtime");
      console.info(`[${SUITE}:${label}] releasedProbes=${portReleased.mock.calls.length} gaveUpAt=${gaveUp} firstSpawnAt=${firstSpawn}`);
      expect(portReleased.mock.calls.length).toBeGreaterThan(1);
      expect(gaveUp).toBeGreaterThan(-1);
      expect(firstSpawn === -1 || firstSpawn > gaveUp).toBe(true);
      expect(logs.some((l) => l.message.startsWith("port released while waiting"))).toBe(false);
    } catch (err) {
      dump(label, { spawns: spawn.mock.calls.length, logs: logs.slice(-30) });
      throw err;
    } finally {
      await drive(guardian.stop());
    }
  });
});
