/**
 * @test-id LIB-DB-ASYNC-MIGRATIONS-001
 * @level unit
 * @why Phase 2 of the library-db unification — mobile uses
 *   react-native-sqlite-storage, whose driver is Promise-based.
 *   `ensureLibrarySchemaAsync(db, group)` mirrors the sync `ensureLibrarySchema`
 *   but iterates the SAME shared DDL constants so sync and async can never
 *   drift. This test pins that guarantee and prevents accidental fork.
 */
import { describe, expect, it } from "vitest";
import {
  type AsyncSqliteDb,
  ensureLibrarySchemaAsync,
  ensureLibrarySchema,
  getGroupDdlStatements,
  type SqliteDb,
} from "../src/migrations";
import { ALL_LIBRARY_DB_GROUPS } from "../src/manifest";

const SUITE = "async-migrations";

const buildAsyncMockDb = () => {
  const executed: string[] = [];
  const db: AsyncSqliteDb = {
    exec: async (sql: string) => {
      executed.push(sql);
    },
  };
  return { db, executed };
};

const buildSyncMockDb = () => {
  const executed: string[] = [];
  const db: SqliteDb = {
    exec: (sql: string) => {
      executed.push(sql);
      return undefined;
    },
    prepare: (_sql: string) => ({
      all: () => [],
      run: () => undefined,
    }),
  };
  return { db, executed };
};

const normalizeWhitespace = (sql: string): string => sql.replace(/\s+/g, " ").trim();

const head = (s: string, n = 120): string => (s.length > n ? `${s.slice(0, n)}…` : s);

