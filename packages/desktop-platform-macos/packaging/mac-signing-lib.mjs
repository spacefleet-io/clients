// REL-MAC-02: Developer ID signing and notarization of the macOS app, its update zip and its dmg.
//
// Signing is on when all of the APPLE_* variables below are set (the CI secrets of the same names), and the build
// is ad-hoc signed otherwise. A half-set group fails the build: it would silently ship an ad-hoc build.
//
// The Mac keeps no credentials (REL-MOB-03, REL-CD-10): scripts/package.mjs imports the .p12 into a throwaway
// keychain for the one build, writes the App Store Connect API key to a temporary file, and removes both when it ends.
// scripts/mac-after-pack.mjs signs every Mach-O file and bundle with the identity found there (hardened runtime,
// secure timestamp, entitlements.mac.plist next to this file), then notarizes the .app and staples its ticket
// (notarizeApp): electron-builder builds the in-app-update zip (`<Product>-<version>-<arch>-mac.zip`, listed in
// latest-mac.yml) and the dmg from that stapled app, so the feed's sha512 is the notarized zip's. package.mjs then
// signs the dmg, notarizes it, staples the ticket and checks both the dmg and the zipped app with spctl.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

/** Spotlight skips everything below a folder whose name ends in `.noindex`: scratch copies of the app go there (REL-MAC-10). */
export const MAC_SCRATCH_DIR = "sf-mac-scratch.noindex";

/** A fresh `<tmp>/sf-mac-scratch.noindex/<prefix>XXXXXX` directory. @param {string} prefix @param {string} [root] */
export const macScratchDir = (prefix, root = tmpdir()) => {
  const parent = join(root, MAC_SCRATCH_DIR);
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, prefix));
};

export const LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

/** `root` when it is an app bundle, and every app bundle below it (Electron helpers, the Badger Player helper). @param {string} root */
export const appBundlesIn = (root) => {
  if (!existsSync(root)) return [];
  const below = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"))
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name));
  return [...(root.endsWith(".app") ? [root] : []), ...below].sort();
};

/**
 * Launch Services forgets every app bundle at or below `root` (REL-MAC-10): a bundle that was opened, assessed or merely
 * seen stays registered after it is deleted, and Spotlight and "Open With" keep offering it. Run before deleting a
 * scratch or build copy of the app. Returns the bundles it unregistered; none means no call.
 * @param {string} root
 * @param {(command: string, args: string[]) => string} run  throws on a non-zero exit
 */
export const forgetAppBundles = (root, run) => {
  const bundles = appBundlesIn(root);
  if (bundles.length > 0) run(LSREGISTER, ["-u", ...bundles]);
  return bundles;
};

/**
 * forgetAppBundles, then delete `root`. A failed unregister is logged, never fatal: the Mac runner's GC catches it.
 * @param {string} root
 * @param {(command: string, args: string[]) => string} run
 */
export const removeAppCopy = (root, run) => {
  try {
    forgetAppBundles(root, run);
  } catch (error) {
    console.warn(`[mac] could not unregister the app bundles in ${root}: ${error instanceof Error ? error.message : String(error)}`);
  }
  rmSync(root, { recursive: true, force: true });
};

export const MAC_SIGNING_ENV = [
  "APPLE_DEVID_P12_BASE64",
  "APPLE_DEVID_P12_PASSWORD",
  "APPLE_NOTARY_KEY_P8_BASE64",
  "APPLE_NOTARY_KEY_ID",
  "APPLE_NOTARY_ISSUER_ID",
  "APPLE_TEAM_ID",
];

/** What package.mjs hands electron-builder's afterPack hook (mac-after-pack.mjs). */
export const MAC_SIGN_IDENTITY_ENV = "SF_MAC_SIGN_IDENTITY";
export const MAC_SIGN_KEYCHAIN_ENV = "SF_MAC_SIGN_KEYCHAIN";
/** What package.mjs hands the afterPack hook to notarize the signed .app (the notary key file and its ids). */
export const MAC_NOTARY_KEY_ENV = "SF_MAC_NOTARY_KEY";
export const MAC_NOTARY_KEY_ID_ENV = "SF_MAC_NOTARY_KEY_ID";
export const MAC_NOTARY_ISSUER_ENV = "SF_MAC_NOTARY_ISSUER";
const MAC_NOTARY_ENV = [MAC_NOTARY_KEY_ENV, MAC_NOTARY_KEY_ID_ENV, MAC_NOTARY_ISSUER_ENV];

