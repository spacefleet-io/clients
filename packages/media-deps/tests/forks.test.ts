import { gitlinkProblems } from "../src/forks/gitlinks";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gitAuthEnv } from "../src/forks/git";
import { isMirroredRef, mirrorFork, parseLsRemote, planMirror } from "../src/forks/mirror";
import { pinRelease } from "../src/forks/pin";
import { compareVersions, importReleases, listReleaseVersions, type FetchLike } from "../src/forks/releases";

const temps: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "media-deps-forks-"));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  }).trim();
// real git subprocesses: well under 1 s alone, but several seconds under turbo's parallel test:core load
const GIT_TEST_TIMEOUT_MS = 30_000;

/** A bare "upstream" with a main branch + tag, built through a scratch clone. */
const makeUpstream = () => {
  const root = tempDir();
  const bare = path.join(root, "upstream.git");
  const work = path.join(root, "work");
  run(root, "init", "-q", "--bare", "-b", "main", bare);
  run(root, "clone", "-q", bare, work);
  writeFileSync(path.join(work, "a.txt"), "one\n");
  run(work, "add", "a.txt");
  run(work, "commit", "-q", "-m", "one");
  run(work, "tag", "v1");
  run(work, "push", "-q", "origin", "main", "v1");
  return { root, bare, work };
};

const refs = (bare: string) =>
  run(bare, "for-each-ref", "--format=%(refname)", "refs/heads", "refs/tags")
    .split("\n")
    .filter(Boolean);

describe("mirror ref selection", () => {
  it("mirrors upstream branches and tags, never an sf/ ref, never pull refs or peeled tags", () => {
    expect(isMirroredRef("refs/heads/main")).toBe(true);
    expect(isMirroredRef("refs/heads/release/8.1")).toBe(true);
    expect(isMirroredRef("refs/tags/n8.1.3")).toBe(true);
    expect(isMirroredRef("refs/heads/sf/8.1.3")).toBe(false);
    expect(isMirroredRef("refs/tags/sf/8.1.3")).toBe(false);
    expect(isMirroredRef("refs/pull/12/head")).toBe(false);
    expect(isMirroredRef("refs/tags/v1^{}")).toBe(false);
  });

  it("parses ls-remote output and reports exactly the refs the fork lacks or has at another sha", () => {
    const upstream = parseLsRemote(
      ["aaa\trefs/heads/main", "bbb\trefs/tags/v1", "ccc\trefs/tags/v1^{}", "ddd\trefs/heads/sf/x", "eee\trefs/pull/1/head"].join("\n")
    );
    expect(upstream).toEqual([
      { name: "refs/heads/main", sha: "aaa" },
      { name: "refs/tags/v1", sha: "bbb" },
      { name: "refs/tags/v1^{}", sha: "ccc" },
      { name: "refs/heads/sf/x", sha: "ddd" },
      { name: "refs/pull/1/head", sha: "eee" },
    ]);
    const fork = [
      { name: "refs/heads/main", sha: "old" },
      { name: "refs/tags/v1", sha: "bbb" },
      { name: "refs/heads/sf/mine", sha: "zzz" },
    ];
    expect(planMirror(upstream, fork).map((ref) => ref.name)).toEqual(["refs/heads/main"]);
    expect(planMirror(upstream, [{ name: "refs/heads/main", sha: "aaa" }, fork[1]!])).toEqual([]);
  });
});

