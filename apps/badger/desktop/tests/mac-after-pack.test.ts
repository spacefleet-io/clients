/**
 * The macOS afterPack hook: fails loudly on an incomplete deps bundle, moves the
 * mpv helper app out of Resources, and signs inside-out. The real-codesign case
 * runs only where /usr/bin/codesign exists (a Mac); the rest is pure.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import afterPack, { depsProblems, PLAYER_HELPER_APP, signingOrder } from "../scripts/mac-after-pack.mjs";

const tmpDirs: string[] = [];
const makeTmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-mac-after-pack-"));
  tmpDirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const COMPLETE_DEPS = [
  "/d",
  "/d/bin",
  "/d/lib",
  "/d/bin/ffmpeg",
  "/d/bin/ffprobe",
  "/d/bin/sf-lifeline",
  "/d/deps-manifest.json",
  `/d/${PLAYER_HELPER_APP}/Contents/MacOS/mpv`,
];

describe("mac afterPack: deps bundle check", () => {
  it("accepts a complete bundle and names every missing piece of an incomplete one", () => {
    const present = new Set(COMPLETE_DEPS);
    const list = (dir: string) => (dir === "/d/bin" || dir === "/d/lib" ? ["x"] : []);
    expect(depsProblems("/d", (p: string) => present.has(p), list)).toEqual([]);

    expect(depsProblems("/missing", () => false, list)).toEqual(["/missing does not exist"]);

    present.delete(`/d/${PLAYER_HELPER_APP}/Contents/MacOS/mpv`);
    present.delete("/d/bin/sf-lifeline");
    const problems = depsProblems("/d", (p: string) => present.has(p), (dir: string) => (dir === "/d/bin" ? ["x"] : []));
    console.info(`[mac-after-pack:deps] problems=${JSON.stringify(problems)}`);
    expect(problems).toEqual([
      "/d/lib is missing or empty",
      "/d/bin/sf-lifeline is missing",
      `/d/${PLAYER_HELPER_APP}/Contents/MacOS/mpv is missing`,
    ]);
  });

  it("is a no-op for non-mac targets", async () => {
    await expect(
      afterPack({ electronPlatformName: "linux", appOutDir: "/nonexistent", packager: { appInfo: { productFilename: "Badger" } } }),
    ).resolves.toBeUndefined();
  });

  it("refuses to sign a mac build whose deps bundle is missing", async () => {
    const out = makeTmp();
    mkdirSync(join(out, "Badger.app", "Contents", "Resources"), { recursive: true });
    await expect(
      afterPack({ electronPlatformName: "darwin", appOutDir: out, packager: { appInfo: { productFilename: "Badger" } } }),
    ).rejects.toThrow(/deps bundle is incomplete/);
  });
});

describe("mac afterPack: signing order", () => {
  it("signs loose Mach-O files first, then bundles deepest first, the app last", () => {
    const app = "/o/Badger.app";
    const order = signingOrder(app, {
      files: [`${app}/Contents/MacOS/Badger`, `${app}/Contents/Resources/deps/lib/libavcodec.dylib`],
      bundles: [
        app,
        `${app}/Contents/Helpers/${PLAYER_HELPER_APP}`,
        `${app}/Contents/Frameworks/Electron Framework.framework`,
        `${app}/Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/x.app`,
      ],
    });
    expect(order).toEqual([
      `${app}/Contents/Resources/deps/lib/libavcodec.dylib`,
      `${app}/Contents/MacOS/Badger`,
      `${app}/Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/x.app`,
      `${app}/Contents/Frameworks/Electron Framework.framework`,
      `${app}/Contents/Helpers/${PLAYER_HELPER_APP}`,
      app,
    ]);
  });
});

// @req REL-MAC-02 ad-hoc signed bundle that passes codesign --verify --deep --strict
// @req REL-MAC-09 the mpv helper shows as "Badger Player" in the Dock
// @req PLAT-DESK-02 the app executable's minos is raised to the macOS 14 minimum
describe.runIf(existsSync("/usr/bin/codesign"))("mac afterPack on a real bundle (macOS host)", () => {
  /** A packed Badger.app whose deps bundle holds the Player helper with `helperName` as its CFBundleName / DisplayName. */
  const packedApp = (helperName: string) => {
    const out = makeTmp();
    const contents = join(out, "Badger.app", "Contents");
    const deps = join(contents, "Resources", "deps");
    const machO = "/usr/bin/true"; // any Mach-O stands in for the real binaries
    mkdirSync(join(contents, "MacOS"), { recursive: true });
    // Stands in for Electron's prebuilt executable, which says minos 13.0.
    const lowered = spawnSync(
      "vtool",
      ["-set-build-version", "macos", "13.0", "26.0", "-replace", "-output", join(contents, "MacOS", "Badger"), machO],
      { encoding: "utf8" },
    );
    expect(lowered.status, lowered.stderr).toBe(0);
    writeFileSync(
      join(contents, "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Badger</string><key>CFBundleIdentifier</key><string>io.spacefleet.badger-desktop</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`,
    );
    for (const name of ["ffmpeg", "ffprobe", "sf-lifeline"]) {
      mkdirSync(join(deps, "bin"), { recursive: true });
      copyFileSync(machO, join(deps, "bin", name));
      chmodSync(join(deps, "bin", name), 0o755);
    }
    mkdirSync(join(deps, "lib"), { recursive: true });
    copyFileSync(machO, join(deps, "lib", "libfake.dylib"));
    writeFileSync(join(deps, "deps-manifest.json"), "{}");
    const helper = join(deps, PLAYER_HELPER_APP, "Contents");
    mkdirSync(join(helper, "MacOS"), { recursive: true });
    copyFileSync(machO, join(helper, "MacOS", "mpv"));
    writeFileSync(
      join(helper, "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleDisplayName</key><string>${helperName}</string><key>CFBundleExecutable</key><string>mpv</string><key>CFBundleIdentifier</key><string>io.spacefleet.badger-desktop.player</string><key>CFBundleName</key><string>${helperName}</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`,
    );
    return { out, contents, deps };
  };

  it("moves the Player helper to Contents/Helpers as Badger Player.app, raises the app executable to minos 14.0 and leaves a valid ad-hoc signature", async () => {
    const { out, contents, deps } = packedApp("Badger Player");
    await afterPack({ electronPlatformName: "darwin", appOutDir: out, packager: { appInfo: { productFilename: "Badger" } } });

    const app = join(out, "Badger.app");
    expect(existsSync(join(deps, PLAYER_HELPER_APP))).toBe(false);
    expect(PLAYER_HELPER_APP).toBe("Badger Player.app");
    expect(existsSync(join(contents, "Helpers", PLAYER_HELPER_APP, "Contents", "MacOS", "mpv"))).toBe(true);
    const verify = spawnSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app], { encoding: "utf8" });
    const display = spawnSync("codesign", ["-dv", join(deps, "bin", "ffmpeg")], { encoding: "utf8" });
    console.info(`[mac-after-pack:real] verify=${verify.status} ${verify.stderr.trim()} | ffmpeg: ${display.stderr.trim()}`);
    expect(verify.status).toBe(0);
    expect(display.stderr).toMatch(/Signature=adhoc/);
    const build = spawnSync("vtool", ["-show-build", join(contents, "MacOS", "Badger")], { encoding: "utf8" });
    const minos = [...build.stdout.matchAll(/^\s*minos (\S+)$/gm)].map((m) => m[1]);
    console.info(`[mac-after-pack:real] app executable minos=${minos.join(",")}`);
    expect(minos.length).toBeGreaterThan(0);
    expect(minos).toEqual(minos.map(() => "14.0"));
  });

  it("refuses a deps bundle whose Player helper is named anything but Badger Player", async () => {
    const { out } = packedApp("SpaceBadger Player");
    await expect(
      afterPack({ electronPlatformName: "darwin", appOutDir: out, packager: { appInfo: { productFilename: "Badger" } } }),
    ).rejects.toThrow(/CFBundleName is "SpaceBadger Player", expected "Badger Player"/);
  });
});