const dumpMigrationSnapshot = (
  label: string,
  ctx: {
    group?: string;
    executed?: ReadonlyArray<string>;
    expected?: ReadonlyArray<string>;
    indexMismatch?: number;
    note?: string;
    extra?: Record<string, unknown>;
  } = {},
) => {
  try {
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    if (ctx.note) console.error(`note: ${ctx.note}`);
    if (ctx.group) console.error(`group: ${ctx.group}`);
    if (ctx.executed) {
      console.error(`executed count: ${ctx.executed.length}`);
      ctx.executed.forEach((stmt, idx) => {
        console.error(`  [${idx}] ${head(normalizeWhitespace(stmt))}`);
      });
    }
    if (ctx.expected) {
      console.error(`expected count: ${ctx.expected.length}`);
      ctx.expected.forEach((stmt, idx) => {
        console.error(`  [${idx}] ${head(normalizeWhitespace(stmt))}`);
      });
    }
    if (ctx.indexMismatch !== undefined) {
      console.error(`first mismatch at index: ${ctx.indexMismatch}`);
    }
    if (ctx.extra) console.error(`extra:\n${JSON.stringify(ctx.extra, null, 2)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("ensureLibrarySchemaAsync(db, group)", () => {
  for (const group of ALL_LIBRARY_DB_GROUPS) {
    it(`emits the canonical DDL for the "${group}" group`, async () => {
      console.info(`[${SUITE}:async-emit:${group}] running ensureLibrarySchemaAsync`);
      const mock = buildAsyncMockDb();
      await ensureLibrarySchemaAsync(mock.db, group);
      const expected = getGroupDdlStatements(group);
      console.info(
        `[${SUITE}:async-emit:${group}] executed=${mock.executed.length} expected=${expected.length}`,
      );

      try {
        expect(mock.executed.length).toBe(expected.length);
        mock.executed.forEach((stmt, idx) => {
          expect(normalizeWhitespace(stmt)).toBe(normalizeWhitespace(expected[idx]!));
        });
      } catch (err) {
        // Find the first divergence to help triage
        let mismatchIdx = -1;
        for (let i = 0; i < Math.max(mock.executed.length, expected.length); i++) {
          const a = normalizeWhitespace(mock.executed[i] ?? "");
          const e = normalizeWhitespace(expected[i] ?? "");
          if (a !== e) {
            mismatchIdx = i;
            break;
          }
        }
        dumpMigrationSnapshot("async-canonical-ddl-drift", {
          group,
          executed: mock.executed,
          expected,
          indexMismatch: mismatchIdx,
          note: "async migration step does not match canonical group DDL — sync/async drift",
        });
        throw err;
      }
    });
  }

  it("returns a Promise that resolves (not throws)", async () => {
    console.info(`[${SUITE}:resolves] expecting Promise resolution for group=core`);
    const mock = buildAsyncMockDb();
    try {
      await expect(ensureLibrarySchemaAsync(mock.db, "core")).resolves.toBeUndefined();
    } catch (err) {
      dumpMigrationSnapshot("async-did-not-resolve-undefined", {
        group: "core",
        executed: mock.executed,
        note: "ensureLibrarySchemaAsync should resolve to undefined",
      });
      throw err;
    }
  });

  it("rejects if the underlying exec throws", async () => {
    console.info(`[${SUITE}:rejects] injecting failing exec for group=core`);
    const failingDb: AsyncSqliteDb = {
      exec: async () => {
        throw new Error("simulated mobile sqlite error");
      },
    };
    try {
      await expect(ensureLibrarySchemaAsync(failingDb, "core")).rejects.toThrow(
        "simulated mobile sqlite error",
      );
    } catch (err) {
      dumpMigrationSnapshot("async-did-not-propagate-error", {
        group: "core",
        note: "ensureLibrarySchemaAsync must propagate exec rejection",
      });
      throw err;
    }
  });
});

describe("sync/async DDL parity (drift guard)", () => {
  it("async DDL is a prefix of sync DDL for every group (sync may add legacy ALTERs)", async () => {
    for (const group of ALL_LIBRARY_DB_GROUPS) {
      console.info(`[${SUITE}:parity:${group}] computing sync/async DDL pair`);
      const asyncMock = buildAsyncMockDb();
      const syncMock = buildSyncMockDb();
      await ensureLibrarySchemaAsync(asyncMock.db, group);
      ensureLibrarySchema(syncMock.db, group);
      console.info(
        `[${SUITE}:parity:${group}] async=${asyncMock.executed.length} sync=${syncMock.executed.length}`,
      );

      try {
        // Sync emits everything async emits, in the same order, possibly followed
        // by extra ALTER TABLE statements for legacy column migrations.
        asyncMock.executed.forEach((stmt, idx) => {
          expect(normalizeWhitespace(syncMock.executed[idx] ?? ""), `${group}[${idx}]`).toBe(
            normalizeWhitespace(stmt),
          );
        });
        expect(syncMock.executed.length).toBeGreaterThanOrEqual(asyncMock.executed.length);
      } catch (err) {
        dumpMigrationSnapshot("sync-async-prefix-mismatch", {
          group,
          executed: syncMock.executed,
          expected: asyncMock.executed,
          note: "sync prefix must mirror async; suffix may add ALTER/PRAGMA only",
        });
        throw err;
      }
    }
  });

  it("any sync-only suffix on a group is exclusively ALTER TABLE or PRAGMA statements", async () => {
    for (const group of ALL_LIBRARY_DB_GROUPS) {
      const syncMock = buildSyncMockDb();
      ensureLibrarySchema(syncMock.db, group);
      const baseLen = getGroupDdlStatements(group).length;
      const suffix = syncMock.executed.slice(baseLen);
      console.info(
        `[${SUITE}:suffix-shape:${group}] baseLen=${baseLen} suffixLen=${suffix.length}`,
      );
      for (const stmt of suffix) {
        const upper = stmt.trim().toUpperCase();
        try {
          expect(
            upper.startsWith("ALTER TABLE") || upper.startsWith("PRAGMA"),
            `${group} suffix should be legacy ALTER/PRAGMA only, got: ${stmt.slice(0, 80)}`,
          ).toBe(true);
        } catch (err) {
          dumpMigrationSnapshot("suffix-shape-violation", {
            group,
            executed: syncMock.executed,
            extra: { offendingStmt: stmt.slice(0, 200), baseLen, suffixLen: suffix.length },
            note: "sync-only suffix must be legacy ALTER/PRAGMA",
          });
          throw err;
        }
      }
    }
  });
});

describe("getGroupDdlStatements", () => {
  it("returns a non-empty array for each group", () => {
    for (const group of ALL_LIBRARY_DB_GROUPS) {
      const stmts = getGroupDdlStatements(group);
      console.info(`[${SUITE}:non-empty:${group}] stmt-count=${stmts.length}`);
      try {
        expect(stmts.length, `${group} should have base DDL`).toBeGreaterThan(0);
      } catch (err) {
        dumpMigrationSnapshot("empty-group-ddl", {
          group,
          executed: stmts,
          note: "group has no DDL — manifest entry without backing tables?",
        });
        throw err;
      }
    }
  });

  it("every statement is a CREATE TABLE or CREATE INDEX", () => {
    for (const group of ALL_LIBRARY_DB_GROUPS) {
      const stmts = getGroupDdlStatements(group);
      console.info(`[${SUITE}:shape:${group}] checking ${stmts.length} stmts`);
      for (const stmt of stmts) {
        const upper = stmt.trim().toUpperCase();
        try {
          expect(
            upper.startsWith("CREATE TABLE") ||
              upper.startsWith("CREATE UNIQUE INDEX") ||
              upper.startsWith("CREATE INDEX"),
            `${group}: expected CREATE statement, got: ${stmt.slice(0, 80)}`,
          ).toBe(true);
        } catch (err) {
          dumpMigrationSnapshot("non-create-statement", {
            group,
            executed: stmts,
            extra: { offendingStmt: stmt.slice(0, 200) },
            note: "getGroupDdlStatements should only return CREATE TABLE / CREATE INDEX",
          });
          throw err;
        }
      }
    }
  });
});
