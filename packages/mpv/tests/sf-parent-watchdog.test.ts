/**
 * @bugfix mpv-survives-app-sigkill
 * @regression-proof
 *
 * Ultimate-stress finding F6 (violation `orphan-mpv`): SpaceBadger spawns mpv
 * `detached:true` + `unref()` so it is NOT in the Electron process group; a
 * SIGKILL of the Electron main process therefore left a fullscreen mpv playing
 * with nobody to control it. The fix is an mpv-side watchdog in sf.lua that
 * polls the parent pid it is handed via `--script-opts=sf-parent_pid=<pid>`.
 *
 * This test drives the REAL mpv binary with the REAL sf.lua:
 *   fake parent (a `sleep`) <- pid handed to mpv via script-opts
 *   SIGKILL the fake parent  -> mpv must exit within ~2 s.
 * Pre-fix sf.lua ignores `sf-parent_pid`, mpv keeps running, and the
 * "exits within 2 s of parent SIGKILL" assertion fails.
 *
 * Skips (loudly) when no runnable vendored/explicit mpv exists on the host.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireMediaBinary } from "@space/media-deps";
import { resolveExternalMpvTarget } from "../src/external";
import { resolveMpvOscScript } from "../src/index";

const TAG = "[sf-parent-watchdog]";
const KILL_TO_EXIT_BUDGET_MS = 2_000;

const target = process.platform === "linux" ? resolveExternalMpvTarget() : null;
const oscScript = resolveMpvOscScript();
const runnable = Boolean(target && target.kind !== "fallback" && oscScript);
requireMediaBinary("mpv (shipped bundle) + sf.lua", runnable);
if (!runnable) {
  console.warn(
    `${TAG} SKIP: no runnable mpv/sf.lua (platform=${process.platform} kind=${target?.kind ?? "n/a"} osc=${oscScript ?? "none"}). Run \`bun run setup:binaries\`.`,
  );
}

// Stand-in for a sandboxed SF_MPV_SYSTEM_BIN: a new PID namespace with its own
// /proc, exactly what flatpak/bwrap give mpv. Needs unprivileged user namespaces.
const UNSHARE_PID_NS = ["unshare", "--user", "--map-root-user", "--pid", "--fork", "--mount-proc"];
const unshareProbe = runnable ? spawnSync(UNSHARE_PID_NS[0]!, [...UNSHARE_PID_NS.slice(1), "true"]) : null;
const unshareUsable = unshareProbe?.status === 0;
if (runnable && !unshareUsable) {
  console.warn(
    `${TAG} SKIP sandboxed-namespace case: unprivileged unshare unavailable (status=${unshareProbe?.status} err=${unshareProbe?.stderr?.toString().trim()})`,
  );
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // kill(0) succeeds on zombies; treat them as dead (state Z/X in /proc).
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
    return state !== "Z" && state !== "X";
  } catch {
    return false;
  }
};

type Harness = { dir: string; parent: ChildProcess; mpv: ChildProcess; logFile: string; sock: string };
const live: Harness[] = [];

const launch = async (
  opts: {
    parentPidArg: (parentPid: number) => string | null;
    /** Command prefix mpv is run through (e.g. an `unshare` PID-namespace sandbox). */
    wrapper?: string[];
  } = { parentPidArg: (p) => `sf-parent_pid=${p}` },
): Promise<Harness> => {
  const dir = mkdtempSync(join(tmpdir(), "sf-parent-wd-"));
  const sock = join(dir, "mpv.sock");
  const logFile = join(dir, "mpv.log");
  // The fake "Electron main": any long-lived process we can SIGKILL.
  const parent = spawn("sleep", ["300"], { stdio: "ignore" });
  if (!parent.pid) throw new Error("fake parent failed to spawn");
  const scriptOpts = opts.parentPidArg(parent.pid);
  const args = [
    "--no-config",
    "--idle=yes",
    "--force-window=no",
    "--vo=null",
    "--ao=null",
    "--no-terminal",
    "--load-scripts=no",
    `--log-file=${logFile}`,
    `--input-ipc-server=${sock}`,
    `--script=${oscScript}`,
    ...(scriptOpts ? [`--script-opts=${scriptOpts}`] : []),
  ];
  const env = {
    ...process.env,
    ...(target!.kind === "bundle" && target!.libDirs.length > 0
      ? { LD_LIBRARY_PATH: [target!.libDirs.join(":"), process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") }
      : {}),
  };
  const wrapper = opts.wrapper ?? [];
  console.info(
    `${TAG} launch bin=${target!.bin} kind=${target!.kind} fakeParentPid=${parent.pid} scriptOpts=${scriptOpts} wrapper=${JSON.stringify(wrapper)}`,
  );
  console.info(`${TAG} mpv log file: ${logFile}`);
  // Mirror production: detached + unref, so mpv is NOT in the parent's group.
  // With a wrapper, `mpv.pid` is the wrapper's (unshare --fork waits for mpv).
  const [cmd, ...cmdArgs] = [...wrapper, target!.bin, ...args];
  const mpv = spawn(cmd!, cmdArgs, { stdio: "ignore", detached: true, env });
  mpv.unref();
  const h: Harness = { dir, parent, mpv, logFile, sock };
  live.push(h);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !existsSync(sock)) {
    if (mpv.exitCode !== null) throw new Error(`${TAG} mpv exited early code=${mpv.exitCode}\n${dumpLog(h)}`);
    await sleep(50);
  }
  if (!existsSync(sock)) throw new Error(`${TAG} mpv IPC socket never appeared\n${dumpLog(h)}`);
  // Let sf.lua finish loading (it captures the parent's start time on load).
  await sleep(500);
  console.info(`${TAG} mpv ready pid=${mpv.pid}`);
  return h;
};

const dumpLog = (h: Harness): string => {
  try {
    return `--- mpv log (${h.logFile}) ---\n${readFileSync(h.logFile, "utf8").split("\n").slice(-60).join("\n")}`;
  } catch (err) {
    return `(no mpv log: ${err instanceof Error ? err.message : String(err)})`;
  }
};

const waitGone = async (pid: number, budgetMs: number): Promise<number | null> => {
  const t0 = Date.now();
  while (Date.now() - t0 <= budgetMs) {
    if (!pidAlive(pid)) return Date.now() - t0;
    await sleep(25);
  }
  return null;
};

afterEach(() => {
  for (const h of live.splice(0)) {
    // The vendored AppImage (junest) and the `unshare` wrapper run the real mpv
    // as a descendant, so SIGKILLing `h.mpv.pid` alone orphaned it. The unique
    // log-file path is on that mpv's command line: kill by it first.
    const reaped = spawnSync("pkill", ["-KILL", "-f", h.logFile]);
    console.info(`${TAG} cleanup pkill -f ${h.logFile} status=${reaped.status}`);
    for (const p of [h.mpv.pid, h.parent.pid]) {
      if (p) {
        try {
          process.kill(p, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
    rmSync(h.dir, { recursive: true, force: true });
  }
});

describe.skipIf(!runnable)("sf.lua parent-death watchdog (real mpv)", () => {
  it("mpv exits within 2 s of its parent being SIGKILLed", async () => {
    const h = await launch();
    const mpvPid = h.mpv.pid!;
    expect(pidAlive(mpvPid), "mpv alive while parent is alive").toBe(true);
    // Parent alive for a while: watchdog must NOT fire spuriously.
    await sleep(2_500);
    expect(pidAlive(mpvPid), "mpv must stay up while its parent lives").toBe(true);

    console.info(`${TAG} SIGKILL fake parent pid=${h.parent.pid}`);
    h.parent.kill("SIGKILL");
    const goneAfterMs = await waitGone(mpvPid, KILL_TO_EXIT_BUDGET_MS + 1_000);
    console.info(`${TAG} mpv gone after ${goneAfterMs ?? "NEVER (>3s)"} ms`);
    if (goneAfterMs === null || goneAfterMs > KILL_TO_EXIT_BUDGET_MS) {
      console.error(`${TAG} FAIL dump\n${dumpLog(h)}`);
    }
    expect(goneAfterMs, "mpv exit latency after parent SIGKILL (ms)").not.toBeNull();
    expect(goneAfterMs!).toBeLessThanOrEqual(KILL_TO_EXIT_BUDGET_MS);
  }, 60_000);

  it("mpv started with an already-dead parent pid exits instead of lingering", async () => {
    const dead = spawn("true", [], { stdio: "ignore" });
    await new Promise((r) => dead.on("exit", r));
    const deadPid = dead.pid!;
    // Launch with the dead pid (pid is reaped, so /proc/<pid> is gone).
    const h = await launch({ parentPidArg: () => `sf-parent_pid=${deadPid}` }).catch((err: Error) => {
      // mpv may legitimately quit before we even see the socket: that's the pass condition too.
      console.info(`${TAG} early exit with dead parent (expected): ${err.message.split("\n")[0]}`);
      return null;
    });
    if (h) {
      const goneAfterMs = await waitGone(h.mpv.pid!, KILL_TO_EXIT_BUDGET_MS + 1_000);
      console.info(`${TAG} dead-parent mpv gone after ${goneAfterMs ?? "NEVER"} ms`);
      expect(goneAfterMs, "mpv with dead parent pid must exit").not.toBeNull();
    }
  }, 60_000);

  it("without sf-parent_pid the watchdog is off (mpv keeps running when the 'parent' dies)", async () => {
    const h = await launch({ parentPidArg: () => null });
    h.parent.kill("SIGKILL");
    await sleep(2_000);
    expect(pidAlive(h.mpv.pid!), "no watchdog configured -> mpv unaffected").toBe(true);
  }, 60_000);

  // @bugfix sf-parent-watchdog-sandboxed-pid-namespace @regression-proof
  // A sandboxed SF_MPV_SYSTEM_BIN (flatpak/bwrap) runs mpv in its own PID
  // namespace with its own /proc: the app's pid is invisible there. Pre-fix the
  // watchdog read that as "parent already dead" and quit mpv at start. Now the
  // app also passes its PID-namespace inode and sf.lua disables the watchdog
  // with a warning when mpv's namespace differs.
  it.skipIf(!unshareUsable)(
    "mpv in another PID namespace keeps running and logs that the watchdog is disabled",
    async () => {
      const hostNs = /^pid:\[(\d+)\]$/.exec(readlinkSync("/proc/self/ns/pid"))![1];
      const h = await launch({
        parentPidArg: (p) => `sf-parent_pid=${p},sf-parent_pidns=${hostNs}`,
        wrapper: UNSHARE_PID_NS,
      });
      // Real-time wait: the watchdog polls every 0.5 s against the platform
      // clock in a real mpv process; fake timers cannot drive it.
      await sleep(2_000);
      const alive = pidAlive(h.mpv.pid!);
      const log = readFileSync(h.logFile, "utf8");
      const disabledLine = log.split("\n").find((l) => l.includes("parent-watchdog: disabled, mpv runs in another PID namespace"));
      console.info(`${TAG} sandboxed mpv alive=${alive} hostNs=${hostNs} disabledLine=${disabledLine ?? "<none>"}`);
      if (!alive || !disabledLine) console.error(`${TAG} FAIL dump\n${dumpLog(h)}`);
      expect(alive, "sandboxed mpv must not quit because the app pid is invisible").toBe(true);
      expect(disabledLine, "watchdog must log that it is disabled").toBeTruthy();
    },
    60_000,
  );

  it("same PID namespace: an explicit sf-parent_pidns still watches the parent", async () => {
    const hostNs = /^pid:\[(\d+)\]$/.exec(readlinkSync("/proc/self/ns/pid"))![1];
    const h = await launch({ parentPidArg: (p) => `sf-parent_pid=${p},sf-parent_pidns=${hostNs}` });
    h.parent.kill("SIGKILL");
    const goneAfterMs = await waitGone(h.mpv.pid!, KILL_TO_EXIT_BUDGET_MS + 1_000);
    console.info(`${TAG} same-ns mpv gone after ${goneAfterMs ?? "NEVER"} ms`);
    if (goneAfterMs === null) console.error(`${TAG} FAIL dump\n${dumpLog(h)}`);
    expect(goneAfterMs, "same-namespace watchdog must still fire").not.toBeNull();
  }, 60_000);
});
