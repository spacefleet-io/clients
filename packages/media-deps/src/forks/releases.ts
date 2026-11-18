import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { git, gitAuthEnv, type ForgeAuth } from "./git";
import { parseLsRemote } from "./mirror";
import { newestMtime, tarballTree } from "./tree";

export type ReleaseTarballUpstream = {
  index: string;
  versionPattern: string;
  downloadUrl: string;
  since: string;
};

/** The slice of `fetch` this module uses (an injected double needs no `preconnect`). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Numeric dotted-version comparison (`3.99.5` < `3.100`). */
export const compareVersions = (a: string, b: string): number => {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
};

/** Versions the RSS listing publishes as `<title>…path…</title>` and `versionPattern` accepts, >= `since`, ascending. */
export const listReleaseVersions = (feed: string, upstream: ReleaseTarballUpstream): string[] => {
  const pattern = new RegExp(upstream.versionPattern);
  const versions = new Set<string>();
  for (const match of feed.matchAll(/<title>\s*(?:<!\[CDATA\[)?([^<\]]+?)(?:\]\]>)?\s*<\/title>/g)) {
    const version = pattern.exec(match[1] ?? "")?.[1];
    if (version !== undefined && compareVersions(version, upstream.since) >= 0) versions.add(version);
  }
  return [...versions].sort(compareVersions);
};

export type ImportReleasesOptions = {
  name: string;
  upstream: ReleaseTarballUpstream;
  forkUrl: string;
  cacheDir: string;
  auth?: ForgeAuth;
  /** sha256 the already-pinned release must have (a different file under the same version is refused). */
  expected?: Readonly<Record<string, string>>;
  fetchImpl?: FetchLike;
  log?: (line: string) => void;
};

/**
 * Upstreams that only publish tarballs (LAME on SourceForge): every release newer than `since` that the fork
 * lacks becomes ONE commit on `main` (parent = the previous import) whose tree is the tarball and whose message
 * carries the original url + sha256, tagged `v<version>`. Nothing is rewritten: existing tags are never touched.
 */
export const importReleases = async (options: ImportReleasesOptions): Promise<{ imported: string[] }> => {
  const log = options.log ?? (() => {});
  const fetchImpl = options.fetchImpl ?? fetch;
  const env = gitAuthEnv(options.auth);
  const feed = await fetchImpl(options.upstream.index);
  if (!feed.ok) throw new Error(`release_index_failed:${feed.status}:${options.upstream.index}`);
  const versions = listReleaseVersions(await feed.text(), options.upstream);
  const forkTags = new Set(parseLsRemote(await git(["ls-remote", "--tags", options.forkUrl], { env })).map((ref) => ref.name));
  const missing = versions.filter((version) => !forkTags.has(`refs/tags/v${version}`));
  if (missing.length === 0) {
    log(`[forks] ${options.name}: no new release (${versions.length} known upstream)`);
    return { imported: [] };
  }

  const repoDir = path.join(options.cacheDir, `${options.name}.git`);
  mkdirSync(options.cacheDir, { recursive: true });
  await git(["init", "--bare", "-q", repoDir]);
  await git(["fetch", "--no-tags", "-q", options.forkUrl, "+refs/heads/main:refs/heads/main"], { cwd: repoDir, env, allowFailure: true });
  const scratch = mkdtempSync(path.join(os.tmpdir(), "media-deps-release-"));
  try {
    for (const version of missing) {
      const url = options.upstream.downloadUrl.replaceAll("{version}", version);
      const response = await fetchImpl(url);
      if (!response.ok) throw new Error(`release_download_failed:${response.status}:${url}`);
      const body = Buffer.from(await response.arrayBuffer());
      const sha256 = createHash("sha256").update(body).digest("hex");
      const expected = options.expected?.[version];
      if (expected !== undefined && expected !== sha256) throw new Error(`release_sha256_mismatch:${url}:got ${sha256} want ${expected}`);
      const tarball = path.join(scratch, `${version}.tar.gz`);
      writeFileSync(tarball, body);
      const tree = await tarballTree(repoDir, tarball, scratch);
      const parent = await git(["rev-parse", "-q", "--verify", "refs/heads/main"], { cwd: repoDir, allowFailure: true });
      const date = newestMtime(path.join(scratch, "work"));
      const message = [`import ${options.name} ${version}`, "", `Release artifact: ${url}`, `sha256: ${sha256}`, ""].join("\n");
      const sha = await git(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message], {
        cwd: repoDir,
        env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      });
      await git(["update-ref", "refs/heads/main", sha], { cwd: repoDir });
      await git(["tag", `v${version}`, sha], { cwd: repoDir });
      log(`[forks] ${options.name}: imported ${version} sha256=${sha256}`);
    }
    await git(["push", "-q", options.forkUrl, "refs/heads/main:refs/heads/main", ...missing.map((version) => `refs/tags/v${version}:refs/tags/v${version}`)], {
      cwd: repoDir,
      env,
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return { imported: missing };
};
