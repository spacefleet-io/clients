import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildManifest, createArchive, writeManifest } from "../src/bundle";
import { DEFAULT_RELEASES_URL, archiveFileName, computeRecipeHash, packageFileUrl, packageVersion, releaseTag } from "../src/plan";
import { ANONYMOUS_GITHUB_HINT, GITHUB_API_URL, GITHUB_UPLOADS_URL, SHA256_SUFFIX, fetchDeps, isBundleCurrent, isPublished, publishBundle, releasesToken, type FetchLike } from "../src/registry";
import { loadTarget } from "../src/targets";

const temps: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "media-deps-registry-"));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Builds a tiny fake bundle for linux-x64 whose manifest carries the CURRENT recipe hash. */
const makeBundle = async (recipeHash?: string) => {
  const target = await loadTarget("linux-x64");
  const hash = recipeHash ?? computeRecipeHash(target);
  const dir = tempDir();
  mkdirSync(path.join(dir, "bin"));
  writeFileSync(path.join(dir, "bin", "ffmpeg"), "fake ffmpeg");
  writeFileSync(path.join(dir, "bin", "libx.so"), "fake lib");
  writeManifest(dir, await buildManifest(dir, target, hash));
  const archive = path.join(dir, archiveFileName(target));
  await createArchive(dir, archive);
  const body = readFileSync(archive);
  return { target, hash, archive, body, sha256: createHash("sha256").update(body).digest("hex") };
};

/** Serves the archive + sidecar at the plain (public) release URLs and counts hits. */
const fakeRegistry = (bundle: Awaited<ReturnType<typeof makeBundle>>) => {
  const url = packageFileUrl(bundle.target, packageVersion(bundle.hash), archiveFileName(bundle.target), DEFAULT_RELEASES_URL);
  const hits: string[] = [];
  const fetchImpl: FetchLike = async (input: string | URL | Request, init?: RequestInit) => {
    const requested = String(input);
    hits.push(`${init?.method ?? "GET"} ${requested}`);
    if (requested === url) return new Response(bundle.body);
    if (requested === `${url}${SHA256_SUFFIX}`) return new Response(`${bundle.sha256}  x\n`);
    return new Response("nope", { status: 404 });
  };
  return { fetchImpl, hits, url };
};

/** A fake GitHub releases API for spacefleet-io/media-deps: release lookup/creation, asset upload/delete/download. */
const fakeGitHub = (initial: Record<string, Record<string, Uint8Array>> = {}) => {
  const releases = new Map<string, { id: number; assets: Map<string, Uint8Array> }>();
  let nextId = 1;
  for (const [tag, assets] of Object.entries(initial)) releases.set(tag, { id: nextId++, assets: new Map(Object.entries(assets)) });
  const calls: string[] = [];
  const auths: (string | undefined)[] = [];
  const repo = "/repos/spacefleet-io/media-deps";
  const assetUrl = (releaseId: number, name: string) => `${GITHUB_API_URL}${repo}/releases/assets/${releaseId}-${name}`;
  const json = (tag: string) => {
    const release = releases.get(tag)!;
    return Response.json({ id: release.id, tag_name: tag, assets: [...release.assets.keys()].map((name) => ({ id: 0, name, url: assetUrl(release.id, name) })) });
  };
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    auths.push((init?.headers as Record<string, string> | undefined)?.Authorization);
    if (url.startsWith("https://storage.example/")) {
      const [releaseId, name] = decodeURIComponent(url.slice("https://storage.example/".length)).split("/");
      const release = [...releases.values()].find((entry) => String(entry.id) === releaseId);
      calls.push(`STORAGE ${name}`);
      return new Response(release?.assets.get(name ?? "") ?? null, { status: release?.assets.has(name ?? "") ? 200 : 404 });
    }
    const tagged = url.match(/\/releases\/tags\/(.+)$/);
    if (tagged) {
      const tag = decodeURIComponent(tagged[1] ?? "");
      calls.push(`GET release`);
      return releases.has(tag) ? json(tag) : new Response("", { status: 404 });
    }
    if (url === `${GITHUB_API_URL}${repo}/releases` && method === "POST") {
      const tag = (JSON.parse(String(init?.body)) as { tag_name: string }).tag_name;
      calls.push("POST release");
      releases.set(tag, { id: nextId++, assets: new Map() });
      return json(tag);
    }
    const upload = url.match(/^https:\/\/uploads\.github\.com\/repos\/spacefleet-io\/media-deps\/releases\/(\d+)\/assets\?name=(.+)$/);
    if (upload && method === "POST") {
      const release = [...releases.values()].find((entry) => String(entry.id) === upload[1]);
      const name = decodeURIComponent(upload[2] ?? "");
      calls.push(`UPLOAD ${name.endsWith(SHA256_SUFFIX) ? "sidecar" : "file"}`);
      if (!release || release.assets.has(name)) return new Response("already_exists", { status: 422 });
      release.assets.set(name, new Uint8Array(init?.body as Uint8Array));
      return new Response("{}", { status: 201 });
    }
    const asset = url.match(/\/releases\/assets\/(\d+)-(.+)$/);
    if (asset) {
      const release = [...releases.values()].find((entry) => String(entry.id) === asset[1]);
      const name = asset[2] ?? "";
      if (method === "DELETE") {
        calls.push(`DELETE ${name.endsWith(SHA256_SUFFIX) ? "sidecar" : "file"}`);
        release?.assets.delete(name);
        return new Response(null, { status: 204 });
      }
      calls.push(`GET asset`);
      return new Response(null, { status: 302, headers: { location: `https://storage.example/${asset[1]}/${encodeURIComponent(name)}` } });
    }
    return new Response("unexpected", { status: 500 });
  };
  return { fetchImpl, calls, auths, releases };
};

