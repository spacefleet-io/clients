import { execFile, spawnSync } from "node:child_process";
import { win32 } from "node:path";
import type { Env } from "@space/desktop-platform-contract";
import { readEnv } from "./env";

/**
 * PowerShell is how this layer asks Windows things that have no Node API
 * (command line of another process, GPU adapters, listening-port owners). Windows
 * PowerShell 5.1 ships with every supported Windows, so it is the one used.
 *
 * Scripts travel as `-EncodedCommand` (base64 UTF-16LE): no argv quoting rules to
 * get wrong, whatever the script contains.
 */

/** `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`, else `powershell.exe` from PATH. */
export const powershellExecutable = (env: Env = process.env): string => {
  const root = readEnv(env, "SystemRoot")?.trim() || readEnv(env, "windir")?.trim();
  return root ? win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "powershell.exe";
};

/** argv (without the executable) that runs `script` hidden, non-interactively, without profile or execution policy. */
export const buildPowerShellArgs = (script: string): string[] => [
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-EncodedCommand",
  Buffer.from(script, "utf16le").toString("base64"),
];

/** Decode what `buildPowerShellArgs` encoded (tests, diagnostics). */
export const decodePowerShellScript = (args: readonly string[]): string | null => {
  const at = args.indexOf("-EncodedCommand");
  const encoded = at >= 0 ? args[at + 1] : undefined;
  return encoded === undefined ? null : Buffer.from(encoded, "base64").toString("utf16le");
};

/** Makes the script's stdout UTF-8 without a BOM (the default is the OEM code page). */
export const UTF8_OUTPUT_PRELUDE = "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false\n";

export type PowerShellResult = { ok: boolean; stdout: string; stderr: string; error?: string };

const MAX_BUFFER = 4 * 1024 * 1024;

const clean = (stdout: string): string => stdout.replace(/^\uFEFF/, "");

/** Runs `script` and waits. Never throws; `ok` is exit code 0 within `timeoutMs`. `env` locates PowerShell and is its environment. */
export const runPowerShellSync = (script: string, timeoutMs: number, env: Env = process.env): PowerShellResult => {
  const result = spawnSync(powershellExecutable(env), buildPowerShellArgs(`${UTF8_OUTPUT_PRELUDE}${script}`), {
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
  return {
    ok: result.status === 0 && !result.error,
    stdout: clean(result.stdout ?? ""),
    stderr: result.stderr ?? "",
    error: result.error?.message ?? (result.status === 0 ? undefined : `exit ${result.status ?? result.signal}`),
  };
};

/** Same as `runPowerShellSync` without blocking the event loop. */
export const runPowerShell = (script: string, timeoutMs: number, env: Env = process.env): Promise<PowerShellResult> =>
  // Not Promise.withResolvers: the desktop typecheck compiles against a pre-ES2024 lib.
  new Promise<PowerShellResult>((resolve) => {
    const child = execFile(
      powershellExecutable(env),
      buildPowerShellArgs(`${UTF8_OUTPUT_PRELUDE}${script}`),
      { encoding: "utf8", windowsHide: true, timeout: timeoutMs, maxBuffer: MAX_BUFFER },
      (error, stdout, stderr) =>
        resolve({ ok: !error, stdout: clean(stdout ?? ""), stderr: stderr ?? "", error: error?.message })
    );
    child.stdin?.end();
  });

/** A pid that is safe to put in a script: a positive safe integer, else null. */
export const validPid = (pid: number): number | null => (Number.isSafeInteger(pid) && pid > 0 ? pid : null);
