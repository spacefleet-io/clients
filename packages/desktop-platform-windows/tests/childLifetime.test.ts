import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  buildJobHolderScript,
  buildSurvivorLauncherScript,
  createHolderStderrReader,
  createWindowsChildLifetime,
  decodeClixmlDocument,
  parseHolderAnswer,
  quoteWindowsArgument,
  type HolderChild,
  type HolderStderrRecord,
  type LifetimeLog,
} from "../src/childLifetime";
import { decodePowerShellScript, type PowerShellResult } from "../src/powershell";
import type { Win32Api } from "../src/win32api";

const silent = () => {};

const fakeApi = (options: { job?: number | null; killOnClose?: boolean; openFails?: boolean } = {}) => {
  const log: string[] = [];
  const api: Win32Api = {
    openProcess: (pid, access) => (log.push(`open ${pid} 0x${access.toString(16)}`), options.openFails ? null : 900 + pid),
    closeHandle: (h) => void log.push(`close ${h}`),
    ntSuspendProcess: () => 0,
    ntResumeProcess: () => 0,
    getAffinity: () => null,
    setAffinity: () => false,
    getPriorityClass: () => 0,
    setPriorityClass: () => false,
    createJobObject: () => (log.push("createJob"), options.job === undefined ? 500 : options.job),
    setKillOnClose: (job) => (log.push(`killOnClose ${job}`), options.killOnClose ?? true),
    assignProcessToJob: (job, process) => (log.push(`assign ${job} ${process}`), true),
  };
  return { api, log };
};

