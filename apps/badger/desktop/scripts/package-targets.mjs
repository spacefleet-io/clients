// The single table of packaging targets. Every packaging script (package.mjs,
// materialize-runtime-deps.mjs, electron-builder.config.mjs) reads its per-OS
// facts from here, so adding a system (macOS) is one new entry, not a hunt
// through scripts. Nothing here inspects the host: the target is always named
// explicitly (or defaults to DEFAULT_TARGET), which is what lets Linux
// cross-build the Windows installer and Windows build the same output.

import { join } from "node:path";

import { linuxArtifactPatterns } from "@space/desktop-platform-linux/packaging/linux-packages";
import { ELECTRON_LANGUAGES, LPROJ_EXTENSION, MAC_ELECTRON_LANGUAGES, PAK_EXTENSION } from "@space/desktop-platform/packaging/packaged-locales-lib";

/**
 * @typedef {{
 *   id: string;
 *   productName: string;
 *   builderFlag: string;
 *   builderPlatform: string;
 *   arch: "x64" | "arm64";
 *   bunTarget: string;
 *   nodePlatform: string;
 *   exeSuffix: string;
 *   depsDir: string;
 *   unpackedDir: string;
 *   resourcesSubpath: string;
 *   inAppUpdates: boolean;
 *   requiredResources: string[];
 *   locales: { subpath: string; languages: string[]; extension: string };
 *   artifactPatterns: RegExp[];
 * }} PackageTarget
 */

// The macOS app bundle is Badger.app (REL-MAC-05); everything else of the
// target table lives inside it.
const MAC_APP_BUNDLE = "Badger.app";

/** Relative to <resources>/ (Contents/Resources): the mpv helper app the afterPack hook moves to Contents/Helpers. */
export const MAC_PLAYER_HELPER = "../Helpers/Badger Player.app";

/** PLAT-DESK-02: the oldest macOS the desktop apps run on (shared with Parrot). */
export { MAC_MINIMUM_SYSTEM_VERSION } from "@space/desktop-platform-macos/packaging/mac-after-pack-lib";

/**
 * @param {"arm64" | "x64"} arch
 * @param {string} unpackedDir electron-builder's output dir name for that arch
 * @returns {PackageTarget}
 */
function macTarget(arch, unpackedDir) {
  return {
    id: `macos-${arch}`,
    productName: "Badger",
    builderFlag: "--mac",
    builderPlatform: "mac",
    arch,
    bunTarget: `bun-darwin-${arch}`,
    nodePlatform: "darwin",
    exeSuffix: "",
    depsDir: `vendor/deps/macos-${arch}`,
    unpackedDir,
    resourcesSubpath: `${MAC_APP_BUNDLE}/Contents/Resources`,
    // REL-MAC-02 / REL-UPD-01: electron-updater (Squirrel.Mac) ships in the package: app-update.yml, and the zip of
    // the notarized app listed in latest-mac.yml.
    inAppUpdates: true,
    requiredResources: [
      "deps/bin/ffmpeg",
      "deps/bin/ffprobe",
      "deps/bin/sf-lifeline",
      "deps/lib",
      "deps/deps-manifest.json",
      `${MAC_PLAYER_HELPER}/Contents/MacOS/mpv`,
      `${MAC_PLAYER_HELPER}/Contents/Info.plist`,
      "app-update.yml",
    ],
    // Contents/Resources/<lang>.lproj, relative to the unpacked dir (see MAC_ELECTRON_LANGUAGES).
    locales: { subpath: `${MAC_APP_BUNDLE}/Contents/Resources`, languages: MAC_ELECTRON_LANGUAGES, extension: LPROJ_EXTENSION },
    // REL-MAC-03: one dmg per arch (never universal), plus the update zip, its blockmap and this arch's
    // latest-mac.yml (the release workflow merges the two arches' feeds into one).
    artifactPatterns: [
      new RegExp(`^Badger-.+-${arch}\\.dmg$`),
      new RegExp(`^Badger-.+-${arch}-mac\\.zip$`),
      new RegExp(`^Badger-.+-${arch}-mac\\.zip\\.blockmap$`),
      /^latest-mac\.yml$/,
    ],
  };
}

