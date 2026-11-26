// Host-agnostic desktop packager: builds the Parrot app for one target (linux-x64 | windows-x64 | macos-arm64 |
// macos-x64) from one electron-builder config. Same flow and signing code as apps/badger/desktop/scripts/package.mjs,
// minus Badger's media-deps fetch, native-module pruning, runtime compile and staging (Parrot ships none of them).
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
//   build             electron-vite build (with source maps) + main-bundle check
//   symbols           debug ids injected into out/ (scripts/bugsink-sourcemaps.ts); maps uploaded to Bugsink project
//                     parrot-desktop when SF_BUGSINK_AUTH_TOKEN is set (SF_BUGSINK_UPLOAD_REQUIRED=1: a missing token
//                     fails); dist/sourcemaps-<target>.tgz kept beside the installer either way
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
//   report            sha256 + size of each artifact
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

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
} from "../../../../packages/desktop-platform-macos/packaging/mac-signing-lib.mjs";
import { listAsarEntries } from "../../../../packages/desktop-platform/packaging/asar-entries.mjs";
import { checkPackagedLocales } from "../../../../packages/desktop-platform/packaging/packaged-locales-lib.mjs";
import {
  assertWindowsSigningHost,
  authenticodeCheckScript,
  authenticodeProblems,
  listPortableExecutables,
  resolveWindowsSigning,
  windowsSigningLogLine,
  windowsUpdatePublisherFor,
} from "../../../../packages/desktop-platform-windows/packaging/windows-signing-lib.mjs";
import { TEST_BUILD_ENV, TEST_BUILD_FLAG, packageBuildEnv } from "../../../../packages/desktop-platform/packaging/test-build-lib.mjs";
import { LINUX_TOOL_PACKAGES, missingLinuxPackageTools } from "../../../../packages/desktop-platform-linux/packaging/linux-packages.mjs";
import { PACKAGING_UMASK } from "../../../../packages/desktop-platform-linux/packaging/file-modes.mjs";
import { checkParrotAsarEntries, linuxArtifactPatterns, resolveLinuxFormats, resolvePackageTarget } from "./package-targets.mjs";

const appDir = resolve(import.meta.dirname, "..");
// REL-DIST-13 (as Badger): files this run and its children (electron-builder, fpm) write are 644/755 whatever the host's umask.
process.umask(PACKAGING_UMASK);
const repoRoot = resolve(appDir, "..", "..", "..");
const badgerInstallerDir = join(repoRoot, "apps", "badger", "desktop", "installer");
const distDir = join(appDir, "dist");

const argValue = (flag) => {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
};

const target = resolvePackageTarget(argValue("--target") ?? process.env.SF_PACKAGE_TARGET);
const linuxFormats = target.id === "linux-x64" ? resolveLinuxFormats(argValue("--linux-formats") ?? process.env.SF_LINUX_FORMATS) : [];
const artifactPatterns = target.id === "linux-x64" ? linuxArtifactPatterns(linuxFormats) : target.artifactPatterns;
const tag = `[package:${target.id}]`;
const testBuild = process.argv.includes(TEST_BUILD_FLAG);
if (testBuild) console.log(`${tag} TEST build: development ticket key pinned, version marked -devkey; never a release (META-ANON-06)`);

// Decided before anything is built: a half-configured or wrong-host signing setup fails in seconds, not after the
// build. A release Windows build must be signed (REL-INST-03: the updater checks the publisher); a test build may not be.
const windowsSigning = target.id === "windows-x64" ? resolveWindowsSigning(process.env, windowsUpdatePublisherFor({ testBuild })) : null;
if (windowsSigning) {
  assertWindowsSigningHost(windowsSigning, process.platform, existsSync(join(process.env.ProgramFiles ?? "C:\\Program Files", "dotnet", "dotnet.exe")));
  console.log(`${tag} ${windowsSigningLogLine(windowsSigning)}`);
}
const macSigning = target.id.startsWith("macos-") ? resolveMacSigning(process.env) : null;
if (macSigning) {
  if (macSigning.configured && process.platform !== "darwin") throw new Error("macOS signing needs a Mac (codesign, notarytool)");
  console.log(`${tag} macOS signing: ${macSigning.configured ? `Developer ID, team ${macSigning.teamId}, notarized` : "ad-hoc (APPLE_* not set)"}`);
}
// The .deb/.rpm/.pacman are built by fpm calling host tools: say which are missing up front instead of failing minutes
// into electron-builder (same check as Badger, packages/desktop-platform-linux/packaging/linux-packages.mjs).
const missingTools = missingLinuxPackageTools(linuxFormats, (tool) => spawnSync("sh", ["-c", `command -v ${tool}`], { stdio: "ignore" }).status === 0);
if (missingTools.length > 0) {
  throw new Error(
    `${tag} building ${linuxFormats.join(", ")} needs ${missingTools.join(", ")} on this host ` +
      `(Debian: apt-get install ${[...new Set(missingTools.map((tool) => LINUX_TOOL_PACKAGES[tool]))].join(" ")}), or pass --linux-formats AppImage`,
  );
}
if (target.id === "linux-x64") console.log(`${tag} Linux formats: ${linuxFormats.join(", ")}`);

