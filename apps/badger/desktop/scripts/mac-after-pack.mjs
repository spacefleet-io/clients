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
// 2. PLAT-DESK-02: Electron's prebuilt app executable says minos 13.0. Its
//    LC_BUILD_VERSION is raised to MAC_MINIMUM_SYSTEM_VERSION (vtool, from
//    the Xcode command line tools), so dyld enforces the same floor as
//    LSMinimumSystemVersion. Electron's frameworks and helpers keep their own
//    minos: they only run under that executable.
// 3. REL-MAC-02: electron-builder signs nothing (mac.identity = null), so
//    everything is signed here, inside-out: every loose Mach-O file (deps
//    dylibs and executables, the compiled runtime, better-sqlite3's .node,
//    Electron's framework libraries), then every nested bundle deepest first
//    (Electron helpers and frameworks, the Player helper), then the app
//    itself, and the result must pass `codesign --verify --deep --strict`.
//    With the Developer ID identity scripts/package.mjs puts in
//    SF_MAC_SIGN_IDENTITY / SF_MAC_SIGN_KEYCHAIN, items get the hardened
//    runtime, a secure timestamp and installer/entitlements.mac.plist (see
//    scripts/mac-signing-lib.mjs); without it they are ad-hoc signed
//    (`codesign -s -`).
// 4. REL-MAC-02: a Developer ID app is then notarized and stapled
//    (notarizeIfDeveloperId, SF_MAC_NOTARY_* from package.mjs), so the
//    update zip electron-builder builds next (listed in latest-mac.yml)
//    and the dmg both carry a notarized, stapled app.
//
// A missing or empty deps bundle fails the build loudly: a dmg without mpv /
// ffmpeg would install fine and break at first playback.
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, renameSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { afterPackIdentity, codesignArgs, notarizeIfDeveloperId } from "./mac-signing-lib.mjs";
import { MAC_MINIMUM_SYSTEM_VERSION } from "./package-targets.mjs";

const ENTITLEMENTS = join(import.meta.dirname, "..", "installer", "entitlements.mac.plist");

/** The helper app, in the deps bundle and in the packaged app (Contents/Helpers), REL-MAC-09. */
export const PLAYER_HELPER_NAME = "Badger Player";
export const PLAYER_HELPER_APP = `${PLAYER_HELPER_NAME}.app`;

// 32/64-bit Mach-O (both byte orders) and fat/universal headers.
const MACH_O_MAGICS = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca]);
const BUNDLE_SUFFIXES = [".app", ".framework", ".xpc", ".appex", ".bundle"];

const isBundleDir = (name) => BUNDLE_SUFFIXES.some((suffix) => name.endsWith(suffix));

const isMachO = (file) => {
  const fd = openSync(file, "r");
  try {
    const header = Buffer.alloc(4);
    if (readSync(fd, header, 0, 4, 0) < 4) return false;
    return MACH_O_MAGICS.has(header.readUInt32BE(0));
  } finally {
    closeSync(fd);
  }
};

/**
 * Every Mach-O file and nested bundle below `root` (symlinks are not followed:
 * framework `Versions/Current` links would list the same code twice).
 * @param {string} root
 * @returns {{ files: string[]; bundles: string[] }}
 */
export const collectSignables = (root) => {
  const files = [];
  const bundles = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (isBundleDir(entry.name)) bundles.push(full);
        walk(full);
      } else if (entry.isFile() && isMachO(full)) {
        files.push(full);
      }
    }
  };
  walk(root);
  return { files, bundles };
};

const depth = (path) => path.split(sep).length;

/**
 * Inside-out signing order: loose Mach-O files first, then bundles deepest
 * first, the app bundle last.
 * @param {string} appPath
 * @param {{ files: string[]; bundles: string[] }} signables
 * @returns {string[]}
 */
export const signingOrder = (appPath, { files, bundles }) => [
  ...[...files].sort((a, b) => depth(b) - depth(a) || a.localeCompare(b)),
  ...[...bundles].filter((bundle) => bundle !== appPath).sort((a, b) => depth(b) - depth(a) || a.localeCompare(b)),
  appPath,
];

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

const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status}):\n${result.stdout}${result.stderr}`);
  }
  return `${result.stdout}${result.stderr}`;
};
const codesign = (args) => run("codesign", args);

/** "13.0" < "14.0" < "14.1" < "26.6", component by component. */
const versionAtLeast = (version, minimum) => {
  const a = version.split(".").map(Number);
  const b = minimum.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
};

/**
 * Raises the LC_BUILD_VERSION minos of every slice of `file` to `minimum` when any slice is below it
 * (the SDK version is kept). Returns the minos values found before the change.
 */
export const raiseMacosMinimum = (file, minimum) => {
  const shown = run("vtool", ["-show-build", file]);
  const minos = [...shown.matchAll(/^\s*minos (\S+)$/gm)].map((m) => m[1]);
  const sdk = /^\s*sdk (\S+)$/m.exec(shown)?.[1];
  if (minos.length === 0 || !sdk) throw new Error(`[mac-after-pack] ${file} has no LC_BUILD_VERSION:\n${shown}`);
  if (minos.every((v) => versionAtLeast(v, minimum))) return minos;
  run("vtool", ["-set-build-version", "macos", minimum, sdk, "-replace", "-output", file, file]);
  return minos;
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
    const value = run("plutil", ["-extract", key, "raw", "-o", "-", helperPlist]).trim();
    if (value !== PLAYER_HELPER_NAME) throw new Error(`[mac-after-pack] ${PLAYER_HELPER_APP} ${key} is "${value}", expected "${PLAYER_HELPER_NAME}" (REL-MAC-09)`);
  }

  const executable = join(contents, "MacOS", context.packager.appInfo.productFilename);
  const before = raiseMacosMinimum(executable, MAC_MINIMUM_SYSTEM_VERSION);
  console.log(`[mac-after-pack] ${relative(appPath, executable)} minos ${before.join(",")} -> ${MAC_MINIMUM_SYSTEM_VERSION} (or above)`);

  const signing = { ...afterPackIdentity(process.env), entitlements: ENTITLEMENTS };
  const order = signingOrder(appPath, collectSignables(appPath));
  console.log(`[mac-after-pack] ${signing.identity ? "Developer ID" : "ad-hoc"} signing ${order.length} items inside-out`);
  for (const item of order) codesign(codesignArgs(signing, item));
  const verify = codesign(["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  console.log(`[mac-after-pack] ${verify.trim()}`);
  const submission = notarizeIfDeveloperId(appPath, signing.identity, process.env, run);
  if (submission) console.log(`[mac-after-pack] notarized and stapled ${appPath} (submission ${submission})`);
}