/** @type {Record<string, PackageTarget>} */
export const PACKAGE_TARGETS = {
  "linux-x64": {
    id: "linux-x64",
    // electron-builder productName: the AppImage / install dir name. Linux and
    // Windows keep the name existing installs were built with.
    productName: "Badger",
    // electron-builder
    builderFlag: "--linux",
    builderPlatform: "linux",
    arch: "x64",
    // `bun build --compile --target=<bunTarget>`
    bunTarget: "bun-linux-x64",
    // Node's process.platform spelling (better-sqlite3 prebuild pruning)
    nodePlatform: "linux",
    exeSuffix: "",
    // Where scripts/fetch-deps.ts puts the bundled binaries
    // (vendor/deps/<id>/{bin,deps-manifest.json}).
    depsDir: "vendor/deps/linux-x64",
    // electron-builder's unpacked output dir under dist/, and <resources>/ below it.
    unpackedDir: "linux-unpacked",
    resourcesSubpath: "resources",
    // electron-updater ships in the package (app-update.yml + latest-*.yml feed).
    inAppUpdates: true,
    // Resources (relative to <resources>/) that must exist in the package.
    requiredResources: [
      "deps/bin/ffmpeg",
      "deps/bin/ffprobe",
      "deps/bin/mpv",
      "deps/deps-manifest.json",
      "app-update.yml",
    ],
    // Locale files electron-builder keeps (electronLanguages) and package.mjs re-checks,
    // under <unpacked>/<subpath>; see packages/desktop-platform/packaging/packaged-locales-lib.mjs.
    locales: { subpath: "locales", languages: ELECTRON_LANGUAGES, extension: PAK_EXTENSION },
    // Files electron-builder must produce for this target: one per Linux format (PLAT-DESK-01,
    // packages/desktop-platform-linux/packaging/linux-packages.mjs) and the update feed listing all of them.
    artifactPatterns: [...linuxArtifactPatterns("Badger"), /^latest-linux\.yml$/],
  },
  "windows-x64": {
    id: "windows-x64",
    productName: "Badger",
    builderFlag: "--win",
    builderPlatform: "win",
    arch: "x64",
    bunTarget: "bun-windows-x64",
    nodePlatform: "win32",
    exeSuffix: ".exe",
    depsDir: "vendor/deps/windows-x64",
    unpackedDir: "win-unpacked",
    resourcesSubpath: "resources",
    inAppUpdates: true,
    requiredResources: [
      "deps/bin/ffmpeg.exe",
      "deps/bin/ffprobe.exe",
      "deps/bin/mpv.exe",
      "deps/deps-manifest.json",
      "app-update.yml",
    ],
    locales: { subpath: "locales", languages: ELECTRON_LANGUAGES, extension: PAK_EXTENSION },
    artifactPatterns: [/-Setup-.*\.exe$/, /\.exe\.blockmap$/, /^latest\.yml$/],
  },
  // macOS: two separate downloads, never universal (PLAT-DESK-05). Both build on
  // the Apple Silicon host; the x64 one runs there under Rosetta 2 (REL-MAC-01).
  "macos-arm64": macTarget("arm64", "mac-arm64"),
  "macos-x64": macTarget("x64", "mac"),
};

export const DEFAULT_TARGET = "linux-x64";

/**
 * @param {string} [id]
 * @returns {PackageTarget}
 */
export const resolvePackageTarget = (id = DEFAULT_TARGET) => {
  const target = PACKAGE_TARGETS[id];
  if (!target) {
    throw new Error(
      `unknown package target "${id}" (known: ${Object.keys(PACKAGE_TARGETS).join(", ")})`,
    );
  }
  return target;
};

