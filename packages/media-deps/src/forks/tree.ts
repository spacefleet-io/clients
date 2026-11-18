import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { git } from "./git";

/**
 * The git tree object (written into `repoDir`) of a release tarball's content with its top-level directory
 * stripped. Ignored files count (`--force`): the tree is exactly what the tarball contains.
 */
export const tarballTree = async (repoDir: string, tarball: string, scratch: string): Promise<string> => {
  const work = path.join(scratch, "work");
  const index = path.join(scratch, "tarball-index");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  execFileSync("tar", ["-xf", tarball, "-C", work, "--strip-components=1"]);
  const env = { GIT_DIR: repoDir, GIT_WORK_TREE: work, GIT_INDEX_FILE: index };
  await git(["add", "--force", "--all", "."], { cwd: work, env });
  const tree = await git(["write-tree"], { cwd: work, env });
  rmSync(index, { force: true });
  return tree;
};

/** Newest mtime (ISO) under `dir`: a reproducible commit date for an import that has no upstream commit. */
export const newestMtime = (dir: string): string => {
  let newest = 0;
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const full = path.join(current, name);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else newest = Math.max(newest, stat.mtimeMs);
    }
  };
  walk(dir);
  return new Date(newest).toISOString();
};
