import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getDesktopPlatform } from "@space/desktop-platform";

import { resolveExternalMpvTarget } from "../src/external";

const roots: string[] = [];

// On assertion failure, dump the resolver inputs + the actual resolution so a
// mismatch (kind / bin / libDirs) is diagnosable offline without re-running.
const dumpResolutionSnapshot = (label: string, ctx: Record<string, unknown>) => {
  try {
    console.error(`=== [mpv-resolution:${label}] resolution snapshot ===`);
    console.error(JSON.stringify({ ...ctx, plantedRoots: roots }, null, 2));
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

const makeTempDir = () => {
  const root = mkdtempSync(path.join(tmpdir(), "mpv-deps-"));
  roots.push(root);
  console.info(`[mpv-resolution:setup] made temp dir ${root} (roots=${roots.length})`);
  return root;
};

const writeExecutable = (filePath: string) => {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
};

const mpvName = () => getDesktopPlatform().binaries.executableName("mpv");

/** Where the platform keeps mpv below a deps dir: `bin/mpv` (Linux/Windows), the `Badger Player.app` helper (macOS). */
const bundledMpv = (depsDir: string) => path.join(depsDir, getDesktopPlatform().binaries.bundledPath?.("mpv") ?? path.join("bin", mpvName()));

/** The library dirs the platform pairs with the mpv it resolves in this context (Linux/Windows: its bin dir; macOS: `<deps>/lib`). */
const platformMpvLibDirs = (ctx: { cwd: string; env: Record<string, string> }) => getDesktopPlatform().binaries.resolve("mpv", ctx)?.libDirs;

/** A checkout holding the fetched media-deps bundle under `<root>/vendor/deps/<os>-<arch>/`. */
const plantCheckoutBundle = () => {
  const root = makeTempDir();
  const binDir = getDesktopPlatform().binaries.searchDirs({ cwd: root, env: {} })[0];
  if (!binDir?.startsWith(root)) throw new Error(`unexpected bundle search dir ${binDir} for ${root}`);
  const bin = bundledMpv(path.dirname(binDir));
  writeExecutable(bin);
  return { root, bin };
};

afterEach(() => {
  const removing = roots.splice(0);
  console.info(`[mpv-resolution:teardown] removing ${removing.length} temp dir(s)`);
  for (const root of removing) rmSync(root, { recursive: true, force: true });
});

describe("mpv resolution (media-deps bundle)", () => {
  it("resolves the bundle in a checkout's vendor/deps with the platform's library dirs for it", () => {
    const { root, bin } = plantCheckoutBundle();
    const result = resolveExternalMpvTarget({ env: {}, cwd: root });
    if (result.kind !== "bundle" || result.bin !== bin) {
      dumpResolutionSnapshot("checkout", { cwd: root, expectedBin: bin, result });
    }
    expect(result.kind).toBe("bundle");
    expect(result.bin).toBe(bin);
    expect(result.libDirs).toEqual(platformMpvLibDirs({ cwd: root, env: {} }));
    expect(result.libDirs.length).toBeGreaterThan(0);
  });

  // @bugfix mpv-no-auto-system-binary @regression-proof
  //
  // A PATH / /usr/bin mpv (wrong version, different OSC, no libplacebo) must
  // never preempt the controlled binary. Only an EXPLICIT SF_MPV_SYSTEM_BIN is
  // honored, as an operator/dev override; with neither bundle nor override the
  // resolver returns the `fallback` sentinel (the desktop startup check logs it
  // as a "missing required bundled binaries" error) instead of spawning PATH mpv.
  describe("system mpv policy (bundle-only, explicit override)", () => {
    it("returns the fallback sentinel when there is no bundle and no override @req MPV-BIN-01", () => {
      const cwd = makeTempDir();
      const result = resolveExternalMpvTarget({ env: {}, cwd });
      if (result.kind !== "fallback") dumpResolutionSnapshot("no-bundle", { cwd, result });
      expect(result.kind).toBe("fallback");
      expect(result.bin).toBe("mpv");
    });

    it("honors an explicit SF_MPV_SYSTEM_BIN over the bundle", () => {
      const { root } = plantCheckoutBundle();
      const sysBin = path.join(makeTempDir(), "sys-mpv");
      writeExecutable(sysBin);
      const env = { SF_MPV_SYSTEM_BIN: sysBin };
      const result = resolveExternalMpvTarget({ env, cwd: root });
      if (result.kind !== "system" || result.bin !== sysBin) {
        dumpResolutionSnapshot("system-override", { env, cwd: root, expectedBin: sysBin, result });
      }
      expect(result.kind).toBe("system");
      expect(result.bin).toBe(sysBin);
      expect(result.libDirs).toEqual([]);
    });

    it("honors SF_MPV_EXTERNAL_BIN (the app's explicit override) with no bundle present, and ranks it above SF_MPV_SYSTEM_BIN", () => {
      const dir = makeTempDir();
      const extBin = path.join(dir, "ext-mpv");
      const sysBin = path.join(dir, "sys-mpv");
      writeExecutable(extBin);
      writeExecutable(sysBin);
      const alone = resolveExternalMpvTarget({ env: { SF_MPV_EXTERNAL_BIN: extBin }, cwd: dir });
      expect(alone.kind).toBe("system");
      expect(alone.bin).toBe(extBin);
      const both = resolveExternalMpvTarget({ env: { SF_MPV_EXTERNAL_BIN: extBin, SF_MPV_SYSTEM_BIN: sysBin }, cwd: dir });
      expect(both.bin).toBe(extBin);
    });

    it("ignores a non-existent SF_MPV_SYSTEM_BIN and uses the bundle", () => {
      const { root, bin } = plantCheckoutBundle();
      const env = { SF_MPV_SYSTEM_BIN: path.join(root, "does-not-exist", "mpv") };
      const result = resolveExternalMpvTarget({ env, cwd: root });
      if (result.kind !== "bundle" || result.bin !== bin) {
        dumpResolutionSnapshot("missing-system-override", { env, cwd: root, expectedBin: bin, result });
      }
      expect(result.kind).toBe("bundle");
      expect(result.bin).toBe(bin);
    });

    it("does not resolve the retired AppImage / linux-bundle layouts", () => {
      const cwd = makeTempDir();
      writeExecutable(path.join(cwd, "packages", "mpv", "vendor", "mpv", "linux-bundle", "bin", "mpv"));
      writeExecutable(path.join(cwd, "packages", "mpv", "vendor", "mpv", "mpv.AppImage"));
      const result = resolveExternalMpvTarget({ env: {}, cwd });
      expect(result.kind).toBe("fallback");
    });
  });

  // @bugfix packaged-app-binaries-unresolved @regression-proof
  //
  // In the packaged app app.getAppPath() (→ SF_APP_ROOT) is <resources>/app.asar
  // and electron-builder's extraResources land BESIDE it: <resources>/deps/bin.
  // Pre-fix the candidates were relative to the app root itself, so a packaged
  // build resolved kind="fallback" and the startup gate's modal blocked
  // createWindow.
  describe("packaged layout (extraResources beside app.asar)", () => {
    it("resolves a non-fallback external target via SF_APP_ROOT", () => {
      const install = makeTempDir();
      const resources = path.join(install, "resources");
      const appRoot = path.join(resources, "app.asar");
      const cwd = makeTempDir();
      const bin = bundledMpv(path.join(resources, "deps"));
      writeExecutable(bin);
      const env = { SF_APP_ROOT: appRoot };
      const result = resolveExternalMpvTarget({ env, cwd });
      if (result.kind !== "bundle" || result.bin !== bin) {
        dumpResolutionSnapshot("packaged-target", { appRoot, cwd, env, expectedBin: bin, result });
      }
      expect(result.kind).toBe("bundle");
      expect(result.bin).toBe(bin);
      expect(result.libDirs).toEqual(platformMpvLibDirs({ cwd, env }));
      expect(result.libDirs.length).toBeGreaterThan(0);
    });
  });
});
