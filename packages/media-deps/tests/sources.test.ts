import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LIBPLACEBO_REF } from "../src/features";
import { forkEntries, forkRepos } from "../src/forks/catalog";
import { sfBranchName } from "../src/forks/names";
import { FORGE_URL, forkCloneUrl } from "../src/forks/git";
import { getPackageRoot, sourceBuildArgs } from "../src/plan";
import { SOURCES } from "../src/sources";
import type { DepsTarget } from "../src/target";
import { loadTargets } from "../src/targets";

const recipesDir = path.join(getPackageRoot(), "recipes");
const filesUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });

/** @req REL-DEPS-02[ci,badger-desktop,badger-mobile] every recipe (desktop, Android, iPhone) takes library source only from our forks. */
describe("no recipe fetches source from outside our own forks", () => {
  // Binary assets a recipe ships as-is (the Windows player icon) hold no commands or URLs: only text files are read.
  const recipeFiles = filesUnder(recipesDir).filter((file) => !file.endsWith("README.md") && !readFileSync(file).includes(0));

  // The one exception: a toolchain no package manager carries (the Android NDK) comes as a target build arg pair
  // `<X>_URL` + `<X>_SHA256` (hashed into the version) and the recipe refuses the download unless its sha256 matches.
  // It is a compiler, not library source: every library still comes from a fork.
  const pinnedToolchainUrls = async (): Promise<string[]> =>
    (await loadTargets()).flatMap((target) =>
      Object.entries(target.buildArgs ?? {})
        .filter(([key]) => key.endsWith("_URL") && target.buildArgs?.[`${key.slice(0, -"_URL".length)}_SHA256`]?.match(/^[0-9a-f]{64}$/))
        .map(([, url]) => url)
    );

  it("every URL a recipe file mentions is on the forge (or a pinned, hash-checked toolchain archive)", async () => {
    const forgeHost = new URL(FORGE_URL).host;
    const toolchains = await pinnedToolchainUrls();
    for (const file of recipeFiles) {
      const urls = readFileSync(file, "utf8").match(/https?:\/\/[^\s"'\\)]+/g) ?? [];
      for (const url of urls) {
        if (toolchains.includes(url)) continue;
        expect(new URL(url).host, `${path.relative(recipesDir, file)}: ${url}`).toBe(forgeHost);
      }
    }
  });

  it("no recipe downloads or clones by itself: curl, wget, git clone, hg, svn, tarball urls", () => {
    for (const file of recipeFiles) {
      const lines = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("#"));
      // A pinned toolchain download: `curl … "$<X>_URL"` in a script that sha256-checks it against `$<X>_SHA256`; and
      // curl named as a package in an apt-get package list (a line of bare package names: never an invocation).
      const text = lines
        .filter((line) => {
          if (/^\s+[a-z0-9.+-]+(\s+[a-z0-9.+-]+)*\s*\\$/.test(line)) return false;
          const pinned = /^\s*curl\s[^\n]*"\$([A-Z0-9_]+)_URL"\s*$/.exec(line)?.[1];
          return !(pinned && lines.some((other) => other.includes(`$${pinned}_SHA256`) && other.includes("sha256sum -c")));
        })
        .join("\n");
      expect(text, path.relative(recipesDir, file)).not.toMatch(/\b(curl|wget|svn|hg)\b|git\s+clone|\.tar(\.[a-z0-9]+)?\b/);
    }
  });

  // Docker recipes fetch in their Dockerfile or the scripts it runs, native ones in their build scripts: the shell
  // scripts of recipes/<id> and of the recipe directories listed in `recipeInputs` (recipes/_macos/build.sh,
  // recipes/_android/steps/*.sh).
  const recipeText = (target: DepsTarget): string => {
    // `recipeInputs` entries are directories (recipes/_macos) or single files (recipes/_macos/cpm.cmake).
    const inputs = [target.id, ...(target.recipeInputs ?? []).filter((input) => input.startsWith("recipes/")).map((input) => input.slice("recipes/".length))];
    const scripts = inputs
      .map((input) => path.join(recipesDir, input))
      .flatMap((input) => (statSync(input).isDirectory() ? filesUnder(input) : [input]).filter((file) => file.endsWith(".sh")))
      .map((file) => readFileSync(file, "utf8"));
    const dockerfile = target.builder === "docker" ? [readFileSync(path.join(recipesDir, target.id, "Dockerfile"), "utf8")] : [];
    return [...dockerfile, ...scripts].join("\n");
  };

  it("every source goes through fetch-source with its pinned url + sha, and every pinned source is used", async () => {
    for (const target of await loadTargets()) {
      const recipe = recipeText(target);
      const fetched = [...recipe.matchAll(/fetch-source (?:--submodules )?\S+ "\$SRC_([A-Z0-9_]+)_URL" "\$SRC_\1_SHA" /g)].map((match) => match[1]);
      const pinned = Object.keys(sourceBuildArgs(target))
        .filter((key) => key.endsWith("_URL"))
        .map((key) => key.slice("SRC_".length, -"_URL".length));
      expect([...fetched].sort(), `${target.id} recipe vs its sources`).toEqual([...pinned].sort());
      // no other invocation shape (every fetch-source call matched the pinned-url pattern above)
      expect(recipe.match(/(?<![/\w-])fetch-source /g)?.length).toBe(fetched.length);
      if (target.builder !== "docker") continue;
      // every RUN that fetches mounts the credential as a BuildKit secret (never an ARG/ENV)
      for (const run of recipe.split(/\n(?=RUN )/).filter((block) => /^RUN .*(?<![/\w-])fetch-source /.test(block))) {
        expect(run).toContain("--mount=type=secret,id=forge_auth");
      }
      expect(recipe).not.toMatch(/^(ARG|ENV) \w*(TOKEN|AUTH|PASSWORD)\w*/m);
    }
  });
});

describe("the pin list", () => {
  const entries = forkEntries();

  it("pins a full lowercase commit sha per library, on the fork's sf/<version> branch", () => {
    for (const { id, spec } of entries) {
      expect(spec.sha, id).toMatch(/^[0-9a-f]{40}$/);
      expect(sfBranchName(spec.version), id).toMatch(/^sf\/[A-Za-z0-9._-]+$/);
      execFileSync("git", ["check-ref-format", `refs/heads/${sfBranchName(spec.version)}`]);
      expect(spec.license.length, id).toBeGreaterThan(2);
      expect(spec.version.length, id).toBeGreaterThan(0);
    }
    // one `git check-ref-format` per pin: fast alone, several seconds under turbo's parallel test:core load
  }, 30_000);

  it("creates and mirrors every fork once, all in the org the builds read", () => {
    const repos = forkRepos(entries).map((entry) => entry.spec.repo);
    expect(new Set(repos).size).toBe(repos.length);
    for (const repo of repos) expect(forkCloneUrl(repo)).toBe(`${FORGE_URL}/spacefleet-io/${repo}.git`);
    expect(repos).toEqual(expect.arrayContaining(["ffmpeg", "mpv", "libplacebo", "glad", "jinja", "fast-float", "lame"]));
    // pins that share a fork branch (`sf/<version>`) are the same commit
    const shaByBranch = new Map<string, string>();
    for (const { id, spec } of entries) {
      const branch = `${spec.repo}@${sfBranchName(spec.version)}`;
      expect(shaByBranch.get(branch) ?? spec.sha, `${id} ${branch}`).toBe(spec.sha);
      shaByBranch.set(branch, spec.sha);
    }
  });

  it("refuses two pins of one fork that name different upstreams", () => {
    const spec = { version: "1", repo: "x", upstream: { kind: "git", url: "https://a" }, upstreamRef: "1", sha: "0".repeat(40), license: "MIT" } as const;
    expect(() => forkRepos(forkEntries({ a: spec, b: { ...spec, upstream: { kind: "git", url: "https://b" } } }))).toThrow(/fork_upstream_conflict/);
  });

  it("records provenance for every pin that is a commit of ours", () => {
    for (const { id, spec } of entries) {
      if (spec.release) expect(spec.release.sha256, id).toMatch(/^[0-9a-f]{64}$/);
      // a library pinned straight at an upstream commit names that commit or a tag; a submodule IS its gitlink commit
      if (id.includes("/")) expect(spec.sha, id).toBe(spec.upstreamRef);
    }
  });

  it("keeps libplacebo's version and its submodule forks in step with the recipe inputs", () => {
    expect(SOURCES.libplacebo.version).toBe(LIBPLACEBO_REF);
    expect(Object.keys(SOURCES.libplacebo.submodules).sort()).toEqual([
      "3rdparty/Vulkan-Headers",
      "3rdparty/fast_float",
      "3rdparty/glad",
      "3rdparty/jinja",
      "3rdparty/markupsafe",
      "demos/3rdparty/nuklear",
    ]);
  });
});

// The libass fork commits its generated autotools files and a checkout gives them arbitrary mtimes, so make can decide
// aclocal.m4 is stale and call aclocal-1.17, which the build host may lack (`make: *** [aclocal.m4] Error 127`).
describe("recipes that run libass's committed configure", () => {
  const stamp = "touch aclocal.m4 && touch configure && find . \\( -name Makefile.in -o -name config.h.in \\) -exec touch {} +";
  // A libass block runs from `fetch-source libass` to the next fetch-source (meson builds, e.g. Android, have no configure).
  const libassBlock = (text: string): string | undefined => {
    const start = text.indexOf("fetch-source libass ");
    if (start === -1) return undefined;
    const next = text.indexOf("fetch-source ", start + 1);
    return text.slice(start, next === -1 ? undefined : next);
  };
  const configured = filesUnder(recipesDir)
    .filter((file) => !file.endsWith("README.md"))
    .map((file) => ({ file: path.relative(recipesDir, file), block: libassBlock(readFileSync(file, "utf8")) }))
    .filter((entry): entry is { file: string; block: string } => entry.block?.includes("./configure ") ?? false);

  it("re-stamp the generated files in dependency order before configure", () => {
    expect(configured.map((entry) => entry.file).sort()).toEqual(["_apple-mobile/build.sh", "_macos/build.sh", "windows-x64/Dockerfile"]);
    for (const { file, block } of configured) {
      const stamped = block.indexOf(stamp);
      expect(stamped, file).toBeGreaterThan(-1);
      expect(stamped, file).toBeLessThan(block.indexOf("./configure "));
    }
  });
});
