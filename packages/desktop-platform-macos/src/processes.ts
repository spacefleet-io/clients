import { accessSync, constants as fsConstants } from "node:fs";
import { join } from "node:path";
import { spawnDetachedSurvivor, type Env, type ProcessLayer } from "@space/desktop-platform-contract";
import { macosGracefulStop } from "./gracefulStop";
import { createDarwinProcessControl } from "./processControl";
import { createMacosProcessGroup } from "./processGroup";
import { runPsAsync, runPsSync, validPid, type RunPs } from "./ps";

/**
 * Electron's `--remote-debugging-port` socket has no CLOEXEC and neither libuv nor Node closes fds
 * above 2 on spawn, so every child would keep the port bound after Electron let go. macOS has no
 * procfs; `/dev/fd` lists the open descriptors instead. The child starts through a POSIX-mode bash
 * prelude (bash 3.2 ships with every macOS; POSIX mode skips $BASH_ENV, so the caller's environment
 * cannot run a script first) that closes every fd >= 3 and then execs the program in place: pid,
 * command line and parent are the program's own.
 *
 * Every fd >= 3 goes, including a stdio entry the spawner passed on purpose; callers that need one
 * (`'ipc'`, a 4th pipe) must not use the wrapper.
 */
const CLOSE_FDS_SCRIPT = 'for f in /dev/fd/*; do n=${f##*/}; [ "$n" -gt 2 ] && eval "exec $n>&-"; done; exec "$@"';
const CLOSE_INHERITED_FDS_NAME = "sf-close-inherited-fds";
const BASH = "/bin/bash";

/** The lifeline helper's file name in the deps bundle's `bin/` (RT-LIFE-06). */
export const LIFELINE_NAME = "sf-lifeline";

export type MacosProcessesOptions = {
  /**
   * Path of the `sf-lifeline` helper, or null when there is none (then children are not tied to
   * this process and `childLifetime.supported()` is false). Asked on every use.
   */
  locateLifeline: () => string | null;
  runPs?: RunPs;
  /** Structured events about the parent-death guarantee; defaults to console JSON lines. */
  log?: (level: "info" | "warn", event: Record<string, unknown>) => void;
};

const findExecutable = (name: string, pathEnv: string | undefined): string | null => {
  const candidates = name.includes("/")
    ? [name]
    : (pathEnv ?? "").split(":").filter(Boolean).map((dir) => join(dir, name));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return null;
};

const defaultLog = (level: "info" | "warn", event: Record<string, unknown>): void => {
  if (level === "info") console.info(JSON.stringify(event));
  else console.warn(JSON.stringify(event));
};

export const createMacosProcesses = (options: MacosProcessesOptions): ProcessLayer => {
  const runPs = options.runPs ?? runPsSync;
  const log = options.log ?? defaultLog;

  let reported: string | null | undefined;
  /** The helper, with one log line whenever what was found changes (found / missing). */
  const lifeline = (): string | null => {
    const found = options.locateLifeline();
    if (found !== reported) {
      reported = found;
      if (found) log("info", { event: "ffmpeg.parent_death_signal", mode: "sf-lifeline", lifeline: found });
      else {
        log("warn", {
          event: "ffmpeg.parent_death_signal",
          mode: "none",
          reason: "sf-lifeline-not-found",
          effect: "an encoder can outlive a SIGKILLed parent until the encoder-lease reaper finds it",
        });
      }
    }
    return found;
  };

  const withoutInheritedHandles: ProcessLayer["withoutInheritedHandles"] = (command, args, env) => {
    const resolved = findExecutable(command, env?.PATH ?? process.env.PATH);
    if (!resolved) return { command, args };
    return { command: BASH, args: ["--posix", "-c", CLOSE_FDS_SCRIPT, CLOSE_INHERITED_FDS_NAME, resolved, ...args] };
  };

  return {
    withoutInheritedHandles,
    spawnOptions: ({ detached }) => ({ detached }),
    group: createMacosProcessGroup(runPs),
    control: createDarwinProcessControl({ runPs }),
    listThreadIds: (pid) => [pid],
    readCommandLine: async (pid) => (validPid(pid) ? (await runPsAsync(["-ww", "-o", "command=", "-p", String(pid)]))?.trim() || null : null),
    readCommandLineSync: (pid) => (validPid(pid) ? runPs(["-ww", "-o", "command=", "-p", String(pid)])?.trim() || null : null),
    ownPidNamespace: () => null,
    gracefulStop: macosGracefulStop,
    childLifetime: {
      supported: async () => lifeline() !== null,
      /**
       * `sf-lifeline <this pid> -- <command> <args>`: the helper checks this process is still its
       * parent (exit 125 otherwise), starts its kqueue watchdog, closes every inherited fd >= 3 and
       * execs the command in place (see native/sf-lifeline.c). A command that does not resolve is
       * returned unwrapped, so the spawn still fails with ENOENT instead of the helper's exit 127.
       */
      wrap: async (command: string, args: string[], env?: Env) => {
        const helper = lifeline();
        const resolved = helper ? findExecutable(command, env?.PATH ?? process.env.PATH) : null;
        if (!helper || !resolved) return withoutInheritedHandles(command, args, env);
        return { command: helper, args: [String(process.pid), "--", resolved, ...args] };
      },
      afterSpawn: () => {},
      adoptCurrentProcess: async () => false,
      spawnSurvivor: spawnDetachedSurvivor,
    },
  };
};
