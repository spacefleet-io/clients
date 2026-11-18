import { describe, expect, it } from "vitest";
import { buildPortHoldersScript, buildProcessScript, createWindowsDiagnostics } from "../src/diagnostics";

const ok = async (value: unknown) => ({ ok: true, stdout: JSON.stringify(value), stderr: "" });
const fail = async () => ({ ok: false, stdout: "", stderr: "x", error: "exit 1" });
const mustNotRun = async (): Promise<never> => {
  throw new Error("must not run");
};

describe("windows diagnostics scripts", () => {
  it("embed the pid / port as plain numbers", () => {
    expect(buildProcessScript(123)).toContain("Get-Process -Id 123");
    expect(buildProcessScript(123)).toContain('ProcessId=123"');
    expect(buildPortHoldersScript(8080)).toContain("Get-NetTCPConnection -State Listen -LocalPort 8080");
  });
});

describe("windows diagnostics.readProcess", () => {
  it("shapes a live process like the Linux dump and measures CPU between two dumps", async () => {
    let now = 1_000_000;
    let cpu = 10;
    const diagnostics = createWindowsDiagnostics({
      now: () => now,
      run: () =>
        ok({ alive: true, responding: true, cpuSeconds: cpu, workingSetBytes: 200 * 1024 * 1024, handles: 300, threads: 12, parentPid: 4, threadStates: { Wait: 11, Running: 1 }, nonWaitingThreads: "55:Running" }),
    });
    const first = await diagnostics.readProcess(55);
    console.info("[windows-diagnostics:first]", first);
    expect(first).toMatchObject({ platform: "windows", pid: 55, alive: true, state: "running", cpuSecondsTotal: 10, rssMb: 200, handles: 300, threads: 12, parentPid: 4 });
    expect(first.nonSleepingThreads).toEqual(["55:Running"]);
    expect(first.cpuPctSincePrev).toBeUndefined();
    now += 2000;
    cpu += 1;
    const second = await diagnostics.readProcess(55);
    expect(second).toMatchObject({ cpuPctSincePrev: 50, msSincePrev: 2000, cpuSecondsTotal: 11 });
  });

  it("reports a missing process as not alive and flags a hung window", async () => {
    expect(await createWindowsDiagnostics({ run: () => ok({ alive: false }) }).readProcess(9)).toEqual({ platform: "windows", pid: 9, alive: false });
    expect((await createWindowsDiagnostics({ run: () => ok({ alive: true, responding: false }) }).readProcess(9)).state).toBe("not-responding");
  });

  it("still names the platform when PowerShell fails or the pid is nonsense", async () => {
    expect(await createWindowsDiagnostics({ run: fail }).readProcess(9)).toMatchObject({ platform: "windows", pid: 9, error: expect.any(String) });
    const never = createWindowsDiagnostics({ run: mustNotRun });
    expect(await never.readProcess(-1)).toEqual({ platform: "windows", pid: -1, alive: false });
  });
});

describe("windows diagnostics.readPortHolders", () => {
  it("returns the Linux shape with holders from the TCP table", async () => {
    const diagnostics = createWindowsDiagnostics({
      run: () => ok({ listening: true, holders: { pid: 1234, comm: "bun.exe", cmdline: "x".repeat(400) } }),
    });
    const out = await diagnostics.readPortHolders(8080);
    expect(out).toMatchObject({ platform: "windows", port: 8080, listening: true, inodes: [] });
    const holders = out.holders as Array<{ pid: number; comm: string; cmdline: string }>;
    expect(holders).toHaveLength(1);
    expect(holders[0]).toMatchObject({ pid: 1234, comm: "bun.exe" });
    expect(holders[0]?.cmdline).toHaveLength(300);
  });

  it("nobody listening, failed query and bad port are best-effort objects", async () => {
    expect(await createWindowsDiagnostics({ run: () => ok({ listening: false, holders: [] }) }).readPortHolders(1)).toEqual({ platform: "windows", port: 1, listening: false, inodes: [], holders: [] });
    expect(await createWindowsDiagnostics({ run: fail }).readPortHolders(1)).toMatchObject({ platform: "windows", listening: false, error: expect.any(String) });
    expect(await createWindowsDiagnostics({ run: mustNotRun }).readPortHolders(70_000)).toMatchObject({ platform: "windows", holders: [] });
  });

  it("@regression-proof does not block the event loop while PowerShell runs (#928)", async () => {
    let finish!: () => void;
    const diagnostics = createWindowsDiagnostics({
      run: () =>
        new Promise((resolve) => {
          finish = () => resolve({ ok: true, stdout: JSON.stringify({ alive: false }), stderr: "" });
        }),
    });
    let settled = false;
    const pending = diagnostics.readProcess(9).then((out) => {
      settled = true;
      return out;
    });
    // A macrotask still runs while the read is outstanding: the caller's loop keeps turning.
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    finish();
    expect(await pending).toEqual({ platform: "windows", pid: 9, alive: false });
  });
});
