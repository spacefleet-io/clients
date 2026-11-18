import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { computeRecipeHash, packageFileUrl, packageVersion } from "../src/plan";
import { SHA256_SUFFIX, publishBundle, type FetchLike } from "../src/registry";
import { buildSourceArchive, checkSourceArchives, sourceArchiveFileName } from "../src/sourceArchive";
import { buildSourcesManifest, type SourcesManifest } from "../src/sourceManifest";
import type { SourceSpec } from "../src/sources";
import type { DepsTarget } from "../src/target";
import { loadTarget } from "../src/targets";

const temps: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "media-deps-srcarchive-"));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const gitEnv = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...gitEnv } }).trim();
// real git + tar subprocesses: well under 1 s alone, but several seconds under turbo's parallel test:core load
const GIT_TEST_TIMEOUT_MS = 30_000;

/** `<root>/spacefleet-io/{sub,lib}.git`: lib has a submodule at 3rdparty/sub (relative url, like libplacebo's). */
type Forks = { forksUrl: string; libSha: string; subSha: string };
const makeForks = (): Forks => {
  const root = tempDir();
  const forks = path.join(root, "spacefleet-io");
  mkdirSync(forks);
  const subWork = path.join(root, "sub-work");
  run(root, "init", "-q", "-b", "main", subWork);
  writeFileSync(path.join(subWork, "sub.txt"), "sub\n");
  run(subWork, "add", "."), run(subWork, "commit", "-q", "-m", "sub");
  const subSha = run(subWork, "rev-parse", "HEAD");
  run(root, "clone", "-q", "--bare", subWork, path.join(root, "sub.git"));

  const work = path.join(root, "lib-work");
  run(root, "init", "-q", "-b", "main", work);
  writeFileSync(path.join(work, "lib.txt"), "lib\n");
  run(work, "add", "."), run(work, "commit", "-q", "-m", "lib");
  run(work, "submodule", "add", "-q", "../sub.git", "3rdparty/sub");
  run(work, "commit", "-q", "-m", "with submodule");
  const libSha = run(work, "rev-parse", "HEAD");
  run(root, "clone", "-q", "--bare", work, path.join(forks, "lib.git"));
  run(root, "clone", "-q", "--bare", subWork, path.join(forks, "sub.git"));
  return { forksUrl: `file://${forks}`, libSha, subSha };
};

const specOf = (sha: string, repo: string, extra: Partial<SourceSpec> = {}): SourceSpec => ({
  version: "1.0",
  repo,
  upstream: { kind: "git", url: `https://example.invalid/${repo}.git` },
  upstreamRef: "v1.0",
  sha,
  license: "MIT",
  ...extra,
});

/** linux-x64's recipe with the real library list replaced by `lib` (+ its submodule). */
const fakeTarget = async (forks: Forks): Promise<DepsTarget> => ({
  ...(await loadTarget("linux-x64")),
  sources: [],
  extraSources: { lib: specOf(forks.libSha, "lib", { submodules: { "3rdparty/sub": specOf(forks.subSha, "sub", { license: "BSD-3-Clause" }) } }) },
});

