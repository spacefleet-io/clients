/**
 * REL-MAC-02: which macOS signing a build gets (Developer ID + notarization, or ad-hoc), what codesign is asked
 * for, and how the keychain identity and notary verdict are read.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  afterPackIdentity,
  afterPackNotary,
  appBundlesIn,
  assessZippedApp,
  codesignArgs,
  MAC_NOTARY_ISSUER_ENV,
  MAC_NOTARY_KEY_ENV,
  MAC_NOTARY_KEY_ID_ENV,
  MAC_SIGNING_ENV,
  notarizeIfDeveloperId,
  notaryAccepted,
  notarytoolSubmitArgs,
  parseKeychainList,
  pickDeveloperIdIdentity,
  forgetAppBundles,
  LSREGISTER,
  MAC_SCRATCH_DIR,
  macScratchDir,
  removeAppCopy,
  resolveMacSigning,
} from "../scripts/mac-signing-lib.mjs";

const FULL_ENV = {
  APPLE_DEVID_P12_BASE64: "cDEy",
  APPLE_DEVID_P12_PASSWORD: "pw",
  APPLE_NOTARY_KEY_P8_BASE64: "cDg=",
  APPLE_NOTARY_KEY_ID: "ABCDEF1234",
  APPLE_NOTARY_ISSUER_ID: "00000000-0000-0000-0000-000000000000",
  APPLE_TEAM_ID: "8766H6KW4V",
};

// @req REL-MAC-02 Developer ID + notarization when every APPLE_* secret is set, ad-hoc when none is
describe("resolveMacSigning", () => {
  it("is ad-hoc when no APPLE_* variable is set (blank counts as unset)", () => {
    expect(resolveMacSigning({})).toEqual({ configured: false });
    expect(resolveMacSigning({ APPLE_TEAM_ID: "  " })).toEqual({ configured: false });
  });

  it("signs and notarizes when all are set", () => {
    expect(resolveMacSigning(FULL_ENV)).toMatchObject({ configured: true, teamId: "8766H6KW4V", notaryKeyId: "ABCDEF1234" });
  });

  it("fails a half-configured build, naming each missing variable", () => {
    for (const name of MAC_SIGNING_ENV) {
      expect(() => resolveMacSigning({ ...FULL_ENV, [name]: "" })).toThrow(new RegExp(`missing: ${name}$`));
    }
  });

  it("rejects a malformed team id", () => {
    expect(() => resolveMacSigning({ ...FULL_ENV, APPLE_TEAM_ID: "8766h6kw4" })).toThrow(/team id/);
  });
});

// @req REL-MAC-02 Developer ID items get the hardened runtime, a secure timestamp and the entitlements
describe("codesignArgs / afterPackIdentity", () => {
  it("signs ad-hoc without an identity", () => {
    const signing = { ...afterPackIdentity({}), entitlements: "/e.plist" };
    expect(codesignArgs(signing, "/A.app")).toEqual(["--force", "--sign", "-", "/A.app"]);
  });

  it("signs with the Developer ID from the throwaway keychain", () => {
    const signing = { ...afterPackIdentity({ SF_MAC_SIGN_IDENTITY: "AB12", SF_MAC_SIGN_KEYCHAIN: "/k.keychain-db" }), entitlements: "/e.plist" };
    expect(codesignArgs(signing, "/A.app")).toEqual([
      "--force", "--sign", "AB12", "--keychain", "/k.keychain-db", "--options", "runtime", "--timestamp", "--entitlements", "/e.plist", "/A.app",
    ]);
  });

  it("refuses an identity without its keychain", () => {
    expect(() => afterPackIdentity({ SF_MAC_SIGN_IDENTITY: "AB12" })).toThrow(/SF_MAC_SIGN_KEYCHAIN/);
  });
});

describe("pickDeveloperIdIdentity", () => {
  const hash = "0123456789ABCDEF0123456789ABCDEF01234567";
  const other = "FEDCBA9876543210FEDCBA9876543210FEDCBA98";
  const output = (lines: string[]) => `${lines.join("\n")}\n     ${lines.length} valid identities found\n`;

  it("takes the one Developer ID Application identity of the team", () => {
    const found = output([
      `  1) ${other} "Apple Development: Someone (ZZZZZZZZZZ)"`,
      `  2) ${hash} "Developer ID Application: Chris-Alexandre Pena (8766H6KW4V)"`,
    ]);
    expect(pickDeveloperIdIdentity(found, "8766H6KW4V")).toEqual({ hash, name: "Developer ID Application: Chris-Alexandre Pena (8766H6KW4V)" });
  });

  it("fails when the team's identity is missing or ambiguous", () => {
    expect(() => pickDeveloperIdIdentity(output([`  1) ${other} "Developer ID Application: Other (ZZZZZZZZZZ)"`]), "8766H6KW4V")).toThrow(/found 0/);
    const twice = output([
      `  1) ${hash} "Developer ID Application: Chris-Alexandre Pena (8766H6KW4V)"`,
      `  2) ${other} "Developer ID Application: Chris-Alexandre Pena (8766H6KW4V)"`,
    ]);
    expect(() => pickDeveloperIdIdentity(twice, "8766H6KW4V")).toThrow(/found 2/);
  });
});

describe("parseKeychainList / notaryAccepted", () => {
  it("reads the user keychain search list", () => {
    expect(parseKeychainList(`    "/Users/c/Library/Keychains/login.keychain-db"\n    "/tmp/x y/s.keychain-db"\n`)).toEqual([
      "/Users/c/Library/Keychains/login.keychain-db",
      "/tmp/x y/s.keychain-db",
    ]);
  });

  // @req REL-MAC-02 a rejected notarization fails the build
  it("accepts only an Accepted submission", () => {
    expect(notaryAccepted(JSON.stringify({ id: "s1", status: "Accepted", message: "Processing complete" }))).toBe("s1");
    expect(() => notaryAccepted(JSON.stringify({ id: "s2", status: "Invalid", message: "Processing complete" }))).toThrow(/"Invalid".*notarytool log s2/);
  });
});

// A fake `run`: records every command, answers notarytool with a verdict, and lets a test unpack a fake app.
const recorder = (verdict = "Accepted", onDitto?: (args: string[]) => void) => {
  const calls: string[][] = [];
  const run = (command: string, args: string[]) => {
    calls.push([command, ...args]);
    if (command === "ditto") onDitto?.(args);
    if (command === "xcrun" && args[0] === "notarytool") return `Conducting pre-submission checks...\n${JSON.stringify({ id: "sub-1", status: verdict, message: "Processing complete" })}`;
    return "";
  };
  return { calls, run };
};
const NOTARY_ENV = { [MAC_NOTARY_KEY_ENV]: "/tmp/AuthKey.p8", [MAC_NOTARY_KEY_ID_ENV]: "ABCDEF1234", [MAC_NOTARY_ISSUER_ENV]: "issuer-1" };

// @req REL-MAC-02 the .app is notarized and stapled in afterPack, so the update zip (REL-MAC-03) carries a notarized app
describe("app notarization in afterPack (update zip)", () => {
  it("[mac-notary] reads all three notary variables or none, and refuses a half-set group", () => {
    console.info(`[mac-notary] env names ${MAC_NOTARY_KEY_ENV} ${MAC_NOTARY_KEY_ID_ENV} ${MAC_NOTARY_ISSUER_ENV}`);
    expect(afterPackNotary({})).toBeNull();
    expect(afterPackNotary(NOTARY_ENV)).toEqual({ key: "/tmp/AuthKey.p8", keyId: "ABCDEF1234", issuer: "issuer-1" });
    expect(() => afterPackNotary({ ...NOTARY_ENV, [MAC_NOTARY_ISSUER_ENV]: " " })).toThrow(/set all of SF_MAC_NOTARY_KEY, SF_MAC_NOTARY_KEY_ID, SF_MAC_NOTARY_ISSUER or none/);
    expect(notarytoolSubmitArgs("/x/App.zip", { key: "k", keyId: "i", issuer: "s" })).toEqual([
      "notarytool", "submit", "/x/App.zip", "--key", "k", "--key-id", "i", "--issuer", "s", "--wait", "--timeout", "30m", "--output-format", "json",
    ]);
  });

  it("[mac-notary] leaves an ad-hoc app alone and refuses a Developer ID app without notary credentials", () => {
    const { calls, run } = recorder();
    expect(notarizeIfDeveloperId("/dist/mac-arm64/Badger.app", null, NOTARY_ENV, run)).toBeNull();
    console.info(`[mac-notary] ad-hoc calls ${JSON.stringify(calls)}`);
    expect(calls).toEqual([]);
    expect(() => notarizeIfDeveloperId("/dist/mac-arm64/Badger.app", "Developer ID Application: X (8766H6KW4V)", {}, run)).toThrow(/must be notarized \(REL-MAC-02\)/);
  });

  it("[mac-notary] zips the app for the submission, waits for Accepted, then staples and validates the app itself", () => {
    const { calls, run } = recorder();
    const id = notarizeIfDeveloperId("/dist/mac-arm64/Badger.app", "Developer ID Application: X (8766H6KW4V)", NOTARY_ENV, run);
    console.info(`[mac-notary] developer-id calls ${JSON.stringify(calls)}`);
    expect(id).toBe("sub-1");
    expect(calls.map((call) => call.slice(0, 3).join(" "))).toEqual(["ditto -c -k", "xcrun notarytool submit", "xcrun stapler staple", "xcrun stapler validate"]);
    expect(calls[0].slice(-2)[0]).toBe("/dist/mac-arm64/Badger.app");
    expect(calls[0].at(-1)).toMatch(/sf-notarize-app-.*\/Badger\.zip$/);
    expect(calls[1][3]).toBe(calls[0].at(-1));
    expect(calls[2].at(-1)).toBe("/dist/mac-arm64/Badger.app");
    const rejected = recorder("Invalid");
    expect(() => notarizeIfDeveloperId("/dist/mac/Badger.app", "Developer ID Application: X (8766H6KW4V)", NOTARY_ENV, rejected.run)).toThrow(/"Invalid"/);
    // A rejected app is never stapled.
    expect(rejected.calls.some((call) => call.includes("stapler"))).toBe(false);
  });

  it("[mac-notary] checks the update zip as Squirrel.Mac unpacks it: one app, signed, stapled, accepted by Gatekeeper", () => {
    const unpackApps = (names: string[]) => (args: string[]) => {
      for (const name of names) mkdirSync(join(args.at(-1) as string, name), { recursive: true });
    };
    const { calls, run } = recorder("Accepted", unpackApps(["Badger.app"]));
    expect(assessZippedApp("/dist/Badger-0.2.0-arm64-mac.zip", run)).toBe("Badger.app");
    console.info(`[mac-notary] zip assessment calls ${JSON.stringify(calls)}`);
    expect(calls.map((call) => call.slice(0, 3).join(" "))).toEqual([
      "ditto -x -k",
      "codesign --verify --deep",
      "xcrun stapler validate",
      "spctl --assess -vv",
      `${LSREGISTER} -u ${calls[0].at(-1)}/Badger.app`,
    ]);
    expect(calls[3]).toContain("execute");
    // REL-MAC-10: unpacked below a .noindex folder, and Launch Services forgets the copy before it is deleted.
    expect(calls[0].at(-1)).toContain(`/${MAC_SCRATCH_DIR}/sf-update-zip-`);
    expect(existsSync(calls[0].at(-1) as string)).toBe(false);
    for (const names of [[], ["Badger.app", "Other.app"]]) {
      const bad = recorder("Accepted", unpackApps(names));
      expect(() => assessZippedApp("/dist/x-mac.zip", bad.run)).toThrow(`holds ${names.length} .app bundles`);
      expect(bad.calls.filter((call) => call[0] === LSREGISTER).map((call) => call.length - 2)).toEqual(names.length > 0 ? [names.length] : []);
    }
  });
});

// @req REL-MAC-10 scratch and build copies of the app sit below a .noindex folder and are unregistered before they are deleted
describe("scratch and build copies of the app (REL-MAC-10)", () => {
  it("[mac-ls] makes scratch dirs below a .noindex folder, which Spotlight skips", () => {
    const root = mkdtempSync(join(tmpdir(), "mac-ls-"));
    const dir = macScratchDir("sf-x-", root);
    console.info(`[mac-ls] scratch dir ${dir}`);
    expect(dir.startsWith(join(root, "sf-mac-scratch.noindex", "sf-x-"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("[mac-ls] unregisters the app and every bundle inside it (Electron helpers, Badger Player) in one call, then deletes", () => {
    const root = mkdtempSync(join(tmpdir(), "mac-ls-"));
    const dist = join(root, "mac-arm64");
    for (const bundle of ["Badger.app/Contents/Helpers/Badger Player.app", "Badger.app/Contents/Frameworks/Badger Helper (GPU).app"]) mkdirSync(join(dist, bundle, "Contents", "MacOS"), { recursive: true });
    const bundles = [
      join(dist, "Badger.app"),
      join(dist, "Badger.app/Contents/Frameworks/Badger Helper (GPU).app"),
      join(dist, "Badger.app/Contents/Helpers/Badger Player.app"),
    ];
    expect(appBundlesIn(join(dist, "Badger.app"))).toEqual(bundles);
    const { calls, run } = recorder();
    removeAppCopy(dist, run);
    console.info(`[mac-ls] calls ${JSON.stringify(calls)}`);
    expect(calls).toEqual([[LSREGISTER, "-u", ...bundles]]);
    expect(existsSync(dist)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("[mac-ls] makes no call when there is no bundle, and still deletes the copy when lsregister fails", () => {
    const root = mkdtempSync(join(tmpdir(), "mac-ls-"));
    const { calls, run } = recorder();
    expect(forgetAppBundles(join(root, "missing"), run)).toEqual([]);
    mkdirSync(join(root, "linux-unpacked", "resources"), { recursive: true });
    removeAppCopy(join(root, "linux-unpacked"), run);
    expect(calls).toEqual([]);
    mkdirSync(join(root, "mac", "Badger.app"), { recursive: true });
    removeAppCopy(join(root, "mac"), () => {
      throw new Error("lsregister exited with 1");
    });
    expect(existsSync(join(root, "mac"))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
});