const steps = [];
const step = async (name, fn) => {
  const startedAt = Date.now();
  console.log(`\n${tag} ${name}`);
  try {
    await fn();
  } finally {
    const ms = Date.now() - startedAt;
    steps.push({ name, ms });
    console.log(`${tag} ${name} done in ${(ms / 1000).toFixed(1)}s`);
  }
};

const run = (command, args, options = {}) => {
  console.log(`$ ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, {
    stdio: "inherit",
    cwd: appDir,
    ...options,
    env: { ...process.env, SF_PACKAGE_TARGET: target.id, SF_LINUX_FORMATS: linuxFormats.join(","), ...options.env },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.status ?? result.signal}`);
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

/** Every file under `dir`, as absolute paths. */
const walkFiles = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walkFiles(join(dir, entry.name)) : [join(dir, entry.name)]));

await step("build", async () => {
  // META-ANON-06 (as Badger): a release pins the production ticket key; the dev-key flag is refused from the caller's
  // environment and blanked for the build. Only --test-build (a `-devkey` package) builds with it, as `build:test`.
  run("bun", ["run", testBuild ? "build:test" : "build"], { env: packageBuildEnv({ testBuild, env: process.env }) });
  run("bun", ["run", "check:main-bundle"]);
});

// REL-LOG-06 (as Badger): debug ids go into the built JS before packaging; the maps go to Bugsink when the build has
// the token (or must: SF_BUGSINK_UPLOAD_REQUIRED=1) and always travel as dist/sourcemaps-<target>.tgz. A checkout
// without scripts/bugsink-sourcemaps.ts (the public clients repo) skips the inject and the upload.
await step("symbols", async () => {
  const bugsink = join(repoRoot, "scripts", "bugsink-sourcemaps.ts");
  const outDir = join(appDir, "out");
  const required = process.env.SF_BUGSINK_UPLOAD_REQUIRED === "1";
  const haveBugsink = existsSync(bugsink);
  if (!haveBugsink && required) throw new Error(`SF_BUGSINK_UPLOAD_REQUIRED=1 but ${bugsink} is missing`);
  if (!haveBugsink) {
    console.log(`${tag} scripts/bugsink-sourcemaps.ts is not in this checkout: debug ids not injected, symbols not uploaded`);
  } else {
    run("bun", [bugsink, "inject", outDir], { cwd: repoRoot });
    if (process.env.SF_BUGSINK_AUTH_TOKEN?.trim() || required) {
      run("bun", [bugsink, "upload", outDir, "--project", "parrot-desktop"], { cwd: repoRoot, env: required ? { SF_BUGSINK_UPLOAD_OPTIONAL: "" } : {} });
    } else {
      console.log(`${tag} SF_BUGSINK_AUTH_TOKEN is not set: debug symbols not uploaded here (they are kept in dist/sourcemaps-${target.id}.tgz)`);
    }
  }
  const archive = join(distDir, `sourcemaps-${target.id}.tgz`);
  mkdirSync(distDir, { recursive: true });
  rmSync(archive, { force: true });
  const files = walkFiles(outDir)
    .filter((file) => /\.(?:c?js|mjs|map)$/.test(file))
    .map((file) => relative(appDir, file).split(sep).join("/"));
  if (files.length === 0) throw new Error(`no built .js or .map files under ${outDir} to archive`);
  if (!files.some((file) => file.endsWith(".map"))) throw new Error(`${outDir} holds no source maps: electron.vite.config.ts must build with sourcemap on (REL-LOG-06)`);
  const listFile = join(distDir, `sourcemaps-${target.id}.list`);
  writeFileSync(listFile, `${files.join("\n")}\n`);
  try {
    run("tar", ["-czf", archive, "-C", appDir, "-T", listFile]);
  } finally {
    rmSync(listFile, { force: true });
  }
  console.log(`${tag} ${files.length} files in ${archive}`);
});

