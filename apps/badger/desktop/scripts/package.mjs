// Host-agnostic desktop packager: builds the Badger app for one target
// (linux-x64 | windows-x64 | macos-arm64 | macos-x64) from one electron-builder
// config. Linux can build the Linux and Windows targets (the Windows NSIS
// installer is cross-built, needing wine only to edit the executable's
// icon/version info); a Windows host builds the same output. The macOS dmgs
// build on a Mac (codesign + hdiutil), both arches on either Mac.
//
//   node scripts/package.mjs [--target linux-x64|windows-x64|macos-arm64|macos-x64] [--skip-fetch-deps] [--test-build]
//
// --test-build (`package:windows-test`): a dev-key TEST package for runs against a development-key stack
// (windows-quick.ts), never a release: renderer built with VITE_SF_DEV_TICKET_KEY=1 and version `<version>-devkey`,
// which the installer store refuses (scripts/test-build-lib.mjs, META-ANON-06). Without the flag nothing changes.
//
// Steps (each timed; the report lands in dist/package-report-<target>.json):
//   fetch-deps        bun scripts/fetch-deps.ts: the published ffmpeg + ffprobe + mpv bundle for the target
//   build             electron-vite build (with source maps) + bundle check
//   symbols           debug ids injected into out/ (scripts/bugsink-sourcemaps.ts); maps uploaded to Bugsink with SF_BUGSINK_AUTH_TOKEN (SF_BUGSINK_UPLOAD_REQUIRED=1: a missing token fails); dist/sourcemaps-<target>.tgz kept beside the installer
//   materialize       prune better-sqlite3 to the target's prebuilds
//   runtime           bun build --compile the runtime for the target (cross-compile)
//   stage             slices next to the runtime binary
//   electron-builder  AppImage + .deb + .rpm + .pacman (+ update feed file, all four listed) / NSIS installer (+ update feed file; signed with Azure Artifact Signing when configured, scripts/windows-signing-lib.mjs) / dmg + update zip (+ latest-mac.yml listing the zip; the app signed by scripts/mac-after-pack.mjs: Developer ID when the APPLE_* variables are set, then notarized and stapled before it is zipped, scripts/mac-signing-lib.mjs, ad-hoc otherwise)
//   verify            every required resource and only the supported locales are in the unpacked package, and app.asar holds no source maps or unused drizzle-orm dialects
//   signatures        Windows, signing configured: the installer and every unpacked .exe carry a valid, timestamped signature
//   notarize          macOS, signing configured: the dmg is signed, notarized (notarytool), stapled, and accepted by Gatekeeper (spctl); the app in the update zip is stapled and accepted by Gatekeeper
//   report            sha256 + size of each artifact
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, createReadStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import {
  findMissingResources,
  resolvePackageTarget,
  runtimeBinaryName,
  runtimeCompileArgs,
  stageDirFor,
  unpackedResourcesDir,
} from "./package-targets.mjs";
import { checkPackagedAsarEntries, listAsarEntries } from "./packaged-asar-lib.mjs";
import { checkPackagedLocales } from "./packaged-locales-lib.mjs";
import {
  MAC_NOTARY_ISSUER_ENV,
  MAC_NOTARY_KEY_ENV,
  MAC_NOTARY_KEY_ID_ENV,
  MAC_SIGN_IDENTITY_ENV,
  MAC_SIGN_KEYCHAIN_ENV,
  assessZippedApp,
  notaryAccepted,
  notarytoolSubmitArgs,
  openSigningKeychain,
  removeAppCopy,
  resolveMacSigning,
} from "./mac-signing-lib.mjs";
import { packageClosure, SUBTITLE_OCR_DIR, SUBTITLE_OCR_EXTERNAL, subtitleOcrBuildArgs } from "./subtitle-ocr-stage-lib.mjs";
import { LINUX_FORMATS, LINUX_TOOL_PACKAGES, missingLinuxPackageTools } from "../../../../packages/desktop-platform-linux/packaging/linux-packages.mjs";
import { PACKAGING_UMASK } from "../../../../packages/desktop-platform-linux/packaging/file-modes.mjs";
import { packageBuildEnv, TEST_BUILD_ENV, TEST_BUILD_FLAG } from "./test-build-lib.mjs";
import {
  assertWindowsSigningHost,
  authenticodeCheckScript,
  authenticodeProblems,
  listPortableExecutables,
  resolveWindowsSigning,
  windowsSigningLogLine,
  windowsUpdatePublisherFor,
} from "./windows-signing-lib.mjs";

