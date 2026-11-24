/**
 * REL-FAM-03 + PLAT-DESK-14: Badger and Parrot resolve their name and Electron userData dir with one function, through
 * the REAL platform layers (not mocks). Each app keeps the release dir its existing installs use, so no update signs
 * anybody out; a development build keeps the same dir with `-dev`; SF_USER_DATA_PATH overrides both.
 *
 * @bugfix @regression-proof @req PLAT-DESK-14 @req REL-FAM-03
 */
import { describe, expect, it } from "vitest";

import { platform as linux } from "../../desktop-platform-linux/src/index";
import { platform as macos } from "../../desktop-platform-macos/src/index";
import { platform as windows } from "../../desktop-platform-windows/src/index";
import { resolveAppIdentity, type AppIdentitySpec } from "../src/main-shell/appIdentity";

const T = "app-identity";

// The two apps' declarations, as their main processes pass them.
const BADGER: AppIdentitySpec = { names: { productName: "Badger", legacyName: "Badger" }, userData: { legacyDir: ["@sf", "desktop"] } };
const PARROT: AppIdentitySpec = { names: { productName: "Parrot", legacyName: "Parrot" }, userData: { everyOs: "spaceparrot" } };

const OSES = [
  { os: "linux", platform: linux, appData: "/home/u/.config" },
  { os: "windows", platform: windows, appData: "C:\\Users\\u\\AppData\\Roaming" },
  { os: "macos", platform: macos, appData: "/Users/u/Library/Application Support" },
] as const;

const EXPECTED = {
  badger: {
    linux: "/home/u/.config/@sf/desktop",
    windows: "C:\\Users\\u\\AppData\\Roaming\\@sf\\desktop",
    macos: "/Users/u/Library/Application Support/Badger",
  },
  parrot: {
    linux: "/home/u/.config/spaceparrot",
    windows: "C:\\Users\\u\\AppData\\Roaming\\spaceparrot",
    macos: "/Users/u/Library/Application Support/spaceparrot",
  },
} as const;

describe("resolveAppIdentity", () => {
  for (const [app, spec] of [["badger", BADGER], ["parrot", PARROT]] as const) {
    // @bugfix @regression-proof @req PLAT-DESK-14 @req REL-FAM-03
    it(`@req PLAT-DESK-14 ${app}: keeps the release dir of existing installs on every OS, and -dev next to it for a dev build`, () => {
      for (const { os, platform, appData } of OSES) {
        console.info(`[${T}:${app}] phase: ${os}`);
        const release = resolveAppIdentity({ ...spec, platform, appData, env: {}, devBuild: false });
        const dev = resolveAppIdentity({ ...spec, platform, appData, env: {}, devBuild: true });
        console.info(`[${T}:${app}] state`, JSON.stringify({ os, release, dev }));
        expect(release.userDataDir).toBe(EXPECTED[app][os]);
        expect(dev.userDataDir).toBe(`${EXPECTED[app][os]}-dev`);
        expect(dev.name).toBe(release.name);
      }
    });

    // @req PLAT-DESK-14
    it(`@req PLAT-DESK-14 ${app}: SF_USER_DATA_PATH (lanes, e2e) chooses the dir of either build on every OS`, () => {
      for (const { os, platform } of OSES) {
        for (const devBuild of [false, true]) {
          const identity = resolveAppIdentity({ ...spec, platform, appData: "/x", env: { SF_USER_DATA_PATH: " /lane/data " }, devBuild });
          console.info(`[${T}:${app}:override] state`, JSON.stringify({ os, devBuild, identity }));
          expect(identity.userDataDir).toBe("/lane/data");
        }
      }
    });
  }

  // @req REL-MAC-05
  it("@req REL-MAC-05 names each app after the product on every OS", () => {
    const names = OSES.map(({ os, platform, appData }) => ({
      os,
      badger: resolveAppIdentity({ ...BADGER, platform, appData, env: {}, devBuild: false }).name,
      parrot: resolveAppIdentity({ ...PARROT, platform, appData, env: {}, devBuild: false }).name,
    }));
    console.info(`[${T}:names] state`, JSON.stringify(names));
    expect(names).toEqual([
      { os: "linux", badger: "Badger", parrot: "Parrot" },
      { os: "windows", badger: "Badger", parrot: "Parrot" },
      { os: "macos", badger: "Badger", parrot: "Parrot" },
    ]);
  });
});
