/**
 * Process-group signalling for the external mpv (issue #25 P21).
 *
 * mpv is spawned detached, so it leads its own process group. The retired
 * AppImage build was a wrapper chain (`AppRun sh → junest bash → ld-linux →
 * mpv`) where signalling the spawned pid alone hit a wrapper four levels above
 * the real mpv, and a hung mpv outlived the app by ~20 min in the confirmation
 * run. Every signal still goes to the whole group, so a surviving member is
 * never orphaned, through `getDesktopPlatform().processes.group` (the OS
 * decides how a group is addressed and walked).
 *
 * `liveMpvGroups` lets the main process's `process.on("exit")` safety net
 * kill every mpv we started synchronously, because the async dispose()
 * escalation timers die with Electron.
 */
import { getDesktopPlatform } from "@space/desktop-platform";

import { scopeLogger } from "./logger";

const logger = scopeLogger("mpv-process-group");

const liveMpvGroups = new Set<number>();

/** Grace between SIGTERM and SIGKILL in the synchronous exit path. */
const EXIT_KILL_GRACE_MS = 500;
const EXIT_KILL_POLL_MS = 25;

export const trackMpvProcessGroup = (pgid: number): void => {
  liveMpvGroups.add(pgid);
};

export const untrackMpvProcessGroup = (pgid: number): void => {
  liveMpvGroups.delete(pgid);
};

/** Test-only view of the tracked groups. */
export const __trackedMpvProcessGroupsForTests = (): number[] => [...liveMpvGroups];

/**
 * True while any process of the group can still run (zombies do not count);
 * the OS-specific check is `getDesktopPlatform().processes.group`.
 */
export const isMpvProcessGroupAlive = (pgid: number): boolean => getDesktopPlatform().processes.group.isAlive(pgid);

/**
 * Signal every process of the mpv group. SIGTERM is followed by SIGCONT so a
 * stopped (SIGSTOP'd / traced) member can act on it. Returns true when the
 * signal was delivered to at least one process.
 */
export const signalMpvProcessGroup = (pgid: number, signal: "SIGTERM" | "SIGKILL"): boolean => {
  const delivered = getDesktopPlatform().processes.group.signal(pgid, signal === "SIGTERM" ? "terminate" : "kill");
  if (delivered) {
    logger.info({ pgid, signal }, "signalled mpv process group");
  } else if (isMpvProcessGroupAlive(pgid)) {
    logger.warn({ pgid, signal }, "mpv process-group signal failed");
  }
  return delivered;
};

/**
 * Synchronous last-resort kill for `process.on("exit")`: SIGTERM every
 * tracked group, wait up to EXIT_KILL_GRACE_MS for them to go, then SIGKILL
 * the survivors. Blocks exit by at most the grace.
 */
export const killAllMpvProcessGroupsSync = (): void => {
  const groups = [...liveMpvGroups].filter((pgid) => isMpvProcessGroupAlive(pgid));
  if (groups.length === 0) return;
  logger.warn({ groups }, "app exiting with mpv still alive; killing its process groups");
  for (const pgid of groups) signalMpvProcessGroup(pgid, "SIGTERM");
  const deadline = Date.now() + EXIT_KILL_GRACE_MS;
  let survivors = groups.filter((pgid) => isMpvProcessGroupAlive(pgid));
  while (survivors.length > 0 && Date.now() < deadline) {
    // Synchronous sleep: no event loop is left in an exit handler.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, EXIT_KILL_POLL_MS);
    survivors = survivors.filter((pgid) => isMpvProcessGroupAlive(pgid));
  }
  for (const pgid of survivors) signalMpvProcessGroup(pgid, "SIGKILL");
  for (const pgid of groups) liveMpvGroups.delete(pgid);
  logger.warn({ groups, sigkilled: survivors }, "mpv process groups killed at exit");
};