const appDir = resolve(import.meta.dirname, "..");
// REL-DIST-13: every file this run and its children (electron-builder, fpm) write is 644/755, whatever umask the host
// hands us (the CI job containers run with 000, which shipped world-writable files in the .deb/.rpm/.pacman).
process.umask(PACKAGING_UMASK);
const repoRoot = resolve(appDir, "..", "..", "..");
const runtimeDir = join(repoRoot, "apps", "runtime");
const distDir = join(appDir, "dist");

const argValue = (flag) => {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
};

const target = resolvePackageTarget(argValue("--target") ?? process.env.SF_PACKAGE_TARGET);
const skipFetchDeps = process.argv.includes("--skip-fetch-deps");
const testBuild = process.argv.includes(TEST_BUILD_FLAG);
if (testBuild) console.log(`[package:${target.id}] TEST build: development ticket key pinned, version marked -devkey; never a release (META-ANON-06)`);
const stageDir = stageDirFor(appDir, target);

// Decided before anything is built: a half-configured or wrong-host signing setup fails in seconds, not after the build.
// A release Windows build must be signed (REL-INST-03: installed apps check the update's publisher); a test build may not be.
const windowsSigning = target.id === "windows-x64" ? resolveWindowsSigning(process.env, windowsUpdatePublisherFor({ testBuild })) : null;
if (windowsSigning) {
  assertWindowsSigningHost(windowsSigning, process.platform, existsSync(join(process.env.ProgramFiles ?? "C:\\Program Files", "dotnet", "dotnet.exe")));
  console.log(`[package:${target.id}] ${windowsSigningLogLine(windowsSigning)}`);
}
const macSigning = target.id.startsWith("macos-") ? resolveMacSigning(process.env) : null;
if (macSigning) {
  if (macSigning.configured && process.platform !== "darwin") throw new Error("macOS signing needs a Mac (codesign, notarytool)");
  console.log(`[package:${target.id}] macOS signing: ${macSigning.configured ? `Developer ID, team ${macSigning.teamId}, notarized` : "ad-hoc (APPLE_* not set)"}`);
}
// PLAT-DESK-01: the .deb/.rpm/.pacman need host tools (fpm shells out to them): fail in seconds, naming the packages.
if (target.id === "linux-x64") {
  const missingTools = missingLinuxPackageTools(LINUX_FORMATS, (tool) => spawnSync("sh", ["-c", `command -v ${tool}`], { stdio: "ignore" }).status === 0);
  if (missingTools.length > 0) {
    throw new Error(
      `[package:${target.id}] building the Linux packages needs ${missingTools.join(", ")} on this host ` +
        `(Debian: apt-get install ${[...new Set(missingTools.map((tool) => LINUX_TOOL_PACKAGES[tool]))].join(" ")})`,
    );
  }
}

const steps = [];
const step = async (name, fn) => {
  const startedAt = Date.now();
  console.log(`\n[package:${target.id}] ${name}`);
  try {
    await fn();
  } finally {
    const ms = Date.now() - startedAt;
    steps.push({ name, ms });
    console.log(`[package:${target.id}] ${name} done in ${(ms / 1000).toFixed(1)}s`);
  }
};

const run = (command, args, options = {}) => {
  console.log(`$ ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, {
    stdio: "inherit",
    cwd: appDir,
    ...options,
    env: { ...process.env, SF_PACKAGE_TARGET: target.id, ...options.env },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status ?? result.signal}`);
  }
};

