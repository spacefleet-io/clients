import { spawn, type ChildProcess } from "node:child_process";
import type { Env, ProcessLayer } from "@space/desktop-platform-contract";
import { buildPowerShellArgs, powershellExecutable, runPowerShell, runPowerShellSync, type PowerShellResult } from "./powershell";
import {
  ACCESS_ASSIGN_TO_JOB,
  ACCESS_HOLDER_ASSIGN,
  CHILD_LIFETIME_JOB_LIMITS,
  CREATE_BREAKAWAY_FROM_JOB,
  CREATE_NEW_PROCESS_GROUP,
  CREATE_NO_WINDOW,
  ERROR_ACCESS_DENIED,
  ERROR_INVALID_PARAMETER,
  JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION_SIZE,
  JOBOBJECT_LIMIT_FLAGS_OFFSET,
  STILL_ACTIVE,
  loadWin32Api,
  type Handle,
  type Win32Api,
} from "./win32api";

/**
 * A child must die with the process that spawned it (an encoder that outlives a
 * crashed runtime keeps encoding at full CPU). Windows has a kernel mechanism
 * for exactly that, no polling: a Job Object with
 * JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE. Every process in the job (and the
 * descendants it spawns, which join the job) is terminated when the LAST handle
 * to the job closes, and the kernel closes a dead process's handles.
 *
 *  - Bun: ONE in-process job object (`bun:ffi`), created on first use, never
 *    closed; the child is assigned to it right after the spawn. The job handle
 *    dies with this process, however it dies.
 *  - Electron / Node (no `bun:ffi`): ONE hidden PowerShell "holder" owns the job
 *    (P/Invoke of the same calls) and reads child pids from its stdin. Its stdin
 *    pipe is held only by this process, so when this process dies the pipe closes,
 *    the holder exits, and the job closes with it.
 *
 * `wrap` is the identity: the guarantee is set up after the spawn (`afterSpawn`).
 *
 * `spawnSurvivor` is the one way out: a launcher creates the process with CREATE_BREAKAWAY_FROM_JOB, which the job
 * allows (JOB_OBJECT_LIMIT_BREAKAWAY_OK) only for a process that asks for it, so it outlives this process (the e2e
 * harness's `docker compose down`, started from an exit handler, used to be killed with the worker and leak the
 * compose project and its fixed ports). Nothing else asks: Node, Bun, mpv and Electron's own children (browser, GPU,
 * renderer, utility; checked on Windows 11 with Electron 45) stay members.
 *
 * `afterSpawn` leaves a window: whatever the child spawned before it was assigned is outside the job. A process
 * that spawns a launcher which spawns the app (the e2e harness) calls `adoptCurrentProcess` once, BEFORE its first
 * spawn: it joins the job itself, and everything it spawns afterwards is a member from creation. Nested jobs
 * (Windows 8+ / Server 2012+) let a descendant's own job (the low-end profile's) nest inside.
 */

export type LifetimeLog = (level: "info" | "warn", event: Record<string, unknown>) => void;

const defaultLog: LifetimeLog = (level, event) => {
  if (level === "info") console.info(JSON.stringify(event));
  else console.warn(JSON.stringify(event));
};

/**
 * The PowerShell holder: creates the job, then assigns every pid read from stdin until stdin closes. It answers each pid
 * with one line:
 *  - `assigned <pid>`: the child is in the job;
 *  - `exited <pid>`: the child exited before the holder reached it (a short-lived ffprobe while the holder was still
 *    starting). Nothing to bind: a child that is gone cannot outlive anyone. Either no process has the pid any more
 *    (OpenProcess fails with ERROR_INVALID_PARAMETER, 87), or its parent still holds a handle to the dead process
 *    (AssignProcessToJobObject fails with ERROR_ACCESS_DENIED, 5, and the exit code is no longer STILL_ACTIVE);
 *  - `open-failed <pid> <win32 error>` / `assign-failed <pid> <win32 error>`: a live child the job could not take.
 *
 * `$ProgressPreference`: Windows PowerShell 5.1 reports "Preparing modules for first use." as a progress record, and
 * with stderr on a pipe every record goes there as CLIXML. Nobody reads progress here, so it is not produced.
 */
