import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { windowsPaths } from "../src/paths";

describe("windows paths", () => {
  it("defaults the runtime data dir to %LOCALAPPDATA%\\SpaceFleet\\runtime", () => {
    console.info("[windows-paths:default] checking default runtime data dir");
    expect(windowsPaths.runtimeDataDir({ LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local" })).toBe("C:\\Users\\Ada\\AppData\\Local\\SpaceFleet\\runtime");
  });

  it("reads LOCALAPPDATA ignoring case and whitespace", () => {
    expect(windowsPaths.runtimeDataDir({ LocalAppData: "  D:\\Data  " })).toBe("D:\\Data\\SpaceFleet\\runtime");
  });

  it("honours a trimmed SPACEFLEET_RUNTIME_DATA_DIR and ignores blank values", () => {
    const fallback = win32.join("C:\\L", "SpaceFleet", "runtime");
    expect(windowsPaths.runtimeDataDir({ SPACEFLEET_RUNTIME_DATA_DIR: "  D:\\sf  ", LOCALAPPDATA: "C:\\L" })).toBe("D:\\sf");
    expect(windowsPaths.runtimeDataDir({ SPACEFLEET_RUNTIME_DATA_DIR: "   ", LOCALAPPDATA: "C:\\L" })).toBe(fallback);
    expect(windowsPaths.runtimeDataDir({ SPACEFLEET_RUNTIME_DATA_DIR: "", LOCALAPPDATA: "C:\\L" })).toBe(fallback);
  });

  it("keeps Electron user data in the legacy <appData>\\<scope>\\<name> dir", () => {
    expect(windowsPaths.appUserDataDir({ appData: "C:\\R", productName: "SpaceBadger", legacyDir: ["@space", "badger"] })).toBe("C:\\R\\@space\\badger");
  });

  it("falls back to ~\\AppData\\Local without LOCALAPPDATA", () => {
    const local = win32.join(homedir(), "AppData", "Local");
    expect(windowsPaths.userDataBase({})).toBe(local);
    expect(windowsPaths.userDataBase({ LOCALAPPDATA: "  " })).toBe(local);
    expect(windowsPaths.runtimeDataDir({})).toBe(win32.join(local, "SpaceFleet", "runtime"));
  });

  it("user data base is %LOCALAPPDATA%", () => {
    expect(windowsPaths.userDataBase({ LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local" })).toBe("C:\\Users\\Ada\\AppData\\Local");
  });

  it("reads process.env when no env is given", () => {
    const saved = process.env.SPACEFLEET_RUNTIME_DATA_DIR;
    process.env.SPACEFLEET_RUNTIME_DATA_DIR = "E:\\from-process-env";
    try {
      expect(windowsPaths.runtimeDataDir()).toBe("E:\\from-process-env");
    } finally {
      if (saved === undefined) delete process.env.SPACEFLEET_RUNTIME_DATA_DIR;
      else process.env.SPACEFLEET_RUNTIME_DATA_DIR = saved;
    }
  });

  it("prepareRuntimeDataDir creates the resolved dir and returns it", () => {
    const root = mkdtempSync(join(tmpdir(), "sf-windows-paths-"));
    const dir = join(root, "nested", "runtime");
    try {
      expect(windowsPaths.prepareRuntimeDataDir({ env: { SPACEFLEET_RUNTIME_DATA_DIR: dir } })).toBe(dir);
      expect(existsSync(dir)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
