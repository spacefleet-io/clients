// Host-agnostic desktop packager: builds the Badger app for one target
// (linux-x64 | windows-x64 | macos-arm64 | macos-x64) from one electron-builder
// config. Linux can build the Linux and Windows targets (the Windows NSIS
// installer is cross-built, needing wine only to edit the executable's
// icon/version info); a Windows host builds the same output. The macOS dmgs
// build on a Mac (codesign + hdiutil), both arches on either Mac. The steps Badger and Parrot share live in
// packages/desktop-platform/packaging/package-steps.mjs (REL-FAM-03); this file adds Badger's own (media deps,
// native-module pruning, runtime compile and staging, and what its package must hold).
//
//   node scripts/package.mjs [--target linux-x64|windows-x64|macos-arm64|macos-x64] [--skip-fetch-deps] [--test-build]
//
// --test-build (`package:windows-test`): a dev-key TEST package for runs against a development-key stack
// (windows-quick.ts), never a release: renderer built with VITE_SF_DEV_TICKET_KEY=1 and version `<version>-devkey`,
// which the installer store refuses (packages/desktop-platform/packaging/test-build-lib.mjs, META-ANON-06). Without the flag nothing changes.
//
// Steps (each timed; the report lands in dist/package-report-<target>.json):
//   fetch-deps        bun scripts/fetch-deps.ts: the published ffmpeg + ffprobe + mpv bundle for the target
//   build             electron-vite build (with source maps) + bundle check
//   symbols           debug ids injected into out/ (scripts/bugsink-sourcemaps.ts); maps uploaded to Bugsink with SF_BUGSINK_AUTH_TOKEN (SF_BUGSINK_UPLOAD_REQUIRED=1: a missing token fails); dist/sourcemaps-<target>.tgz kept beside the installer; a build with no source maps is refused (REL-LOG-06)
//   materialize       prune better-sqlite3 to the target's prebuilds
//   runtime           bun build --compile the runtime for the target (cross-compile)
//   stage             slices next to the runtime binary
//   electron-builder  AppImage + .deb + .rpm + .pacman (+ update feed file, all four listed) / NSIS installer (+ update feed file; signed with Azure Artifact Signing when configured, packages/desktop-platform-windows/packaging/windows-signing-lib.mjs) / dmg + update zip (+ latest-mac.yml listing the zip; the app signed by scripts/mac-after-pack.mjs: Developer ID when the APPLE_* variables are set, then notarized and stapled before it is zipped, packages/desktop-platform-macos/packaging/mac-signing-lib.mjs, ad-hoc otherwise)
//   verify            every required resource and only the supported locales are in the unpacked package, and app.asar holds no source maps or unused drizzle-orm dialects
//   signatures        Windows, signing configured: the installer and every unpacked .exe carry a valid, timestamped signature
//   notarize          macOS, signing configured: the dmg is signed, notarized (notarytool), stapled, and accepted by Gatekeeper (spctl); the app in the update zip is stapled and accepted by Gatekeeper
//   report            sha256 + size of each artifact
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  findMissingResources,
  resolvePackageTarget,
  runtimeBinaryName,
  runtimeCompileArgs,
  stageDirFor,
  unpackedResourcesDir,
} from "./package-targets.mjs";
import { listAsarEntries } from "../../../../packages/desktop-platform/packaging/asar-entries.mjs";
import { createPackageRun } from "../../../../packages/desktop-platform/packaging/package-steps.mjs";
import { checkPackagedAsarEntries } from "./packaged-asar-lib.mjs";
import { packageClosure, SUBTITLE_OCR_DIR, SUBTITLE_OCR_EXTERNAL, subtitleOcrBuildArgs } from "./subtitle-ocr-stage-lib.mjs";
import { LINUX_FORMATS } from "../../../../packages/desktop-platform-linux/packaging/linux-packages.mjs";
import { packageBuildEnv, TEST_BUILD_FLAG } from "../../../../packages/desktop-platform/packaging/test-build-lib.mjs";

const appDir = resolve(import.meta.dirname, "..");
const repoRoot = resolve(appDir, "..", "..", "..");
const runtimeDir = join(repoRoot, "apps", "runtime");

const argValue = (flag) => {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
};

const target = resolvePackageTarget(argValue("--target") ?? process.env.SF_PACKAGE_TARGET);
const skipFetchDeps = process.argv.includes("--skip-fetch-deps");
const testBuild = process.argv.includes(TEST_BUILD_FLAG);
const stageDir = stageDirFor(appDir, target);
const pkg = createPackageRun({ appDir, target, testBuild });
const { distDir, step, run } = pkg;
// PLAT-DESK-01: Badger always builds all four Linux formats.
if (target.id === "linux-x64") pkg.assertLinuxTools(LINUX_FORMATS);

