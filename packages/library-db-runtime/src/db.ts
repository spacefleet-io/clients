// Use globalThis to cache the lazily-loaded Database class.
// Try bun:sqlite first (runtime/headless), fall back to better-sqlite3 (Electron/Node).
// better-sqlite3 13 loads one N-API prebuild (`prebuilds/<platform>-<arch>.node`)
// under Node and Electron alike, so there is no per-ABI binding to select.
import { createRequire } from "node:module";

let _Database: any = null;
let _drizzle: any = null;

// `require` is not a global under ESM (Electron with ELECTRON_RUN_AS_NODE
// + tsx, the headless CLI, the desktop main when bundled as ESM). The
// previous bare `require(...)` calls below threw `ReferenceError: require
// is not defined` immediately — the outer try/catch couldn't help because
// it was the lookup of `require` itself that failed, not the lookup of
// "bun:sqlite". Use createRequire so this module's CJS-resolution surface
// keeps working across both the CJS targets (Electron preload) and ESM
// targets (E2E harness, headless main).
const localRequire = createRequire(import.meta.url);

/** Registers the sqlite driver + drizzle adapter up front (see `bunSqlite.ts`), skipping the lazy `require`s below. */
export const setSqliteModules = (modules: { Database: any; drizzle: any }) => {
  _Database = modules.Database;
  _drizzle = modules.drizzle;
};

const ensureLoaded = () => {
  if (_Database) return;
  try {
    _Database = localRequire("bun:sqlite").Database;
    _drizzle = localRequire("drizzle-orm/bun-sqlite").drizzle;
  } catch {
    _Database = localRequire("better-sqlite3");
    _drizzle = localRequire("drizzle-orm/better-sqlite3").drizzle;
  }
};

export type SqliteDatabase = { exec(sql: string): void; prepare(sql: string): any; close(): void; serialize(): Uint8Array; [k: string]: any };
export type MainSqliteDatabase = ReturnType<typeof import("drizzle-orm/bun-sqlite").drizzle>;

export const createOrm = (db: SqliteDatabase) => {
  ensureLoaded();
  return _drizzle(db);
};

export const openDatabase = (filename: string): SqliteDatabase => {
  ensureLoaded();
  return new _Database(filename);
};