describe("mirrorFork", () => {
  it("pushes upstream into the fork without ever touching or receiving sf/ branches, and is a no-op when current", async () => {
    const upstream = makeUpstream();
    // upstream even has an sf/ branch of its own: it must not land in the fork
    run(upstream.work, "push", "-q", "origin", "main:refs/heads/sf/upstream-owned");
    const fork = path.join(upstream.root, "fork.git");
    run(upstream.root, "init", "-q", "--bare", "-b", "main", fork);
    // our own patch branch in the fork
    run(upstream.work, "remote", "add", "fork", fork);
    writeFileSync(path.join(upstream.work, "patch.txt"), "ours\n");
    run(upstream.work, "add", "patch.txt");
    run(upstream.work, "commit", "-q", "-m", "our patch");
    run(upstream.work, "push", "-q", "fork", "HEAD:refs/heads/sf/1.0");
    const ourPatch = run(fork, "rev-parse", "refs/heads/sf/1.0");
    run(upstream.work, "reset", "-q", "--hard", "v1");

    const cache = tempDir();
    const first = await mirrorFork({ upstreamUrl: upstream.bare, forkUrl: fork, cacheDir: cache, name: "lib" });
    expect(first.status).toBe("updated");
    expect(refs(fork).sort()).toEqual(["refs/heads/main", "refs/heads/sf/1.0", "refs/tags/v1"]);
    expect(run(fork, "rev-parse", "refs/heads/sf/1.0")).toBe(ourPatch);

    const second = await mirrorFork({ upstreamUrl: upstream.bare, forkUrl: fork, cacheDir: cache, name: "lib" });
    expect(second.status).toBe("up-to-date");

    // upstream moves on: a new commit on main, a new tag, a force-pushed rewrite of a branch
    writeFileSync(path.join(upstream.work, "b.txt"), "two\n");
    run(upstream.work, "add", "b.txt");
    run(upstream.work, "commit", "-q", "-m", "two");
    run(upstream.work, "tag", "v2");
    run(upstream.work, "push", "-q", "origin", "main", "v2");
    const third = await mirrorFork({ upstreamUrl: upstream.bare, forkUrl: fork, cacheDir: tempDir(), name: "lib" });
    expect(third.status).toBe("updated");
    expect(run(fork, "rev-parse", "refs/heads/main")).toBe(run(upstream.bare, "rev-parse", "refs/heads/main"));
    expect(run(fork, "rev-parse", "refs/tags/v2")).toBe(run(upstream.bare, "rev-parse", "refs/tags/v2"));
    expect(run(fork, "rev-parse", "refs/heads/sf/1.0")).toBe(ourPatch);
  }, GIT_TEST_TIMEOUT_MS);
});

describe("gitAuthEnv", () => {
  it("scopes the credential to the forge url through the environment, never argv", () => {
    const env = gitAuthEnv({ user: "bot", token: "s3cret" }, "https://forge.example");
    expect(env.GIT_CONFIG_KEY_0).toBe("http.https://forge.example/.extraheader");
    expect(env.GIT_CONFIG_VALUE_0).toBe(`AUTHORIZATION: basic ${Buffer.from("bot:s3cret").toString("base64")}`);
    expect(gitAuthEnv(undefined)).toEqual({});
  });
});

