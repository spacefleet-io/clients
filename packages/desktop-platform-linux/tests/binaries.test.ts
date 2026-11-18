import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLinuxBinaries } from "../src/binaries";

const binaries = createLinuxBinaries("x64");
const roots: string[] = [];

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const makeTempDir = () => {
  const root = mkdtempSync(path.join(tmpdir(), "ffmpeg-layer-"));
  roots.push(root);
  return root;
};

const writeExecutable = (filePath: string) => {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
};

// Dump-on-failure: surface the resolution inputs and result so a wrong-path failure is diagnosable offline.
const dumpBinaryResolutionSnapshot = (label: string, ctx: Record<string, unknown>) => {
  try {
    console.error(`=== [binary-resolution:${label}] snapshot ===\n${JSON.stringify(ctx, null, 2)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("linux binaries: ffmpeg/ffprobe resolution (the media-deps bundle layout)", () => {
  it("finds the binaries in the fetched checkout bundle (bun scripts/fetch-deps.ts)", () => {
    const repo = makeTempDir();
    const appRoot = path.join(repo, "apps", "badger", "desktop");
    const ffprobe = path.join(repo, "vendor", "deps", "linux-x64", "bin", "ffprobe");
    writeExecutable(ffprobe);
    const resolved = binaries.resolve("ffprobe", { appRoot, cwd: appRoot, env: {} });
    console.info(`[binary-resolution:vendor-dev] resolved=${JSON.stringify(resolved)}`);
    try {
      expect(resolved?.path).toBe(ffprobe);
      expect(resolved?.source).toBe("vendor-deps");
      expect(resolved?.libDirs).toEqual([path.dirname(ffprobe)]);
    } catch (err) {
      dumpBinaryResolutionSnapshot("vendor-dev", { repo, resolved });
      throw err;
    }
  });

  // @bugfix packaged-app-binaries-unresolved @regression-proof
  // Packaged: app.getAppPath() is <resources>/app.asar and extraResources put the bundle at
  // <resources>/deps/bin/<bin>, beside app.asar, not under it. Pre-fix no candidate pointed there, ffmpeg/ffprobe
  // resolved to undefined and the startup gate's modal blocked the window from ever opening.
  it("finds the binaries beside app.asar in the packaged layout", () => {
    const install = makeTempDir();
    const resources = path.join(install, "resources");
    const expected = path.join(resources, "deps", "bin", "ffprobe");
    writeExecutable(expected);
    const resolved = binaries.resolve("ffprobe", { appRoot: path.join(resources, "app.asar"), cwd: makeTempDir(), env: {} });
    try {
      expect(resolved?.path).toBe(expected);
      expect(resolved?.source).toBe("packaged-deps");
    } catch (err) {
      dumpBinaryResolutionSnapshot("packaged-layout", { resources, resolved });
      throw err;
    }
  });

  it("prefers the packaged bundle over a checkout bundle", () => {
    const install = makeTempDir();
    const resources = path.join(install, "resources");
    const packaged = path.join(resources, "deps", "bin", "ffmpeg");
    const checkout = path.join(install, "vendor", "deps", "linux-x64", "bin", "ffmpeg");
    writeExecutable(packaged);
    writeExecutable(checkout);
    expect(binaries.resolve("ffmpeg", { appRoot: path.join(resources, "app.asar"), cwd: install, env: {} })?.path).toBe(packaged);
  });

  it("returns undefined when no binary exists at any path", () => {
    const root = makeTempDir();
    const resolved = binaries.resolve("ffmpeg", { appRoot: root, cwd: root, env: {} });
    try {
      expect(resolved).toBeUndefined();
    } catch (err) {
      dumpBinaryResolutionSnapshot("none-exist", { root, resolved });
      throw err;
    }
  });

  // The pre-media-deps vendor/ffmpeg (BtbN static / cpu-min) and resources/ffmpeg layouts were retired with the
  // own-builds cutover (#248): a stale copy lying around must never be picked up.
  it("does not resolve retired legacy layouts", () => {
    const install = makeTempDir();
    const resources = path.join(install, "resources");
    writeExecutable(path.join(resources, "ffmpeg", "ffprobe"));
    writeExecutable(path.join(install, "packages", "ffmpeg", "vendor", "ffmpeg", "ffprobe"));
    expect(binaries.resolve("ffprobe", { appRoot: path.join(resources, "app.asar"), cwd: install, env: {} })).toBeUndefined();
  });
});