/** @param {Record<string, string | undefined>} env */
export const resolveMacSigning = (env) => {
  const values = Object.fromEntries(MAC_SIGNING_ENV.map((name) => [name, env[name]?.trim() ?? ""]));
  const missing = MAC_SIGNING_ENV.filter((name) => values[name] === "");
  if (missing.length === MAC_SIGNING_ENV.length) return { configured: false };
  if (missing.length > 0) {
    throw new Error(`macOS signing is half configured (REL-MAC-02): set all of ${MAC_SIGNING_ENV.join(", ")} or none; missing: ${missing.join(", ")}`);
  }
  if (!/^[A-Z0-9]{10}$/.test(values.APPLE_TEAM_ID)) throw new Error(`APPLE_TEAM_ID is not a 10-character Apple team id`);
  return {
    configured: true,
    p12Base64: values.APPLE_DEVID_P12_BASE64,
    p12Password: values.APPLE_DEVID_P12_PASSWORD,
    notaryKeyP8Base64: values.APPLE_NOTARY_KEY_P8_BASE64,
    notaryKeyId: values.APPLE_NOTARY_KEY_ID,
    notaryIssuerId: values.APPLE_NOTARY_ISSUER_ID,
    teamId: values.APPLE_TEAM_ID,
  };
};

/** The identity afterPack signs with: Developer ID from package.mjs's keychain, or ad-hoc (identity null). */
export const afterPackIdentity = (env) => {
  const identity = env[MAC_SIGN_IDENTITY_ENV]?.trim() || null;
  const keychain = env[MAC_SIGN_KEYCHAIN_ENV]?.trim() || null;
  if (identity && !keychain) throw new Error(`${MAC_SIGN_IDENTITY_ENV} is set without ${MAC_SIGN_KEYCHAIN_ENV}`);
  return { identity, keychain };
};

/**
 * The notary credentials afterPack notarizes the .app with: null when none is set (ad-hoc build), all three otherwise.
 * @param {Record<string, string | undefined>} env
 * @returns {{ key: string; keyId: string; issuer: string } | null}
 */
export const afterPackNotary = (env) => {
  const [key, keyId, issuer] = MAC_NOTARY_ENV.map((name) => env[name]?.trim() ?? "");
  if (!key && !keyId && !issuer) return null;
  if (!key || !keyId || !issuer) throw new Error(`set all of ${MAC_NOTARY_ENV.join(", ")} or none`);
  return { key, keyId, issuer };
};

/** `xcrun notarytool submit` arguments: wait for the verdict (at most 30 min), JSON output for notaryAccepted. */
export const notarytoolSubmitArgs = (file, { key, keyId, issuer }) => [
  "notarytool", "submit", file,
  "--key", key, "--key-id", keyId, "--issuer", issuer,
  "--wait", "--timeout", "30m", "--output-format", "json",
];

/**
 * Notarizes a Developer-ID-signed .app in place and staples its ticket (REL-MAC-02): the app is zipped with ditto for
 * the submission only. electron-builder then builds the update zip and the dmg from the stapled app, so a notarized
 * app is what both carry, offline-verifiable. Returns the submission id.
 * @param {string} appPath
 * @param {{ key: string; keyId: string; issuer: string }} notary
 * @param {(command: string, args: string[]) => string} run  throws on a non-zero exit, returns stdout+stderr
 */
export const notarizeApp = (appPath, notary, run) => {
  const dir = macScratchDir("sf-notarize-app-");
  try {
    const zip = join(dir, `${basename(appPath, ".app")}.zip`);
    run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, zip]);
    const submission = run("xcrun", notarytoolSubmitArgs(zip, notary));
    const id = notaryAccepted(submission.slice(submission.indexOf("{")));
    run("xcrun", ["stapler", "staple", appPath]);
    run("xcrun", ["stapler", "validate", appPath]);
    return id;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/**
 * afterPack's last step: a Developer ID app is notarized and stapled before electron-builder zips it and builds the
 * dmg (the update zip must hold a notarized app); an ad-hoc app is left as is. Returns the submission id, or null.
 * @param {string} appPath
 * @param {string | null} identity
 * @param {Record<string, string | undefined>} env
 * @param {(command: string, args: string[]) => string} run
 */
export const notarizeIfDeveloperId = (appPath, identity, env, run) => {
  if (!identity) return null;
  const notary = afterPackNotary(env);
  if (!notary) throw new Error(`Developer ID build without ${MAC_NOTARY_ENV.join(", ")}: the app in the update zip and the dmg must be notarized (REL-MAC-02)`);
  return notarizeApp(appPath, notary, run);
};

/**
 * The update zip holds one app that is validly signed, carries its stapled notarization ticket and passes Gatekeeper:
 * unpacked with ditto as Squirrel.Mac does. Returns the app's name.
 * @param {string} zip
 * @param {(command: string, args: string[]) => string} run
 */
