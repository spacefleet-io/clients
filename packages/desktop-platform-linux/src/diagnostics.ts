import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import type { DiagnosticsLayer } from "@space/desktop-platform-contract";

/**
 * Out-of-process diagnostics of the runtime, taken by the guardian when a
 * health probe fails (#25, ultimate stress P1).
 *
 * A runtime whose event loop is stuck cannot report on itself, so the guardian
 * reads what the kernel knows: the main thread's state (R = wants CPU,
 * D = blocked in I/O, S = sleeping), the kernel function it waits in (wchan),
 * the syscall it is inside and the file that syscall targets (e.g.
 * `fsync runtime_jobs.db-wal`), how much CPU it burned since the previous
 * dump, the state of every thread, and host CPU/IO pressure (procfs).
 *
 * Every read is best-effort: a field that cannot be read is omitted, never an
 * error. Kept permanently on: it runs only on a failed probe.
 */

/** x86_64 / aarch64 numbers of the syscalls that block a JS thread on I/O or a
 *  child. Unknown numbers are logged raw. */
const SYSCALL_NAMES: Record<string, string> = {
  "0": "read",
  "1": "write",
  "7": "poll",
  "17": "pread64",
  "18": "pwrite64",
  "61": "wait4",
  "74": "fsync",
  "75": "fdatasync",
  "87": "unlink",
  "202": "futex",
  "232": "epoll_wait",
  "257": "openat",
  "263": "unlinkat",
  "281": "epoll_pwait",
  "441": "epoll_pwait2",
};
const FD_SYSCALLS: Record<string, true> = { read: true, write: true, pread64: true, pwrite64: true, fsync: true, fdatasync: true };

const readText = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/** Fields after the `(comm)` of /proc/<pid>/stat: [0]=state … [11]=utime [12]=stime. */
const statFields = (raw: string | null): string[] | null => {
  if (!raw) return null;
  const close = raw.lastIndexOf(")");
  return close < 0 ? null : raw.slice(close + 2).split(" ");
};

/**
 * The Linux diagnostics layer over a procfs mounted at `procRoot` (tests point
 * it at a fixture tree). Each instance keeps its own CPU-tick history, so the
 * CPU share of `readProcess` is measured between two dumps of the same layer.
 */
