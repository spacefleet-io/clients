import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MANIFEST_FILE_NAME, bundleEntries, readManifest } from "../../media-deps/src/bundle";
import { computeRecipeHash, getPackageRoot } from "../../media-deps/src/plan";
import { fetchDeps, isBundleCurrent } from "../../media-deps/src/registry";
import { loadTarget } from "../../media-deps/src/targets";

/**
 * Puts the Apple media-deps bundles of one platform where `MpvPlayback.podspec` vendors them: Libmpv, the six FFmpeg
 * libraries and MoltenVK as dynamic xcframeworks, each holding the DEVICE slice (`media-deps-ios-arm64` for iPhone,
 * `media-deps-tvos-arm64` for Apple TV) and the SIMULATOR slice (`media-deps-ios-arm64-simulator`,
 * `media-deps-tvos-arm64-simulator`; REL-MOB-02, REL-TV-03), so Xcode picks the right one for a device or a simulator
 * build. media-deps publishes the two as separate bundles (the device bundle stays device-only); this script syncs
 * each to `ios/vendor/media-deps/<target>/` and joins them into `ios/vendor/media-deps/<ios|tvos>/` with
 * `xcodebuild -create-xcframework` (all gitignored, `**\/vendor/`). The podspec vendors the joined directory. An app
 * built for the device embeds only the device slice.
 *
 * Default: the published bundle of THIS checkout's recipe (`fetchDeps`: GitHub release of spacefleet-io/media-deps, content-addressed version
 * `fl<n>-<recipe hash>`, sha256-verified, cached in ~/.cache/spacefleet/deps) — the recipe is the pin, there is no
 * lockfile to bump. Development before CI publishes: a local build per bundle, default
 * `packages/media-deps/out/<target>`: `--local [dir]` or `SB_MEDIA_DEPS_<IOS|TVOS>_LOCAL=<dir|1>` for the device
 * bundle, `--local-simulator [dir]` or `SB_MEDIA_DEPS_<IOS|TVOS>_SIMULATOR_LOCAL=<dir|1>` for the simulator bundle.
 *
 * Usage: bun packages/mobile-mpv-playback/scripts/fetch-ios-deps.ts [--target ios-arm64|tvos-arm64] [--local [dir]]
 *          [--local-simulator [dir]]
 * The iPhone app's Podfile runs it (ios-arm64, the default) on every `pod install`; the Apple TV app passes tvos-arm64.
 */
export const TARGET_IDS = ["ios-arm64", "tvos-arm64"] as const;
export type AppleTargetId = (typeof TARGET_IDS)[number];
/** Every bundle this script syncs: a device target or its simulator twin. */
export type AppleBundleId = AppleTargetId | `${AppleTargetId}-simulator`;

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageDir, "..", "..");
export const vendorRoot = path.join(packageDir, "ios", "vendor", "media-deps");
export const defaultLocalDir = (bundleId: AppleBundleId) => path.join(repoRoot, "packages", "media-deps", "out", bundleId);
export const simulatorOf = (targetId: AppleTargetId): AppleBundleId => `${targetId}-simulator`;
/** `ios-arm64` -> `ios`: the joined (device + simulator) directory the podspec vendors. */
export const platformOf = (targetId: AppleTargetId): "ios" | "tvos" => (targetId === "tvos-arm64" ? "tvos" : "ios");

/** `--target <id>` (default ios-arm64, the iPhone app). */
export const targetFromArgs = (argv: string[]): AppleTargetId => {
  const flag = argv.indexOf("--target");
  if (flag < 0) return "ios-arm64";
  const value = argv[flag + 1];
  const found = TARGET_IDS.find((id) => id === value);
  if (!found) throw new Error(`unknown_target:${value ?? ""} (want ${TARGET_IDS.join(" | ")})`);
  return found;
};

/**
 * Copies the bundle in `source` (its manifest's top-level entries + the manifest) into `dest`, replacing what was there.
 * Every manifest file must be present with its size; a `dest` already holding the same recipe intact is left alone.
 */
