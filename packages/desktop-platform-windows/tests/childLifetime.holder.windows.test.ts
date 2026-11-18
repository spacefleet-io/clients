import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * The Electron / Node path of childLifetime: no `bun:ffi`, so one PowerShell
 * holder owns a KILL_ON_JOB_CLOSE job. Forced here by `loadApi: () => null`
 * (the helper runs under `bun` so it can import the TypeScript source).
 * Needs a real Windows host (the Linux CI skips it).
 */
const dir = mkdtempSync(join(tmpdir(), "sf-lifetime-holder-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitFor = async (check: () => boolean, timeoutMs: number, what: string) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
};

describe.skipIf(process.platform !== "win32")("windows childLifetime, PowerShell holder mode", () => {
  it("a child dies when the parent that spawned it is killed", async () => {
    const module = fileURLToPath(new URL("../src/childLifetime.ts", import.meta.url));
    const heartbeat = join(dir, "heartbeat.mjs");
    writeFileSync(heartbeat, `setInterval(() => {}, 1000);\n`);
    const parent = join(dir, "parent.mjs");
    writeFileSync(
      parent,
      `
import { spawn } from "node:child_process";
const { createWindowsChildLifetime } = await import(${JSON.stringify(pathToFileURL(module).href)});
const lifetime = createWindowsChildLifetime({
  loadApi: () => null,
  log: (level, event) => console.log("log " + level + " " + JSON.stringify(event)),
});
console.log("supported " + (await lifetime.supported()));
const child = spawn("bun", [${JSON.stringify(heartbeat)}], { stdio: "ignore" });
lifetime.afterSpawn(child.pid);
console.log("child " + child.pid);
setInterval(() => {}, 1000);
`
    );
    const helper = spawn("bun", [parent], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    helper.stdout.on("data", (chunk) => (out += String(chunk)));
    helper.stderr.on("data", (chunk) => (out += String(chunk)));
    try {
      await waitFor(() => /child \d+/.test(out), 30_000, "the parent to report its child");
      const childPid = Number(/child (\d+)/.exec(out)![1]);
      console.info(`[lifetime-holder] child ${childPid}; parent output so far:\n${out}`);
      // The holder assigns asynchronously: wait for its confirmation before killing the parent.
      await waitFor(() => out.includes(`"event":"child_lifetime.assign","mode":"powershell-holder","pid":${childPid},"ok":true`), 30_000, "the holder to confirm the assignment");
      expect(alive(childPid)).toBe(true);
      process.kill(helper.pid!, "SIGKILL");
      await waitFor(() => !alive(childPid), 15_000, "the child to die with its parent");
    } catch (error) {
      console.error(`[lifetime-holder] failed; helper output:\n${out}`);
      throw error;
    } finally {
      helper.kill();
    }
  }, 90_000);

  it("a process that adopted itself (the Node harness case) takes a grandchild with it when killed", async () => {
    const module = fileURLToPath(new URL("../src/childLifetime.ts", import.meta.url));
    const heartbeat = join(dir, "heartbeat-adopt.mjs");
    writeFileSync(heartbeat, `setInterval(() => {}, 1000);\n`);
    // mid: what a launcher does, spawns the app, which here is the grandchild
    const mid = join(dir, "mid.mjs");
    writeFileSync(
      mid,
      `
import { spawn } from "node:child_process";
const grandchild = spawn("bun", [${JSON.stringify(heartbeat)}], { stdio: "ignore" });
console.log("grandchild " + grandchild.pid);
setInterval(() => {}, 1000);
`
    );
    const parent = join(dir, "adopter.mjs");
    writeFileSync(
      parent,
      `
import { spawn } from "node:child_process";
const { createWindowsChildLifetime } = await import(${JSON.stringify(pathToFileURL(module).href)});
const lifetime = createWindowsChildLifetime({
  loadApi: () => null,
  log: (level, event) => console.log("log " + level + " " + JSON.stringify(event)),
});
const adopted = await lifetime.adoptCurrentProcess();
console.log("adopted " + adopted);
if (adopted) spawn("bun", [${JSON.stringify(mid)}], { stdio: ["ignore", "inherit", "inherit"] });
setInterval(() => {}, 1000);
`
    );
    const helper = spawn("bun", [parent], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    helper.stdout.on("data", (chunk) => (out += String(chunk)));
    helper.stderr.on("data", (chunk) => (out += String(chunk)));
    try {
      await waitFor(() => out.includes("adopted "), 60_000, "the adopter to report");
      expect(out).toContain("adopted true");
      await waitFor(() => /grandchild \d+/.test(out), 30_000, "the mid process to report its child");
      const grandchild = Number(/grandchild (\d+)/.exec(out)![1]);
      expect(alive(grandchild)).toBe(true);
      process.kill(helper.pid!, "SIGKILL");
      await waitFor(() => !alive(grandchild), 15_000, "the grandchild to die with the adopter");
    } catch (error) {
      console.error(`[lifetime-holder] adopt failed; helper output:\n${out}`);
      throw error;
    } finally {
      helper.kill();
    }
  }, 120_000);

  // @bugfix holder-clixml-and-exited-child: a cold holder (PowerShell start + Add-Type) used to write a CLIXML progress
  // record ("#< CLIXML") to stderr, logged at warn, and answer a child that had already exited (the preload's ffprobe on
  // a drop) with open-failed / assign-failed, also at warn: six Badger dd-* e2e failed their console check on Windows.
  it("a child that exited before the holder reached it is reported at info, and a cold holder writes nothing to stderr", async () => {
    const module = fileURLToPath(new URL("../src/childLifetime.ts", import.meta.url));
    const win32 = fileURLToPath(new URL("../src/win32api.ts", import.meta.url));
    const parent = join(dir, "exited.mjs");
    writeFileSync(
      parent,
      `
import { spawn } from "node:child_process";
const { createWindowsChildLifetime } = await import(${JSON.stringify(pathToFileURL(module).href)});
const { loadWin32Api, PROCESS_QUERY_LIMITED_INFORMATION } = await import(${JSON.stringify(pathToFileURL(win32).href)});
const api = loadWin32Api();
const lifetime = createWindowsChildLifetime({
  loadApi: () => null,
  log: (level, event) => console.log("log " + level + " " + JSON.stringify(event)),
});
// held: this process keeps a handle on the dead child (what a parent does until it reaps it), so OpenProcess succeeds
// and AssignProcessToJobObject fails with ERROR_ACCESS_DENIED. Not held: no process has the pid, OpenProcess fails with 87.
const run = (held) => {
  const { promise, resolve } = Promise.withResolvers();
  const child = spawn("bun", ["-e", ""], { stdio: "ignore" });
  const handle = held ? api.openProcess(child.pid, PROCESS_QUERY_LIMITED_INFORMATION) : null;
  console.log("spawned " + child.pid + " held=" + (handle !== null));
  child.on("exit", (code) => resolve({ pid: child.pid, code }));
  return promise;
};
const gone = await run(false);
const held = await run(true);
console.log("exited " + JSON.stringify({ gone, held }));
lifetime.afterSpawn(gone.pid);
lifetime.afterSpawn(held.pid);
console.log("pids " + gone.pid + " " + held.pid);
setInterval(() => {}, 1000);
`
    );
    const helper = spawn("bun", [parent], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    helper.stdout.on("data", (chunk) => (out += String(chunk)));
    helper.stderr.on("data", (chunk) => (out += String(chunk)));
    const exitedLine = (pid: number) => `"event":"child_lifetime.assign","mode":"powershell-holder","pid":${pid},"ok":false,"reason":"child-exited-before-assignment"`;
    try {
      await waitFor(() => /pids \d+ \d+/.test(out), 30_000, "the helper to report its exited children");
      const [, gone, held] = /pids (\d+) (\d+)/.exec(out)!.map(Number);
      console.info(`[lifetime-holder:exited] gone=${gone} held=${held}`);
      await waitFor(() => out.includes(exitedLine(gone!)) && out.includes(exitedLine(held!)), 60_000, "the holder to answer both pids");
      console.info(`[lifetime-holder:exited] helper output:\n${out}`);
      expect(out).toContain(`log info {${exitedLine(gone!)}}`);
      expect(out).toContain(`log info {${exitedLine(held!)}}`);
      expect(out).toContain('log info {"event":"child_lifetime.holder","line":"ready"}');
      expect(out).not.toContain("log warn");
      expect(out).not.toContain("CLIXML");
    } catch (error) {
      console.error(`[lifetime-holder:exited] failed; helper output:\n${out}`);
      throw error;
    } finally {
      helper.kill();
    }
  }, 120_000);

  // @bugfix compose-down-breakaway: the e2e harness adopts itself into the kill-on-close job, then starts
  // `docker compose down` from its exit handler. A plain detached spawn was a member of the job and died with the
  // worker, so the compose project leaked its fixed ports (seen on a Windows test machine). spawnSurvivor must outlive the adopter
  // while an ordinary child still dies with it.
  it("spawnSurvivor outlives a killed adopter, while its ordinary child dies with it", async () => {
    const module = fileURLToPath(new URL("../src/childLifetime.ts", import.meta.url));
    const heartbeat = join(dir, "heartbeat-survivor.mjs");
    writeFileSync(heartbeat, `setInterval(() => {}, 1000);\n`);
    const parent = join(dir, "survivor-adopter.mjs");
    writeFileSync(
      parent,
      `
import { spawn } from "node:child_process";
const { createWindowsChildLifetime } = await import(${JSON.stringify(pathToFileURL(module).href)});
const lifetime = createWindowsChildLifetime({
  loadApi: () => null,
  log: (level, event) => console.log("log " + level + " " + JSON.stringify(event)),
});
const adopted = await lifetime.adoptCurrentProcess();
console.log("adopted " + adopted);
const plain = spawn(process.execPath, [${JSON.stringify(heartbeat)}], { stdio: "ignore", detached: true });
const survivor = lifetime.spawnSurvivor(process.execPath, [${JSON.stringify(heartbeat)}], process.env);
console.log("pids " + plain.pid + " " + survivor);
setInterval(() => {}, 1000);
`
    );
    const helper = spawn("bun", [parent], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    helper.stdout.on("data", (chunk) => (out += String(chunk)));
    helper.stderr.on("data", (chunk) => (out += String(chunk)));
    let survivor = 0;
    try {
      await waitFor(() => /pids \d+ (\d+|null)/.test(out), 90_000, "the adopter to report its two children");
      console.info(`[lifetime-holder:survivor] helper output so far:\n${out}`);
      expect(out).toContain("adopted true");
      const [, plainText, survivorText] = /pids (\d+) (\d+|null)/.exec(out)!;
      const plain = Number(plainText);
      expect(survivorText).not.toBe("null");
      survivor = Number(survivorText);
      expect(out).toContain(`log info {"event":"child_lifetime.survivor","pid":${survivor},`);
      expect(out).toContain('"outsideJob":true');
      expect(out).not.toContain("log warn");
      expect(alive(plain)).toBe(true);
      expect(alive(survivor)).toBe(true);
      console.info(`[lifetime-holder:survivor] killing adopter ${helper.pid}; plain=${plain} survivor=${survivor}`);
      process.kill(helper.pid!, "SIGKILL");
      await waitFor(() => !alive(plain), 15_000, "the ordinary child to die with the adopter");
      // the job closed when the plain child died: the survivor, outside it, must still be running
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      console.info(`[lifetime-holder:survivor] after kill: plain alive=${alive(plain)} survivor alive=${alive(survivor)}`);
      expect(alive(survivor)).toBe(true);
    } catch (error) {
      console.error(`[lifetime-holder:survivor] failed; helper output:\n${out}`);
      throw error;
    } finally {
      helper.kill();
      if (survivor > 0 && alive(survivor)) process.kill(survivor, "SIGKILL");
    }
  }, 150_000);
});
