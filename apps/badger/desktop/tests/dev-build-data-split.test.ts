/**
 * PLAT-DESK-14 — a development build of Badger never shares data or a runtime with the release build.
 *
 * Before the fix both builds used `<appData>/@sf/desktop` as userData, one runtime data dir and runtime port 3020.
 * The release app signed in to production opened the dev server's library (and pushed its rows to production), the dev
 * app read the release app's session, and whichever build started second attached to the other's runtime.
 *
 * @bugfix @regression-proof @req PLAT-DESK-14
 * @covers apps/badger/desktop/src/main/appIdentity.ts
 *         apps/badger/desktop/src/main/runtimeSpawnEnv.ts (applyDevBuildRuntimeDefaults, isExternalRuntimeUrl)
 *         apps/badger/desktop/src/main/devBuildEnv.ts + index.ts (load order)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { platform as linux } from "../../../../packages/desktop-platform-linux/src/index";
import { platform as macos } from "../../../../packages/desktop-platform-macos/src/index";
import { platform as windows } from "../../../../packages/desktop-platform-windows/src/index";
import { resolveAppIdentity } from "../src/main/appIdentity";
import { applyDevBuildRuntimeDefaults, DEV_BUILD_RUNTIME_PORT, isExternalRuntimeUrl } from "../src/main/runtimeSpawnEnv";

const T = "dev-build-data-split";
const RELEASE_RUNTIME_DIR = "/home/u/.local/share/SpaceFleet/runtime";

describe("development build userData (PLAT-DESK-14)", () => {
  // @bugfix @regression-proof @req PLAT-DESK-14
  it("puts a development build's data next to the release build's, never in it, on every OS", () => {
    const cases = [
      { os: "linux", platform: linux, appData: "/home/u/.config", release: "/home/u/.config/@sf/desktop" },
      {
        os: "windows",
        platform: windows,
        appData: "C:\\Users\\u\\AppData\\Roaming",
        release: "C:\\Users\\u\\AppData\\Roaming\\@sf\\desktop",
      },
      {
        os: "macos",
        platform: macos,
        appData: "/Users/u/Library/Application Support",
        release: "/Users/u/Library/Application Support/Badger",
      },
    ];
    for (const { os, platform, appData, release } of cases) {
      const releaseIdentity = resolveAppIdentity(platform, appData, {}, false);
      const devIdentity = resolveAppIdentity(platform, appData, {}, true);
      console.info(`[${T}:userData] os=${os} release=${releaseIdentity.userDataDir} dev=${devIdentity.userDataDir}`);
      expect(releaseIdentity.userDataDir).toBe(release);
      expect(devIdentity.userDataDir).toBe(`${release}-dev`);
      expect(devIdentity.name).toBe(releaseIdentity.name);
    }
  });

  // @req PLAT-DESK-14
  it("still lets SF_USER_DATA_PATH (lanes, e2e) choose the dir of a development build", () => {
    expect(resolveAppIdentity(linux, "/x", { SF_USER_DATA_PATH: "/lane/data" }, true).userDataDir).toBe("/lane/data");
  });
});

describe("development build runtime (PLAT-DESK-14)", () => {
  // @bugfix @regression-proof @req PLAT-DESK-14
  it("gives a development build its own runtime port and runtime data dir", () => {
    const env: NodeJS.ProcessEnv = {};
    const applied = applyDevBuildRuntimeDefaults(env, true, RELEASE_RUNTIME_DIR);
    console.info(`[${T}:runtime-dev] applied=${JSON.stringify(applied)}`);
    expect(env.SF_RUNTIME_BASE_URL).toBe(`http://127.0.0.1:${DEV_BUILD_RUNTIME_PORT}`);
    expect(DEV_BUILD_RUNTIME_PORT).not.toBe(3020);
    expect(env.SPACEFLEET_RUNTIME_DATA_DIR).toBe(`${RELEASE_RUNTIME_DIR}-dev`);
    // The app spawns and manages that runtime itself: it is not an external runtime.
    expect(isExternalRuntimeUrl(env.SF_RUNTIME_BASE_URL)).toBe(false);
  });

  // @req PLAT-DESK-14
  it("leaves a release build on the release runtime", () => {
    const env: NodeJS.ProcessEnv = {};
    const applied = applyDevBuildRuntimeDefaults(env, false, RELEASE_RUNTIME_DIR);
    console.info(`[${T}:runtime-release] applied=${JSON.stringify(applied)}`);
    expect(env).toEqual({});
    expect(applied).toEqual({ runtimeBaseUrl: null, runtimeDataDir: null });
  });

  // @req PLAT-DESK-14
  it("keeps the runtime URL and data dir a lane or e2e run set", () => {
    const env: NodeJS.ProcessEnv = { SF_RUNTIME_BASE_URL: "http://127.0.0.1:3120", SPACEFLEET_RUNTIME_DATA_DIR: "/tmp/sf-runtime-x" };
    applyDevBuildRuntimeDefaults(env, true, RELEASE_RUNTIME_DIR);
    expect(env).toEqual({ SF_RUNTIME_BASE_URL: "http://127.0.0.1:3120", SPACEFLEET_RUNTIME_DATA_DIR: "/tmp/sf-runtime-x" });
  });

  // @req PLAT-DESK-14
  it("counts only a runtime on another port than the two managed ones as external", () => {
    const verdicts = Object.fromEntries(
      [undefined, "http://127.0.0.1:3020", "http://127.0.0.1:3021/", "http://127.0.0.1:30210", "http://127.0.0.1:4555"].map(
        (url) => [String(url), isExternalRuntimeUrl(url)],
      ),
    );
    console.info(`[${T}:external] ${JSON.stringify(verdicts)}`);
    expect(verdicts).toEqual({
      undefined: false,
      "http://127.0.0.1:3020": false,
      "http://127.0.0.1:3021/": false,
      "http://127.0.0.1:30210": true,
      "http://127.0.0.1:4555": true,
    });
  });

  // @req PLAT-DESK-14
  it("applies the development defaults before any main module reads SF_RUNTIME_BASE_URL at load time", () => {
    const indexSource = readFileSync(fileURLToPath(new URL("../src/main/index.ts", import.meta.url)), "utf8");
    const imports = indexSource.split("\n").filter((line) => line.startsWith("import "));
    console.info(`[${T}:load-order] first imports=${JSON.stringify(imports.slice(0, 3))}`);
    // packagedNodeEnv only sets NODE_ENV; devBuildEnv must come right after it, before every other module.
    expect(imports.slice(0, 2)).toEqual(['import "./packagedNodeEnv";', 'import "./devBuildEnv";']);
  });
});
