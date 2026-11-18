/**
 * @test-id MOBILE-PLAYBACK-MPV-FONTCONFIG-001
 * @level unit
 * @bugfix
 * @regression-proof
 *
 * Why exists: Android has no fontconfig configuration and no writable fontconfig cache dir, so libass' first use in each
 * libmpv instance rescanned every font in /system/fonts: `[sub/ass] Setting up fonts...` blocked mpv's core thread for
 * 1.2 s (audio underrun) and made a subtitle track switch take 1.6 s on the throttled phone (budget 500 ms). The engine must
 * point fontconfig at an explicit fonts.conf with a persistent cache dir BEFORE `MPVLib.create`, since fontconfig reads its
 * environment once, at first use.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const mpvDir = resolve(__dirname, "../../../../packages/mobile-mpv-playback/android/src/main/java/com/spacefleet/mpvplayback/mpv");
const kt = (name: string): string => readFileSync(resolve(mpvDir, name), "utf8");

describe("mpv fontconfig is configured with a persistent cache", () => {
  it("@regression-proof MpvEngine installs the config before creating the mpv instance", () => {
    const engine = kt("MpvEngine.kt");
    const install = engine.indexOf("MpvFontConfig.install(");
    const create = engine.indexOf("\n    MPVLib.create(");
    console.info("[playback-mpv-fontconfig] install at", install, "create at", create);
    expect(install).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(install);
  });

  it("MpvFontConfig writes fonts.conf with the system font dirs and a cachedir, and exports the env", () => {
    const cfg = kt("MpvFontConfig.kt");
    expect(cfg).toContain("<dir>/system/fonts</dir>");
    expect(cfg).toContain("<cachedir>");
    for (const name of ["FONTCONFIG_FILE", "FONTCONFIG_PATH", "XDG_CACHE_HOME"]) expect(cfg).toContain(name);
  });
});
