import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FEATURE_LIST_VERSION, FFMPEG_COMPONENTS } from "../src/features";
import {
  DEFAULT_RELEASES_URL,
  archiveFileName,
  computeRecipeHash,
  createBuildPlan,
  dockerBuildArgs,
  ffmpegConfigureFlags,
  getPackageRoot,
  hardwareFlags,
  packageFileUrl,
  packageVersion,
  releasesBaseUrl,
} from "../src/plan";
import { SOURCES } from "../src/sources";
import { hostTarget, loadDesktopTarget, loadTarget, loadTargets } from "../src/targets";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway copy of the package's recipes dir, so tests can edit recipe files. */
const copyRecipes = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "media-deps-test-"));
  temps.push(dir);
  cpSync(path.join(getPackageRoot(), "recipes"), path.join(dir, "recipes"), { recursive: true });
  return dir;
};

describe("target discovery", () => {
  it("finds every recipe directory with a target.ts, each keyed by its directory name", async () => {
    const targets = await loadTargets();
    expect(targets.map((target) => target.id)).toEqual(expect.arrayContaining(["linux-x64", "ios-arm64-simulator", "tvos-arm64-simulator"]));
    for (const target of targets) {
      const simulator = target.kind === "mobile" && target.simulator === true;
      expect(target.id).toBe(`${target.os}-${target.arch}${simulator ? "-simulator" : ""}`);
      if (target.kind === "desktop") expect(target.exeSuffix).toBe(target.os === "windows" ? ".exe" : "");
    }
  });

  it("rejects an unknown target", async () => {
    await expect(loadTarget("plan9-mips")).rejects.toThrow("unknown_target:plan9-mips");
  });

  it("picks the host target from each recipe's nodePlatform + arch", async () => {
    expect((await hostTarget("linux", "x64")).id).toBe("linux-x64");
    expect((await hostTarget("win32", "x64")).id).toBe("windows-x64");
    await expect(hostTarget("freebsd", "x64")).rejects.toThrow("unsupported_host:freebsd-x64");
  });
});

describe("ffmpeg configure flags", () => {
  it("covers every shared component plus the target's hardware encoders", async () => {
    const target = await loadDesktopTarget("linux-x64");
    const flags = ffmpegConfigureFlags(target);
    for (const [kind, names] of Object.entries(FFMPEG_COMPONENTS)) {
      for (const name of names) expect(flags).toContain(`--enable-${kind}=${name}`);
    }
    for (const family of target.hardwareEncoders) {
      expect(flags).toContain(`--enable-encoder=h264_${family}`);
      expect(flags).toContain(`--enable-encoder=hevc_${family}`);
    }
    expect(flags).toContain("--disable-everything");
    expect(flags).toContain("--enable-libx264");
    expect(new Set(flags).size).toBe(flags.length);
  });

  it("derives the hardware filters from the families", async () => {
    const target = await loadTarget("linux-x64");
    const flags = hardwareFlags(target);
    expect(flags).toEqual(expect.arrayContaining(["--enable-filter=scale_vaapi", "--enable-filter=scale_cuda", "--enable-filter=scale_qsv"]));
  });
});

describe("recipe hash and package coordinates", () => {
  it("is stable, and changes with a recipe file or a pinned source", async () => {
    const target = await loadTarget("linux-x64");
    const root = copyRecipes();
    const base = computeRecipeHash(target, root);
    expect(computeRecipeHash(target, root)).toBe(base);
    expect(computeRecipeHash(target)).toBe(base);

    writeFileSync(path.join(root, "recipes", "linux-x64", "assemble.sh"), "echo changed\n", { flag: "a" });
    expect(computeRecipeHash(target, root)).not.toBe(base);

    const pinned = { ...target, sources: target.sources.filter((id) => id !== "lame") };
    expect(computeRecipeHash(pinned, getPackageRoot())).not.toBe(base);
  });

  it("is independent of the checkout's line endings (core.autocrlf on Windows)", async () => {
    const target = await loadTarget("linux-x64");
    const root = copyRecipes();
    const base = computeRecipeHash(target, root);
    const file = path.join(root, "recipes", "linux-x64", "assemble.sh");
    writeFileSync(file, readFileSync(file, "utf8").replaceAll("\n", "\r\n"));
    expect(computeRecipeHash(target, root)).toBe(base);
  });

  it("ignores target.ts content (already covered by the resolved args)", async () => {
    const target = await loadTarget("linux-x64");
    const root = copyRecipes();
    const base = computeRecipeHash(target, root);
    writeFileSync(path.join(root, "recipes", "linux-x64", "target.ts"), "// comment only\n", { flag: "a" });
    expect(computeRecipeHash(target, root)).toBe(base);
  });

  it("builds version, file name and URL", async () => {
    const target = await loadTarget("linux-x64");
    const version = packageVersion("a".repeat(64));
    expect(version).toBe(`fl${FEATURE_LIST_VERSION}-aaaaaaaaaaaa`);
    expect(archiveFileName(target)).toBe("media-deps-linux-x64.tar.gz");
    expect(packageFileUrl(target, version, archiveFileName(target), DEFAULT_RELEASES_URL)).toBe(
      `https://github.com/spacefleet-io/media-deps/releases/download/media-deps-linux-x64-${version}/media-deps-linux-x64.tar.gz`
    );
    expect(releasesBaseUrl({ MEDIA_DEPS_BASE_URL: "https://mirror.example/deps/" })).toBe("https://mirror.example/deps");
    expect(releasesBaseUrl({})).toBe(DEFAULT_RELEASES_URL);
  });

  it("does not depend on where the forks are hosted: the pinned commit fixes the source", async () => {
    const target = await loadTarget("linux-x64");
    const base = computeRecipeHash(target);
    const saved = process.env.MEDIA_DEPS_FORKS_URL;
    process.env.MEDIA_DEPS_FORKS_URL = "https://mirror.example/forks";
    try {
      expect(dockerBuildArgs(target).SRC_FFMPEG_URL).toBe("https://mirror.example/forks/ffmpeg.git");
      expect(computeRecipeHash(target)).toBe(base);
    } finally {
      if (saved === undefined) delete process.env.MEDIA_DEPS_FORKS_URL;
      else process.env.MEDIA_DEPS_FORKS_URL = saved;
    }
  });
});

