/**
 * @bugfix @regression-proof issue #25 (desktop-e2e run 8013 / 7950:
 * quit-during-ingest "Keep processing" hung until the test timeout).
 *
 * With an external runtime (SF_RUNTIME_BASE_URL set — every e2e launch) or
 * direct-SQLite mode, main never calls `runtimeGuardian.start()`, so the
 * guardian's data dir (the platform's runtime data dir) may not exist. Quit still
 * ran `runtimeGuardian.stop()` (before-quit) and `runtimeGuardian.killSync()`
 * (process "exit"): both rewrote `runtime.refs` and threw ENOENT. The throw
 * inside the exit handler wedged Electron's shutdown (main thread stopped
 * answering, process never exited). Both paths also targeted the pid in the
 * shared runtime.pid — a runtime this app never spawned.
 *
 * A guardian that never registered this app must leave the refs file and the
 * runtime alone on stop()/killSync().
 */
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import { RuntimeGuardian } from "@space/runtime-host";

const SUITE = "runtime-guardian-quit-external-runtime";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const neverStartedGuardian = (runtimeDataDir: string, processKill: Mock) =>
  new RuntimeGuardian(
    {
      appName: "badger",
      spawnCommand: { command: "true", args: [], cwd: "/tmp" },
      runtimeDataDir,
      runtimePort: 39999,
      healthIntervalMs: 100_000,
    },
    {
      healthProbe: async () => true,
      waitForReady: async () => true,
      processPid: 22222,
      processKill,
      hostLoad: () => ({ loadFactor: 1, source: "loadavg", cpuPressure: null, loadavg1: 0, effectiveCpus: 4, cpuBusy: 0 }),
    },
  );

