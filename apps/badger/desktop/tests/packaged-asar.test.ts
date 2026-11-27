import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { createBuilderConfig } from "../electron-builder.config.mjs";
import { SIGNED_WINDOWS_ENV } from "../../../../packages/desktop-platform-windows/packaging/signedWindowsEnv";
import {
  asarFileExcludes,
  checkPackagedAsarEntries,
  DRIZZLE_ENTRY_POINTS,
  DRIZZLE_USED_DIRS,
  drizzleRootDir,
} from "../scripts/packaged-asar-lib.mjs";

const drizzleRoot = realpathSync(drizzleRootDir());

const topLevel = (file: string) => {
  const parts = relative(drizzleRoot, file).split("/");
  return parts.length > 1 ? parts[0]! : null;
};

/** Every file drizzle-orm itself loads from `entryPoints`, following static, dynamic and require() relative specifiers. */
const importClosure = (entryPoints: string[]) => {
  const specifier = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(["'])(\.{1,2}\/[^"']+)\1/g;
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const ext = file.endsWith(".cjs") ? ".cjs" : ".js";
    for (const match of readFileSync(file, "utf8").matchAll(specifier)) {
      const base = resolve(dirname(file), match[2]!);
      const target = [base, `${base}${ext}`, join(base, `index${ext}`)].find(
        (candidate) => candidate.endsWith(ext) && existsSync(candidate),
      );
      if (!target) throw new Error(`unresolved relative import ${match[2]} in ${file}`);
      visit(target);
    }
  };
  for (const entry of entryPoints) visit(join(drizzleRoot, entry));
  return [...seen];
};

describe("packaged app.asar contents", () => {
  it("drops every drizzle-orm dialect and driver directory the app never loads", () => {
    const installedDirs = readdirSync(drizzleRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    const excludedDirs = asarFileExcludes()
      .map((pattern) => pattern.match(/^!\*\*\/node_modules\/drizzle-orm\/([^/{]+)\{,\/\*\*\/\*\}$/)?.[1])
      .filter((dir): dir is string => dir !== undefined);
    expect(excludedDirs.sort()).toEqual(installedDirs.filter((dir) => !DRIZZLE_USED_DIRS.includes(dir)).sort());
    // The ones that cost the most when they slip back in: a dialect we never open.
    for (const dialect of ["gel-core", "mysql-core", "singlestore-core", "neon-http", "libsql", "bun-sqlite"]) {
      expect(excludedDirs).toContain(dialect);
    }
  });

  it("drops source maps and type declarations the runtime never reads", () => {
    expect(asarFileExcludes()).toEqual(expect.arrayContaining(["!**/*.map", "!**/*.d.{cts,mts}"]));
  });

  it("never excludes a drizzle-orm file the main process loads at runtime", () => {
    // out/main imports "drizzle-orm" and "drizzle-orm/sqlite-core" (ESM) and require()s "drizzle-orm/better-sqlite3" (CJS).
    const closure = importClosure(DRIZZLE_ENTRY_POINTS);
    expect(closure.length).toBeGreaterThan(100);
    const needed = new Set(closure.map(topLevel).filter((dir): dir is string => dir !== null));
    expect([...needed].filter((dir) => !DRIZZLE_USED_DIRS.includes(dir))).toEqual([]);
    expect(closure.filter((file) => /\.(map|d\.cts|d\.mts)$/.test(file))).toEqual([]);
  });

  it("applies the excludes to the app files of both targets", () => {
    for (const targetId of ["linux-x64", "windows-x64"]) {
      const cfg = createBuilderConfig({ targetId, env: SIGNED_WINDOWS_ENV }) as unknown as { files: string[] };
      expect(cfg.files.slice(0, 3)).toEqual(["out/**", "node_modules/**", "package.json"]);
      expect(cfg.files.slice(3)).toEqual(asarFileExcludes());
    }
  });

  it("accepts an asar holding only what the app loads", () => {
    expect(
      checkPackagedAsarEntries([
        "out/main/index.js",
        "node_modules/drizzle-orm/index.js",
        "node_modules/drizzle-orm/index.cjs",
        "node_modules/drizzle-orm/sqlite-core/index.js",
        "node_modules/drizzle-orm/better-sqlite3/index.cjs",
        "node_modules/drizzle-orm/pg-core/primary-keys.js",
      ]),
    ).toEqual({ unexpected: [], missing: [] });
  });

  it("flags an unused dialect, a source map or a type declaration that slipped back in", () => {
    const { unexpected } = checkPackagedAsarEntries([
      "node_modules/drizzle-orm/index.js",
      "node_modules/drizzle-orm/sqlite-core/index.js",
      "node_modules/drizzle-orm/better-sqlite3/index.cjs",
      "node_modules/drizzle-orm/mysql-core/index.js",
      "node_modules/drizzle-orm/gel-core/index.js",
      "node_modules/drizzle-orm/index.js.map",
      "node_modules/drizzle-orm/index.d.cts",
      "node_modules/electron-updater/out/main.js.map",
    ]);
    expect(unexpected).toEqual([
      "node_modules/drizzle-orm/mysql-core/index.js",
      "node_modules/drizzle-orm/gel-core/index.js",
      "node_modules/drizzle-orm/index.js.map",
      "node_modules/drizzle-orm/index.d.cts",
      "node_modules/electron-updater/out/main.js.map",
    ]);
  });

  it("flags a pruned file the main process needs", () => {
    expect(checkPackagedAsarEntries(["out/main/index.js", "node_modules/drizzle-orm/index.js"]).missing).toEqual([
      "node_modules/drizzle-orm/sqlite-core/index.js",
      "node_modules/drizzle-orm/better-sqlite3/index.cjs",
    ]);
  });
});