describe("holder script", () => {
  it("creates a kill-on-close job and assigns every pid read from stdin", () => {
    const script = buildJobHolderScript();
    console.info("[windows-lifetime:script] %d lines", script.split("\n").length);
    expect(script).toContain("CreateJobObjectW");
    expect(script).toContain("AssignProcessToJobObject");
    expect(script).toContain("WriteInt32($info, 16, 0x2800)"); // LimitFlags = KILL_ON_JOB_CLOSE | BREAKAWAY_OK (spawnSurvivor only)
    expect(script).toContain("SetInformationJobObject($job, 9, $info, 144)");
    expect(script).toContain("OpenProcess(0x1101,"); // assign (SET_QUOTA | TERMINATE) + QUERY_LIMITED_INFORMATION for the exit code
    expect(script).toContain("GetExitCodeProcess($proc, [ref]$code) -and ($code -ne 259)"); // STILL_ACTIVE
    expect(script).toContain('if ($err -eq 87) { Reply "exited $id" }'); // ERROR_INVALID_PARAMETER: no process has the pid
    // Progress records would reach the piped stderr as CLIXML (seen on Windows PowerShell 5.1: "Preparing modules for first use.").
    expect(script.split("\n").slice(0, 2)).toEqual(["$ErrorActionPreference = 'Stop'", "$ProgressPreference = 'SilentlyContinue'"]);
    expect(script).toContain("OpenStandardInput");
    expect(script).toMatch(/^'@$/m); // the here-string terminator sits at line start
    expect(script).toContain("ReadLine()");
  });
});

describe("holder answers", () => {
  it("parses every answer, with the Win32 error of a real failure", () => {
    const lines = ["assigned 12", "exited 13", "assign-failed 14 5", "open-failed 15 5", "ready", "assigned", "exited 1 2 3"];
    const parsed = lines.map(parseHolderAnswer);
    console.info("[windows-lifetime:answers]", JSON.stringify(parsed));
    expect(parsed).toEqual([
      { outcome: "assigned", pid: 12 },
      { outcome: "exited", pid: 13 },
      { outcome: "assign-failed", pid: 14, win32Error: 5 },
      { outcome: "open-failed", pid: 15, win32Error: 5 },
      null,
      null,
      null,
    ]);
  });
});

// Verbatim from the holder on a fr-FR Windows PowerShell 5.1 host (2026-11-13), accents as decoded there.
const PROGRESS_DOCUMENT =
  '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T><T>System.Object</T></TN><MS><I64 N="SourceId">1</I64><PR N="Record"><AV>Préparation des modules à la première utilisation.</AV><AI>0</AI><Nil /><PI>-1</PI><PC>-1</PC><T>Completed</T><SR>-1</SR><SD> </SD></PR></MS></Obj></Objs>';
const ERROR_DOCUMENT =
  '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><S S="Error">Add-Type : c:\\x.cs(3) : &lt;name&gt; &amp; _x0022_quoted_x0022__x000D__x000A_</S><S S="Error">    + FullyQualifiedErrorId : SOURCE_CODE_ERROR_x000D__x000A_</S></Objs>';

describe("holder stderr (CLIXML)", () => {
  it("decodes a progress record and an error record", () => {
    const progress = decodeClixmlDocument(PROGRESS_DOCUMENT);
    const error = decodeClixmlDocument(ERROR_DOCUMENT);
    console.info("[windows-lifetime:clixml]", JSON.stringify({ progress, error }));
    expect(progress).toEqual([{ kind: "progress", text: "Préparation des modules à la première utilisation." }]);
    expect(error).toEqual([{ kind: "error", text: 'Add-Type : c:\\x.cs(3) : <name> & "quoted"\r\n    + FullyQualifiedErrorId : SOURCE_CODE_ERROR' }]);
  });

  it("reassembles documents split across chunks, drops the CLIXML header, passes plain lines through", () => {
    const records: HolderStderrRecord[] = [];
    const reader = createHolderStderrReader((record) => records.push(record));
    const stream = `#< CLIXML\r\n${PROGRESS_DOCUMENT}${ERROR_DOCUMENT}SetInformationJobObject failed\r\n`;
    // The first chunk Node delivered on the Windows e2e host was "#< CLIXML" alone (logged then as the whole stderr).
    for (const chunk of ["#< CLIXML", stream.slice(9, 40), stream.slice(40, 300), stream.slice(300)]) reader.push(chunk);
    reader.push("CreateJobObjectW fai");
    reader.flush();
    console.info("[windows-lifetime:stderr-reader]", JSON.stringify(records));
    expect(records.map((record) => record.kind)).toEqual(["progress", "error", "error", "error"]);
    expect(records[2]).toEqual({ kind: "error", text: "SetInformationJobObject failed" });
    expect(records[3]).toEqual({ kind: "error", text: "CreateJobObjectW fai" });
  });

  it("a bare CLIXML header left at exit is not an error", () => {
    const records: HolderStderrRecord[] = [];
    const reader = createHolderStderrReader((record) => records.push(record));
    reader.push("#< CLIXML");
    reader.flush();
    expect(records).toEqual([]);
  });
});

describe("windows child lifetime (in-process job over bun:ffi)", () => {
  it("wrap is the identity", async () => {
    const lifetime = createWindowsChildLifetime({ loadApi: () => null, log: silent });
    expect(await lifetime.wrap("C:\\bun.exe", ["a.mjs"], { X: "1" })).toEqual({ command: "C:\\bun.exe", args: ["a.mjs"] });
  });

  it("creates ONE job on first use and assigns each pid to it", () => {
    const { api, log } = fakeApi();
    const lifetime = createWindowsChildLifetime({ loadApi: () => api, log: silent });
    lifetime.afterSpawn(11);
    lifetime.afterSpawn(12);
    console.info("[windows-lifetime:job] calls", log);
    expect(log.filter((line) => line === "createJob")).toHaveLength(1);
    expect(log.filter((line) => line.startsWith("killOnClose"))).toEqual(["killOnClose 500"]);
    expect(log).toContain("open 11 0x101");
    expect(log).toContain("assign 500 911");
    expect(log).toContain("assign 500 912");
    expect(log).toContain("close 911");
    expect(log).toContain("close 912");
    expect(log).not.toContain("close 500"); // the job lives as long as this process
  });

  it("adoptCurrentProcess puts THIS process in the kill-on-close job, creating the job first, and resolves true", async () => {
    const { api, log } = fakeApi();
    const lifetime = createWindowsChildLifetime({ loadApi: () => api, log: silent });
    expect(await lifetime.adoptCurrentProcess()).toBe(true);
    expect(log.indexOf("createJob")).toBeLessThan(log.indexOf(`assign 500 ${900 + process.pid}`));
    expect(log).toContain(`open ${process.pid} 0x101`);
    expect(log).not.toContain("close 500");
  });

  it("adoptCurrentProcess resolves false (and logs) when the job cannot be created or the assignment fails", async () => {
    const warnings: Array<Record<string, unknown>> = [];
    const warn = (level: "info" | "warn", event: Record<string, unknown>) => level === "warn" && warnings.push(event);
    expect(await createWindowsChildLifetime({ loadApi: () => fakeApi({ job: null }).api, log: warn }).adoptCurrentProcess()).toBe(false);
    expect(await createWindowsChildLifetime({ loadApi: () => fakeApi({ openFails: true }).api, log: warn }).adoptCurrentProcess()).toBe(false);
    expect(warnings.length).toBeGreaterThanOrEqual(2);
  });

  it("ignores an undefined pid (spawn failed) and never throws", () => {
    const { api, log } = fakeApi({ openFails: true });
    const warnings: Array<Record<string, unknown>> = [];
    const lifetime = createWindowsChildLifetime({ loadApi: () => api, log: (level, event) => level === "warn" && warnings.push(event) });
    lifetime.afterSpawn(undefined);
    expect(log).toEqual([]);
    expect(() => lifetime.afterSpawn(5)).not.toThrow();
    expect(warnings[0]).toMatchObject({ event: "child_lifetime.assign", pid: 5, ok: false, reason: "open-process-failed" });
  });

  it("supported() is true when the job can be created and false when it cannot", async () => {
    expect(await createWindowsChildLifetime({ loadApi: () => fakeApi().api, log: silent }).supported()).toBe(true);
    expect(await createWindowsChildLifetime({ loadApi: () => fakeApi({ job: null }).api, log: silent }).supported()).toBe(false);
    const noKill = fakeApi({ killOnClose: false });
    expect(await createWindowsChildLifetime({ loadApi: () => noKill.api, log: silent }).supported()).toBe(false);
    expect(noKill.log).toContain("close 500");
  });
});

type FakeHolder = HolderChild & { written: string[]; emitter: EventEmitter; stdout: EventEmitter };

const fakeHolder = (): FakeHolder => {
  const emitter = new EventEmitter();
  const written: string[] = [];
  const stream = () => Object.assign(new EventEmitter(), { setEncoding: () => {}, unref: () => {} });
  const stdin = Object.assign(new EventEmitter(), { write: (text: string) => (written.push(text), true), unref: () => {} });
  const holder = Object.assign(emitter, { stdin, stdout: stream(), stderr: stream(), unref: () => {}, pid: 4321, written, emitter });
  return holder as unknown as FakeHolder;
};

describe("windows child lifetime (PowerShell holder under Node / Electron)", () => {
  it("spawns ONE hidden holder with the job script and feeds it the pids", () => {
    const spawned: Array<{ command: string; args: string[] }> = [];
    const holder = fakeHolder();
    const lifetime = createWindowsChildLifetime({
      loadApi: () => null,
      spawnHolder: (command, args) => (spawned.push({ command, args }), holder),
      log: silent,
    });
    lifetime.afterSpawn(101);
    lifetime.afterSpawn(102);
    console.info("[windows-lifetime:holder] spawned", spawned.length, "wrote", holder.written);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.command).toMatch(/powershell\.exe$/);
    expect(decodePowerShellScript(spawned[0]!.args)).toBe(buildJobHolderScript());
    expect(holder.written).toEqual(["101\n", "102\n"]);
  });

  it("adoptCurrentProcess waits for the holder to confirm it assigned this process, then resolves true", async () => {
    const holder = fakeHolder();
    const lifetime = createWindowsChildLifetime({ loadApi: () => null, spawnHolder: () => holder, log: silent });
    let settled: boolean | null = null;
    const adopted = lifetime.adoptCurrentProcess().then((ok) => (settled = ok));
    expect(holder.written).toEqual([`${process.pid}\n`]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBeNull(); // not before the holder said so: spawns made now would escape the job
    holder.stdout.emit("data", "ready\n");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBeNull();
    holder.stdout.emit("data", `assigned ${process.pid}\n`);
    expect(await adopted).toBe(true);
  });

  it("adoptCurrentProcess resolves false when the holder refuses the assignment or exits first", async () => {
    const refusing = fakeHolder();
    const refused = createWindowsChildLifetime({ loadApi: () => null, spawnHolder: () => refusing, log: silent }).adoptCurrentProcess();
    refusing.stdout.emit("data", `assign-failed ${process.pid}\n`);
    expect(await refused).toBe(false);
    const dying = fakeHolder();
    const died = createWindowsChildLifetime({ loadApi: () => null, spawnHolder: () => dying, log: silent }).adoptCurrentProcess();
    dying.emitter.emit("exit", 1);
    expect(await died).toBe(false);
  });

  it("adoptCurrentProcess gives up, bounded, when the holder never answers", async () => {
    const holder = fakeHolder();
    const lifetime = createWindowsChildLifetime({ loadApi: () => null, spawnHolder: () => holder, log: silent, adoptTimeoutMs: 50 });
    expect(await lifetime.adoptCurrentProcess()).toBe(false);
  });

  it("restarts the holder after it exits", () => {
    const holders: FakeHolder[] = [];
    const lifetime = createWindowsChildLifetime({
      loadApi: () => null,
      spawnHolder: () => {
        const holder = fakeHolder();
        holders.push(holder);
        return holder;
      },
      log: silent,
    });
    lifetime.afterSpawn(1);
    holders[0]!.emitter.emit("exit", 1);
    lifetime.afterSpawn(2);
    expect(holders).toHaveLength(2);
    expect(holders[1]!.written).toEqual(["2\n"]);
  });

  it("supported() follows the PowerShell probe and logs the consequence when it fails", async () => {
    const warnings: string[] = [];
    const bad = createWindowsChildLifetime({ loadApi: () => null, probePowerShell: async () => false, log: (level, event) => level === "warn" && warnings.push(String(event.event)) });
    expect(await bad.supported()).toBe(false);
    expect(warnings).toEqual(["child_lifetime.supported"]);
    expect(await createWindowsChildLifetime({ loadApi: () => null, probePowerShell: async () => true, log: silent }).supported()).toBe(true);
  });

  it("a spawn error is logged, never thrown", () => {
    const lifetime = createWindowsChildLifetime({
      loadApi: () => null,
      spawnHolder: () => {
        throw new Error("ENOENT");
      },
      log: silent,
    });
    expect(() => lifetime.afterSpawn(3)).not.toThrow();
  });

  const recordingHolder = () => {
    const holder = fakeHolder();
    const logs: Array<{ level: string; event: Record<string, unknown> }> = [];
    const log: LifetimeLog = (level, event) => logs.push({ level, event });
    const lifetime = createWindowsChildLifetime({ loadApi: () => null, spawnHolder: () => holder, log });
    return { holder, logs, lifetime, stderr: holder.stderr as unknown as EventEmitter };
  };

  // @bugfix holder-clixml-and-exited-child (see childLifetime.holder.windows.test.ts)
  it("a child that exited before the holder reached it is info, a live child the job refused is a warning with its Win32 error", () => {
    const { holder, logs, lifetime } = recordingHolder();
    lifetime.afterSpawn(11);
    lifetime.afterSpawn(12);
    lifetime.afterSpawn(13);
    // answers split mid-line across chunks, as a pipe may deliver them
    for (const chunk of ["ready\r\nexited 1", "1\r\nassigned 12\r", "\nassign-failed 13 5\r\n"]) holder.stdout.emit("data", chunk);
    console.info("[windows-lifetime:answers-logged]", JSON.stringify(logs));
    expect(logs).toEqual([
      { level: "info", event: { event: "child_lifetime.holder", line: "ready" } },
      { level: "info", event: { event: "child_lifetime.assign", mode: "powershell-holder", pid: 11, ok: false, reason: "child-exited-before-assignment" } },
      { level: "info", event: { event: "child_lifetime.assign", mode: "powershell-holder", pid: 12, ok: true } },
      {
        level: "warn",
        event: { event: "child_lifetime.assign", mode: "powershell-holder", pid: 13, ok: false, reason: "assign-failed", win32Error: 5, effect: "this child can outlive a killed parent" },
      },
    ]);
  });

  it("CLIXML progress on stderr is info; a real error on stderr stays a warning, decoded", () => {
    const { logs, lifetime, stderr } = recordingHolder();
    lifetime.afterSpawn(21);
    stderr.emit("data", "#< CLIXML");
    stderr.emit("data", `\r\n${PROGRESS_DOCUMENT}`);
    stderr.emit("data", ERROR_DOCUMENT);
    console.info("[windows-lifetime:stderr-logged]", JSON.stringify(logs));
    expect(logs).toEqual([
      { level: "info", event: { event: "child_lifetime.holder", progress: "Préparation des modules à la première utilisation." } },
      { level: "warn", event: { event: "child_lifetime.holder", stderr: 'Add-Type : c:\\x.cs(3) : <name> & "quoted"\r\n    + FullyQualifiedErrorId : SOURCE_CODE_ERROR' } },
    ]);
  });

  it("a long stderr error keeps its tail, where PowerShell puts the message after echoing the whole script", () => {
    const { logs, lifetime, stderr } = recordingHolder();
    lifetime.afterSpawn(22);
    const echoedScript = "x".repeat(5000);
    stderr.emit("data", `#< CLIXML\r\n<Objs Version="1.1.0.1"><S S="Error">${echoedScript} : sf-deliberate-failure_x000D__x000A_</S></Objs>`);
    const logged = String(logs[0]?.event.stderr);
    console.info("[windows-lifetime:stderr-tail]", logged.length, logged.slice(-60));
    expect(logs[0]?.level).toBe("warn");
    expect(logged.length).toBe(2001);
    expect(logged.startsWith("…")).toBe(true);
    expect(logged.endsWith(" : sf-deliberate-failure")).toBe(true);
  });

  it("an adopt answered `exited` resolves false", async () => {
    const { holder, lifetime } = recordingHolder();
    const adopted = lifetime.adoptCurrentProcess();
    holder.stdout.emit("data", `exited ${process.pid}\n`);
    expect(await adopted).toBe(false);
  });
});

describe("survivor command line", () => {
  it("quotes each argument as CommandLineToArgvW parses it back", () => {
    const cases: Array<[string, string]> = [
      ["plain", "plain"],
      ["C:\\Program Files\\node\\node.exe", '"C:\\Program Files\\node\\node.exe"'],
      ["", '""'],
      ['say "hi"', '"say \\"hi\\""'],
      ["C:\\dir with space\\", '"C:\\dir with space\\\\"'],
      ['a\\"b c', '"a\\\\\\"b c"'],
      ["no\\trailing\\quote\\", "no\\trailing\\quote\\"],
    ];
    for (const [arg, expected] of cases) {
      console.info("[windows-lifetime:quote] %s -> %s", JSON.stringify(arg), quoteWindowsArgument(arg));
      expect(quoteWindowsArgument(arg)).toBe(expected);
    }
  });

  it("the launcher asks for breakaway first, retries inside the job only on ERROR_ACCESS_DENIED, and inherits no handle", () => {
    const commandLine = '"C:\\sf\\node.exe" -e "require(\\"x\\")" é';
    const script = buildSurvivorLauncherScript(commandLine);
    console.info("[windows-lifetime:survivor-script] %d lines", script.split("\n").length);
    expect(script.split("\n").slice(0, 2)).toEqual(["$ErrorActionPreference = 'Stop'", "$ProgressPreference = 'SilentlyContinue'"]);
    // CREATE_BREAKAWAY_FROM_JOB | CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP, then without the breakaway
    expect(script).toContain("[SfSurvivor]::Start($commandLine, 0x9000200, [ref]$err)");
    expect(script).toContain("[SfSurvivor]::Start($commandLine, 0x8000200, [ref]$err)");
    expect(script).toContain("if ($err -ne 5) {");
    expect(script).toContain("IntPtr.Zero, IntPtr.Zero, false, flags");
    const encoded = /FromBase64String\('([^']+)'\)/.exec(script)![1]!;
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(commandLine);
    expect(script).toMatch(/^'@$/m);
  });
});

describe("windows child lifetime spawnSurvivor", () => {
  const launcher = (stdout: string, extra: Partial<PowerShellResult> = {}) => {
    const calls: Array<{ script: string; timeoutMs: number; env: Record<string, string | undefined> }> = [];
    const logs: Array<{ level: string; event: Record<string, unknown> }> = [];
    const lifetime = createWindowsChildLifetime({
      loadApi: () => null,
      runPowerShellSync: (script, timeoutMs, env) => (calls.push({ script, timeoutMs, env }), { ok: true, stdout, stderr: "", ...extra }),
      log: (level, event) => logs.push({ level, event }),
    });
    return { lifetime, calls, logs };
  };

  it("returns the pid of a process started outside the job, logged at info, with the given environment", () => {
    const { lifetime, calls, logs } = launcher("started 4242 breakaway\r\n");
    const env = { PATH: "C:\\x", SF_COMPOSE_DOWN_LOG: "C:\\t\\p.log" };
    const pid = lifetime.spawnSurvivor("C:\\Program Files\\node.exe", ["-e", 'console.log("x")'], env);
    console.info("[windows-lifetime:survivor] pid=%s logs=%s", pid, JSON.stringify(logs));
    expect(pid).toBe(4242);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.env).toBe(env);
    expect(calls[0]!.script).toBe(buildSurvivorLauncherScript('"C:\\Program Files\\node.exe" -e "console.log(\\"x\\")"'));
    expect(logs).toEqual([{ level: "info", event: { event: "child_lifetime.survivor", pid: 4242, command: "C:\\Program Files\\node.exe", outsideJob: true } }]);
  });

  it("an enclosing job that refuses breakaway still starts the process, and says at warn it is tied to that job", () => {
    const { lifetime, logs } = launcher("started 77 in-job 5\n");
    expect(lifetime.spawnSurvivor("node", [], {})).toBe(77);
    console.info("[windows-lifetime:survivor-in-job]", JSON.stringify(logs));
    expect(logs).toHaveLength(1);
    expect(logs[0]!.level).toBe("warn");
    expect(logs[0]!.event).toMatchObject({ event: "child_lifetime.survivor", pid: 77, outsideJob: false, win32Error: 5 });
  });

  it("a failed start returns null and logs the Win32 error, the launcher error and the stderr tail", () => {
    const failed = launcher("failed 2\n");
    expect(failed.lifetime.spawnSurvivor("missing.exe", [], {})).toBeNull();
    expect(failed.logs[0]).toEqual({ level: "warn", event: { event: "child_lifetime.survivor", pid: null, command: "missing.exe", win32Error: 2, launcher: null, stderr: "" } });

    const crashed = launcher("", { ok: false, stderr: "Add-Type : boom\n", error: "timed out" });
    expect(crashed.lifetime.spawnSurvivor("node", [], {})).toBeNull();
    console.info("[windows-lifetime:survivor-failed]", JSON.stringify([failed.logs, crashed.logs]));
    expect(crashed.logs[0]).toEqual({ level: "warn", event: { event: "child_lifetime.survivor", pid: null, command: "node", win32Error: null, launcher: "timed out", stderr: "Add-Type : boom" } });
  });
});
