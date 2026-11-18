import { EventEmitter, once } from "node:events";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join as joinPath } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import { RuntimeGuardian as ProductionRuntimeGuardian, type RuntimeHostDeps, type RuntimeHostOptions, type SpawnCommand } from "../src/guardian";

/** Fake runtimes in these tests often never exit when asked to stop, so the
 *  production stop waits (4.5 s drain + 5 s after SIGKILL) would blow the test
 *  timeout. A test of those waits passes its own values. */
class RuntimeGuardian extends ProductionRuntimeGuardian {
  constructor(options: RuntimeHostOptions, deps?: RuntimeHostDeps) {
    super({ shutdownGraceMs: 100, childKillGraceMs: 100, ...options }, deps);
  }
}
import { getDesktopPlatform, setDesktopPlatformForTests } from "@space/desktop-platform";
import type { HostLoad } from "../src/load";
import { getLivePids, readPidsFromFile, readRuntimePid, registerPid } from "../src/refs";

const SUITE = "runtime-host-guardian";

/** Pin host load to idle so health-failure timing does not depend on the
 *  machine running the suite (#25: the guardian scales its grace by load). */
const idleLoad = (): HostLoad => ({ loadFactor: 1, source: "loadavg", cpuPressure: null, loadavg1: 0, effectiveCpus: 4, cpuBusy: 0 });

const dummySpawn: SpawnCommand = { command: "true", args: [], cwd: "/tmp" };

type TransitionEvent = { at: number; event: string };
/** Graceful stop for tests: the platform's request would signal a real pid, so it
 *  goes through the injected kill mock as SIGTERM (the Linux mechanism), and a
 *  fake runtime child exits when asked, like a real one. */
const liveFakes = new Map<number, ChildProcess>();
const stopVia =
  (processKill?: (pid: number, signal?: string | number) => boolean): NonNullable<RuntimeHostDeps["requestStop"]> =>
  (pid) => {
    const fake = liveFakes.get(pid);
    if (fake) {
      fake.kill("SIGTERM");
      return true;
    }
    try {
      processKill?.(pid, "SIGTERM");
      return true;
    } catch {
      return false;
    }
  };


const recordEvents = (guardian: RuntimeGuardian, sink: TransitionEvent[]) => {
  const stamp = (event: string) => () => sink.push({ at: Date.now(), event });
  guardian.on("ready", stamp("ready"));
  guardian.on("restarting", stamp("restarting"));
  guardian.on("lost", stamp("lost"));
};

/** A fake runtime child that, like a real process, exits after it is signalled.
 *  The guardian awaits the exit of a child it terminates before respawning. */
const killableChild = (pid: number) => {
  const child = Object.assign(new EventEmitter(), {
    pid,
    killed: false,
    unref: vi.fn(),
    kill: vi.fn((signal?: NodeJS.Signals) => {
      child.killed = true;
      setImmediate(() => child.emit("exit", null, signal ?? "SIGTERM"));
      return true;
    }),
  });
  liveFakes.set(pid, child as unknown as ChildProcess);
  return child as unknown as ChildProcess;
};

