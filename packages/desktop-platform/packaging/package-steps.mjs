// The packaging steps Badger and Parrot share (REL-FAM-03): one run per target, each step timed, the report written to
// dist/package-report-<target>.json. Each app's scripts/package.mjs keeps only what is its own (Badger: media deps,
// native-module pruning, runtime compile and staging; both: what its app.asar must hold) and calls these for the rest:
// signing preflight, the Linux packaging tools check, the source-map archive and upload (REL-LOG-06), electron-builder,
// the locale check, the Windows signature and macOS notarization checks, and the artifact report.
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
} from "../../desktop-platform-macos/packaging/mac-signing-lib.mjs";
import { PACKAGING_UMASK } from "../../desktop-platform-linux/packaging/file-modes.mjs";
import { LINUX_TOOL_PACKAGES, missingLinuxPackageTools } from "../../desktop-platform-linux/packaging/linux-packages.mjs";
import {
  assertWindowsSigningHost,
  authenticodeCheckScript,
  authenticodeProblems,
  listPortableExecutables,
  resolveWindowsSigning,
  windowsSigningLogLine,
  windowsUpdatePublisherFor,
} from "../../desktop-platform-windows/packaging/windows-signing-lib.mjs";
import { checkPackagedLocales } from "./packaged-locales-lib.mjs";
import { TEST_BUILD_ENV } from "./test-build-lib.mjs";

/** Apple's Developer ID G2 intermediate, imported into the throwaway signing keychain so codesign can build the chain. */
export const DEVELOPER_ID_INTERMEDIATE_CERT = resolve(import.meta.dirname, "../../desktop-platform-macos/packaging/DeveloperIDG2CA.cer");

/** Every file under `dir`, as absolute paths. */
export const walkFiles = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walkFiles(join(dir, entry.name)) : [join(dir, entry.name)]));

export const sha256 = (file) =>
  new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolveHash(hash.digest("hex")));
  });

/**
 * The built files the symbols archive holds (paths relative to `appDir`, `/`-separated). REL-LOG-06: an archive without
 * a single source map is refused, since error reports from that build could never be read.
 */
export const sourcemapArchiveFiles = (outDir, appDir) => {
  const files = walkFiles(outDir)
    .filter((file) => /\.(?:c?js|mjs|map)$/.test(file))
    .map((file) => relative(appDir, file).split(sep).join("/"));
  if (files.length === 0) throw new Error(`no built .js or .map files under ${outDir} to archive`);
  if (!files.some((file) => file.endsWith(".map"))) throw new Error(`${outDir} holds no source maps: the build must emit them (REL-LOG-06)`);
  return files;
};

/**
 * The expected artifact patterns no file in `names` matches. A build that silently dropped one format (the .rpm, the
 * update zip, the blockmap the updater downloads differences with) must not pass.
 */
export const absentArtifacts = (patterns, names) => patterns.filter((pattern) => !names.some((name) => pattern.test(name)));

/**
 * Starts a packaging run for one target of the app in `appDir`. Signing is decided here, before anything is built, so
 * a half-configured or wrong-host setup fails in seconds. `runEnv` is added to every command's environment.
 */
