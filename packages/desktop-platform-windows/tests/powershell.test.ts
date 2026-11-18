import { describe, expect, it } from "vitest";
import { buildCommandLineScript, createWindowsProcesses, parseCommandLineOutput } from "../src/processes";
import { buildPowerShellArgs, decodePowerShellScript, powershellExecutable, validPid } from "../src/powershell";

describe("powershell argv", () => {
  it("passes the script as a base64 UTF-16LE -EncodedCommand that round-trips", () => {
    const script = 'Write-Output "héllo \'quoted\' ✓"\n$x = 1';
    const args = buildPowerShellArgs(script);
    console.info("[windows-powershell:args]", args.slice(0, -1));
    expect(args.slice(0, 6)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
    expect(args).toHaveLength(7);
    expect(decodePowerShellScript(args)).toBe(script);
    expect(decodePowerShellScript(["-NoProfile"])).toBeNull();
  });

  it("finds powershell.exe under SystemRoot (any key case), else on PATH", () => {
    expect(powershellExecutable({ SystemRoot: "C:\\Windows" })).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(powershellExecutable({ SYSTEMROOT: "D:\\Win" })).toBe("D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(powershellExecutable({})).toBe("powershell.exe");
  });

  it("validPid accepts only positive safe integers", () => {
    expect(validPid(1)).toBe(1);
    expect(validPid(2 ** 22 - 7)).toBe(2 ** 22 - 7);
    for (const bad of [0, -3, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(validPid(bad)).toBeNull();
  });
});

describe("command line reader", () => {
  it("builds a CIM query for exactly that pid", () => {
    const script = buildCommandLineScript(4242);
    expect(script).toContain("Get-CimInstance Win32_Process");
    expect(script).toContain('-Filter "ProcessId=4242"');
  });

  it("parses output: trimmed text, null for empty or failed runs", () => {
    expect(parseCommandLineOutput({ ok: true, stdout: '  "C:\\bun.exe" run x.mjs \r\n', stderr: "" })).toBe('"C:\\bun.exe" run x.mjs');
    expect(parseCommandLineOutput({ ok: true, stdout: "\r\n", stderr: "" })).toBeNull();
    expect(parseCommandLineOutput({ ok: false, stdout: "partial", stderr: "boom", error: "exit 1" })).toBeNull();
  });

  it("readCommandLine(Sync) runs the script with a bounded timeout and returns null for invalid pids without running", async () => {
    const seen: Array<{ script: string; timeoutMs: number; mode: string }> = [];
    const processes = createWindowsProcesses({
      runSync: (script, timeoutMs) => (seen.push({ script, timeoutMs, mode: "sync" }), { ok: true, stdout: "mpv.exe --idle\n", stderr: "" }),
      run: async (script, timeoutMs) => (seen.push({ script, timeoutMs, mode: "async" }), { ok: true, stdout: "", stderr: "" }),
    });
    expect(processes.readCommandLineSync(99)).toBe("mpv.exe --idle");
    expect(await processes.readCommandLine(99)).toBeNull();
    expect(processes.readCommandLineSync(-1)).toBeNull();
    expect(await processes.readCommandLine(0)).toBeNull();
    console.info("[windows-powershell:readCommandLine] runs", seen.map((s) => `${s.mode}:${s.timeoutMs}`));
    expect(seen.map((s) => s.mode)).toEqual(["sync", "async"]);
    for (const run of seen) {
      expect(run.timeoutMs).toBeGreaterThanOrEqual(10_000);
      expect(run.timeoutMs).toBeLessThanOrEqual(60_000);
    }
  });

  it("static members: detached + windowsHide, [pid] threads, no pid namespace", () => {
    const processes = createWindowsProcesses();
    expect(processes.spawnOptions({ detached: true })).toEqual({ detached: true, windowsHide: true });
    expect(processes.spawnOptions({ detached: false })).toEqual({ detached: false, windowsHide: true });
    expect(processes.listThreadIds(77)).toEqual([77]);
    expect(processes.ownPidNamespace()).toBeNull();
    expect(processes.control.name).toBe("windows");
  });
});