export const buildJobHolderScript = (): string =>
  [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "Add-Type -TypeDefinition @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public static class SfJob {",
    '  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]',
    "  public static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);",
    '  [DllImport("kernel32.dll", SetLastError = true)]',
    "  public static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint size);",
    '  [DllImport("kernel32.dll", SetLastError = true)]',
    "  public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);",
    '  [DllImport("kernel32.dll", SetLastError = true)]',
    "  public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);",
    '  [DllImport("kernel32.dll", SetLastError = true)]',
    "  public static extern bool GetExitCodeProcess(IntPtr process, out uint code);",
    '  [DllImport("kernel32.dll", SetLastError = true)]',
    "  public static extern bool CloseHandle(IntPtr handle);",
    "}",
    "'@",
    "function Reply([string]$text) { [Console]::Out.WriteLine($text); [Console]::Out.Flush() }",
    `$info = [Runtime.InteropServices.Marshal]::AllocHGlobal(${JOBOBJECT_EXTENDED_LIMIT_INFORMATION_SIZE})`,
    `for ($i = 0; $i -lt ${JOBOBJECT_EXTENDED_LIMIT_INFORMATION_SIZE}; $i += 8) { [Runtime.InteropServices.Marshal]::WriteInt64($info, $i, 0) }`,
    `[Runtime.InteropServices.Marshal]::WriteInt32($info, ${JOBOBJECT_LIMIT_FLAGS_OFFSET}, 0x${CHILD_LIFETIME_JOB_LIMITS.toString(16)})`,
    "$job = [SfJob]::CreateJobObjectW([IntPtr]::Zero, $null)",
    "if ($job -eq [IntPtr]::Zero) { [Console]::Error.WriteLine('CreateJobObjectW failed'); exit 2 }",
    `if (-not [SfJob]::SetInformationJobObject($job, ${JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS}, $info, ${JOBOBJECT_EXTENDED_LIMIT_INFORMATION_SIZE})) { [Console]::Error.WriteLine('SetInformationJobObject failed'); exit 3 }`,
    "Reply 'ready'",
    "$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput())",
    "while ($null -ne ($line = $reader.ReadLine())) {",
    "  $id = [uint32]0",
    "  if (-not [uint32]::TryParse($line.Trim(), [ref]$id)) { continue }",
    `  $proc = [SfJob]::OpenProcess(0x${ACCESS_HOLDER_ASSIGN.toString(16).padStart(4, "0")}, $false, $id)`,
    "  if ($proc -eq [IntPtr]::Zero) {",
    "    $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()",
    `    if ($err -eq ${ERROR_INVALID_PARAMETER}) { Reply "exited $id" } else { Reply "open-failed $id $err" }`,
    "    continue",
    "  }",
    "  $ok = [SfJob]::AssignProcessToJobObject($job, $proc)",
    "  $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()",
    "  $code = [uint32]0",
    `  $gone = (-not $ok) -and [SfJob]::GetExitCodeProcess($proc, [ref]$code) -and ($code -ne ${STILL_ACTIVE})`,
    "  [void][SfJob]::CloseHandle($proc)",
    '  if ($ok) { Reply "assigned $id" } elseif ($gone) { Reply "exited $id" } else { Reply "assign-failed $id $err" }',
    "}",
    "exit 0",
  ].join("\n");

/** One answer of the holder to a pid (see `buildJobHolderScript`), or null for another line (`ready`). */
export type HolderAnswer = { outcome: "assigned" | "exited" | "assign-failed" | "open-failed"; pid: number; win32Error?: number };

export const parseHolderAnswer = (line: string): HolderAnswer | null => {
  const match = /^(assigned|exited|assign-failed|open-failed) (\d+)(?: (\d+))?$/.exec(line.trim());
  if (!match) return null;
  const answer: HolderAnswer = { outcome: match[1] as HolderAnswer["outcome"], pid: Number(match[2]) };
  if (match[3] !== undefined) answer.win32Error = Number(match[3]);
  return answer;
};

