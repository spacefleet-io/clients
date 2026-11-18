#!/usr/bin/env node
// Lane-aware development launcher for parrot-desktop, the same lane rules as badger-desktop's
// scripts/dev.mjs: the lane comes from SF_LANE first, then the worktree's `.spacefleet-lane` marker
// (scripts/desktop-dev-lane.mjs). With a lane, user data goes to ~/.local/share/sf-lane-<lane>/parrot-desktop
// and the API/dev-server ports to the lane's; a lane whose user data would land in the real `spaceparrot`
// dir is refused before Electron starts. A lane run is silent and headless (REL-ENV-36): muted Electron, and its
// own Xvfb when no private DISPLAY is set. Without a lane, Parrot runs as before.

import { admitLaneOrExit, electronViteDevArgs, prepareLaneSilentLaunch, resolveDesktopDevEnv, runDevChild } from "../../../../scripts/desktop-dev-lane.mjs";

const baseEnv = { ...process.env };
delete baseEnv.ELECTRON_RUN_AS_NODE;

let resolved;
try {
  resolved = resolveDesktopDevEnv({ app: "parrot-desktop", env: baseEnv, cwd: process.cwd() });
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
const env = resolved.env;
console.log(
  resolved.lane
    ? `[parrot-desktop:dev] lane=${resolved.lane} (from ${resolved.source}) userData=${resolved.userDataPath} api=${env.SF_API_BASE_URL} vite=${env.SF_DEV_SERVER_URL}`
    : `[parrot-desktop:dev] no lane: userData=${resolved.userDataPath ?? "(app default)"} vite=${env.SF_DEV_SERVER_URL}`,
);

// REL-ENV-43: no new Electron + vite on a host that is short of memory.
admitLaneOrExit("parrot-desktop:dev");

// REL-ENV-36: an agent's lane run never plays sound or opens a window on the developer's screen. Without a lane, nothing changes.
let silent;
try {
  silent = await prepareLaneSilentLaunch({ lane: resolved.lane, env });
} catch (err) {
  console.error(`[parrot-desktop:dev] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
if (silent.logLine) console.log(`[parrot-desktop:dev] ${silent.logLine}`);

// Everything after `--` goes to Electron (electron-vite flags such as --remoteDebuggingPort stay before it).
// `--watch`: a preload or main change rebuilds them (UX-CRASH-01: a new screen on the old preload crashed).
runDevChild({
  command: "electron-vite",
  args: electronViteDevArgs({ userArgs: process.argv.slice(2), electronArgs: silent.electronArgs }),
  env: silent.env,
  xvfb: silent.xvfb,
  sink: silent.sink,
});
