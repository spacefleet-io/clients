// Windows code signing with Azure Artifact Signing (REL-INST-03). Pure helpers shared by
// electron-builder.config.mjs (what electron-builder is told) and scripts/package.mjs (the log line,
// the host check and the post-build signature check); tests/windows-signing.test.ts covers them.
//
// Signing is configured by environment variables (README "Windows code signing"):
//   AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET   CI secrets: the app registration (spacebadger-ci-signer)
//                                                           that holds "Artifact Signing Certificate Profile Signer"
//   AZURE_SIGNING_ENDPOINT, AZURE_SIGNING_ACCOUNT,          optional CI variables overriding    WINDOWS_SIGNING_DEFAULTS:
//   AZURE_SIGNING_CERT_PROFILE                              the account's regional endpoint, account and certificate profile
// None set: a release build is refused, since installed apps only accept updates signed by
// WINDOWS_UPDATE_PUBLISHER_NAME; only a dev-key test build (`package.mjs --test-build`, never released) may build unsigned,
// saying "Windows signing not configured" once. The three secrets set: electron-builder signs through the TrustedSigning
// PowerShell module, every signing error fails the build, and package.mjs re-checks every shipped PE file afterwards.
// Anything set but a secret missing: the build fails (a half-configured CI must not ship unsigned by accident).

import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

export const WINDOWS_SIGNING_SECRETS = ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"];
export const WINDOWS_SIGNING_VARIABLES = ["AZURE_SIGNING_ENDPOINT", "AZURE_SIGNING_ACCOUNT", "AZURE_SIGNING_CERT_PROFILE"];
export const WINDOWS_SIGNING_ENV = [...WINDOWS_SIGNING_SECRETS, ...WINDOWS_SIGNING_VARIABLES];

/** Our Artifact Signing account (North Europe, tenant df604d74-59e3-4cba-a3b1-cd45fedafb14). Not secrets. */
export const WINDOWS_SIGNING_DEFAULTS = {
  AZURE_SIGNING_ENDPOINT: "https://neu.codesigning.azure.net/",
  AZURE_SIGNING_ACCOUNT: "spacebadger",
  AZURE_SIGNING_CERT_PROFILE: "spacebadger-public",
};

export const WINDOWS_SIGNING_NOT_CONFIGURED = "Windows signing not configured";

/**
 * The RFC 3161 timestamp server every signature carries. Artifact Signing certificates live 72 hours: without a
 * timestamp a signature stops validating 3 days after the build. Set explicitly (electron-builder 26 happens to
 * default to the same values) so an electron-builder default change cannot ship untimestamped installers.
 */
export const WINDOWS_TIMESTAMP_RFC3161 = "http://timestamp.acs.microsoft.com";
export const WINDOWS_SIGNING_DIGEST = "SHA256";

/**
 * The file extensions electron-builder signs on top of `.exe` (its `win.signExts`). Without them it signs only
 * `.exe` files, so Badger 0.1.2 shipped the FFmpeg DLLs next to ffprobe/ffmpeg/mpv (avcodec, avformat, avutil,
 * avfilter, avdevice, swresample, swscale) unsigned, and Smart App Control refused to load them: ffprobe exited 2
 * and mpv could not start. `.node` covers native Node modules in app.asar.unpacked, which are DLLs too.
 */
export const WINDOWS_SIGN_EXTS = [".dll", ".node"];

/**
 * The CN of the certificate profile spacebadger-public signs with (Azure portal, profile subject
 * `CN=PENA Chris-Alexandre, O=PENA Chris-Alexandre, L=Toulouse, C=FR`). electron-builder 26's schema requires
 * azureSignOptions.publisherName on every signed build; whether the updater checks it is WINDOWS_UPDATE_PUBLISHER_NAME.
 */
export const WINDOWS_CERT_PUBLISHER_NAME = "PENA Chris-Alexandre";

/**
 * The publisher the in-app updater requires on a Windows update (REL-INST-03), exactly as the signing certificate's
 * CN: the certificate profile's subject CN (WINDOWS_CERT_PUBLISHER_NAME). null would turn the check off
 * (verifyUpdateCodeSignature: false).
 *
 * On since the first public release (source: Chris 2026-11-11 (chat), updates must install silently): every
 * Windows build of Badger and Parrot must be signed (resolveWindowsSigning refuses an unsigned one), because
 * installed apps refuse an update whose publisher is not this name.
 * @type {string | null}
 */
export const WINDOWS_UPDATE_PUBLISHER_NAME = WINDOWS_CERT_PUBLISHER_NAME;

