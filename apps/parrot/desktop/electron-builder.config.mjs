// electron-builder configuration for the Parrot desktop app: one config, one target per OS, driven by
// scripts/package.mjs, which sets:
//   SF_PACKAGE_TARGET   linux-x64 | windows-x64 | macos-arm64 | macos-x64   (default linux-x64)
//   SF_LINUX_FORMATS    comma-separated subset of AppImage,deb,rpm,pacman  (default all four)
//   SF_UPDATE_FEED_URL  electron-updater generic feed base URL baked into app-update.yml
//                       (default https://api.spacefleet.io/desktop/parrot)
//   SF_PACKAGE_TEST_BUILD "1" only for `package.mjs --test-build`: the version gets the `-devkey` suffix and a Windows
//                       build may be unsigned (Badger's scripts/test-build-lib.mjs, META-ANON-06)
// Mirrors apps/badger/desktop/electron-builder.config.mjs and shares its signing code (scripts/windows-signing-lib.mjs,
// scripts/mac-signing-lib.mjs there), minus what Parrot does not ship: no runtime, no media-deps bundle, no mpv, no
// native module (SQLite is node:sqlite), no NSIS hook. The tray icons ship as Badger's do (PLAT-DESK-10). Nothing here
// inspects the host OS.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { TEST_BUILD_ENV, testBuildVersion } from "../../badger/desktop/scripts/test-build-lib.mjs";
import { resolveWindowsSigning, windowsSigningBuilderOptions, windowsUpdatePublisherFor } from "../../badger/desktop/scripts/windows-signing-lib.mjs";
import { nativeLinuxPackageOptions } from "../../../packages/desktop-platform-linux/packaging/linux-packages.mjs";
import { linuxAfterInstallScript, withLinuxModes } from "../../../packages/desktop-platform-linux/packaging/file-modes.mjs";
import { ELECTRON_LANGUAGES, MAC_MINIMUM_SYSTEM_VERSION, PRODUCT_NAME, resolveLinuxFormats, resolvePackageTarget } from "./scripts/package-targets.mjs";

const appDir = import.meta.dirname;

/** The in-app updater's generic feed (REL-UPD-01): the API serves latest-linux.yml / latest.yml / latest-mac.yml there. */
export const DEFAULT_UPDATE_FEED_URL = "https://api.spacefleet.io/desktop/parrot";
// The app icons (UX-THEME-04, drawn by scripts/app-icons/generate.py), as Badger's. Linux and Windows: the helmet alone
// on transparency. ICON_SOURCE (1024 px) is the window / tray icon on Linux and Windows; LINUX_ICONS (one PNG per hicolor
// size) the AppImage/.deb/.rpm/.pacman icons; WINDOWS_ICON the .exe and NSIS installer icon; the .icns (the mascot on
// the navy rounded square, Apple's grid with its margin) the Mac's. Each platform names its own: without linux.icon
// electron-builder draws the Linux icons from mac.icon, the navy tile.
const ICON_SOURCE = "installer/icon.png";
const LINUX_ICONS = "installer/icons";
const WINDOWS_ICON = "installer/icon.ico";
const MAC_ICON = "installer/icon.icns";
// macOS menu-bar icon: monochrome template image (16 pt, @2x 32 px), PLAT-DESK-06 / PLAT-DESK-10.
export const TRAY_TEMPLATE_ICONS = ["trayTemplate.png", "trayTemplate@2x.png"];

