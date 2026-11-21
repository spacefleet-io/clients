import { spawnSync } from "node:child_process";
import { accessSync, constants, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ANDROID_STEPS,
  androidHostScripts,
  buildManifest,
  computeRecipeHash,
  dockerBuildArgs,
  forgeAuthFromEnv,
  getPackageRoot,
  loadMobileTarget,
  packageVersion,
  vendorDepsDir,
  verifyTarget,
  writeManifest,
} from "../src/index";
import { parseArgs } from "./_args";

/**
 * Builds one Android libmpv bundle from source on THIS host, without Docker, and puts it where
 * `bun scripts/fetch-deps.ts` would put the published bundle (vendor/deps/<target>/), so the app build takes it
 * unchanged. This is how F-Droid's build server gets libmpv (scripts/android-foss-build.sh with
 * SF_MEDIA_DEPS_FROM_SOURCE=1, REL-DIST-22): it builds every native library from source and downloads none.
 *
 * It runs the very scripts of recipes/_android (env.sh + steps/*.sh, src/androidHost.ts), with the toolchain step's
 * NDK download replaced by the host's NDK of the same version. The recipe files themselves stay as they are, so the
 * recipe hash (and the published bundles) do not change.
 *
 * Needs on the host: bash, git, curl, a C compiler for the build machine (fribidi and mpv run generators), pkg-config,
 * nasm, cmake, ninja, python3, meson >= 1.3, gperf, patchelf, file; and the recipe's NDK (27.1.12297006) at
 * ANDROID_NDK_HOME or <ANDROID_HOME|ANDROID_SDK_ROOT>/ndk/<version>.
 *
 * With --docker-paths it builds at the Docker build's own paths (below); with the Docker image's meson (1.12.1) and
 * pkg-config (0.29.2), its libraries are then byte-identical to the published bundle's, so an APK built this way
 * matches the one we sign. Without it, the work tree is MEDIA_DEPS_HOST_ROOT (default /tmp/sf-media-deps)/<target>,
 * with the three roots moved under it.
 *
 * Usage: bun scripts/build-android-host.ts --target android-<arm64|arm|x64|ia32> [--docker-paths]
 */
const args = parseArgs(process.argv.slice(2));
if (typeof args.target !== "string") throw new Error("usage: build-android-host.ts --target android-<arch>");
const target = await loadMobileTarget(args.target);
if (target.os !== "android") throw new Error(`not_an_android_target:${target.id}`);
const packageRoot = getPackageRoot();
const repoRoot = path.resolve(packageRoot, "..", "..");
const buildArgs = dockerBuildArgs(target);
const ndkVersion = buildArgs.NDK_VERSION!;
const abi = buildArgs.ANDROID_ABI!;

const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
const ndk = process.env.ANDROID_NDK_HOME || (sdk ? path.join(sdk, "ndk", ndkVersion) : "");
if (!ndk || !existsSync(path.join(ndk, "source.properties"))) {
  throw new Error(`NDK ${ndkVersion} not found: set ANDROID_NDK_HOME, or ANDROID_HOME with ndk/${ndkVersion} installed`);
}

// --docker-paths: the very paths of the Docker build (/opt, /work, /recipe), which the libraries embed (ffmpeg's
// configuration string holds the compiler paths), so the result can be byte-identical to the published bundle. The
// caller (root) prepares them: empty /work, /recipe, /opt/deps and /opt/out writable by this user, /opt/cross.ini
// writable, and the NDK at /opt/ndk. Otherwise the work tree is MEDIA_DEPS_HOST_ROOT/<target>, made here.
const dockerPaths = args["docker-paths"] === true;
const root = dockerPaths ? "/" : path.join(process.env.MEDIA_DEPS_HOST_ROOT || "/tmp/sf-media-deps", target.id);
const recipe = path.join(packageRoot, "recipes", "_android");
const bin = dockerPaths ? mkdtempSync(path.join(tmpdir(), "media-deps-bin-")) : path.join(root, "bin");
if (dockerPaths) {
  for (const dir of ["/work", "/recipe", "/opt/deps", "/opt/out"]) {
    accessSync(dir, constants.W_OK);
    if (readdirSync(dir).length > 0) throw new Error(`--docker-paths: ${dir} is not empty`);
  }
  accessSync("/opt/cross.ini", constants.W_OK);
  if (!existsSync("/opt/ndk/source.properties")) throw new Error("--docker-paths: no NDK at /opt/ndk");
  mkdirSync("/recipe/steps");
} else {
  rmSync(root, { recursive: true, force: true });
  for (const dir of ["opt", "work", "bin", "recipe/steps"]) mkdirSync(path.join(root, dir), { recursive: true });
  symlinkSync(path.resolve(ndk), path.join(root, "opt", "ndk"));
}
symlinkSync(path.join(packageRoot, "recipes", "_shared", "fetch-source.sh"), path.join(bin, "fetch-source"));
cpSync(path.join(recipe, "jni"), path.join(root, "recipe", "jni"), { recursive: true });
for (const [file, text] of Object.entries(androidHostScripts(packageRoot, dockerPaths ? undefined : root))) {
  writeFileSync(path.join(root, "recipe", file), text);
}

const forgeAuth = forgeAuthFromEnv();
const env = {
  ...process.env,
  ...buildArgs,
  ...(forgeAuth ? { FORGE_AUTH: `${forgeAuth.user}:${forgeAuth.token}` } : {}),
  PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
};
const recipeHash = computeRecipeHash(target, packageRoot);
console.info(`[media-deps:host] ${target.id} ${packageVersion(recipeHash)} in ${root} (NDK ${ndk})`);
for (const step of ANDROID_STEPS) {
  console.info(`[media-deps:host] ${target.id}: ${step}`);
  // Each Docker step starts in WORKDIR /work.
  const run = spawnSync("bash", [path.join(root, "recipe", "steps", `${step}.sh`)], { stdio: "inherit", env, cwd: path.join(root, "work") });
  if (run.status !== 0) throw new Error(`step_failed:${target.id}:${step}:${run.status ?? run.signal}`);
}

// The bundle = what the Docker build's `out` stage exports (lib/<abi>/*.so), plus the manifest fetch-deps writes.
const dir = vendorDepsDir(repoRoot, target.id);
rmSync(dir, { recursive: true, force: true });
mkdirSync(path.join(dir, "lib"), { recursive: true });
cpSync(path.join(root, "opt", "out", "lib", abi), path.join(dir, "lib", abi), { recursive: true });
writeManifest(dir, await buildManifest(dir, target, recipeHash));
const result = await verifyTarget({ bundleDir: dir, target, hostPlatform: process.platform, oscScript: "" });
if (!result.ok) throw new Error(`verification failed:\n${result.failures.join("\n")}`);
// Empty again for the next target (with --docker-paths the directories themselves belong to the caller).
if (dockerPaths) {
  for (const dir of ["/work", "/recipe", "/opt/deps", "/opt/out"]) {
    for (const entry of readdirSync(dir)) rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
  rmSync(bin, { recursive: true, force: true });
} else {
  rmSync(root, { recursive: true, force: true });
}
console.info(`[media-deps:host] ${target.id} -> ${dir}`);