describe("docker build plan", () => {
  it("exports the out stage with every pinned source as a build arg", async () => {
    const target = await loadTarget("linux-x64");
    const plan = createBuildPlan(target, { outputDir: "/tmp/out", packageRoot: "/pkg", forgeAuth: { user: "bot", token: "tok" } });
    expect(plan.args).toEqual(expect.arrayContaining(["--target", "out", "--platform", "linux/amd64"]));
    expect(plan.args).toContain("type=local,dest=/tmp/out");
    expect(plan.args.at(-1)).toBe("/pkg");
    const buildArgs = dockerBuildArgs(target);
    expect(buildArgs.SRC_FFMPEG_SHA).toBe(SOURCES.ffmpeg.sha);
    expect(buildArgs.SRC_FFMPEG_URL).toBe("https://github.com/spacefleet-io/ffmpeg.git");
    expect(Object.keys(buildArgs).filter((key) => key.endsWith("_SHA256"))).toEqual([]);
    expect(buildArgs).not.toHaveProperty("LIBPLACEBO_REF");
    expect(buildArgs.FFMPEG_FLAGS).toContain("--enable-libx264");
    expect(Object.keys(buildArgs)).toEqual([...Object.keys(buildArgs)].sort((a, b) => a.localeCompare(b)));
  });

  it("runs a native target's recipe script with the resolved build args in the environment", async () => {
    const target = await loadTarget("linux-x64");
    const plan = createBuildPlan({ ...target, builder: "native" }, { outputDir: "/x", packageRoot: "/pkg", forgeAuth: { user: "bot", token: "tok" } });
    expect(plan.command).toBe("bash");
    expect(plan.args).toEqual(["/pkg/recipes/linux-x64/build.sh", "/x"]);
    expect(plan.env.SRC_FFMPEG_URL).toBe("https://github.com/spacefleet-io/ffmpeg.git");
    expect(plan.env.FFMPEG_FLAGS).toContain("--enable-libx264");
  });

  it("hands the forge credential to docker as a BuildKit secret read from the environment, never as a build arg", async () => {
    const target = await loadTarget("linux-x64");
    const plan = createBuildPlan(target, { outputDir: "/tmp/out", packageRoot: "/pkg", forgeAuth: { user: "bot", token: "tok-123" } });
    expect(plan.args).toEqual(expect.arrayContaining(["--secret", "id=forge_auth,env=FORGE_AUTH"]));
    expect(plan.env.FORGE_AUTH).toBe("bot:tok-123");
    expect(plan.args.join(" ")).not.toContain("tok-123");
  });

  it("builds without a credential (public forks): no secret, no FORGE_AUTH", async () => {
    const target = await loadTarget("linux-x64");
    const plan = createBuildPlan(target, { outputDir: "/tmp/out", packageRoot: "/pkg" });
    expect(plan.args).not.toContain("--secret");
    expect(plan.env).not.toHaveProperty("FORGE_AUTH");
  });

  it("does not let the credential change the recipe hash (version)", async () => {
    const target = await loadTarget("linux-x64");
    const a = createBuildPlan(target, { outputDir: "/o", packageRoot: "/pkg", forgeAuth: { user: "a", token: "1" } });
    const b = createBuildPlan(target, { outputDir: "/o", packageRoot: "/pkg", forgeAuth: { user: "b", token: "2" } });
    expect(a.args).toEqual(b.args);
  });
});
