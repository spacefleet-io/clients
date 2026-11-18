import { spawnSync } from "node:child_process";
import type { GroupSignal, ProcessLayer } from "@space/desktop-platform-contract";
import { validPid } from "./powershell";

const errorCode = (error: unknown): string | undefined =>
  error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;

/**
 * argv of `taskkill` for a whole process tree: `/T` follows the parent links
 * below `pid`. `kill` adds `/F`, a forced terminate. Without `/F` taskkill only
 * asks windowed processes to close, so `terminate` is a request a console
 * process (bun, ffmpeg, mpv) ignores: it reports failure and the caller
 * escalates to `kill`.
 */
export const buildTaskkillArgs = (pid: number, signal: GroupSignal): string[] => {
  const args = ["/PID", String(pid), "/T"];
  if (signal === "kill") args.push("/F");
  return args;
};

export type WindowsProcessGroupDeps = {
  /** Runs `taskkill <args>` and returns its exit status (null when it could not run / timed out). */
  runTaskkill: (args: string[]) => number | null;
  /** `process.kill(pid, 0)` semantics: true when the process exists. */
  probe: (pid: number) => boolean;
};

const defaultDeps: WindowsProcessGroupDeps = {
  runTaskkill: (args) =>
    spawnSync("taskkill.exe", args, { windowsHide: true, stdio: "ignore", timeout: 15_000 }).status,
  probe: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return errorCode(error) === "EPERM";
    }
  },
};

/**
 * Process groups on Windows: there is no process group id, so the group is the
 * tree below the leader's pid (the leader was spawned detached) and is
 * addressed with `taskkill /T`. `isAlive` is the leader's liveness: libuv's
 * signal-0 probe checks the exit code, so a terminated leader whose handle a
 * parent still holds reads as gone.
 */
export const createWindowsProcessGroup = (overrides: Partial<WindowsProcessGroupDeps> = {}): ProcessLayer["group"] => {
  const deps: WindowsProcessGroupDeps = { ...defaultDeps, ...overrides };
  return {
    isAlive: (leaderPid) => validPid(leaderPid) !== null && deps.probe(leaderPid),
    signal: (leaderPid, signal) => {
      if (validPid(leaderPid) === null) return false;
      return deps.runTaskkill(buildTaskkillArgs(leaderPid, signal)) === 0;
    },
  };
};
