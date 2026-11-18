import { SOURCES, type SourceSpec } from "../sources";

export type ForkEntry = {
  /** `ffmpeg`, or `libplacebo/3rdparty/glad` for a submodule. */
  id: string;
  spec: Omit<SourceSpec, "submodules">;
  /** Set for a submodule: the checkout path inside its parent. */
  submodulePath?: string;
  parent?: string;
  /** Parent only: submodule path -> fork repo name (rewrites `.gitmodules` in the pin commit). */
  submoduleRepos?: Readonly<Record<string, string>>;
  /** Parent only: the pinned submodules themselves. */
  submodules?: SourceSpec["submodules"];
};

/** Every fork the pin list needs: each source plus the submodules its build consumes. */
export const forkEntries = (sources: Readonly<Record<string, SourceSpec>> = SOURCES): ForkEntry[] =>
  Object.entries(sources).flatMap(([id, spec]) => [
    {
      id,
      spec,
      submodules: spec.submodules,
      submoduleRepos: spec.submodules
        ? Object.fromEntries(Object.entries(spec.submodules).map(([submodulePath, sub]) => [submodulePath, sub.repo]))
        : undefined,
    },
    ...Object.entries(spec.submodules ?? {}).map(([submodulePath, sub]) => ({
      id: `${id}/${submodulePath}`,
      spec: sub,
      submodulePath,
      parent: id,
    })),
  ]);

/**
 * One entry per fork repository: what `create` and `sync` walk. A repository can carry several pins (two
 * consumers needing different revisions of the same library, each on its own `sf/<version>` branch), but it is
 * created and mirrored once. Every pin of one repository must name the same upstream.
 */
export const forkRepos = (entries: readonly ForkEntry[] = forkEntries()): ForkEntry[] => {
  const byRepo = new Map<string, ForkEntry>();
  for (const entry of entries) {
    const first = byRepo.get(entry.spec.repo);
    if (!first) {
      byRepo.set(entry.spec.repo, entry);
      continue;
    }
    if (JSON.stringify(first.spec.upstream) !== JSON.stringify(entry.spec.upstream)) {
      throw new Error(`fork_upstream_conflict:${entry.spec.repo}:${first.id} vs ${entry.id}`);
    }
  }
  return [...byRepo.values()];
};

