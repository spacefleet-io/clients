import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MANIFEST_FILE_NAME,
  MANIFEST_SCHEMA_VERSION,
  extractArchive,
  readManifest,
  sha256File,
  type DepsManifest,
} from "./bundle";
import { githubTokenFromEnv } from "./forks/git";
import {
  DEFAULT_RELEASES_URL,
  RELEASES_REPO,
  archiveFileName,
  computeRecipeHash,
  getPackageRoot,
  packageFileUrl,
  packageName,
  packageVersion,
  releaseTag,
  releasesBaseUrl,
} from "./plan";
import { loadTarget } from "./targets";
import type { DepsTarget } from "./target";

export const SHA256_SUFFIX = ".sha256";

export const defaultCacheDir = () => path.join(os.homedir(), ".cache", "spacefleet", "deps");

/**
 * The GitHub token for READING the releases while the repository is private (public releases need none):
 * MEDIA_DEPS_GH_TOKEN, then GH_TOKEN, then the git credential stored for github.com (`git credential fill`, never
 * prompting; `gh auth setup-git` provides one). Undefined when none is set: downloads then use the plain release URLs.
 */
export const releasesToken = (
  env: Record<string, string | undefined> = process.env,
  gitCredential: (host: string) => { user: string; token: string } | undefined = gitCredentialFill
): string | undefined => githubTokenFromEnv(env) ?? gitCredential("github.com")?.token;