const assertDepsPresent = () => {
  const binDir = join(repoRoot, target.depsDir, "bin");
  if (!existsSync(binDir) || readdirSync(binDir).length === 0) {
    throw new Error(
      `missing bundled binaries for ${target.id}: ${binDir}\n` +
        `fetch them first: bun scripts/fetch-deps.ts --target ${target.id}   (from ${repoRoot})`,
    );
  }
};

await step("fetch-deps", async () => {
  if (!skipFetchDeps) run("bun", [join(repoRoot, "scripts", "fetch-deps.ts"), "--target", target.id], { cwd: repoRoot });
  assertDepsPresent();
});

await step("build", async () => {
  // --sourcemap: every packaged build carries the maps the error reports are symbolicated with (REL-LOG-06); they stay
  // in out/ and out of the installer (packaged-asar-lib.mjs excludes **/*.map).
  // META-ANON-06: a release pins the production ticket key. The dev-key flag of test builds (`build:test`) is refused
  // here and blanked for the build, so neither the shell nor an .env file can slip it into a package. Only --test-build
  // (a `-devkey` test package the installer store refuses) builds with it: the app is then the same `build:test` test
  // build the e2e runs use, packaged (packages/desktop-platform/packaging/test-build-lib.mjs).
  run("bun", ["run", testBuild ? "build:test" : "build", "--sourcemap"], { env: packageBuildEnv({ testBuild, env: process.env }) });
  run("bun", ["run", "check:main-bundle"]);
});

await pkg.symbols({ project: "badger-desktop" });

await step("materialize", async () => {
  // Cross-target prunes would leave the host's node_modules without its own
  // better-sqlite3 prebuild; put it back however this script ends.
  process.on("exit", () => {
    spawnSync(process.execPath, [join(appDir, "scripts", "materialize-runtime-deps.mjs")], {
      stdio: "inherit",
      cwd: appDir,
      env: { ...process.env, SF_PACKAGE_TARGET: "" },
    });
  });
  run(process.execPath, [join(appDir, "scripts", "materialize-runtime-deps.mjs")]);
});

await step("runtime", async () => {
  rmSync(join(stageDir, "runtime"), { recursive: true, force: true });
  mkdirSync(join(stageDir, "runtime"), { recursive: true });
  const outfile = join(stageDir, "runtime", runtimeBinaryName(target));
  run("bun", runtimeCompileArgs(target, outfile), {
    cwd: runtimeDir,
  });
});

await step("stage", async () => {
  // The runtime reads slice manifests from RUNTIME_SLICES_DIR; Badger ships
  // the core slice and its own module slice only.
  const slicesOut = join(stageDir, "runtime", "slices");
  cpSync(join(runtimeDir, "slices", "core"), join(slicesOut, "core"), { recursive: true });
  cpSync(join(runtimeDir, "slices", "modules", "badger"), join(slicesOut, "modules", "badger"), { recursive: true });
  // PLAY-TRACK-05: the subtitle OCR child, bundled, with tesseract.js and its deps beside it.
  const ocrOut = join(stageDir, "runtime", SUBTITLE_OCR_DIR);
  const ingestCoreDir = join(repoRoot, "packages", "ingest-core");
  run("bun", subtitleOcrBuildArgs(join(ingestCoreDir, "src", "subtitleOcr", "cli.ts"), join(ocrOut, "subtitle-ocr.js")), { cwd: repoRoot });
  for (const [name, dir] of packageClosure(ingestCoreDir, SUBTITLE_OCR_EXTERNAL)) {
    cpSync(dir, join(ocrOut, "node_modules", name), { recursive: true, dereference: true });
  }
});

// The app's main bundle is large enough that electron-builder's asar step needs more than Node's default heap.
await pkg.electronBuilder({ env: { NODE_OPTIONS: "--max-old-space-size=8192" } });

await step("verify", async () => {
  const resourcesDir = unpackedResourcesDir(distDir, target);
  const missing = findMissingResources(resourcesDir, target, existsSync);
  if (missing.length > 0) {
    throw new Error(`packaged ${target.id} build is missing: ${missing.join(", ")} (in ${resourcesDir})`);
  }
  const asarPath = join(resourcesDir, "app.asar");
  const { unexpected, missing: missingEntries } = checkPackagedAsarEntries(listAsarEntries(asarPath));
  if (unexpected.length > 0 || missingEntries.length > 0) {
    throw new Error(
      `packaged ${target.id} app.asar content is off (${unexpected.length} unexpected, e.g. ${unexpected.slice(0, 5).join(", ") || "none"}; ` +
        `missing: ${missingEntries.join(", ") || "none"}) in ${asarPath}`,
    );
  }
  pkg.verifyLocales();
});

await pkg.signatures();
await pkg.notarize();
await pkg.report();