/** Runs a command and returns its output; the output is shown only when it fails (it may name keychain paths, never secrets). */
const capture = (command, args) => {
  const result = spawnSync(command, args, { cwd: appDir, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args[0] ?? ""} exited with ${result.status ?? result.signal}:\n${result.stdout}${result.stderr}`);
  return `${result.stdout}${result.stderr}`;
};

// The throwaway signing keychain lives from the electron-builder step to the end of the run, however it ends.
let macKeychain = null;
const closeMacKeychain = () => {
  if (!macKeychain) return;
  const { close } = macKeychain;
  macKeychain = null;
  close();
};
process.on("exit", closeMacKeychain);

const sha256 = (file) =>
  new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolveHash(hash.digest("hex")));
  });

const assertDepsPresent = () => {
  const binDir = join(repoRoot, target.depsDir, "bin");
  if (!existsSync(binDir) || readdirSync(binDir).length === 0) {
    throw new Error(
      `missing bundled binaries for ${target.id}: ${binDir}\n` +
        `fetch them first: bun scripts/fetch-deps.ts --target ${target.id}   (from ${repoRoot})`,
    );
  }
};

/** Every file under `dir`, as absolute paths. */
const walkFiles = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walkFiles(join(dir, entry.name)) : [join(dir, entry.name)]));

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
  // build the e2e runs use, packaged (scripts/test-build-lib.mjs).
  run("bun", ["run", testBuild ? "build:test" : "build", "--sourcemap"], { env: packageBuildEnv({ testBuild, env: process.env }) });
  run("bun", ["run", "check:main-bundle"]);
});

// REL-LOG-06: debug ids go into the built JS before it is packaged, so the shipped files carry them (needs no
// credentials: every build, local or CI, does it). The maps then go to Bugsink when the build has the token, or must
// (SF_BUGSINK_UPLOAD_REQUIRED=1: the Linux release workflow, where a missing token fails the build). A build without
// either (a developer's or a PR's quick build) skips the upload; the Windows and macOS installers are built that way,
// and their maps travel in `sourcemaps-<target>.tgz` next to the installer, from which the release workflow uploads
// them. A checkout without scripts/bugsink-sourcemaps.ts (the public clients repo) skips the inject and the upload.
await step("symbols", async () => {
  const bugsink = join(repoRoot, "scripts", "bugsink-sourcemaps.ts");
  const outDir = join(appDir, "out");
  const required = process.env.SF_BUGSINK_UPLOAD_REQUIRED === "1";
  const haveBugsink = existsSync(bugsink);
  if (!haveBugsink && required) throw new Error(`SF_BUGSINK_UPLOAD_REQUIRED=1 but ${bugsink} is missing`);
  if (!haveBugsink) {
    console.log(`[package:${target.id}] scripts/bugsink-sourcemaps.ts is not in this checkout: debug ids not injected, symbols not uploaded`);
  } else {
    run("bun", [bugsink, "inject", outDir], { cwd: repoRoot });
    if (process.env.SF_BUGSINK_AUTH_TOKEN?.trim() || required) {
      // Required means required: an inherited SF_BUGSINK_UPLOAD_OPTIONAL=1 must not turn a missing token into a notice.
      run("bun", [bugsink, "upload", outDir, "--project", "badger-desktop"], {
        cwd: repoRoot,
        env: required ? { SF_BUGSINK_UPLOAD_OPTIONAL: "" } : {},
      });
    } else {
      console.log(`[package:${target.id}] SF_BUGSINK_AUTH_TOKEN is not set: debug symbols not uploaded here (the sourcemaps archive goes to the installer store)`);
    }
  }
  const archive = join(distDir, `sourcemaps-${target.id}.tgz`);
  mkdirSync(distDir, { recursive: true });
  rmSync(archive, { force: true });
  const files = walkFiles(outDir)
    .filter((file) => /\.(?:c?js|mjs|map)$/.test(file))
    .map((file) => relative(appDir, file).split(sep).join("/"));
  if (files.length === 0) throw new Error(`no built .js or .map files under ${outDir} to archive`);
  const listFile = join(distDir, `sourcemaps-${target.id}.list`);
  writeFileSync(listFile, `${files.join("\n")}\n`);
  try {
    run("tar", ["-czf", archive, "-C", appDir, "-T", listFile]);
  } finally {
    rmSync(listFile, { force: true });
  }
});

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

await step("electron-builder", async () => {
  removeAppCopy(join(distDir, target.unpackedDir), capture);
  // A stale installer from an earlier build must never be reported (or shipped)
  // as this build's output.
  if (existsSync(distDir)) {
    for (const name of readdirSync(distDir)) {
      if (target.artifactPatterns.some((pattern) => pattern.test(name))) rmSync(join(distDir, name), { force: true });
    }
  }
  const builderArgs = ["--config", "electron-builder.config.mjs", target.builderFlag, `--${target.arch}`, "--publish", "never"];
  if (macSigning?.configured) {
    macKeychain = openSigningKeychain(macSigning, { run: capture, intermediateCert: join(appDir, "installer", "DeveloperIDG2CA.cer") });
    console.log(`[package:${target.id}] signing as ${macKeychain.identity.name}`);
  }
  run("bun", ["x", "electron-builder", ...builderArgs], {
    env: {
      NPM_CONFIG_WORKSPACES: "false",
      NPM_CONFIG_WORKSPACE: "false",
      NODE_OPTIONS: "--max-old-space-size=8192",
      [TEST_BUILD_ENV]: testBuild ? "1" : "",
      [MAC_SIGN_IDENTITY_ENV]: macKeychain?.identity.hash ?? "",
      [MAC_SIGN_KEYCHAIN_ENV]: macKeychain?.keychain ?? "",
      // afterPack notarizes the signed app before electron-builder zips it (mac-signing-lib.mjs notarizeIfDeveloperId).
      [MAC_NOTARY_KEY_ENV]: macKeychain?.notaryKey ?? "",
      [MAC_NOTARY_KEY_ID_ENV]: macKeychain ? macSigning.notaryKeyId : "",
      [MAC_NOTARY_ISSUER_ENV]: macKeychain ? macSigning.notaryIssuerId : "",
    },
  });
});

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
  const localesDir = join(distDir, target.unpackedDir, target.locales.subpath);
  const { unexpected: unexpectedLocales, missing: missingLocales } = checkPackagedLocales(
    readdirSync(localesDir),
    target.locales.languages,
    target.locales.extension,
  );
  if (unexpectedLocales.length > 0 || missingLocales.length > 0) {
    throw new Error(
      `packaged ${target.id} locales differ from ${target.locales.languages.join(", ")} (unexpected: ${unexpectedLocales.join(", ") || "none"}; ` +
        `missing: ${missingLocales.join(", ") || "none"}) in ${localesDir}`,
    );
  }
});

if (windowsSigning?.configured) {
  await step("signatures", async () => {
    const installers = readdirSync(distDir)
      .filter((name) => name.toLowerCase().endsWith(".exe") && target.artifactPatterns.some((pattern) => pattern.test(name)))
      .map((name) => join(distDir, name));
    const files = [...installers, ...listPortableExecutables(join(distDir, target.unpackedDir))];
    // -EncodedCommand (UTF-16LE base64): no Windows command-line quoting of the multi-line script.
    const encoded = Buffer.from(authenticodeCheckScript(files), "utf16le").toString("base64");
    const result = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { encoding: "utf8" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Get-AuthenticodeSignature exited ${result.status}: ${result.stderr}`);
    const problems = authenticodeProblems(result.stdout, files);
    for (const file of files) console.log(`  checked ${file}`);
    if (installers.length === 0) problems.push(`no installer in ${distDir}`);
    if (problems.length > 0) throw new Error(`Windows signing is configured but ${problems.length} file(s) are not properly signed:\n  ${problems.join("\n  ")}`);
    console.log(`[package:${target.id}] ${files.length} PE files validly signed and timestamped`);
  });
}