/** The credential git's helpers hold for `https://<host>`, without prompting; undefined when there is none. */
export const gitCredentialFill = (host: string): { user: string; token: string } | undefined => {
  const result = spawnSync("git", ["credential", "fill"], {
    input: `protocol=https\nhost=${host}\n\n`,
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" },
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return undefined;
  const fields = Object.fromEntries(
    result.stdout
      .split("\n")
      .map((line) => line.split(/=(.*)/s, 2) as [string, string])
      .filter(([key]) => key)
  );
  return fields.username && fields.password ? { user: fields.username, token: fields.password } : undefined;
};

/**
 * The slice of `fetch` this module uses. Not `typeof fetch`, which in Bun also
 * demands the `preconnect` static that injected test doubles do not have.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const GITHUB_API_URL = "https://api.github.com";
export const GITHUB_UPLOADS_URL = "https://uploads.github.com";

type ReleaseAsset = { id: number; name: string; url: string };
type Release = { id: number; tag_name: string; assets: ReleaseAsset[] };

/** The GitHub releases API of RELEASES_REPO, authenticated with `token`. */
export type ReleasesApi = { token: string; fetchImpl: FetchLike; apiUrl?: string; uploadsUrl?: string; repo?: string };

const apiHeaders = (token: string, extra: Record<string, string> = {}) => ({
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2022-11-28",
  ...extra,
});

const repoPath = (api: ReleasesApi) => `/repos/${api.repo ?? RELEASES_REPO}`;

/** The release of `tag`; undefined when there is none (404). */
const getRelease = async (api: ReleasesApi, tag: string): Promise<Release | undefined> => {
  const url = `${api.apiUrl ?? GITHUB_API_URL}${repoPath(api)}/releases/tags/${encodeURIComponent(tag)}`;
  const response = await api.fetchImpl(url, { headers: apiHeaders(api.token) });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`release_lookup_failed:${response.status}:${tag}`);
  return (await response.json()) as Release;
};

/** Creates the release of `tag` (and its tag, on the default branch); a concurrent creation is reused. */
const ensureRelease = async (api: ReleasesApi, tag: string, body: string): Promise<Release> => {
  const existing = await getRelease(api, tag);
  if (existing) return existing;
  const response = await api.fetchImpl(`${api.apiUrl ?? GITHUB_API_URL}${repoPath(api)}/releases`, {
    method: "POST",
    headers: apiHeaders(api.token, { "Content-Type": "application/json" }),
    body: JSON.stringify({ tag_name: tag, name: tag, body, draft: false, prerelease: false, make_latest: "false" }),
  });
  if (response.ok) return (await response.json()) as Release;
  // 422: the tag's release was created meanwhile.
  const raced = response.status === 422 ? await getRelease(api, tag) : undefined;
  if (raced) return raced;
  throw new Error(`release_create_failed:${response.status}:${tag}:${(await response.text()).slice(0, 300)}`);
};

/** Downloads a release asset through the API (works on a private repository); the storage redirect is followed without the token. */
const downloadAsset = async (api: ReleasesApi, asset: ReleaseAsset): Promise<Buffer> => {
  const response = await api.fetchImpl(asset.url, { headers: apiHeaders(api.token, { Accept: "application/octet-stream" }), redirect: "manual" });
  const location = response.headers.get("location");
  const final = response.status >= 300 && response.status < 400 && location ? await api.fetchImpl(location) : response;
  if (!final.ok) throw new Error(`download_failed:${final.status}:${asset.url}`);
  return Buffer.from(await final.arrayBuffer());
};

/** Appended to an anonymous GitHub 404: on a fresh host the usual cause is the missing read token, not a missing bundle. */
export const ANONYMOUS_GITHUB_HINT = ` (no GitHub token: ${RELEASES_REPO} is private, so GitHub answers 404 to an anonymous download even when the release is published; set MEDIA_DEPS_GH_TOKEN or GH_TOKEN, or store a github.com git credential with \`gh auth setup-git\`)`;

/** Where one published version's files are read from: the plain release URLs, or the API when a token is at hand. */
export type ReleaseFiles = {
  url: (file: string) => string;
  /** True when `file` is published (404 / missing asset: false; any other failure throws). */
  exists: (file: string) => Promise<boolean>;
  get: (file: string) => Promise<Buffer>;
};

export const releaseFiles = (options: {
  target: Pick<DepsTarget, "id">;
  version: string;
  /** A mirror (`<base>/<tag>/<file>`); default MEDIA_DEPS_BASE_URL, else the GitHub releases. */
  baseUrl?: string;
  /** Read through the GitHub API with this token (private repository); ignored for a mirror. */
  token?: string;
  fetchImpl?: FetchLike;
  apiUrl?: string;
}): ReleaseFiles => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? releasesBaseUrl();
  const url = (file: string) => packageFileUrl(options.target, options.version, file, baseUrl);
  if (!options.token || baseUrl !== DEFAULT_RELEASES_URL) {
    return {
      url,
      exists: async (file) => {
        const response = await fetchImpl(url(file), { method: "HEAD" });
        if (response.ok) return true;
        if (response.status === 404) return false;
        throw new Error(`registry_head_failed:${response.status}:${url(file)}`);
      },
      get: async (file) => {
        const response = await fetchImpl(url(file));
        if (response.ok) return Buffer.from(await response.arrayBuffer());
        // While RELEASES_REPO is private, GitHub answers 404 to an anonymous download of a published file too, so
        // without a token a 404 says nothing about publication: name the missing token instead of "not published".
        const anonymousGitHub = response.status === 404 && baseUrl === DEFAULT_RELEASES_URL;
        throw new Error(`download_failed:${response.status}:${url(file)}${anonymousGitHub ? ANONYMOUS_GITHUB_HINT : ""}`);
      },
    };
  }
  const api: ReleasesApi = { token: options.token, fetchImpl, apiUrl: options.apiUrl };
  let release: Promise<Release | undefined> | undefined;
  const asset = async (file: string) => (await (release ??= getRelease(api, releaseTag(options.target, options.version))))?.assets.find((entry) => entry.name === file);
  return {
    url,
    exists: async (file) => (await asset(file)) !== undefined,
    get: async (file) => {
      const found = await asset(file);
      if (!found) throw new Error(`download_failed:404:${url(file)}`);
      return downloadAsset(api, found);
    },
  };
};

/** Where a target's bundle lives in a checkout: `<repo>/vendor/deps/<target>/{bin/,…,deps-manifest.json}`. */
export const vendorDepsDir = (repoRoot: string, targetId: string) => path.join(repoRoot, "vendor", "deps", targetId);

/** True when `dir` already holds the bundle built from `recipeHash`, with every file intact (size). */
export const isBundleCurrent = (dir: string, recipeHash: string): boolean => {
  if (!existsSync(path.join(dir, MANIFEST_FILE_NAME))) return false;
  try {
    const manifest = readManifest(dir);
    if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION || manifest.recipeHash !== recipeHash) return false;
    return Object.entries(manifest.files).every(([name, file]) => {
      const full = path.join(dir, name);
      return existsSync(full) && statSync(full).size === file.size;
    });
  } catch {
    return false;
  }
};