describe("fetchDeps", () => {
  const plain = { token: "", log: () => {} };

  it("downloads, verifies and extracts into vendor/deps/<target>, then no-ops", async () => {
    const bundle = await makeBundle();
    const registry = fakeRegistry(bundle);
    const repoRoot = tempDir();
    const cacheDir = tempDir();
    const first = await fetchDeps({ targetId: "linux-x64", repoRoot, cacheDir, fetchImpl: registry.fetchImpl, ...plain });
    expect(first.status).toBe("fetched");
    expect(readFileSync(path.join(repoRoot, "vendor", "deps", "linux-x64", "bin", "ffmpeg"), "utf8")).toBe("fake ffmpeg");
    expect(isBundleCurrent(first.dir, bundle.hash)).toBe(true);
    expect(registry.url).toBe(
      `https://github.com/spacefleet-io/media-deps/releases/download/media-deps-linux-x64-${packageVersion(bundle.hash)}/media-deps-linux-x64.tar.gz`
    );

    const hitsAfterFirst = registry.hits.length;
    const second = await fetchDeps({ targetId: "linux-x64", repoRoot, cacheDir, fetchImpl: registry.fetchImpl, ...plain });
    expect(second.status).toBe("cached");
    expect(registry.hits.length).toBe(hitsAfterFirst);
    // Builds a real tar bundle, downloads and extracts it twice: over the 5 s default on a loaded CI runner (run 34650).
  }, 30_000);

  it("reuses the download cache after vendor/ is wiped (sidecar only)", async () => {
    const bundle = await makeBundle();
    const registry = fakeRegistry(bundle);
    const cacheDir = tempDir();
    await fetchDeps({ targetId: "linux-x64", repoRoot: tempDir(), cacheDir, fetchImpl: registry.fetchImpl, ...plain });
    const before = registry.hits.filter((hit) => hit === `GET ${registry.url}`).length;
    await fetchDeps({ targetId: "linux-x64", repoRoot: tempDir(), cacheDir, fetchImpl: registry.fetchImpl, ...plain });
    expect(registry.hits.filter((hit) => hit === `GET ${registry.url}`).length).toBe(before);
  }, 30_000);

  it("rejects an archive whose sha256 differs from the sidecar", async () => {
    const bundle = await makeBundle();
    const registry = fakeRegistry({ ...bundle, sha256: "0".repeat(64) });
    await expect(
      fetchDeps({ targetId: "linux-x64", repoRoot: tempDir(), cacheDir: tempDir(), fetchImpl: registry.fetchImpl, ...plain })
    ).rejects.toThrow("sha256_mismatch");
  });

  it("rejects a bundle built from another recipe and leaves vendor/ untouched", async () => {
    const stale = await makeBundle("b".repeat(64));
    const current = await makeBundle();
    // Serve the stale archive under the current version's URL.
    const registry = fakeRegistry({ ...stale, hash: current.hash });
    const repoRoot = tempDir();
    await expect(
      fetchDeps({ targetId: "linux-x64", repoRoot, cacheDir: tempDir(), fetchImpl: registry.fetchImpl, ...plain })
    ).rejects.toThrow("recipe_hash_mismatch");
    expect(existsSync(path.join(repoRoot, "vendor", "deps", "linux-x64"))).toBe(false);
  });

  it("fails clearly when the version is not published", async () => {
    const fetchImpl: FetchLike = async () => new Response("", { status: 404 });
    await expect(
      fetchDeps({ targetId: "linux-x64", repoRoot: tempDir(), cacheDir: tempDir(), fetchImpl, ...plain })
    ).rejects.toThrow("download_failed:404");
  });

  // @req REL-DEPS-05[ci]
  it("without a token, a 404 from the private GitHub releases names the missing token, not a missing bundle", async () => {
    const fetchImpl: FetchLike = async () => new Response("", { status: 404 });
    const error = (await fetchDeps({ targetId: "linux-x64", repoRoot: tempDir(), cacheDir: tempDir(), fetchImpl, ...plain }).catch((caught) => caught)) as Error;
    expect(error.message.startsWith(`download_failed:404:${DEFAULT_RELEASES_URL}/`)).toBe(true);
    expect(error.message.endsWith(ANONYMOUS_GITHUB_HINT)).toBe(true);
    expect(ANONYMOUS_GITHUB_HINT).toContain("MEDIA_DEPS_GH_TOKEN");
  });

  // @req REL-DEPS-05[ci]
  it("a 404 from a mirror (MEDIA_DEPS_BASE_URL) is a plain not-published error, with no token hint", async () => {
    const fetchImpl: FetchLike = async () => new Response("", { status: 404 });
    const error = (await fetchDeps({ targetId: "linux-x64", repoRoot: tempDir(), cacheDir: tempDir(), baseUrl: "https://mirror.example/deps", fetchImpl, ...plain }).catch((caught) => caught)) as Error;
    expect(error.message.startsWith("download_failed:404:https://mirror.example/deps/")).toBe(true);
    expect(error.message).not.toContain("no GitHub token");
  });

  it("reads a private release through the API with the token, and follows the storage redirect without it", async () => {
    const bundle = await makeBundle();
    const tag = releaseTag(bundle.target, packageVersion(bundle.hash));
    const github = fakeGitHub({
      [tag]: { [archiveFileName(bundle.target)]: bundle.body, [`${archiveFileName(bundle.target)}${SHA256_SUFFIX}`]: Buffer.from(`${bundle.sha256}  x\n`) },
    });
    const result = await fetchDeps({ targetId: "linux-x64", repoRoot: tempDir(), cacheDir: tempDir(), fetchImpl: github.fetchImpl, token: "tok", log: () => {} });
    expect(result.status).toBe("fetched");
    expect(github.calls).toEqual(["GET release", "GET asset", "STORAGE media-deps-linux-x64.tar.gz.sha256", "GET asset", "STORAGE media-deps-linux-x64.tar.gz"]);
    expect(github.auths).toEqual(["Bearer tok", "Bearer tok", undefined, "Bearer tok", undefined]);
  });

  it("reads a mirror (MEDIA_DEPS_BASE_URL) anonymously, even with a token", async () => {
    const bundle = await makeBundle();
    const mirror = "https://mirror.example/deps";
    const url = packageFileUrl(bundle.target, packageVersion(bundle.hash), archiveFileName(bundle.target), mirror);
    const seen: { url: string; auth?: string }[] = [];
    const fetchImpl: FetchLike = async (input, init) => {
      seen.push({ url: String(input), auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
      if (String(input) === url) return new Response(bundle.body);
      if (String(input) === `${url}${SHA256_SUFFIX}`) return new Response(`${bundle.sha256}  x\n`);
      return new Response("", { status: 404 });
    };
    await fetchDeps({ targetId: "linux-x64", repoRoot: tempDir(), cacheDir: tempDir(), baseUrl: mirror, fetchImpl, token: "tok", log: () => {} });
    expect(seen).toEqual([{ url: `${url}${SHA256_SUFFIX}`, auth: undefined }, { url, auth: undefined }]);
  });
});

describe("releasesToken", () => {
  it("prefers MEDIA_DEPS_GH_TOKEN, then GH_TOKEN, then the git credential of github.com", () => {
    const git = (host: string) => (host === "github.com" ? { user: "g", token: "gt" } : undefined);
    expect(releasesToken({ MEDIA_DEPS_GH_TOKEN: "m", GH_TOKEN: "h" }, git)).toBe("m");
    expect(releasesToken({ GH_TOKEN: "h" }, git)).toBe("h");
    expect(releasesToken({}, git)).toBe("gt");
    expect(releasesToken({}, () => undefined)).toBeUndefined();
  });

  it("isPublished treats 404 as unpublished and a refused HEAD (401) as an error, never as unpublished", async () => {
    const target = { id: "linux-x64" };
    const status = (code: number): FetchLike => async () => new Response("", { status: code });
    expect((await isPublished({ target, version: "v", fileName: "f", fetchImpl: status(404), token: "" })).published).toBe(false);
    expect((await isPublished({ target, version: "v", fileName: "f", fetchImpl: status(200), token: "" })).published).toBe(true);
    await expect(isPublished({ target, version: "v", fileName: "f", fetchImpl: status(401), token: "" })).rejects.toThrow("registry_head_failed:401");
  });

  it("isPublished on a private release looks for the sidecar asset", async () => {
    const target = { id: "linux-x64" };
    const github = fakeGitHub({ [releaseTag(target, "v")]: { f: new Uint8Array(), [`g${SHA256_SUFFIX}`]: new Uint8Array() } });
    expect((await isPublished({ target, version: "v", fileName: "f", fetchImpl: github.fetchImpl, token: "t" })).published).toBe(false);
    expect((await isPublished({ target, version: "v", fileName: "g", fetchImpl: github.fetchImpl, token: "t" })).published).toBe(true);
    expect((await isPublished({ target, version: "w", fileName: "g", fetchImpl: github.fetchImpl, token: "t" })).published).toBe(false);
  });
});

describe("publishBundle", () => {
  const publish = async (bundle: Awaited<ReturnType<typeof makeBundle>>, fetchImpl: FetchLike) =>
    publishBundle({ target: bundle.target, recipeHash: bundle.hash, archivePath: bundle.archive, token: "t", fetchImpl, log: () => {} });

  it("skips a file whose sidecar is already in the release", async () => {
    const bundle = await makeBundle();
    const name = archiveFileName(bundle.target);
    const github = fakeGitHub({ [releaseTag(bundle.target, packageVersion(bundle.hash))]: { [name]: bundle.body, [`${name}${SHA256_SUFFIX}`]: new Uint8Array() } });
    const result = await publish(bundle, github.fetchImpl);
    expect(result.status).toBe("exists");
    expect(github.calls).toEqual(["GET release"]);
    expect(github.auths).toEqual(["Bearer t"]);
  });

  it("creates the release, uploads the archive, then the sidecar", async () => {
    const bundle = await makeBundle();
    const github = fakeGitHub();
    const result = await publish(bundle, github.fetchImpl);
    expect(result.status).toBe("published");
    expect(result.url).toBe(packageFileUrl(bundle.target, packageVersion(bundle.hash), archiveFileName(bundle.target), DEFAULT_RELEASES_URL));
    expect(github.calls).toEqual(["GET release", "POST release", "UPLOAD file", "UPLOAD sidecar"]);
    const assets = github.releases.get(releaseTag(bundle.target, packageVersion(bundle.hash)))?.assets;
    expect(Buffer.from(assets?.get(`${archiveFileName(bundle.target)}${SHA256_SUFFIX}`) ?? []).toString()).toBe(`${result.sha256}  ${archiveFileName(bundle.target)}\n`);
    expect(execFileSync("tar", ["-tzf", bundle.archive]).toString()).toContain("deps-manifest.json");
  });

  it("replaces an archive left behind without its sidecar", async () => {
    const bundle = await makeBundle();
    const github = fakeGitHub({ [releaseTag(bundle.target, packageVersion(bundle.hash))]: { [archiveFileName(bundle.target)]: new Uint8Array([1]) } });
    const result = await publish(bundle, github.fetchImpl);
    expect(result.status).toBe("published");
    expect(github.calls).toEqual(["GET release", "DELETE file", "UPLOAD file", "UPLOAD sidecar"]);
  });

  it("@bugfix @regression-proof leaves a concurrently completed publish alone: an upload refused as existing is never deleted", async () => {
    const bundle = await makeBundle();
    const github = fakeGitHub();
    const fetchImpl: FetchLike = async (input, init) => {
      // Another run for the same recipe hash uploads the archive while ours is creating the release.
      if (String(input).startsWith(GITHUB_UPLOADS_URL) && !String(input).includes("sha256")) {
        const release = [...github.releases.values()][0];
        release?.assets.set(archiveFileName(bundle.target), bundle.body);
      }
      return github.fetchImpl(input, init);
    };
    const result = await publish(bundle, fetchImpl);
    expect(result.status).toBe("exists");
    expect(github.calls).toEqual(["GET release", "POST release", "UPLOAD file"]);
  });
});