if (macSigning?.configured) {
  await step("notarize", async () => {
    const dmgs = readdirSync(distDir)
      .filter((name) => name.endsWith(".dmg") && target.artifactPatterns.some((pattern) => pattern.test(name)))
      .map((name) => join(distDir, name));
    if (dmgs.length === 0) throw new Error(`no dmg in ${distDir} to notarize`);
    const { identity, keychain, notaryKey } = macKeychain;
    for (const dmg of dmgs) {
      run("codesign", ["--force", "--sign", identity.hash, "--keychain", keychain, "--timestamp", dmg]);
      const submission = capture("xcrun", notarytoolSubmitArgs(dmg, { key: notaryKey, keyId: macSigning.notaryKeyId, issuer: macSigning.notaryIssuerId }));
      const id = notaryAccepted(submission.slice(submission.indexOf("{")));
      console.log(`[package:${target.id}] notarized ${dmg} (submission ${id})`);
      run("xcrun", ["stapler", "staple", dmg]);
      run("xcrun", ["stapler", "validate", dmg]);
      run("spctl", ["--assess", "-vv", "--type", "open", "--context", "context:primary-signature", dmg]);
    }
    // The update zip was built from the app afterPack notarized and stapled: check what Squirrel.Mac will unpack.
    const zips = readdirSync(distDir).filter((name) => name.endsWith("-mac.zip") && target.artifactPatterns.some((pattern) => pattern.test(name)));
    if (zips.length === 0) throw new Error(`no update zip in ${distDir} to check`);
    for (const zip of zips) console.log(`[package:${target.id}] ${zip}: ${assessZippedApp(join(distDir, zip), capture)} is signed, stapled and accepted by Gatekeeper`);
    closeMacKeychain();
  });
}