const dumpGuardianSnapshot = (
  label: string,
  ctx: {
    dir?: string;
    guardian?: RuntimeGuardian | null;
    transitions?: TransitionEvent[];
    spawnMock?: ReturnType<typeof vi.fn>;
    childPidsSpawned?: number[];
    childExitCodes?: Array<number | null>;
    expectedEvents?: string[];
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    console.error(`dir: ${ctx.dir ?? "(none)"}`);
    if (ctx.dir) {
      const pidPath = joinPath(ctx.dir, "runtime.pid");
      const refsPath = joinPath(ctx.dir, "runtime.refs");
      const logPath = joinPath(ctx.dir, "runtime.log");
      console.error(`pid file: exists=${existsSync(pidPath)} value=${JSON.stringify(readRuntimePid(pidPath))}`);
      console.error(`refs file: exists=${existsSync(refsPath)} pids=${JSON.stringify(readPidsFromFile(refsPath))} live=${JSON.stringify(getLivePids(refsPath))}`);
      console.error(`log file: exists=${existsSync(logPath)}`);
      if (existsSync(logPath)) {
        try {
          const body = readFileSync(logPath, "utf8");
          const tail = body.length > 2000 ? body.slice(-2000) : body;
          console.error(`runtime.log tail (${tail.length}b):\n${tail}`);
        } catch (e) {
          console.error(`(runtime.log read failed: ${e instanceof Error ? e.message : String(e)})`);
        }
      }
    }
    if (ctx.guardian) {
      console.error(`guardian.isHealthy: ${ctx.guardian.isHealthy}`);
      console.error(`guardian.logPath: ${ctx.guardian.logPath ?? "(unset)"}`);
    }
    if (ctx.transitions) {
      console.error(`recent transitions (${ctx.transitions.length}):\n${JSON.stringify(ctx.transitions, null, 2)}`);
    }
    if (ctx.spawnMock) {
      console.error(`spawn call count: ${ctx.spawnMock.mock.calls.length}`);
    }
    if (ctx.childPidsSpawned) {
      console.error(`child pids spawned: ${JSON.stringify(ctx.childPidsSpawned)}`);
    }
    if (ctx.childExitCodes) {
      console.error(`child exit codes: ${JSON.stringify(ctx.childExitCodes)}`);
    }
    if (ctx.expectedEvents) {
      console.error(`expected events: ${JSON.stringify(ctx.expectedEvents)}`);
    }
    console.error(`env snapshot: pid=${process.pid} platform=${process.platform} node=${process.version}`);
    if (ctx.extra) {
      console.error(`extra:\n${JSON.stringify(ctx.extra, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

const makeGuardian = (
  dataDir: string,
  overrides?: {
    appName?: string;
    healthy?: boolean | (() => boolean);
    spawnPid?: number;
    pid?: number;
    onSpawn?: () => void;
  }
) => {
  let healthResult = overrides?.healthy ?? true;
  const spawnMock = vi.fn(() => {
    overrides?.onSpawn?.();
    const fakeChild = Object.assign(new (require("node:events").EventEmitter)(), {
      pid: overrides?.spawnPid ?? 99999,
      killed: false,
      kill: vi.fn(),
      unref: vi.fn(),
    });
    return fakeChild as any;
  });

  return new RuntimeGuardian(
    {
      appName: overrides?.appName ?? "test-app",
      spawnCommand: dummySpawn,
      runtimeDataDir: dataDir,
      runtimePort: 39999,
      healthIntervalMs: 50,
      healthProbeTimeoutMs: 100,
      maxConsecutiveFailures: 3,
      spawnDeadlineMs: 1000,
      waitDeadlineMs: 1000,
    },
    {
      spawn: spawnMock,
      healthProbe: async () =>
        typeof healthResult === "function" ? healthResult() : healthResult,
      waitForReady: async () => {
        healthResult = true;
        return true;
      },
      processPid: overrides?.pid ?? process.pid,
      processKill: vi.fn(),
      requestStop: stopVia(),
      hostLoad: idleLoad,
    }
  );
};

describe("RuntimeGuardian", () => {
  let root: string;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const setup = () => {
    root = mkdtempSync(joinPath(tmpdir(), "rt-guardian-"));
    return root;
  };

  it("attaches to an existing healthy runtime without spawning", async () => {
    const dir = setup();
    console.info(`[${SUITE}:attach-healthy] dir=${dir} healthy=true (default) — expect ready, no spawn`);
    const guardian = makeGuardian(dir);
    const events: string[] = [];
    const transitions: TransitionEvent[] = [];
    guardian.on("ready", () => {
      events.push("ready");
      transitions.push({ at: Date.now(), event: "ready" });
    });

    try {
      await guardian.start();
      console.info(`[${SUITE}:attach-healthy] events after start=${JSON.stringify(events)} isHealthy=${guardian.isHealthy}`);
      expect(events).toEqual(["ready"]);
      expect(guardian.isHealthy).toBe(true);
      // No spawn needed
      await guardian.stop();
      console.info(`[${SUITE}:attach-healthy] OK`);
    } catch (err) {
      dumpGuardianSnapshot("attach-healthy-failure", {
        dir,
        guardian,
        transitions,
        expectedEvents: ["ready"],
        extra: { observedEvents: events },
      });
      throw err;
    }
  });

  it("@bugfix @regression-proof prepares the platform's default data dir (owner-only + legacy migration) before writing to it", async () => {
    // Pre-fix the guardian only mkdir'd the default dir, so nothing carried the old /tmp data over
    // and its first write (runtime.refs) made the new dir look already in use.
    const dir = setup();
    const host = getDesktopPlatform();
    const calls: Array<{ existedBefore: boolean; env: unknown }> = [];
    setDesktopPlatformForTests({
      ...host,
      paths: {
        ...host.paths,
        runtimeDataDir: () => dir,
        prepareRuntimeDataDir: (options) => {
          calls.push({ existedBefore: existsSync(joinPath(dir, "runtime.refs")), env: options?.env });
          return dir;
        },
      },
    });
    try {
      const guardian = new RuntimeGuardian(
        { appName: "test-app", spawnCommand: dummySpawn, runtimePort: 39999, healthIntervalMs: 100_000 },
        { healthProbe: async () => true, waitForReady: async () => true, processKill: vi.fn(), requestStop: stopVia(), hostLoad: idleLoad },
      );
      await guardian.start();
      console.info(`[${SUITE}:prepare-default-dir] calls=${JSON.stringify(calls.map((c) => c.existedBefore))}`);
      expect(calls).toEqual([{ existedBefore: false, env: process.env }]);
      await guardian.stop();
    } finally {
      setDesktopPlatformForTests(null);
    }
  });

  it("spawns the runtime when health probe fails", async () => {
    const dir = setup();
    console.info(`[${SUITE}:spawn-on-unhealthy] dir=${dir} healthy=false-then-true — expect spawn pid=99999`);
    let probeCount = 0;
    const guardian = makeGuardian(dir, {
      healthy: () => {
        probeCount += 1;
        const result = probeCount > 1; // fail first, succeed after spawn
        console.info(`[${SUITE}:spawn-on-unhealthy] healthProbe call=${probeCount} returns=${result}`);
        return result;
      },
    });
    const events: string[] = [];
    const transitions: TransitionEvent[] = [];
    guardian.on("ready", () => {
      events.push("ready");
      transitions.push({ at: Date.now(), event: "ready" });
    });

    try {
      await guardian.start();
      console.info(`[${SUITE}:spawn-on-unhealthy] events=${JSON.stringify(events)} pidFile=${readRuntimePid(joinPath(dir, "runtime.pid"))}`);
      expect(events).toEqual(["ready"]);
      expect(readRuntimePid(joinPath(dir, "runtime.pid"))).toBe(99999);
      await guardian.stop();
      console.info(`[${SUITE}:spawn-on-unhealthy] OK`);
    } catch (err) {
      dumpGuardianSnapshot("spawn-on-unhealthy-failure", {
        dir,
        guardian,
        transitions,
        childPidsSpawned: [99999],
        expectedEvents: ["ready"],
        extra: { observedEvents: events, probeCount },
      });
      throw err;
    }
  });

  it("@bugfix @regression-proof spawns the runtime through the platform's fd-closing launcher, so fds Electron leaks never reach it", async () => {
    const dir = setup();
    const base = getDesktopPlatform();
    const launcherCalls: Array<{ command: string; args: string[]; env: Record<string, string | undefined> | undefined }> = [];
    setDesktopPlatformForTests({
      ...base,
      processes: {
        ...base.processes,
        withoutInheritedHandles: (command, args, env) => {
          launcherCalls.push({ command, args, env });
          return { command: "sf-isolated-launcher", args: ["--isolated", command, ...args] };
        },
      },
    });
    const spawnMock = vi.fn(() => killableChild(99998));
    let healthy = false;
    const guardian = new RuntimeGuardian(
      {
        appName: "test-app",
        spawnCommand: { command: "sf-runtime", args: ["--serve"], cwd: "/tmp", env: { SF_MARKER: "1" } },
        runtimeDataDir: dir,
        runtimePort: 39999,
        healthIntervalMs: 50,
        healthProbeTimeoutMs: 100,
        maxConsecutiveFailures: 3,
        spawnDeadlineMs: 1000,
        waitDeadlineMs: 1000,
      },
      {
        spawn: spawnMock as unknown as RuntimeHostDeps["spawn"],
        healthProbe: async () => healthy,
        waitForReady: async () => {
          healthy = true;
          return true;
        },
        processPid: process.pid,
        processKill: vi.fn(),
        requestStop: stopVia(),
        hostLoad: idleLoad,
      }
    );
    try {
      await guardian.start();
      console.info(`[${SUITE}:isolated-launch] launcher=${JSON.stringify(launcherCalls.map((c) => [c.command, c.args]))} spawn=${JSON.stringify(spawnMock.mock.calls.map((c) => c.slice(0, 2)))}`);
      expect(launcherCalls).toHaveLength(1);
      expect(launcherCalls[0]).toMatchObject({ command: "sf-runtime", args: ["--serve"], env: { SF_MARKER: "1" } });
      expect(spawnMock.mock.calls[0]?.slice(0, 2)).toEqual(["sf-isolated-launcher", ["--isolated", "sf-runtime", "--serve"]]);
    } finally {
      setDesktopPlatformForTests(null);
      await guardian.stop();
    }
  });

  it("creates a runtime.log file when spawning", async () => {
    const dir = setup();
    console.info(`[${SUITE}:log-file-created] dir=${dir} — expect runtime.log to be created on spawn`);
    let probeCount = 0;
    const guardian = makeGuardian(dir, {
      healthy: () => {
        probeCount += 1;
        return probeCount > 1;
      },
    });

    try {
      await guardian.start();
      const logPath = joinPath(dir, "runtime.log");
      console.info(`[${SUITE}:log-file-created] logExists=${existsSync(logPath)} guardian.logPath=${guardian.logPath}`);
      expect(existsSync(logPath)).toBe(true);
      expect(guardian.logPath).toBe(logPath);
      await guardian.stop();
      console.info(`[${SUITE}:log-file-created] OK`);
    } catch (err) {
      dumpGuardianSnapshot("log-file-created-failure", {
        dir,
        guardian,
        extra: { probeCount },
      });
      throw err;
    }
  });

  it("registers its PID in the refs file on start", async () => {
    const dir = setup();
    console.info(`[${SUITE}:pid-registered] dir=${dir} processPid=11111 — expect refs to contain 11111`);
    const guardian = makeGuardian(dir, { pid: 11111 });

    try {
      await guardian.start();
      const refs = readPidsFromFile(joinPath(dir, "runtime.refs"));
      console.info(`[${SUITE}:pid-registered] refs after start=${JSON.stringify(refs)}`);
      expect(refs).toContain(11111);
      await guardian.stop();
      console.info(`[${SUITE}:pid-registered] OK`);
    } catch (err) {
      dumpGuardianSnapshot("pid-registered-failure", { dir, guardian, extra: { expectedPid: 11111 } });
      throw err;
    }
  });

  // --- Scenario: the last open app closes -> runtime shuts down ---
  it("kills the runtime when the last app stops", async () => {
    const dir = setup();
    console.info(`[${SUITE}:last-app-kill] dir=${dir} — start solo guardian, stop, expect kill(55555,SIGTERM)`);
    const killMock = vi.fn();
    const guardian = new RuntimeGuardian(
      {
        appName: "badger",
        spawnCommand: dummySpawn,
        runtimeDataDir: dir,
        runtimePort: 39999,
        healthIntervalMs: 100_000, // no ticks during test
        spawnDeadlineMs: 1000,
      },
      {
        spawn: vi.fn(() => {
          const fakeChild = Object.assign(new (require("node:events").EventEmitter)(), {
            pid: 55555,
            killed: false,
            kill: vi.fn(),
            unref: vi.fn(),
          });
          return fakeChild as any;
        }),
        healthProbe: async () => false,
        waitForReady: async () => true,
        processPid: 11111,
        processKill: killMock,
        requestStop: stopVia(killMock),
        hostLoad: idleLoad,
      }
    );

    try {
      await guardian.start();
      const pidAfterStart = readRuntimePid(joinPath(dir, "runtime.pid"));
      console.info(`[${SUITE}:last-app-kill] pid after start=${pidAfterStart}`);
      expect(pidAfterStart).toBe(55555);

      await guardian.stop();
      console.info(`[${SUITE}:last-app-kill] killMock calls=${JSON.stringify(killMock.mock.calls)}`);
      // Last ref removed -> runtime killed (httpDisconnect fails since no real server)
      expect(killMock).toHaveBeenCalledWith(55555, "SIGTERM");
      console.info(`[${SUITE}:last-app-kill] OK`);
    } catch (err) {
      dumpGuardianSnapshot("last-app-kill-failure", {
        dir,
        guardian,
        childPidsSpawned: [55555],
        extra: { killMockCalls: killMock.mock.calls, expected: [55555, "SIGTERM"] },
      });
      throw err;
    }
  });

  // --- Scenario: Both Badger and Parrot open, Parrot closes -> runtime stays ---
  it("does not kill the runtime when other apps still reference it", async () => {
    const dir = setup();
    console.info(`[${SUITE}:no-kill-with-other-ref] dir=${dir} pre-registering badger=${process.pid}; parrot pid=22222`);
    const killMock = vi.fn();

    // Simulate Badger already registered
    registerPid(joinPath(dir, "runtime.refs"), process.pid);

    const parrotGuardian = new RuntimeGuardian(
      {
        appName: "parrot",
        spawnCommand: dummySpawn,
        runtimeDataDir: dir,
        runtimePort: 39999,
        healthIntervalMs: 100_000,
      },
      {
        spawn: vi.fn(() => {
          const fakeChild = Object.assign(new (require("node:events").EventEmitter)(), {
            pid: 55555,
            killed: false,
            kill: vi.fn(),
            unref: vi.fn(),
          });
          return fakeChild as any;
        }),
        healthProbe: async () => true,
        waitForReady: async () => true,
        processPid: 22222,
        processKill: killMock,
        requestStop: stopVia(killMock),
        hostLoad: idleLoad,
      }
    );

    try {
      await parrotGuardian.start();
      const refsAfterStart = readPidsFromFile(joinPath(dir, "runtime.refs"));
      console.info(`[${SUITE}:no-kill-with-other-ref] refs after parrot-start=${JSON.stringify(refsAfterStart)}`);
      expect(refsAfterStart).toContain(process.pid); // badger
      expect(refsAfterStart).toContain(22222); // parrot

      await parrotGuardian.stop();
      const refsAfterStop = readPidsFromFile(joinPath(dir, "runtime.refs"));
      console.info(`[${SUITE}:no-kill-with-other-ref] refs after parrot-stop=${JSON.stringify(refsAfterStop)} killCalls=${JSON.stringify(killMock.mock.calls)}`);
      // Badger's PID (process.pid) is still alive -> runtime NOT killed
      expect(killMock).not.toHaveBeenCalled();
      // Parrot's PID removed, Badger's remains
      expect(refsAfterStop).toContain(process.pid);
      expect(refsAfterStop).not.toContain(22222);
      console.info(`[${SUITE}:no-kill-with-other-ref] OK`);
    } catch (err) {
      dumpGuardianSnapshot("no-kill-with-other-ref-failure", {
        dir,
        guardian: parrotGuardian,
        extra: { killMockCalls: killMock.mock.calls, badgerPid: process.pid, parrotPid: 22222 },
      });
      throw err;
    }
  });

  // --- Scenario: Runtime crashes while both apps are open ---
  it("emits 'restarting' and restarts when the runtime process exits @req RT-LIFE-05", async () => {
    const dir = setup();
    console.info(`[${SUITE}:restart-on-exit] dir=${dir} — spawn pid=77777, emit exit(1), expect [ready,restarting,ready]`);
    const events: string[] = [];
    const transitions: TransitionEvent[] = [];
    let fakeChild: any = null;

    const guardian = new RuntimeGuardian(
      {
        appName: "badger",
        spawnCommand: dummySpawn,
        runtimeDataDir: dir,
        runtimePort: 39999,
        healthIntervalMs: 100_000,
        spawnDeadlineMs: 1000,
      },
      {
        spawn: vi.fn(() => {
          fakeChild = Object.assign(new (require("node:events").EventEmitter)(), {
            pid: 77777,
            killed: false,
            kill: vi.fn(),
            unref: vi.fn(),
          });
          return fakeChild;
        }),
        healthProbe: async () => false,
        waitForReady: async () => true,
        processPid: 33333,
        processKill: vi.fn(),
        requestStop: stopVia(),
        hostLoad: idleLoad,
      }
    );

    guardian.on("ready", () => {
      events.push("ready");
      transitions.push({ at: Date.now(), event: "ready" });
    });
    guardian.on("restarting", () => {
      events.push("restarting");
      transitions.push({ at: Date.now(), event: "restarting" });
    });

    try {
      await guardian.start();
      console.info(`[${SUITE}:restart-on-exit] events after start=${JSON.stringify(events)}`);
      expect(events).toEqual(["ready"]);

      // Simulate runtime crash
      console.info(`[${SUITE}:restart-on-exit] emitting exit(1) on child`);
      fakeChild.emit("exit", 1, null);
      // Let the async restart flow run
      const startedAt = Date.now();
      await new Promise((r) => setTimeout(r, 100));
      console.info(`[${SUITE}:restart-on-exit] events after 100ms wait (elapsed=${Date.now() - startedAt}ms)=${JSON.stringify(events)}`);

      expect(events).toEqual(["ready", "restarting", "ready"]);
      await guardian.stop();
      console.info(`[${SUITE}:restart-on-exit] OK`);
    } catch (err) {
      dumpGuardianSnapshot("restart-on-exit-failure", {
        dir,
        guardian,
        transitions,
        childPidsSpawned: [77777],
        childExitCodes: [1],
        expectedEvents: ["ready", "restarting", "ready"],
        extra: { observedEvents: events },
      });
      throw err;
    }
  });

  // --- Scenario: Health monitor detects failure and restarts ---
  it("restarts after consecutive health failures @req RT-LIFE-05", async () => {
    const dir = setup();
    console.info(`[${SUITE}:restart-on-unhealth] dir=${dir} healthIntervalMs=30 maxConsecutiveFailures=3`);
    const events: string[] = [];
    const transitions: TransitionEvent[] = [];
    let healthOk = true;

    const guardian = new RuntimeGuardian(
      {
        appName: "badger",
        spawnCommand: dummySpawn,
        runtimeDataDir: dir,
        runtimePort: 39999,
        healthIntervalMs: 30,
        maxConsecutiveFailures: 3,
        spawnDeadlineMs: 1000,
      },
      {
        spawn: vi.fn(() => {
          const fakeChild = Object.assign(new (require("node:events").EventEmitter)(), {
            pid: 88888,
            killed: false,
            kill: vi.fn(),
            unref: vi.fn(),
          });
          return fakeChild as any;
        }),
        healthProbe: async () => healthOk,
        waitForReady: async () => {
          healthOk = true;
          return true;
        },
        processPid: 44444,
        processKill: vi.fn(),
        requestStop: stopVia(),
        hostLoad: idleLoad,
      }
    );

    guardian.on("ready", () => {
      events.push("ready");
      transitions.push({ at: Date.now(), event: "ready" });
    });
    guardian.on("restarting", () => {
      events.push("restarting");
      transitions.push({ at: Date.now(), event: "restarting" });
    });

    try {
      await guardian.start();
      console.info(`[${SUITE}:restart-on-unhealth] events after start=${JSON.stringify(events)}`);
      expect(events).toEqual(["ready"]);

      // Simulate runtime becoming unhealthy
      console.info(`[${SUITE}:restart-on-unhealth] flipping healthOk=false, waiting 250ms`);
      healthOk = false;
      const startedAt = Date.now();
      await new Promise((r) => setTimeout(r, 250));
      console.info(`[${SUITE}:restart-on-unhealth] events after wait (elapsed=${Date.now() - startedAt}ms)=${JSON.stringify(events)} isHealthy=${guardian.isHealthy}`);

      expect(events).toContain("restarting");
      expect(events[events.length - 1]).toBe("ready");
      expect(guardian.isHealthy).toBe(true);
      await guardian.stop();
      console.info(`[${SUITE}:restart-on-unhealth] OK`);
    } catch (err) {
      dumpGuardianSnapshot("restart-on-unhealth-failure", {
        dir,
        guardian,
        transitions,
        childPidsSpawned: [88888],
        extra: { observedEvents: events, healthOkFinal: healthOk },
      });
      throw err;
    }
  });

  // --- Scenario: Restart fails -> emit lost ---
  it("emits 'lost' when restart fails", async () => {
    const dir = setup();
    console.info(`[${SUITE}:restart-failure-emits-lost] dir=${dir} maxRestartRetries=1 waitForReady=always-false`);
    const events: string[] = [];
    const transitions: TransitionEvent[] = [];
    let healthOk = true;

    const guardian = new RuntimeGuardian(
      {
        appName: "badger",
        spawnCommand: dummySpawn,
        runtimeDataDir: dir,
        runtimePort: 39999,
        healthIntervalMs: 30,
        maxConsecutiveFailures: 2,
        maxRestartRetries: 1,
        restartBackoffBaseMs: 50,
        spawnDeadlineMs: 200,
      },
      {
        spawn: vi.fn(() => killableChild(66666)),
        healthProbe: async () => healthOk,
        waitForReady: async () => false, // restart always fails
        processPid: 55555,
        processKill: vi.fn(),
        requestStop: stopVia(),
        hostLoad: idleLoad,
      }
    );

    recordEvents(guardian, transitions);
    guardian.on("ready", () => events.push("ready"));
    guardian.on("restarting", () => events.push("restarting"));
    guardian.on("lost", () => events.push("lost"));

    try {
      await guardian.start();
      console.info(`[${SUITE}:restart-failure-emits-lost] events after start=${JSON.stringify(events)}`);
      expect(events).toEqual(["ready"]);

      console.info(`[${SUITE}:restart-failure-emits-lost] flipping healthOk=false, waiting 1500ms for restart loop to give up`);
      healthOk = false;
      const startedAt = Date.now();
      await new Promise((r) => setTimeout(r, 1500));
      console.info(`[${SUITE}:restart-failure-emits-lost] events after wait (elapsed=${Date.now() - startedAt}ms)=${JSON.stringify(events)}`);

      expect(events).toContain("restarting");
      expect(events).toContain("lost");
      await guardian.stop();
      console.info(`[${SUITE}:restart-failure-emits-lost] OK`);
    } catch (err) {
      dumpGuardianSnapshot("restart-failure-emits-lost-failure", {
        dir,
        guardian,
        transitions,
        childPidsSpawned: [66666],
        expectedEvents: ["ready", "restarting", "lost"],
        extra: { observedEvents: events },
      });
      throw err;
    }
  });

  // --- Scenario: Two guardians race to spawn ---
  it("second guardian waits while first spawns", async () => {
    const dir = setup();
    console.info(`[${SUITE}:two-guardians-race] dir=${dir} pids=[10001,10002] starting concurrently`);
    const events1: string[] = [];
    const events2: string[] = [];

    const guardian1 = makeGuardian(dir, { healthy: false, pid: 10001 });
    const guardian2 = makeGuardian(dir, { healthy: false, pid: 10002 });

    guardian1.on("ready", () => events1.push("ready"));
    guardian2.on("ready", () => events2.push("ready"));

    try {
      // Start both concurrently — one acquires the lock, the other waits
      const startedAt = Date.now();
      await Promise.all([guardian1.start(), guardian2.start()]);
      console.info(`[${SUITE}:two-guardians-race] both started in ${Date.now() - startedAt}ms events1=${JSON.stringify(events1)} events2=${JSON.stringify(events2)}`);

      expect(events1).toEqual(["ready"]);
      expect(events2).toEqual(["ready"]);

      // Both registered
      const refs = readPidsFromFile(joinPath(dir, "runtime.refs"));
      console.info(`[${SUITE}:two-guardians-race] refs=${JSON.stringify(refs)}`);
      expect(refs).toContain(10001);
      expect(refs).toContain(10002);

      await guardian1.stop();
      await guardian2.stop();
      console.info(`[${SUITE}:two-guardians-race] OK`);
    } catch (err) {
      dumpGuardianSnapshot("two-guardians-race-failure", {
        dir,
        guardian: guardian1,
        extra: { events1, events2, refs: readPidsFromFile(joinPath(dir, "runtime.refs")) },
      });
      throw err;
    }
  });

  // --- Scenario: Backoff retry recovers after transient failure ---
  it("retries with exponential backoff before emitting lost", async () => {
    const dir = setup();
    console.info(`[${SUITE}:exp-backoff-retry] dir=${dir} maxRestartRetries=3 base=50ms max=200ms — fail twice then succeed`);
    const events: string[] = [];
    const transitions: TransitionEvent[] = [];
    let healthOk = true;
    let spawnAttempts = 0;

    const guardian = new RuntimeGuardian(
      {
        appName: "badger",
        spawnCommand: dummySpawn,
        runtimeDataDir: dir,
        runtimePort: 39999,
        healthIntervalMs: 30,
        maxConsecutiveFailures: 2,
        maxRestartRetries: 3,
        restartBackoffBaseMs: 50,
        restartBackoffMaxMs: 200,
        spawnDeadlineMs: 50,
      },
      {
        spawn: vi.fn(() => killableChild(77700 + spawnAttempts)),
        healthProbe: async () => healthOk,
        waitForReady: async () => {
          spawnAttempts++;
          console.info(`[${SUITE}:exp-backoff-retry] waitForReady call #${spawnAttempts}`);
          // Fail first 2 attempts, succeed on 3rd
          if (spawnAttempts >= 3) {
            healthOk = true;
            return true;
          }
          return false;
        },
        processPid: 55550,
        processKill: vi.fn(),
        requestStop: stopVia(),
        hostLoad: idleLoad,
      }
    );

    guardian.on("ready", () => {
      events.push("ready");
      transitions.push({ at: Date.now(), event: "ready" });
    });
    guardian.on("restarting", () => {
      events.push("restarting");
      transitions.push({ at: Date.now(), event: "restarting" });
    });
    guardian.on("lost", () => {
      events.push("lost");
      transitions.push({ at: Date.now(), event: "lost" });
    });

    try {
      await guardian.start();
      console.info(`[${SUITE}:exp-backoff-retry] events after start=${JSON.stringify(events)}, resetting spawnAttempts to 0 and going unhealthy`);
      spawnAttempts = 0;
      healthOk = false;
      const startedAt = Date.now();
      await new Promise((r) => setTimeout(r, 1500));
      console.info(`[${SUITE}:exp-backoff-retry] events after 1500ms wait (elapsed=${Date.now() - startedAt}ms) events=${JSON.stringify(events)} spawnAttempts=${spawnAttempts}`);

      expect(events).toContain("restarting");
      expect(events).toContain("ready");
      expect(events).not.toContain("lost");
      expect(spawnAttempts).toBeGreaterThanOrEqual(3);
      await guardian.stop();
      console.info(`[${SUITE}:exp-backoff-retry] OK`);
    } catch (err) {
      dumpGuardianSnapshot("exp-backoff-retry-failure", {
        dir,
        guardian,
        transitions,
        extra: { observedEvents: events, spawnAttempts, healthOkFinal: healthOk },
      });
      throw err;
    }
  });

  // --- Scenario: Exit during in-flight restart is queued ---
  it("processes queued exit event after in-flight restart completes", async () => {
    const dir = setup();
    console.info(`[${SUITE}:queued-exit-restart] dir=${dir} — first exit while restart in flight should re-trigger restart`);
    const events: string[] = [];
    const transitions: TransitionEvent[] = [];
    let fakeChild: any = null;
    let spawnCount = 0;

    const guardian = new RuntimeGuardian(
      {
        appName: "badger",
        spawnCommand: dummySpawn,
        runtimeDataDir: dir,
        runtimePort: 39999,
        healthIntervalMs: 100_000,
        maxRestartRetries: 2,
        restartBackoffBaseMs: 50,
        spawnDeadlineMs: 200,
      },
      {
        spawn: vi.fn(() => {
          spawnCount++;
          fakeChild = Object.assign(new (require("node:events").EventEmitter)(), {
            pid: 78000 + spawnCount,
            killed: false,
            kill: vi.fn(),
            unref: vi.fn(),
          });
          console.info(`[${SUITE}:queued-exit-restart] spawn #${spawnCount} pid=${78000 + spawnCount}`);
          return fakeChild;
        }),
        healthProbe: async () => false,
        waitForReady: async () => {
          // Simulate: during first restart, the new child also crashes
          if (spawnCount === 2 && fakeChild) {
            console.info(`[${SUITE}:queued-exit-restart] spawnCount=2 — queuing exit(1) in 10ms`);
            // Queue an exit event during restart
            setTimeout(() => fakeChild.emit("exit", 1, null), 10);
          }
          return true;
        },
        processPid: 55551,
        processKill: vi.fn(),
        requestStop: stopVia(),
        hostLoad: idleLoad,
      }
    );

    guardian.on("ready", () => {
      events.push("ready");
      transitions.push({ at: Date.now(), event: "ready" });
    });
    guardian.on("restarting", () => {
      events.push("restarting");
      transitions.push({ at: Date.now(), event: "restarting" });
    });

    try {
      await guardian.start();
      console.info(`[${SUITE}:queued-exit-restart] events after start=${JSON.stringify(events)}`);
      expect(events).toEqual(["ready"]);

      // Trigger first exit
      console.info(`[${SUITE}:queued-exit-restart] emitting first exit(1)`);
      fakeChild.emit("exit", 1, null);
      const startedAt = Date.now();
      await new Promise((r) => setTimeout(r, 500));
      console.info(`[${SUITE}:queued-exit-restart] events after 500ms (elapsed=${Date.now() - startedAt}ms)=${JSON.stringify(events)} spawnCount=${spawnCount}`);

      // Should see: ready (initial), restarting (first exit), ready (first restart),
      // restarting (queued exit), ready (second restart)
      const restartCount = events.filter((e) => e === "restarting").length;
      expect(restartCount).toBeGreaterThanOrEqual(2);
      expect(events[events.length - 1]).toBe("ready");
      await guardian.stop();
      console.info(`[${SUITE}:queued-exit-restart] OK restartCount=${restartCount}`);
    } catch (err) {
      dumpGuardianSnapshot("queued-exit-restart-failure", {
        dir,
        guardian,
        transitions,
        childExitCodes: [1, 1],
        extra: { observedEvents: events, spawnCount, restartCount: events.filter((e) => e === "restarting").length },
      });
      throw err;
    }
  });

  // --- Scenario: stop() always kills when last app, even if httpDisconnect succeeds ---
  it("@bugfix @regression-proof kills runtime on stop when last app regardless of disconnect result", async () => {
    const dir = setup();
    console.info(`[${SUITE}:stop-always-kills-last] dir=${dir} — verify orphan-prevention: kill on stop even with successful disconnect`);
    const killMock = vi.fn();

    // Create a guardian that will successfully HTTP-disconnect
    // (simulated by the runtime being "up" — though the mock doesn't actually call disconnect)
    const guardian = new RuntimeGuardian(
      {
        appName: "badger",
        spawnCommand: dummySpawn,
        runtimeDataDir: dir,
        runtimePort: 39999,
        healthIntervalMs: 100_000,
        spawnDeadlineMs: 1000,
      },
      {
        spawn: vi.fn(() => {
          const fakeChild = Object.assign(new (require("node:events").EventEmitter)(), {
            pid: 55555,
            killed: false,
            kill: vi.fn(),
            unref: vi.fn(),
          });
          return fakeChild as any;
        }),
        healthProbe: async () => false,
        waitForReady: async () => true,
        processPid: 11111,
        processKill: killMock,
        requestStop: stopVia(killMock),
        hostLoad: idleLoad,
      }
    );

    try {
      await guardian.start();
      console.info(`[${SUITE}:stop-always-kills-last] started — calling stop`);
      await guardian.stop();
      console.info(`[${SUITE}:stop-always-kills-last] killMock calls=${JSON.stringify(killMock.mock.calls)}`);

      // Must kill regardless of disconnect result — this is the orphan prevention fix
      expect(killMock).toHaveBeenCalledWith(55555, "SIGTERM");
      console.info(`[${SUITE}:stop-always-kills-last] OK`);
    } catch (err) {
      dumpGuardianSnapshot("stop-always-kills-last-failure", {
        dir,
        guardian,
        childPidsSpawned: [55555],
        extra: { killMockCalls: killMock.mock.calls, expected: [55555, "SIGTERM"] },
      });
      throw err;
    }
  });

  // --- Scenario: the stop waits for the runtime's own drain (RT-LIFE-04, #671 R2) ---
  const stopTimingGuardian = (dir: string, drainMs: number | null, shutdownGraceMs: number) => {
    const signals: string[] = [];
    const child = Object.assign(new EventEmitter(), {
      pid: 61001,
      killed: false,
      kill: vi.fn(),
      unref: vi.fn(),
    });
    const guardian = new RuntimeGuardian(
      {
        appName: "badger",
        spawnCommand: dummySpawn,
        runtimeDataDir: dir,
        runtimePort: 39999,
        healthIntervalMs: 100_000,
        spawnDeadlineMs: 1000,
        shutdownGraceMs,
        childKillGraceMs: 1_000,
      },
      {
        spawn: vi.fn(() => child as unknown as ChildProcess),
        healthProbe: async () => false,
        waitForReady: async () => true,
        processPid: 11111,
        // SIGKILL ends the fake at once, like a real one.
        processKill: vi.fn((_pid: number, signal?: string | number) => {
          signals.push(String(signal));
          if (signal === "SIGKILL") setImmediate(() => child.emit("exit", null, "SIGKILL"));
          return true;
        }),
        // A runtime that drains for `drainMs` after the stop request, or never exits (null).
        requestStop: () => {
          signals.push("SIGTERM");
          if (drainMs !== null) setTimeout(() => child.emit("exit", 0, null), drainMs);
          return true;
        },
        hostLoad: idleLoad,
      }
    );
    return { guardian, signals };
  };

  it("@bugfix @regression-proof stop waits for the runtime's shutdown drain instead of SIGKILLing at 0.5 s @req RT-LIFE-04", async () => {
    const dir = setup();
    const DRAIN_MS = 1_200;
    console.info(`[${SUITE}:stop-waits-for-drain] dir=${dir} drainMs=${DRAIN_MS} shutdownGraceMs=4500`);
    const { guardian, signals } = stopTimingGuardian(dir, DRAIN_MS, 4_500);
    await guardian.start();
    const startedAt = Date.now();
    await guardian.stop();
    const elapsedMs = Date.now() - startedAt;
    console.info(`[${SUITE}:stop-waits-for-drain] signals=${JSON.stringify(signals)} elapsedMs=${elapsedMs}`);
    // The old fixed 0.5 s wait SIGKILLed this drain halfway through.
    expect(signals).toEqual(["SIGTERM"]);
    expect(elapsedMs).toBeGreaterThanOrEqual(DRAIN_MS - 100);
    expect(existsSync(joinPath(dir, "runtime.pid"))).toBe(false);
  });

  it("@req RT-LIFE-04 stop SIGKILLs a runtime that ignores the stop request only after the shutdown grace", async () => {
    const dir = setup();
    const GRACE_MS = 700;
    console.info(`[${SUITE}:stop-kills-after-grace] dir=${dir} runtime never exits shutdownGraceMs=${GRACE_MS}`);
    const { guardian, signals } = stopTimingGuardian(dir, null, GRACE_MS);
    await guardian.start();
    const startedAt = Date.now();
    await guardian.stop();
    const elapsedMs = Date.now() - startedAt;
    console.info(`[${SUITE}:stop-kills-after-grace] signals=${JSON.stringify(signals)} elapsedMs=${elapsedMs}`);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(elapsedMs).toBeGreaterThanOrEqual(GRACE_MS - 100);
    expect(elapsedMs).toBeLessThan(GRACE_MS + 1_000);
  });

  // --- Scenario: killSync kills runtime synchronously ---
  it("@bugfix @regression-proof killSync kills runtime without async for process.on('exit')", async () => {
    const dir = setup();
    console.info(`[${SUITE}:killSync-no-async] dir=${dir} — verify killSync works in process.on('exit') context`);
    const killMock = vi.fn();
    const guardian = new RuntimeGuardian(
      {
        appName: "badger",
        spawnCommand: dummySpawn,
        runtimeDataDir: dir,
        runtimePort: 39999,
        healthIntervalMs: 100_000,
        spawnDeadlineMs: 1000,
      },
      {
        spawn: vi.fn(() => {
          const fakeChild = Object.assign(new (require("node:events").EventEmitter)(), {
            pid: 44444,
            killed: false,
            kill: vi.fn(),
            unref: vi.fn(),
          });
          return fakeChild as any;
        }),
        healthProbe: async () => false,
        waitForReady: async () => true,
        processPid: 22222,
        processKill: killMock,
        requestStop: stopVia(killMock),
        hostLoad: idleLoad,
      }
    );

    try {
      await guardian.start();
      console.info(`[${SUITE}:killSync-no-async] started — calling killSync synchronously (no await)`);
      // Call killSync synchronously — no await, simulates process.on('exit')
      guardian.killSync();
      console.info(`[${SUITE}:killSync-no-async] killMock calls=${JSON.stringify(killMock.mock.calls)}`);

      expect(killMock).toHaveBeenCalledWith(44444, "SIGTERM");
      console.info(`[${SUITE}:killSync-no-async] OK`);
    } catch (err) {
      dumpGuardianSnapshot("killSync-no-async-failure", {
        dir,
        guardian,
        childPidsSpawned: [44444],
        extra: { killMockCalls: killMock.mock.calls, expected: [44444, "SIGTERM"] },
      });
      throw err;
    }
  });

  // --- Scenario: killSync does NOT kill when other apps still reference runtime ---
  it("killSync does not kill when other apps still reference runtime", async () => {
    const dir = setup();
    console.info(`[${SUITE}:killSync-respect-other-ref] dir=${dir} — pre-register live pid=${process.pid}, then killSync from parrot`);
    const killMock = vi.fn();

    // Simulate another app already registered
    registerPid(joinPath(dir, "runtime.refs"), process.pid);

    const guardian = new RuntimeGuardian(
      {
        appName: "parrot",
        spawnCommand: dummySpawn,
        runtimeDataDir: dir,
        runtimePort: 39999,
        healthIntervalMs: 100_000,
      },
      {
        spawn: vi.fn(() => {
          const fakeChild = Object.assign(new (require("node:events").EventEmitter)(), {
            pid: 33333,
            killed: false,
            kill: vi.fn(),
            unref: vi.fn(),
          });
          return fakeChild as any;
        }),
        healthProbe: async () => true,
        waitForReady: async () => true,
        processPid: 22222,
        processKill: killMock,
        requestStop: stopVia(killMock),
        hostLoad: idleLoad,
      }
    );

    try {
      await guardian.start();
      console.info(`[${SUITE}:killSync-respect-other-ref] started — calling killSync`);
      guardian.killSync();
      console.info(`[${SUITE}:killSync-respect-other-ref] killMock calls=${JSON.stringify(killMock.mock.calls)} refs=${JSON.stringify(readPidsFromFile(joinPath(dir, "runtime.refs")))}`);

      // Other app (process.pid) is still alive — runtime must NOT be killed
      expect(killMock).not.toHaveBeenCalled();
      console.info(`[${SUITE}:killSync-respect-other-ref] OK`);
    } catch (err) {
      dumpGuardianSnapshot("killSync-respect-other-ref-failure", {
        dir,
        guardian,
        extra: { killMockCalls: killMock.mock.calls, otherLivePid: process.pid },
      });
      throw err;
    }
  });

  // --- Scenario: Non-detached spawn ties child to parent ---
  it("does not unref child when detached is false", async () => {
    const dir = setup();
    console.info(`[${SUITE}:no-unref-when-attached] dir=${dir} spawnCommand.detached=false — unref must NOT be called`);
    let childUnrefCalled = false;

    const guardian = new RuntimeGuardian(
      {
        appName: "badger",
        spawnCommand: { ...dummySpawn, detached: false },
        runtimeDataDir: dir,
        runtimePort: 39999,
        healthIntervalMs: 100_000,
        spawnDeadlineMs: 1000,
      },
      {
        spawn: vi.fn(() => {
          const fakeChild = Object.assign(new (require("node:events").EventEmitter)(), {
            pid: 66666,
            killed: false,
            kill: vi.fn(),
            unref: vi.fn(() => { childUnrefCalled = true; }),
          });
          return fakeChild as any;
        }),
        healthProbe: async () => false,
        waitForReady: async () => true,
        processPid: 33333,
        processKill: vi.fn(),
        requestStop: stopVia(),
        hostLoad: idleLoad,
      }
    );

    try {
      await guardian.start();
      console.info(`[${SUITE}:no-unref-when-attached] started — childUnrefCalled=${childUnrefCalled}`);
      // unref should NOT have been called when detached: false
      expect(childUnrefCalled).toBe(false);
      await guardian.stop();
      console.info(`[${SUITE}:no-unref-when-attached] OK`);
    } catch (err) {
      dumpGuardianSnapshot("no-unref-when-attached-failure", {
        dir,
        guardian,
        childPidsSpawned: [66666],
        extra: { childUnrefCalled, detached: false },
      });
      throw err;
    }
  });

  // --- Scenario: Stale refs from crashed app are cleaned up ---
  it("prunes dead PIDs from refs on stop so a stale crashed-app ref does not keep runtime alive", async () => {
    const dir = setup();
    console.info(`[${SUITE}:stale-refs-pruned] dir=${dir} — pre-write runtime.pid=44444 and stale ref=2_000_000_000`);
    const refsPath = joinPath(dir, "runtime.refs");
    const pidPath = joinPath(dir, "runtime.pid");

    // Simulate: runtime is running with PID 44444, and a crashed app left a stale ref
    const { writeRuntimePid: writePid } = await import("../src/refs");
    writePid(pidPath, 44444);
    registerPid(refsPath, 2_000_000_000); // dead PID from crashed app

    const killMock = vi.fn();
    const guardian = new RuntimeGuardian(
      {
        appName: "badger",
        spawnCommand: dummySpawn,
        runtimeDataDir: dir,
        runtimePort: 39999,
        healthIntervalMs: 100_000,
      },
      {
        spawn: vi.fn(() => {
          const fakeChild = Object.assign(new (require("node:events").EventEmitter)(), {
            pid: 44444,
            killed: false,
            kill: vi.fn(),
            unref: vi.fn(),
          });
          return fakeChild as any;
        }),
        healthProbe: async () => true,
        waitForReady: async () => true,
        processPid: 10003,
        processKill: killMock,
        requestStop: stopVia(killMock),
        hostLoad: idleLoad,
      }
    );

    try {
      await guardian.start();
      const refsAfterStart = readPidsFromFile(refsPath);
      console.info(`[${SUITE}:stale-refs-pruned] refs after start=${JSON.stringify(refsAfterStart)}`);
      // Both 2_000_000_000 (dead) and 10003 are in refs
      expect(refsAfterStart).toContain(10003);

      await guardian.stop();
      console.info(`[${SUITE}:stale-refs-pruned] refs after stop=${JSON.stringify(readPidsFromFile(refsPath))} killMock=${JSON.stringify(killMock.mock.calls)}`);
      // 10003 unregistered, 2_000_000_000 pruned as dead -> no live refs -> runtime killed
      expect(killMock).toHaveBeenCalledWith(44444, "SIGTERM");
      console.info(`[${SUITE}:stale-refs-pruned] OK`);
    } catch (err) {
      dumpGuardianSnapshot("stale-refs-pruned-failure", {
        dir,
        guardian,
        childPidsSpawned: [44444],
        extra: { killMockCalls: killMock.mock.calls, expectedKill: [44444, "SIGTERM"], stalePid: 2_000_000_000, appPid: 10003 },
      });
      throw err;
    }
  });

  // Round-12 #5 regression: RuntimeGuardian respawn-while-alive loop.
  // Pre-fix: when the runtime was alive on port 3020 but health probe transiently
  // failed, the guardian spawned a new bun. The new bun hit round-11 L1 port-probe,
  // exited 0 cleanly, the child-exit handler treated it as a crash and restarted
  // ~2s later. Forever loop, every iteration polluting runtime.log.
  describe("@bugfix @regression-proof Round-12 #5 — port-probe before spawn + clean-exit suppression", () => {
    it("skips spawn when port is already bound by another runtime", async () => {
      const dir = mkdtempSync(joinPath(tmpdir(), "rt-port-bound-"));
      console.info(`[${SUITE}:port-bound-no-respawn] dir=${dir} portProbe=true healthProbe=false — verify NO spawn`);
      let guardian: RuntimeGuardian | null = null;
      const spawnMock = vi.fn();
      const portProbeMock = vi.fn(async () => true);
      try {
        guardian = new RuntimeGuardian(
          {
            appName: "test",
            spawnCommand: dummySpawn,
            runtimeDataDir: dir,
            runtimePort: 39999,
            healthIntervalMs: 100_000,
            healthProbeTimeoutMs: 100,
            spawnDeadlineMs: 500,
            waitDeadlineMs: 500,
          },
          {
            spawn: spawnMock as any,
            healthProbe: async () => false, // forces ensureRuntimeSpawned path
            waitForReady: async () => true,
            portProbe: portProbeMock,
            processPid: process.pid,
            processKill: vi.fn(),
            requestStop: stopVia(),
            hostLoad: idleLoad,
          }
        );

        await guardian.start();
        console.info(`[${SUITE}:port-bound-no-respawn] portProbe calls=${portProbeMock.mock.calls.length} spawn calls=${spawnMock.mock.calls.length}`);
        expect(portProbeMock).toHaveBeenCalled();
        expect(spawnMock).not.toHaveBeenCalled(); // critical: no respawn loop
        await guardian.stop();
        console.info(`[${SUITE}:port-bound-no-respawn] OK`);
      } catch (err) {
        dumpGuardianSnapshot("port-bound-no-respawn-failure", {
          dir,
          guardian,
          spawnMock,
          extra: { portProbeCalls: portProbeMock.mock.calls.length, spawnCalls: spawnMock.mock.calls.length },
        });
        throw err;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("ignores child clean-exit (code 0, port still bound) — no restart loop", async () => {
      const dir = mkdtempSync(joinPath(tmpdir(), "rt-clean-exit-"));
      console.info(`[${SUITE}:clean-exit-port-bound-no-restart] dir=${dir} — child exits code 0 with port bound, expect NO respawn`);
      let portBound = false;
      const portProbeMock = vi.fn(async () => portBound);
      const spawnCount = { n: 0 };
      let lastChild: any = null;
      const spawnMock = vi.fn(() => {
        spawnCount.n += 1;
        lastChild = Object.assign(new (require("node:events").EventEmitter)(), {
          pid: 50000 + spawnCount.n,
          killed: false,
          kill: vi.fn(),
          unref: vi.fn(),
        });
        console.info(`[${SUITE}:clean-exit-port-bound-no-restart] spawn #${spawnCount.n} pid=${50000 + spawnCount.n}`);
        return lastChild as any;
      });
      let healthy = false;
      let guardian: RuntimeGuardian | null = null;
      try {
        guardian = new RuntimeGuardian(
          {
            appName: "test",
            spawnCommand: dummySpawn,
            runtimeDataDir: dir,
            runtimePort: 39999,
            healthIntervalMs: 100_000, // health monitor disabled for this test
            healthProbeTimeoutMs: 100,
            spawnDeadlineMs: 500,
            waitDeadlineMs: 500,
          },
          {
            spawn: spawnMock as any,
            healthProbe: async () => healthy,
            waitForReady: async () => {
              healthy = true;
              return true;
            },
            portProbe: portProbeMock,
            processPid: process.pid,
            processKill: vi.fn(),
            requestStop: stopVia(),
            hostLoad: idleLoad,
          }
        );

        await guardian.start();
        console.info(`[${SUITE}:clean-exit-port-bound-no-restart] spawnCount after start=${spawnCount.n}`);
        expect(spawnCount.n).toBe(1); // initial spawn

        // Now the child exits cleanly (code 0) — the L1 self-refusal pattern.
        // BEFORE this can happen, port becomes bound (the surviving runtime).
        portBound = true;
        console.info(`[${SUITE}:clean-exit-port-bound-no-restart] portBound=true, emitting exit(0)`);
        lastChild?.emit("exit", 0, null);

        // Wait briefly for any async restart logic
        const startedAt = Date.now();
        await new Promise((r) => setTimeout(r, 200));
        console.info(`[${SUITE}:clean-exit-port-bound-no-restart] spawnCount after 200ms wait (elapsed=${Date.now() - startedAt}ms)=${spawnCount.n}`);

        // Critical: NO additional spawn — the clean-exit-with-port-bound was
        // suppressed.
        expect(spawnCount.n).toBe(1);
        await guardian.stop();
        console.info(`[${SUITE}:clean-exit-port-bound-no-restart] OK`);
      } catch (err) {
        dumpGuardianSnapshot("clean-exit-port-bound-no-restart-failure", {
          dir,
          guardian,
          spawnMock,
          childPidsSpawned: Array.from({ length: spawnCount.n }, (_, i) => 50001 + i),
          childExitCodes: [0],
          extra: { spawnCountFinal: spawnCount.n, portBound, healthy },
        });
        throw err;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("non-zero exit still triggers restart (real crash, not L1 self-refusal)", async () => {
      const dir = mkdtempSync(joinPath(tmpdir(), "rt-nonzero-exit-"));
      console.info(`[${SUITE}:nonzero-exit-restarts] dir=${dir} — port free, child exits code 1, expect respawn`);
      const portProbeMock = vi.fn(async () => false); // port free → spawn proceeds
      const spawnCount = { n: 0 };
      let lastChild: any = null;
      const spawnMock = vi.fn(() => {
        spawnCount.n += 1;
        lastChild = Object.assign(new (require("node:events").EventEmitter)(), {
          pid: 60000 + spawnCount.n,
          killed: false,
          kill: vi.fn(),
          unref: vi.fn(),
        });
        console.info(`[${SUITE}:nonzero-exit-restarts] spawn #${spawnCount.n} pid=${60000 + spawnCount.n}`);
        return lastChild as any;
      });
      let healthy = false;
      let guardian: RuntimeGuardian | null = null;
      try {
        guardian = new RuntimeGuardian(
          {
            appName: "test",
            spawnCommand: dummySpawn,
            runtimeDataDir: dir,
            runtimePort: 39999,
            healthIntervalMs: 100_000,
            healthProbeTimeoutMs: 100,
            spawnDeadlineMs: 500,
            waitDeadlineMs: 500,
            maxRestartRetries: 1,
          },
          {
            spawn: spawnMock as any,
            healthProbe: async () => healthy,
            waitForReady: async () => {
              healthy = true;
              return true;
            },
            portProbe: portProbeMock,
            processPid: process.pid,
            processKill: vi.fn(),
            requestStop: stopVia(),
            hostLoad: idleLoad,
          }
        );

        await guardian.start();
        console.info(`[${SUITE}:nonzero-exit-restarts] spawnCount after start=${spawnCount.n}`);
        expect(spawnCount.n).toBe(1);

        // Real crash: non-zero exit code → restart should fire.
        healthy = false;
        console.info(`[${SUITE}:nonzero-exit-restarts] emitting exit(1) (real crash)`);
        lastChild?.emit("exit", 1, null);

        // Wait for restart to attempt
        const startedAt = Date.now();
        await new Promise((r) => setTimeout(r, 600));
        console.info(`[${SUITE}:nonzero-exit-restarts] spawnCount after 600ms wait (elapsed=${Date.now() - startedAt}ms)=${spawnCount.n}`);

        // Restart attempted → at least 2 spawns (initial + restart)
        expect(spawnCount.n).toBeGreaterThanOrEqual(2);
        await guardian.stop();
        console.info(`[${SUITE}:nonzero-exit-restarts] OK`);
      } catch (err) {
        dumpGuardianSnapshot("nonzero-exit-restarts-failure", {
          dir,
          guardian,
          spawnMock,
          childPidsSpawned: Array.from({ length: spawnCount.n }, (_, i) => 60001 + i),
          childExitCodes: [1],
          extra: { spawnCountFinal: spawnCount.n, healthy },
        });
        throw err;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  /**
   * @test-id GUARDIAN-START-FAIL-RECOVERS-001
   * @bugfix
   * @regression-proof
   * @level unit
   * @why Ultimate stress finding F5 (issue #25, runs 2026-10-05T00-45-33 and
   *      01-29-49): on a quick app relaunch the previous runtime still held the
   *      port while refusing health; `start()` waited waitDeadlineMs, threw
   *      `runtime_external_wait_timeout`, and — because the health monitor was
   *      only armed AFTER a successful spawn — the guardian was dead for the
   *      rest of the session. The old runtime then exited, nothing respawned
   *      it, and every library call answered LIBRARY_DB_NOT_READY.
   */
  describe("@bugfix @regression-proof start() failure recovery (F5)", () => {
    it("keeps recovering after the initial start() fails: restarts, spawns, emits ready", async () => {
      const dir = mkdtempSync(joinPath(tmpdir(), "rt-start-fail-"));
      console.info(`[${SUITE}:start-fail-recovers] dir=${dir} — port bound + wait times out on start, then port frees; expect restart -> spawn -> ready`);
      const transitions: TransitionEvent[] = [];
      let portBound = true; // old runtime still holds the port, refusing health
      let healthy = false;
      let spawns = 0;
      const spawnMock = vi.fn(() => {
        spawns += 1;
        console.info(`[${SUITE}:start-fail-recovers] spawn #${spawns}`);
        return Object.assign(new EventEmitter(), {
          pid: 70000 + spawns,
          killed: false,
          kill: vi.fn(),
          unref: vi.fn(),
        }) as unknown as ChildProcess;
      });
      let waitCalls = 0;
      const guardian = new RuntimeGuardian(
        {
          appName: "test",
          spawnCommand: dummySpawn,
          runtimeDataDir: dir,
          runtimePort: 39999,
          healthIntervalMs: 100_000,
          healthProbeTimeoutMs: 100,
          spawnDeadlineMs: 500,
          waitDeadlineMs: 500,
          restartBackoffBaseMs: 500,
        },
        {
          spawn: spawnMock as unknown as NonNullable<RuntimeHostDeps["spawn"]>,
          healthProbe: async () => healthy,
          waitForReady: async () => {
            waitCalls += 1;
            console.info(`[${SUITE}:start-fail-recovers] waitForReady #${waitCalls} portBound=${portBound}`);
            if (portBound) {
              // The doomed old runtime finally exits while the first wait runs out.
              portBound = false;
              return false;
            }
            healthy = true;
            return true;
          },
          portProbe: async () => portBound,
          processPid: process.pid,
          processKill: vi.fn(),
          requestStop: stopVia(),
          hostLoad: idleLoad,
        }
      );
      recordEvents(guardian, transitions);
      try {
        const readyEvent = once(guardian, "ready");
        await expect(guardian.start()).rejects.toThrow("runtime_external_wait_timeout");
        console.info(`[${SUITE}:start-fail-recovers] start() rejected as expected; waiting for background recovery`);
        // Awaits the real "ready" signal (vitest's test timeout bounds it); the
        // 500 ms floor of restartBackoffBaseMs is guardian-internal.
        await readyEvent;
        console.info(`[${SUITE}:start-fail-recovers] healthy=${guardian.isHealthy} spawns=${spawns} transitions=${JSON.stringify(transitions)}`);
        expect(guardian.isHealthy).toBe(true);
        expect(spawns).toBe(1);
        expect(transitions.map((t) => t.event)).toEqual(["restarting", "ready"]);
      } catch (err) {
        dumpGuardianSnapshot("start-fail-recovers-failure", {
          dir,
          guardian,
          spawnMock,
          transitions,
          extra: { portBound, healthy, spawns, waitCalls },
        });
        throw err;
      } finally {
        await guardian.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  /**
   * Simulated runtime processes for the single-runtime invariant tests.
   * Real timers on purpose: the guardian's deadlines, kill grace and backoff
   * are wall-clock timers racing async polls and child exit events, and the
   * rest of this suite drives them the same way; fake timers would have to
   * interleave advanceTimersByTime with every awaited poll to stay faithful.
   * Each fake child models a real OS process: it is alive until it exits,
   * binds the port and answers health once its boot time has elapsed, and
   * exits (asynchronously, like a signal delivery) when killed. `liveCount()`
   * is sampled on every spawn so a second spawn while the first child is
   * still alive is caught at the moment it happens.
   */
  type SimChild = EventEmitter & {
    pid: number;
    killed: boolean;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: Mock;
    unref: Mock;
    spawnedAt: number;
    bootMs: number;
    hung: boolean;
    alive: boolean;
    killSignals: Array<string | number | undefined>;
  };

  const makeRuntimeSim = (label: string, bootPlan: Array<{ bootMs: number; crashAfterMs?: number; crashCode?: number }>) => {
    const children: SimChild[] = [];
    let bootOverride: (typeof bootPlan)[number] | null = null;
    const liveAtSpawn: number[] = [];
    let maxLive = 0;
    const t0 = Date.now();
    const rel = () => `${Date.now() - t0}ms`;
    const liveCount = () => children.filter((c) => c.alive).length;
    const exitChild = (c: SimChild, code: number | null, signal: NodeJS.Signals | null) => {
      if (!c.alive) return;
      c.alive = false;
      c.exitCode = code;
      c.signalCode = signal;
      console.info(`[${SUITE}:${label}] +${rel()} child pid=${c.pid} exit code=${code} signal=${signal} live=${liveCount()}`);
      c.emit("exit", code, signal);
    };
    const spawn = vi.fn(() => {
      const plan = bootOverride ?? bootPlan[Math.min(children.length, bootPlan.length - 1)];
      const live = liveCount();
      liveAtSpawn.push(live);
      const c = Object.assign(new EventEmitter(), {
        pid: 81000 + children.length,
        killed: false,
        exitCode: null,
        signalCode: null,
        unref: vi.fn(),
        spawnedAt: Date.now(),
        bootMs: plan.bootMs,
        hung: false,
        alive: true,
        killSignals: [] as Array<string | number | undefined>,
      }) as unknown as SimChild;
      c.kill = vi.fn((signal?: string | number) => {
        c.killSignals.push(signal);
        c.killed = true;
        console.info(`[${SUITE}:${label}] +${rel()} kill(${String(signal)}) -> pid=${c.pid} alive=${c.alive}`);
        setTimeout(() => exitChild(c, null, (typeof signal === "string" ? signal : "SIGTERM") as NodeJS.Signals), 5);
        return true;
      });
      children.push(c);
      maxLive = Math.max(maxLive, liveCount());
      console.info(`[${SUITE}:${label}] +${rel()} spawn #${children.length} pid=${c.pid} bootMs=${plan.bootMs} crashAfterMs=${plan.crashAfterMs ?? "-"} liveBeforeSpawn=${live} liveNow=${liveCount()}`);
      if (plan.crashAfterMs !== undefined) {
        setTimeout(() => exitChild(c, plan.crashCode ?? 1, null), plan.crashAfterMs);
      }
      return c as unknown as ChildProcess;
    });
    const ready = (c: SimChild) => c.alive && !c.hung && Date.now() - c.spawnedAt >= c.bootMs;
    const healthy = () => children.some(ready);
    const portBound = () => children.some((c) => c.alive && Date.now() - c.spawnedAt >= c.bootMs);
    const waitForReady = async (_url: string, deadlineMs: number, _intervalMs: number) => {
      const deadline = Date.now() + deadlineMs;
      while (Date.now() < deadline) {
        if (healthy()) return true;
        await new Promise((r) => setTimeout(r, 10));
      }
      console.info(`[${SUITE}:${label}] +${rel()} waitForReady(${deadlineMs}ms) timed out live=${liveCount()}`);
      return false;
    };
    const dump = () => ({
      elapsed: rel(),
      maxLive,
      liveAtSpawn,
      liveNow: liveCount(),
      children: children.map((c) => ({
        pid: c.pid,
        alive: c.alive,
        hung: c.hung,
        bootMs: c.bootMs,
        exitCode: c.exitCode,
        signalCode: c.signalCode,
        killSignals: c.killSignals,
      })),
    });
    return {
      children,
      /** Every later spawn uses this boot behaviour (e.g. the runtime got "fixed"). */
      setBoot(plan: (typeof bootPlan)[number]) {
        bootOverride = plan;
      },
      spawn,
      liveCount,
      liveAtSpawn,
      get maxLive() {
        return maxLive;
      },
      deps: (): RuntimeHostDeps => {
        const processKill = vi.fn((pid: number, signal?: string | number) => {
          const c = children.find((x) => x.pid === pid);
          if (!c || !c.alive) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
          if (signal !== 0) c.kill(signal);
          return true;
        });
        return {
          spawn: spawn as unknown as NonNullable<RuntimeHostDeps["spawn"]>,
          healthProbe: async () => healthy(),
          waitForReady,
          portProbe: async () => portBound(),
          processPid: process.pid,
          hostLoad: idleLoad,
          // Pid-file kills route to the simulated child with that pid.
          processKill,
          requestStop: stopVia(processKill),
        };
      },
      dump,
    };
  };

  const withDeadline = async <T>(label: string, promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> => {
    const expired = Promise.withResolvers<T>();
    const timer = setTimeout(() => {
      onTimeout();
      expired.reject(new Error(`${label}: not reached within ${ms}ms`));
    }, ms);
    try {
      return await Promise.race([promise, expired.promise]);
    } finally {
      clearTimeout(timer);
    }
  };

  /**
   * @test-id GUARDIAN-SINGLE-RUNTIME-001
   * @bugfix
   * @regression-proof
   * @level unit
   * @why Issue #25, Opus review of PR #38: when the first runtime child boots
   *      slower than spawnDeadlineMs (old 4-core i5 + HDD, Windows Defender
   *      first-run scan), ensureRuntimeSpawned threw runtime_spawn_timeout
   *      but left child A running. #38's background recovery then ran
   *      attemptRestart with no backoff: A had not bound the port yet, the
   *      lock was free, so child B was spawned while A was still alive — two
   *      runtimes on the same jobs DB (the dual-spawn race apps/runtime warns
   *      about). The #38 P3 finding in the same code: after 'lost', the exit
   *      re-queue and the health tick restarted the cycle forever.
   */
  describe("@bugfix @regression-proof single live runtime child (#25 / #38 review)", () => {
    it("never spawns a second runtime while a slow-booting first child is still alive", async () => {
      const label = "single-runtime-slow-boot";
      const dir = mkdtempSync(joinPath(tmpdir(), "rt-single-"));
      // Child A boots in 1500 ms, past the 300 ms deadline; child B boots in 20 ms.
      const sim = makeRuntimeSim(label, [{ bootMs: 1500 }, { bootMs: 20 }]);
      const transitions: TransitionEvent[] = [];
      console.info(`[${SUITE}:${label}] dir=${dir} spawnDeadlineMs=300 — child A boots in 1500ms; expect A terminated (and exited) before B is spawned`);
      const guardian = new RuntimeGuardian(
        {
          appName: "test",
          spawnCommand: dummySpawn,
          runtimeDataDir: dir,
          runtimePort: 39999,
          healthIntervalMs: 100_000,
          healthProbeTimeoutMs: 100,
          spawnDeadlineMs: 300,
          waitDeadlineMs: 300,
          restartBackoffBaseMs: 500,
          childKillGraceMs: 200,
        },
        sim.deps(),
      );
      recordEvents(guardian, transitions);
      try {
        const readyEvent = once(guardian, "ready");
        await expect(guardian.start()).rejects.toThrow("runtime_spawn_timeout");
        console.info(`[${SUITE}:${label}] start() rejected; sim=${JSON.stringify(sim.dump())}`);
        await withDeadline(label, readyEvent, 5000, () => dumpGuardianSnapshot(`${label}-no-ready`, { dir, guardian, transitions, extra: sim.dump() }));
        console.info(`[${SUITE}:${label}] ready; sim=${JSON.stringify(sim.dump())} transitions=${JSON.stringify(transitions)}`);
        expect(sim.liveAtSpawn).toEqual([0, 0]);
        expect(sim.maxLive).toBe(1);
        expect(sim.liveCount()).toBe(1);
        expect(sim.children[0].alive).toBe(false);
        expect(sim.children[0].killSignals[0]).toBe("SIGTERM");
        expect(guardian.isHealthy).toBe(true);
      } catch (err) {
        dumpGuardianSnapshot(`${label}-failure`, { dir, guardian, transitions, spawnMock: sim.spawn, extra: sim.dump() });
        throw err;
      } finally {
        await guardian.stop();
        console.info(`[${SUITE}:${label}] after stop sim=${JSON.stringify(sim.dump())}`);
        rmSync(dir, { recursive: true, force: true });
      }
    }, 15_000);

    it("kills its own hung runtime that still holds the port, then respawns exactly one", async () => {
      const label = "single-runtime-hung-port";
      const dir = mkdtempSync(joinPath(tmpdir(), "rt-single-"));
      const sim = makeRuntimeSim(label, [{ bootMs: 10 }, { bootMs: 10 }]);
      const transitions: TransitionEvent[] = [];
      console.info(`[${SUITE}:${label}] dir=${dir} — child A boots, then hangs (port bound, health false); expect A killed then B spawned`);
      const guardian = new RuntimeGuardian(
        {
          appName: "test",
          spawnCommand: dummySpawn,
          runtimeDataDir: dir,
          runtimePort: 39999,
          healthIntervalMs: 50,
          healthProbeTimeoutMs: 50,
          maxConsecutiveFailures: 3,
          spawnDeadlineMs: 300,
          waitDeadlineMs: 300,
          restartBackoffBaseMs: 500,
          childKillGraceMs: 200,
        },
        sim.deps(),
      );
      recordEvents(guardian, transitions);
      try {
        await guardian.start();
        expect(sim.children.length).toBe(1);
        const recovered = once(guardian, "ready");
        sim.children[0].hung = true;
        console.info(`[${SUITE}:${label}] child A hung; waiting for kill + respawn`);
        await withDeadline(label, recovered, 6000, () => dumpGuardianSnapshot(`${label}-no-ready`, { dir, guardian, transitions, extra: sim.dump() }));
        console.info(`[${SUITE}:${label}] recovered; sim=${JSON.stringify(sim.dump())} transitions=${JSON.stringify(transitions)}`);
        expect(sim.children.length).toBe(2);
        expect(sim.liveAtSpawn).toEqual([0, 0]);
        expect(sim.maxLive).toBe(1);
        expect(sim.children[0].alive).toBe(false);
        expect(sim.children[1].alive).toBe(true);
      } catch (err) {
        dumpGuardianSnapshot(`${label}-failure`, { dir, guardian, transitions, spawnMock: sim.spawn, extra: sim.dump() });
        throw err;
      } finally {
        await guardian.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    }, 15_000);

    it("fails a boot fast when the child exits before ready instead of waiting out the deadline", async () => {
      const label = "single-runtime-crash-fast-fail";
      const dir = mkdtempSync(joinPath(tmpdir(), "rt-single-"));
      const sim = makeRuntimeSim(label, [{ bootMs: 100_000, crashAfterMs: 30, crashCode: 1 }]);
      const transitions: TransitionEvent[] = [];
      console.info(`[${SUITE}:${label}] dir=${dir} spawnDeadlineMs=20000 — child crashes at 30ms; expect start() to reject well under 2s`);
      const guardian = new RuntimeGuardian(
        {
          appName: "test",
          spawnCommand: dummySpawn,
          runtimeDataDir: dir,
          runtimePort: 39999,
          healthIntervalMs: 100_000,
          healthProbeTimeoutMs: 100,
          spawnDeadlineMs: 20_000,
          waitDeadlineMs: 300,
          restartBackoffBaseMs: 60_000,
          childKillGraceMs: 200,
        },
        sim.deps(),
      );
      recordEvents(guardian, transitions);
      const startedAt = Date.now();
      try {
        await withDeadline(
          label,
          expect(guardian.start()).rejects.toThrow("runtime_exited_before_ready"),
          2000,
          () => dumpGuardianSnapshot(`${label}-slow`, { dir, guardian, transitions, extra: sim.dump() }),
        );
        console.info(`[${SUITE}:${label}] rejected after ${Date.now() - startedAt}ms sim=${JSON.stringify(sim.dump())}`);
        expect(sim.maxLive).toBe(1);
      } catch (err) {
        dumpGuardianSnapshot(`${label}-failure`, { dir, guardian, transitions, spawnMock: sim.spawn, extra: sim.dump() });
        throw err;
      } finally {
        await guardian.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    }, 15_000);

    it("defaults the boot deadline to 60 s so a slow home PC is not killed mid-boot", async () => {
      const label = "single-runtime-default-deadline";
      const dir = mkdtempSync(joinPath(tmpdir(), "rt-single-"));
      const deadlines: number[] = [];
      let healthy = false;
      const guardian = new RuntimeGuardian(
        { appName: "test", spawnCommand: dummySpawn, runtimeDataDir: dir, runtimePort: 39999, healthIntervalMs: 100_000 },
        {
          spawn: vi.fn(() => Object.assign(new EventEmitter(), { pid: 82001, killed: false, kill: vi.fn(), unref: vi.fn() })) as unknown as NonNullable<RuntimeHostDeps["spawn"]>,
          healthProbe: async () => healthy,
          waitForReady: async (_u, deadlineMs) => {
            deadlines.push(deadlineMs);
            healthy = true;
            return true;
          },
          portProbe: async () => false,
          processPid: process.pid,
          processKill: vi.fn(),
          requestStop: stopVia(),
          hostLoad: idleLoad,
        },
      );
      try {
        await guardian.start();
        console.info(`[${SUITE}:${label}] waitForReady deadlines=${JSON.stringify(deadlines)}`);
        expect(deadlines[0]).toBeGreaterThanOrEqual(60_000);
      } finally {
        healthy = false;
        await guardian.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("fails a boot fast when the runtime binary cannot be spawned (ENOENT, no pid)", async () => {
      const label = "single-runtime-spawn-error";
      const dir = mkdtempSync(joinPath(tmpdir(), "rt-single-"));
      const spawned: EventEmitter[] = [];
      const guardian = new RuntimeGuardian(
        {
          appName: "test",
          spawnCommand: dummySpawn,
          runtimeDataDir: dir,
          runtimePort: 39999,
          healthIntervalMs: 100_000,
          healthProbeTimeoutMs: 100,
          spawnDeadlineMs: 20_000,
          waitDeadlineMs: 300,
          restartBackoffBaseMs: 60_000,
          childKillGraceMs: 200,
        },
        {
          spawn: vi.fn(() => {
            // Real node: a missing binary yields a ChildProcess with no pid
            // that emits 'error' (ENOENT) on a later tick and never 'exit'.
            const c = Object.assign(new EventEmitter(), { pid: undefined, exitCode: null, signalCode: null, killed: false, kill: vi.fn(), unref: vi.fn() });
            spawned.push(c);
            setImmediate(() => {
              console.info(`[${SUITE}:${label}] emitting ENOENT on child #${spawned.length}`);
              c.emit("error", Object.assign(new Error("spawn runtime ENOENT"), { code: "ENOENT" }));
            });
            return c;
          }) as unknown as NonNullable<RuntimeHostDeps["spawn"]>,
          healthProbe: async () => false,
          // Health never answers: only the spawn error may end the boot wait.
          waitForReady: () => new Promise<boolean>(() => {}),
          portProbe: async () => false,
          processPid: process.pid,
          processKill: vi.fn(),
          requestStop: stopVia(),
          hostLoad: idleLoad,
        },
      );
      const startedAt = Date.now();
      console.info(`[${SUITE}:${label}] dir=${dir} spawnDeadlineMs=20000 — spawn fails with ENOENT; expect start() to reject well under 2s`);
      try {
        await withDeadline(
          label,
          expect(guardian.start()).rejects.toThrow("runtime_exited_before_ready"),
          2000,
          () => console.error(`[${SUITE}:${label}] start() still pending after 2s; spawned=${spawned.length}`),
        );
        console.info(`[${SUITE}:${label}] rejected after ${Date.now() - startedAt}ms spawned=${spawned.length}`);
        // start() hands over to background recovery, which may already have
        // made its first (equally failing) attempt — so no exact count.
        expect(spawned.length).toBeGreaterThanOrEqual(1);
      } finally {
        await guardian.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    }, 15_000);

    it("stays 'lost' (no more spawns) after the restart cycle gives up, until a manual restart", async () => {
      const label = "single-runtime-lost-terminal";
      const dir = mkdtempSync(joinPath(tmpdir(), "rt-single-"));
      // Every child crashes 10 ms after spawn until sim.setBoot() "fixes" the runtime.
      const crash = { bootMs: 100_000, crashAfterMs: 10, crashCode: 1 };
      const sim = makeRuntimeSim(label, [crash]);
      const transitions: TransitionEvent[] = [];
      console.info(`[${SUITE}:${label}] dir=${dir} — runtime never starts; expect lost then silence, then manual restart works`);
      const guardian = new RuntimeGuardian(
        {
          appName: "test",
          spawnCommand: dummySpawn,
          runtimeDataDir: dir,
          runtimePort: 39999,
          healthIntervalMs: 30,
          healthProbeTimeoutMs: 30,
          maxConsecutiveFailures: 2,
          maxRestartRetries: 1,
          restartBackoffBaseMs: 500,
          spawnDeadlineMs: 300,
          waitDeadlineMs: 300,
          childKillGraceMs: 200,
        },
        sim.deps(),
      );
      recordEvents(guardian, transitions);
      try {
        const lost = once(guardian, "lost");
        await expect(guardian.start()).rejects.toThrow();
        await withDeadline(label, lost, 6000, () => dumpGuardianSnapshot(`${label}-no-lost`, { dir, guardian, transitions, extra: sim.dump() }));
        const spawnsAtLost = sim.children.length;
        console.info(`[${SUITE}:${label}] lost after ${spawnsAtLost} spawns; watching 1500ms for further restarts`);
        await new Promise((r) => setTimeout(r, 1500));
        console.info(`[${SUITE}:${label}] after quiet window sim=${JSON.stringify(sim.dump())} transitions=${JSON.stringify(transitions)}`);
        expect(sim.children.length).toBe(spawnsAtLost);
        expect(transitions.at(-1)?.event).toBe("lost");
        expect(guardian.state).toBe("lost");

        // Manual restart (Settings > System > Restart runtime) re-arms recovery.
        sim.setBoot({ bootMs: 10 });
        await guardian.restart();
        console.info(`[${SUITE}:${label}] manual restart done sim=${JSON.stringify(sim.dump())}`);
        expect(guardian.isHealthy).toBe(true);
        expect(transitions.at(-1)?.event).toBe("ready");
        expect(sim.maxLive).toBe(1);
      } catch (err) {
        dumpGuardianSnapshot(`${label}-failure`, { dir, guardian, transitions, spawnMock: sim.spawn, extra: sim.dump() });
        throw err;
      } finally {
        await guardian.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    }, 20_000);
  });
});

describe("RuntimeGuardian owner secret login (RT-SEC-05)", () => {
  let root: string;
  afterEach(() => {
    vi.unstubAllGlobals();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const deps = (): RuntimeHostDeps => ({
    healthProbe: async () => true,
    waitForReady: async () => true,
    processKill: vi.fn(),
    requestStop: stopVia(),
    hostLoad: idleLoad,
  });

  it("sends the current owner secret on its connection login, read fresh each time @req RT-SEC-05[badger-desktop]", async () => {
    root = mkdtempSync(joinPath(tmpdir(), "rt-guardian-owner-"));
    const seen: Array<string | undefined> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
        if (String(url).endsWith("/runtime/session/login")) {
          seen.push(init?.headers?.["X-Runtime-Owner"]);
          return new Response(JSON.stringify({ token: "t" }), { status: 200 });
        }
        return new Response(JSON.stringify({ connectionId: "c" }), { status: 200 });
      }),
    );
    let secret = "a".repeat(64);
    const read = vi.fn(() => secret);
    const guardian = new RuntimeGuardian(
      { appName: "test-app", spawnCommand: dummySpawn, runtimeDataDir: root, runtimePort: 39999, healthIntervalMs: 100_000, ownerSecret: read },
      deps(),
    );
    await guardian.start();
    expect(seen).toEqual(["a".repeat(64)]);
    await guardian.stop();
    // A restarted runtime issues a new secret; the next login must use it.
    secret = "b".repeat(64);
    await guardian.start();
    expect(seen).toEqual(["a".repeat(64), "b".repeat(64)]);
    await guardian.stop();
    console.info(`[${SUITE}:owner-secret] logins=${seen.length}`);
  });

  it("falls back to the PID refs when the runtime refuses the login @req RT-SEC-05[badger-desktop]", async () => {
    root = mkdtempSync(joinPath(tmpdir(), "rt-guardian-owner-"));
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "owner_secret_required" }), { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const log = vi.fn();
    const guardian = new RuntimeGuardian(
      { appName: "test-app", spawnCommand: dummySpawn, runtimeDataDir: root, runtimePort: 39999, healthIntervalMs: 100_000, log },
      deps(),
    );
    await guardian.start();
    expect(fetchMock).toHaveBeenCalledTimes(1); // login only, no connect without a token
    expect(guardian.isHealthy).toBe(true);
    expect(log).toHaveBeenCalledWith("warn", expect.stringContaining("owner secret"), expect.objectContaining({ status: 401 }));
    await guardian.stop();
  });
});
