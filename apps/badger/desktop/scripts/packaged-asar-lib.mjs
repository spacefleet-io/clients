// What app.asar ships from node_modules. `drizzle-orm` is externalized from the
// main bundle (electron.vite.config.ts `runtimeExternals`) and loaded by
// packages/library-db-runtime at runtime, so electron-builder copies the whole
// package: 10 MiB over 2241 files, of which the app loads about 1.1 MiB. The
// excludes below drop the rest; `checkPackagedAsarEntries` re-checks the built
// asar and tests/packaged-asar.test.ts proves the excludes never remove a file
// the main process loads.
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";

/**
 * Entry points the main process loads: `import … from "drizzle-orm"` and
 * `"drizzle-orm/sqlite-core"` (ESM, the bundled @space/library-db-* schemas) and
 * `require("drizzle-orm/better-sqlite3")` (CJS, packages/library-db-runtime/src/db.ts).
 */
export const DRIZZLE_ENTRY_POINTS = [
  "index.js",
  "index.cjs",
  "sqlite-core/index.js",
  "sqlite-core/index.cjs",
  "better-sqlite3/index.js",
  "better-sqlite3/index.cjs",
];

/**
 * drizzle-orm directories those entry points reach. `pg-core` is used for one
 * helper (`relations.js` imports `pg-core/primary-keys.js`), not as a dialect.
 */
export const DRIZZLE_USED_DIRS = ["better-sqlite3", "cache", "pg-core", "query-builders", "sql", "sqlite-core"];

/** @returns {string} the installed drizzle-orm package directory */
export const drizzleRootDir = () => dirname(createRequire(import.meta.url).resolve("drizzle-orm"));

/**
 * electron-builder `files` patterns appended after the defaults: no source maps or
 * `.d.cts`/`.d.mts` declarations anywhere (`.d.ts` is already excluded by
 * electron-builder), and no drizzle-orm directory outside DRIZZLE_USED_DIRS. The
 * directory list is read from the installed package so a new driver added by an
 * upgrade is excluded by default.
 * @param {string} [drizzleRoot]
 * @returns {string[]}
 */
export const asarFileExcludes = (drizzleRoot = drizzleRootDir()) => [
  "!**/*.map",
  "!**/*.d.{cts,mts}",
  ...readdirSync(drizzleRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !DRIZZLE_USED_DIRS.includes(entry.name))
    .map((entry) => `!**/node_modules/drizzle-orm/${entry.name}{,/**/*}`),
];

const REQUIRED_ASAR_ENTRIES = [
  "node_modules/drizzle-orm/index.js",
  "node_modules/drizzle-orm/sqlite-core/index.js",
  "node_modules/drizzle-orm/better-sqlite3/index.cjs",
];

const normalize = (entry) => entry.replace(/^\/+/, "");

/**
 * Entries that must not be in the packaged asar (source maps, declarations, an unused
 * drizzle-orm dialect) and required ones that are absent.
 * @param {string[]} entries file paths inside app.asar
 * @returns {{ unexpected: string[]; missing: string[] }}
 */
export const checkPackagedAsarEntries = (entries) => {
  const normalized = entries.map(normalize);
  const unexpected = entries.filter((entry, index) => {
    const path = normalized[index];
    if (/\.(?:map|d\.cts|d\.mts)$/.test(path)) return true;
    const drizzleDir = /^node_modules\/drizzle-orm\/([^/]+)\//.exec(path)?.[1];
    return drizzleDir !== undefined && !DRIZZLE_USED_DIRS.includes(drizzleDir);
  });
  const present = new Set(normalized);
  return { unexpected, missing: REQUIRED_ASAR_ENTRIES.filter((entry) => !present.has(entry)) };
};

/**
 * Every file path inside an asar archive. Reads only the JSON header: the file is a
 * Chromium pickle (u32 size, u32 header size, u32 json length, u32 json length, json).
 * @param {string} asarPath
 * @returns {string[]}
 */
export const listAsarEntries = (asarPath) => {
  const buffer = readFileSync(asarPath);
  const jsonLength = buffer.readUInt32LE(12);
  const header = JSON.parse(buffer.subarray(16, 16 + jsonLength).toString("utf8"));
  const entries = [];
  const walk = (node, prefix) => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const path = `${prefix}/${name}`;
      if (child.files) walk(child, path);
      else entries.push(path.slice(1));
    }
  };
  walk(header, "");
  return entries;
};