const artifacts = [];
await step("report", async () => {
  for (const name of readdirSync(distDir).sort()) {
    if (!target.artifactPatterns.some((pattern) => pattern.test(name))) continue;
    const file = join(distDir, name);
    artifacts.push({ name, bytes: statSync(file).size, sha256: await sha256(file) });
  }
  if (artifacts.length === 0) throw new Error(`electron-builder produced no ${target.id} artifacts in ${distDir}`);
  // Every expected format, not just any artifact: a Linux build that silently dropped the .rpm must not pass.
  const absent = target.artifactPatterns.filter((pattern) => !artifacts.some(({ name }) => pattern.test(name)));
  if (absent.length > 0) throw new Error(`electron-builder produced no ${absent.join(", ")} artifact for ${target.id} in ${distDir}`);
});

// REL-MAC-10: the unpacked Badger.app is only the dmg's and the zip's input. Left in dist/ it is one more "Badger" in
// Spotlight and Launch Services, so it is unregistered and removed; the dmg is what gets installed and tested.
if (target.id.startsWith("macos-")) removeAppCopy(join(distDir, target.unpackedDir), capture);

const totalMs = steps.reduce((sum, entry) => sum + entry.ms, 0);
const report = {
  target: target.id,
  ...(testBuild ? { testBuild: true } : {}),
  totalMs,
  steps,
  artifacts,
  ...(windowsSigning ? { windowsSigned: windowsSigning.configured } : {}),
  ...(macSigning ? { macNotarized: macSigning.configured } : {}),
};
writeFileSync(join(distDir, `package-report-${target.id}.json`), `${JSON.stringify(report, null, 2)}\n`);
console.log(`\n[package:${target.id}] ${(totalMs / 1000).toFixed(1)}s total`);
for (const artifact of artifacts) {
  console.log(`  ${artifact.sha256}  ${artifact.bytes}  ${artifact.name}`);
}
