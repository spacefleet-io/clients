import { execFile } from "node:child_process";
import { loadavg } from "node:os";
import type { DiagnosticsLayer } from "@space/desktop-platform-contract";
import { runPsAsync, validPid } from "./ps";

/**
 * Out-of-process diagnostics taken by the guardian when a health probe fails. macOS has no procfs,
 * so the process table comes from `ps` (state, CPU, memory, every thread's state and priority),
 * host memory from `vm_stat` and listening sockets from `lsof`. Every read is best-effort: a field
 * that cannot be read is omitted, never an error. Runs only on a failed probe, without blocking
 * the caller's event loop (the guardian runs in the Electron main process).
 */

export type MacosDiagnosticsReaders = {
  /** stdout of `ps <args>`, or null when ps failed. */
  runPs: (args: string[]) => Promise<string | null>;
  /** stdout of `<command> <args>`, or null when it could not run. */
  run: (command: string, args: string[]) => Promise<string | null>;
};

const defaultReaders: MacosDiagnosticsReaders = {
  runPs: runPsAsync,
  run: (command, args) =>
    new Promise((resolve) => {
      execFile(command, args, { encoding: "utf8", timeout: 10_000 }, (error, stdout) => {
        resolve(error && !stdout ? null : typeof stdout === "string" ? stdout : null);
      });
    }),
};

/** `ps -o pid=,ppid=,pgid=,stat=,%cpu=,rss=,vsz=,etime=,time=` -> fields, or null for no row. */
export const parseProcessRow = (text: string | null): Record<string, unknown> | null => {
  const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)/.exec(text ?? "");
  if (!m) return null;
  return {
    pid: Number(m[1]),
    parentPid: Number(m[2]),
    pgid: Number(m[3]),
    state: m[4],
    cpuPercent: Number(m[5]),
    rssBytes: Number(m[6]) * 1024,
    vszBytes: Number(m[7]) * 1024,
    elapsed: m[8],
    cpuTime: m[9],
  };
};

/** `ps -M -p <pid>` (one row per thread) -> thread count, count per state, and the non-sleeping threads. */
export const parseThreadRows = (text: string | null): Record<string, unknown> | null => {
  if (!text) return null;
  const states: Record<string, number> = {};
  const busy: string[] = [];
  let threads = 0;
  for (const line of text.split("\n").slice(1)) {
    const m = /\s([\d.]+)\s+(\S+)\s+(\d+\S*)\s+\d+:[\d.]+\s+\d+:[\d.]+/.exec(line);
    if (!m) continue;
    threads += 1;
    const state = m[2]!.charAt(0);
    states[state] = (states[state] ?? 0) + 1;
    if (state !== "S" && state !== "I" && busy.length < 12) busy.push(`${threads}:${m[2]} pri=${m[3]} cpu=${m[1]}%`);
  }
  return threads > 0 ? { threads, threadStates: states, nonSleepingThreads: busy } : null;
};

/** `vm_stat` -> host memory in bytes (free, active, inactive, wired, compressed). */
export const parseVmStat = (text: string | null): Record<string, number> | null => {
  if (!text) return null;
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
  if (!Number.isFinite(pageSize) || pageSize <= 0) return null;
  const pages = (label: string) => {
    const m = new RegExp(`^${label}:\\s+(\\d+)\\.`, "m").exec(text);
    return m ? Number(m[1]) * pageSize : undefined;
  };
  const out: Record<string, number> = {};
  const fields: Array<[string, string]> = [
    ["freeBytes", "Pages free"],
    ["activeBytes", "Pages active"],
    ["inactiveBytes", "Pages inactive"],
    ["wiredBytes", "Pages wired down"],
    ["compressedBytes", "Pages occupied by compressor"],
  ];
  for (const [key, label] of fields) {
    const value = pages(label);
    if (value !== undefined) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
};

/** `lsof -F pc` records (`p<pid>` then `c<command>` lines) -> unique holders. */
export const parseLsofHolders = (text: string | null): Array<{ pid: number; comm?: string }> => {
  const holders: Array<{ pid: number; comm?: string }> = [];
  for (const line of (text ?? "").split("\n")) {
    if (line.startsWith("p")) {
      const pid = Number(line.slice(1));
      if (validPid(pid) && !holders.some((holder) => holder.pid === pid)) holders.push({ pid });
    } else if (line.startsWith("c") && holders.length > 0) {
      holders[holders.length - 1]!.comm = line.slice(1);
    }
  }
  return holders;
};

export const createMacosDiagnostics = (readers: Partial<MacosDiagnosticsReaders> = {}): DiagnosticsLayer => {
  const { runPs, run } = { ...defaultReaders, ...readers };
  const commandLine = async (pid: number) => (await runPs(["-ww", "-o", "command=", "-p", String(pid)]))?.trim() || undefined;
  return {
    readProcess: async (pid) => {
      const out: Record<string, unknown> = { platform: "macos", pid };
      if (!validPid(pid)) return { ...out, alive: false };
      const row = parseProcessRow(await runPs(["-o", "pid=,ppid=,pgid=,stat=,%cpu=,rss=,vsz=,etime=,time=", "-p", String(pid)]));
      if (!row) return { ...out, alive: false };
      Object.assign(out, { alive: !String(row.state).startsWith("Z") }, row);
      const cmdline = await commandLine(pid);
      if (cmdline) out.cmdline = cmdline;
      const threads = parseThreadRows(await runPs(["-M", "-p", String(pid)]));
      if (threads) Object.assign(out, threads);
      out.loadAverage = loadavg();
      const memory = parseVmStat(await run("/usr/bin/vm_stat", []));
      if (memory) out.hostMemory = memory;
      return out;
    },
    readPortHolders: async (port) => {
      const out: Record<string, unknown> = { platform: "macos", port };
      if (!Number.isInteger(port) || port <= 0 || port > 65535) return out;
      const text = await run("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"]);
      if (text === null) return out;
      const holders = await Promise.all(
        parseLsofHolders(text).map(async (holder) => ({ ...holder, cmdline: await commandLine(holder.pid) })),
      );
      return { ...out, listening: holders.length > 0, holders };
    },
  };
};

export const macosDiagnostics: DiagnosticsLayer = createMacosDiagnostics();
