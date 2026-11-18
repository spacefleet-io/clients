import { execFile, spawnSync } from "node:child_process";

/**
 * macOS has no procfs: the process table comes from `/bin/ps` (sysctl KERN_PROC underneath), which
 * every macOS ships. One row per process, zombies included.
 */
export type PsRow = { pid: number; ppid: number; pgid: number; stat: string };

/** Runs `ps <args>` and returns stdout, or null when ps failed. Injected by tests. */
export type RunPs = (args: string[]) => string | null;

const PS = "/bin/ps";
const PS_TIMEOUT_MS = 5_000;

export const runPsSync: RunPs = (args) => {
  const res = spawnSync(PS, args, { encoding: "utf8", timeout: PS_TIMEOUT_MS });
  // ps exits 1 when a `-p` pid matches nothing; its (empty) stdout is still the answer.
  if (res.error || typeof res.stdout !== "string") return null;
  return res.stdout;
};

export const runPsAsync = (args: string[]): Promise<string | null> =>
  // Not Promise.withResolvers: the desktop typecheck compiles against a pre-ES2024 lib.
  new Promise((resolve) => {
    execFile(PS, args, { encoding: "utf8", timeout: PS_TIMEOUT_MS }, (error, stdout) => {
      resolve(error && !stdout ? null : stdout);
    });
  });

export const parsePsRows = (text: string): PsRow[] => {
  const rows: PsRow[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), stat: m[4]! });
  }
  return rows;
};

/** Every process of the host, or null when ps could not be run. */
export const listProcesses = (runPs: RunPs = runPsSync): PsRow[] | null => {
  const text = runPs(["-axo", "pid=,ppid=,pgid=,stat="]);
  return text === null ? null : parsePsRows(text);
};

/** `pid` and every live descendant of it, parents before children. */
export const descendantsOf = (rows: readonly PsRow[], pid: number): number[] => {
  const children = new Map<number, number[]>();
  for (const row of rows) {
    if (row.stat.startsWith("Z")) continue;
    const list = children.get(row.ppid);
    if (list) list.push(row.pid);
    else children.set(row.ppid, [row.pid]);
  }
  const out = [pid];
  const seen = new Set(out);
  for (let i = 0; i < out.length; i += 1) {
    for (const child of children.get(out[i]!) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
    }
  }
  return out;
};

/** Validated pid for an argv: a positive integer, so nothing else reaches ps / lsof. */
export const validPid = (pid: number): boolean => Number.isInteger(pid) && pid > 0;
