import { execFile } from "node:child_process";
import { cpSync, existsSync, lutimesSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { forkCloneUrl, forksBaseUrl, type ForgeAuth } from "./forks/git";
import { computeRecipeHash, dockerBuildArgs, getPackageRoot, packageName, packageVersion, targetSources } from "./plan";
import { isPublished, type FetchLike } from "./registry";
import { buildSourcesManifest } from "./sourceManifest";
import { loadTarget } from "./targets";
import type { DepsTarget } from "./target";

const execFileAsync = promisify(execFile);

export const SOURCES_MANIFEST_FILE_NAME = "SOURCES.json";

/** `media-deps-<target>-source.tar.gz`: the corresponding source of the bundle published next to it. */
export const sourceArchiveFileName = (target: Pick<DepsTarget, "id">) => `${packageName(target)}-source.tar.gz`;

/** What the archive tells a reader who wants to rebuild or audit the bundle (GPL/LGPL "written offer" fulfilled by the archive itself). */
const readmeText = (target: DepsTarget, version: string) => `Corresponding source of media-deps-${target.id} ${version}
==========================================================

This archive holds the exact source of every library compiled into the media-deps bundle of the same version
(ffmpeg, mpv, x264, x265, libplacebo, ... including their submodules), as plain trees:

  sources/<id>/     the tree of the pinned commit (git submodules checked out in place)
  recipe/           the Dockerfile + scripts that build the bundle, the feature list and the pin list
  build-args.json   the resolved docker build arguments (configure flags, pinned fork urls and commits)
  SOURCES.json      library, version, fork repository, pinned commit, upstream location and licence of every source

Every tree was fetched by commit id (recipe/_shared/fetch-source.sh refuses any other commit) from our fork of
the upstream project (https://github.com/spacefleet-io/<repo>), so it is byte for byte the tree the build
compiled. Local patches live on the fork branches sf/<version> and appear in SOURCES.json as the pinned commit (see "release" for a release tarball import).
`;

/** Runs the build's own fetch script, so the archive can never hold anything the build did not compile. */
const fetchTree = async (options: {
  script: string;
  id: string;
  url: string;
  sha: string;
  dest: string;
  submodules: boolean;
  authFile: string | undefined;
}) => {
  try {
    await execFileAsync("sh", [options.script, ...(options.submodules ? ["--submodules"] : []), options.id, options.url, options.sha, options.dest], {
      env: { ...process.env, ...(options.authFile ? { FORGE_AUTH_FILE: options.authFile } : {}) },
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : String(error);
    throw new Error(`source_fetch_failed:${options.id}:${stderr.trim()}`);
  }
};

export type BuildSourceArchiveOptions = {
  target: DepsTarget;
  /** Receives `<archive>` (the tar.gz). */
  archivePath: string;
  /** Only needed while the forks are private (or for a private mirror). */
  forgeAuth?: ForgeAuth;
  /** Where the forks live (`<base>/<repo>.git`); default forksBaseUrl(). */
  forksUrl?: string;
  packageRoot?: string;
};

/** Recipe files shipped in the archive, relative to the package root (a target's `recipeInputs` included). */
const recipePaths = (target: DepsTarget) => [
  path.join("recipes", "_shared"),
  path.join("recipes", target.id),
  ...(target.recipeInputs ?? []),
  path.join("src", "features.ts"),
  path.join("src", "sources.ts"),
];

/** Where a recipe file lands under `recipe/`: inputs outside the package (`../desktop-platform-macos/…`) go to `recipe/external/…`. */
const archiveRecipePath = (relative: string) => {
  const segments = path.normalize(relative).split(path.sep);
  const outside = segments.findIndex((segment) => segment !== "..");
  return outside > 0 ? path.join("external", ...segments.slice(outside)) : relative;
};

const walkSorted = (dir: string, prefix: string): string[] =>
  readdirSync(path.join(dir, prefix), { withFileTypes: true })
    .map((entry) => ({ entry, relative: `${prefix}/${entry.name}` }))
    .sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0))
    .flatMap(({ entry, relative }) => (entry.isDirectory() ? [relative, ...walkSorted(dir, relative)] : [relative]));

/**
 * `tar` of `<cwd>/<top>` with sorted entries, uid/gid 0 and every mtime 0. GNU tar (Linux runners) does it with
 * flags; bsdtar (macOS, Windows) has no --sort/--mtime, so the tree's times are zeroed and the sorted list is passed.
 */
const createReproducibleTar = async (cwd: string, top: string, tarFile: string) => {
  const version = await execFileAsync("tar", ["--version"]).then((out) => out.stdout, () => "");
  if (version.includes("GNU tar")) {
    await execFileAsync("tar", ["--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "-cf", tarFile, "-C", cwd, top]);
    return;
  }
  const entries = [top, ...walkSorted(cwd, top)];
  for (const entry of [...entries].reverse()) lutimesSync(path.join(cwd, entry), 0, 0);
  const list = path.join(path.dirname(tarFile), "source.list");
  writeFileSync(list, `${entries.join("\n")}\n`);
  await execFileAsync("tar", [
    "--uid", "0", "--gid", "0", "--numeric-owner", "--no-mac-metadata", "--no-xattrs", "--no-acls", "--no-fflags",
    "-n", "-cf", tarFile, "-C", cwd, "-T", list,
  ]);
};

/** Fetches every pinned tree of the target and packs them with the recipe and the manifest. Returns the manifest's package version. */
export const buildSourceArchive = async (options: BuildSourceArchiveOptions): Promise<{ version: string; recipeHash: string }> => {
  const packageRoot = options.packageRoot ?? getPackageRoot();
  const forksUrl = options.forksUrl ?? forksBaseUrl();
  const recipeHash = computeRecipeHash(options.target, packageRoot);
  const version = packageVersion(recipeHash);
  const staging = mkdtempSync(path.join(os.tmpdir(), "media-deps-source-"));
  const root = path.join(staging, `media-deps-${options.target.id}-source-${version}`);
  try {
    mkdirSync(path.join(root, "sources"), { recursive: true });
    let authFile: string | undefined;
    if (options.forgeAuth) {
      authFile = path.join(staging, "forge_auth");
      writeFileSync(authFile, `${options.forgeAuth.user}:${options.forgeAuth.token}`, { mode: 0o600 });
    }
    const script = path.join(packageRoot, "recipes", "_shared", "fetch-source.sh");
    for (const [id, spec] of Object.entries(targetSources(options.target))) {
      await fetchTree({
        script,
        id,
        url: forkCloneUrl(spec.repo, forksUrl),
        sha: spec.sha,
        dest: path.join(root, "sources", id),
        submodules: spec.submodules !== undefined,
        authFile,
      });
    }
    for (const relative of recipePaths(options.target)) {
      const from = path.join(packageRoot, relative);
      if (!existsSync(from)) throw new Error(`recipe_file_missing:${relative}`);
      cpSync(from, path.join(root, "recipe", archiveRecipePath(relative)), { recursive: true });
    }
    writeFileSync(path.join(root, "build-args.json"), `${JSON.stringify(dockerBuildArgs(options.target), null, 2)}\n`);
    writeFileSync(path.join(root, SOURCES_MANIFEST_FILE_NAME), `${JSON.stringify(buildSourcesManifest(options.target, recipeHash, forksUrl), null, 2)}\n`);
    writeFileSync(path.join(root, "README.txt"), readmeText(options.target, version));

    mkdirSync(path.dirname(options.archivePath), { recursive: true });
    // Sorted, owner-less, zero mtime: the same pins always give the same bytes (gzip -n: no name/time header).
    const tarFile = path.join(staging, "source.tar");
    await createReproducibleTar(staging, path.basename(root), tarFile);
    await execFileAsync("sh", ["-c", 'gzip -n -9 -c "$1" > "$2"', "sh", tarFile, options.archivePath]);
    return { version, recipeHash };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
};

export type SourceArchiveCheck = { target: string; version: string; url: string; published: boolean };

/**
 * The release gate: the media-deps a checkout bundles (content addressed by its recipe hash, exactly what
 * `fetch-deps` resolves) must have its corresponding-source archive published. `ok` is false when any is missing.
 */
export const checkSourceArchives = async (options: {
  targetIds: readonly string[];
  baseUrl?: string;
  fetchImpl?: FetchLike;
  token?: string;
  apiUrl?: string;
  packageRoot?: string;
}): Promise<{ ok: boolean; results: SourceArchiveCheck[] }> => {
  const results: SourceArchiveCheck[] = [];
  for (const targetId of options.targetIds) {
    const target = await loadTarget(targetId, options.packageRoot ?? getPackageRoot());
    const version = packageVersion(computeRecipeHash(target, options.packageRoot));
    const { published, url } = await isPublished({
      target,
      version,
      fileName: sourceArchiveFileName(target),
      baseUrl: options.baseUrl,
      fetchImpl: options.fetchImpl,
      token: options.token,
      apiUrl: options.apiUrl,
    });
    results.push({ target: target.id, version, url, published });
  }
  return { ok: results.every((result) => result.published), results };
};
