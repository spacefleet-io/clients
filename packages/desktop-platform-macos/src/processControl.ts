import { spawnSync } from "node:child_process";
import type { ProcessControlBackend } from "@space/desktop-platform-contract";
import { descendantsOf, listProcesses, runPsSync, type RunPs } from "./ps";

/**
 * The playback-gate backend on macOS (INGS-LANE-02).
 *
 * suspend / resume = SIGSTOP / SIGCONT of the process and every descendant it has at that moment
 * (a wrapped encoder may run helpers of its own; freezing only the root would leave them working).
 *
 * macOS has no CPU-affinity API, so "throttle" is the background band, as Chris decided for macOS:
 * `taskpolicy -b -p <pid>` (setpriority PRIO_DARWIN_BG: lowest scheduler band, throttled disk I/O,
 * efficiency cores on Apple silicon) for the process and its descendants; `-B` takes them out
 * again. That is a priority band, not a hard one-core cap (`throttleKind: "background-band"`).
 * The band is read back from the process's scheduling priority: the kernel drops a background
 * process's base priority to MAXPRI_THROTTLE (4), which `ps -o pri` shows.
 */
export const DARWIN_BG_PRIORITY = 4;

export type DarwinProcessControlDeps = {
  kill: (pid: number, signal: "SIGSTOP" | "SIGCONT") => void;
  runTaskpolicy: (args: string[]) => { status: number | null; stderr: string };
  runPs: RunPs;
};

const defaultDeps: DarwinProcessControlDeps = {
  kill: (pid, signal) => process.kill(pid, signal),
  runTaskpolicy: (args) => {
    const res = spawnSync("/usr/sbin/taskpolicy", args, { encoding: "utf8", timeout: 5_000 });
    return { status: res.status, stderr: res.error ? res.error.message : res.stderr };
  },
  runPs: runPsSync,
};

export const createDarwinProcessControl = (overrides: Partial<DarwinProcessControlDeps> = {}): ProcessControlBackend => {
  const deps: DarwinProcessControlDeps = { ...defaultDeps, ...overrides };

  /** `pid` first, then its live descendants. Only `pid` when the process table cannot be read. */
  const tree = (pid: number): number[] => {
    const rows = listProcesses(deps.runPs);
    return rows ? descendantsOf(rows, pid) : [pid];
  };

  /** Apply `action` to the whole tree; the root's failure throws, a descendant that exited meanwhile is skipped. */
  const forTree = (pid: number, action: (target: number) => void) => {
    for (const target of tree(pid)) {
      if (target === pid) {
        action(target);
        continue;
      }
      try {
        action(target);
      } catch {
        // exited between the ps read and the action
      }
    }
  };

  const policy = (flag: "-b" | "-B") => (target: number) => {
    const res = deps.runTaskpolicy([flag, "-p", String(target)]);
    if (res.status !== 0) throw new Error(res.stderr.trim() || `taskpolicy ${flag} -p ${target} exited with ${res.status}`);
  };

  return {
    name: "darwin",
    throttleKind: "background-band",
    reconcileMs: 0,
    open: (pid) => ({
      suspend: () => forTree(pid, (target) => deps.kill(target, "SIGSTOP")),
      resume: () => forTree(pid, (target) => deps.kill(target, "SIGCONT")),
      throttle: () => forTree(pid, policy("-b")),
      unthrottle: () => forTree(pid, policy("-B")),
      inBackgroundBand: () => {
        const text = deps.runPs(["-o", "pri=", "-p", String(pid)])?.trim();
        if (!text || !/^\d+$/.test(text)) return null;
        return Number(text) <= DARWIN_BG_PRIORITY;
      },
      close: () => {},
    }),
  };
};
