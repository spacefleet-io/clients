import type { GroupSignal, ProcessLayer } from "@space/desktop-platform-contract";
import { listProcesses, runPsSync, type RunPs } from "./ps";

const errorCode = (error: unknown): string | undefined =>
  error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;

/**
 * Process groups on macOS: a detached child leads its own group, so every signal goes to
 * `kill(-pgid)` and reaches the whole tree.
 *
 * `isAlive` asks `kill(-pgid, 0)` first (ESRCH: the group is empty), then the process table for a
 * member that is not a zombie: `kill(-pgid, 0)` alone also succeeds on a group whose only member is
 * an unreaped zombie, which would keep a dead group tracked forever. When ps cannot be run the
 * probe decides (EPERM still means alive: it exists, owned by someone else).
 */
export const createMacosProcessGroup = (runPs: RunPs = runPsSync): ProcessLayer["group"] => ({
  isAlive: (pgid) => {
    try {
      process.kill(-pgid, 0);
    } catch (error) {
      if (errorCode(error) !== "EPERM") return false;
    }
    const rows = listProcesses(runPs);
    if (!rows) return true;
    return rows.some((row) => row.pgid === pgid && !row.stat.startsWith("Z"));
  },
  signal: (pgid, signal: GroupSignal) => {
    const sig = signal === "terminate" ? "SIGTERM" : "SIGKILL";
    try {
      process.kill(-pgid, sig);
    } catch {
      return false; // ESRCH: the group is gone; EPERM/other: nothing was signalled
    }
    if (signal === "terminate") {
      // A stopped (SIGSTOP'd / traced) member only acts on SIGTERM once continued.
      try {
        process.kill(-pgid, "SIGCONT");
      } catch {
        // group may already be gone
      }
    }
    return true;
  },
});
