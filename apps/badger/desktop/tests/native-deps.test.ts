import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  BETTER_SQLITE_NATIVE_LOAD_GUIDANCE,
  isBetterSqliteNativeMismatchError,
} from "../src/main/nativeDeps";
import { getActionableDesktopErrorMessage } from "../src/renderer/src/lib/actionableErrors";
import { createBuilderConfig } from "../electron-builder.config.mjs";
import { SIGNED_WINDOWS_ENV } from "@space/desktop-platform-windows/packaging/signedWindowsEnv";

const desktopRequire = createRequire(join(__dirname, "..", "package.json"));
const betterSqliteDir = dirname(desktopRequire.resolve("better-sqlite3/package.json"));

describe("native deps", () => {
  it("ships better-sqlite3 as an N-API prebuild with no install-time native build", () => {
    const pkg = JSON.parse(readFileSync(join(betterSqliteDir, "package.json"), "utf8")) as {
      version: string;
      gypfile?: boolean;
      scripts?: Record<string, string>;
    };
    expect(Number(pkg.version.split(".")[0])).toBeGreaterThanOrEqual(13);
    expect(pkg.gypfile).toBe(false);
    expect(pkg.scripts?.install).toBeUndefined();
    expect(pkg.scripts?.postinstall).toBeUndefined();
    // Host prebuild only: `bun run package` materializes this package in place and
    // prunes the other platforms' prebuilds (scripts/materialize-runtime-deps-lib.mjs).
    expect(existsSync(join(betterSqliteDir, "prebuilds", `${process.platform}-${process.arch}.node`))).toBe(true);
  });

  it("@bugfix packages the N-API prebuild as-is instead of running @electron/rebuild", () => {
    // electron-builder's npm rebuild asks node-abi for the Electron ABI; node-abi
    // lags new Electron majors (it failed with "Could not detect abi for version
    // 43.7.8"), and an N-API prebuild needs no per-Electron rebuild anyway.
    for (const targetId of ["linux-x64", "windows-x64"]) {
      const build = createBuilderConfig({ targetId, env: SIGNED_WINDOWS_ENV }) as { npmRebuild?: boolean; asarUnpack?: string[] };
      expect(build.npmRebuild).toBe(false);
      expect(build.asarUnpack).toContain("**/*.node");
    }
  });

  it("pins electron to Electron 45 and packages the same version", () => {
    // Electron 44 dropped macOS 12 (Electron 45 keeps that floor); our minimum is macOS 14 (Sonoma), chosen by Chris 2026-10-16.
    // The installed `electron` and electron-builder's `build.electronVersion` must
    // match, or the packaged app ships a different runtime than the one tested.
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as {
      devDependencies: Record<string, string>;
    };
    // Badger's electron-builder config lives in electron-builder.config.mjs (one config for every target).
    const { electronVersion } = createBuilderConfig({ targetId: "linux-x64" }) as { electronVersion: string };
    expect(pkg.devDependencies.electron).toMatch(/^45\.\d+\.\d+$/);
    expect(electronVersion).toBe(pkg.devDependencies.electron);
  });

  it.each([
    "Error: Module did not self-register: '/x/better_sqlite3.node'.",
    "was compiled against a different Node.js version using NODE_MODULE_VERSION 137",
    "ERR_DLOPEN_FAILED: libfoo.so: cannot open shared object file",
    "Cannot find module '/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node'",
  ])("classifies a native load failure: %s", (message) => {
    expect(isBetterSqliteNativeMismatchError(new Error(message))).toBe(true);
  });

  it("does not classify unrelated open failures", () => {
    expect(isBetterSqliteNativeMismatchError(new Error("DECRYPT_FAILED"))).toBe(false);
    expect(isBetterSqliteNativeMismatchError(new Error("Cannot find module 'drizzle-orm'"))).toBe(false);
  });

  it("keeps the load-failure guidance actionable in the renderer and free of retired rebuild commands", () => {
    expect(getActionableDesktopErrorMessage(new Error(BETTER_SQLITE_NATIVE_LOAD_GUIDANCE))).toBe(
      BETTER_SQLITE_NATIVE_LOAD_GUIDANCE
    );
    expect(BETTER_SQLITE_NATIVE_LOAD_GUIDANCE).not.toContain("rebuild:electron");
  });
});
