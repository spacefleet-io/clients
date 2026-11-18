import { execFile } from "node:child_process";
import { accessSync, constants as fsConstants, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { basename, join as joinPath } from "node:path";
import { spawnDetachedSurvivor, type Env, type ProcessLayer } from "@space/desktop-platform-contract";
import { createLinuxProcessGroup } from "./processGroup";
import { createLinuxProcessControl, listLinuxThreadIds } from "./processControl";
import { linuxGracefulStop } from "./gracefulStop";

/**
 * #25 P7: an encoder must die with the process that spawned it. A SIGKILLed
 * runtime (crash, OOM kill, guardian kill) runs no cleanup, and its ffmpeg
 * children used to keep encoding at full CPU, reparented to init. Neither
 * Bun.spawn nor node:child_process can set PR_SET_PDEATHSIG, so the child is
 * started through util-linux `setpriv --pdeathsig KILL`, which sets it and
 * then execs the binary in place: the pid, command line (encoder-lease
 * identity check) and niceness tracking are those of the program itself. The
 * death signal follows the spawning THREAD; the runtime spawns from its main
 * thread only.
 *
 * Resolved once per layer. When setpriv is missing or too old (no
 * --pdeathsig before util-linux 2.33) commands still run unwrapped and one
 * warning says why an orphan may survive.
 */
const PARENT_DEATH_ARGS = ["--pdeathsig", "KILL", "--"] as const;

/**
 * Electron's `--remote-debugging-port` socket has no CLOEXEC, and libuv does
 * not close fds above 2 on spawn, so the runtime, mpv and ffmpeg inherited it
 * and kept the port bound after Electron let go (`ss` showed one fd on :9333
 * in all three). Neither Bun.spawn nor node:child_process can close them, so
 * the child starts through a bash prelude that closes every fd >= 3 listed in
 * /proc/self/fd and then execs the program in place: pid, command line and
 * parent are the program's own, like the setpriv wrapper. bash (not dash:
 * redirections only reach single-digit fds there, the leaked fd was 68) in
 * POSIX mode, which skips $BASH_ENV, so the caller's environment cannot run a
 * script before the program. `exec` also undoes bash's SHLVL bump.
 *
 * Every fd >= 3 goes, including a stdio entry the spawner passed on purpose;
 * callers that need one (`'ipc'`, a 4th pipe) must not use the wrapper.
 */
const CLOSE_FDS_SCRIPT = 'for f in /proc/self/fd/*; do n=${f##*/}; [ "$n" -gt 2 ] && eval "exec $n>&-"; done; exec "$@"';

/**
 * setpriv arms PR_SET_PDEATHSIG only once it runs: a parent that dies between the fork and that
 * prctl is never signalled, and the child would run on as an orphan (157 of 300 children
 * SIGKILLed-at-spawn survived, and a loaded CI machine hit it in the playback test). setpriv is
 * outermost, so by the time this prelude runs the signal is armed; bash's $PPID is the parent at
 * its own start, so a parent that is no longer the spawner (the wrapping process) means it died
 * first and the child exits instead of running. `$1` is the spawner's pid.
 */
const PARENT_ALIVE_GUARD = '[ "$PPID" = "$1" ] || exit 1; shift; ';

const CLOSE_INHERITED_FDS_NAME = "sf-close-inherited-fds";

export type LinuxProcessesOptions = {
  /** procfs root for the group / command-line / thread readers (tests point it at a fake). */
  procRoot?: string;
  /** Runs `setpriv <args>` and reports whether it exited 0 (tests inject a fake). */
  runSetpriv?: (setpriv: string, args: string[]) => Promise<boolean>;
  /** PATH used to find `setpriv`; `/usr/bin:/bin` is always appended. */
  pathEnv?: string;
  /** Structured events about the parent-death guarantee; defaults to console JSON lines. */
  log?: (level: "info" | "warn", event: Record<string, unknown>) => void;
};

const findExecutable = (name: string, pathEnv: string | undefined): string | null => {
  const candidates = name.includes("/")
    ? [name]
    : (pathEnv ?? "").split(":").filter(Boolean).map((dir) => joinPath(dir, name));
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

const defaultRunSetpriv = (setpriv: string, args: string[]): Promise<boolean> =>
  // Not Promise.withResolvers: the desktop typecheck compiles against a pre-ES2024 lib.
  new Promise<boolean>((resolve) => {
    execFile(setpriv, args, { timeout: 5_000 }, (err) => resolve(!err));
  });

const defaultLog = (level: "info" | "warn", event: Record<string, unknown>): void => {
  if (level === "info") console.info(JSON.stringify(event));
  else console.warn(JSON.stringify(event));
};

export const createLinuxProcesses = (options: LinuxProcessesOptions = {}): ProcessLayer => {
  const procRoot = options.procRoot ?? "/proc";
  const runSetpriv = options.runSetpriv ?? defaultRunSetpriv;
  const log = options.log ?? defaultLog;

  const readCommandLineSync = (pid: number): string | null => {
    try {
      const text = readFileSync(`${procRoot}/${pid}/cmdline`, "utf8").split("\0").join(" ").trim();
      return text.length > 0 ? text : null;
    } catch {
      return null;
    }
  };

  let parentDeathWrapper: Promise<string | null> | null = null;
  const probeParentDeathWrapper = async (): Promise<string | null> => {
    const setpriv = findExecutable("setpriv", `${options.pathEnv ?? process.env.PATH ?? ""}:/usr/bin:/bin`);
    if (setpriv && (await runSetpriv(setpriv, [...PARENT_DEATH_ARGS, "true"]))) {
      log("info", { event: "ffmpeg.parent_death_signal", mode: "setpriv", setpriv });
      return setpriv;
    }
    log("warn", {
      event: "ffmpeg.parent_death_signal",
      mode: "none",
      reason: setpriv ? "setpriv-rejected-pdeathsig" : "setpriv-not-found",
      effect: "an encoder can outlive a SIGKILLed parent until the encoder-lease reaper finds it",
    });
    return null;
  };
  const resolveParentDeathWrapper = () => (parentDeathWrapper ??= probeParentDeathWrapper());

  let closeFdsShell: string | null | undefined;
  /** `withoutInheritedHandles`, optionally refusing to run unless `parentPid` is still the parent (see PARENT_ALIVE_GUARD). */
  const closeInheritedFds = (command: string, args: string[], env: Env | undefined, parentPid?: number): { command: string; args: string[] } => {
    if (closeFdsShell === undefined) {
      // Started as `sh` when sh is bash: ananicy-cpp (CachyOS default) renices a process named `bash` or `dash` to -4 within
      // milliseconds, and the renice sticks through the exec, so an ffmpeg started as `bash` would run ABOVE normal priority.
      const searchPath = `${options.pathEnv ?? process.env.PATH ?? ""}:/usr/bin:/bin`;
      const sh = findExecutable("sh", searchPath);
      closeFdsShell = sh && basename(realpathSync(sh)) === "bash" ? sh : findExecutable("bash", searchPath);
      if (!closeFdsShell) {
        log("warn", {
          event: "spawn.inherited_fds",
          mode: "none",
          reason: "bash-not-found",
          effect: "a child keeps every fd its parent leaked (Electron's DevTools port stays bound)",
        });
      }
    }
    const resolved = closeFdsShell ? findExecutable(command, env?.PATH ?? process.env.PATH) : null;
    if (!closeFdsShell || !resolved) return { command, args };
    const script = parentPid === undefined ? CLOSE_FDS_SCRIPT : `${PARENT_ALIVE_GUARD}${CLOSE_FDS_SCRIPT}`;
    const guard = parentPid === undefined ? [] : [String(parentPid)];
    return { command: closeFdsShell, args: ["--posix", "-c", script, CLOSE_INHERITED_FDS_NAME, ...guard, resolved, ...args] };
  };
  const withoutInheritedHandles: ProcessLayer["withoutInheritedHandles"] = (command, args, env) => closeInheritedFds(command, args, env);

  return {
    withoutInheritedHandles,
    spawnOptions: ({ detached }) => ({ detached }),
    group: createLinuxProcessGroup(procRoot),
    control: createLinuxProcessControl(),
    listThreadIds: (pid) => listLinuxThreadIds(pid, procRoot),
    readCommandLine: async (pid) => readCommandLineSync(pid),
    readCommandLineSync,
    ownPidNamespace: () => {
      try {
        return /^pid:\[(\d+)\]$/.exec(readlinkSync(`${procRoot}/self/ns/pid`))?.[1] ?? null;
      } catch {
        return null;
      }
    },
    gracefulStop: linuxGracefulStop,
    childLifetime: {
      supported: async () => (await resolveParentDeathWrapper()) !== null,
      /**
       * The argv to spawn for `command args` so the child gets SIGKILL when its
       * parent dies. A command that does not resolve is returned unwrapped, so
       * the spawn still fails with ENOENT instead of setpriv's exit 127.
       */
      wrap: async (command: string, args: string[], env?: Env) => {
        const setpriv = await resolveParentDeathWrapper();
        const resolved = setpriv ? findExecutable(command, env?.PATH ?? process.env.PATH) : null;
        if (!setpriv || !resolved) return withoutInheritedHandles(command, args, env);
        // setpriv stays OUTERMOST: it arms the parent-death signal first, so a
        // parent that dies while the fd-closing prelude runs still takes the
        // child with it (the signal survives the later execs; none is setuid).
        // A parent that died before setpriv armed it is caught by the prelude's guard.
        // The spawner is this process (wrap's contract: the caller spawns the returned argv itself).
        const inner = closeInheritedFds(resolved, args, env, process.pid);
        return { command: setpriv, args: [...PARENT_DEATH_ARGS, inner.command, ...inner.args] };
      },
      afterSpawn: () => {},
      adoptCurrentProcess: async () => false,
      spawnSurvivor: spawnDetachedSurvivor,
    },
  };
};

export const linuxProcesses: ProcessLayer = createLinuxProcesses();
