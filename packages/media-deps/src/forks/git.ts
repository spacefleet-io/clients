import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Where the forks live (one repository per library). Every build, the nightly sync and the source archive read from here only. */
export const FORGE_URL = "https://github.com";
export const FORGE_ORG = "spacefleet-io";

/** `user:token` that can read (builds, source archive) or write (sync, pin) the fork repositories. */
export type ForgeAuth = { user: string; token: string };

/**
 * The GitHub token the entry-point scripts use, for the forks and the bundle releases alike: MEDIA_DEPS_GH_TOKEN,
 * then GH_TOKEN. Undefined when neither is set: the forks and releases are public, so reading needs none.
 */
export const githubTokenFromEnv = (env: Record<string, string | undefined> = process.env): string | undefined =>
  env.MEDIA_DEPS_GH_TOKEN || env.GH_TOKEN || undefined;

/** The git credential for the forks: GitHub takes any user name with a token as the password. */
export const forgeAuthFromEnv = (env: Record<string, string | undefined> = process.env): ForgeAuth | undefined => {
  const token = githubTokenFromEnv(env);
  return token ? { user: "x-access-token", token } : undefined;
};

/** `<forge>/<org>`, or MEDIA_DEPS_FORKS_URL (a mirror holding the same repositories). */
export const forksBaseUrl = (env: Record<string, string | undefined> = process.env) =>
  (env.MEDIA_DEPS_FORKS_URL || `${FORGE_URL}/${FORGE_ORG}`).replace(/\/+$/, "");

export const forkCloneUrl = (repo: string, baseUrl = forksBaseUrl()) => `${baseUrl}/${repo}.git`;

/**
 * The credential reaches git through GIT_CONFIG_* environment variables, scoped to the forge URL: it is never put
 * on a command line (visible in `ps`), never written to `.git/config`, and never sent to another host.
 */
export const gitAuthEnv = (auth: ForgeAuth | undefined, forgeUrl = FORGE_URL): Record<string, string> => {
  if (!auth) return {};
  const basic = Buffer.from(`${auth.user}:${auth.token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${forgeUrl}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
};

export type GitOptions = {
  cwd?: string;
  env?: Record<string, string>;
  /** Text piped to stdin is not needed anywhere: kept out on purpose. */
  allowFailure?: boolean;
};

const IDENTITY_ENV = {
  GIT_AUTHOR_NAME: "Spacefleet Deps",
  GIT_AUTHOR_EMAIL: "deps@spacefleet.invalid",
  GIT_COMMITTER_NAME: "Spacefleet Deps",
  GIT_COMMITTER_EMAIL: "deps@spacefleet.invalid",
};

/** Runs git, returns trimmed stdout. Errors carry git's stderr (auth headers are never in it). */
export const git = async (args: readonly string[], options: GitOptions = {}): Promise<string> => {
  try {
    const { stdout } = await execFileAsync("git", [...args], {
      cwd: options.cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...IDENTITY_ENV, ...options.env },
      maxBuffer: 256 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    if (options.allowFailure) return "";
    const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : String(error);
    throw new Error(`git ${args[0]} failed: ${stderr.trim()}`);
  }
};
