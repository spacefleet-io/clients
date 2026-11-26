// electron-builder afterPack hook for the macOS targets (no-op for the others). Parrot ships no deps bundle or mpv
// helper (Badger's hook moves those first), so it runs only the macOS steps both desktop apps share (finishMacApp,
// packages/desktop-platform-macos/packaging/mac-after-pack-lib.mjs):
// 1. PLAT-DESK-02: the app executable's LC_BUILD_VERSION minos is raised to MAC_MINIMUM_SYSTEM_VERSION (vtool).
// 2. REL-MAC-02: electron-builder signs nothing (mac.identity = null), so everything is signed there, inside-out
//    (loose Mach-O files, nested bundles deepest first, the app last), then `codesign --verify --deep --strict`.
//    Developer ID with hardened runtime, timestamp and the shared entitlements.mac.plist when scripts/package.mjs put
//    an identity in SF_MAC_SIGN_IDENTITY / SF_MAC_SIGN_KEYCHAIN; ad-hoc otherwise.
// 3. REL-MAC-02: a Developer ID app is then notarized and stapled (notarizeIfDeveloperId, SF_MAC_NOTARY_*), so the
//    update zip electron-builder builds next (listed in latest-mac.yml) and the dmg both carry a notarized app.
import { join } from "node:path";

import { finishMacApp } from "@space/desktop-platform-macos/packaging/mac-after-pack-lib";

/** @param {{ electronPlatformName: string; appOutDir: string; packager: { appInfo: { productFilename: string } } }} context */
export default async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  finishMacApp(appPath, join(appPath, "Contents", "MacOS", context.packager.appInfo.productFilename));
}
