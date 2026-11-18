import { FEATURE_LIST_VERSION } from "./features";
import { forkCloneUrl, forksBaseUrl } from "./forks/git";
import { packageVersion, targetSources } from "./plan";
import type { SourceSpec } from "./sources";
import type { DepsTarget } from "./target";

/** One library (or submodule) of a bundle: what was built, from which commit of which fork, under which licence. */
export type SourceRecord = {
  id: string;
  version: string;
  /** Checkout directory inside the source archive (`sources/<id>`), or the submodule path inside its parent. */
  path: string;
  repo: string;
  forkUrl: string;
  /** The exact commit built (tip of the fork's `sf/<version>`). */
  sha: string;
  upstreamUrl: string;
  upstreamRef: string;
  license: string;
  /** Present when `sha` is a commit of ours holding an upstream release tarball's tree. */
  release?: { url: string; sha256: string };
  submodules?: SourceRecord[];
};

export type SourcesManifest = {
  schemaVersion: 1;
  target: string;
  packageVersion: string;
  recipeHash: string;
  featureListVersion: number;
  sources: SourceRecord[];
};

export const upstreamUrlOf = (spec: Pick<SourceSpec, "upstream">) =>
  spec.upstream.kind === "git" ? spec.upstream.url : spec.upstream.downloadUrl;

const recordOf = (id: string, spec: Omit<SourceSpec, "submodules"> & Pick<SourceSpec, "submodules">, entryPath: string, forksUrl: string): SourceRecord => ({
  id,
  version: spec.version,
  path: entryPath,
  repo: spec.repo,
  forkUrl: forkCloneUrl(spec.repo, forksUrl),
  sha: spec.sha,
  upstreamUrl: upstreamUrlOf(spec),
  upstreamRef: spec.upstreamRef,
  license: spec.license,
  ...(spec.release ? { release: spec.release } : {}),
  ...(spec.submodules
    ? { submodules: Object.entries(spec.submodules).map(([submodulePath, sub]) => recordOf(submodulePath, sub, submodulePath, forksUrl)) }
    : {}),
});

/** The licence + provenance table of one target's pinned sources (ids sorted: the file is deterministic). */
export const buildSourcesManifest = (target: DepsTarget, recipeHash: string, forksUrl = forksBaseUrl()): SourcesManifest => ({
  schemaVersion: 1,
  target: target.id,
  packageVersion: packageVersion(recipeHash),
  recipeHash,
  featureListVersion: FEATURE_LIST_VERSION,
  sources: Object.entries(targetSources(target))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, spec]) => recordOf(id, spec, `sources/${id}`, forksUrl)),
});
