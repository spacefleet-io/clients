import { readdirSync, readFileSync } from "node:fs";
import type { GroupSignal, ProcessLayer } from "@space/desktop-platform-contract";

const errorCode = (error: unknown): string | undefined =>
  error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;

/**
 * Process groups on Linux: a detached child leads its own group, so every
 * signal goes to `kill(-pgid)` and reaches the whole tree (an AppImage mpv is
 * a chain `AppImage -> AppRun sh -> junest bash -> ld-linux -> mpv`; signalling
 * the spawned pid alone hits the wrapper four levels above the real mpv).
 *
 * `isAlive` scans `<procRoot>/<pid>/stat` for members of the group that are
 * not zombies. `kill(-pgid, 0)` alone also succeeds on a group whose only
 * member is an unreaped zombie (killed, waiting for a reaper), which happens
 * when nothing reaps orphans, e.g. a container whose PID 1 is not an init, and
 * it would keep a dead group tracked forever. When procfs is unreadable the
 * `kill(-pgid, 0)` probe decides: EPERM still means alive (exists, owned by
 * someone else) and ESRCH means the group is empty.
 *
 * `procRoot` exists for tests (a fake procfs).
 */
export const createLinuxProcessGroup = (procRoot = "/proc"): ProcessLayer["group"] => ({
  isAlive: (pgid) => {
    let entries: string[] | null = null;
    try {
      entries = readdirSync(procRoot);
    } catch {
      entries = null;
    }
    if (entries) {
      for (const entry of entries) {
        if (!/^\d+$/.test(entry)) continue;
        let stat: string;
        try {
          stat = readFileSync(`${procRoot}/${entry}/stat`, "utf8");
        } catch {
          continue; // exited between readdir and read
        }
        // "pid (comm) state ppid pgrp …": comm may hold spaces and parens.
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        if (Number(fields[2]) === pgid && fields[0] !== "Z" && fields[0] !== "X") return true;
      }
      return false;
    }
    try {
      process.kill(-pgid, 0);
      return true;
    } catch (error) {
      return errorCode(error) === "EPERM";
    }
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
