import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";

import { setSqliteModules } from "./db";

/**
 * Hands bun's sqlite modules to the lazy loader in `db.ts`. Call once from a Bun entry point that is
 * `bun build --compile`d: the loader's `createRequire(import.meta.url)` calls cannot resolve
 * `drizzle-orm/bun-sqlite` out of the compiled bundle, but these static imports are bundled. Never import
 * this from Node/Electron code (`bun:sqlite` does not exist there).
 */
export const registerBunSqlite = (): void => {
  setSqliteModules({ Database, drizzle });
};
