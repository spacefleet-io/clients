/**
 * REL-UPD-07: how a Linux copy of Badger or Parrot that the system's package manager installed (.deb, .rpm, .pacman)
 * or a Flatpak gets updated. Main process only (Node built-ins); the renderer sees the outcome through `UpdaterState`.
 *
 *  - Install type: the AppImage runtime sets `APPIMAGE`; Flatpak sets `FLATPAK_ID` (and mounts `/.flatpak-info`); a
 *    native package ships `/usr/lib/<package>/system-update` (packages/desktop-platform-linux/packaging/system-update.mjs)
 *    and the package manager that owns that file is asked, never the distribution's name.
 *  - Update: `pkexec /usr/lib/<package>/system-update`, a fixed argument list. The desktop's own password dialog asks
 *    (polkit action `io.spacefleet.<package>.update`, "Update Badger"); the app never sees the password. The helper
 *    updates that one package from SpaceFleet's repository, or refuses and says why (its exit codes below).
 *  - No pkexec, no display, or pkexec could not ask: the app shows the command to run in a terminal instead.
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { SystemUpdateFailure } from "./types";

/** Mirrors `SYSTEM_UPDATE_EXIT` of system-update.mjs (a test keeps the two equal). */
export const SYSTEM_UPDATE_EXIT = {
  updated: 0,
  notNewer: 10,
  repoMissing: 11,
  needsSystemUpdate: 12,
  packageManager: 13,
  usage: 64,
  notManaged: 69,
  notRoot: 77,
} as const;

/** pkexec's own exit codes: the user closed the password dialog / pkexec could not authorize (no agent, wrong password). */
export const PKEXEC_EXIT = { dismissed: 126, notAuthorized: 127 } as const;

/** Which program updates a native package (the manual "update the whole system" command depends on it). */
export type SystemPackageManager = "pacman" | "apt" | "dnf" | "zypper";

export type LinuxInstall =
  | { kind: "appimage" }
  | { kind: "flatpak"; flatpakId: string | null }
  | { kind: "system"; manager: SystemPackageManager; helperPath: string }
  /** Started from an unpacked folder, a package built elsewhere (no helper), or a helper no package manager owns. */
  | { kind: "other"; reason: string };

export type SystemUpdateOutcome =
  | { result: "updated"; before: string | null; after: string | null }
  | { result: "dismissed" }
  | { result: "failed"; failure: SystemUpdateFailure; detail: string };