/** What the holder's stderr carried: real error text, or a progress record nobody needs to act on. */
export type HolderStderrRecord = { kind: "error"; text: string } | { kind: "progress"; text: string };

const decodeClixmlText = (text: string): string =>
  text
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

/** The records of one CLIXML `<Objs>` document: its error / warning text (one element per line, joined) and its progress activities. */
export const decodeClixmlDocument = (document: string): HolderStderrRecord[] => {
  const records: HolderStderrRecord[] = [];
  for (const match of document.matchAll(/<Obj S="progress"[\s\S]*?<AV>([\s\S]*?)<\/AV>/g)) {
    records.push({ kind: "progress", text: decodeClixmlText(match[1] ?? "").trim() });
  }
  const errorText = [...document.matchAll(/<S S="(?:Error|Warning)">([\s\S]*?)<\/S>/g)].map((match) => decodeClixmlText(match[1] ?? "")).join("").trim();
  if (errorText.length > 0) records.push({ kind: "error", text: errorText });
  return records;
};

/**
 * Windows PowerShell writes its error, warning and progress streams to a piped stderr as CLIXML: a `#< CLIXML` line,
 * then one `<Objs>…</Objs>` document per write, arriving in arbitrary chunks. Plain text (the script's own
 * `[Console]::Error` lines) is passed through line by line. `flush` hands over whatever is left when the holder exits.
 */
export const createHolderStderrReader = (onRecord: (record: HolderStderrRecord) => void) => {
  let buffer = "";
  const drain = () => {
    for (;;) {
      buffer = buffer.replace(/^\s+/, "");
      if (buffer.length === 0) return;
      if (buffer.startsWith("<Objs")) {
        const end = buffer.indexOf("</Objs>");
        if (end < 0) return;
        for (const record of decodeClixmlDocument(buffer.slice(0, end + "</Objs>".length))) onRecord(record);
        buffer = buffer.slice(end + "</Objs>".length);
        continue;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line !== "#< CLIXML") onRecord({ kind: "error", text: line });
    }
  };
  return {
    push: (text: string) => {
      buffer += text;
      drain();
    },
    flush: () => {
      const rest = buffer.trim();
      buffer = "";
      if (rest.length > 0 && rest !== "#< CLIXML") onRecord({ kind: "error", text: rest });
    },
  };
};

/** The slice of a spawned child the holder needs (tests pass a fake). */
export type HolderChild = Pick<ChildProcess, "stdin" | "stdout" | "stderr" | "unref" | "on" | "pid">;
export type SpawnHolder = (command: string, args: string[]) => HolderChild;

const defaultSpawnHolder: SpawnHolder = (command, args) =>
  spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

/** Bound on the PowerShell holder confirming an assignment (cold start + Add-Type compile). */
const ADOPT_TIMEOUT_MS = 30_000;
/** Bound on the survivor launcher (cold PowerShell + Add-Type, seconds on a loaded host). */
const SURVIVOR_LAUNCH_TIMEOUT_MS = 30_000;

