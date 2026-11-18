#!/usr/bin/env node
// Lane-aware development launcher for badger-desktop.
//
// Resolves the lane (SF_LANE first, then the worktree's `.spacefleet-lane`
// marker) through scripts/desktop-dev-lane.mjs, exports the lane env
// (SF_API_BASE_URL, SF_RUNTIME_BASE_URL, SF_USER_DATA_PATH, SF_DEV_SERVER_URL,
// SF_DEVTOOLS_PORT, SPACEFLEET_RUNTIME_DATA_DIR, SF_RUNTIME_SPAWN_MODE=source so
// the app spawns the lane's runtime itself), then execs `electron-vite dev --watch`.
// Without a lane (a developer's main checkout) the app uses its normal data dir and
// the default dev ports. A lane whose user data would land in the real app data
// dir is refused before Electron starts. A lane run is silent and headless
// (REL-ENV-36): muted Electron and mpv, and its own Xvfb when no private DISPLAY is set.
//
// Two badger-desktop instances in two different lanes can run concurrently
// because each picks a deterministic port offset from its lane slug.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureElectronBinary } from "../../../../scripts/ensure-electron-binary.mjs";
import { admitLaneOrExit, electronViteDevArgs, prepareLaneSilentLaunch, resolveDesktopDevEnv, runDevChild } from "../../../../scripts/desktop-dev-lane.mjs";
import { TEST_KEYCHAIN_ARGS } from "./test-keychain-args.mjs";

const baseEnv = { ...process.env };
delete baseEnv.ELECTRON_RUN_AS_NODE;
baseEnv.SF_DUMMY_STORAGE_DIR = baseEnv.SF_DUMMY_STORAGE_DIR || "./.storage";

let resolved;
try {
  resolved = resolveDesktopDevEnv({ app: "badger-desktop", env: baseEnv, cwd: process.cwd() });
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
const env = resolved.env;
console.log(
  resolved.lane
    ? `[badger-desktop:dev] lane=${resolved.lane} (from ${resolved.source}) userData=${resolved.userDataPath} api=${env.SF_API_BASE_URL} runtime=${env.SF_RUNTIME_BASE_URL} runtimeSpawn=${env.SF_RUNTIME_SPAWN_MODE ?? "default"} vite=${env.SF_DEV_SERVER_URL} devtools=${env.SF_DEVTOOLS_PORT}`
    : `[badger-desktop:dev] no lane: userData=${resolved.userDataPath ?? "(app default)"} vite=${env.SF_DEV_SERVER_URL} devtools=${env.SF_DEVTOOLS_PORT}`,
);

// Warn if the local .env still hardcodes VITE_API_BASE_URL — that wins over
// the Vite proxy via loadEnv precedence and would silently bypass the lane.
try {
  const dotenvPath = path.resolve("./.env");
  if (existsSync(dotenvPath)) {
    const raw = readFileSync(dotenvPath, "utf8");
    if (/^\s*VITE_API_BASE_URL\s*=/m.test(raw)) {
      console.warn(
        "[badger-desktop:dev] WARNING: apps/badger/desktop/.env pins VITE_API_BASE_URL — Vite's loadEnv wins over process.env, so the lane API URL will be ignored. Remove that line or the renderer will keep talking to the .env-pinned host.",
      );
    }
  }
} catch {
  // best-effort warning — don't block dev launch on read errors
}

if (!env.SF_LOG_LEVEL && !env.LOG_LEVEL) env.SF_LOG_LEVEL = "debug";
if (!env.SF_LOG_PRETTY && !env.LOG_PRETTY) env.SF_LOG_PRETTY = "1";

ensureElectronBinary(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));

// REL-ENV-43: no new Electron + vite on a host that is short of memory.
admitLaneOrExit("badger-desktop:dev");

// REL-ENV-36: an agent's lane run never plays sound or opens a window on the developer's screen. Without a lane, nothing changes.
let silent;
try {
  silent = await prepareLaneSilentLaunch({ lane: resolved.lane, env });
} catch (err) {
  console.error(`[badger-desktop:dev] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
if (silent.logLine) console.log(`[badger-desktop:dev] ${silent.logLine}`);

// Dev runs (yours and agents' MCP sessions) never touch the login keychain: each rebuild is a new
// unsigned binary to macOS, so a real safeStorage lookup prompts for the password every time.
// Everything after `--` goes to Electron; keep any args the caller already passes there.
// `--watch`: a preload or main change rebuilds them (UX-CRASH-01: a new screen on the old preload crashed).
runDevChild({
  command: "electron-vite",
  args: electronViteDevArgs({ userArgs: process.argv.slice(2), electronArgs: [...TEST_KEYCHAIN_ARGS, ...silent.electronArgs] }),
  env: silent.env,
  xvfb: silent.xvfb,
  sink: silent.sink,
});