/**
 * The publisher check a build gets: WINDOWS_UPDATE_PUBLISHER_NAME for every release build, none for a dev-key test
 * build (META-ANON-06, refused by the installer store, never published), which may then build unsigned.
 * @param {{ testBuild?: boolean }} [options]
 * @returns {string | null}
 */
export const windowsUpdatePublisherFor = ({ testBuild = false } = {}) => (testBuild ? null : WINDOWS_UPDATE_PUBLISHER_NAME);

const value = (env, name) => (env[name] ?? "").trim();
/** An account coordinate: the variable when set (CI passes "" for an unset variable), else our account's value. */
const coordinate = (env, name) => value(env, name) || WINDOWS_SIGNING_DEFAULTS[name];

/** @typedef {{ configured: false } | { configured: true; endpoint: string; account: string; profile: string }} WindowsSigning */

/**
 * @param {Record<string, string | undefined>} env
 * @param {string | null} [publisherName]
 * @returns {WindowsSigning}
 */
export function resolveWindowsSigning(env, publisherName = WINDOWS_UPDATE_PUBLISHER_NAME) {
  const set = WINDOWS_SIGNING_ENV.filter((name) => value(env, name) !== "");
  if (set.length === 0) {
    if (publisherName != null) {
      throw new Error(
        `${WINDOWS_SIGNING_NOT_CONFIGURED}, but the updater requires updates signed by "${publisherName}" ` +
          `(WINDOWS_UPDATE_PUBLISHER_NAME): installed apps would refuse this unsigned build. Set ${WINDOWS_SIGNING_SECRETS.join(", ")}.`,
      );
    }
    return { configured: false };
  }
  const missing = WINDOWS_SIGNING_SECRETS.filter((name) => !set.includes(name));
  if (missing.length > 0) {
    throw new Error(
      `Windows signing is partly configured: ${missing.join(", ")} missing (set: ${set.join(", ")}). ` +
        `Set ${WINDOWS_SIGNING_SECRETS.join(", ")} to sign, or none of ${WINDOWS_SIGNING_ENV.join(", ")} to build unsigned.`,
    );
  }
  const endpoint = coordinate(env, "AZURE_SIGNING_ENDPOINT");
  if (!/^https:\/\/[a-z0-9-]+\.codesigning\.azure\.net\/?$/i.test(endpoint)) {
    throw new Error(`AZURE_SIGNING_ENDPOINT "${endpoint}" is not an Artifact Signing endpoint (https://<region>.codesigning.azure.net/)`);
  }
  return { configured: true, endpoint, account: coordinate(env, "AZURE_SIGNING_ACCOUNT"), profile: coordinate(env, "AZURE_SIGNING_CERT_PROFILE") };
}

/**
 * The `win` options electron-builder gets for signing and for the updater's signature check.
 * Unsigned: no azureSignOptions, so electron-builder signs nothing. Signed: azureSignOptions makes it sign the app
 * exe, every .exe and (signExts) every .dll and .node in the app folder, extraResources (runtime, ffmpeg, ffprobe,
 * mpv and their FFmpeg DLLs) and app.asar.unpacked, then the NSIS uninstaller and the installer.
 * @param {WindowsSigning} signing
 * @param {string | null} [publisherName]
 */
export function windowsSigningBuilderOptions(signing, publisherName = WINDOWS_UPDATE_PUBLISHER_NAME) {
  if (!signing.configured) return { verifyUpdateCodeSignature: false };
  return {
    verifyUpdateCodeSignature: publisherName != null,
    signExts: WINDOWS_SIGN_EXTS,
    azureSignOptions: {
      endpoint: signing.endpoint,
      codeSigningAccountName: signing.account,
      certificateProfileName: signing.profile,
      // signtool /tr <server> /td SHA256 /fd SHA256: timestamped, so the signature outlives the 72 h certificate.
      timestampRfc3161: WINDOWS_TIMESTAMP_RFC3161,
      timestampDigest: WINDOWS_SIGNING_DIGEST,
      fileDigest: WINDOWS_SIGNING_DIGEST,
      // Required by electron-builder's schema (a signed build without it fails config validation). It reaches
      // app-update.yml, and so the updater's check, only when verifyUpdateCodeSignature is on.
      publisherName: publisherName ?? WINDOWS_CERT_PUBLISHER_NAME,
    },
  };
}

/** The one line package.mjs prints for a Windows build. */
export function windowsSigningLogLine(signing) {
  return signing.configured
    ? `Windows signing: Azure Artifact Signing (account ${signing.account}, certificate profile ${signing.profile}, ${signing.endpoint})`
    : `${WINDOWS_SIGNING_NOT_CONFIGURED} (${WINDOWS_SIGNING_ENV.join(", ")} unset): building unsigned, without the updater's publisher check`;
}

