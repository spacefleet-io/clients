import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

type StatementLike = {
  run: (...args: unknown[]) => unknown;
  get: (...args: unknown[]) => unknown;
  all: (...args: unknown[]) => unknown[];
};

class DatabaseSyncCompat {
  private readonly db: {
    exec: (sql: string) => unknown;
    close?: () => void;
    prepare: (sql: string) => StatementLike;
  };

  constructor(path: string, options?: Record<string, unknown>) {
    let ctor: ((path: string, options?: Record<string, unknown>) => unknown) | null = null;
    try {
      const nodeSqlite = require("node:sqlite") as {
        DatabaseSync?: new (path: string, options?: Record<string, unknown>) => unknown;
      };
      if (nodeSqlite.DatabaseSync) {
        ctor = (dbPath, dbOptions) => new nodeSqlite.DatabaseSync!(dbPath, dbOptions ?? {});
      }
    } catch {
      // noop, fallback to bun:sqlite below
    }
    if (!ctor) {
      const bunSqlite = require("bun:sqlite") as {
        Database?: new (path: string, options?: Record<string, unknown>) => unknown;
      };
      if (!bunSqlite.Database) {
        throw new Error("sqlite_driver_unavailable");
      }
      ctor = (dbPath) => new bunSqlite.Database!(dbPath);
    }
    this.db = ctor(path, options) as DatabaseSyncCompat["db"];
  }

  exec(sql: string) {
    return this.db.exec(sql);
  }

  prepare(sql: string) {
    const statement = this.db.prepare(sql);
    return {
      run: (...args: unknown[]) => statement.run(...args),
      get: (...args: unknown[]) => statement.get(...args),
      all: (...args: unknown[]) => statement.all(...args),
    };
  }

  close() {
    if (typeof this.db.close === "function") {
      this.db.close();
    }
  }
}

export const DatabaseSync = DatabaseSyncCompat;