describe("pinRelease", () => {
  const makeTarball = (files: Record<string, string>) => {
    const dir = tempDir();
    const content = path.join(dir, "lib-1.0");
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(content, name)), { recursive: true });
      writeFileSync(path.join(content, name), body);
    }
    const tarball = path.join(dir, "lib-1.0.tar.gz");
    execFileSync("tar", ["-czf", tarball, "-C", dir, "lib-1.0"]);
    return tarball;
  };

  it("pins the tag commit itself when the release tarball is exactly the tag's tree", async () => {
    const upstream = makeUpstream();
    const tarball = makeTarball({ "a.txt": "one\n" });
    const result = await pinRelease({
      repoDir: upstream.bare,
      ref: "v1",
      version: "1.0",
      release: { url: "https://example.invalid/lib-1.0.tar.gz", file: tarball },
    });
    expect(result.imported).toBe(false);
    expect(result.sha).toBe(run(upstream.bare, "rev-parse", "v1^{commit}"));
    expect(run(upstream.bare, "rev-parse", "refs/heads/sf/1.0")).toBe(result.sha);
  }, GIT_TEST_TIMEOUT_MS);

  it("adds ONE import commit on top of the tag holding the tarball tree, with provenance, deterministically", async () => {
    const upstream = makeUpstream();
    const tarball = makeTarball({ "a.txt": "one\n", configure: "#!/bin/sh\necho generated\n" });
    const release = { url: "https://example.invalid/lib-1.0.tar.gz", file: tarball };
    const first = await pinRelease({ repoDir: upstream.bare, ref: "v1", version: "1.0", release });
    expect(first.imported).toBe(true);
    expect(run(upstream.bare, "rev-parse", `${first.sha}^`)).toBe(run(upstream.bare, "rev-parse", "v1^{commit}"));
    expect(run(upstream.bare, "ls-tree", "--name-only", first.sha).split("\n")).toEqual(["a.txt", "configure"]);
    const message = run(upstream.bare, "log", "-1", "--format=%B", first.sha);
    expect(message).toContain("https://example.invalid/lib-1.0.tar.gz");
    expect(message).toContain(first.releaseSha256);
    expect(run(upstream.bare, "rev-parse", "refs/heads/sf/1.0")).toBe(first.sha);

    const again = await pinRelease({ repoDir: upstream.bare, ref: "v1", version: "1.0", release });
    expect(again.sha).toBe(first.sha);
  }, GIT_TEST_TIMEOUT_MS);

  it("rewrites .gitmodules to relative fork urls on top of the tag when asked", async () => {
    const upstream = makeUpstream();
    writeFileSync(
      path.join(upstream.work, ".gitmodules"),
      '[submodule "3rdparty/glad"]\n\tpath = 3rdparty/glad\n\turl = https://github.com/Dav1dde/glad\n'
    );
    run(upstream.work, "add", ".gitmodules");
    run(upstream.work, "commit", "-q", "-m", "submodules");
    run(upstream.work, "tag", "v2");
    run(upstream.work, "push", "-q", "origin", "main", "v2");
    const result = await pinRelease({
      repoDir: upstream.bare,
      ref: "v2",
      version: "2.0",
      submoduleRepos: { "3rdparty/glad": "glad" },
    });
    expect(result.imported).toBe(true);
    const gitmodules = run(upstream.bare, "show", `${result.sha}:.gitmodules`);
    expect(gitmodules).toContain("url = ../glad.git");
    expect(gitmodules).not.toContain("github.com");
    expect(run(upstream.bare, "rev-parse", `${result.sha}^`)).toBe(run(upstream.bare, "rev-parse", "v2^{commit}"));
  }, GIT_TEST_TIMEOUT_MS);
});

