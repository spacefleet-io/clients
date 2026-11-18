import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { FEATURE_LIST_VERSION, FFMPEG_VERSION, LIBPLACEBO_REF, MPV_VERSION } from "./features";
import { targetSources } from "./plan";
import type { DepsTarget } from "./target";

const execFileAsync = promisify(execFile);

export const MANIFEST_FILE_NAME = "deps-manifest.json";
export const MANIFEST_SCHEMA_VERSION = 2;

/**
 * `deps-manifest.json`, shipped at the bundle root: what the bundle is and the hash of every file in it.
 * The bundle root holds `bin/` and, per OS, more (macOS: `lib/` and `Badger Player.app/`).
 */
export type DepsManifest = {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  featureListVersion: number;
  target: string;
  os: DepsTarget["os"];
  arch: DepsTarget["arch"];
  recipeHash: string;
  versions: Record<string, string>;
  /** Where each library came from: the fork repository, the exact commit built and its licence (full table: the source archive's SOURCES.json). */
  sources: Record<string, { repo: string; sha: string; license: string }>;
  /** POSIX paths relative to the bundle root (`bin/ffmpeg`, `lib/libavcodec.62.dylib`, …). */
  files: Record<string, { sha256: string; size: number }>;
};

/** The top-level entries of a bundle (`bin`, `lib`, `Badger Player.app`), read from its manifest. */
export const bundleEntries = (manifest: Pick<DepsManifest, "files">): string[] =>
  [...new Set(Object.keys(manifest.files).map((name) => name.split("/")[0] ?? name))].sort();

export const sha256File = async (file: string): Promise<string> => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
};

/** Every regular file under `dir`, as POSIX paths relative to it. A symlink is refused: the bundle ships real files only. */
const listBundleFiles = (dir: string, prefix = ""): string[] =>
  readdirSync(path.join(dir, prefix), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`bundle_contains_symlink:${relative}`);
      return entry.isDirectory() ? listBundleFiles(dir, relative) : [relative];
    });

/** Builds the manifest of the bundle in `bundleDir` (call before anything else, e.g. the archive, lands there). */
export const buildManifest = async (bundleDir: string, target: DepsTarget, recipeHash: string): Promise<DepsManifest> => {
  const files: DepsManifest["files"] = {};
  for (const name of listBundleFiles(bundleDir)) {
    if (name === MANIFEST_FILE_NAME) continue;
    const full = path.join(bundleDir, name);
    files[name] = { sha256: await sha256File(full), size: statSync(full).size };
  }
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    featureListVersion: FEATURE_LIST_VERSION,
    target: target.id,
    os: target.os,
    arch: target.arch,
    recipeHash,
    versions: {
      ffmpeg: FFMPEG_VERSION,
      mpv: MPV_VERSION,
      libplacebo: LIBPLACEBO_REF,
      ...Object.fromEntries(Object.entries(targetSources(target)).map(([id, spec]) => [id, spec.version])),
    },
    sources: Object.fromEntries(
      Object.entries(targetSources(target)).map(([id, spec]) => [id, { repo: spec.repo, sha: spec.sha, license: spec.license }])
    ),
    files,
  };
};

export const writeManifest = (dir: string, manifest: DepsManifest) =>
  writeFileSync(path.join(dir, MANIFEST_FILE_NAME), `${JSON.stringify(manifest, null, 2)}\n`);

export const readManifest = (dir: string): DepsManifest =>
  JSON.parse(readFileSync(path.join(dir, MANIFEST_FILE_NAME), "utf8")) as DepsManifest;

/** Packs the bundle in `dir` (the top-level entries its manifest lists + the manifest) into `archivePath` (host `tar`; bsdtar on Windows). */
export const createArchive = async (dir: string, archivePath: string) => {
  await execFileAsync("tar", ["-czf", archivePath, "-C", dir, ...bundleEntries(readManifest(dir)), MANIFEST_FILE_NAME]);
};

export const extractArchive = async (archivePath: string, destDir: string) => {
  await execFileAsync("tar", ["-xzf", archivePath, "-C", destDir]);
};