export const createLinuxDiagnostics = (procRoot = "/proc"): DiagnosticsLayer => {
  const describeSyscall = (pid: number, raw: string | null): string | null => {
    if (!raw) return null;
    const parts = raw.trim().split(/\s+/);
    const nr = parts[0];
    if (!nr) return null;
    if (nr === "running") return "running";
    const name = SYSCALL_NAMES[nr] ?? `syscall_${nr}`;
    if (!FD_SYSCALLS[name] || !parts[1]) return name;
    const fd = Number.parseInt(parts[1], 16);
    try {
      return `${name} ${readlinkSync(`${procRoot}/${pid}/fd/${fd}`)}`;
    } catch {
      return `${name} fd=${fd}`;
    }
  };

  // Clock ticks per second for utime/stime; 100 on every mainstream Linux.
  const ticksPerSec = 100;
  const prevTicks = new Map<number, { ticks: number; at: number }>();

  return {
    readProcess: async (pid) => {
      const out: Record<string, unknown> = { platform: "linux", pid };
      const main = statFields(readText(`${procRoot}/${pid}/stat`));
      if (!main) {
        out.alive = false;
        return out;
      }
      out.alive = true;
      out.state = main[0];
      out.wchan = readText(`${procRoot}/${pid}/wchan`)?.trim() || null;
      out.syscall = describeSyscall(pid, readText(`${procRoot}/${pid}/syscall`));
      const ticks = Number(main[11]) + Number(main[12]);
      const now = Date.now();
      const prev = prevTicks.get(pid);
      if (prev && now > prev.at) {
        out.cpuPctSincePrev = Math.round(((ticks - prev.ticks) / ticksPerSec / ((now - prev.at) / 1000)) * 1000) / 10;
        out.msSincePrev = now - prev.at;
      }
      prevTicks.set(pid, { ticks, at: now });
      out.cpuSecondsTotal = Math.round((ticks / ticksPerSec) * 10) / 10;
      const status = readText(`${procRoot}/${pid}/status`);
      const vmRss = status?.match(/^VmRSS:\s+(\d+)/m)?.[1];
      if (vmRss) out.rssMb = Math.round(Number(vmRss) / 1024);
      try {
        const states: Record<string, number> = {};
        const busy: string[] = [];
        for (const tid of readdirSync(`${procRoot}/${pid}/task`)) {
          const f = statFields(readText(`${procRoot}/${pid}/task/${tid}/stat`));
          if (!f?.[0]) continue;
          states[f[0]] = (states[f[0]] ?? 0) + 1;
          if (f[0] !== "S" && busy.length < 12) {
            const comm = readText(`${procRoot}/${pid}/task/${tid}/comm`)?.trim() ?? "?";
            const wchan = readText(`${procRoot}/${pid}/task/${tid}/wchan`)?.trim() || "0";
            busy.push(`${tid}:${comm}:${f[0]}:${wchan}`);
          }
        }
        out.threadStates = states;
        out.nonSleepingThreads = busy;
      } catch {
        // task dir unreadable: leave the thread fields out
      }
      out.psiCpu = readText(`${procRoot}/pressure/cpu`)?.split("\n")[0]?.trim() ?? null;
      out.psiIo = readText(`${procRoot}/pressure/io`)?.split("\n")[0]?.trim() ?? null;
      return out;
    },

    /**
     * Who holds a listening TCP port (#25 P4): the procfs equivalent of
     * `ss -ltnp sport = :<port>`, without spawning a binary. Read from
     * /proc/net/tcp{,6} (state 0A = LISTEN) and matched to a pid through the
     * socket inode in /proc/<pid>/fd. Logged when the port is bound but nothing
     * answers health and runtime.pid names no live holder, so the next triage can
     * tell a draining runtime from a foreign process. Best-effort: processes of
     * other users are invisible without privileges.
     */
    readPortHolders: async (port) => {
      const portHex = port.toString(16).toUpperCase().padStart(4, "0");
      const inodes = new Set<string>();
      for (const table of [`${procRoot}/net/tcp`, `${procRoot}/net/tcp6`]) {
        for (const line of readText(table)?.split("\n").slice(1) ?? []) {
          const cols = line.trim().split(/\s+/);
          // cols: sl local_address rem_address st … uid timeout inode
          if (cols[3] === "0A" && cols[1]?.endsWith(`:${portHex}`) && cols[9]) inodes.add(cols[9]);
        }
      }
      const holders: Array<{ pid: number; comm: string | null; cmdline: string | null }> = [];
      if (inodes.size > 0) {
        let pids: string[] = [];
        try {
          pids = readdirSync(procRoot).filter((name) => /^\d+$/.test(name));
        } catch {
          // procfs unreadable: report the inodes alone
        }
        for (const pid of pids) {
          let fds: string[];
          try {
            fds = readdirSync(`${procRoot}/${pid}/fd`);
          } catch {
            continue;
          }
          const holds = fds.some((fd) => {
            try {
              return inodes.has(readlinkSync(`${procRoot}/${pid}/fd/${fd}`).match(/^socket:\[(\d+)\]$/)?.[1] ?? "");
            } catch {
              return false;
            }
          });
          if (!holds) continue;
          holders.push({
            pid: Number(pid),
            comm: readText(`${procRoot}/${pid}/comm`)?.trim() ?? null,
            cmdline: readText(`${procRoot}/${pid}/cmdline`)?.split("\0").filter(Boolean).join(" ").slice(0, 300) ?? null,
          });
        }
      }
      return { platform: "linux", port, listening: inodes.size > 0, inodes: [...inodes], holders };
    },
  };
};

export const linuxDiagnostics: DiagnosticsLayer = createLinuxDiagnostics();
