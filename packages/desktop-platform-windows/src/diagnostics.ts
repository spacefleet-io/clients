import type { DiagnosticsLayer } from "@space/desktop-platform-contract";
import { runPowerShell, validPid, type PowerShellResult } from "./powershell";

/**
 * Out-of-process diagnostics taken by the guardian when a health probe fails
 * (the Linux layer reads procfs; here PowerShell asks the process table and the
 * TCP table). Every read is best-effort: a field that cannot be read is
 * omitted, never an error. Runs only on a failed probe, as an async child
 * process: a cold PowerShell takes seconds on a saturated 2-core box, and the
 * guardian calling this lives in the Electron main process (#928).
 */

const TIMEOUT_MS = 15_000;

/** JSON of what is known about `pid`: `{"alive":false}` when it does not exist. */
export const buildProcessScript = (pid: number): string =>
  [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$p = Get-Process -Id ${pid}`,
    "if (-not $p) { '{\"alive\":false}'; exit 0 }",
    `$c = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"`,
    "$states = @{}",
    "$busy = New-Object System.Collections.ArrayList",
    "foreach ($t in $p.Threads) {",
    "  $s = [string]$t.ThreadState",
    "  $states[$s] = 1 + [int]$states[$s]",
    '  if ($s -ne \'Wait\' -and $busy.Count -lt 12) { [void]$busy.Add(("{0}:{1}" -f $t.Id, $s)) }',
    "}",
    "[pscustomobject]@{",
    "  alive = $true",
    "  responding = $p.Responding",
    "  cpuSeconds = $p.TotalProcessorTime.TotalSeconds",
    "  workingSetBytes = $p.WorkingSet64",
    "  handles = $p.HandleCount",
    "  threads = $p.Threads.Count",
    "  parentPid = $c.ParentProcessId",
    "  threadStates = $states",
    "  nonWaitingThreads = @($busy)",
    "} | ConvertTo-Json -Compress -Depth 4",
  ].join("\n");

/** JSON `{listening, holders:[{pid, comm, cmdline}]}` of the processes listening on `port`. */
export const buildPortHoldersScript = (port: number): string =>
  [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$conns = @(Get-NetTCPConnection -State Listen -LocalPort ${port})`,
    "$holders = @($conns | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {",
    '  $c = Get-CimInstance Win32_Process -Filter "ProcessId=$_"',
    "  [pscustomobject]@{ pid = [int]$_; comm = $c.Name; cmdline = $c.CommandLine }",
    "})",
    "[pscustomobject]@{ listening = ($conns.Count -gt 0); holders = $holders } | ConvertTo-Json -Compress -Depth 4",
  ].join("\n");

const parseJson = (result: PowerShellResult): Record<string, unknown> | null => {
  if (!result.ok) return null;
  try {
    const value: unknown = JSON.parse(result.stdout.trim());
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const round1 = (value: number) => Math.round(value * 10) / 10;

/** ConvertTo-Json turns a one-element array into the element itself: always hand back a list. */
const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]);

export type WindowsDiagnosticsDeps = {
  run: (script: string) => Promise<PowerShellResult>;
  now: () => number;
};

const defaultDeps: WindowsDiagnosticsDeps = {
  run: (script) => runPowerShell(script, TIMEOUT_MS),
  now: () => Date.now(),
};

/** Each instance keeps its own CPU-time history, so `cpuPctSincePrev` is measured between two dumps of the same layer. */
export const createWindowsDiagnostics = (overrides: Partial<WindowsDiagnosticsDeps> = {}): DiagnosticsLayer => {
  const deps: WindowsDiagnosticsDeps = { ...defaultDeps, ...overrides };
  const prevCpu = new Map<number, { seconds: number; at: number }>();
  return {
    readProcess: async (pid) => {
      const out: Record<string, unknown> = { platform: "windows", pid };
      if (validPid(pid) === null) {
        out.alive = false;
        return out;
      }
      const raw = parseJson(await deps.run(buildProcessScript(pid)));
      if (!raw) {
        out.error = "process table unreadable";
        return out;
      }
      out.alive = raw.alive === true;
      if (!out.alive) return out;
      out.state = raw.responding === false ? "not-responding" : "running";
      const cpuSeconds = num(raw.cpuSeconds);
      if (cpuSeconds !== undefined) {
        const now = deps.now();
        const prev = prevCpu.get(pid);
        if (prev && now > prev.at) {
          out.cpuPctSincePrev = round1(((cpuSeconds - prev.seconds) / ((now - prev.at) / 1000)) * 100);
          out.msSincePrev = now - prev.at;
        }
        prevCpu.set(pid, { seconds: cpuSeconds, at: now });
        out.cpuSecondsTotal = round1(cpuSeconds);
      }
      const workingSet = num(raw.workingSetBytes);
      if (workingSet !== undefined) out.rssMb = Math.round(workingSet / (1024 * 1024));
      const handles = num(raw.handles);
      if (handles !== undefined) out.handles = handles;
      const threads = num(raw.threads);
      if (threads !== undefined) out.threads = threads;
      const parentPid = num(raw.parentPid);
      if (parentPid !== undefined) out.parentPid = parentPid;
      if (raw.threadStates && typeof raw.threadStates === "object") out.threadStates = raw.threadStates;
      out.nonSleepingThreads = asList(raw.nonWaitingThreads);
      return out;
    },

    readPortHolders: async (port) => {
      const out: Record<string, unknown> = { platform: "windows", port, listening: false, inodes: [], holders: [] };
      if (!Number.isInteger(port) || port < 0 || port > 65_535) return out;
      const raw = parseJson(await deps.run(buildPortHoldersScript(port)));
      if (!raw) {
        out.error = "tcp table unreadable";
        return out;
      }
      out.listening = raw.listening === true;
      out.holders = asList(raw.holders).flatMap((holder) => {
        if (!holder || typeof holder !== "object") return [];
        const { pid, comm, cmdline } = holder as Record<string, unknown>;
        if (typeof pid !== "number") return [];
        return [
          {
            pid,
            comm: typeof comm === "string" ? comm : null,
            cmdline: typeof cmdline === "string" ? cmdline.slice(0, 300) : null,
          },
        ];
      });
      return out;
    },
  };
};

export const windowsDiagnostics: DiagnosticsLayer = createWindowsDiagnostics();