export type FetchDepsOptions = {
  /** Target id; defaults to the host's. */
  targetId: string;
  repoRoot: string;
  cacheDir?: string;
  /** A mirror of the releases; default MEDIA_DEPS_BASE_URL, else the GitHub releases. */
  baseUrl?: string;
  fetchImpl?: FetchLike;
  packageRoot?: string;
  log?: (line: string) => void;
  /** GitHub token for a private releases repository; resolved by releasesToken() when omitted. */
  token?: string;
  apiUrl?: string;
};

export type FetchDepsResult = { status: "cached" | "fetched"; dir: string; target: DepsTarget; version: string; manifest: DepsManifest };

/**
 * Makes `vendor/deps/<target>/` hold the published bundle that matches the checked-out recipe.
 * The version is content addressed (recipe hash of THIS checkout), so there is no lockfile to
 * bump: a recipe change in a PR resolves to that PR's own build. Idempotent; downloads are
 * cached by version and verified against the `.sha256` sidecar and the manifest's per-file hashes.
 */
export const fetchDeps = async (options: FetchDepsOptions): Promise<FetchDepsResult> => {
  const log = options.log ?? ((line: string) => console.info(line));
  const fetchImpl = options.fetchImpl ?? fetch;
  const target = await loadTarget(options.targetId, options.packageRoot ?? getPackageRoot());
  const recipeHash = computeRecipeHash(target, options.packageRoot);
  const version = packageVersion(recipeHash);
  const dir = vendorDepsDir(options.repoRoot, target.id);

  if (isBundleCurrent(dir, recipeHash)) {
    log(`[media-deps] ${target.id} ${version} already in ${dir}`);
    return { status: "cached", dir, target, version, manifest: readManifest(dir) };
  }

  const cacheDir = path.join(options.cacheDir ?? defaultCacheDir(), target.id, version);
  mkdirSync(cacheDir, { recursive: true });
  const archivePath = path.join(cacheDir, archiveFileName(target));
  const baseUrl = options.baseUrl ?? releasesBaseUrl();
  const files = releaseFiles({
    target,
    version,
    baseUrl,
    // A mirror is read anonymously; only the GitHub releases may need the token while private.
    token: baseUrl === DEFAULT_RELEASES_URL ? (options.token ?? releasesToken()) : undefined,
    fetchImpl,
    apiUrl: options.apiUrl,
  });
  const archiveUrl = files.url(archiveFileName(target));
  const expected = (
    await files.get(`${archiveFileName(target)}${SHA256_SUFFIX}`).then((body) => body.toString("utf8").trim().split(/\s+/)[0] ?? "")
  ).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error(`bad_sha256_sidecar:${archiveUrl}`);

  if (!existsSync(archivePath) || (await sha256File(archivePath)) !== expected) {
    log(`[media-deps] downloading ${archiveUrl}`);
    const body = await files.get(archiveFileName(target));
    const got = createHash("sha256").update(body).digest("hex");
    if (got !== expected) throw new Error(`sha256_mismatch:${archiveUrl}:got ${got} want ${expected}`);
    writeFileSync(archivePath, body);
  }

  mkdirSync(path.dirname(dir), { recursive: true });
  const staging = mkdtempSync(path.join(path.dirname(dir), `.${target.id}-`));
  try {
    await extractArchive(archivePath, staging);
    const manifest = readManifest(staging);
    if (manifest.recipeHash !== recipeHash) throw new Error(`recipe_hash_mismatch:${manifest.recipeHash} != ${recipeHash}`);
    for (const [name, file] of Object.entries(manifest.files)) {
      const got = await sha256File(path.join(staging, name));
      if (got !== file.sha256) throw new Error(`file_sha256_mismatch:${name}`);
    }
    rmSync(dir, { recursive: true, force: true });
    renameSync(staging, dir);
    log(`[media-deps] ${target.id} ${version} -> ${dir}`);
    return { status: "fetched", dir, target, version, manifest };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
};

export type PublishOptions = {
  target: DepsTarget;
  recipeHash: string;
  archivePath: string;
  /** Release asset name; the bundle by default (the source archive publishes next to it under its own name). */
  fileName?: string;
  /** GitHub token with contents:write on RELEASES_REPO. */
  token: string;
  fetchImpl?: FetchLike;
  apiUrl?: string;
  uploadsUrl?: string;
  log?: (line: string) => void;
};

const releaseBody = (target: Pick<DepsTarget, "id">, version: string) =>
  `ffmpeg, mpv and their libraries for ${target.id}, recipe version ${version}, built from the pinned commits of the ` +
  `spacefleet-io forks.\n\n${packageName(target)}-source.tar.gz is the corresponding source: every library tree, the build ` +
  `recipe and SOURCES.json (licence, fork and upstream of each library). Each file has a .sha256 sidecar.\n`;

/**
 * Uploads a file as an asset of the target's release `media-deps-<target>-<version>` (created when missing), the
 * `.sha256` sidecar last; a file whose sidecar is already published is left untouched.
 */
export const publishBundle = async (options: PublishOptions): Promise<{ status: "published" | "exists"; url: string; sha256: string }> => {
  const log = options.log ?? ((line: string) => console.info(line));
  const api: ReleasesApi = { token: options.token, fetchImpl: options.fetchImpl ?? fetch, apiUrl: options.apiUrl, uploadsUrl: options.uploadsUrl };
  const version = packageVersion(options.recipeHash);
  const tag = releaseTag(options.target, version);
  const fileName = options.fileName ?? archiveFileName(options.target);
  const sidecarName = `${fileName}${SHA256_SUFFIX}`;
  const url = packageFileUrl(options.target, version, fileName, DEFAULT_RELEASES_URL);
  const sha256 = await sha256File(options.archivePath);

  const release = await ensureRelease(api, tag, releaseBody(options.target, version));
  if (release.assets.some((asset) => asset.name === sidecarName)) {
    log(`[media-deps] ${options.target.id} ${version} ${fileName} is already published`);
    return { status: "exists", url, sha256 };
  }
  const orphan = release.assets.find((asset) => asset.name === fileName);
  if (orphan) {
    // A run that died between the two uploads left this file without its sidecar: drop it, then upload again.
    log(`[media-deps] ${fileName} exists without a sidecar: replacing the orphaned upload`);
    const removed = await api.fetchImpl(orphan.url, { method: "DELETE", headers: apiHeaders(api.token) });
    if (!removed.ok && removed.status !== 404) throw new Error(`publish_failed:${removed.status}:DELETE ${orphan.url}`);
  }
  /** Returns false when a concurrent run uploaded this very name (the content address makes its bytes ours). */
  const upload = async (name: string, body: Buffer): Promise<boolean> => {
    const target = `${api.uploadsUrl ?? GITHUB_UPLOADS_URL}${repoPath(api)}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`;
    const response = await api.fetchImpl(target, {
      method: "POST",
      headers: apiHeaders(api.token, { "Content-Type": "application/octet-stream" }),
      body: new Uint8Array(body),
    });
    if (response.status === 422) return false;
    if (!response.ok) throw new Error(`publish_failed:${response.status}:${name}:${(await response.text()).slice(0, 300)}`);
    return true;
  };
  const concurrent = () => {
    log(`[media-deps] ${options.target.id} ${version} ${fileName} was published concurrently`);
    return { status: "exists" as const, url, sha256 };
  };
  if (!(await upload(fileName, readFileSync(options.archivePath)))) return concurrent();
  // Written last: a half-uploaded version (file without sidecar) is replaced on the next run, never fetched.
  if (!(await upload(sidecarName, Buffer.from(`${sha256}  ${fileName}\n`)))) return concurrent();
  log(`[media-deps] published ${options.target.id} ${version} ${fileName} sha256=${sha256}`);
  return { status: "published", url, sha256 };
};

/** True when the release of this recipe version holds `fileName` completely (the sidecar is uploaded last). */
export const isPublished = async (options: {
  target: Pick<DepsTarget, "id">;
  version: string;
  fileName: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  /** GitHub token (private repository); resolved by releasesToken() when omitted. */
  token?: string;
  apiUrl?: string;
}): Promise<{ published: boolean; url: string }> => {
  const baseUrl = options.baseUrl ?? releasesBaseUrl();
  const files = releaseFiles({
    ...options,
    baseUrl,
    token: baseUrl === DEFAULT_RELEASES_URL ? (options.token ?? releasesToken()) : undefined,
  });
  return { published: await files.exists(`${options.fileName}${SHA256_SUFFIX}`), url: files.url(options.fileName) };
};