describe(SUITE, () => {
  it("@bugfix @regression-proof killSync on a never-started guardian does not throw when the data dir is missing", () => {
    const parent = mkdtempSync(join(tmpdir(), `${SUITE}-`));
    dirs.push(parent);
    const missingDir = join(parent, "spacefleet-runtime");
    const killMock = vi.fn();
    const guardian = neverStartedGuardian(missingDir, killMock);
    console.info(`[${SUITE}:killSync-missing-dir] dataDir=${missingDir} exists=${existsSync(missingDir)}`);

    // Runs inside process.on("exit") in main: a throw here wedges Electron's shutdown.
    expect(() => guardian.killSync()).not.toThrow();
    expect(killMock).not.toHaveBeenCalled();
    expect(existsSync(missingDir)).toBe(false);
  });

  it("@bugfix @regression-proof stop on a never-started guardian resolves when the data dir is missing", async () => {
    const parent = mkdtempSync(join(tmpdir(), `${SUITE}-`));
    dirs.push(parent);
    const missingDir = join(parent, "spacefleet-runtime");
    const killMock = vi.fn();
    const guardian = neverStartedGuardian(missingDir, killMock);
    console.info(`[${SUITE}:stop-missing-dir] dataDir=${missingDir} exists=${existsSync(missingDir)}`);

    // before-quit fires `void runtimeGuardian.stop()`: a rejection is unhandled.
    await expect(guardian.stop()).resolves.toBeUndefined();
    expect(killMock).not.toHaveBeenCalled();
  });

  it("@bugfix @regression-proof stop/killSync on a never-started guardian leave a runtime it does not own alone", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), `${SUITE}-`));
    dirs.push(dataDir);
    // Another app's runtime: pid file + refs owned by someone else.
    writeFileSync(join(dataDir, "runtime.pid"), "77777");
    writeFileSync(join(dataDir, "runtime.refs"), "");
    const killMock = vi.fn();
    const guardian = neverStartedGuardian(dataDir, killMock);

    await guardian.stop();
    guardian.killSync();
    console.info(`[${SUITE}:foreign-runtime] killMock calls=${JSON.stringify(killMock.mock.calls)}`);

    expect(killMock).not.toHaveBeenCalled();
    expect(existsSync(join(dataDir, "runtime.pid"))).toBe(true);
  });

  // Self-review of #86: the never-started guard must not cover a guardian whose
  // start() already spawned its own runtime and is still waiting for it to boot
  // (quit during a slow cold start). That runtime is ours and must not outlive the app.
  const midSpawnGuardian = (dataDir: string, processKill: Mock, childKill: Mock) => {
    // waitForReady is the boot wait start() makes right after spawning: it
    // signals "spawned" and holds the boot open until the test releases it.
    const spawned = Promise.withResolvers<void>();
    const boot = Promise.withResolvers<boolean>();
    const guardian = new RuntimeGuardian(
      {
        appName: "badger",
        spawnCommand: { command: "true", args: [], cwd: "/tmp" },
        runtimeDataDir: dataDir,
        runtimePort: 39999,
        healthIntervalMs: 100_000,
        spawnDeadlineMs: 60_000,
      },
      {
        // Like a real process, the child exits once signalled (the guardian awaits that exit).
        spawn: vi.fn(() => {
          const child = Object.assign(new EventEmitter(), { pid: 55555, killed: false, unref: vi.fn() });
          return Object.assign(child, {
            kill: vi.fn((signal?: NodeJS.Signals) => {
              childKill(signal);
              child.killed = true;
              setImmediate(() => child.emit("exit", null, signal ?? "SIGTERM"));
              return true;
            }),
          }) as never;
        }),
        healthProbe: async () => false,
        waitForReady: () => {
          spawned.resolve();
          return boot.promise;
        },
        portProbe: async () => false,
        processPid: 11111,
        processKill,
        // The platform's stop request would signal a real pid: record it as the Linux SIGTERM on the mock and the child.
        requestStop: (pid) => {
          processKill(pid, "SIGTERM");
          childKill("SIGTERM");
          return true;
        },
        hostLoad: () => ({ loadFactor: 1, source: "loadavg", cpuPressure: null, loadavg1: 0, effectiveCpus: 4, cpuBusy: 0 }),
      },
    );
    const untilSpawned = async () => {
      await spawned.promise;
      console.info(`[${SUITE}:mid-spawn] boot wait entered; runtime.pid exists=${existsSync(join(dataDir, "runtime.pid"))}`);
    };
    return { guardian, untilSpawned, releaseBoot: boot.resolve };
  };

  it("@bugfix @regression-proof stop during the first spawn's boot wait kills the runtime this guardian spawned", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), `${SUITE}-`));
    dirs.push(dataDir);
    const killMock = vi.fn();
    const { guardian, untilSpawned, releaseBoot } = midSpawnGuardian(dataDir, killMock, vi.fn());
    const started = guardian.start().catch((err: unknown) => err);
    await untilSpawned();

    await guardian.stop();
    console.info(`[${SUITE}:stop-mid-spawn] killMock calls=${JSON.stringify(killMock.mock.calls)}`);
    releaseBoot(false);
    await started;

    expect(killMock).toHaveBeenCalledWith(55555, "SIGTERM");
  });

  it("@bugfix @regression-proof killSync during the first spawn's boot wait kills the runtime this guardian spawned", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), `${SUITE}-`));
    dirs.push(dataDir);
    const killMock = vi.fn();
    const childKill = vi.fn();
    const { guardian, untilSpawned, releaseBoot } = midSpawnGuardian(dataDir, killMock, childKill);
    const started = guardian.start().catch((err: unknown) => err);
    await untilSpawned();

    guardian.killSync();
    console.info(`[${SUITE}:killSync-mid-spawn] killMock calls=${JSON.stringify(killMock.mock.calls)} childKill calls=${JSON.stringify(childKill.mock.calls)}`);
    await guardian.stop();
    releaseBoot(false);
    await started;

    expect(killMock).toHaveBeenCalledWith(55555, "SIGTERM");
    expect(childKill).toHaveBeenCalledWith("SIGTERM");
  });
});
