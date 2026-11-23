/**
 * The Google-free Android build (SF_FOSS=1, PLAT-MOBILE-06): the switch in foss.cjs leaves every Google Play services
 * library out of Badger and Parrot, and does nothing when unset, so the Play build stays as it was. The native side is
 * checked from source: no Kotlin that both builds compile may reach Google Play services, and the Cast SDK is a
 * Play-build dependency only.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { PLAY_SERVICES_LIBRARIES, fossAutolinkExclusions, withFossStubs } = require("../foss.cjs") as {
  PLAY_SERVICES_LIBRARIES: readonly string[];
  fossAutolinkExclusions: (appDir: string, enabled?: boolean) => Record<string, unknown>;
  withFossStubs: (
    resolveRequest: (context: unknown, moduleName: string, platform: string | null) => { type: string; filePath?: string },
    stubs?: Record<string, string>,
    enabled?: boolean,
  ) => (context: unknown, moduleName: string, platform: string | null) => { type: string; filePath?: string };
};

const repo = resolve(__dirname, "../../..");
const badger = join(repo, "apps/badger/mobile");
const parrot = join(repo, "apps/parrot/mobile");
const unlinked = { platforms: { android: null } };

const kotlinFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return kotlinFiles(path);
    return /\.(kt|java)$/.test(name) ? [path] : [];
  });

describe("@req PLAT-MOBILE-06 Google-free Android build switch", () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("unlinks Firebase, Google Cast and the ML Kit scanner from Badger on Android", () => {
    const exclusions = fossAutolinkExclusions(badger, true);
    console.info(`[foss] badger unlinked: ${Object.keys(exclusions).join(", ")}`);
    expect(Object.keys(exclusions).sort()).toEqual([...PLAY_SERVICES_LIBRARIES].sort());
    for (const entry of Object.values(exclusions)) expect(entry).toEqual(unlinked);
  });

  it("unlinks only the ML Kit scanner from Parrot, which has no Firebase or Cast", () => {
    const exclusions = fossAutolinkExclusions(parrot, true);
    console.info(`[foss] parrot unlinked: ${Object.keys(exclusions).join(", ")}`);
    expect(exclusions).toEqual({ "react-native-camera-kit": unlinked });
  });

  it("changes nothing in the Play build", () => {
    expect(fossAutolinkExclusions(badger, false)).toEqual({});
    expect(fossAutolinkExclusions(parrot, false)).toEqual({});
    const resolveRequest = () => ({ type: "sourceFile", filePath: "/x.ts" });
    expect(withFossStubs(resolveRequest, { a: "/b.ts" }, false)).toBe(resolveRequest);
  });

  it("swaps Firebase and the named stubs for stand-ins, and a module with a .foss sibling for that sibling", () => {
    const dir = mkdtempSync(join(tmpdir(), "foss-build-"));
    temps.push(dir);
    for (const name of ["scanner.ts", "scanner.foss.ts", "plain.tsx"]) writeFileSync(join(dir, name), "export {};\n");
    const resolved: Record<string, string> = { "./scanner": join(dir, "scanner.ts"), "./plain": join(dir, "plain.tsx") };
    const resolveRequest = (_context: unknown, moduleName: string) =>
      resolved[moduleName] ? { type: "sourceFile", filePath: resolved[moduleName] } : { type: "empty" };
    const resolver = withFossStubs(resolveRequest, { "react-native-google-cast": "/stub/googleCast.foss.ts" }, true);

    for (const firebase of ["@react-native-firebase/app", "@react-native-firebase/messaging"]) {
      expect(resolver(null, firebase, "android").filePath).toBe(resolve(__dirname, "../src/foss/notInThisBuild.ts"));
    }
    expect(resolver(null, "react-native-google-cast", "android").filePath).toBe("/stub/googleCast.foss.ts");
    expect(resolver(null, "./scanner", "android").filePath).toBe(join(dir, "scanner.foss.ts"));
    expect(resolver(null, "./plain", "android").filePath).toBe(join(dir, "plain.tsx"));
    expect(resolver(null, "./missing", "android")).toEqual({ type: "empty" });
  });

  it("gives the QR scanner and Badger's Cast module a Google-free sibling", () => {
    const scanner = readFileSync(join(repo, "packages/mobile-shell/src/pairing-approve/qrScanner.foss.ts"), "utf8");
    expect(scanner).not.toMatch(/from ["']react-native-camera-kit["']/);
    expect(scanner).toMatch(/qrScannerAvailable(?::\s*boolean)?\s*=\s*false/);
    const available = readFileSync(join(badger, "src/lib/cast/googleCastAvailable.foss.ts"), "utf8");
    expect(available).toMatch(/googleCastAvailable(?::\s*boolean)?\s*=\s*false/);
    expect(readFileSync(join(badger, "metro.config.js"), "utf8")).toMatch(/googleCast\.foss\.ts/);
  });

  it("keeps Google Play services out of the Kotlin both Badger builds compile, and the Cast SDK a Play-build dependency", () => {
    const app = join(badger, "android/app");
    const shared = [...kotlinFiles(join(app, "src/main/java")), ...kotlinFiles(join(app, "src/foss/java"))];
    const offenders = shared.filter((file) =>
      /import (com\.google\.android\.gms|com\.google\.firebase|com\.reactnative\.googlecast|androidx\.mediarouter)/.test(
        readFileSync(file, "utf8"),
      ),
    );
    console.info(`[foss] ${shared.length} Kotlin files in src/main + src/foss; Play services imports in: ${offenders.join(", ") || "none"}`);
    expect(shared.length).toBeGreaterThan(0);
    expect(offenders).toEqual([]);

    const gradle = readFileSync(join(app, "build.gradle"), "utf8");
    const castDependency = gradle.indexOf("play-services-cast-framework");
    const guard = gradle.lastIndexOf("if (!fossBuild)", castDependency);
    expect(castDependency).toBeGreaterThan(0);
    expect(guard).toBeGreaterThan(0);
    expect(gradle.slice(guard, castDependency)).not.toMatch(/\n\s*\}\s*\n/);
    expect(gradle).toMatch(/if \(!fossBuild && [^\n]*\) \{\s*apply plugin: ["']com\.google\.gms\.google-services["']/);
  });
});
