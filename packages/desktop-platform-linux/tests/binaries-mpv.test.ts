import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ResolvedBinary } from "@space/desktop-platform-contract";
import { createLinuxBinaries } from "../src/binaries";

// Real-filesystem tests for the mpv lookups (moved from packages/mpv/src/index.ts
// resolveMpvAppImage / resolveMpvLinuxBundle; the former `mpv/tests/resolution.test.ts` cases).
const binaries = createLinuxBinaries("x64");
const roots: string[] = [];

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const makeTempDir = () => {
  const root = mkdtempSync(path.join(tmpdir(), "mpv-layer-"));
  roots.push(root);
  console.info(`[linux-binaries-mpv:setup] made temp dir ${root}`);
  return root;
};

const writeExecutable = (filePath: string) => {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
};

const dump = (label: string, ctx: Record<string, unknown>) => {
  try {
    console.error(`=== [linux-binaries-mpv:${label}] snapshot ===\n${JSON.stringify(ctx, null, 2)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

const expectPaths = (label: string, ctx: Record<string, unknown>, all: ResolvedBinary[], paths: string[]) => {
  const actual = all.map((entry) => entry.path);
  console.info(`[linux-binaries-mpv:${label}] candidates=${JSON.stringify(actual)}`);
  try {
    expect(actual).toEqual(paths);
  } catch (err) {
    dump(label, { ...ctx, all });
    throw err;
  }
};

describe("linux binaries: mpv lookups (the media-deps bundle layout)", () => {
  it("resolves <resources>/deps/bin/mpv beside app.asar with libDirs=[bin]", () => {
    const install = makeTempDir();
    const resources = path.join(install, "resources");
    const appRoot = path.join(resources, "app.asar");
    const cwd = makeTempDir();
    const depsMpv = path.join(resources, "deps", "bin", "mpv");
    writeExecutable(depsMpv);
    const all = binaries.resolveAll("mpv", { appRoot, cwd, env: {} });
    expectPaths("packaged", { appRoot, cwd }, all, [depsMpv]);
    expect(all[0]?.source).toBe("packaged-deps");
    expect(all[0]?.libDirs).toEqual([path.dirname(depsMpv)]);
    expect(binaries.resolve("mpv", { appRoot, cwd, env: {} })?.path).toBe(depsMpv);
  });

  it("returns [] / undefined when no mpv exists anywhere", () => {
    const root = makeTempDir();
    expect(binaries.resolveAll("mpv", { appRoot: root, cwd: root, env: {} })).toEqual([]);
    expect(binaries.resolve("mpv", { appRoot: root, cwd: root, env: {} })).toBeUndefined();
  });

  // @bugfix mpv-vendor-unreachable-when-main-bundled @regression-proof
  //
  // Dev startup failure: with @space/mpv bundled into the desktop main process the
  // fetched bundle lives at the MONOREPO ROOT (vendor/deps/linux-x64/bin), while
  // appRoot/cwd are the deep app package dir (apps/badger/desktop). The lookup
  // must walk up to find it.
  describe("dev monorepo layout (binary only at repo-root vendor/deps)", () => {
    const buildFakeRepo = () => {
      const repo = makeTempDir();
      const appDir = path.join(repo, "apps", "badger", "desktop");
      mkdirSync(appDir, { recursive: true });
      const bundleBin = path.join(repo, "vendor", "deps", "linux-x64", "bin", "mpv");
      writeExecutable(bundleBin);
      console.info(`[linux-binaries-mpv:dev-layout-setup] repo=${repo} appDir=${appDir}`);
      return { repo, appDir, bundleBin };
    };

    it("finds the fetched bundle by walking up from the app dir", () => {
      const { appDir, bundleBin } = buildFakeRepo();
      const all = binaries.resolveAll("mpv", { appRoot: appDir, cwd: appDir, env: {} });
      expectPaths("dev-layout", { appDir }, all, [bundleBin]);
      expect(all[0]?.source).toBe("vendor-deps");
      expect(all[0]?.libDirs).toEqual([path.dirname(bundleBin)]);
    });

    it("ignores another architecture's bundle", () => {
      const repo = makeTempDir();
      const appDir = path.join(repo, "apps", "badger", "desktop");
      mkdirSync(appDir, { recursive: true });
      writeExecutable(path.join(repo, "vendor", "deps", "windows-x64", "bin", "mpv.exe"));
      expect(binaries.resolveAll("mpv", { appRoot: appDir, cwd: appDir, env: {} })).toEqual([]);
    });
  });

  // The pre-media-deps layouts (extracted linux-bundle, mpv.AppImage, packages/mpv/vendor) were retired with the
  // own-builds cutover (#248): a stale copy lying around must never be picked up.
  it("does not resolve retired legacy layouts", () => {
    const install = makeTempDir();
    const resources = path.join(install, "resources");
    const appRoot = path.join(resources, "app.asar");
    writeExecutable(path.join(resources, "mpv", "linux-bundle", "bin", "mpv"));
    writeExecutable(path.join(resources, "mpv", "mpv.AppImage"));
    writeExecutable(path.join(install, "packages", "mpv", "vendor", "mpv", "linux-bundle", "bin", "mpv"));
    expect(binaries.resolveAll("mpv", { appRoot, cwd: install, env: {} })).toEqual([]);
  });
});

describe("linux binaries: library path and launch env", () => {
  it("withLibraryPath prepends, dedupes, preserves existing entries and does not mutate", () => {
    const env = { LD_LIBRARY_PATH: "/x/lib:/opt/b/lib", KEEP: "1" };
    const out = binaries.withLibraryPath(env, ["/opt/b/lib", "/opt/b/lib/dri", "/opt/b/lib"]);
    console.info(`[linux-binaries-mpv:ld-path] out=${JSON.stringify(out)}`);
    expect(out.LD_LIBRARY_PATH).toBe("/opt/b/lib:/opt/b/lib/dri:/x/lib");
    expect(out.KEEP).toBe("1");
    expect(env.LD_LIBRARY_PATH).toBe("/x/lib:/opt/b/lib");
  });

  it("withLibraryPath with no dirs returns an unchanged copy", () => {
    const env = { A: "1" };
    const out = binaries.withLibraryPath(env, []);
    expect(out).toEqual(env);
    expect(out).not.toBe(env);
  });

  it("launchEnv: bundle libDirs go on LD_LIBRARY_PATH", () => {
    const out = binaries.launchEnv({ libDirs: ["/opt/b/lib"] }, { LD_LIBRARY_PATH: "/y" });
    expect(out.LD_LIBRARY_PATH).toBe("/opt/b/lib:/y");
  });
});
