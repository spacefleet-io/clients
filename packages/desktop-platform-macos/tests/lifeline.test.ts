import { spawn, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMacosProcesses } from "../src/processes";
import { buildLifeline } from "./lifelineBuild";

const isMac = process.platform === "darwin";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Polls real OS process state (no event exists for "another process exited"); returns the elapsed ms, or null on timeout. */
const waitUntil = async (condition: () => boolean, timeoutMs: number) => {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) return null;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return Date.now() - start;
};

describe.skipIf(!isMac)("sf-lifeline (native/sf-lifeline.c)", () => {
  let lifeline: string;
  beforeAll(() => {
    lifeline = buildLifeline();
  });
  afterAll(() => rmSync(dirname(lifeline), { recursive: true, force: true }));

  // @req RT-LIFE-06[runtime]
  it("SIGKILLs the command within 1 s of its parent being SIGKILLed, and the watchdog exits with it", async () => {
    // A bash parent spawns `sf-lifeline <its pid> -- sleep 60` and reports the child's pid, then is SIGKILLed.
    const parent = spawn("/bin/bash", ["-c", `"$1" $$ -- /bin/sleep 60 & echo $!; wait`, "parent", lifeline], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    const childPid = await new Promise<number>((resolve) => parent.stdout.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim()))));
    // The command runs in place of the helper: the spawned pid IS the program (same pid, its own command line).
    await waitUntil(() => (spawnSync("/bin/ps", ["-o", "command=", "-p", String(childPid)], { encoding: "utf8" }).stdout ?? "").startsWith("/bin/sleep"), 2_000);
    const command = spawnSync("/bin/ps", ["-o", "command=", "-p", String(childPid)], { encoding: "utf8" }).stdout.trim();
    const watchdogs = () =>
      spawnSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" })
        .stdout.split("\n")
        .filter((line) => line.includes(`sf-lifeline --watch ${parent.pid} ${childPid}`));
    await waitUntil(() => watchdogs().length === 1, 2_000);
    console.info(`[sf-lifeline] parent=${parent.pid} child=${childPid} command="${command}" watchdogs=${JSON.stringify(watchdogs())}`);
    expect(command).toBe("/bin/sleep 60");
    expect(watchdogs()).toHaveLength(1);

    process.kill(parent.pid!, "SIGKILL");
    const diedAfterMs = await waitUntil(() => !alive(childPid), 1_000);
    console.info(`[sf-lifeline] child ${childPid} died ${diedAfterMs ?? ">1000"} ms after its parent's SIGKILL`);
    if (diedAfterMs === null) process.kill(childPid, "SIGKILL");
    expect(diedAfterMs).not.toBeNull();
    expect(await waitUntil(() => watchdogs().length === 0, 1_000)).not.toBeNull();
  });

  // @req RT-LIFE-06[runtime]
  it("passes stdin, stdout and stderr through and returns the command's exit status", () => {
    const echo = spawnSync(lifeline, [String(process.pid), "--", "/bin/sh", "-c", 'read line; echo "out:$line"; echo "err:$line" >&2; exit 7'], {
      input: "hello\n",
      encoding: "utf8",
    });
    console.info(`[sf-lifeline] status=${echo.status} stdout=${JSON.stringify(echo.stdout)} stderr=${JSON.stringify(echo.stderr)}`);
    expect(echo.stdout).toBe("out:hello\n");
    expect(echo.stderr).toBe("err:hello\n");
    expect(echo.status).toBe(7);

    const signalled = spawnSync(lifeline, [String(process.pid), "--", "/bin/sh", "-c", "kill -TERM $$"], { encoding: "utf8" });
    expect(signalled.signal).toBe("SIGTERM");
  });

  // @req RT-LIFE-06[runtime]
  it("exits 125 without running the command when its parent is not the expected pid (died before arming)", () => {
    // Parent pid 1 (launchd) is never this test's process: the same state as a spawner that died before the helper ran.
    const res = spawnSync(lifeline, ["1", "--", "/bin/sh", "-c", "echo ran"], { encoding: "utf8" });
    console.info(`[sf-lifeline] dead-parent status=${res.status} stderr=${res.stderr.trim()}`);
    expect(res.status).toBe(125);
    expect(res.stdout).toBe("");
  });

  it("reports usage errors as 125 and a missing command as 127", () => {
    expect(spawnSync(lifeline, [], { encoding: "utf8" }).status).toBe(125);
    expect(spawnSync(lifeline, [String(process.pid), "sleep", "1"], { encoding: "utf8" }).status).toBe(125);
    expect(spawnSync(lifeline, [String(process.pid), "--", "/nonexistent/sf-command"], { encoding: "utf8" }).status).toBe(127);
  });

  it("closes descriptors above 2 that the parent leaked before the command runs", () => {
    // fd 3 is a pipe the parent passes on purpose; the command must not see it (Electron's DevTools-port leak).
    const res = spawnSync(lifeline, [String(process.pid), "--", "/bin/bash", "-c", "(: >&3) 2>/dev/null && echo held || echo none"], {
      stdio: ["ignore", "pipe", "pipe", "pipe"],
      encoding: "utf8",
    });
    expect(res.stdout.trim()).toBe("none");
  });
});

describe.skipIf(!isMac)("childLifetime through sf-lifeline", () => {
  let lifeline: string;
  beforeAll(() => {
    lifeline = buildLifeline();
  });
  afterAll(() => rmSync(dirname(lifeline), { recursive: true, force: true }));

  it("wraps a resolvable command as `sf-lifeline <this pid> -- <absolute command> args` and reports support", async () => {
    const events: string[] = [];
    const layer = createMacosProcesses({ locateLifeline: () => lifeline, log: (_level, event) => events.push(String(event.mode)) });
    expect(await layer.childLifetime.supported()).toBe(true);
    expect(await layer.childLifetime.wrap("sh", ["-c", "true"], { PATH: "/bin" })).toEqual({
      command: lifeline,
      args: [String(process.pid), "--", "/bin/sh", "-c", "true"],
    });
    expect(await layer.childLifetime.adoptCurrentProcess()).toBe(false);
    expect(events).toEqual(["sf-lifeline"]);
  });

  it("without the helper: unsupported, one warning, and only the inherited-fd prelude is applied", async () => {
    const events: string[] = [];
    const layer = createMacosProcesses({ locateLifeline: () => null, log: (level, event) => events.push(`${level}:${String(event.reason)}`) });
    expect(await layer.childLifetime.supported()).toBe(false);
    const wrapped = await layer.childLifetime.wrap("sh", ["-c", "true"], { PATH: "/bin" });
    expect(wrapped.command).toBe("/bin/bash");
    expect(wrapped.args.slice(-3)).toEqual(["/bin/sh", "-c", "true"]);
    expect(events).toEqual(["warn:sf-lifeline-not-found"]);
  });

  it("returns an unresolvable command unwrapped so the spawn fails with ENOENT", async () => {
    const layer = createMacosProcesses({ locateLifeline: () => lifeline, log: () => {} });
    expect(await layer.childLifetime.wrap("sf-no-such-command", ["x"], { PATH: "/bin" })).toEqual({ command: "sf-no-such-command", args: ["x"] });
  });
});
