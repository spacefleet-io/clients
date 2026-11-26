// electron-builder configuration for the Badger desktop app: one config, one
// target per OS. `scripts/package.mjs` drives it and sets:
//   SF_PACKAGE_TARGET   linux-x64 | windows-x64 | macos-arm64 | macos-x64   (default linux-x64)
//   SF_UPDATE_FEED_URL  electron-updater generic feed base URL baked into
//                       app-update.yml (default https://api.spacefleet.io/desktop/badger)
//   SF_PACKAGE_TEST_BUILD "1" only for `package.mjs --test-build`: the version gets the `-devkey`
//                       test-build mark (packages/desktop-platform/packaging/test-build-lib.mjs, META-ANON-06)
// Nothing here inspects the host OS, so Linux cross-builds the Windows installer
// (a dev-key test build only: a release Windows build must be signed) and a Windows host builds the same output.
// Windows signing (Azure Artifact Signing, REL-INST-03) comes from the AZURE_* environment variables
// (packages/desktop-platform-windows/packaging/windows-signing-lib.mjs) and runs on a Windows host only. macOS dmgs
// need the host's codesign + hdiutil (scripts/mac-after-pack.mjs).
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { MAC_MINIMUM_SYSTEM_VERSION, resolvePackageTarget, stageDirFor } from "./scripts/package-targets.mjs";
import { asarFileExcludes } from "./scripts/packaged-asar-lib.mjs";
import { LINUX_FORMATS, nativeLinuxPackageOptions } from "@space/desktop-platform-linux/packaging/linux-packages";
import { linuxAfterInstallScript, withLinuxModes } from "@space/desktop-platform-linux/packaging/file-modes";
import { ELECTRON_LANGUAGES } from "@space/desktop-platform/packaging/packaged-locales-lib";
import { TEST_BUILD_ENV, testBuildVersion } from "@space/desktop-platform/packaging/test-build-lib";
import { resolveWindowsSigning, windowsSigningBuilderOptions, windowsUpdatePublisherFor } from "@space/desktop-platform-windows/packaging/windows-signing-lib";

const appDir = import.meta.dirname;
const repoRoot = resolve(appDir, "..", "..", "..");
// The app icons (UX-THEME-04, drawn by scripts/app-icons/generate.py). Linux and Windows: the helmet alone on
// transparency. ICON_SOURCE (1024 px) is the window / tray icon on Linux and Windows; LINUX_ICONS (one PNG per hicolor
// size) the AppImage/.deb/.rpm/.pacman icons; WINDOWS_ICON the .exe and NSIS installer icon. Each platform names its
// own: without linux.icon electron-builder draws the Linux icons from mac.icon, the navy tile. The renderer favicon
// (src/renderer/public/icon.png) is 403x366 and electron-builder rejects/mangles non-square icons.
const ICON_SOURCE = "installer/icon.png";
const LINUX_ICONS = "installer/icons";
const WINDOWS_ICON = "installer/icon.ico";
// macOS app icon: the mascot on the navy rounded square, on Apple's grid with its margin (all sizes 16..1024).
const MAC_ICON = "installer/icon.icns";
// macOS menu-bar icon: monochrome template image (16 pt, @2x 32 px), PLAT-DESK-06.
// Shipped on every target; the platform layer's shell.trayIcon picks it.
const TRAY_TEMPLATE_ICONS = ["trayTemplate.png", "trayTemplate@2x.png"];

export const DEFAULT_UPDATE_FEED_URL = "https://api.spacefleet.io/desktop/badger";

