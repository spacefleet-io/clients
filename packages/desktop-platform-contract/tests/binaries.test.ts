import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bundledBinDirs, depsDirName, firstExisting } from "../src";

const roots: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-binaries-"));
  roots.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("bundledBinDirs", () => {
  it("names the per-OS deps dir", () => {
    expect(depsDirName("windows", "x64")).toBe("windows-x64");
  });

  it("puts <resources>/deps/bin first when packaged", () => {
    const dirs = bundledBinDirs("linux", "x64", { appRoot: "/opt/app/resources/app.asar", resourcesPath: "/opt/app/resources", cwd: "/" });
    console.info(`[binaries.test] packaged dirs: ${JSON.stringify(dirs)}`);
    expect(dirs[0]).toBe(join("/opt/app/resources", "deps", "bin"));
  });

  it("derives resources from the app root when no resourcesPath is given", () => {
    const dirs = bundledBinDirs("linux", "x64", { appRoot: "/opt/app/resources/app.asar", cwd: "/" });
    expect(dirs[0]).toBe(join("/opt/app/resources", "deps", "bin"));
  });

  // @bugfix @regression-proof: the packaged app calls resolveExternalMpvTarget() with no appRoot; the only
  // hint is SF_APP_ROOT in env, which the lookup ignored, so the shipped <resources>/deps/bin/mpv(.exe) was never found.
  it("derives resources from SF_APP_ROOT in env when no appRoot is passed", () => {
    const dirs = bundledBinDirs("windows", "x64", { env: { SF_APP_ROOT: "/opt/app/resources/app.asar" }, cwd: "/" });
    expect(dirs[0]).toBe(join("/opt/app/resources", "deps", "bin"));
  });

  it("walks up from cwd to vendor/deps/<os>-<arch>/bin in a checkout", () => {
    const root = scratch();
    const cwd = join(root, "apps", "badger", "desktop");
    mkdirSync(cwd, { recursive: true });
    const dirs = bundledBinDirs("windows", "arm64", { cwd });
    console.info(`[binaries.test] checkout dirs: ${JSON.stringify(dirs)}`);
    expect(dirs).toContain(join(root, "vendor", "deps", "windows-arm64", "bin"));
    expect(new Set(dirs).size).toBe(dirs.length);
  });
});

describe("firstExisting", () => {
  it("returns the first dir that has the file", () => {
    const a = scratch();
    const b = scratch();
    writeFileSync(join(b, "mpv"), "x");
    expect(firstExisting([a, b], "mpv")).toEqual({ path: join(b, "mpv"), dir: b });
    expect(firstExisting([a], "mpv")).toBeUndefined();
  });
});
