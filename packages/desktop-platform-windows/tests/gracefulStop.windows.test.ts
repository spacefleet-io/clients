import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createWindowsGracefulStop } from "../src/gracefulStop";
import { runPowerShellSync } from "../src/powershell";

/**
 * Real named pipes: need a Windows host (the Linux CI skips them). The pipe
 * server needs `bun:ffi` and vitest's workers run under Node, so each server
 * runs in a `bun` helper process and this test is the client / inspector.
 */
const scratch = mkdtempSync(join(tmpdir(), "sf-stop-pipe-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
// Markers go to the scratch dir (a killed helper cannot clean up), never to the real %LOCALAPPDATA%.
const markerDir = join(scratch, "markers");
const windowsGracefulStop = createWindowsGracefulStop({ markerDir: () => markerDir });
const helperStop = `createWindowsGracefulStop({ markerDir: () => ${JSON.stringify(markerDir)} })`;

const sourceUrl = (file: string) => pathToFileURL(fileURLToPath(new URL(`../src/${file}`, import.meta.url))).href;

const waitFor = async (check: () => boolean, timeoutMs: number, what: string) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
};

type Helper = { child: ChildProcessWithoutNullStreams; text: () => string; lines: () => string[]; exited: () => boolean };
const helpers: Helper[] = [];
const runHelper = (name: string, source: string): Helper => {
  const file = join(scratch, `${name}.mjs`);
  writeFileSync(file, source);
  const child = spawn("bun", [file], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let out = "";
  child.stdout.on("data", (chunk) => (out += String(chunk)));
  child.stderr.on("data", (chunk) => (out += String(chunk)));
  const helper: Helper = { child, text: () => out, lines: () => out.split(/\r?\n/).filter(Boolean), exited: () => child.exitCode !== null || child.signalCode !== null };
  helpers.push(helper);
  return helper;
};
afterEach(() => {
  for (const helper of helpers.splice(0)) if (!helper.exited()) helper.child.kill();
});

const uniquePipe = (label: string) => `\\\\.\\pipe\\sf-stop-test-${label}-${process.pid}-${Date.now()}`;

describe.skipIf(process.platform !== "win32")("windows graceful stop (real pipe)", () => {
  it("install -> request() delivers through the hardened pipe, the helper exits cleanly, and a later request is refused", async () => {
    const helper = runHelper(
      "stoppable",
      `
const { createWindowsGracefulStop } = await import(${JSON.stringify(sourceUrl("gracefulStop.ts"))});
const windowsGracefulStop = ${helperStop};
const uninstall = windowsGracefulStop.install(
  (source) => process.stdout.write("stopped " + source + "\\n", () => { uninstall(); process.exit(0); }),
  (reason) => console.log("unavailable " + reason)
);
console.log("ready " + process.pid);
setInterval(() => {}, 1000);
`
    );
    await waitFor(() => helper.lines().some((line) => line.startsWith("ready ") || line.startsWith("unavailable ")), 30_000, "the helper to install");
    console.info(`[windows-graceful-stop:real] helper out=${JSON.stringify(helper.text())}`);
    expect(helper.text()).not.toContain("unavailable");
    const pid = helper.child.pid!;
    expect(windowsGracefulStop.request(pid)).toBe(true);
    await waitFor(helper.exited, 30_000, "the helper to exit");
    expect(helper.child.exitCode).toBe(0);
    expect(helper.lines()).toContain("stopped pipe");
    expect(windowsGracefulStop.request(pid)).toBe(false);
  });

  it("a second server cannot take a name that is already held (first instance only)", async () => {
    const name = uniquePipe("squat");
    const helper = runHelper(
      "squat",
      `
const { openStopPipe } = await import(${JSON.stringify(sourceUrl("stopPipe.ts"))});
const { loadBunFfi } = await import(${JSON.stringify(sourceUrl("win32api.ts"))});
const ffi = loadBunFfi();
const first = openStopPipe(ffi, ${JSON.stringify(name)}, () => console.log("first got a client"));
const second = openStopPipe(ffi, ${JSON.stringify(name)}, () => console.log("second got a client"));
console.log("first ok=" + first.ok);
console.log("second ok=" + second.ok + " reason=" + (second.ok ? "" : second.reason));
if (first.ok) first.close();
// Once the owner closed it, the name is free again for a legitimate server.
const third = openStopPipe(ffi, ${JSON.stringify(name)}, () => {});
console.log("third ok=" + third.ok);
if (third.ok) third.close();
`
    );
    await waitFor(helper.exited, 30_000, "the helper to finish");
    console.info(`[windows-graceful-stop:squat] ${JSON.stringify(helper.text())}`);
    expect(helper.lines()).toContain("first ok=true");
    expect(helper.lines().find((line) => line.startsWith("second ok="))).toMatch(/^second ok=false reason=CreateNamedPipeW failed.*first instance refused/);
    expect(helper.lines()).toContain("third ok=true");
  });

  it("the pipe's DACL is one owner-only ACE: no Everyone, Users or Authenticated Users", async () => {
    const name = uniquePipe("dacl");
    const helper = runHelper(
      "dacl",
      `
const { openStopPipe } = await import(${JSON.stringify(sourceUrl("stopPipe.ts"))});
const { loadBunFfi } = await import(${JSON.stringify(sourceUrl("win32api.ts"))});
// A slow poll keeps the inspecting client connected (the server disconnects a client once it has seen it).
const opened = openStopPipe(loadBunFfi(), ${JSON.stringify(name)}, () => console.log("client"), 20000);
console.log("ready ok=" + opened.ok);
setInterval(() => {}, 1000);
`
    );
    await waitFor(() => helper.lines().some((line) => line.startsWith("ready ")), 30_000, "the helper to open the pipe");
    expect(helper.lines()).toContain("ready ok=true");
    const leaf = name.slice("\\\\.\\pipe\\".length);
    const read = runPowerShellSync(
      `$c = New-Object System.IO.Pipes.NamedPipeClientStream('.', '${leaf}', [System.IO.Pipes.PipeDirection]::InOut)\n` +
        "$c.Connect(5000)\n" +
        // Windows PowerShell 5.1 (.NET Framework) has the instance method; PowerShell 7 only the extension.
        "$sd = if ($c.PSObject.Methods['GetAccessControl']) { $c.GetAccessControl() } else { [System.IO.Pipes.PipeAclExtensions]::GetAccessControl($c) }\n" +
        "[Console]::Out.Write($sd.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access))\n" +
        "$c.Dispose()",
      60_000
    );
    console.info(`[windows-graceful-stop:dacl] ok=${read.ok} sddl=${JSON.stringify(read.stdout)} stderr=${JSON.stringify(read.stderr)}`);
    expect(read.ok).toBe(true);
    const sddl = read.stdout.trim();
    // Protected DACL with exactly one allow ACE for the owner (OW, or the owner's own SID once resolved).
    expect(sddl).toMatch(/^D:P\(A;;[A-Z0-9]+;;;(OW|S-1-[0-9-]+)\)$/);
    for (const everyone of ["WD", "AU", "BU", "BG", "AN", "NU", "IU"]) expect(sddl).not.toContain(`;;;${everyone})`);
  });

  it("uninstall frees the name, so the same process can install again and keeps being stoppable", async () => {
    const helper = runHelper(
      "reinstall",
      `
const { createWindowsGracefulStop } = await import(${JSON.stringify(sourceUrl("gracefulStop.ts"))});
const windowsGracefulStop = ${helperStop};
let n = 0;
const first = windowsGracefulStop.install(() => { n++; console.log("request " + n); }, (reason) => console.log("unavailable " + reason));
console.log("ready " + process.pid);
await new Promise((resolve) => process.stdin.once("data", resolve));
first();
console.log("uninstalled");
const second = windowsGracefulStop.install(() => { n++; console.log("request " + n); }, (reason) => console.log("unavailable " + reason));
console.log("reinstalled");
setInterval(() => {}, 1000);
`
    );
    helper.child.stdin.on("error", () => {});
    await waitFor(() => helper.lines().some((line) => line.startsWith("ready ")), 30_000, "the helper to install");
    const pid = helper.child.pid!;
    expect(windowsGracefulStop.request(pid)).toBe(true);
    await waitFor(() => helper.lines().includes("request 1"), 10_000, "the first request");
    helper.child.stdin.write("go\n");
    await waitFor(() => helper.lines().includes("reinstalled"), 30_000, "the reinstall");
    expect(helper.text()).not.toContain("unavailable");
    expect(windowsGracefulStop.request(pid)).toBe(true);
    await waitFor(() => helper.lines().includes("request 2"), 10_000, "the request after reinstall");
  });
});
