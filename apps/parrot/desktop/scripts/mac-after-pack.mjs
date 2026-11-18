// electron-builder afterPack hook for the macOS targets (no-op for the others). Badger's hook
// (apps/badger/desktop/scripts/mac-after-pack.mjs) without its deps/mpv-helper half, sharing its code:
// 1. PLAT-DESK-02: the app executable's LC_BUILD_VERSION minos is raised to MAC_MINIMUM_SYSTEM_VERSION (vtool).
// 2. REL-MAC-02: electron-builder signs nothing (mac.identity = null), so everything is signed here, inside-out
//    (loose Mach-O files, nested bundles deepest first, the app last), then `codesign --verify --deep --strict`.
//    Developer ID with hardened runtime, timestamp and Badger's installer/entitlements.mac.plist when
//    scripts/package.mjs put an identity in SF_MAC_SIGN_IDENTITY / SF_MAC_SIGN_KEYCHAIN; ad-hoc otherwise.
// 3. REL-MAC-02: a Developer ID app is then notarized and stapled (notarizeIfDeveloperId, SF_MAC_NOTARY_*), so the
//    update zip electron-builder builds next (listed in latest-mac.yml) and the dmg both carry a notarized app.
import { spawnSync } from "node:child_process";
import { join, relative, resolve } from "node:path";

import { collectSignables, raiseMacosMinimum, signingOrder } from "../../../badger/desktop/scripts/mac-after-pack.mjs";
import { afterPackIdentity, codesignArgs, notarizeIfDeveloperId } from "../../../badger/desktop/scripts/mac-signing-lib.mjs";
import { MAC_MINIMUM_SYSTEM_VERSION } from "./package-targets.mjs";

const ENTITLEMENTS = resolve(import.meta.dirname, "..", "..", "..", "badger", "desktop", "installer", "entitlements.mac.plist");

const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status}):\n${result.stdout}${result.stderr}`);
  return `${result.stdout}${result.stderr}`;
};
const codesign = (args) => run("codesign", args);

/** @param {{ electronPlatformName: string; appOutDir: string; packager: { appInfo: { productFilename: string } } }} context */
export default async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);

  const executable = join(appPath, "Contents", "MacOS", context.packager.appInfo.productFilename);
  const before = raiseMacosMinimum(executable, MAC_MINIMUM_SYSTEM_VERSION);
  console.log(`[mac-after-pack] ${relative(appPath, executable)} minos ${before.join(",")} -> ${MAC_MINIMUM_SYSTEM_VERSION} (or above)`);

  const signing = { ...afterPackIdentity(process.env), entitlements: ENTITLEMENTS };
  const order = signingOrder(appPath, collectSignables(appPath));
  console.log(`[mac-after-pack] ${signing.identity ? "Developer ID" : "ad-hoc"} signing ${order.length} items inside-out`);
  for (const item of order) codesign(codesignArgs(signing, item));
  console.log(`[mac-after-pack] ${codesign(["--verify", "--deep", "--strict", "--verbose=2", appPath]).trim()}`);
  const submission = notarizeIfDeveloperId(appPath, signing.identity, process.env, run);
  if (submission) console.log(`[mac-after-pack] notarized and stapled ${appPath} (submission ${submission})`);
}
