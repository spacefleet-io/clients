import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { git } from "./git";
import { sfBranchName } from "./names";
import { tarballTree } from "./tree";

export type ReleaseArtifact = {
  /** Where upstream published it (provenance, recorded in the commit message). */
  url: string;
  /** The downloaded file. */
  file: string;
  /** Expected sha256; a different file is refused. */
  sha256?: string;
};

export type PinOptions = {
  /** A bare repo holding the (mirrored) upstream history. */
  repoDir: string;
  /** Upstream tag or commit the version is built from. */
  ref: string;
  /** Human version; names the branch `sf/<version>`. */
  version: string;
  /** The upstream release tarball the pre-fork build used, when it is not simply the tagged tree. */
  release?: ReleaseArtifact;
  /** `.gitmodules` path -> fork repo name: rewrites submodule urls to `../<repo>.git` so a recursive clone stays inside the forge. */
  submoduleRepos?: Readonly<Record<string, string>>;
};

export type PinResult = {
  /** The commit to pin: the upstream commit itself, or our single commit on top of it. */
  sha: string;
  /** True when `sha` is a commit of ours (release import and/or submodule rewrite). */
  imported: boolean;
  /** The upstream commit `ref` resolves to. */
  upstreamSha: string;
  releaseSha256?: string;
  branch: string;
};

const sha256Of = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** Rewrites each listed submodule's `url =` to the sibling fork repo, keeping everything else byte for byte. */
export const rewriteGitmodules = (text: string, repos: Readonly<Record<string, string>>): string => {
  const sections = text.split(/(?=^\[submodule )/m);
  return sections
    .map((section) => {
      const submodulePath = /^\s*path\s*=\s*(.+?)\s*$/m.exec(section)?.[1];
      const repo = submodulePath === undefined ? undefined : repos[submodulePath];
      return repo === undefined ? section : section.replace(/^(\s*url\s*=\s*).+$/m, `$1../${repo}.git`);
    })
    .join("");
};

/**
 * Decides the commit a build pins for one library version and creates `refs/heads/sf/<version>` at it in `repoDir`.
 *
 * - No release tarball and no submodules to rewrite, or a tarball whose tree is exactly the tag's tree: the pin is
 *   the upstream commit itself (nothing of ours in the tree).
 * - Otherwise ONE commit of ours on top of the upstream commit whose tree is the release tarball's tree (generated
 *   `configure`, `VERSION` stamps, …: exactly what the build consumed before the forks) and/or the tag's tree with
 *   the `.gitmodules` urls pointing at the sibling forks. Author/dates are derived from the upstream commit, so the
 *   same inputs always produce the same sha.
 */
export const pinRelease = async (options: PinOptions): Promise<PinResult> => {
  const gitDir = { cwd: options.repoDir };
  const upstreamSha = await git(["rev-parse", `${options.ref}^{commit}`], gitDir);
  const upstreamTree = await git(["rev-parse", `${upstreamSha}^{tree}`], gitDir);
  const scratch = mkdtempSync(path.join(os.tmpdir(), "media-deps-pin-"));
  const index = path.join(scratch, "index");
  try {
    let releaseSha256: string | undefined;
    let tree = upstreamTree;
    if (options.release) {
      releaseSha256 = sha256Of(options.release.file);
      if (options.release.sha256 !== undefined && options.release.sha256 !== releaseSha256) {
        throw new Error(`release_sha256_mismatch:${options.release.url}:got ${releaseSha256} want ${options.release.sha256}`);
      }
      tree = await tarballTree(options.repoDir, options.release.file, scratch);
    }

    if (options.submoduleRepos) {
      const env = { GIT_INDEX_FILE: index };
      const original = await git(["show", `${tree}:.gitmodules`], gitDir);
      const file = path.join(scratch, ".gitmodules");
      writeFileSync(file, rewriteGitmodules(`${original}\n`, options.submoduleRepos));
      const blob = await git(["hash-object", "-w", file], gitDir);
      await git(["read-tree", tree], { ...gitDir, env });
      await git(["update-index", "--cacheinfo", `100644,${blob},.gitmodules`], { ...gitDir, env });
      tree = await git(["write-tree"], { ...gitDir, env });
    }

    let sha = upstreamSha;
    if (tree !== upstreamTree) {
      const date = await git(["show", "-s", "--format=%cI", upstreamSha], gitDir);
      const lines = [`sf: ${options.version} as the build consumes it`, ""];
      if (options.release && releaseSha256) {
        lines.push(
          `Tree = the upstream release artifact, which differs from the tagged tree of ${options.ref} (generated build files, version stamps).`,
          `Release artifact: ${options.release.url}`,
          `sha256: ${releaseSha256}`
        );
      }
      if (options.submoduleRepos) lines.push("Submodule urls point at the sibling forks (relative ../<repo>.git); gitlinks are untouched.");
      lines.push(`Upstream commit: ${upstreamSha}`, "");
      sha = await git(["commit-tree", tree, "-p", upstreamSha, "-m", lines.join("\n")], {
        ...gitDir,
        env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      });
    }
    const branch = sfBranchName(options.version);
    await git(["update-ref", `refs/heads/${branch}`, sha], gitDir);
    return { sha, imported: sha !== upstreamSha, upstreamSha, releaseSha256, branch };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};