/** @param {{ targetId?: string; updateFeedUrl?: string; testBuild?: boolean; env?: Record<string, string | undefined> }} [options] */
export const createBuilderConfig = ({ targetId, updateFeedUrl = DEFAULT_UPDATE_FEED_URL, testBuild = false, env = process.env } = {}) => {
  const target = resolvePackageTarget(targetId);
  const stageDir = stageDirFor(appDir, target);
  const feedUrl = updateFeedUrl.replace(/\/+$/, "");
  // Only the Windows target reads the signing variables: a half-set AZURE_* must not break a Linux or macOS build.
  // REL-INST-03: a release build must be signed and its updater checks the publisher; a dev-key test build may be unsigned.
  const winPublisher = windowsUpdatePublisherFor({ testBuild });
  const winSigning =
    target.id === "windows-x64" ? windowsSigningBuilderOptions(resolveWindowsSigning(env, winPublisher), winPublisher) : { verifyUpdateCodeSignature: false };

  // Resources every target ships, under <resources>/:
  //   runtime/        the compiled runtime binary (+ slices/), spawned detached by the app
  //   mpv/osc, mpv/icons   our OSC lua scripts, fonts and mpv icon (the only OSC mpv may run)
  //   icon.png        tray / window icon
  //   trayTemplate*.png   menu-bar template icon (macOS)
  const sharedExtraResources = [
    { from: join(stageDir, "runtime"), to: "runtime" },
    { from: join(repoRoot, "packages", "mpv", "resources", "osc"), to: "mpv/osc" },
    { from: join(repoRoot, "packages", "mpv", "resources", "icons"), to: "mpv/icons" },
    { from: join(appDir, ICON_SOURCE), to: "icon.png" },
    ...TRAY_TEMPLATE_ICONS.map((name) => ({ from: join(appDir, "installer", name), to: name })),
  ];

  // Bundled external binaries per the DepsBuilds contract: the whole
  // vendor/deps/<target>/ (bin/ + deps-manifest.json) lands in <resources>/deps/.
  const depsResources = [{ from: join(repoRoot, target.depsDir), to: "deps" }];

  return {
    // Bundle id never changes (REL-MAC-05): macOS ties settings and Keychain entries to it.
    appId: "io.spacefleet.badger-desktop",
    // META-ANON-06: a dev-key test package carries `<version>-devkey` (installer name, Apps & features, app.getVersion()),
    // which the installer store refuses, so it is never mistaken for, or registered as, a release.
    // REL-DIST-04: `homepage` is the Linux packages' homepage (fpm refuses a .deb/.rpm/.pacman without one); package.json carries none.
    extraMetadata: {
      homepage: "https://spacebadger.io",
      ...(testBuild ? { version: testBuildVersion(JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")).version) } : {}),
    },
    // Per target (scripts/package-targets.mjs): "Badger" everywhere, Badger.app on macOS (REL-MAC-05).
    productName: target.productName,
    electronVersion: "45.3.2",
    npmRebuild: false,
    asarUnpack: ["**/*.node"],
    // Only the locales the UI supports (en, fr, nl, de); see packages/desktop-platform/packaging/packaged-locales-lib.mjs.
    electronLanguages: ELECTRON_LANGUAGES,
    // No source maps, no unused drizzle-orm dialects: see scripts/packaged-asar-lib.mjs.
    files: ["out/**", "node_modules/**", "package.json", ...asarFileExcludes()],
    extraResources: [...sharedExtraResources, ...depsResources],
    // PLAT-WEB-05: `badger://` starts the desktop player from the web player (Linux x-scheme-handler/badger in the
    // .desktop MimeType, macOS CFBundleURLTypes, Windows registry via NSIS). main/index.ts also registers it at runtime.
    protocols: [{ name: "Badger", schemes: ["badger"] }],
    // PLAT-DESK-01: AppImage + .deb + .rpm + .pacman, each carrying the same app and the same bundled
    // mpv/ffmpeg (PLAT-DESK-04); only package metadata differs (packages/desktop-platform-linux/packaging/linux-packages.mjs). The native
    // packages install to /opt/Badger and update through electron-updater's Deb/Rpm/PacmanUpdater.
    linux: {
      executableName: "spacebadger",
      target: LINUX_FORMATS,
      // REL-DIST-04: publisher contact, homepage, category Audio & Video; the package name is per format below.
      category: "AudioVideo",
      synopsis: "Your own films and series, played anywhere",
      maintainer: "SpaceFleet <contact@spacefleet.io>",
      vendor: "SpaceFleet",
      icon: LINUX_ICONS,
    },
    // REL-DIST-14: the .deb/.rpm/.pacman are named "spacebadger" (Debian/Ubuntu's own "badger" is BadgerDB 2.x) and
    // take over the "badger" packages Badger 0.1.0/0.1.1 installed.
    ...nativeLinuxPackageOptions({
      appDir,
      packageName: "spacebadger",
      productName: "Badger",
      legacyName: "badger",
      version: JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")).version,
      mpv: true,
      afterInstall: linuxAfterInstallScript(appDir),
    }),
    win: {
      target: [{ target: "nsis", arch: ["x64"] }],
      // REL-INST-03: signed with Azure Artifact Signing (azureSignOptions + signExts: the app exe, every .exe,
      // .dll and .node in the app and extraResources, the uninstaller and the installer); an unsigned Windows build is refused, since
      // the updater checks the publisher (WINDOWS_UPDATE_PUBLISHER_NAME) of every downloaded update.
      // The executable is always edited (icon, version info), which needs wine on Linux.
      // The Windows app is named Badger: Badger.exe, the "Badger" shortcuts, Badger-Setup-<version>.exe.
      ...winSigning,
      executableName: "Badger",
      icon: WINDOWS_ICON,
    },
    mac: {
      // REL-MAC-02/03: the dmg to install and the zip the in-app updater (Squirrel.Mac) downloads, one per arch.
      target: [
        { target: "dmg", arch: [target.arch] },
        { target: "zip", arch: [target.arch] },
      ],
      icon: MAC_ICON,
      category: "public.app-category.video",
      minimumSystemVersion: MAC_MINIMUM_SYSTEM_VERSION,
      // The update zip: Badger-<version>-<arch>-mac.zip (+ .zip.blockmap), listed in latest-mac.yml. The dmg names
      // itself (dmg.artifactName); electron-builder's default would drop the arch from the x64 zip.
      artifactName: "${productName}-${version}-${arch}-mac.${ext}",
      // REL-MAC-02: identity null = electron-builder signs nothing. scripts/mac-after-pack.mjs
      // moves the mpv helper app to Contents/Helpers and signs the whole bundle inside-out:
      // Developer ID with the hardened runtime when the APPLE_* secrets are set (then it also notarizes
      // and staples the .app before electron-builder zips it, and scripts/package.mjs notarizes and
      // staples the dmg), ad-hoc otherwise (Apple Silicon refuses to run unsigned code).
      identity: null,
      hardenedRuntime: false,
      gatekeeperAssess: false,
      notarize: false,
    },
    dmg: {
      // REL-MAC-03: Badger-<version>-arm64.dmg / -x64.dmg (the update zip is named by mac.artifactName).
      artifactName: "Badger-${version}-${arch}.${ext}",
      title: "Badger ${version}",
      // No blockmap: the updater downloads the zip, never the dmg.
      writeUpdateInfo: false,
    },
    // REL-DIST-13: on Linux the packed app is normalized to u=rwX,go=rX before the AppImage/.deb/.rpm/.pacman are built;
    // on macOS the hook signs (scripts/mac-after-pack.mjs).
    afterPack: withLinuxModes(join(appDir, "scripts", "mac-after-pack.mjs")),
    nsis: {
      // One-click, per-user: no wizard pages, no UAC prompt, installs into
      // %LOCALAPPDATA%\Programs and launches the app. That is the simplest UX
      // for a non-technical user, and the same silent path serves auto-updates.
      oneClick: true,
      perMachine: false,
      allowElevation: false,
      runAfterFinish: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: "Badger",
      // Uninstalling must never delete the user's library / settings.
      deleteAppDataOnUninstall: false,
      // The runtime outlives the window and lives inside the install dir; it has
      // to be stopped before files are replaced or removed.
      include: "installer/installer.nsh",
      // electron-builder's default (`${productName} Setup ${version}`) has a
      // space; the update API only serves [A-Za-z0-9._-] artifact names: Badger-Setup-<version>.exe.
      artifactName: "Badger-Setup-${version}.${ext}",
    },
    // In-app updater feed (REL-UPD-01): app-update.yml in the package, latest-linux.yml / latest.yml /
    // latest-mac.yml next to the installers, served by the API at /desktop/badger/<file>.
    publish: [
      {
        provider: "generic",
        url: feedUrl,
        channel: "latest",
      },
    ],
  };
};

export default createBuilderConfig({
  targetId: process.env.SF_PACKAGE_TARGET,
  updateFeedUrl: process.env.SF_UPDATE_FEED_URL || undefined,
  testBuild: process.env[TEST_BUILD_ENV] === "1",
});
