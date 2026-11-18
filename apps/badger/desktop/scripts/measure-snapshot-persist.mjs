// Measures the renderer main-thread cost of the cold-start library snapshot
// cache write (issue #25) in a real Electron renderer, and compares the old
// trailing-debounce policy with the persister used by LibraryProvider.
//
//   node apps/badger/desktop/scripts/measure-snapshot-persist.mjs
//
// Env knobs:
//   SF_BENCH_CPU_THROTTLE    CDP CPU throttling rate (default 4; ~old 4-core i5
//                            vs a current desktop core). 1 = no throttling.
//   SF_BENCH_TARGET_BYTES    serialized snapshot size (default 1_000_000).
//   SF_BENCH_PLAYBACK_S      simulated playback length in seconds (default 120).
//   SF_BENCH_IDLE_S          idle tail after playback stops (default 15).
//   SF_BENCH_SKIP_POLICY=1   only run the per-write micro benchmark.
//
// The window is hidden and launched with --disable-gpu, the target home PC
// profile (no GPU). Output: one JSON report on stdout, progress on stderr.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const desktopRoot = join(import.meta.dirname, "..");
const workDir = mkdtempSync(join(tmpdir(), "sf-persist-bench-"));
const log = (msg) => process.stderr.write(`[measure-snapshot-persist] ${msg}\n`);

// Bundle the real persister so the "after" policy is the shipped code.
const persisterBundle = join(workDir, "persister.js");
execFileSync(
  "bun",
  [
    "build",
    join(desktopRoot, "src/renderer/src/lib/librarySnapshotPersister.ts"),
    "--target=browser",
    "--format=iife",
    "--outfile",
    persisterBundle,
  ],
  { stdio: ["ignore", "ignore", "inherit"] }
);
// IIFE bundles of a module with exports do not expose them; re-export on window.
const persisterSource = readFileSync(persisterBundle, "utf8").replace(
  /\}\)\(\);\s*$/,
  "window.__sfPersister = { createLibrarySnapshotPersister };\n})();\n"
);
writeFileSync(persisterBundle, persisterSource);
writeFileSync(join(workDir, "index.html"), "<!doctype html><html><body>bench</body></html>");

const config = {
  throttle: Number(process.env.SF_BENCH_CPU_THROTTLE ?? 4),
  targetBytes: Number(process.env.SF_BENCH_TARGET_BYTES ?? 1_000_000),
  playbackS: Number(process.env.SF_BENCH_PLAYBACK_S ?? 120),
  idleS: Number(process.env.SF_BENCH_IDLE_S ?? 15),
  skipPolicy: process.env.SF_BENCH_SKIP_POLICY === "1",
};

const mainSource = `
const { app, BrowserWindow } = require("electron");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const workDir = ${JSON.stringify(workDir)};
const config = ${JSON.stringify(config)};
app.commandLine.appendSwitch("disable-gpu");
app.setPath("userData", join(workDir, "userData"));
const pageBench = ${JSON.stringify(readFileSync(join(import.meta.dirname, "measure-snapshot-persist-page.js"), "utf8"))};
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  await win.loadFile(join(workDir, "index.html"));
  win.webContents.debugger.attach("1.3");
  await win.webContents.debugger.sendCommand("Emulation.setCPUThrottlingRate", { rate: config.throttle });
  win.webContents.on("console-message", (_e, _level, message) => process.stderr.write(message + "\\n"));
  await win.webContents.executeJavaScript(readFileSync(join(workDir, "persister.js"), "utf8"));
  await win.webContents.executeJavaScript(pageBench);
  const report = await win.webContents.executeJavaScript("window.__sfRunBench(" + JSON.stringify(config) + ")");
  process.stdout.write(JSON.stringify({ electron: process.versions.electron, chrome: process.versions.chrome, config, ...report }, null, 2) + "\\n");
  app.exit(0);
});
`;
writeFileSync(join(workDir, "main.cjs"), mainSource);

const electronBinary = require(join(desktopRoot, "node_modules", "electron"));
log(`workDir=${workDir} electron=${electronBinary} config=${JSON.stringify(config)}`);
const child = spawn(electronBinary, ["--no-sandbox", join(workDir, "main.cjs")], {
  stdio: ["ignore", "inherit", "inherit"],
});
child.on("exit", (code) => {
  rmSync(workDir, { recursive: true, force: true });
  process.exit(code ?? 1);
});