describe("release-tarball upstreams (LAME on SourceForge)", () => {
  const upstream = {
    index: "https://feed.invalid/rss",
    versionPattern: "^/lame/([0-9]+(?:\\.[0-9]+)+)/lame-\\1\\.tar\\.gz$",
    downloadUrl: "https://dl.invalid/lame-{version}.tar.gz",
    since: "3.100",
  };
  const rss = (...paths: string[]) =>
    `<rss><channel><title>LAME</title>${paths.map((p) => `<item><title><![CDATA[${p}]]></title></item>`).join("")}</channel></rss>`;

  it("lists only well-formed release versions at or above `since`, oldest first", () => {
    const feed = rss("/lame/4.0/lame-4.0.tar.gz", "/lame/3.100/lame-3.100.tar.gz", "/lame/3.99/lame-3.99.5.tar.gz", "/lame/3.97beta/lame-3.97b.tar.gz", "/lame/3.101/lame-3.101.tar.gz");
    expect(listReleaseVersions(feed, upstream)).toEqual(["3.100", "3.101", "4.0"]);
    expect(compareVersions("3.99.5", "3.100")).toBeLessThan(0);
  });

  it("imports each missing release as one commit + tag v<version> with provenance, and is a no-op afterwards", async () => {
    const root = tempDir();
    const fork = path.join(root, "lame.git");
    run(root, "init", "-q", "--bare", "-b", "main", fork);
    const tarballs = new Map<string, Buffer>();
    for (const version of ["3.100", "3.101"]) {
      const dir = path.join(root, `src-${version}`);
      mkdirSync(path.join(dir, `lame-${version}`), { recursive: true });
      writeFileSync(path.join(dir, `lame-${version}`, "configure"), `#!/bin/sh\necho ${version}\n`);
      const file = path.join(root, `${version}.tar.gz`);
      execFileSync("tar", ["-czf", file, "-C", dir, `lame-${version}`]);
      tarballs.set(`https://dl.invalid/lame-${version}.tar.gz`, readFileSync(file));
    }
    const fetchImpl: FetchLike = async (url) => {
      if (url === upstream.index) return new Response(rss("/lame/3.100/lame-3.100.tar.gz", "/lame/3.101/lame-3.101.tar.gz"));
      const body = tarballs.get(url);
      return body ? new Response(new Uint8Array(body)) : new Response("nope", { status: 404 });
    };
    const sha100 = createHash("sha256").update(tarballs.get("https://dl.invalid/lame-3.100.tar.gz")!).digest("hex");

    const first = await importReleases({ name: "lame", upstream, forkUrl: fork, cacheDir: tempDir(), fetchImpl, expected: { "3.100": sha100 } });
    expect(first.imported).toEqual(["3.100", "3.101"]);
    const tip = run(fork, "rev-parse", "refs/tags/v3.101^{commit}");
    expect(run(fork, "rev-parse", "refs/heads/main")).toBe(tip);
    expect(run(fork, "rev-parse", `${tip}^`)).toBe(run(fork, "rev-parse", "refs/tags/v3.100^{commit}"));
    expect(run(fork, "log", "-1", "--format=%B", "refs/tags/v3.100")).toContain(`sha256: ${sha100}`);
    const firstSha = run(fork, "rev-parse", "refs/tags/v3.100^{commit}");

    const second = await importReleases({ name: "lame", upstream, forkUrl: fork, cacheDir: tempDir(), fetchImpl });
    expect(second.imported).toEqual([]);

    // a re-import into a fresh fork reproduces the same commit: the pin is derivable
    const other = path.join(root, "other.git");
    run(root, "init", "-q", "--bare", "-b", "main", other);
    await importReleases({ name: "lame", upstream, forkUrl: other, cacheDir: tempDir(), fetchImpl });
    expect(run(other, "rev-parse", "refs/tags/v3.100^{commit}")).toBe(firstSha);
  }, GIT_TEST_TIMEOUT_MS);

  it("refuses a release whose sha256 differs from the pinned one", async () => {
    const root = tempDir();
    const fork = path.join(root, "lame.git");
    run(root, "init", "-q", "--bare", "-b", "main", fork);
    const dir = path.join(root, "src", "lame-3.100");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "configure"), "x");
    const file = path.join(root, "a.tar.gz");
    execFileSync("tar", ["-czf", file, "-C", path.join(root, "src"), "lame-3.100"]);
    const body = readFileSync(file);
    const fetchImpl: FetchLike = async (url) =>
      url === upstream.index ? new Response(rss("/lame/3.100/lame-3.100.tar.gz")) : new Response(new Uint8Array(body));
    await expect(
      importReleases({ name: "lame", upstream, forkUrl: fork, cacheDir: tempDir(), fetchImpl, expected: { "3.100": "0".repeat(64) } })
    ).rejects.toThrow(/release_sha256_mismatch/);
  }, GIT_TEST_TIMEOUT_MS);
});

describe("gitlinkProblems", () => {
  const sha = "a".repeat(40);
  const tree = `100644 blob ${"b".repeat(40)}\tmeson.build\n160000 commit ${sha}\t3rdparty/glad\n`;
  const modules = `[submodule "3rdparty/glad"]\n\tpath = 3rdparty/glad\n\turl = ../glad.git\n`;

  it("accepts a tree whose gitlinks are the pinned submodule forks", () => {
    expect(gitlinkProblems({ "3rdparty/glad": { repo: "glad", sha } }, tree, modules)).toEqual([]);
  });

  it("reports a moved gitlink, a missing one and a url that leaves our forks", () => {
    const problems = gitlinkProblems(
      { "3rdparty/glad": { repo: "glad", sha: "c".repeat(40) }, "3rdparty/jinja": { repo: "jinja", sha } },
      tree,
      modules.replace("../glad.git", "https://github.com/Dav1dde/glad")
    );
    expect(problems).toHaveLength(4);
    expect(problems.join("\n")).toContain("3rdparty/glad: tree has " + sha);
    expect(problems.join("\n")).toContain("3rdparty/jinja: tree has no gitlink");
    expect(problems.join("\n")).toContain("https://github.com/Dav1dde/glad");
  });
});
