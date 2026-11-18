import { mkdirSync } from "node:fs";
import path from "node:path";
import { gitAuthEnv, git, type ForgeAuth } from "./git";

export type Ref = { name: string; sha: string };

/**
 * What the nightly sync copies: every upstream branch and tag, EXCEPT anything under `sf/` (our own patch
 * branches live there and nothing upstream may ever write, move or delete them), pull refs, and peeled tags.
 */
export const isMirroredRef = (name: string): boolean =>
  /^refs\/(heads|tags)\//.test(name) && !name.endsWith("^{}") && !/^refs\/(heads|tags)\/sf\//.test(name);

export const parseLsRemote = (output: string): Ref[] =>
  output
    .split("\n")
    .filter((line) => line.includes("\t"))
    .map((line) => {
      const [sha = "", name = ""] = line.split("\t");
      return { name, sha };
    });

/** The upstream refs the fork does not have at the same sha. */
export const planMirror = (upstream: readonly Ref[], fork: readonly Ref[]): Ref[] => {
  const forkShas = new Map(fork.map((ref) => [ref.name, ref.sha]));
  return upstream.filter((ref) => isMirroredRef(ref.name) && forkShas.get(ref.name) !== ref.sha);
};

/** Negative refspecs keep `sf/` out of both directions even if someone ever points a wildcard at it. */
const MIRROR_REFSPECS = ["+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*", "^refs/heads/sf/*", "^refs/tags/sf/*"] as const;

export type MirrorOptions = {
  /** Local label (cache directory name, log lines). */
  name: string;
  upstreamUrl: string;
  forkUrl: string;
  /** Working bare repositories live here; reused between runs so an update only transfers the delta. */
  cacheDir: string;
  auth?: ForgeAuth;
  log?: (line: string) => void;
};

export type MirrorResult = { status: "up-to-date" | "updated"; refs: string[] };

/**
 * Brings the fork's upstream refs up to date with upstream. Cheap when nothing changed (two `ls-remote`).
 * Otherwise: seed a local bare repo from the FORK (fast, same network), fetch only the delta from upstream,
 * push every changed branch/tag forced. Never pushes or deletes `sf/*`; upstream branches that disappeared
 * upstream stay in the fork.
 */
export const mirrorFork = async (options: MirrorOptions): Promise<MirrorResult> => {
  const log = options.log ?? (() => {});
  const env = gitAuthEnv(options.auth);
  const upstream = parseLsRemote(await git(["ls-remote", "--heads", "--tags", options.upstreamUrl], { env }));
  const fork = parseLsRemote(await git(["ls-remote", "--heads", "--tags", options.forkUrl], { env }));
  const stale = planMirror(upstream, fork);
  if (stale.length === 0) {
    log(`[forks] ${options.name}: up to date (${upstream.filter((ref) => isMirroredRef(ref.name)).length} refs)`);
    return { status: "up-to-date", refs: [] };
  }

  const repoDir = path.join(options.cacheDir, `${options.name}.git`);
  mkdirSync(options.cacheDir, { recursive: true });
  await git(["init", "--bare", "-q", repoDir]);
  if (fork.length > 0) {
    await git(["fetch", "--no-tags", "-q", options.forkUrl, "+refs/heads/*:refs/forge/heads/*", "+refs/tags/*:refs/forge/tags/*"], {
      cwd: repoDir,
      env,
    });
  }
  await git(["fetch", "--no-tags", "--force", "-q", options.upstreamUrl, ...MIRROR_REFSPECS], { cwd: repoDir, env });
  await git(["push", "--force", "-q", options.forkUrl, ...MIRROR_REFSPECS.map((spec) => spec.replace(/^\+/, ""))], { cwd: repoDir, env });
  log(`[forks] ${options.name}: ${stale.length} refs updated`);
  return { status: "updated", refs: stale.map((ref) => ref.name) };
};
