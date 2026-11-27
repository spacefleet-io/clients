/**
 * PLAT-DESK-14 for Parrot: a development build (`electron-vite dev`, `build:test`) talks to the local dev stack, so it
 * keeps its data in `<appData>/spaceparrot-dev`; a release build keeps `<appData>/spaceparrot`, the dir every existing
 * install uses on every OS (a different release dir would sign every Parrot user out).
 * Checked on the source of src/main/index.ts (the module runs Electron at import).
 *
 * @bugfix @regression-proof
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(import.meta.dirname, "../src/main/index.ts"), "utf8");

// @req PLAT-DESK-14
describe("Parrot userData per build kind", () => {
  it("sets userData through the shared resolver, from the release dir existing installs use and the dev-build flag", () => {
    const setUserData = source.split("\n").find((line) => line.startsWith('app.setPath("userData"')) ?? "";
    console.info(`[dev-build-user-data] ${setUserData}`);
    expect(setUserData).toBe(
      'app.setPath("userData", resolveUserDataDir({ releaseDir: releaseUserDataDir, env: process.env, devBuild: isDevBuild }));',
    );
    expect(source).toContain('const releaseUserDataDir = join(app.getPath("appData"), "spaceparrot");');
    // The flag is the same one that points the build at the local dev stack instead of production.
    expect(source).toMatch(/isDevBuild \? "http:\/\/localhost:3000" : PRODUCTION_API_BASE_URL/);
  });
});
