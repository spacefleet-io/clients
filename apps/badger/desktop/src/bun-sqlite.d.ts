/**
 * Minimal type stub for `bun:sqlite` so the desktop tsc check passes.
 * The actual runtime uses better-sqlite3 in Electron; this satisfies
 * the type-only import from @space/library-db-runtime.
 *
 * This uses the same structural shape as SqliteDatabase in db.ts so
 * assignments between the two are compatible in both directions.
 */
declare module "bun:sqlite" {
  type Database = {
    close(): void;
    exec(sql: string): void;
    prepare(sql: string): any;
    serialize(): Uint8Array;
    [key: string]: any;
  };

  const Database: {
    new (filename?: string, options?: Record<string, unknown>): Database;
  };

  type Statement<T = unknown> = {
    [key: string]: any;
  };
}
