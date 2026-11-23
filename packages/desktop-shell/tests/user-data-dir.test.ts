/**
 * PLAT-DESK-14: a desktop app's development build keeps its data next to the release build's, never in it, and
 * `SF_USER_DATA_PATH` (lanes, e2e) overrides both.
 */
import { describe, expect, it } from "vitest";
import { resolveUserDataDir } from "../src/main-shell/userDataDir";

const RELEASE = "/home/u/.config/spaceparrot";

// @req PLAT-DESK-14
describe("resolveUserDataDir", () => {
  it("keeps the release dir for a release build", () => {
    expect(resolveUserDataDir({ releaseDir: RELEASE, env: {}, devBuild: false })).toBe(RELEASE);
  });

  it("appends -dev for a development build", () => {
    expect(resolveUserDataDir({ releaseDir: RELEASE, env: {}, devBuild: true })).toBe(`${RELEASE}-dev`);
  });

  it("lets SF_USER_DATA_PATH override both builds, ignoring a blank value", () => {
    for (const devBuild of [false, true]) {
      expect(resolveUserDataDir({ releaseDir: RELEASE, env: { SF_USER_DATA_PATH: " /lane/data " }, devBuild })).toBe("/lane/data");
      expect(resolveUserDataDir({ releaseDir: RELEASE, env: { SF_USER_DATA_PATH: "  " }, devBuild })).toBe(
        devBuild ? `${RELEASE}-dev` : RELEASE,
      );
    }
  });
});
