import type { ProcessLayer } from "@space/desktop-platform-contract";
import { createWindowsChildLifetime } from "./childLifetime";
import { windowsGracefulStop } from "./gracefulStop";
import { createWindowsProcessControl } from "./processControl";
import { createWindowsProcessGroup } from "./processGroup";
import { runPowerShell, runPowerShellSync, validPid, type PowerShellResult } from "./powershell";

/** A cold PowerShell + CIM query takes seconds on a loaded machine; bounded so a wedged WMI cannot hang the caller forever. */
const COMMAND_LINE_TIMEOUT_MS = 20_000;

/** PowerShell that prints the command line of `pid` and nothing when the process does not exist / has none. */
export const buildCommandLineScript = (pid: number): string =>
  `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue\n` +
  "if ($p -and $p.CommandLine) { [Console]::Out.Write($p.CommandLine) }";

/** The command line a `buildCommandLineScript` run printed, or null (not ok / empty). */
export const parseCommandLineOutput = (result: PowerShellResult): string | null => {
  if (!result.ok) return null;
  const text = result.stdout.trim();
  return text.length > 0 ? text : null;
};

export type WindowsProcessesDeps = {
  runSync: (script: string, timeoutMs: number) => PowerShellResult;
  run: (script: string, timeoutMs: number) => Promise<PowerShellResult>;
};

export const createWindowsProcesses = (overrides: Partial<WindowsProcessesDeps> = {}): ProcessLayer => {
  const runSync = overrides.runSync ?? ((script, timeoutMs) => runPowerShellSync(script, timeoutMs));
  const run = overrides.run ?? ((script, timeoutMs) => runPowerShell(script, timeoutMs));
  return {
    // A detached child leads its own tree (new process group, own console); windowsHide keeps console windows from flashing.
    spawnOptions: ({ detached }) => ({ detached, windowsHide: true }),
    group: createWindowsProcessGroup(),
    control: createWindowsProcessControl(),
    listThreadIds: (pid) => [pid],
    readCommandLine: async (pid) => {
      const valid = validPid(pid);
      if (valid === null) return null;
      return parseCommandLineOutput(await run(buildCommandLineScript(valid), COMMAND_LINE_TIMEOUT_MS));
    },
    readCommandLineSync: (pid) => {
      const valid = validPid(pid);
      if (valid === null) return null;
      return parseCommandLineOutput(runSync(buildCommandLineScript(valid), COMMAND_LINE_TIMEOUT_MS));
    },
    ownPidNamespace: () => null,
    gracefulStop: windowsGracefulStop,
    // Verified on the Windows VM (conformance `process-no-inherited-sockets`): Bun/libuv pass a child only its stdio table, so a handle its parent holds never reaches a spawned child. Nothing to close, so the launcher is the identity.
    withoutInheritedHandles: (command, args) => ({ command, args }),
    childLifetime: createWindowsChildLifetime(),
  };
};

export const windowsProcesses: ProcessLayer = createWindowsProcesses();