const listArchive = (archive: string) => execFileSync("tar", ["-tzf", archive], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n");
const readFromArchive = (archive: string, member: string) => execFileSync("tar", ["-xzOf", archive, member], { encoding: "utf8" });

beforeAll(() => {
  // file:// submodule urls are refused by git unless allowed; the forks of a real build are https
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow";
  process.env.GIT_CONFIG_VALUE_0 = "always";
});

describe("buildSourceArchive", () => {
  it("packs the pinned trees (submodules in place, no .git), the recipe, the build args and SOURCES.json", async () => {
    const forks = makeForks();
    const target = await fakeTarget(forks);
    const archive = path.join(tempDir(), sourceArchiveFileName(target));
    const { version } = await buildSourceArchive({ target, archivePath: archive, forksUrl: forks.forksUrl });

    const root = `media-deps-linux-x64-source-${version}`;
    const members = listArchive(archive);
    expect(members).toContain(`${root}/sources/lib/lib.txt`);
    expect(members).toContain(`${root}/sources/lib/3rdparty/sub/sub.txt`);
    expect(members.filter((name) => /\/\.git(\/|$)/.test(name))).toEqual([]);
    expect(members).toContain(`${root}/recipe/recipes/_shared/fetch-source.sh`);
    expect(members).toContain(`${root}/recipe/recipes/linux-x64/Dockerfile`);
    expect(members).toContain(`${root}/recipe/src/features.ts`);
    expect(members).toContain(`${root}/recipe/src/sources.ts`);
    expect(members).toContain(`${root}/README.txt`);

    const args = JSON.parse(readFromArchive(archive, `${root}/build-args.json`)) as Record<string, string>;
    expect(args.SRC_LIB_SHA).toBe(forks.libSha);
    const manifest = JSON.parse(readFromArchive(archive, `${root}/SOURCES.json`)) as SourcesManifest;
    expect(manifest.packageVersion).toBe(version);
    expect(manifest.sources).toHaveLength(1);
    expect(manifest.sources[0]).toMatchObject({ id: "lib", sha: forks.libSha, license: "MIT", repo: "lib", path: "sources/lib" });
    expect(manifest.sources[0]?.submodules?.[0]).toMatchObject({ path: "3rdparty/sub", sha: forks.subSha, license: "BSD-3-Clause" });
  }, GIT_TEST_TIMEOUT_MS);

  it("is byte-for-byte reproducible for the same pins", async () => {
    const forks = makeForks();
    const target = await fakeTarget(forks);
    const dir = tempDir();
    await buildSourceArchive({ target, archivePath: path.join(dir, "a.tar.gz"), forksUrl: forks.forksUrl });
    await buildSourceArchive({ target, archivePath: path.join(dir, "b.tar.gz"), forksUrl: forks.forksUrl });
    expect(readFileSync(path.join(dir, "a.tar.gz")).equals(readFileSync(path.join(dir, "b.tar.gz")))).toBe(true);
  }, GIT_TEST_TIMEOUT_MS);

  it("refuses to archive a commit the fork does not hold", async () => {
    const forks = makeForks();
    const target = { ...(await fakeTarget(forks)), extraSources: { lib: specOf("0".repeat(40), "lib") } };
    const archive = path.join(tempDir(), "x.tar.gz");
    await expect(buildSourceArchive({ target, archivePath: archive, forksUrl: forks.forksUrl })).rejects.toThrow(/source_fetch_failed:lib/);
    expect(existsSync(archive)).toBe(false);
  }, GIT_TEST_TIMEOUT_MS);
});

describe("buildSourcesManifest", () => {
  it("lists every real source with a fork url, a pinned sha and a licence", async () => {
    const target = await loadTarget("linux-x64");
    const manifest = buildSourcesManifest(target, computeRecipeHash(target));
    const ids = manifest.sources.map((source) => source.id);
    expect(ids).toContain("ffmpeg");
    expect(ids).toContain("libplacebo");
    for (const source of manifest.sources) {
      expect(source.forkUrl).toBe(`https://github.com/spacefleet-io/${source.repo}.git`);
      expect(source.license).not.toBe("");
    }
    expect(manifest.sources.find((source) => source.id === "libplacebo")?.submodules).toHaveLength(6);
  });
});

describe("checkSourceArchives (the release gate)", () => {
  const registry = (present: boolean): { fetchImpl: FetchLike; hits: string[] } => {
    const hits: string[] = [];
    return {
      hits,
      fetchImpl: async (input, init) => {
        hits.push(`${init?.method ?? "GET"} ${input}`);
        return new Response("", { status: present ? 200 : 404 });
      },
    };
  };

  it("fails and names the version + url when the archive of the bundled recipe is missing", async () => {
    const { fetchImpl, hits } = registry(false);
    const target = await loadTarget("linux-x64");
    const version = packageVersion(computeRecipeHash(target));
    const result = await checkSourceArchives({ targetIds: ["linux-x64"], fetchImpl, token: "" });
    expect(result.ok).toBe(false);
    expect(result.results[0]).toMatchObject({
      target: "linux-x64",
      version,
      published: false,
      url: packageFileUrl(target, version, sourceArchiveFileName(target)),
    });
    // the sidecar is uploaded last: checking it proves the whole file is there
    expect(hits).toEqual([`HEAD ${packageFileUrl(target, version, sourceArchiveFileName(target))}${SHA256_SUFFIX}`]);
  });

  it("passes when every target's archive is published", async () => {
    const result = await checkSourceArchives({ targetIds: ["linux-x64", "windows-x64"], fetchImpl: registry(true).fetchImpl, token: "" });
    expect(result.ok).toBe(true);
    expect(result.results.map((entry) => entry.target)).toEqual(["linux-x64", "windows-x64"]);
  });

  it("fails when only one of several targets is missing", async () => {
    const target = await loadTarget("windows-x64");
    const missing = packageFileUrl(target, packageVersion(computeRecipeHash(target)), sourceArchiveFileName(target));
    const fetchImpl: FetchLike = async (input) => new Response("", { status: String(input).startsWith(missing) ? 404 : 200 });
    const result = await checkSourceArchives({ targetIds: ["linux-x64", "windows-x64"], fetchImpl, token: "" });
    expect(result.ok).toBe(false);
    expect(result.results.map((entry) => entry.published)).toEqual([true, false]);
  });
});

describe("publishing the source archive", () => {
  it("uploads it under its own name into the bundle's release, sidecar last", async () => {
    const target = await loadTarget("linux-x64");
    const recipeHash = computeRecipeHash(target);
    const archive = path.join(tempDir(), "src.tar.gz");
    writeFileSync(archive, "source bytes");
    const uploads: { name: string; body: string }[] = [];
    let created: { tag_name: string; body: string } | undefined;
    const fetchImpl: FetchLike = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/releases/tags/")) return new Response("", { status: 404 });
      if (url.pathname === "/repos/spacefleet-io/media-deps/releases") {
        created = JSON.parse(String(init?.body)) as { tag_name: string; body: string };
        return Response.json({ id: 7, tag_name: created.tag_name, assets: [] }, { status: 201 });
      }
      if (url.host === "uploads.github.com" && url.pathname === "/repos/spacefleet-io/media-deps/releases/7/assets") {
        uploads.push({ name: url.searchParams.get("name") ?? "", body: Buffer.from(init?.body as Uint8Array).toString("utf8") });
        return new Response("{}", { status: 201 });
      }
      return new Response("unexpected", { status: 500 });
    };
    const result = await publishBundle({ target, recipeHash, archivePath: archive, fileName: sourceArchiveFileName(target), token: "t", fetchImpl, log: () => {} });
    const version = packageVersion(recipeHash);
    expect(created?.tag_name).toBe(`media-deps-linux-x64-${version}`);
    expect(created?.body).toContain("media-deps-linux-x64-source.tar.gz");
    expect(result.url).toBe(`https://github.com/spacefleet-io/media-deps/releases/download/media-deps-linux-x64-${version}/media-deps-linux-x64-source.tar.gz`);
    expect(uploads.map((upload) => upload.name)).toEqual(["media-deps-linux-x64-source.tar.gz", `media-deps-linux-x64-source.tar.gz${SHA256_SUFFIX}`]);
    expect(uploads[1]?.body).toMatch(/^[0-9a-f]{64} {2}media-deps-linux-x64-source\.tar\.gz\n$/);
  });
});