/** The OS calls detection and the update make; tests replace them. */
export type SystemProbe = {
  env: Record<string, string | undefined>;
  exists: (path: string) => boolean;
  /** True when `name` is an executable file in one of `PATH`'s folders. */
  onPath: (name: string) => boolean;
  /** Runs `command` with a fixed argument list (never a shell) and resolves its exit code and output. */
  run: (command: string, args: readonly string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>;
  /** Starts `command args` once this process has exited (see `relaunchAfterExit`). */
  relaunchAfterExit: (command: string, args: readonly string[]) => void;
};

/** Kept for the life of the process: the pipe to the relaunch helper must stay open until the app exits. */
let relauncher: ChildProcess | null = null;

/**
 * Starts the app again once this process is gone, from the files the package manager just installed.
 * Electron's `app.relaunch()` is not used: its relaunch helper is this process's own executable (`/proc/self/exe`),
 * which the update replaced, and the old binary would start against the new version's resources. Here a detached
 * `sh` holds the read end of a pipe whose write end only this process holds (libuv opens it close-on-exec, so no
 * renderer or GPU process inherits it): `cat` returns when the app has closed its files, single-instance lock released.
 * The kernel closes them a moment before the process itself is dead, so the helper then waits until `/proc` shows the
 * app (`$PPID`, kept from the helper's start) gone, a zombie or dead, and `exec` starts the new binary at the same path
 * with the same arguments.
 */
const relaunchAfterExit = (command: string, args: readonly string[]): void => {
  if (relauncher) return;
  const script =
    'cat >/dev/null; while case "$(sed -n "s/^State:[[:space:]]*//p" "/proc/$PPID/status" 2>/dev/null)" in ""|Z*|X*) false;; esac; do sleep 0.05; done; exec "$@"';
  relauncher = nodeSpawn("/bin/sh", ["-c", script, "sf-relaunch", command, ...args], {
    detached: true,
    stdio: ["pipe", "ignore", "ignore"],
    shell: false,
  });
  relauncher.on("error", (err) => console.error("[updater] relaunch helper could not start", err));
  relauncher.unref();
};

export const nodeSystemProbe: SystemProbe = {
  env: process.env,
  exists: existsSync,
  onPath: (name) =>
    (process.env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .some((dir) => {
        try {
          accessSync(join(dir, name), fsConstants.X_OK);
          return true;
        } catch {
          return false;
        }
      }),
  run: (command, args) => {
    const { promise, resolve } = Promise.withResolvers<{ code: number | null; stdout: string; stderr: string }>();
    const child = nodeSpawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"], shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (err) => resolve({ code: null, stdout, stderr: `${stderr}${err.message}` }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    return promise;
  },
  relaunchAfterExit,
};

/** `/usr/lib/<package>/system-update`, where the native package installs the helper. */
export const systemUpdateHelperPath = (packageName: string): string => `/usr/lib/${packageName}/system-update`;

/** Install type of a Linux copy, from what the system shows (environment, files, the owning package manager). */
export const detectLinuxInstall = async (packageName: string, probe: SystemProbe): Promise<LinuxInstall> => {
  if (probe.env.APPIMAGE) return { kind: "appimage" };
  if (probe.env.FLATPAK_ID || probe.exists("/.flatpak-info")) return { kind: "flatpak", flatpakId: probe.env.FLATPAK_ID || null };
  const helperPath = systemUpdateHelperPath(packageName);
  if (!probe.exists(helperPath)) return { kind: "other", reason: `${helperPath} is missing` };
  const owner = async (command: string, args: string[], owns: (stdout: string) => boolean): Promise<boolean> =>
    probe.onPath(command) && owns((await probe.run(command, args)).stdout);
  if (await owner("pacman", ["-Qqo", helperPath], (out) => out.trim() === packageName)) return { kind: "system", manager: "pacman", helperPath };
  if (await owner("dpkg-query", ["-S", helperPath], (out) => out.startsWith(`${packageName}: `))) return { kind: "system", manager: "apt", helperPath };
  if (await owner("rpm", ["-qf", "--qf", "%{NAME}", helperPath], (out) => out.trim() === packageName)) {
    if (probe.onPath("dnf")) return { kind: "system", manager: "dnf", helperPath };
    if (probe.onPath("zypper")) return { kind: "system", manager: "zypper", helperPath };
    return { kind: "other", reason: "rpm package without dnf or zypper" };
  }
  return { kind: "other", reason: `no package manager owns ${helperPath} as ${packageName}` };
};

/** pkexec is installed and a graphical session is there to show its dialog. Whether an agent answers shows at run time (127). */
export const canAskPassword = (probe: SystemProbe): boolean =>
  probe.onPath("pkexec") && Boolean(probe.env.DISPLAY || probe.env.WAYLAND_DISPLAY);

/** The command the user can run in a terminal instead: the same helper, or the whole-system update it asked for. */
export const manualCommand = (install: Extract<LinuxInstall, { kind: "system" | "flatpak" }>, failure?: SystemUpdateFailure): string => {
  if (install.kind === "flatpak") return `flatpak update ${install.flatpakId ?? ""}`.trim();
  if (failure !== "needsSystemUpdate") return `sudo ${install.helperPath}`;
  switch (install.manager) {
    case "pacman":
      return "sudo pacman -Syu";
    case "apt":
      return "sudo apt-get update && sudo apt-get upgrade";
    case "dnf":
      return "sudo dnf upgrade --refresh";
    case "zypper":
      return "sudo zypper update";
  }
};

const FAILURE_BY_EXIT: Record<number, SystemUpdateFailure> = {
  [SYSTEM_UPDATE_EXIT.notNewer]: "notNewer",
  [SYSTEM_UPDATE_EXIT.repoMissing]: "repoMissing",
  [SYSTEM_UPDATE_EXIT.needsSystemUpdate]: "needsSystemUpdate",
  [SYSTEM_UPDATE_EXIT.packageManager]: "packageManager",
  [PKEXEC_EXIT.notAuthorized]: "notAuthorized",
};

/**
 * The package manager's own words (and Flatpak's, flatpakPortal.ts) for "the repository's server could not be
 * reached" (DNS, refused or failed connection, timeout): libcurl's messages as pacman, dnf, zypper and flatpak print
 * them, and apt's. A 404 or a bad signature is not a network failure.
 */
export const NETWORK_FAILURE =
  /could(?: no|n'?)t (?:resolve|connect)|failed to connect|unable to connect|connection (?:refused|timed out|reset)|temporary failure (?:in name )?resolv|name or service not known|network is unreachable|no route to host|timeout was reached|operation too slow|curl error \((?:5|6|7|28|35|52|56)\)/i;

/** Runs `pkexec <helper>` (nothing else on the command line) and reads its answer. */
export const runSystemUpdate = async (helperPath: string, probe: SystemProbe): Promise<SystemUpdateOutcome> => {
  const { code, stdout, stderr } = await probe.run("pkexec", [helperPath]);
  const detail = stderr.trim().split("\n").slice(-6).join("\n");
  if (code === SYSTEM_UPDATE_EXIT.updated) {
    const line = stdout.split("\n").find((l) => l.startsWith(`SF_SYSTEM_UPDATE=${SYSTEM_UPDATE_EXIT.updated} `)) ?? "";
    return { result: "updated", before: /before=(\S+)/.exec(line)?.[1] ?? null, after: /after=(\S+)/.exec(line)?.[1] ?? null };
  }
  if (code === PKEXEC_EXIT.dismissed) return { result: "dismissed" };
  if (code === null) return { result: "failed", failure: "noPasswordDialog", detail };
  if (code === SYSTEM_UPDATE_EXIT.packageManager && NETWORK_FAILURE.test(stderr)) return { result: "failed", failure: "network", detail };
  return { result: "failed", failure: FAILURE_BY_EXIT[code] ?? "other", detail: detail || `exit ${code}` };
};
