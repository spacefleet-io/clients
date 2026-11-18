import { closeSync, existsSync, mkdirSync, openSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, win32 } from "node:path";
import type { ProcessLayer } from "@space/desktop-platform-contract";
import { windowsPaths } from "./paths";
import { openStopPipe, type OpenStopPipeResult } from "./stopPipe";
import { loadBunFfi, type BunFfiModule } from "./win32api";

/**
 * `process.kill(pid, 'SIGTERM')` is a forced TerminateProcess on Windows: no
 * handler runs, so the runtime's drain would never happen. A stoppable process
 * instead listens on the named pipe `\\.\pipe\sf-stop-<pid>` and treats any
 * connection as the stop request; Ctrl+C in a console still arrives as SIGINT.
 *
 * The pipe is the hardened one from `stopPipe.ts` (first instance only,
 * owner-only DACL, no remote clients). The pid-derived name is public, so a
 * stopper must not trust a pipe just because it opens: the process that owns
 * the pipe also leaves a marker file for its pid in a per-user directory
 * (`%LOCALAPPDATA%\SpaceFleet\stop-pipes`, writable only by that user), written
 * after the pipe was created and removed on uninstall or on process `exit`.
 * `request` delivers only when the process is alive and the marker exists, so
 * a pipe someone else created first (the owner's `install` refused it and wrote
 * no marker) is reported as undeliverable and the stopper's forced-kill
 * escalation takes over.
 *
 * Not covered: a runtime ended without running `exit` handlers (a forced
 * terminate) leaves its marker until the next `install` or `request` prunes it,
 * so if that pid is reused by a process that also holds a squatted pipe of that
 * name before then, `request` would believe it. The request carries no data and
 * the stopper's escalation still ends the real process, so this only delays it.
 */
export const stopPipeName = (pid: number): string => `\\\\.\\pipe\\sf-stop-${pid}`;

export type WindowsGracefulStopDeps = {
  /** `bun:ffi`, or null under Node / Electron: the pipe server needs it. */
  loadFfi: () => BunFfiModule | null;
  openPipe: (ffi: BunFfiModule, name: string, onConnection: () => void) => OpenStopPipeResult;
  /** Open and close the pipe as a client (the connection is the request). True when it opened. */
  connectPipe: (name: string) => boolean;
  markerDir: () => string;
  isAlive: (pid: number) => boolean;
  warn: (message: string) => void;
};

const defaultIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const defaultDeps: WindowsGracefulStopDeps = {
  loadFfi: loadBunFfi,
  openPipe: openStopPipe,
  connectPipe: (name) => {
    try {
      closeSync(openSync(name, "r+"));
      return true;
    } catch {
      return false;
    }
  },
  markerDir: () => win32.join(windowsPaths.userDataBase(), "SpaceFleet", "stop-pipes"),
  isAlive: defaultIsAlive,
  warn: (message) => console.warn(`[desktop-platform] ${message}`),
};

export const createWindowsGracefulStop = (overrides: Partial<WindowsGracefulStopDeps> = {}): ProcessLayer["gracefulStop"] => {
  const deps = { ...defaultDeps, ...overrides };
  const markerPath = (pid: number): string => join(deps.markerDir(), String(pid));

  /** Markers a crashed owner left behind (no uninstall ran): their pid is gone. */
  const pruneStaleMarkers = () => {
    try {
      for (const entry of readdirSync(deps.markerDir())) {
        const pid = /^\d+$/.test(entry) ? Number(entry) : null;
        if (pid !== null && pid !== process.pid && !deps.isAlive(pid)) rmSync(join(deps.markerDir(), entry), { force: true });
      }
    } catch {
      // No marker directory yet.
    }
  };

  return {
    install: (onRequest, onUnavailable) => {
      const onInt = () => onRequest("SIGINT");
      process.on("SIGINT", onInt);
      const name = stopPipeName(process.pid);
      const unavailable = (reason: string) => {
        const message = `graceful-stop pipe ${name} unavailable: ${reason}`;
        if (onUnavailable) onUnavailable(message);
        else deps.warn(message);
      };
      let closePipe: (() => void) | null = null;
      const removeMarker = () => {
        try {
          rmSync(markerPath(process.pid), { force: true });
        } catch {
          // A marker that cannot be removed is pruned once this pid is dead.
        }
      };
      const ffi = deps.loadFfi();
      if (!ffi) {
        // Without the pipe the process is just not stoppable gracefully: the
        // stopper's forced-kill escalation still ends it.
        unavailable("the pipe server needs bun:ffi and this runtime has none");
      } else {
        try {
          pruneStaleMarkers();
          // A marker of an earlier process that had this pid must not vouch for the new pipe.
          removeMarker();
          const opened = deps.openPipe(ffi, name, () => onRequest("pipe"));
          if (!opened.ok) {
            unavailable(opened.reason);
          } else {
            closePipe = opened.close;
            try {
              mkdirSync(deps.markerDir(), { recursive: true });
              writeFileSync(markerPath(process.pid), "");
            } catch (error) {
              // No marker means no stopper will deliver, so the pipe would serve nobody.
              closePipe();
              closePipe = null;
              unavailable(`could not write the stop marker: ${(error as Error).message}`);
            }
          }
        } catch (error) {
          // install must never abort the runtime's startup.
          closePipe?.();
          closePipe = null;
          unavailable((error as Error).message);
        }
      }
      // The runtime leaves through process.exit, which skips the uninstall function.
      if (closePipe) process.once("exit", removeMarker);
      return () => {
        process.off("SIGINT", onInt);
        process.off("exit", removeMarker);
        if (closePipe) {
          closePipe();
          removeMarker();
        }
      };
    },
    request: (pid) => {
      // Opening the pipe is the whole message (CreateFile = connect), and it is
      // synchronous, so a stopper's `exit` handler can use it. A request only
      // asks the process to drain, the same as Ctrl+C, and carries no data.
      if (!existsSync(markerPath(pid))) return false;
      if (!deps.isAlive(pid)) {
        rmSync(markerPath(pid), { force: true });
        return false;
      }
      return deps.connectPipe(stopPipeName(pid));
    },
  };
};

export const windowsGracefulStop: ProcessLayer["gracefulStop"] = createWindowsGracefulStop();
