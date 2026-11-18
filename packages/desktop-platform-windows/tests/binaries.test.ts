import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWindowsBinaries, executableName, withWindowsPath } from "../src/binaries";

describe("windows executableName", () => {
  it("appends .exe and is idempotent", () => {
    console.info("[windows-binaries:executableName] start");
    expect(executableName("mpv")).toBe("mpv.exe");
    expect(executableName("ffmpeg")).toBe("ffmpeg.exe");
    expect(executableName("mpv.exe")).toBe("mpv.exe");
    expect(executableName("MPV.EXE")).toBe("MPV.EXE");
    expect(executableName(executableName("ffprobe"))).toBe("ffprobe.exe");
  });
});

describe("windows PATH merging", () => {
  it("prepends dirs to PATH with ; and returns a copy", () => {
    const env = { PATH: "C:\\Windows;C:\\Tools", KEEP: "1" };
    const out = withWindowsPath(env, ["C:\\deps\\bin"]);
    console.info("[windows-binaries:path] merged", out);
    expect(out).toEqual({ PATH: "C:\\deps\\bin;C:\\Windows;C:\\Tools", KEEP: "1" });
    expect(out).not.toBe(env);
    expect(env.PATH).toBe("C:\\Windows;C:\\Tools");
  });

  it("finds the existing key case-insensitively and does not add a second spelling", () => {
    const out = withWindowsPath({ Path: "C:\\Windows" }, ["C:\\deps\\bin"]);
    expect(out).toEqual({ Path: "C:\\deps\\bin;C:\\Windows" });
    expect(Object.keys(out)).toEqual(["Path"]);
  });

  it("creates PATH when there is none", () => {
    expect(withWindowsPath({}, ["C:\\a", "C:\\b"])).toEqual({ PATH: "C:\\a;C:\\b" });
  });

  it("dedupes dirs against each other and the existing entries, ignoring case and a trailing slash", () => {
    const out = withWindowsPath({ PATH: "c:\\DEPS\\bin\\;C:\\Windows;;" }, ["C:\\deps\\bin", "C:\\deps\\bin", "C:\\extra"]);
    expect(out.PATH).toBe("C:\\deps\\bin;C:\\extra;C:\\Windows");
  });

  it("returns an untouched copy for no dirs", () => {
    const env = { Path: "C:\\Windows" };
    const out = withWindowsPath(env, []);
    expect(out).toEqual(env);
    expect(out).not.toBe(env);
  });
});

describe("windows binary layer", () => {
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "sf-win-binaries-"));
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const layer = createWindowsBinaries("x64");

  it("searches vendor/deps/windows-x64/bin and <resources>/deps/bin", () => {
    const resources = join(tmp, "res");
    const dirs = layer.searchDirs({ appRoot: join(resources, "app.asar"), resourcesPath: resources, cwd: join(tmp, "co") });
    console.info("[windows-binaries:searchDirs]", dirs);
    expect(dirs[0]).toBe(join(resources, "deps", "bin"));
    expect(dirs).toContain(join(tmp, "co", "vendor", "deps", "windows-x64", "bin"));
    expect(layer.searchDirs({ cwd: tmp }).every((dir) => !dir.includes("linux-"))).toBe(true);
  });

  it("resolves .exe files from a checkout (vendor-deps) and from a packaged app (packaged-deps)", () => {
    const checkout = join(tmp, "checkout");
    const devBin = join(checkout, "vendor", "deps", "windows-x64", "bin");
    mkdirSync(devBin, { recursive: true });
    writeFileSync(join(devBin, "mpv.exe"), "x");
    writeFileSync(join(devBin, "mpv"), "x"); // a bare name is NOT the Windows binary
    const dev = layer.resolve("mpv", { cwd: join(checkout, "apps"), env: {} });
    expect(dev).toEqual({ path: join(devBin, "mpv.exe"), dir: devBin, libDirs: [devBin], source: "vendor-deps" });

    const resources = join(tmp, "installed", "resources");
    const packagedBin = join(resources, "deps", "bin");
    mkdirSync(packagedBin, { recursive: true });
    writeFileSync(join(packagedBin, "ffmpeg.exe"), "x");
    const packaged = layer.resolve("ffmpeg", { appRoot: join(resources, "app.asar"), resourcesPath: resources, cwd: join(tmp, "elsewhere"), env: {} });
    expect(packaged?.path).toBe(join(packagedBin, "ffmpeg.exe"));
    expect(packaged?.source).toBe("packaged-deps");
    console.info("[windows-binaries:resolve] dev=%s packaged=%s", dev?.source, packaged?.source);
  });

  it("has no legacy lookups: an absent binary is undefined / empty", () => {
    const ctx = { cwd: join(tmp, "nowhere"), env: { SF_MPV_EXTERNAL_BUNDLE_BIN: join(tmp, "x.exe") } };
    expect(layer.resolve("mpv", ctx)).toBeUndefined();
    expect(layer.resolveAll("mpv", ctx)).toEqual([]);
    expect(layer.resolveAll("ffmpeg", ctx)).toEqual([]);
  });

  it("launchEnv / withLibraryPath put the library dirs on PATH, even when it is spelled Path", () => {
    const env = { Path: "C:\\Windows", KEEP: "1" };
    expect(layer.launchEnv({ libDirs: ["C:\\deps\\bin"] }, env)).toEqual({ Path: "C:\\deps\\bin;C:\\Windows", KEEP: "1" });
    expect(layer.withLibraryPath(env, ["C:\\lib"])).toEqual({ Path: "C:\\lib;C:\\Windows", KEEP: "1" });
    expect(env).toEqual({ Path: "C:\\Windows", KEEP: "1" });
    expect(layer.launchEnv({}, { A: "1" })).toEqual({ A: "1" });
  });
});
