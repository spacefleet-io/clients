// electron-builder afterPack hook for the macOS targets (no-op for the others).
//
// 1. The deps bundle (vendor/deps/macos-<arch>/, shipped as
//    Contents/Resources/deps) carries the mpv helper app "Badger Player.app"
//    (MPV-MODEL-03, built under that name with CFBundleName / CFBundleDisplayName
//    "Badger Player" by packages/media-deps/recipes/_macos/build.sh, REL-MAC-09).
//    Nested code must not live in Resources, so it moves to Contents/Helpers/;
//    mpv finds its libraries through its second LC_RPATH
//    (@executable_path/../../../../Resources/deps/lib). A deps bundle whose helper
//    has another name fails the build.
// 2. The macOS steps both desktop apps share (finishMacApp,
//    packages/desktop-platform-macos/packaging/mac-after-pack-lib.mjs): the app
//    executable's minos raised to the macOS floor (PLAT-DESK-02), everything
//    signed inside-out (every loose Mach-O file: deps dylibs and executables, the
//    compiled runtime, better-sqlite3's .node, Electron's framework libraries;
//    then every nested bundle deepest first: Electron helpers and frameworks, the
//    Player helper; then the app) and verified, then a Developer ID app notarized
//    and stapled (REL-MAC-02).
//
// A missing or empty deps bundle fails the build loudly: a dmg without mpv /
// ffmpeg would install fine and break at first playback.
import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { join, relative } from "node:path";

import { finishMacApp, runMacTool } from "@space/desktop-platform-macos/packaging/mac-after-pack-lib";

/** The helper app, in the deps bundle and in the packaged app (Contents/Helpers), REL-MAC-09. */
export const PLAYER_HELPER_NAME = "Badger Player";
export const PLAYER_HELPER_APP = `${PLAYER_HELPER_NAME}.app`;

/**
 * What the deps bundle must contain before the app may be signed and shipped.
 * @param {string} depsDir
 * @param {(path: string) => boolean} exists
 * @param {(path: string) => string[]} list
 * @returns {string[]} problems; empty when complete
 */
export const depsProblems = (depsDir, exists, list) => {
  if (!exists(depsDir)) return [`${depsDir} does not exist`];
  const problems = [];
  for (const sub of ["bin", "lib"]) {
    const dir = join(depsDir, sub);
    if (!exists(dir) || list(dir).length === 0) problems.push(`${dir} is missing or empty`);
  }
  for (const file of ["bin/ffmpeg", "bin/ffprobe", "bin/sf-lifeline", "deps-manifest.json", `${PLAYER_HELPER_APP}/Contents/MacOS/mpv`]) {
    if (!exists(join(depsDir, file))) problems.push(`${join(depsDir, file)} is missing`);
  }
  return problems;
};

/** @param {{ electronPlatformName: string; appOutDir: string; packager: { appInfo: { productFilename: string } } }} context */
export default async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const contents = join(appPath, "Contents");
  const depsDir = join(contents, "Resources", "deps");

  const problems = depsProblems(depsDir, existsSync, (dir) => readdirSync(dir));
  if (problems.length > 0) {
    throw new Error(
      `[mac-after-pack] the packaged deps bundle is incomplete, refusing to build a dmg:\n  ${problems.join("\n  ")}\n` +
        "fetch it first: bun scripts/fetch-deps.ts --target macos-<arch>   (from the repo root)",
    );
  }

  const helpersDir = join(contents, "Helpers");
  const helperTarget = join(helpersDir, PLAYER_HELPER_APP);
  mkdirSync(helpersDir, { recursive: true });
  if (existsSync(helperTarget)) throw new Error(`[mac-after-pack] ${helperTarget} already exists`);
  renameSync(join(depsDir, PLAYER_HELPER_APP), helperTarget);
  console.log(`[mac-after-pack] moved ${PLAYER_HELPER_APP} to ${relative(appPath, helperTarget)}`);
  const helperPlist = join(helperTarget, "Contents", "Info.plist");
  for (const key of ["CFBundleName", "CFBundleDisplayName"]) {
    const value = runMacTool("plutil", ["-extract", key, "raw", "-o", "-", helperPlist]).trim();
    if (value !== PLAYER_HELPER_NAME) throw new Error(`[mac-after-pack] ${PLAYER_HELPER_APP} ${key} is "${value}", expected "${PLAYER_HELPER_NAME}" (REL-MAC-09)`);
  }

  finishMacApp(appPath, join(contents, "MacOS", context.packager.appInfo.productFilename));
}