export const assessZippedApp = (zip, run) => {
  const dir = macScratchDir("sf-update-zip-");
  try {
    run("ditto", ["-x", "-k", zip, dir]);
    const apps = readdirSync(dir).filter((name) => name.endsWith(".app"));
    if (apps.length !== 1) throw new Error(`${zip} holds ${apps.length} .app bundles at its top, expected exactly 1`);
    const app = join(dir, apps[0]);
    run("codesign", ["--verify", "--deep", "--strict", app]);
    run("xcrun", ["stapler", "validate", app]);
    run("spctl", ["--assess", "-vv", "--type", "execute", app]);
    return apps[0];
  } finally {
    removeAppCopy(dir, run);
  }
};

/**
 * codesign arguments for one item. Developer ID: hardened runtime, secure timestamp and the entitlements (the
 * notary service refuses anything else). Ad-hoc: a bare `--sign -` (no runtime, so unsigned-JIT code still runs).
 * @param {{ identity: string | null; keychain: string | null; entitlements: string }} signing
 */
export const codesignArgs = ({ identity, keychain, entitlements }, item) =>
  identity
    ? ["--force", "--sign", identity, "--keychain", keychain, "--options", "runtime", "--timestamp", "--entitlements", entitlements, item]
    : ["--force", "--sign", "-", item];

/**
 * The SHA-1 of the one valid "Developer ID Application" identity of `teamId` in `security find-identity` output.
 * @param {string} output
 * @param {string} teamId
 */
export const pickDeveloperIdIdentity = (output, teamId) => {
  const matches = [...output.matchAll(/^\s*\d+\)\s+([0-9A-F]{40})\s+"(Developer ID Application: [^"]*\((\w{10})\))"/gm)].filter(
    (match) => match[3] === teamId,
  );
  if (matches.length !== 1) {
    throw new Error(`expected one valid "Developer ID Application" identity for team ${teamId}, found ${matches.length}:\n${output}`);
  }
  return { hash: matches[0][1], name: matches[0][2] };
};

/** `security list-keychains -d user` output to paths. */
export const parseKeychainList = (output) => [...output.matchAll(/"([^"]+)"/g)].map((match) => match[1]);

/**
 * notarytool's JSON result: throws unless the submission was accepted.
 * @param {string} output
 */
export const notaryAccepted = (output) => {
  const result = JSON.parse(output);
  if (result.status !== "Accepted") {
    throw new Error(`notarization ${result.id ?? "?"} ended "${result.status}": ${result.message ?? ""} (xcrun notarytool log ${result.id ?? "<id>"} for details)`);
  }
  return result.id;
};

/**
 * Imports the Developer ID .p12 and Apple's G2 intermediate into a throwaway keychain and writes the notary key.
 * `close()` puts the user's keychain search list back and deletes the keychain and the key; package.mjs calls it
 * however the build ends.
 * @param {ReturnType<typeof resolveMacSigning> & { configured: true }} signing
 * @param {{ run: (command: string, args: string[]) => string; intermediateCert: string }} options
 */
export const openSigningKeychain = (signing, { run, intermediateCert }) => {
  const dir = mkdtempSync(join(tmpdir(), "sf-mac-signing-"));
  const keychain = join(dir, "signing.keychain-db");
  const keychainPassword = randomBytes(24).toString("hex");
  const p12 = join(dir, "devid.p12");
  const notaryKey = join(dir, `AuthKey_${signing.notaryKeyId}.p8`);
  const searchList = parseKeychainList(run("security", ["list-keychains", "-d", "user"]));
  let listChanged = false;
  const close = () => {
    try {
      if (listChanged) run("security", ["list-keychains", "-d", "user", "-s", ...searchList]);
      run("security", ["delete-keychain", keychain]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  try {
    writeFileSync(p12, Buffer.from(signing.p12Base64, "base64"), { mode: 0o600 });
    writeFileSync(notaryKey, Buffer.from(signing.notaryKeyP8Base64, "base64"), { mode: 0o600 });
    run("security", ["create-keychain", "-p", keychainPassword, keychain]);
    run("security", ["set-keychain-settings", "-lut", "21600", keychain]);
    run("security", ["unlock-keychain", "-p", keychainPassword, keychain]);
    run("security", ["import", p12, "-k", keychain, "-P", signing.p12Password, "-T", "/usr/bin/codesign", "-T", "/usr/bin/security"]);
    run("security", ["import", intermediateCert, "-k", keychain]);
    run("security", ["set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", keychainPassword, keychain]);
    rmSync(p12, { force: true });
    run("security", ["list-keychains", "-d", "user", "-s", keychain, ...searchList.filter((path) => path !== keychain)]);
    listChanged = true;
    const identity = pickDeveloperIdIdentity(run("security", ["find-identity", "-v", "-p", "codesigning", keychain]), signing.teamId);
    return { keychain, identity, notaryKey, close };
  } catch (error) {
    close();
    throw error;
  }
};
