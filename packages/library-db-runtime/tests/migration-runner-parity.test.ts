/**
 * @test-id LIB-DB-MIGRATION-RUNNER-PARITY-001
 * @level integration (real-engine, bun:sqlite)
 *
 * Phase 7.4 of the library-db unification: pin that the sync and async
 * runners stay byte-for-byte equivalent. Drives the SAME migration sequence
 * through both code paths against a real bun:sqlite handle and asserts the
 * final `user_version` matches AND the side-effect rows match exactly.
 *
 * If a future tweak to one runner forks the version-bump semantics or the
 * skip-pending logic, this test fails before the drift reaches production.
 *
 * Lives in library-db-runtime (bun:test) rather than library-db-definition
 * (vitest, node env) because vitest can't import `bun:sqlite`. The runners
 * under test are imported from @space/library-db-definition.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import {
  type AsyncLibraryMigration,
  type AsyncSqliteRunnerDb,
  type LibraryMigration,
  runMigrations,
  runMigrationsAsync,
} from "@space/library-db-definition/migrationRunner";
import type { SqliteDb } from "@space/library-db-definition/migrations";

type ParitySpec = {
  version: number;
  description: string;
  apply: (db: Database) => void;
};

const paritySpecs: ReadonlyArray<ParitySpec> = [
  {
    version: 1,
    description: "create_probe",
    apply: (db) => {
      db.exec(
        "CREATE TABLE IF NOT EXISTS probe (id INTEGER PRIMARY KEY, label TEXT NOT NULL);"
      );
      db.prepare("INSERT INTO probe (id, label) VALUES (?, ?);").run(1, "v1_insert");
    },
  },
  {
    version: 2,
    description: "second_row",
    apply: (db) => {
      db.prepare("INSERT INTO probe (id, label) VALUES (?, ?);").run(2, "v2_insert");
    },
  },
  {
    version: 3,
    description: "update_row",
    apply: (db) => {
      db.prepare("UPDATE probe SET label = ? WHERE id = ?;").run("v3_updated", 1);
    },
  },
];

const buildSyncMigrations = (): ReadonlyArray<LibraryMigration<SqliteDb>> =>
  paritySpecs.map<LibraryMigration<SqliteDb>>((spec) => ({
    version: spec.version,
    description: spec.description,
    up: (handle) => {
      spec.apply(handle as unknown as Database);
    },
  }));

const buildAsyncMigrations = (): ReadonlyArray<AsyncLibraryMigration<AsyncBunAdapter>> =>
  paritySpecs.map<AsyncLibraryMigration<AsyncBunAdapter>>((spec) => ({
    version: spec.version,
    description: spec.description,
    up: async (handle) => {
      spec.apply(handle.__db);
    },
  }));

// Thin async adapter over bun:sqlite — mirrors what mobile does over
// react-native-sqlite-storage (sans the RN-specific shape).
type AsyncBunAdapter = AsyncSqliteRunnerDb & { __db: Database };

const asAsyncAdapter = (db: Database): AsyncBunAdapter => ({
  __db: db,
  exec: async (sql) => {
    db.exec(sql);
  },
  query: async (sql) => {
    return db.prepare(sql).all() as ReadonlyArray<Record<string, unknown>>;
  },
});

const readUserVersion = (db: Database): number => {
  try {
    const row = db.prepare("PRAGMA user_version;").get() as { user_version?: number } | undefined;
    return Number(row?.user_version ?? 0);
  } catch {
    return -1;
  }
};

const probeContents = (db: Database): ReadonlyArray<{ id: number; label: string }> => {
  try {
    return db.prepare("SELECT id, label FROM probe ORDER BY id ASC;").all() as Array<{
      id: number;
      label: string;
    }>;
  } catch {
    return [];
  }
};

// Suite-id: migration-runner-parity
// Dumps the migration step outputs for both runners side-by-side so any
// drift is obvious — user_version + probe-table contents are the canonical
// parity signals.
const dumpParitySnapshot = (
  label: string,
  ctx: {
    syncDb?: Database;
    asyncDb?: Database;
    syncResult?: unknown;
    asyncResult?: unknown;
    specsCount?: number;
  },
) => {
  try {
    console.error(`=== [migration-runner-parity:${label}] snapshot ===`);
    if (ctx.specsCount !== undefined) console.error(`paritySpecs.length=${ctx.specsCount}`);

    const comparison = {
      syncDb: ctx.syncDb
        ? {
            user_version: readUserVersion(ctx.syncDb),
            probe: probeContents(ctx.syncDb),
          }
        : "(no syncDb)",
      asyncDb: ctx.asyncDb
        ? {
            user_version: readUserVersion(ctx.asyncDb),
            probe: probeContents(ctx.asyncDb),
          }
        : "(no asyncDb)",
    };
    console.error(`parity comparison:\n${JSON.stringify(comparison, null, 2)}`);

    if (ctx.syncResult !== undefined) {
      console.error(`syncResult=${JSON.stringify(ctx.syncResult)}`);
    }
    if (ctx.asyncResult !== undefined) {
      console.error(`asyncResult=${JSON.stringify(ctx.asyncResult)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("migration runner parity (sync ↔ async)", () => {
  it("both runners reach the same final user_version on a fresh DB", async () => {
    console.info(`[migration-runner-parity:final-version] fresh DBs, ${paritySpecs.length} specs`);
    const syncDb = new Database(":memory:");
    const asyncDb = new Database(":memory:");
    try {
      runMigrations(syncDb as unknown as SqliteDb, "parity", buildSyncMigrations());
      await runMigrationsAsync(asAsyncAdapter(asyncDb), "parity", buildAsyncMigrations());

      const syncVer = readUserVersion(syncDb);
      const asyncVer = readUserVersion(asyncDb);
      console.info(
        `[migration-runner-parity:final-version] sync.user_version=${syncVer} async.user_version=${asyncVer}`,
      );
      try {
        expect(syncVer).toBe(3);
        expect(asyncVer).toBe(3);
        expect(syncVer).toBe(asyncVer);
      } catch (err) {
        console.error(`[migration-runner-parity:final-version] assertion failed`);
        dumpParitySnapshot("final-version-failure", {
          syncDb,
          asyncDb,
          specsCount: paritySpecs.length,
        });
        throw err;
      }
    } finally {
      syncDb.close();
      asyncDb.close();
    }
  });

  it("both runners produce identical probe-table side effects", async () => {
    console.info(`[migration-runner-parity:side-effects] fresh DBs, ${paritySpecs.length} specs`);
    const syncDb = new Database(":memory:");
    const asyncDb = new Database(":memory:");
    try {
      runMigrations(syncDb as unknown as SqliteDb, "parity", buildSyncMigrations());
      await runMigrationsAsync(asAsyncAdapter(asyncDb), "parity", buildAsyncMigrations());

      const syncRows = probeContents(syncDb);
      const asyncRows = probeContents(asyncDb);
      console.info(
        `[migration-runner-parity:side-effects] sync probe=${JSON.stringify(syncRows)} async probe=${JSON.stringify(asyncRows)}`,
      );
      try {
        expect(syncRows).toEqual([
          { id: 1, label: "v3_updated" },
          { id: 2, label: "v2_insert" },
        ]);
        expect(asyncRows).toEqual(syncRows);
      } catch (err) {
        console.error(`[migration-runner-parity:side-effects] assertion failed`);
        dumpParitySnapshot("side-effects-failure", {
          syncDb,
          asyncDb,
          specsCount: paritySpecs.length,
        });
        throw err;
      }
    } finally {
      syncDb.close();
      asyncDb.close();
    }
  });

  it("both runners skip-at-current-version identically when partial state exists", async () => {
    console.info(`[migration-runner-parity:partial] pre-applying v1 + setting user_version=1`);
    const syncDb = new Database(":memory:");
    const asyncDb = new Database(":memory:");
    try {
      // Pre-apply v1 manually + bump user_version to 1; the runners should
      // then ONLY apply v2 and v3 forward.
      for (const db of [syncDb, asyncDb]) {
        paritySpecs[0]!.apply(db);
        db.exec("PRAGMA user_version = 1;");
      }
      console.info(
        `[migration-runner-parity:partial] pre-run sync.user_version=${readUserVersion(syncDb)} async.user_version=${readUserVersion(asyncDb)}`,
      );

      const syncResult = runMigrations(
        syncDb as unknown as SqliteDb,
        "parity",
        buildSyncMigrations()
      );
      const asyncResult = await runMigrationsAsync(
        asAsyncAdapter(asyncDb),
        "parity",
        buildAsyncMigrations()
      );
      console.info(
        `[migration-runner-parity:partial] sync.applied=${JSON.stringify(syncResult.applied)} async.applied=${JSON.stringify(asyncResult.applied)}`,
      );

      try {
        expect(syncResult.applied).toEqual([2, 3]);
        expect(asyncResult.applied).toEqual([2, 3]);
        expect(syncResult.applied).toEqual(asyncResult.applied);
        expect(readUserVersion(syncDb)).toBe(readUserVersion(asyncDb));
        expect(probeContents(syncDb)).toEqual(probeContents(asyncDb));
      } catch (err) {
        console.error(`[migration-runner-parity:partial] assertion failed`);
        dumpParitySnapshot("partial-failure", {
          syncDb,
          asyncDb,
          syncResult,
          asyncResult,
          specsCount: paritySpecs.length,
        });
        throw err;
      }
    } finally {
      syncDb.close();
      asyncDb.close();
    }
  });

  it("both runners are idempotent when rerun with the same migration array", async () => {
    console.info(`[migration-runner-parity:idempotent] first run`);
    const syncDb = new Database(":memory:");
    const asyncDb = new Database(":memory:");
    try {
      runMigrations(syncDb as unknown as SqliteDb, "parity", buildSyncMigrations());
      await runMigrationsAsync(asAsyncAdapter(asyncDb), "parity", buildAsyncMigrations());
      const firstSync = probeContents(syncDb);
      const firstAsync = probeContents(asyncDb);
      console.info(
        `[migration-runner-parity:idempotent] after first run sync=${JSON.stringify(firstSync)} async=${JSON.stringify(firstAsync)}`,
      );

      console.info(`[migration-runner-parity:idempotent] second run (should no-op)`);
      const syncResult = runMigrations(
        syncDb as unknown as SqliteDb,
        "parity",
        buildSyncMigrations()
      );
      const asyncResult = await runMigrationsAsync(
        asAsyncAdapter(asyncDb),
        "parity",
        buildAsyncMigrations()
      );
      console.info(
        `[migration-runner-parity:idempotent] second-run sync.applied=${JSON.stringify(syncResult.applied)} async.applied=${JSON.stringify(asyncResult.applied)}`,
      );

      try {
        expect(syncResult.applied).toEqual([]);
        expect(asyncResult.applied).toEqual([]);
        expect(probeContents(syncDb)).toEqual(firstSync);
        expect(probeContents(asyncDb)).toEqual(firstAsync);
      } catch (err) {
        console.error(`[migration-runner-parity:idempotent] assertion failed`);
        dumpParitySnapshot("idempotent-failure", {
          syncDb,
          asyncDb,
          syncResult,
          asyncResult,
          specsCount: paritySpecs.length,
        });
        throw err;
      }
    } finally {
      syncDb.close();
      asyncDb.close();
    }
  });
});