await step("electron-builder", async () => {
  removeAppCopy(join(distDir, target.unpackedDir), capture);
  // A stale installer from an earlier build must never be reported (or shipped) as this build's output.
  for (const name of readdirSync(distDir)) {
    if (target.artifactPatterns.some((pattern) => pattern.test(name))) rmSync(join(distDir, name), { force: true });
  }
  const builderArgs = ["--config", "electron-builder.config.mjs", target.builderFlag, `--${target.arch}`, "--publish", "never"];
  if (macSigning?.configured) {
    macKeychain = openSigningKeychain(macSigning, { run: capture, intermediateCert: join(badgerInstallerDir, "DeveloperIDG2CA.cer") });
    console.log(`${tag} signing as ${macKeychain.identity.name}`);
  }
  run("bun", ["x", "electron-builder", ...builderArgs], {
    env: {
      NPM_CONFIG_WORKSPACES: "false",
      NPM_CONFIG_WORKSPACE: "false",
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
  const localesDir = join(distDir, target.unpackedDir, target.locales.subpath);
  const { unexpected: unexpectedLocales, missing: missingLocales } = checkPackagedLocales(readdirSync(localesDir), target.locales.languages, target.locales.extension);
  if (unexpectedLocales.length > 0 || missingLocales.length > 0) {
    throw new Error(
      `packaged ${target.id} locales differ from ${target.locales.languages.join(", ")} (unexpected: ${unexpectedLocales.join(", ") || "none"}; ` +
        `missing: ${missingLocales.join(", ") || "none"}) in ${localesDir}`,
    );
  }
  console.log(`${tag} locales: ${target.locales.languages.join(", ")}`);
  // electron-updater reads the feed URL from it (REL-UPD-01): an app without it can never update itself.
  const appUpdateYml = join(resourcesDir, "app-update.yml");
  if (!existsSync(appUpdateYml)) throw new Error(`packaged ${target.id} build has no ${appUpdateYml}: the in-app updater would have no feed`);
  console.log(`${tag} app-update.yml: present`);
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
    const problems = authenticodeProblems(result.stdout, files, null);
    for (const file of files) console.log(`  checked ${file}`);
    if (installers.length === 0) problems.push(`no installer in ${distDir}`);
    if (problems.length > 0) throw new Error(`Windows signing is configured but ${problems.length} file(s) are not properly signed:\n  ${problems.join("\n  ")}`);
    console.log(`${tag} ${files.length} PE files validly signed and timestamped`);
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
      console.log(`${tag} notarized ${dmg} (submission ${id})`);
      run("xcrun", ["stapler", "staple", dmg]);
      run("xcrun", ["stapler", "validate", dmg]);
      run("spctl", ["--assess", "-vv", "--type", "open", "--context", "context:primary-signature", dmg]);
    }
    // The update zip was built from the app afterPack notarized and stapled: check what Squirrel.Mac will unpack.
    const zips = readdirSync(distDir).filter((name) => name.endsWith("-mac.zip") && target.artifactPatterns.some((pattern) => pattern.test(name)));
    if (zips.length === 0) throw new Error(`no update zip in ${distDir} to check`);
    for (const zip of zips) console.log(`${tag} ${zip}: ${assessZippedApp(join(distDir, zip), capture)} is signed, stapled and accepted by Gatekeeper`);
    closeMacKeychain();
  });
}

const artifacts = [];
await step("report", async () => {
  for (const name of readdirSync(distDir).sort()) {
    if (!artifactPatterns.some((pattern) => pattern.test(name))) continue;
    const file = join(distDir, name);
    artifacts.push({ name, bytes: statSync(file).size, sha256: await sha256(file) });
  }
  // Every expected format, not just any artifact: a build that silently dropped the .deb must not pass.
  const absent = artifactPatterns.filter((pattern) => !artifacts.some((artifact) => pattern.test(artifact.name)) && !/blockmap/.test(pattern.source));
  if (absent.length > 0) throw new Error(`electron-builder produced no ${absent.map((pattern) => pattern.source).join(", ")} artifact for ${target.id} in ${distDir}`);
});

// REL-MAC-10 (as Badger): the unpacked Parrot.app is only the dmg's and the zip's input; it is unregistered and removed.
if (target.id.startsWith("macos-")) removeAppCopy(join(distDir, target.unpackedDir), capture);

const totalMs = steps.reduce((sum, entry) => sum + entry.ms, 0);
const report = {
  target: target.id,
  totalMs,
  steps,
  artifacts,
  ...(target.id === "linux-x64" ? { linuxFormats } : {}),
  ...(windowsSigning ? { windowsSigned: windowsSigning.configured } : {}),
  ...(macSigning ? { macNotarized: macSigning.configured } : {}),
  ...(testBuild ? { testBuild: true } : {}),
};
writeFileSync(join(distDir, `package-report-${target.id}.json`), `${JSON.stringify(report, null, 2)}\n`);
console.log(`\n${tag} ${(totalMs / 1000).toFixed(1)}s total`);
for (const artifact of artifacts) console.log(`  ${artifact.sha256}  ${artifact.bytes}  ${artifact.name}`);
