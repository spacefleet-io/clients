/**
 * @test-id LIB-DB-RUNTIME-MULTI-SURFACE-UPGRADE-001
 * @level integration (real-engine, bun:sqlite)
 * @bugfix @regression-proof
 *
 * @why End-to-end coverage of the "fresh user installs vN, populates library
 *   on disk, app upgrades to vN+1 with BOTH a new schema migration AND a
 *   bump in declared op-stream support" cold-boot scenario.
 *
 *   The existing tests cover the building blocks independently:
 *     - `migrationRunner.test.ts` proves the runner mechanics in isolation.
 *     - `legacy-snapshot-exists-on-upgrade.test.ts` proves the per-group
 *       split on first boot of the post-Phase-3 build.
 *     - `decode-stored-manifest.test.ts` proves the op-stream gate.
 *     - `desktop-migration-runner.test.ts` proves desktop's wiring against
 *       a single group on a fresh DB.
 *
 *   What was missing: a composed scenario that pins ALL of these together
 *   on a populated DB across an app upgrade. The invariants to pin are:
 *     1. Pre-existing rows (vN snapshot of disk state) survive the upgrade
 *        unchanged for groups where the schema migration didn't touch them.
 *     2. The schema migration runs to completion BEFORE any post-migration
 *        reads against the new shape happen — i.e. `user_version` reflects
 *        the new build's max BEFORE we start applying ops at the new
 *        op-stream version.
 *     3. The build's declared `currentLibrarySupport` reflects BOTH the
 *        bumped op-stream version AND the bumped per-group schema version
 *        once the new migration array is in place.
 *     4. A re-run of the SAME upgrade is a no-op (idempotent) — second
 *        boot doesn't re-apply the migration or change row contents.
 *
 *   Lives in library-db-runtime because the migration runner is bun:sqlite
 *   integration, and because the test exercises real per-group SQLite
 *   files end-to-end the same way `desktop-migration-runner.test.ts` does.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { ensureLibrarySchema } from "@space/library-db-definition/migrations";
import {
  runMigrations,
  type LibraryMigration,
} from "@space/library-db-definition/migrationRunner";
import {
  assertLibraryCompatible,
  currentLibrarySupport,
  LibraryFormatTooNewError,
} from "@space/library-db-definition/compatibility";
import { OP_STREAM_VERSION } from "@space/library-db-definition/ops";
import type { SqliteDb } from "@space/library-db-definition/migrations";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const readUserVersion = (db: Database): number => {
  const row = db.prepare("PRAGMA user_version;").get() as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
};

const seedVnLibrary = (db: Database) => {
  // The vN client wrote two media items with a populated `title` column to disk.
  ensureLibrarySchema(db as unknown as SqliteDb, "core");
  db.prepare(
    `INSERT INTO media_items (id, type, title, added_at, updated_at, has_files, progress_pct)
     VALUES (?, ?, ?, ?, ?, ?, ?);`
  ).run("m1", "movie", "Old Title 1", "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z", 1, 0);
  db.prepare(
    `INSERT INTO media_items (id, type, title, added_at, updated_at, has_files, progress_pct)
     VALUES (?, ?, ?, ?, ?, ?, ?);`
  ).run("m2", "show", "Old Title 2", "2025-01-02T00:00:00.000Z", "2025-01-02T00:00:00.000Z", 0, 0);
  console.info(`[multi-surface-upgrade-cold-boot:seed] inserted 2 vN media_items`);
};

// Suite-id: multi-surface-upgrade-cold-boot
// Captures the three independently-versioned surfaces (sqlite user_version,
// op-stream, storage), the migration runner result, and any cold-boot row
// snapshot. The whole point of this suite is "did each surface end up at the
// right version" — surface this map prominently.
const dumpUpgradeSnapshot = (
  label: string,
  ctx: {
    db?: Database;
    runnerResult?: { from: number; to: number; applied: number[] };
    capturedError?: unknown;
    extraNotes?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [multi-surface-upgrade-cold-boot:${label}] snapshot ===`);
    if (ctx.db) {
      const userVersion = readUserVersion(ctx.db);
      console.error(`sqlite user_version=${userVersion}`);
      // Probe the released media_items shape — column existence + row contents
      // is what every test asserts on.
      try {
        const rows = ctx.db
          .prepare("SELECT id, title FROM media_items ORDER BY id;")
          .all();
        console.error(`media_items rows=${JSON.stringify(rows)}`);
      } catch (e) {
        console.error(`media_items title-shape probe failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      try {
        const rows = ctx.db
          .prepare("SELECT id, title, release_status FROM media_items ORDER BY id;")
          .all();
        console.error(`media_items rows (with release_status)=${JSON.stringify(rows)}`);
      } catch (e) {
        console.error(
          `media_items release_status-shape probe failed (column may not exist yet): ` +
            `${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    console.error(`build OP_STREAM_VERSION=${OP_STREAM_VERSION}`);
    if (ctx.runnerResult) {
      console.error(`runMigrations result=${JSON.stringify(ctx.runnerResult)}`);
    }
    if (ctx.extraNotes) {
      console.error(`extraNotes=${JSON.stringify(ctx.extraNotes, null, 2)}`);
    }
    if (ctx.capturedError !== undefined) {
      const e = ctx.capturedError;
      console.error(`captured error=${e instanceof Error ? e.message : String(e)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

// A vN+1-style migration: add a column + backfill a default value. This is
// the canonical "schema bump" shape: feature-detection cannot express
// "every NULL becomes 'unknown'" — so it lives in the registry.
const buildVnPlus1CoreMigration = (): ReadonlyArray<LibraryMigration<SqliteDb>> => [
  {
    version: 1,
    description: "add_release_status_with_backfill_unknown",
    up: (handle) => {
      // Add the new column (nullable) — idempotent via try/catch.
      try {
        handle.exec(`ALTER TABLE media_items ADD COLUMN release_status TEXT;`);
      } catch {
        // Column already exists.
      }
      // Backfill: every existing row gets 'unknown'. This is the data step a
      // CREATE-IF-NOT-EXISTS cannot express.
      handle.exec(
        `UPDATE media_items SET release_status = 'unknown' WHERE release_status IS NULL;`
      );
    },
  },
];

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe("multi-surface-upgrade cold-boot scenario", () => {
  it("vN seed populates two rows at user_version=0 (pre-migration baseline)", () => {
    const db = new Database(":memory:");
    try {
      console.info(`[multi-surface-upgrade-cold-boot:vN-baseline] start`);
      seedVnLibrary(db);
      try {
        expect(readUserVersion(db)).toBe(0);
        const rows = db.prepare("SELECT id, title FROM media_items ORDER BY id;").all() as Array<{
          id: string;
          title: string;
        }>;
        console.info(
          `[multi-surface-upgrade-cold-boot:vN-baseline] user_version=${readUserVersion(db)} rows=${JSON.stringify(rows)}`,
        );
        expect(rows).toEqual([
          { id: "m1", title: "Old Title 1" },
          { id: "m2", title: "Old Title 2" },
        ]);
      } catch (err) {
        dumpUpgradeSnapshot("vN-baseline-failure", { db, capturedError: err });
        throw err;
      }
    } finally {
      db.close();
    }
  });

  it("vN+1 cold boot: schema migration runs, user_version bumps to 1, every pre-existing row gets the backfill", () => {
    const db = new Database(":memory:");
    try {
      console.info(`[multi-surface-upgrade-cold-boot:vN+1-coldboot] seedVnLibrary`);
      seedVnLibrary(db);
      // vN+1 cold boot equivalent: re-run ensureLibrarySchema (idempotent)
      // then drive the runner against the new registry.
      ensureLibrarySchema(db as unknown as SqliteDb, "core");
      const migrations = buildVnPlus1CoreMigration();
      console.info(
        `[multi-surface-upgrade-cold-boot:vN+1-coldboot] runMigrations registry-len=${migrations.length}`,
      );
      const result = runMigrations(db as unknown as SqliteDb, "core", migrations);
      console.info(
        `[multi-surface-upgrade-cold-boot:vN+1-coldboot] result=${JSON.stringify(result)} user_version=${readUserVersion(db)}`,
      );

      try {
        // Migration ran: user_version moved 0 → 1, applied = [1].
        expect(result).toEqual({ from: 0, to: 1, applied: [1] });
        expect(readUserVersion(db)).toBe(1);

        // Both pre-existing rows survive AND have the backfilled value.
        const rows = db
          .prepare("SELECT id, title, release_status FROM media_items ORDER BY id;")
          .all() as Array<{ id: string; title: string; release_status: string }>;
        console.info(
          `[multi-surface-upgrade-cold-boot:vN+1-coldboot] post-migration rows=${JSON.stringify(rows)}`,
        );
        expect(rows).toEqual([
          { id: "m1", title: "Old Title 1", release_status: "unknown" },
          { id: "m2", title: "Old Title 2", release_status: "unknown" },
        ]);
      } catch (err) {
        dumpUpgradeSnapshot("vN+1-coldboot-failure", {
          db,
          runnerResult: result,
          capturedError: err,
        });
        throw err;
      }
    } finally {
      db.close();
    }
  });

  it("vN+1 cold boot: build's declared support reflects the bumped schema version (folding through currentLibrarySupport)", () => {
    // Once the new migration is in the registry, `currentLibrarySupport` must
    // fold the new max version into `groupSchemaVersions.core`. This is what
    // the API's release-status feed would consume to compute minClientVersion.
    const support = currentLibrarySupport({
      core: buildVnPlus1CoreMigration(),
    });
    console.info(
      `[multi-surface-upgrade-cold-boot:declared-support] groupSchemaVersions=${JSON.stringify(support.groupSchemaVersions)} ` +
        `opStreamVersion=${support.opStreamVersion} storageFormatVersion=${support.storageFormatVersion}`,
    );
    try {
      expect(support.groupSchemaVersions.core).toBe(1);
      expect(support.opStreamVersion).toBe(OP_STREAM_VERSION);
    } catch (err) {
      dumpUpgradeSnapshot("declared-support-failure", {
        capturedError: err,
        extraNotes: { support },
      });
      throw err;
    }
  });

  it("vN+1 cold boot: declared support is internally compatible with itself (round-trip via assertLibraryCompatible)", () => {
    // After the schema migration completes, the build's view of "observed"
    // should pass through `assertLibraryCompatible` against its own declared
    // support — no LibraryFormatTooNewError. This pins the invariant that a
    // vN+1 client never refuses its own data after upgrading.
    const support = currentLibrarySupport({
      core: buildVnPlus1CoreMigration(),
    });
    console.info(
      `[multi-surface-upgrade-cold-boot:self-compat] round-tripping support through assertLibraryCompatible`,
    );
    try {
      expect(() =>
        assertLibraryCompatible(
          {
            storageFormatVersion: support.storageFormatVersion,
            opStreamVersion: support.opStreamVersion,
            groupSchemaVersions: { core: 1 },
          },
          support
        )
      ).not.toThrow();
    } catch (err) {
      dumpUpgradeSnapshot("self-compat-failure", {
        capturedError: err,
        extraNotes: { support },
      });
      throw err;
    }
  });

  it("vN+1 cold boot: a second boot is a no-op (idempotent — migration does not re-run)", () => {
    const db = new Database(":memory:");
    let second: { from: number; to: number; applied: number[] } | undefined;
    try {
      seedVnLibrary(db);
      const migrations = buildVnPlus1CoreMigration();
      // First "boot" of vN+1.
      ensureLibrarySchema(db as unknown as SqliteDb, "core");
      const first = runMigrations(db as unknown as SqliteDb, "core", migrations);
      console.info(
        `[multi-surface-upgrade-cold-boot:idempotent] first-boot result=${JSON.stringify(first)}`,
      );
      // Mutate the row to prove the second run doesn't overwrite it with the
      // backfill default.
      db.prepare("UPDATE media_items SET release_status = 'released' WHERE id = 'm1';").run();
      console.info(`[multi-surface-upgrade-cold-boot:idempotent] mutated m1.release_status='released'`);

      // Second "boot" of the same vN+1 build.
      ensureLibrarySchema(db as unknown as SqliteDb, "core");
      second = runMigrations(db as unknown as SqliteDb, "core", migrations);
      console.info(
        `[multi-surface-upgrade-cold-boot:idempotent] second-boot result=${JSON.stringify(second)} user_version=${readUserVersion(db)}`,
      );

      try {
        // No migrations applied; user_version unchanged.
        expect(second).toEqual({ from: 1, to: 1, applied: [] });
        expect(readUserVersion(db)).toBe(1);

        // m1 still has the user-set 'released'; m2 still has the original
        // backfill 'unknown'. The migration did NOT re-run.
        const rows = db
          .prepare("SELECT id, release_status FROM media_items ORDER BY id;")
          .all() as Array<{ id: string; release_status: string }>;
        console.info(
          `[multi-surface-upgrade-cold-boot:idempotent] post-second-boot rows=${JSON.stringify(rows)}`,
        );
        expect(rows).toEqual([
          { id: "m1", release_status: "released" },
          { id: "m2", release_status: "unknown" },
        ]);
      } catch (err) {
        dumpUpgradeSnapshot("idempotent-failure", {
          db,
          runnerResult: second,
          capturedError: err,
        });
        throw err;
      }
    } finally {
      db.close();
    }
  });

  it("vN client refuses a vN+1-formatted DB: user_version=1 + empty registry throws LibraryFormatTooNewError (schema surface)", () => {
    // The opposite direction: a vN+1 client wrote user_version=1, vN client
    // (empty registry) opens it. The downgrade-block in the runner produces
    // the typed error.
    const db = new Database(":memory:");
    let caught: LibraryFormatTooNewError | undefined;
    try {
      seedVnLibrary(db);
      // Simulate a vN+1 client having migrated this file.
      db.exec("PRAGMA user_version = 1;");
      console.info(
        `[multi-surface-upgrade-cold-boot:vN-refuses-vN+1] simulated user_version=1, vN client opens empty registry`,
      );

      // vN client boots: empty registry, but user_version=1.
      try {
        runMigrations(db as unknown as SqliteDb, "core", []);
      } catch (e) {
        caught = e as LibraryFormatTooNewError;
      }
      console.info(
        `[multi-surface-upgrade-cold-boot:vN-refuses-vN+1] caught.ctor=${caught?.constructor?.name} ` +
          `surface=${caught?.surface} observed=${caught?.observed} supported=${caught?.supported} group=${caught?.group}`,
      );

      try {
        expect(caught).toBeInstanceOf(LibraryFormatTooNewError);
        expect(caught!.surface).toBe("schema");
        expect(caught!.observed).toBe(1);
        expect(caught!.supported).toBe(0);
        expect(caught!.group).toBe("core");
        // user_version is unchanged — the runner threw before touching it.
        expect(readUserVersion(db)).toBe(1);
      } catch (err) {
        dumpUpgradeSnapshot("vN-refuses-vN+1-failure", {
          db,
          capturedError: err,
          extraNotes: {
            caught: caught
              ? {
                  ctor: caught.constructor?.name,
                  surface: caught.surface,
                  observed: caught.observed,
                  supported: caught.supported,
                  group: caught.group,
                }
              : null,
          },
        });
        throw err;
      }
    } finally {
      db.close();
    }
  });

  it("vN+1 cold boot: schema migration runs FIRST, then later op-stream-version-aware sync can proceed at the new max", () => {
    // Composed ordering invariant: the schema migration must complete
    // BEFORE any code path that depends on the new shape runs. We pin this
    // by checking that AFTER `runMigrations`, the new column is present and
    // any subsequent operation that depends on it (e.g. a SELECT against
    // `release_status`) does not throw.
    const db = new Database(":memory:");
    try {
      seedVnLibrary(db);
      ensureLibrarySchema(db as unknown as SqliteDb, "core");
      const migrations = buildVnPlus1CoreMigration();
      const runnerResult = runMigrations(db as unknown as SqliteDb, "core", migrations);
      console.info(
        `[multi-surface-upgrade-cold-boot:ordering] migrations applied=${JSON.stringify(runnerResult)}`,
      );

      try {
        // Post-migration: a SELECT against the new column must work (no
        // "no such column" error).
        expect(() => {
          db.prepare("SELECT release_status FROM media_items;").all();
        }).not.toThrow();

        // And the build's "what op-stream version do we declare" question can
        // be answered safely now, AFTER schema is at the right version. The
        // declared opStreamVersion is the build's `OP_STREAM_VERSION` —
        // unchanged from the constant, because the constant IS the build's
        // declaration.
        const support = currentLibrarySupport({
          core: migrations,
        });
        console.info(
          `[multi-surface-upgrade-cold-boot:ordering] support.opStreamVersion=${support.opStreamVersion} ` +
            `support.groupSchemaVersions.core=${support.groupSchemaVersions.core}`,
        );
        expect(support.opStreamVersion).toBe(OP_STREAM_VERSION);
        expect(support.groupSchemaVersions.core).toBe(1);
      } catch (err) {
        dumpUpgradeSnapshot("ordering-failure", {
          db,
          runnerResult,
          capturedError: err,
        });
        throw err;
      }
    } finally {
      db.close();
    }
  });
});
