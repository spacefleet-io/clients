import type { SourceSpec } from "../sources";

/** Submodule commits recorded in a tree: path -> sha (mode 160000 lines of `git ls-tree -r`). */
export const parseGitlinks = (lsTree: string): Record<string, string> =>
  Object.fromEntries(
    lsTree
      .split("\n")
      .map((line) => /^160000 commit ([0-9a-f]{40})\t(.+)$/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => [match[2] ?? "", match[1] ?? ""])
  );

/** `.gitmodules` path -> url. */
export const parseGitmodules = (text: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const block of text.split(/^\[submodule .*\]$/m).slice(1)) {
    const path = /^\s*path\s*=\s*(.+?)\s*$/m.exec(block)?.[1];
    const url = /^\s*url\s*=\s*(.+?)\s*$/m.exec(block)?.[1];
    if (path && url) out[path] = url;
  }
  return out;
};

/**
 * Problems of a pinned tree against its pin list: every submodule the build consumes must sit at exactly the
 * pinned commit and be fetched from the sibling fork (`../<repo>.git`), never from upstream. Empty = fine.
 */
export const gitlinkProblems = (
  submodules: Readonly<Record<string, Pick<SourceSpec, "repo" | "sha">>>,
  lsTree: string,
  gitmodules: string
): string[] => {
  const links = parseGitlinks(lsTree);
  const urls = parseGitmodules(gitmodules);
  return Object.entries(submodules).flatMap(([submodulePath, spec]) => {
    const found: string[] = [];
    if (links[submodulePath] !== spec.sha) found.push(`${submodulePath}: tree has ${links[submodulePath] ?? "no gitlink"}, pin is ${spec.sha}`);
    if (urls[submodulePath] !== `../${spec.repo}.git`) found.push(`${submodulePath}: .gitmodules url is ${urls[submodulePath] ?? "missing"}, want ../${spec.repo}.git`);
    return found;
  });
};
