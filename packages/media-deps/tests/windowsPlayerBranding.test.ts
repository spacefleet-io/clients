import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * MPV-MODEL-05 / @req MPV-MODEL-05[badger-desktop]
 * @bugfix mpv-taskbar-icon: the first Windows user saw mpv's own icon on the player's taskbar button. mpv.exe is a
 * separate process from Badger.exe, so Badger's AppUserModelId never covered it, and mpv's window class takes its icon
 * from mpv.exe's IDI_ICON1 resource (etc/mpv-icon.ico). The windows-x64 recipe now builds mpv.exe with Badger's icon
 * and the name "Badger Player".
 * @regression-proof the Dockerfile check fails on the old recipe (no brand-mpv.sh before `meson setup`).
 */
const packageRoot = path.resolve(import.meta.dirname, "..");
const recipeDir = path.join(packageRoot, "recipes", "windows-x64");
const brandScript = path.join(recipeDir, "brand-mpv.sh");
const playerIco = path.join(recipeDir, "badger-player.ico");
// osdep/mpv.rc at the pinned desktop mpv commit (src/sources.ts `mpv`, v0.41.0 = 41f6a645068483470267271e1d09966ca3b9f413).
const pinnedRc = path.join(import.meta.dirname, "fixtures", "mpv-v0.41.0", "mpv.rc");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const fakeMpvSource = (rc: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), "sf-brand-mpv-"));
  dirs.push(dir);
  mkdirSync(path.join(dir, "osdep"));
  mkdirSync(path.join(dir, "etc"));
  writeFileSync(path.join(dir, "osdep", "mpv.rc"), rc);
  writeFileSync(path.join(dir, "etc", "mpv-icon.ico"), "mpv's own icon");
  return dir;
};

const brand = (dir: string) => {
  const run = spawnSync("sh", [brandScript, dir, playerIco], { encoding: "utf8" });
  console.info(`[brand-mpv] exit=${run.status} stdout=${run.stdout.trim()} stderr=${run.stderr.trim()}`);
  return run;
};

/** The ICONDIR of an .ico: each entry's width (0 = 256). */
const icoSizes = (bytes: Buffer) => {
  expect(bytes.readUInt16LE(0)).toBe(0);
  expect(bytes.readUInt16LE(2)).toBe(1);
  const count = bytes.readUInt16LE(4);
  return Array.from({ length: count }, (_, i) => bytes.readUInt8(6 + i * 16) || 256).sort((a, b) => a - b);
};

describe("Windows mpv.exe is built as Badger Player @req MPV-MODEL-05", () => {
  it("brands the pinned mpv.rc: Badger's icon in place of mpv's, Badger Player names, mpv's licence note kept", () => {
    const dir = fakeMpvSource(readFileSync(pinnedRc, "utf8"));
    const run = brand(dir);
    expect(run.status).toBe(0);
    const rc = readFileSync(path.join(dir, "osdep", "mpv.rc"), "utf8");
    const values = rc.split("\n").filter((line) => line.includes("VALUE"));
    console.info(`[brand-mpv] branded VALUE lines:\n${values.join("\n")}`);
    expect(rc).toContain('VALUE "FileDescription", "Badger Player"');
    expect(rc).toContain('VALUE "ProductName", "Badger Player"');
    expect(rc).toContain('VALUE "CompanyName", "SpaceFleet"');
    expect(rc).not.toMatch(/VALUE "(FileDescription|ProductName|CompanyName)", "mpv"/);
    expect(rc).toContain('VALUE "OriginalFilename", "mpv.exe"');
    expect(rc).toContain("GNU General Public License");
    expect(rc).toMatch(/IDI_ICON1 ICON .*"etc\/mpv-icon\.ico"/);
    expect(readFileSync(path.join(dir, "etc", "mpv-icon.ico")).equals(readFileSync(playerIco))).toBe(true);
  });

  it("fails the build when mpv.rc no longer has the lines it rewrites", () => {
    const changed = readFileSync(pinnedRc, "utf8").replace('VALUE "FileDescription", "mpv"', 'VALUE "FileDescription", "mpv media player"');
    const run = brand(fakeMpvSource(changed));
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('"FileDescription", "Badger Player"');
  });

  it("fails the build when mpv.rc no longer builds its window icon from etc/mpv-icon.ico", () => {
    const changed = readFileSync(pinnedRc, "utf8").replace('"etc/mpv-icon.ico"', '"etc/icon.ico"');
    const run = brand(fakeMpvSource(changed));
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("IDI_ICON1");
  });

  it("the player icon carries every Windows shell size, 16 to 256 px", () => {
    const sizes = icoSizes(readFileSync(playerIco));
    console.info(`[brand-mpv] badger-player.ico sizes: ${sizes.join(",")}`);
    expect(sizes).toEqual([16, 20, 24, 32, 40, 48, 64, 96, 128, 256]);
  });

  it("the recipe brands the mpv source after fetching it and before meson configures it", () => {
    const dockerfile = readFileSync(path.join(recipeDir, "Dockerfile"), "utf8");
    const fetch = dockerfile.indexOf('fetch-source mpv "$SRC_MPV_URL"');
    const brandAt = dockerfile.indexOf("sh /opt/recipe/brand-mpv.sh /work/mpv /opt/recipe/badger-player.ico");
    const setup = dockerfile.indexOf("meson setup /work/mpv/build");
    const copy = dockerfile.indexOf("COPY recipes/windows-x64/brand-mpv.sh recipes/windows-x64/badger-player.ico /opt/recipe/");
    console.info(`[brand-mpv] Dockerfile offsets copy=${copy} fetch=${fetch} brand=${brandAt} setup=${setup}`);
    expect(copy).toBeGreaterThan(-1);
    expect(fetch).toBeGreaterThan(copy);
    expect(brandAt).toBeGreaterThan(fetch);
    expect(setup).toBeGreaterThan(brandAt);
  });

});