/** One argv element as CreateProcess's command line carries it (the CommandLineToArgvW / MSVCRT parsing rules). */
export const quoteWindowsArgument = (arg: string): string => {
  if (arg.length > 0 && !/[\s"]/.test(arg)) return arg;
  let quoted = '"';
  let backslashes = 0;
  for (const char of arg) {
    if (char === "\\") {
      backslashes += 1;
      continue;
    }
    // Backslashes count literally unless a quote follows them: then each is doubled and the quote escaped.
    quoted += char === '"' ? `${"\\".repeat(backslashes * 2 + 1)}"` : `${"\\".repeat(backslashes)}${char}`;
    backslashes = 0;
  }
  return `${quoted}${"\\".repeat(backslashes * 2)}"`;
};

/**
 * The launcher `spawnSurvivor` runs: CreateProcessW of `commandLine` with CREATE_BREAKAWAY_FROM_JOB (plus its own
 * process group and no console), inheriting the launcher's environment and working folder and NO handle (an
 * inherited stdout pipe would keep the synchronous caller waiting for the survivor's exit). When an enclosing job
 * refuses breakaway (ERROR_ACCESS_DENIED) it starts the process anyway, inside the jobs, and says so. Answers one
 * line: `started <pid> breakaway`, `started <pid> in-job <win32 error of the breakaway attempt>`, or `failed <error>`.
 */
export const buildSurvivorLauncherScript = (commandLine: string): string => {
  const flags = CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW;
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "Add-Type -TypeDefinition @'",
    "using System;",
    "using System.Text;",
    "using System.Runtime.InteropServices;",
    "public static class SfSurvivor {",
    "  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]",
    "  struct StartupInfo { public int cb; public string reserved, desktop, title; public int x, y, width, height, xChars, yChars, fill, flags; public short show, reserved2Size; public IntPtr reserved2, stdIn, stdOut, stdErr; }",
    "  [StructLayout(LayoutKind.Sequential)]",
    "  struct ProcessInformation { public IntPtr process, thread; public int pid, tid; }",
    '  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]',
    "  static extern bool CreateProcessW(string app, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string folder, ref StartupInfo startup, out ProcessInformation info);",
    '  [DllImport("kernel32.dll", SetLastError = true)]',
    "  static extern bool CloseHandle(IntPtr handle);",
    "  public static int Start(string commandLine, uint flags, out int error) {",
    "    var startup = new StartupInfo(); startup.cb = Marshal.SizeOf(typeof(StartupInfo)); ProcessInformation info;",
    "    if (!CreateProcessW(null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, false, flags, IntPtr.Zero, null, ref startup, out info)) { error = Marshal.GetLastWin32Error(); return 0; }",
    "    CloseHandle(info.thread); CloseHandle(info.process); error = 0; return info.pid;",
    "  }",
    "}",
    "'@",
    `$commandLine = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(commandLine, "utf8").toString("base64")}'))`,
    "$err = 0",
    `$id = [SfSurvivor]::Start($commandLine, 0x${(flags | CREATE_BREAKAWAY_FROM_JOB).toString(16)}, [ref]$err)`,
    "if ($id -ne 0) { [Console]::Out.WriteLine(\"started $id breakaway\"); exit 0 }",
    `if ($err -ne ${ERROR_ACCESS_DENIED}) { [Console]::Out.WriteLine("failed $err"); exit 0 }`,
    "$breakawayErr = $err",
    `$id = [SfSurvivor]::Start($commandLine, 0x${flags.toString(16)}, [ref]$err)`,
    "if ($id -ne 0) { [Console]::Out.WriteLine(\"started $id in-job $breakawayErr\") } else { [Console]::Out.WriteLine(\"failed $err\") }",
    "exit 0",
  ].join("\n");
};

export type WindowsChildLifetimeDeps = {
  /** The Win32 API, or null when the runtime has no `bun:ffi` (then the PowerShell holder is used). */
  loadApi: () => Win32Api | null;
  spawnHolder: SpawnHolder;
  /** Whether PowerShell can run (the holder's prerequisite). */
  probePowerShell: () => Promise<boolean>;
  /** Runs the survivor launcher, with `env` as its environment (which the survivor inherits). */
  runPowerShellSync: (script: string, timeoutMs: number, env: Env) => PowerShellResult;
  log: LifetimeLog;
  adoptTimeoutMs: number;
};

const defaultDeps: WindowsChildLifetimeDeps = {
  loadApi: loadWin32Api,
  spawnHolder: defaultSpawnHolder,
  probePowerShell: async () => (await runPowerShell("exit 0", 20_000)).ok,
  runPowerShellSync,
  log: defaultLog,
  adoptTimeoutMs: ADOPT_TIMEOUT_MS,
};

export const createWindowsChildLifetime = (overrides: Partial<WindowsChildLifetimeDeps> = {}): ProcessLayer["childLifetime"] => {
  const deps: WindowsChildLifetimeDeps = { ...defaultDeps, ...overrides };

  // --- in-process job (Bun) -------------------------------------------------
  let job: Handle | null | undefined;
  const ensureJob = (api: Win32Api): Handle | null => {
    if (job !== undefined) return job;
    const created = api.createJobObject();
    if (created !== null && !api.setKillOnClose(created)) {
      api.closeHandle(created);
      job = null;
    } else {
      job = created;
    }
    deps.log(job === null ? "warn" : "info", { event: "child_lifetime.job", mode: "bun-ffi", created: job !== null });
    return job;
  };
  const assignInProcess = (api: Win32Api, pid: number): boolean => {
    const jobHandle = ensureJob(api);
    if (jobHandle === null) {
      deps.log("warn", { event: "child_lifetime.assign", mode: "bun-ffi", pid, ok: false, reason: "job-not-created" });
      return false;
    }
    const process = api.openProcess(pid, ACCESS_ASSIGN_TO_JOB);
    if (process === null) {
      deps.log("warn", { event: "child_lifetime.assign", mode: "bun-ffi", pid, ok: false, reason: "open-process-failed" });
      return false;
    }
    try {
      const ok = api.assignProcessToJob(jobHandle, process);
      deps.log(ok ? "info" : "warn", { event: "child_lifetime.assign", mode: "bun-ffi", pid, ok });
      return ok;
    } finally {
      api.closeHandle(process);
    }
  };

  // --- PowerShell holder (Electron / Node) ---------------------------------
  let holder: HolderChild | null = null;
  /** Pids whose assignment `adoptCurrentProcess` is waiting on: settled by the holder's answer line for that pid. */
  const pendingAdopt = new Map<number, (ok: boolean) => void>();
  const startHolder = (): HolderChild => {
    const child = deps.spawnHolder(powershellExecutable(), buildPowerShellArgs(buildJobHolderScript()));
    holder = child;
    // The holder must not keep this process alive, only follow its death.
    child.unref();
    const unref = (stream: unknown) => (stream as { unref?: () => void } | null)?.unref?.();
    child.stdin?.on("error", () => {}); // the holder died: the next spawn restarts it
    unref(child.stdin);
    child.stdout?.setEncoding("utf8");
    let pendingLine = "";
    child.stdout?.on("data", (text: string) => {
      const lines = (pendingLine + text).split(/\r?\n/);
      pendingLine = lines.pop() ?? "";
      for (const line of lines.filter(Boolean)) {
        const answer = parseHolderAnswer(line);
        if (!answer) {
          deps.log(line === "ready" ? "info" : "warn", { event: "child_lifetime.holder", line });
          continue;
        }
        if (answer.outcome === "assigned") {
          deps.log("info", { event: "child_lifetime.assign", mode: "powershell-holder", pid: answer.pid, ok: true });
        } else if (answer.outcome === "exited") {
          // A short-lived child (ffprobe) ended before the holder reached it, typically while the holder was still
          // starting. Not a lifetime gap: the child is already gone.
          deps.log("info", { event: "child_lifetime.assign", mode: "powershell-holder", pid: answer.pid, ok: false, reason: "child-exited-before-assignment" });
        } else {
          deps.log("warn", {
            event: "child_lifetime.assign",
            mode: "powershell-holder",
            pid: answer.pid,
            ok: false,
            reason: answer.outcome,
            win32Error: answer.win32Error ?? null,
            effect: "this child can outlive a killed parent",
          });
        }
        pendingAdopt.get(answer.pid)?.(answer.outcome === "assigned");
      }
    });
    unref(child.stdout);
    child.stderr?.setEncoding("utf8");
    const stderr = createHolderStderrReader((record) => {
      if (record.kind === "progress") {
        deps.log("info", { event: "child_lifetime.holder", progress: record.text.slice(0, 500) });
        return;
      }
      // An error from the -EncodedCommand script is the WHOLE script echoed back, then the message and its position:
      // the tail is what says what failed.
      deps.log("warn", { event: "child_lifetime.holder", stderr: record.text.length > 2000 ? `…${record.text.slice(-2000)}` : record.text });
    });
    child.stderr?.on("data", (text: string) => stderr.push(text));
    unref(child.stderr);
    const forget = () => {
      if (holder === child) holder = null;
      for (const settle of pendingAdopt.values()) settle(false);
    };
    child.on("error", (error) => {
      deps.log("warn", { event: "child_lifetime.holder", error: error.message });
      forget();
    });
    child.on("exit", (code) => {
      stderr.flush();
      deps.log("warn", { event: "child_lifetime.holder", exited: code });
      forget();
    });
    return child;
  };
  const assignViaHolder = (pid: number): void => {
    const child = holder ?? startHolder();
    child.stdin?.write(`${pid}\n`);
  };

  const adoptViaHolder = (pid: number): Promise<boolean> => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const timer = setTimeout(() => {
      deps.log("warn", { event: "child_lifetime.adopt", pid, ok: false, reason: "holder-timeout", timeoutMs: deps.adoptTimeoutMs });
      resolve(false);
    }, deps.adoptTimeoutMs);
    pendingAdopt.set(pid, (ok) => {
      clearTimeout(timer);
      pendingAdopt.delete(pid);
      resolve(ok);
    });
    try {
      assignViaHolder(pid);
    } catch (error) {
      clearTimeout(timer);
      pendingAdopt.delete(pid);
      throw error;
    }
    return promise;
  };

  let supportedProbe: Promise<boolean> | null = null;
  const probeSupported = async (): Promise<boolean> => {
    const api = deps.loadApi();
    if (api) return ensureJob(api) !== null;
    const ok = await deps.probePowerShell();
    if (!ok) deps.log("warn", { event: "child_lifetime.supported", mode: "powershell-holder", ok: false, effect: "a child can outlive a killed parent" });
    return ok;
  };

  return {
    supported: () => (supportedProbe ??= probeSupported()),
    wrap: async (command, args) => ({ command, args }),
    adoptCurrentProcess: async () => {
      try {
        const api = deps.loadApi();
        return api ? assignInProcess(api, process.pid) : await adoptViaHolder(process.pid);
      } catch (error) {
        deps.log("warn", { event: "child_lifetime.adopt", pid: process.pid, ok: false, error: error instanceof Error ? error.message : String(error) });
        return false;
      }
    },
    afterSpawn: (pid) => {
      if (pid === undefined) return;
      try {
        const api = deps.loadApi();
        if (api) assignInProcess(api, pid);
        else assignViaHolder(pid);
      } catch (error) {
        deps.log("warn", { event: "child_lifetime.assign", pid, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    },
    spawnSurvivor: (command, args, env) => {
      const commandLine = [command, ...args].map(quoteWindowsArgument).join(" ");
      const result = deps.runPowerShellSync(buildSurvivorLauncherScript(commandLine), SURVIVOR_LAUNCH_TIMEOUT_MS, env);
      const started = /^started (\d+) (breakaway|in-job)(?: (\d+))?$/m.exec(result.stdout);
      if (started) {
        const pid = Number(started[1]);
        if (started[2] === "breakaway") {
          deps.log("info", { event: "child_lifetime.survivor", pid, command, outsideJob: true });
        } else {
          deps.log("warn", {
            event: "child_lifetime.survivor",
            pid,
            command,
            outsideJob: false,
            win32Error: Number(started[3]),
            effect: "an enclosing job refuses breakaway: this process dies with that job",
          });
        }
        return pid;
      }
      const failed = /^failed (\d+)$/m.exec(result.stdout);
      deps.log("warn", {
        event: "child_lifetime.survivor",
        pid: null,
        command,
        win32Error: failed ? Number(failed[1]) : null,
        launcher: result.error ?? null,
        stderr: result.stderr.trim().slice(-2000),
      });
      return null;
    },
  };
};
