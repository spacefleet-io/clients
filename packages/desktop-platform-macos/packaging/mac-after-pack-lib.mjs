// The macOS half both desktop apps' electron-builder afterPack hooks share (apps/*/desktop/scripts/mac-after-pack.mjs).
// `finishMacApp` runs it on the packed .app:
// 1. PLAT-DESK-02: Electron's prebuilt app executable says minos 13.0. Its LC_BUILD_VERSION is raised to
//    MAC_MINIMUM_SYSTEM_VERSION (vtool, from the Xcode command line tools), so dyld enforces the same floor as
//    LSMinimumSystemVersion. Electron's frameworks and helpers keep their own minos: they only run under that executable.
// 2. REL-MAC-02: electron-builder signs nothing (mac.identity = null), so everything is signed here, inside-out (loose
//    Mach-O files, nested bundles deepest first, the app last), and the result must pass
//    `codesign --verify --deep --strict`. With the Developer ID identity the apps' scripts/package.mjs put in
//    SF_MAC_SIGN_IDENTITY / SF_MAC_SIGN_KEYCHAIN, items get the hardened runtime, a secure timestamp and
//    entitlements.mac.plist (next to this file; see mac-signing-lib.mjs); without it they are ad-hoc signed
//    (`codesign -s -`).
// 3. REL-MAC-02: a Developer ID app is then notarized and stapled (notarizeIfDeveloperId, SF_MAC_NOTARY_* from
//    package.mjs), so the update zip electron-builder builds next (listed in latest-mac.yml) and the dmg both carry a
//    notarized, stapled app.
import { spawnSync } from "node:child_process";
import { closeSync, openSync, readSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { afterPackIdentity, codesignArgs, notarizeIfDeveloperId } from "./mac-signing-lib.mjs";

/**
 * PLAT-DESK-02: the oldest macOS the desktop apps run on (Chris 2026-10-16). electron-builder writes it
 * as LSMinimumSystemVersion; the afterPack hook raises the app executable's LC_BUILD_VERSION minos to it.
 */
export const MAC_MINIMUM_SYSTEM_VERSION = "14.0";

/** The entitlements every Developer ID signed item gets (hardened runtime). */
export const MAC_ENTITLEMENTS = join(import.meta.dirname, "entitlements.mac.plist");

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
 * Runs a macOS tool; a non-zero exit throws with its output.
 * @param {string} command
 * @param {string[]} args
 * @returns {string} stdout and stderr
 */
export const runMacTool = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status}):\n${result.stdout}${result.stderr}`);
  }
  return `${result.stdout}${result.stderr}`;
};
const codesign = (args) => runMacTool("codesign", args);

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
  const shown = runMacTool("vtool", ["-show-build", file]);
  const minos = [...shown.matchAll(/^\s*minos (\S+)$/gm)].map((m) => m[1]);
  const sdk = /^\s*sdk (\S+)$/m.exec(shown)?.[1];
  if (minos.length === 0 || !sdk) throw new Error(`[mac-after-pack] ${file} has no LC_BUILD_VERSION:\n${shown}`);
  if (minos.every((v) => versionAtLeast(v, minimum))) return minos;
  runMacTool("vtool", ["-set-build-version", "macos", minimum, sdk, "-replace", "-output", file, file]);
  return minos;
};

/**
 * Steps 1-3 above on a packed .app: raise the executable's minos, sign everything inside-out, verify, then notarize and
 * staple a Developer ID app.
 * @param {string} appPath the .app bundle
 * @param {string} executable its Contents/MacOS executable
 */
export const finishMacApp = (appPath, executable) => {
  const before = raiseMacosMinimum(executable, MAC_MINIMUM_SYSTEM_VERSION);
  console.log(`[mac-after-pack] ${relative(appPath, executable)} minos ${before.join(",")} -> ${MAC_MINIMUM_SYSTEM_VERSION} (or above)`);

  const signing = { ...afterPackIdentity(process.env), entitlements: MAC_ENTITLEMENTS };
  const order = signingOrder(appPath, collectSignables(appPath));
  console.log(`[mac-after-pack] ${signing.identity ? "Developer ID" : "ad-hoc"} signing ${order.length} items inside-out`);
  for (const item of order) codesign(codesignArgs(signing, item));
  const verify = codesign(["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  console.log(`[mac-after-pack] ${verify.trim()}`);
  const submission = notarizeIfDeveloperId(appPath, signing.identity, process.env, runMacTool);
  if (submission) console.log(`[mac-after-pack] notarized and stapled ${appPath} (submission ${submission})`);
};
