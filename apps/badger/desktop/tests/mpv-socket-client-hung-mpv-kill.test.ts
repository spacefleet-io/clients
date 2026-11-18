/**
 * @bugfix mpv-hung-process-outlives-app
 * @regression-proof
 *
 * Issue #25 P21 (ultimate confirmation run, seed 1791373829836). A hung mpv
 * outlived the app by ~20 min: its 5-process tree (`mpv.AppImage → AppRun sh
 * → junest bash → ld-linux → /usr/bin/mpv`) survived Electron's clean exit.
 *   - dispose() awaited `quit` for 1 s; a timeout sent NO SIGTERM.
 *   - the 700 ms SIGKILL went to the spawned pid only (the wrapper four
 *     levels above mpv) and its timer died with Electron.
 *   - process.on("exit") killed only the runtime.
 *
 * Fix: signals go to the mpv PROCESS GROUP (spawned detached), SIGTERM as
 * soon as `quit` gets no reply, SIGKILL after a grace, plus a synchronous
 * group kill at app exit (`killAllMpvProcessGroupsSync`).
 *
 * The stub reproduces the shape: `/bin/sh` (the wrapper, group leader) runs a
 * child that binds the IPC socket and then SIGSTOPs itself, so it never
 * answers `quit` — exactly a hung mpv core under a wrapper.
 *
 * Real processes and timers on purpose: this is about real signals reaching
 * real descendants; there is nothing to fake.
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnixSocketMpvClient } from "../src/main/mpvSocketClient";
import { __trackedMpvProcessGroupsForTests, killAllMpvProcessGroupsSync } from "../src/main/mpvProcessGroup";

const TAG = "[mpv-hung-kill]";

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

/** /proc state letter (R, S, T = stopped, Z = zombie) or null when gone. */
const procState = (pid: number): string | null => {
  try {
    return /\) (\S) /.exec(readFileSync(`/proc/${pid}/stat`, "utf8"))?.[1] ?? null;
  } catch {
    return null;
  }
};

/**
 * Killed = gone or a zombie. An orphaned child is reparented to PID 1; in a
 * CI container PID 1 may never reap it, so it stays `Z` although it is dead.
 */
const isPidKilled = (pid: number): boolean => {
  const state = procState(pid);
  return state === null || state === "Z";
};

const waitUntil = async (what: string, predicate: () => boolean, timeoutMs: number): Promise<number> => {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`${TAG} timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return Date.now() - startedAt;
};

/** Node program for the hung-mpv child: bind the socket, record the pid, stop. */
const HUNG_CHILD = `
const net = require("node:net");
const fs = require("node:fs");
const [socketPath, pidFile] = process.argv.slice(1);
net.createServer(() => {}).listen(socketPath, () => {
  fs.writeFileSync(pidFile, String(process.pid));
  process.kill(process.pid, "SIGSTOP");
});
`;

const describeLinux = process.platform === "linux" ? describe : describe.skip;

describeLinux("hung mpv under a wrapper is killed, never orphaned (issue #25 P21)", () => {
  let dir: string | null = null;
  let leftovers: number[] = [];

  afterEach(() => {
    for (const pid of leftovers) {
      if (isPidAlive(pid)) {
        console.warn(`${TAG} cleanup: SIGKILL leftover pid ${pid}`);
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // ignore
        }
      }
    }
    leftovers = [];
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  const startHungMpv = async (wrapperTail: string) => {
    dir = mkdtempSync(join(tmpdir(), "sf-mpv-hung-"));
    const socketPath = join(dir, "mpv.sock");
    const pidFile = join(dir, "child.pid");
    // The wrapper (group leader) starts the hung child, then `wrapperTail`.
    const script = `SF_TEST_GO="${join(dir, "go")}"; "${process.execPath}" -e '${HUNG_CHILD}' "${socketPath}" "${pidFile}" & ${wrapperTail}`;
    const client = new UnixSocketMpvClient();
    const { socketReady } = await client.start({
      bin: "/bin/sh",
      args: ["-c", script],
      env: process.env,
      socketPath,
    });
    await waitUntil("child pid file", () => existsSync(pidFile), 5000);
    const childPid = Number(readFileSync(pidFile, "utf8"));
    // @ts-expect-error — test reads the spawned wrapper pid.
    const wrapperPid: number = client.processGroupId;
    leftovers = [childPid, wrapperPid];
    await waitUntil("child stopped", () => procState(childPid) === "T", 5000);
    console.info(
      `${TAG} started socketReady=${socketReady} wrapperPid=${wrapperPid} childPid=${childPid} childState=${procState(childPid)} tracked=${JSON.stringify(__trackedMpvProcessGroupsForTests())}`,
    );
    expect(socketReady).toBe(true);
    return { client, childPid, wrapperPid };
  };

  it("@bugfix @regression-proof dispose() of an mpv that never answers quit kills the whole group, the stopped child included", async () => {
    const { client, childPid, wrapperPid } = await startHungMpv("wait");
    const disposeStarted = Date.now();
    await client.dispose();
    console.info(`${TAG} dispose returned after ${Date.now() - disposeStarted}ms childState=${procState(childPid)}`);
    const tookMs = await waitUntil(
      "child and wrapper dead",
      () => isPidKilled(childPid) && !isPidAlive(wrapperPid),
      5000,
    );
    console.info(`${TAG} group gone ${tookMs}ms after dispose returned`);
    await waitUntil("group untracked", () => !__trackedMpvProcessGroupsForTests().includes(wrapperPid), 5000);
  });

  it("@bugfix @regression-proof the synchronous exit kill takes a hung group down before returning", async () => {
    const { childPid, wrapperPid } = await startHungMpv("wait");
    const startedAt = Date.now();
    killAllMpvProcessGroupsSync();
    const tookMs = Date.now() - startedAt;
    // Zombies are dead; the test process (their reaper) may not have run yet.
    const childKilled = isPidKilled(childPid);
    console.info(`${TAG} killAllMpvProcessGroupsSync took ${tookMs}ms childState=${procState(childPid)}`);
    expect(childKilled).toBe(true);
    expect(tookMs).toBeLessThan(2000);
    await waitUntil("wrapper reaped", () => !isPidAlive(wrapperPid), 5000);
    expect(__trackedMpvProcessGroupsForTests()).not.toContain(wrapperPid);
  });

  it("@bugfix @regression-proof a wrapper that exits while the real mpv hangs does not leave an orphan", async () => {
    // The wrapper exits once told to (after the child stopped): the child is
    // reparented away from us, exactly the AppImage orphan.
    const { client, childPid } = await startHungMpv('while [ ! -e "$SF_TEST_GO" ]; do sleep 0.05; done; exit 0');
    const exited = new Promise<void>((resolve) => client.on("exit", () => resolve()));
    writeFileSync(join(dir ?? "", "go"), "");
    await exited;
    console.info(`${TAG} wrapper exited; childState=${procState(childPid)}`);
    const tookMs = await waitUntil("orphaned child dead", () => isPidKilled(childPid), 5000);
    console.info(`${TAG} orphan killed ${tookMs}ms after the wrapper exited`);
    await client.dispose();
  });
});

/**
 * The /proc-based liveness decision (zombie-only groups are dead, stopped
 * members are alive; CI regression PR #111, desktop-test run 8208) lives with
 * the Linux platform implementation:
 * packages/desktop-platform-linux/tests/processes.test.ts.
 */