/**
 * Where package.mjs stages build outputs electron-builder then packs.
 * @param {string} appDir
 * @param {PackageTarget} target
 * @returns {string}
 */
export const stageDirFor = (appDir, target) => join(appDir, ".package-stage", target.id);

/**
 * `<resources>/` of the unpacked build of `target` (Linux/Windows `<unpacked>/resources`,
 * macOS `<unpacked>/Badger.app/Contents/Resources`).
 * @param {string} distDir
 * @param {PackageTarget} target
 * @returns {string}
 */
export const unpackedResourcesDir = (distDir, target) => join(distDir, target.unpackedDir, target.resourcesSubpath);

/**
 * Packaged runtime file name; the app spawns `<resources>/runtime/runtime`.
 * @param {PackageTarget} target
 * @returns {string}
 */
export const runtimeBinaryName = (target) => `runtime${target.exeSuffix}`;

/**
 * `bun` arguments that compile the runtime entry into the packaged binary for `target`.
 * @param {PackageTarget} target
 * @param {string} outfile
 * @param {string} [entry]
 * @returns {string[]}
 */
export const runtimeCompileArgs = (target, outfile, entry = "src/index.ts") => [
  "build",
  "--compile",
  `--target=${target.bunTarget}`,
  // The runtime is a headless daemon: no console window, even when spawned
  // detached from the GUI app. (--windows-title/--windows-description are
  // refused when cross-compiling, so they would make the output host-dependent.)
  ...(target.id === "windows-x64" ? ["--windows-hide-console"] : []),
  // `bun build` replaces every `process.env.NODE_ENV` read in the bundle (ours and our dependencies') with the
  // NODE_ENV of the BUILD process, "development" when unset. The compiled runtime would then log env=development and
  // validate job events in every shipped build whatever environment it is spawned with. Pin it to what ships.
  "--define",
  'process.env.NODE_ENV="production"',
  "--outfile",
  outfile,
  entry,
];

// Resources every target must ship, relative to <resources>/.
const COMMON_REQUIRED_RESOURCES = [
  "runtime/slices/core/manifest.json",
  "runtime/slices/modules/badger/manifest.json",
  // PLAY-TRACK-05: the subtitle OCR child and its tesseract.js wasm (scripts/subtitle-ocr-stage-lib.mjs).
  "runtime/ocr/subtitle-ocr.js",
  "runtime/ocr/node_modules/tesseract.js/package.json",
  "runtime/ocr/node_modules/tesseract.js-core/package.json",
  "mpv/osc/sf.lua",
  "mpv/osc/sf-select.lua",
  "mpv/osc/input.conf",
  "mpv/osc/tog4in1/tog4in1.lua",
  // tog4in1.lua is LGPL-2.1-or-later: its licence text ships with it.
  "mpv/osc/LGPL-2.1.txt",
  "mpv/osc/tog4in1/fonts",
  "mpv/icons/spacebadger.png",
  "icon.png",
  "trayTemplate.png",
  "trayTemplate@2x.png",
];

/**
 * Every resource a packaged build of `target` must contain.
 * @param {PackageTarget} target
 * @returns {string[]}
 */
export const requiredResourcesFor = (target) => [
  `runtime/${runtimeBinaryName(target)}`,
  ...COMMON_REQUIRED_RESOURCES,
  ...target.requiredResources,
];

/**
 * Resources missing from an unpacked build; empty when the package is complete.
 * `exists` is injected so the check is testable without a real build.
 * @param {string} resourcesDir
 * @param {PackageTarget} target
 * @param {(path: string) => boolean} exists
 * @returns {string[]}
 */
export const findMissingResources = (resourcesDir, target, exists) =>
  requiredResourcesFor(target).filter((relative) => !exists(join(resourcesDir, relative)));