/**
 * A configured build fails before building unless the host can sign: the TrustedSigning PowerShell module only runs on
 * Windows, and the Azure Artifact Signing plugin it hands signtool is a .NET 8 assembly loaded from the default .NET
 * install (C:\Program Files\dotnet). Without .NET, signtool exits 3 with no message, minutes into the build.
 */
export function assertWindowsSigningHost(signing, platform, hasDotnet) {
  if (!signing.configured) return;
  if (platform !== "win32") {
    throw new Error(`Windows signing is configured but this host is ${platform}: Azure Artifact Signing runs on Windows only (build in the Windows VM or on the laptop)`);
  }
  if (!hasDotnet) {
    throw new Error("Windows signing is configured but this host has no .NET in C:\\Program Files\\dotnet: Azure Artifact Signing needs the .NET 8 runtime (provision the VM with `windows-vm.ts provision`, a host with `windows-vm.ts provision-host`)");
  }
}

/**
 * Whether `file` is a Windows PE image (exe, dll, node module, sys...): an "MZ" DOS header whose e_lfanew points at
 * "PE\0\0". Read from the bytes, not the name, so a PE file with any extension is caught.
 */
export function isPortableExecutable(file) {
  const fd = openSync(file, "r");
  try {
    const dos = Buffer.alloc(64);
    if (readSync(fd, dos, 0, 64, 0) < 64 || dos.readUInt16LE(0) !== 0x5a4d) return false;
    const peOffset = dos.readUInt32LE(0x3c);
    const sig = Buffer.alloc(4);
    return readSync(fd, sig, 0, 4, peOffset) === 4 && sig.readUInt32LE(0) === 0x00004550;
  } finally {
    closeSync(fd);
  }
}

/**
 * Every PE file under `dir`, recursively (the unpacked app: Badger.exe, Electron's DLLs, the runtime, the bundled
 * ffmpeg/ffprobe/mpv and their FFmpeg DLLs, native modules), whatever its extension: the signature check covers
 * all of them, so a PE file electron-builder did not sign fails the build.
 */
export function listPortableExecutables(dir) {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((rel) => join(dir, rel))
    .filter((file) => statSync(file).isFile() && isPortableExecutable(file))
    .sort();
}

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** PowerShell (5.1 compatible) printing one JSON array: path, Authenticode status, signer subject, timestamped. */
export function authenticodeCheckScript(files) {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$rows = foreach ($f in @(${files.map(psQuote).join(", ")})) {`,
    "  $s = Get-AuthenticodeSignature -LiteralPath $f",
    "  [pscustomobject]@{ path = $f; status = [string]$s.Status; subject = $(if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { '' }); timestamped = ($null -ne $s.TimeStamperCertificate) }",
    "}",
    "ConvertTo-Json -Compress -InputObject @($rows)",
  ].join("\n");
}

/** The CN of an X.500 subject ("CN=Name, O=Name, C=FR" -> "Name"), or "" when absent. */
export function subjectCommonName(subject) {
  const match = /(?:^|,\s*)CN=(?:"((?:[^"]|"")*)"|([^,]*))/.exec(subject);
  if (!match) return "";
  return match[1] !== undefined ? match[1].replace(/""/g, '"') : match[2].trim();
}

/**
 * Problems in authenticodeCheckScript's output: a file not validly signed, signed without a timestamp (Artifact
 * Signing certificates live 3 days; an untimestamped signature dies with them), or signed by someone other than
 * the publisher the updater requires.
 * @param {string} json
 * @param {readonly string[]} expectedFiles
 * @param {string | null} [publisherName]
 * @returns {string[]}
 */
export function authenticodeProblems(json, expectedFiles, publisherName = WINDOWS_UPDATE_PUBLISHER_NAME) {
  const rows = JSON.parse(json);
  const list = Array.isArray(rows) ? rows : [rows];
  const problems = [];
  const seen = new Set(list.map((row) => row.path));
  for (const file of expectedFiles) if (!seen.has(file)) problems.push(`${file}: not checked`);
  for (const row of list) {
    if (row.status !== "Valid") problems.push(`${row.path}: signature ${row.status || "missing"}`);
    else if (!row.timestamped) problems.push(`${row.path}: signed without a timestamp`);
    else if (publisherName != null && subjectCommonName(row.subject) !== publisherName) {
      problems.push(`${row.path}: signed by "${subjectCommonName(row.subject)}", the updater requires "${publisherName}"`);
    }
  }
  return problems;
}