/** @param {{ targetId?: string; linuxFormats?: string; updateFeedUrl?: string; testBuild?: boolean; env?: Record<string, string | undefined> }} [options] */
export const createBuilderConfig = ({ targetId, linuxFormats, updateFeedUrl = DEFAULT_UPDATE_FEED_URL, testBuild = false, env = process.env } = {}) => {
  const target = resolvePackageTarget(targetId);
  // Only the Windows target reads the signing variables: a half-set AZURE_* must not break a Linux or macOS build.
  // REL-INST-03 (as Badger): a release build must be signed and its updater checks the publisher; a dev-key test build may be unsigned.
  const winPublisher = windowsUpdatePublisherFor({ testBuild });
  const winSigning =
    target.id === "windows-x64" ? windowsSigningBuilderOptions(resolveWindowsSigning(env, winPublisher), winPublisher) : { verifyUpdateCodeSignature: false };

  return {
    // Bundle id never changes once shipped: macOS ties settings and Keychain entries to it.
    appId: "io.spacefleet.parrot-desktop",
    productName: PRODUCT_NAME,
    electronVersion: "45.3.2",
    // PLAT-DESK-10: the window / tray icon (Linux, Windows) and the macOS menu-bar template image (16 pt, @2x 32 px),
    // read from process.resourcesPath by src/main/index.ts.
    extraResources: [
      { from: join(appDir, ICON_SOURCE), to: "icon.png" },
      ...TRAY_TEMPLATE_ICONS.map((name) => ({ from: join(appDir, "installer", name), to: name })),
    ],
    npmRebuild: false,
    // Everything (the @space/* packages, music-metadata, the error-report SDK) is bundled into out/ by electron-vite;
    // Parrot has no `dependencies`, so no node_modules ship. No source maps or declarations either (REL-LOG-06: the maps
    // stay in out/ and travel as dist/sourcemaps-<target>.tgz).
    // electron-builder still walks the bun workspace's node_modules and would pack ~2300 files of it: excluded.
    files: ["out/**", "package.json", "!node_modules{,/**/*}", "!**/*.map", "!**/*.d.{ts,cts,mts}"],
    electronLanguages: ELECTRON_LANGUAGES,
    // .deb/.rpm metadata (fpm refuses a package without a homepage); package.json carries none.
    // META-ANON-06 (as Badger): a dev-key test package carries `<version>-devkey`, which the installer store refuses.
    extraMetadata: {
      homepage: "https://spaceparrot.io",
      ...(testBuild ? { version: testBuildVersion(JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")).version) } : {}),
    },
    // ACCT-PAY-05: `parrot://billing/return` brings the browser back to Parrot after paying (Info.plist, .desktop, registry).
    protocols: [{ name: "Parrot", schemes: ["parrot"] }],
    linux: {
      executableName: "spaceparrot",
      target: resolveLinuxFormats(linuxFormats),
      category: "Audio",
      synopsis: "Your own music, uploaded to your SpaceFleet storage and played anywhere",
      maintainer: "SpaceFleet <contact@spacefleet.io>",
      vendor: "SpaceFleet",
      artifactName: "Parrot-${version}-${arch}.${ext}",
      icon: LINUX_ICONS,
    },
    // PLAT-DESK-01: the .deb/.rpm/.pacman package name, dependencies and file names, shared with Badger (Parrot bundles
    // no mpv). REL-DIST-14: named "spaceparrot", taking over the "parrot" packages of Parrot 0.1.0 to 0.1.2.
    ...nativeLinuxPackageOptions({
      appDir,
      packageName: "spaceparrot",
      legacyName: "parrot",
      version: JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")).version,
      mpv: false,
      afterInstall: linuxAfterInstallScript(appDir),
    }),
    win: {
      target: [{ target: "nsis", arch: ["x64"] }],
      // REL-INST-03 (as Badger): signed with Azure Artifact Signing from the AZURE_* variables (an unsigned build is
      // refused). The executable is always edited (icon, version info), which needs wine on Linux.
      ...winSigning,
      executableName: "Parrot",
      icon: WINDOWS_ICON,
    },
    mac: {
      // REL-MAC-02/03 (as Badger): the dmg to install, the zip for the in-app updater (Squirrel.Mac), one per arch.
      target: [
        { target: "dmg", arch: [target.arch] },
        { target: "zip", arch: [target.arch] },
      ],
      category: "public.app-category.music",
      icon: MAC_ICON,
      minimumSystemVersion: MAC_MINIMUM_SYSTEM_VERSION,
      // The update zip: Parrot-<version>-<arch>-mac.zip (+ .zip.blockmap), listed in latest-mac.yml. The dmg names
      // itself (dmg.artifactName); electron-builder's default would drop the arch from the x64 zip.
      artifactName: "${productName}-${version}-${arch}-mac.${ext}",
      // REL-MAC-02 (as Badger): electron-builder signs nothing; scripts/mac-after-pack.mjs signs the bundle
      // inside-out (Developer ID + hardened runtime when the APPLE_* secrets are set, ad-hoc otherwise) and
      // notarizes and staples the .app before electron-builder zips it; scripts/package.mjs notarizes and staples the dmg.
      identity: null,
      hardenedRuntime: false,
      gatekeeperAssess: false,
      notarize: false,
    },
    dmg: {
      artifactName: "Parrot-${version}-${arch}.${ext}",
      title: "Parrot ${version}",
      // No blockmap: the updater downloads the zip, never the dmg.
      writeUpdateInfo: false,
    },
    // REL-DIST-13 (as Badger): Linux normalizes the packed app to u=rwX,go=rX; macOS signs (scripts/mac-after-pack.mjs).
    afterPack: withLinuxModes(join(appDir, "scripts", "mac-after-pack.mjs")),
    nsis: {
      // One-click, per-user, as Badger: no wizard, no UAC, installs into %LOCALAPPDATA%\Programs and launches.
      oneClick: true,
      perMachine: false,
      allowElevation: false,
      runAfterFinish: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: PRODUCT_NAME,
      // Uninstalling must never delete the user's library / settings.
      deleteAppDataOnUninstall: false,
      artifactName: "Parrot-Setup-${version}.${ext}",
    },
    // In-app updater feed (REL-UPD-01): app-update.yml in the package, latest-linux.yml / latest.yml / latest-mac.yml
    // next to the installers, served by the API at /desktop/parrot/<file>.
    publish: [{ provider: "generic", url: updateFeedUrl.replace(/\/+$/, ""), channel: "latest" }],
  };
};

export default createBuilderConfig({
  targetId: process.env.SF_PACKAGE_TARGET,
  linuxFormats: process.env.SF_LINUX_FORMATS,
  updateFeedUrl: process.env.SF_UPDATE_FEED_URL || undefined,
  testBuild: process.env[TEST_BUILD_ENV] === "1",
});