export const syncBundle = (
  source: string,
  dest: string,
  bundleId: AppleBundleId,
  log: (line: string) => void = (line) => console.info(line),
): { status: "current" | "copied"; recipeHash: string } => {
  const manifest = readManifest(source);
  if (manifest.target !== bundleId) throw new Error(`wrong_target:${manifest.target} (want ${bundleId}) in ${source}`);
  if (!isBundleCurrent(source, manifest.recipeHash)) throw new Error(`incomplete_bundle:${source} (a manifest file is missing or has the wrong size)`);
  if (isBundleCurrent(dest, manifest.recipeHash)) {
    log(`[apple-deps] ${dest} already holds ${bundleId} recipe ${manifest.recipeHash.slice(0, 12)}`);
    return { status: "current", recipeHash: manifest.recipeHash };
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  const staging = mkdtempSync(path.join(path.dirname(dest), ".media-deps-"));
  try {
    for (const entry of [...bundleEntries(manifest), MANIFEST_FILE_NAME]) {
      cpSync(path.join(source, entry), path.join(staging, entry), { recursive: true, verbatimSymlinks: true });
    }
    rmSync(dest, { recursive: true, force: true });
    renameSync(staging, dest);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  log(`[apple-deps] ${bundleId} recipe ${manifest.recipeHash.slice(0, 12)}: ${bundleEntries(manifest).join(", ")} -> ${dest}`);
  return { status: "copied", recipeHash: manifest.recipeHash };
};

/** Records which device + simulator recipes a joined directory was made from. */
export const JOINED_STAMP = ".joined-recipes";

/** The single-slice `<Name>.xcframework` in `bundleDir` -> its `<Name>.framework` (the one slice directory inside). */
const sliceFramework = (bundleDir: string, xcframework: string): string => {
  const name = xcframework.replace(/\.xcframework$/, "");
  const slices = readdirSync(path.join(bundleDir, xcframework), { withFileTypes: true }).filter((entry) => entry.isDirectory());
  if (slices.length !== 1) throw new Error(`not_single_slice:${path.join(bundleDir, xcframework)} (${slices.map((slice) => slice.name).join(",")})`);
  return path.join(bundleDir, xcframework, slices[0]?.name ?? "", `${name}.framework`);
};

/**
 * Joins the device bundle and the simulator bundle (same xcframework names, one slice each) into `dest`: one
 * xcframework per library with both slices. Left alone when `dest` already holds the join of these two recipes.
 */
export const joinSlices = (
  device: { dir: string; recipeHash: string },
  simulator: { dir: string; recipeHash: string },
  dest: string,
  log: (line: string) => void = (line) => console.info(line),
): "current" | "joined" => {
  const stamp = `${device.recipeHash} ${simulator.recipeHash}\n`;
  const names = readdirSync(device.dir).filter((entry) => entry.endsWith(".xcframework")).sort();
  const simulatorNames = readdirSync(simulator.dir).filter((entry) => entry.endsWith(".xcframework")).sort();
  if (names.join(",") !== simulatorNames.join(",")) throw new Error(`slice_mismatch:device=${names.join(",")} simulator=${simulatorNames.join(",")}`);
  const stampFile = path.join(dest, JOINED_STAMP);
  if (existsSync(stampFile) && readFileSync(stampFile, "utf8") === stamp && names.every((name) => existsSync(path.join(dest, name, "Info.plist")))) {
    log(`[apple-deps] ${dest} already joins device ${device.recipeHash.slice(0, 12)} + simulator ${simulator.recipeHash.slice(0, 12)}`);
    return "current";
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  const staging = mkdtempSync(path.join(path.dirname(dest), ".media-deps-joined-"));
  try {
    for (const name of names) {
      execFileSync(
        "xcodebuild",
        ["-create-xcframework", "-framework", sliceFramework(device.dir, name), "-framework", sliceFramework(simulator.dir, name), "-output", path.join(staging, name)],
        { stdio: ["ignore", "ignore", "inherit"] },
      );
    }
    writeFileSync(path.join(staging, JOINED_STAMP), stamp);
    rmSync(dest, { recursive: true, force: true });
    renameSync(staging, dest);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  log(`[apple-deps] joined device + simulator slices of ${names.join(", ")} -> ${dest}`);
  return "joined";
};

/**
 * The local bundle dir for `bundleId`, or null → fetch the published one. Device: `--local [dir]` /
 * `SB_MEDIA_DEPS_<IOS|TVOS>_LOCAL=<dir|1>`; simulator: `--local-simulator [dir]` /
 * `SB_MEDIA_DEPS_<IOS|TVOS>_SIMULATOR_LOCAL=<dir|1>`.
 */
export const localSource = (argv: string[], env: Record<string, string | undefined>, bundleId: AppleBundleId): string | null => {
  const simulator = bundleId.endsWith("-simulator");
  const flag = argv.indexOf(simulator ? "--local-simulator" : "--local");
  if (flag >= 0) {
    const value = argv[flag + 1];
    return value && !value.startsWith("--") ? path.resolve(value) : defaultLocalDir(bundleId);
  }
  const platform = bundleId.split("-")[0]?.toUpperCase();
  const fromEnv = env[`SB_MEDIA_DEPS_${platform}${simulator ? "_SIMULATOR" : ""}_LOCAL`]?.trim();
  if (!fromEnv || fromEnv === "0") return null;
  return fromEnv === "1" ? defaultLocalDir(bundleId) : path.resolve(fromEnv);
};

/** Syncs one bundle (local build or published package) into `vendor/media-deps/<bundleId>`. */
const syncOne = async (argv: string[], bundleId: AppleBundleId): Promise<{ dir: string; recipeHash: string }> => {
  const local = localSource(argv, process.env, bundleId);
  let source: string;
  if (local) {
    if (!existsSync(path.join(local, MANIFEST_FILE_NAME))) throw new Error(`no_local_bundle:${local} (build it: bun packages/media-deps/scripts/build.ts --target ${bundleId})`);
    const expected = computeRecipeHash(await loadTarget(bundleId, getPackageRoot()));
    const built = readManifest(local).recipeHash;
    // A local build is a development choice: say it differs from the checkout's recipe, but use it.
    if (built !== expected) console.warn(`[apple-deps] local ${bundleId} bundle recipe ${built.slice(0, 12)} differs from this checkout's ${expected.slice(0, 12)}`);
    console.info(`[apple-deps] local bundle ${local}`);
    source = local;
  } else {
    source = (await fetchDeps({ targetId: bundleId, repoRoot })).dir;
  }
  const dir = path.join(vendorRoot, bundleId);
  return { dir, recipeHash: syncBundle(source, dir, bundleId).recipeHash };
};

const main = async () => {
  const argv = process.argv.slice(2);
  const targetId = targetFromArgs(argv);
  const device = await syncOne(argv, targetId);
  const simulator = await syncOne(argv, simulatorOf(targetId));
  joinSlices(device, simulator, path.join(vendorRoot, platformOf(targetId)));
};

if (import.meta.main) await main();
