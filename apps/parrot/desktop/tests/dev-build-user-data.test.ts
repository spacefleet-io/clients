/**
 * PLAT-DESK-14 for Parrot: a development build (`electron-vite dev`, `build:test`) talks to the local dev stack, so it
 * keeps its data in `<appData>/spaceparrot-dev`; a release build keeps `<appData>/spaceparrot`, the dir every existing
 * install uses on every OS, macOS included (a different release dir would sign every Parrot user out).
 * Resolved through the REAL platform layers by the resolver Badger uses too (REL-FAM-03); the wiring is checked on the
 * source of src/main/index.ts (the module runs Electron at import).
 *
 * @bugfix @regression-proof
 * @covers apps/parrot/desktop/src/main/appIdentity.ts + packages/desktop-shell/src/main-shell/appIdentity.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { platform as linux } from "@space/desktop-platform-linux";
import { platform as macos } from "@space/desktop-platform-macos";
import { platform as windows } from "@space/desktop-platform-windows";
import { resolveAppIdentity } from "@space/desktop-shell/main-shell";
import { PARROT_IDENTITY } from "../src/main/appIdentity";

const T = "dev-build-user-data";
const source = readFileSync(resolve(import.meta.dirname, "../src/main/index.ts"), "utf8");

// @req PLAT-DESK-14
describe("Parrot userData per build kind", () => {
  // @bugfix @regression-proof @req PLAT-DESK-14
  it("@req PLAT-DESK-14 keeps <appData>/spaceparrot on every OS for a release, spaceparrot-dev for a dev build", () => {
    const cases = [
      { os: "linux", platform: linux, appData: "/home/u/.config", release: "/home/u/.config/spaceparrot" },
      { os: "windows", platform: windows, appData: "C:\\Users\\u\\AppData\\Roaming", release: "C:\\Users\\u\\AppData\\Roaming\\spaceparrot" },
      { os: "macos", platform: macos, appData: "/Users/u/Library/Application Support", release: "/Users/u/Library/Application Support/spaceparrot" },
    ];
    for (const { os, platform, appData, release } of cases) {
      console.info(`[${T}] phase: ${os}`);
      const releaseIdentity = resolveAppIdentity({ ...PARROT_IDENTITY, platform, appData, env: {}, devBuild: false });
      const devIdentity = resolveAppIdentity({ ...PARROT_IDENTITY, platform, appData, env: {}, devBuild: true });
      console.info(`[${T}] state`, JSON.stringify({ os, release: releaseIdentity, dev: devIdentity }));
      expect(releaseIdentity).toEqual({ name: "Parrot", userDataDir: release });
      expect(devIdentity.userDataDir).toBe(`${release}-dev`);
    }
    expect(resolveAppIdentity({ ...PARROT_IDENTITY, platform: linux, appData: "/x", env: { SF_USER_DATA_PATH: "/lane/data" }, devBuild: true }).userDataDir).toBe("/lane/data");
  });

  // @req PLAT-DESK-14
  it("@req PLAT-DESK-14 main sets userData from that resolver with the dev-build flag, and never renames the app", () => {
    const setUserData = source.split("\n").find((line) => line.startsWith('app.setPath("userData"')) ?? "";
    console.info(`[${T}] wiring`, JSON.stringify({ setUserData }));
    expect(setUserData).toBe('app.setPath("userData", appIdentity.userDataDir);');
    expect(source).toMatch(/const appIdentity = resolveAppIdentity\(\{\n {2}\.\.\.PARROT_IDENTITY,[\s\S]*?devBuild: isDevBuild,\n\}\);/);
    // The Linux keyring entry "Parrot Safe Storage" is keyed by the app name: renaming would sign everyone out.
    expect(source).not.toContain("app.setName(");
    // The flag is the same one that points the build at the local dev stack instead of production.
    expect(source).toMatch(/isDevBuild \? "http:\/\/localhost:3000" : PRODUCTION_API_BASE_URL/);
  });
});
