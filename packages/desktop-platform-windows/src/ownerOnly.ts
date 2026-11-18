import { spawnSync } from "node:child_process";
import { win32 } from "node:path";
import type { Env } from "@space/desktop-platform-contract";
import { readEnv } from "./env";
import { buildPowerShellArgs, powershellExecutable, UTF8_OUTPUT_PRELUDE } from "./powershell";

/**
 * `PathLayer.restrictFileToOwner` on Windows: drop the inherited ACL and grant
 * full control to the current user's SID alone, with the stock `icacls.exe`
 * (and `whoami.exe` for the SID: a SID, unlike a user name, is unambiguous on
 * a domain machine and in any locale). When whoami fails (it also looks the
 * account name up, and exited 66 as a PC went to sleep), the SID is read from
 * the process token through PowerShell instead.
 *
 * `run` is the process seam: tests drive the argument lists on any OS. NOT
 * exercised on a real Windows host by the unit tests: that run belongs to the
 * Windows conformance job (`packages/desktop-platform/src/conformance-cli.ts`).
 */

export type AclResult = { status: number | null; stdout: string; stderr: string; error?: string };

export type AclRun = (command: string, args: string[]) => AclResult;

const runSync: AclRun = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error?.message };
};

const systemExecutable = (name: string, env: Env): string => {
  const root = readEnv(env, "SystemRoot")?.trim() || readEnv(env, "windir")?.trim();
  return root ? win32.join(root, "System32", name) : name;
};

const SID = /^S-1-\d+(?:-\d+)+$/;

/** The SID in `whoami /user /fo csv /nh` output (`"DOMAIN\user","S-1-5-21-..."`), or null. */
export const parseWhoamiSid = (stdout: string): string | null => {
  const fields = stdout
    .trim()
    .split(/\r?\n/)[0]
    ?.split(",")
    .map((field) => field.trim().replace(/^"|"$/g, ""));
  const sid = fields?.[fields.length - 1];
  return sid && SID.test(sid) ? sid : null;
};

/** icacls argv: no inheritance, full control for the SID only. */
export const buildIcaclsArgs = (path: string, sid: string): string[] => [path, "/inheritance:r", "/grant:r", `*${sid}:F`];

/** Reads the SID straight from the process token: no account-name lookup. */
const TOKEN_SID_SCRIPT = `${UTF8_OUTPUT_PRELUDE}[Console]::Out.Write([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)`;

const failure = (result: AclResult): string =>
  result.error || result.stderr.trim() || [`exit ${result.status}`, result.stdout.trim()].filter(Boolean).join(", ");

const currentUserSid = (path: string, env: Env, run: AclRun): string => {
  const who = run(systemExecutable("whoami.exe", env), ["/user", "/fo", "csv", "/nh"]);
  const whoSid = who.status === 0 ? parseWhoamiSid(who.stdout) : null;
  if (whoSid) return whoSid;
  const token = run(powershellExecutable(env), buildPowerShellArgs(TOKEN_SID_SCRIPT));
  const tokenSid = token.status === 0 ? token.stdout.replace(/^\uFEFF/, "").trim() : "";
  if (SID.test(tokenSid)) return tokenSid;
  throw new Error(`cannot make ${path} owner-only: could not read the current user's SID (whoami: ${failure(who)}; powershell: ${failure(token)})`);
};

export const restrictFileToOwnerWindows = (path: string, env: Env = process.env, run: AclRun = runSync): void => {
  const sid = currentUserSid(path, env, run);
  const result = run(systemExecutable("icacls.exe", env), buildIcaclsArgs(path, sid));
  if (result.status !== 0) {
    throw new Error(`cannot make ${path} owner-only: icacls failed (${result.error || result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`})`);
  }
};
