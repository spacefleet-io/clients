import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = path.resolve(import.meta.dirname, "../recipes/_shared/fetch-source.sh");
const temps: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "media-deps-fetch-"));
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
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "protocol.file.allow",
  GIT_CONFIG_VALUE_0: "always",
};
const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...gitEnv } }).trim();
// real git subprocesses: well under 1 s alone, but several seconds under turbo's parallel test:core load
const GIT_TEST_TIMEOUT_MS = 30_000;

/** `<root>/sub.git` (one file) and `<root>/super.git` (one file + submodule `3rdparty/sub` at `../sub.git`). */
const makeForks = () => {
  const root = tempDir();
  const subWork = path.join(root, "sub-work");
  run(root, "init", "-q", "-b", "main", subWork);
  writeFileSync(path.join(subWork, "sub.txt"), "sub\n");
  run(subWork, "add", "."), run(subWork, "commit", "-q", "-m", "sub");
  run(root, "clone", "-q", "--bare", subWork, path.join(root, "sub.git"));

  const work = path.join(root, "work");
  run(root, "init", "-q", "-b", "main", work);
  writeFileSync(path.join(work, "lib.txt"), "lib\n");
  run(work, "add", "."), run(work, "commit", "-q", "-m", "first");
  const first = run(work, "rev-parse", "HEAD");
  run(work, "submodule", "add", "-q", "../sub.git", "3rdparty/sub");
  run(work, "commit", "-q", "-m", "second");
  const second = run(work, "rev-parse", "HEAD");
  run(root, "clone", "-q", "--bare", work, path.join(root, "super.git"));
  return { root, url: `file://${path.join(root, "super.git")}`, first, second };
};

const fetchSource = (args: string[], env: Record<string, string> = {}) =>
  spawnSync("sh", [script, ...args], { encoding: "utf8", env: { ...process.env, ...gitEnv, ...env } });

describe("fetch-source.sh", () => {
  it("leaves exactly the pinned commit's tree, without .git", () => {
    const forks = makeForks();
    const dest = path.join(tempDir(), "lib");
    const result = fetchSource(["lib", forks.url, forks.first, dest]);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(path.join(dest, "lib.txt"), "utf8")).toBe("lib\n");
    expect(existsSync(path.join(dest, ".git"))).toBe(false);
    expect(existsSync(path.join(dest, "3rdparty/sub/sub.txt"))).toBe(false);
  }, GIT_TEST_TIMEOUT_MS);

  it("refuses anything that is not a full commit sha, and a commit the fork does not have", () => {
    const forks = makeForks();
    const dest = path.join(tempDir(), "lib");
    expect(fetchSource(["lib", forks.url, "main", dest]).status).not.toBe(0);
    expect(fetchSource(["lib", forks.url, "0".repeat(40), dest]).status).not.toBe(0);
    expect(fetchSource(["lib", "", forks.first, dest]).status).not.toBe(0);
  }, GIT_TEST_TIMEOUT_MS);

  it("--submodules initialises the submodules from the sibling fork (relative url) and drops every .git", () => {
    const forks = makeForks();
    const dest = path.join(tempDir(), "lib");
    const result = fetchSource(["--submodules", "lib", forks.url, forks.second, dest]);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(path.join(dest, "3rdparty/sub/sub.txt"), "utf8")).toBe("sub\n");
    expect(existsSync(path.join(dest, ".git"))).toBe(false);
    expect(existsSync(path.join(dest, "3rdparty/sub/.git"))).toBe(false);
  }, GIT_TEST_TIMEOUT_MS);

  it("hands the credential to git through env vars scoped to the forge origin, never as an argument", () => {
    const bin = tempDir();
    const log = path.join(bin, "calls.log");
    const fakeGit = path.join(bin, "git");
    writeFileSync(
      fakeGit,
      `#!/bin/sh\necho "$GIT_CONFIG_KEY_0|$GIT_CONFIG_VALUE_0|$*" >> "${log}"\n[ "$1" = rev-parse ] && echo "${"a".repeat(40)}"\nexit 0\n`
    );
    chmodSync(fakeGit, 0o755);
    const authFile = path.join(bin, "forge_auth");
    writeFileSync(authFile, "bot:s3cret-token\n");
    mkdirSync(path.join(bin, "dest"));
    const result = fetchSource(["lib", "https://forge.example/spacefleet-deps/lib.git", "a".repeat(40), path.join(bin, "dest")], {
      PATH: `${bin}:${process.env.PATH}`,
      FORGE_AUTH_FILE: authFile,
    });
    expect(result.status, result.stderr).toBe(0);
    const calls = readFileSync(log, "utf8");
    const expected = `http.https://forge.example/.extraheader|AUTHORIZATION: basic ${Buffer.from("bot:s3cret-token").toString("base64")}|`;
    expect(calls).toContain(expected);
    expect(calls).not.toMatch(/s3cret/);
    for (const line of calls.split("\n").filter(Boolean)) expect(line.split("|")[2]).not.toContain("s3cret");
  });

  it("native builds hand the credential as FORGE_AUTH=user:token; it is scoped the same way", () => {
    const bin = tempDir();
    const log = path.join(bin, "calls.log");
    const fakeGit = path.join(bin, "git");
    writeFileSync(
      fakeGit,
      `#!/bin/sh\necho "$GIT_CONFIG_KEY_0|$GIT_CONFIG_VALUE_0|$*" >> "${log}"\n[ "$1" = rev-parse ] && echo "${"a".repeat(40)}"\nexit 0\n`
    );
    chmodSync(fakeGit, 0o755);
    mkdirSync(path.join(bin, "dest"));
    const result = fetchSource(["lib", "https://forge.example/spacefleet-deps/lib.git", "a".repeat(40), path.join(bin, "dest")], {
      PATH: `${bin}:${process.env.PATH}`,
      FORGE_AUTH_FILE: path.join(bin, "absent"),
      FORGE_AUTH: "bot:native-token",
    });
    expect(result.status, result.stderr).toBe(0);
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain(`http.https://forge.example/.extraheader|AUTHORIZATION: basic ${Buffer.from("bot:native-token").toString("base64")}|`);
    for (const line of calls.split("\n").filter(Boolean)) expect(line.split("|")[2]).not.toContain("native-token");
  });
});