export function createPackageRun({ appDir, target, testBuild, runEnv = {} }) {
  // REL-DIST-13: every file this run and its children (electron-builder, fpm) write is 644/755, whatever umask the host
  // hands us (the CI job containers run with 000, which shipped world-writable files in the .deb/.rpm/.pacman).
  process.umask(PACKAGING_UMASK);
  const repoRoot = resolve(appDir, "..", "..", "..");
  const distDir = join(appDir, "dist");
  const tag = `[package:${target.id}]`;
  if (testBuild) console.log(`${tag} TEST build: development ticket key pinned, version marked -devkey; never a release (META-ANON-06)`);

  // A release Windows build must be signed (REL-INST-03: installed apps check the update's publisher); a test build may not be.
  const windowsPublisher = windowsUpdatePublisherFor({ testBuild });
  const windowsSigning = target.id === "windows-x64" ? resolveWindowsSigning(process.env, windowsPublisher) : null;
  if (windowsSigning) {
    assertWindowsSigningHost(windowsSigning, process.platform, existsSync(join(process.env.ProgramFiles ?? "C:\\Program Files", "dotnet", "dotnet.exe")));
    console.log(`${tag} ${windowsSigningLogLine(windowsSigning)}`);
  }
  const macSigning = target.id.startsWith("macos-") ? resolveMacSigning(process.env) : null;
  if (macSigning) {
    if (macSigning.configured && process.platform !== "darwin") throw new Error("macOS signing needs a Mac (codesign, notarytool)");
    console.log(`${tag} macOS signing: ${macSigning.configured ? `Developer ID, team ${macSigning.teamId}, notarized` : "ad-hoc (APPLE_* not set)"}`);
  }

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
      env: { ...process.env, SF_PACKAGE_TARGET: target.id, ...runEnv, ...options.env },
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

  const distFiles = (patterns, filter = () => true) => readdirSync(distDir).filter((name) => filter(name) && patterns.some((pattern) => pattern.test(name)));

  return {
    tag,
    repoRoot,
    distDir,
    windowsSigning,
    macSigning,
    step,
    run,
    capture,

    /** PLAT-DESK-01: the .deb/.rpm/.pacman need host tools (fpm shells out to them): fail in seconds, naming the packages. */
    assertLinuxTools(formats, hint = "") {
      const missing = missingLinuxPackageTools(formats, (tool) => spawnSync("sh", ["-c", `command -v ${tool}`], { stdio: "ignore" }).status === 0);
      if (missing.length === 0) return;
      throw new Error(
        `${tag} building ${formats.join(", ")} needs ${missing.join(", ")} on this host ` +
          `(Debian: apt-get install ${[...new Set(missing.map((tool) => LINUX_TOOL_PACKAGES[tool]))].join(" ")})${hint}`,
      );
    },

    // REL-LOG-06: debug ids go into the built JS before it is packaged, so the shipped files carry them (needs no
    // credentials: every build, local or CI, does it). The maps then go to Bugsink when the build has the token, or must
    // (SF_BUGSINK_UPLOAD_REQUIRED=1: the Linux release workflows, where a missing token fails the build). A build without
    // either (a developer's or a PR's quick build) skips the upload; the Windows and macOS installers are built that way,
    // and their maps travel in `sourcemaps-<target>.tgz` next to the installer, from which the release workflow uploads
    // them. A checkout without scripts/bugsink-sourcemaps.ts (the public clients repo) skips the inject and the upload.
    symbols: ({ project }) =>
      step("symbols", async () => {
        const bugsink = join(repoRoot, "scripts", "bugsink-sourcemaps.ts");
        const outDir = join(appDir, "out");
        const required = process.env.SF_BUGSINK_UPLOAD_REQUIRED === "1";
        const haveBugsink = existsSync(bugsink);
        if (!haveBugsink && required) throw new Error(`SF_BUGSINK_UPLOAD_REQUIRED=1 but ${bugsink} is missing`);
        // Refused before anything is uploaded: a build without maps has nothing to symbolicate its error reports with.
        const files = sourcemapArchiveFiles(outDir, appDir);
        if (!haveBugsink) {
          console.log(`${tag} scripts/bugsink-sourcemaps.ts is not in this checkout: debug ids not injected, symbols not uploaded`);
        } else {
          run("bun", [bugsink, "inject", outDir], { cwd: repoRoot });
          if (process.env.SF_BUGSINK_AUTH_TOKEN?.trim() || required) {
            // Required means required: an inherited SF_BUGSINK_UPLOAD_OPTIONAL=1 must not turn a missing token into a notice.
            run("bun", [bugsink, "upload", outDir, "--project", project], { cwd: repoRoot, env: required ? { SF_BUGSINK_UPLOAD_OPTIONAL: "" } : {} });
          } else {
            console.log(`${tag} SF_BUGSINK_AUTH_TOKEN is not set: debug symbols not uploaded here (they are kept in dist/sourcemaps-${target.id}.tgz)`);
          }
        }
        const archive = join(distDir, `sourcemaps-${target.id}.tgz`);
        mkdirSync(distDir, { recursive: true });
        rmSync(archive, { force: true });
        const listFile = join(distDir, `sourcemaps-${target.id}.list`);
        writeFileSync(listFile, `${files.join("\n")}\n`);
        try {
          run("tar", ["-czf", archive, "-C", appDir, "-T", listFile]);
        } finally {
          rmSync(listFile, { force: true });
        }
        console.log(`${tag} ${files.length} files (${files.filter((file) => file.endsWith(".map")).length} source maps) in ${archive}`);
      }),

    /** electron-builder from the app's electron-builder.config.mjs; `env` adds to the builder's environment. */
    electronBuilder: ({ env = {} } = {}) =>
      step("electron-builder", async () => {
        removeAppCopy(join(distDir, target.unpackedDir), capture);
        // A stale installer from an earlier build must never be reported (or shipped) as this build's output.
        mkdirSync(distDir, { recursive: true });
        for (const name of distFiles(target.artifactPatterns)) rmSync(join(distDir, name), { force: true });
        const builderArgs = ["--config", "electron-builder.config.mjs", target.builderFlag, `--${target.arch}`, "--publish", "never"];
        if (macSigning?.configured) {
          macKeychain = openSigningKeychain(macSigning, { run: capture, intermediateCert: DEVELOPER_ID_INTERMEDIATE_CERT });
          console.log(`${tag} signing as ${macKeychain.identity.name}`);
        }
        run("bun", ["x", "electron-builder", ...builderArgs], {
          env: {
            NPM_CONFIG_WORKSPACES: "false",
            NPM_CONFIG_WORKSPACE: "false",
            ...env,
            // electron-builder gets the test mark explicitly ("" on a release), so an inherited SF_PACKAGE_TEST_BUILD cannot mark a release.
            [TEST_BUILD_ENV]: testBuild ? "1" : "",
            [MAC_SIGN_IDENTITY_ENV]: macKeychain?.identity.hash ?? "",
            [MAC_SIGN_KEYCHAIN_ENV]: macKeychain?.keychain ?? "",
            // afterPack notarizes the signed app before electron-builder zips it (mac-signing-lib.mjs notarizeIfDeveloperId).
            [MAC_NOTARY_KEY_ENV]: macKeychain?.notaryKey ?? "",
            [MAC_NOTARY_KEY_ID_ENV]: macKeychain ? macSigning.notaryKeyId : "",
            [MAC_NOTARY_ISSUER_ENV]: macKeychain ? macSigning.notaryIssuerId : "",
          },
        });
      }),

    /** Only the supported UI locales are in the unpacked package (Electron's locale paks). */
    verifyLocales() {
      const localesDir = join(distDir, target.unpackedDir, target.locales.subpath);
      const { unexpected, missing } = checkPackagedLocales(readdirSync(localesDir), target.locales.languages, target.locales.extension);
      if (unexpected.length > 0 || missing.length > 0) {
        throw new Error(
          `packaged ${target.id} locales differ from ${target.locales.languages.join(", ")} (unexpected: ${unexpected.join(", ") || "none"}; ` +
            `missing: ${missing.join(", ") || "none"}) in ${localesDir}`,
        );
      }
      console.log(`${tag} locales: ${target.locales.languages.join(", ")}`);
    },

    /** Windows, signing configured: the installer and every unpacked .exe carry a valid, timestamped signature by the updater's publisher. */
    signatures: async () => {
      if (!windowsSigning?.configured) return;
      await step("signatures", async () => {
        const installers = distFiles(target.artifactPatterns, (name) => name.toLowerCase().endsWith(".exe")).map((name) => join(distDir, name));
        const files = [...installers, ...listPortableExecutables(join(distDir, target.unpackedDir))];
        // -EncodedCommand (UTF-16LE base64): no Windows command-line quoting of the multi-line script.
        const encoded = Buffer.from(authenticodeCheckScript(files), "utf16le").toString("base64");
        const result = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { encoding: "utf8" });
        if (result.error) throw result.error;
        if (result.status !== 0) throw new Error(`Get-AuthenticodeSignature exited ${result.status}: ${result.stderr}`);
        const problems = authenticodeProblems(result.stdout, files, windowsPublisher);
        for (const file of files) console.log(`  checked ${file}`);
        if (installers.length === 0) problems.push(`no installer in ${distDir}`);
        if (problems.length > 0) throw new Error(`Windows signing is configured but ${problems.length} file(s) are not properly signed:\n  ${problems.join("\n  ")}`);
        console.log(`${tag} ${files.length} PE files validly signed and timestamped`);
      });
    },

    /** macOS, signing configured: the dmg is signed, notarized, stapled and accepted by Gatekeeper; so is the app in the update zip. */
    notarize: async () => {
      if (!macSigning?.configured) return;
      await step("notarize", async () => {
        const dmgs = distFiles(target.artifactPatterns, (name) => name.endsWith(".dmg")).map((name) => join(distDir, name));
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
        const zips = distFiles(target.artifactPatterns, (name) => name.endsWith("-mac.zip"));
        if (zips.length === 0) throw new Error(`no update zip in ${distDir} to check`);
        for (const zip of zips) console.log(`${tag} ${zip}: ${assessZippedApp(join(distDir, zip), capture)} is signed, stapled and accepted by Gatekeeper`);
        closeMacKeychain();
      });
    },

    /**
     * sha256 + size of every artifact matching `artifactPatterns`; fails when one expected format is missing. Then, on
     * macOS, the unpacked app is unregistered and removed (REL-MAC-10: left in dist/ it is one more copy of the app in
     * Spotlight and Launch Services; the dmg is what gets installed and tested), and the report is written.
     */
    report: async ({ artifactPatterns = target.artifactPatterns, extra = {} } = {}) => {
      const artifacts = [];
      await step("report", async () => {
        for (const name of readdirSync(distDir).sort()) {
          if (!artifactPatterns.some((pattern) => pattern.test(name))) continue;
          const file = join(distDir, name);
          artifacts.push({ name, bytes: statSync(file).size, sha256: await sha256(file) });
        }
        if (artifacts.length === 0) throw new Error(`electron-builder produced no ${target.id} artifacts in ${distDir}`);
        const absent = absentArtifacts(artifactPatterns, artifacts.map(({ name }) => name));
        if (absent.length > 0) throw new Error(`electron-builder produced no ${absent.map((pattern) => pattern.source).join(", ")} artifact for ${target.id} in ${distDir}`);
      });
      if (target.id.startsWith("macos-")) removeAppCopy(join(distDir, target.unpackedDir), capture);
      const totalMs = steps.reduce((sum, entry) => sum + entry.ms, 0);
      const report = {
        target: target.id,
        totalMs,
        steps,
        artifacts,
        ...extra,
        ...(windowsSigning ? { windowsSigned: windowsSigning.configured } : {}),
        ...(macSigning ? { macNotarized: macSigning.configured } : {}),
        ...(testBuild ? { testBuild: true } : {}),
      };
      writeFileSync(join(distDir, `package-report-${target.id}.json`), `${JSON.stringify(report, null, 2)}\n`);
      console.log(`\n${tag} ${(totalMs / 1000).toFixed(1)}s total`);
      for (const artifact of artifacts) console.log(`  ${artifact.sha256}  ${artifact.bytes}  ${artifact.name}`);
      return report;
    },
  };
}
