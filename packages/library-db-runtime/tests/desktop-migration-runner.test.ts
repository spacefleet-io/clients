/**
 * @test-id LIB-DB-RUNTIME-DESKTOP-MIGRATIONS-001
 * @level integration (real-engine, bun:sqlite)
 *
 * Phase 7.3 of the library-db unification (plan: when-we-change-how-happy-otter.md).
 *
 * Asserts the desktop-side wiring of the shared `runMigrations` against real
 * bun:sqlite Databases:
 *   1. Baseline: `ensureLibrarySchema(db, group)` followed by `runMigrations`
 *      with the empty desktopCoreMigrations array leaves `user_version=0`
 *      (no migrations to apply).
 *   2. Forward: a hand-rolled v2 migration applied via `runMigrations` bumps
 *      `user_version` to 2 AND its side effect lands on the target table.
 *   3. Idempotent: a second call with the same migration array is a no-op
 *      (user_version stays at 2, side-effect not duplicated).
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ensureLibrarySchema } from "@space/library-db-definition/migrations";
import {
  runMigrations,
  type LibraryMigration,
} from "@space/library-db-definition/migrationRunner";
import type { SqliteDb } from "@space/library-db-definition/migrations";
import {
  desktopCoreMigrations,
  desktopIngestMigrations,
  desktopMetadataMigrations,
  desktopPlaybackMigrations,
  desktopTemplatesMigrations,
} from "../src/desktopMigrations";

const readUserVersion = (db: Database): number => {
  const row = db.prepare("PRAGMA user_version;").get() as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
};

// Suite-id: desktop-migration-runner
// Dump the desktop-side migration registry state, the current user_version,
// and a probe of tables present in the open handle.
const dumpMigrationSnapshot = (
  label: string,
  ctx: {
    db?: Database;
    group?: string;
    pendingMigrations?: ReadonlyArray<LibraryMigration<SqliteDb>>;
    result?: unknown;
    markerRows?: unknown;
  },
) => {
  try {
    console.error(`=== [desktop-migration-runner:${label}] snapshot ===`);
    if (ctx.group) console.error(`group=${ctx.group}`);
    if (ctx.db) {
      console.error(`user_version=${readUserVersion(ctx.db)}`);
      const tables = ctx.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table';")
        .all() as Array<{ name?: string }>;
      console.error(`tables (${tables.length})=${JSON.stringify(tables.map((t) => t.name))}`);
    }
    console.error(`desktop migration registry sizes:`);
    console.error(`  core=${desktopCoreMigrations.length}`);
    console.error(`  metadata=${desktopMetadataMigrations.length}`);
    console.error(`  playback=${desktopPlaybackMigrations.length}`);
    console.error(`  ingest=${desktopIngestMigrations.length}`);
    console.error(`  templates=${desktopTemplatesMigrations.length}`);
    if (ctx.pendingMigrations) {
      console.error(
        `pending migrations (${ctx.pendingMigrations.length})=${JSON.stringify(
          ctx.pendingMigrations.map((m) => ({ version: m.version, description: m.description })),
        )}`,
      );
    }
    if (ctx.result !== undefined) {
      console.error(`runMigrations result=${JSON.stringify(ctx.result)}`);
    }
    if (ctx.markerRows !== undefined) {
      console.error(`marker rows=${JSON.stringify(ctx.markerRows)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  console.info(`[desktop-migration-runner:setup] fresh :memory: handle`);
});

afterEach(() => {
  console.info(
    `[desktop-migration-runner:teardown] closing handle (final user_version=${readUserVersion(db)})`,
  );
  db.close();
});

describe("Phase 7.3 — desktop wires shared runMigrations per group", () => {
  it("baseline: ensureLibrarySchema leaves user_version=0, then the core registry applies v1 once", () => {
    console.info(`[desktop-migration-runner:baseline] ensureLibrarySchema(core)`);
    ensureLibrarySchema(db as unknown as SqliteDb, "core");
    const startVer = readUserVersion(db);
    console.info(`[desktop-migration-runner:baseline] post-ensure user_version=${startVer}`);

    try {
      expect(startVer).toBe(0);

      console.info(
        `[desktop-migration-runner:baseline] runMigrations(core, desktopCoreMigrations) ` +
          `pending=${desktopCoreMigrations.length}`,
      );
      const result = runMigrations(db as unknown as SqliteDb, "core", desktopCoreMigrations);
      console.info(
        `[desktop-migration-runner:baseline] result=${JSON.stringify(result)} ` +
          `final user_version=${readUserVersion(db)}`,
      );
      expect(result).toEqual({ from: 0, to: 1, applied: [1] });
      expect(readUserVersion(db)).toBe(1);
    } catch (err) {
      console.error(`[desktop-migration-runner:baseline] assertion failed`);
      dumpMigrationSnapshot("baseline-failure", {
        db,
        group: "core",
        pendingMigrations: desktopCoreMigrations,
      });
      throw err;
    }
  });

  it("pins the desktop registries: core v1, metadata v1 (media_crew) + v2 (media_editions) and playback v1, the rest at baseline", () => {
    console.info(`[desktop-migration-runner:registry] pinning registry versions`);
    try {
      // New entries land here when an index change / column drop / data backfill is added.
      expect(desktopCoreMigrations.map((m) => m.version)).toEqual([1]);
      expect(desktopPlaybackMigrations.map((m) => m.version)).toEqual([1]);
      expect(desktopMetadataMigrations.map((m) => m.version)).toEqual([1, 2, 3]);
      expect(desktopIngestMigrations.length).toBe(0);
      expect(desktopTemplatesMigrations.length).toBe(0);
    } catch (err) {
      console.error(`[desktop-migration-runner:registry] unexpected registry content`);
      dumpMigrationSnapshot("registry-failure", { db });
      throw err;
    }
  });

  it("a fake v2 migration bumps user_version AND lands its side effect", () => {
    console.info(`[desktop-migration-runner:forward] ensureLibrarySchema(playback)`);
    ensureLibrarySchema(db as unknown as SqliteDb, "playback");

    // Hand-rolled migration: drop one column from media_subtitles via
    // table-rebuild (the canonical SQLite pattern for column removal). Use a
    // tiny stub side-effect instead — write a marker row to app_settings on
    // a fresh table we create in the migration itself.
    const fakeMigrations: ReadonlyArray<LibraryMigration<SqliteDb>> = [
      {
        version: 1,
        description: "fake_v1_marker_table",
        up: (handle) => {
          handle.exec(
            "CREATE TABLE IF NOT EXISTS _phase7_marker (id INTEGER PRIMARY KEY, note TEXT NOT NULL);"
          );
        },
      },
      {
        version: 2,
        description: "fake_v2_marker_row",
        up: (handle) => {
          handle.prepare("INSERT INTO _phase7_marker (id, note) VALUES (?, ?);").run(
            1,
            "v2_applied"
          );
        },
      },
    ];

    console.info(
      `[desktop-migration-runner:forward] runMigrations(playback) pending=${fakeMigrations.length}`,
    );
    let result: ReturnType<typeof runMigrations> | null = null;
    try {
      result = runMigrations(db as unknown as SqliteDb, "playback", fakeMigrations);
      console.info(
        `[desktop-migration-runner:forward] result=${JSON.stringify(result)} ` +
          `final user_version=${readUserVersion(db)}`,
      );
      expect(result).toEqual({ from: 0, to: 2, applied: [1, 2] });
      expect(readUserVersion(db)).toBe(2);

      const row = db.prepare("SELECT note FROM _phase7_marker WHERE id = 1;").get() as
        | { note?: string }
        | undefined;
      console.info(`[desktop-migration-runner:forward] marker row=${JSON.stringify(row)}`);
      expect(row?.note).toBe("v2_applied");
    } catch (err) {
      console.error(`[desktop-migration-runner:forward] assertion failed`);
      const markerRows = (() => {
        try {
          return db.prepare("SELECT id, note FROM _phase7_marker;").all();
        } catch (e) {
          return `(marker table query failed: ${e instanceof Error ? e.message : String(e)})`;
        }
      })();
      dumpMigrationSnapshot("forward-failure", {
        db,
        group: "playback",
        pendingMigrations: fakeMigrations,
        result,
        markerRows,
      });
      throw err;
    }
  });

  it("rerunning with the same migration array is a no-op (idempotent)", () => {
    console.info(`[desktop-migration-runner:idempotent] ensureLibrarySchema(playback)`);
    ensureLibrarySchema(db as unknown as SqliteDb, "playback");

    const fakeMigrations: ReadonlyArray<LibraryMigration<SqliteDb>> = [
      {
        version: 1,
        description: "fake_v1_table",
        up: (handle) => {
          handle.exec(
            "CREATE TABLE IF NOT EXISTS _phase7_counter (n INTEGER NOT NULL);"
          );
          handle.prepare("INSERT INTO _phase7_counter (n) VALUES (?);").run(1);
        },
      },
    ];

    let firstResult: ReturnType<typeof runMigrations> | null = null;
    let secondResult: ReturnType<typeof runMigrations> | null = null;
    try {
      firstResult = runMigrations(db as unknown as SqliteDb, "playback", fakeMigrations);
      console.info(
        `[desktop-migration-runner:idempotent] first result=${JSON.stringify(firstResult)} ` +
          `user_version=${readUserVersion(db)}`,
      );
      expect(readUserVersion(db)).toBe(1);
      const firstCount = (db.prepare("SELECT COUNT(*) AS n FROM _phase7_counter;").get() as { n?: number }).n;
      console.info(`[desktop-migration-runner:idempotent] first count=${firstCount}`);
      expect(firstCount).toBe(1);

      // Second run is a no-op — no new rows inserted, user_version unchanged.
      secondResult = runMigrations(db as unknown as SqliteDb, "playback", fakeMigrations);
      console.info(
        `[desktop-migration-runner:idempotent] second result=${JSON.stringify(secondResult)} ` +
          `user_version=${readUserVersion(db)}`,
      );
      expect(secondResult.applied).toEqual([]);
      expect(readUserVersion(db)).toBe(1);
      const secondCount = (db.prepare("SELECT COUNT(*) AS n FROM _phase7_counter;").get() as { n?: number }).n;
      console.info(`[desktop-migration-runner:idempotent] second count=${secondCount}`);
      expect(secondCount).toBe(1);
    } catch (err) {
      console.error(`[desktop-migration-runner:idempotent] assertion failed`);
      dumpMigrationSnapshot("idempotent-failure", {
        db,
        group: "playback",
        pendingMigrations: fakeMigrations,
        result: { first: firstResult, second: secondResult },
      });
      throw err;
    }
  });
});
