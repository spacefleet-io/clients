import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import type { ProcessControlBackend } from "@space/desktop-platform-contract";

/**
 * Linux process control: suspend / resume = SIGSTOP / SIGCONT of the process
 * and its descendants; throttle = `taskset -a -p -c <one cpu>` on every thread
 * of the process and its descendants (the playback gate's backend).
 */
export type LinuxProcessControlDeps = {
  kill: (pid: number, signal: "SIGSTOP" | "SIGCONT") => void;
  /** File text, or null when missing / unreadable. */
  readText: (path: string) => string | null;
  /** Direct child pids of `pid` (any thread), [] when unknown. */
  listChildren: (pid: number) => number[];
  listThreadIds: (pid: number) => number[];
  runTaskset: (args: string[]) => { status: number | null; stderr: string };
};

const readTextOrNull = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/** Kernel thread ids of `pid` (`/proc/<pid>/task`), `[pid]` when unreadable. */
export const listLinuxThreadIds = (pid: number, procRoot = "/proc"): number[] => {
  try {
    const ids = readdirSync(`${procRoot}/${pid}/task`)
      .map((name) => Number.parseInt(name, 10))
      .filter((id) => Number.isInteger(id) && id > 0);
    return ids.length > 0 ? ids : [pid];
  } catch {
    return [pid];
  }
};

const defaultLinuxDeps: LinuxProcessControlDeps = {
  kill: (pid, signal) => process.kill(pid, signal),
  readText: readTextOrNull,
  listChildren: (pid) => {
    try {
      const out: number[] = [];
      for (const tid of readdirSync(`/proc/${pid}/task`)) {
        const text = readTextOrNull(`/proc/${pid}/task/${tid}/children`);
        for (const part of text?.split(/\s+/) ?? []) {
          const child = Number.parseInt(part, 10);
          if (Number.isInteger(child) && child > 0 && !out.includes(child)) out.push(child);
        }
      }
      return out;
    } catch {
      return [];
    }
  },
  listThreadIds: (pid) => listLinuxThreadIds(pid),
  runTaskset: (args) => {
    const res = spawnSync("taskset", args, { encoding: "utf8", timeout: 5000 });
    return { status: res.status, stderr: res.error ? res.error.message : res.stderr };
  },
};

/** `Cpus_allowed_list` of a process (kernel cpu list such as `0-3,8`), or null. */
const readAllowedList = (text: string | null): string | null => {
  const match = text ? /^Cpus_allowed_list:\s*(\S+)/m.exec(text) : null;
  return match ? match[1]! : null;
};

/** Highest cpu in a kernel cpu list, or null when malformed. */
export const lastCpuOfList = (list: string): number | null => {
  let last: number | null = null;
  for (const part of list.split(",")) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) return null;
    const hi = Number(m[2] ?? m[1]);
    if (last === null || hi > last) last = hi;
  }
  return last;
};

/** Number of cpus in a kernel cpu list, or null when malformed. */
export const countCpusOfList = (list: string): number | null => {
  let count = 0;
  for (const part of list.split(",")) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) return null;
    const lo = Number(m[1]);
    const hi = Number(m[2] ?? m[1]);
    if (hi < lo) return null;
    count += hi - lo + 1;
  }
  return count;
};

/** Field 22 of /proc/<pid>/stat (process start time): with the pid it identifies one process for ever. */
const readStartTime = (readText: LinuxProcessControlDeps["readText"], pid: number): string | null => {
  const stat = readText(`/proc/${pid}/stat`);
  if (!stat) return null;
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
};

export const createLinuxProcessControl = (overrides: Partial<LinuxProcessControlDeps> = {}): ProcessControlBackend => {
  const deps: LinuxProcessControlDeps = { ...defaultLinuxDeps, ...overrides };

  const descendants = (pid: number): number[] => {
    const out: number[] = [];
    const walk = (parent: number) => {
      for (const child of deps.listChildren(parent)) {
        if (out.includes(child) || child === pid) continue;
        out.push(child);
        walk(child);
      }
    };
    walk(pid);
    return out;
  };

  return {
    name: "linux",
    throttleKind: "one-core",
    reconcileMs: 1000,
    open: (pid) => {
      const startTime = readStartTime(deps.readText, pid);
      if (startTime === null) throw new Error(`process ${pid} is not readable under /proc`);
      const originalList = readAllowedList(deps.readText(`/proc/${pid}/status`));
      let throttledThreads: string | null = null;

      /** pid + descendants, or [] when the pid is no longer the process we opened (exited, number reused). */
      const targets = (): number[] => {
        if (readStartTime(deps.readText, pid) !== startTime) return [];
        return [pid, ...descendants(pid)];
      };
      const signal = (sig: "SIGSTOP" | "SIGCONT") => {
        for (const target of targets()) {
          try {
            deps.kill(target, sig);
          } catch (err) {
            // ESRCH: it exited between the check and the signal.
            if (!(err instanceof Error && "code" in err && err.code === "ESRCH")) throw err;
          }
        }
      };
      const taskset = (list: string, targetPids: number[]) => {
        for (const target of targetPids) {
          const res = deps.runTaskset(["-a", "-p", "-c", list, String(target)]);
          if (res.status !== 0) throw new Error(res.stderr.trim() || `taskset exited with ${res.status}`);
        }
      };
      const threadKey = (targetPids: number[]) =>
        targetPids.flatMap((target) => deps.listThreadIds(target)).join(",");
      const pin = () => {
        const allowed = originalList ?? readAllowedList(deps.readText("/proc/self/status"));
        const core = allowed === null ? null : lastCpuOfList(allowed);
        if (core === null) throw new Error(`cannot read the allowed cpu list of process ${pid}`);
        const all = targets();
        if (all.length === 0) return;
        taskset(String(core), all);
        throttledThreads = threadKey(all);
      };

      return {
        suspend: () => signal("SIGSTOP"),
        resume: () => signal("SIGCONT"),
        throttle: pin,
        unthrottle: () => {
          throttledThreads = null;
          const all = targets();
          if (all.length === 0) return;
          if (originalList === null) throw new Error(`no original cpu list recorded for process ${pid}`);
          taskset(originalList, all);
        },
        refresh: () => {
          if (throttledThreads === null) return;
          const all = targets();
          if (all.length === 0 || threadKey(all) === throttledThreads) return;
          pin();
        },
        allowedCpuCount: () => {
          const list = readAllowedList(deps.readText(`/proc/${pid}/status`));
          return list === null ? null : countCpusOfList(list);
        },
        close: () => {},
      };
    },
  };
};
