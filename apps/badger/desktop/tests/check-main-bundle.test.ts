/**
 * @bugfix @regression-proof issue #25 (Electron 43 PR #116): the packaged app
 * crashed at main-process startup with ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING.
 * `@space/runtime-host` sat in `dependencies`, so electron-vite's default
 * `build.externalizeDeps` left `import … from "@space/runtime-host"` in
 * out/main/index.js and electron-builder shipped the package's raw
 * `src/index.ts` into app.asar/node_modules, which Node refuses to load.
 * Workspace `@space/*` packages are TypeScript sources: they must be bundled
 * into out/main and out/preload, never resolved from node_modules at runtime.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { findUnbundledWorkspaceImports } from "../../../../packages/desktop-platform/packaging/check-main-bundle-lib.mjs";

const APP_DIR = join(__dirname, "..");
const CHECK_MAIN_BUNDLE = join(APP_DIR, "../../../packages/desktop-platform/packaging/check-main-bundle.mjs");

const tempDirs: string[] = [];
const makeTempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "check-main-bundle-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("badger desktop package.json", () => {
  it("lists no workspace @space/* package in dependencies (electron-vite would externalize it as raw TS)", () => {
    const pkg = JSON.parse(readFileSync(join(APP_DIR, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const workspaceRuntimeDeps = Object.keys(pkg.dependencies ?? {}).filter((name) => name.startsWith("@space/"));
    expect(workspaceRuntimeDeps).toEqual([]);
  });
});

describe("findUnbundledWorkspaceImports", () => {
  it("flags static, dynamic and require imports of @space/* left in the bundle", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, "index.js"),
      [
        'import { app } from "electron";',
        'import { createRuntimeLifecycleGuardian } from "@space/runtime-host";',
        'const lazy = () => import("@space/ffmpeg/probe");',
        "const cjs = require('@space/logger');",
      ].join("\n"),
    );
    expect(findUnbundledWorkspaceImports([dir])).toEqual([
      { file: join(dir, "index.js"), specifier: "@space/runtime-host" },
      { file: join(dir, "index.js"), specifier: "@space/ffmpeg/probe" },
      { file: join(dir, "index.js"), specifier: "@space/logger" },
    ]);
  });

  it("passes a bundle that only imports real runtime externals", () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "index.js"), 'import Database from "better-sqlite3";\nconst x = "@space/not-an-import";\n');
    writeFileSync(join(dir, "nested", "index.cjs"), 'const { ipcRenderer } = require("electron");\n');
    expect(findUnbundledWorkspaceImports([dir])).toEqual([]);
  });

  it("ignores missing output directories", () => {
    expect(findUnbundledWorkspaceImports([join(makeTempDir(), "absent")])).toEqual([]);
  });
});

describe("check-main-bundle CLI", () => {
  const runCli = (outFiles: Record<string, string>) => {
    const root = makeTempDir();
    for (const [rel, body] of Object.entries(outFiles)) {
      const file = join(root, "out", rel);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, body);
    }
    return spawnSync(process.execPath, [CHECK_MAIN_BUNDLE, root], { encoding: "utf8" });
  };

  it("fails when out/main still imports a workspace package", () => {
    const result = runCli({
      "main/index.js": 'import { x } from "@space/runtime-host";\n',
      "preload/index.cjs": 'require("electron");\n',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("@space/runtime-host");
  });

  it("passes a fully bundled out/main and out/preload", () => {
    const result = runCli({
      "main/index.js": 'import { app } from "electron";\n',
      "preload/index.cjs": 'require("electron");\n',
    });
    expect(result.status).toBe(0);
  });

  it("fails when there is no build output", () => {
    expect(runCli({}).status).toBe(1);
  });
});
