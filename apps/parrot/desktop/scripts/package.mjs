// Host-agnostic desktop packager: builds the Parrot app for one target (linux-x64 | windows-x64 | macos-arm64 |
// macos-x64) from one electron-builder config. The steps both apps share live in
// packages/desktop-platform/packaging/package-steps.mjs (REL-FAM-03); this file adds only Parrot's own: its app.asar and
// app-update.yml check (Parrot ships no media deps, native modules or runtime, unlike Badger).
// Linux builds the Linux and (unsigned) Windows targets; signing Windows needs a Windows host with .NET; the macOS
// dmgs build on a Mac (codesign + hdiutil), both arches on either Mac.
//
//   node scripts/package.mjs [--target linux-x64|windows-x64|macos-arm64|macos-x64] [--linux-formats AppImage,deb,rpm,pacman] [--test-build]
//
// --test-build (`package:windows-test`, as Badger): a dev-key TEST package for runs against a development-key stack,
// never a release: renderer built with VITE_SF_DEV_TICKET_KEY=1, version marked `-devkey`, and a Windows build may be
// unsigned (packages/desktop-platform/packaging/test-build-lib.mjs). A release Windows build without the signing secrets still fails.
//
// The in-app updater's feed (REL-UPD-01) is baked into app-update.yml: https://api.spacefleet.io/desktop/parrot, or
// SF_UPDATE_FEED_URL when set (electron-builder.config.mjs). electron-builder writes latest-linux.yml / latest.yml (+ the
// installer's .blockmap) / latest-mac.yml (listing the -mac.zip) next to the installers.
//
// Steps (each timed; the report lands in dist/package-report-<target>.json):
//   build             electron-vite build (source maps on in electron.vite.config.ts) + main-bundle check
//   symbols           debug ids injected into out/ (scripts/bugsink-sourcemaps.ts); maps uploaded to Bugsink project
//                     parrot-desktop when SF_BUGSINK_AUTH_TOKEN is set (SF_BUGSINK_UPLOAD_REQUIRED=1: a missing token
//                     fails); dist/sourcemaps-<target>.tgz kept beside the installer either way; a build with no
//                     source maps is refused (REL-LOG-06)
//   electron-builder  AppImage + .deb + .rpm + .pacman (+ latest-linux.yml) / NSIS installer (+ latest.yml and .blockmap;
//                     Azure Artifact Signing when configured, Badger's windows-signing-lib.mjs) / dmg + update zip
//                     (+ latest-mac.yml; the app signed by scripts/mac-after-pack.mjs: Developer ID when the APPLE_*
//                     variables are set, then notarized and stapled before it is zipped, Badger's mac-signing-lib.mjs,
//                     ad-hoc otherwise)
//   verify            app.asar holds the built app and no source maps or node_modules; only Parrot's UI locales ship;
//                     app-update.yml is packaged
//   signatures        Windows, signing configured: the installer and every unpacked .exe carry a valid, timestamped signature
//   notarize          macOS, signing configured: the dmg is signed, notarized (notarytool), stapled, accepted by Gatekeeper;
//                     the app in the update zip is stapled and accepted by Gatekeeper
//   report            sha256 + size of each artifact; every expected format must be there
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { listAsarEntries } from "@space/desktop-platform/packaging/asar-entries";
import { createPackageRun } from "@space/desktop-platform/packaging/package-steps";
import { TEST_BUILD_FLAG, packageBuildEnv } from "@space/desktop-platform/packaging/test-build-lib";
import { checkParrotAsarEntries, linuxArtifactPatterns, resolveLinuxFormats, resolvePackageTarget } from "./package-targets.mjs";

const appDir = resolve(import.meta.dirname, "..");

const argValue = (flag) => {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
};

const target = resolvePackageTarget(argValue("--target") ?? process.env.SF_PACKAGE_TARGET);
const linuxFormats = target.id === "linux-x64" ? resolveLinuxFormats(argValue("--linux-formats") ?? process.env.SF_LINUX_FORMATS) : [];
const artifactPatterns = target.id === "linux-x64" ? linuxArtifactPatterns(linuxFormats) : target.artifactPatterns;
const testBuild = process.argv.includes(TEST_BUILD_FLAG);
const pkg = createPackageRun({ appDir, target, testBuild, runEnv: { SF_LINUX_FORMATS: linuxFormats.join(",") } });
const { tag, distDir, step, run } = pkg;
if (target.id === "linux-x64") {
  pkg.assertLinuxTools(linuxFormats, ", or pass --linux-formats AppImage");
  console.log(`${tag} Linux formats: ${linuxFormats.join(", ")}`);
}

await step("build", async () => {
  // META-ANON-06 (as Badger): a release pins the production ticket key; the dev-key flag is refused from the caller's
  // environment and blanked for the build. Only --test-build (a `-devkey` package) builds with it, as `build:test`.
  run("bun", ["run", testBuild ? "build:test" : "build"], { env: packageBuildEnv({ testBuild, env: process.env }) });
  run("bun", ["run", "check:main-bundle"]);
});

await pkg.symbols({ project: "parrot-desktop" });

await pkg.electronBuilder();

await step("verify", async () => {
  const resourcesDir = join(distDir, target.unpackedDir, target.resourcesSubpath);
  const asarPath = join(resourcesDir, "app.asar");
  if (!existsSync(asarPath)) throw new Error(`packaged ${target.id} build has no ${asarPath}`);
  const entries = listAsarEntries(asarPath);
  const { unexpected, missing } = checkParrotAsarEntries(entries);
  console.log(`${tag} app.asar: ${entries.length} entries`);
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(
      `packaged ${target.id} app.asar content is off (${unexpected.length} unexpected, e.g. ${unexpected.slice(0, 5).join(", ") || "none"}; ` +
        `missing: ${missing.join(", ") || "none"}) in ${asarPath}`,
    );
  }
  pkg.verifyLocales();
  // electron-updater reads the feed URL from it (REL-UPD-01): an app without it can never update itself.
  const appUpdateYml = join(resourcesDir, "app-update.yml");
  if (!existsSync(appUpdateYml)) throw new Error(`packaged ${target.id} build has no ${appUpdateYml}: the in-app updater would have no feed`);
  console.log(`${tag} app-update.yml: present`);
});

await pkg.signatures();
await pkg.notarize();
await pkg.report({ artifactPatterns, extra: target.id === "linux-x64" ? { linuxFormats } : {} });
