/**
 * @test-id LIB-SPLIT-MIGRATION-001
 * @level unit (real-engine, bun:sqlite)
 *
 * Direct coverage for `splitGroupFromLegacy` — the one-time Phase-3 helper that
 * copies a group's tables out of the legacy single-file DB into a per-group
 * SQLite file. Before this suite the function was only exercised through the
 * `LibraryDb` constructor (legacy-snapshot-exists-on-upgrade.test.ts), which
 * left the dropFromLegacy=false branch, idempotency marker semantics, fresh-
 * install paths, and partial-failure recovery without dedicated assertions.
 */
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { ensureLibrarySchema } from "@space/library-db-definition/migrations";
import { splitGroupFromLegacy } from "../src/librarySplitMigration";
import type { SqliteDatabase } from "../src/db";

const open = (): SqliteDatabase => new Database(":memory:") as unknown as SqliteDatabase;

const seedLegacyAcrossGroups = (legacy: SqliteDatabase) => {
  // Use the legacy single-arg signature to create every group's tables in one file.
  ensureLibrarySchema(legacy);

  legacy
    .prepare(
      `INSERT INTO media_items (id, type, title, added_at, updated_at, has_files, progress_pct)
       VALUES (?, ?, ?, ?, ?, ?, ?);`
    )
    .run("m1", "movie", "Movie One", "t0", "t0", 0, 0);
  legacy
    .prepare(
      `INSERT INTO media_items (id, type, title, added_at, updated_at, has_files, progress_pct)
       VALUES (?, ?, ?, ?, ?, ?, ?);`
    )
    .run("m2", "tv", "Show Two", "t0", "t0", 0, 0);

  legacy
    .prepare(
      `INSERT INTO media_files (id, media_id, filename, added_at, status)
       VALUES (?, ?, ?, ?, ?);`
    )
    .run("f1", "m1", "m1.mkv", "t0", "local");
  legacy
    .prepare(
      `INSERT INTO media_files (id, media_id, filename, added_at, status)
       VALUES (?, ?, ?, ?, ?);`
    )
    .run("f2", "m2", "m2.mkv", "t0", "local");

  legacy
    .prepare(
      `INSERT INTO media_formats (id, media_id, file_id, quality, codec, size_mb)
       VALUES (?, ?, ?, ?, ?, ?);`
    )
    .run("fmt1", "m1", "f1", "1080p", "h264", 1500);

  legacy
    .prepare(
      `INSERT INTO ingest_jobs (id, media_id, worker_peer_id, kind, status, progress_pct, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?);`
    )
    .run("job1", "m1", "peer-A", "convert", "queued", 0, "t0", "t0");

  legacy
    .prepare(
      `INSERT INTO media_templates (id, name, source, signature, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?);`
    )
    .run("tpl1", "Default 1080p", "system", "sig-abc", "t0", "t0");
};

const tableRowCount = (db: SqliteDatabase, table: string): number => {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table};`).get() as { n?: number };
  return Number(row?.n ?? 0);
};

const safeTableRowCount = (db: SqliteDatabase, table: string): number => {
  if (!hasTable(db, table)) return 0;
  return tableRowCount(db, table);
};

const hasTable = (db: SqliteDatabase, table: string): boolean => {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=? LIMIT 1;")
    .get(table) as { name?: string } | undefined;
  return Boolean(row?.name);
};

const listTables = (db: SqliteDatabase): string[] => {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;")
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
};

// Suite-id: library-split-migration
// Split state per group is the central thing this suite cares about. Dump:
// the legacy/target/core tables + row counts, the per-group marker presence,
// and pre/post-call FK pragma state when relevant.
const dumpSplitSnapshot = (
  label: string,
  ctx: {
    legacy?: SqliteDatabase;
    target?: SqliteDatabase;
    coreDb?: SqliteDatabase;
    group?: string;
    markerKey?: string;
    capturedError?: unknown;
    extraNotes?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [library-split-migration:${label}] snapshot ===`);
    if (ctx.group) console.error(`group=${ctx.group}`);
    if (ctx.legacy) {
      const tables = listTables(ctx.legacy);
      console.error(`legacy tables=${JSON.stringify(tables)}`);
      const fkRow = (ctx.legacy as unknown as { prepare: (sql: string) => { get: () => unknown } })
        .prepare("PRAGMA foreign_keys;")
        .get() as { foreign_keys?: number } | undefined;
      console.error(`legacy PRAGMA foreign_keys=${fkRow?.foreign_keys}`);
    }
    if (ctx.target) {
      const tables = listTables(ctx.target);
      console.error(`target tables=${JSON.stringify(tables)}`);
      const counts: Record<string, number> = {};
      for (const t of tables) counts[t] = safeTableRowCount(ctx.target, t);
      console.error(`target row counts=${JSON.stringify(counts)}`);
    }
    if (ctx.coreDb && ctx.markerKey) {
      try {
        const row = ctx.coreDb
          .prepare("SELECT value FROM app_settings WHERE key = ?;")
          .get(ctx.markerKey) as { value?: string } | undefined;
        console.error(`marker ${ctx.markerKey}=${JSON.stringify(row?.value)}`);
      } catch (e) {
        console.error(`marker probe failed: ${e instanceof Error ? e.message : String(e)}`);
      }
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

describe("splitGroupFromLegacy — core group (copy-only)", () => {
  let legacy: SqliteDatabase;
  let target: SqliteDatabase;

  beforeEach(() => {
    legacy = open();
    target = open();
    seedLegacyAcrossGroups(legacy);
    console.info(
      `[library-split-migration:core-copy-only:setup] legacy.tables=${JSON.stringify(listTables(legacy))} ` +
        `target.tables=${JSON.stringify(listTables(target))}`,
    );
  });

  it("copies core rows into the target DB while leaving the legacy file untouched", () => {
    console.info(
      `[library-split-migration:core-copy-only:copy] running splitGroupFromLegacy core dropFromLegacy=false`,
    );
    const result = splitGroupFromLegacy({
      legacyDb: legacy,
      targetDb: target,
      coreDb: target,
      group: "core",
      dropFromLegacy: false,
    });
    console.info(
      `[library-split-migration:core-copy-only:copy] result=${JSON.stringify(result)}`,
    );

    try {
      expect(result.copied).toBe(true);
      expect(result.tablesProcessed).toEqual(
        expect.arrayContaining(["media_items", "playlists", "app_settings"])
      );

      expect(tableRowCount(target, "media_items")).toBe(2);
      expect(tableRowCount(legacy, "media_items")).toBe(2);
    } catch (err) {
      dumpSplitSnapshot("core-copy-only-failure", {
        legacy,
        target,
        coreDb: target,
        group: "core",
        markerKey: "migration_phase3_core_split",
        capturedError: err,
        extraNotes: { result },
      });
      throw err;
    }
  });

  it("writes the per-group split marker into the coreDb after a successful copy", () => {
    splitGroupFromLegacy({
      legacyDb: legacy,
      targetDb: target,
      coreDb: target,
      group: "core",
      dropFromLegacy: false,
    });

    const marker = target
      .prepare("SELECT value FROM app_settings WHERE key = 'migration_phase3_core_split';")
      .get() as { value?: string } | undefined;
    console.info(
      `[library-split-migration:marker-write] marker=migration_phase3_core_split value=${JSON.stringify(marker?.value)}`,
    );
    try {
      expect(marker?.value).toBe("1");
    } catch (err) {
      dumpSplitSnapshot("marker-write-failure", {
        legacy,
        target,
        coreDb: target,
        group: "core",
        markerKey: "migration_phase3_core_split",
        capturedError: err,
      });
      throw err;
    }
  });

  it("is idempotent — second invocation is a no-op once the marker is set", () => {
    splitGroupFromLegacy({
      legacyDb: legacy,
      targetDb: target,
      coreDb: target,
      group: "core",
      dropFromLegacy: false,
    });

    const firstCount = tableRowCount(target, "media_items");

    target
      .prepare(
        `INSERT INTO media_items (id, type, title, added_at, updated_at, has_files, progress_pct)
         VALUES (?, ?, ?, ?, ?, ?, ?);`
      )
      .run("m3-direct", "movie", "Direct Insert", "t1", "t1", 0, 0);

    console.info(
      `[library-split-migration:idempotent] running second splitGroupFromLegacy (expected no-op); ` +
        `firstCount=${firstCount} mid-counts=${tableRowCount(target, "media_items")}`,
    );
    const result = splitGroupFromLegacy({
      legacyDb: legacy,
      targetDb: target,
      coreDb: target,
      group: "core",
      dropFromLegacy: false,
    });
    console.info(
      `[library-split-migration:idempotent] second-call result=${JSON.stringify(result)} ` +
        `media_items count=${tableRowCount(target, "media_items")}`,
    );

    try {
      expect(result.copied).toBe(false);
      expect(result.tablesProcessed).toEqual([]);
      expect(tableRowCount(target, "media_items")).toBe(firstCount + 1);
    } catch (err) {
      dumpSplitSnapshot("idempotent-failure", {
        legacy,
        target,
        coreDb: target,
        group: "core",
        markerKey: "migration_phase3_core_split",
        capturedError: err,
        extraNotes: { firstCount, secondResult: result },
      });
      throw err;
    }
  });
});

describe("splitGroupFromLegacy — dropFromLegacy=true semantics", () => {
  it("drops the source tables from the legacy file when dropFromLegacy=true", () => {
    const legacy = open();
    const target = open();
    const core = open();
    ensureLibrarySchema(core, "core");
    seedLegacyAcrossGroups(legacy);
    console.info(
      `[library-split-migration:drop-true] pre-split legacy.has-ingest_jobs=${hasTable(legacy, "ingest_jobs")}`,
    );

    splitGroupFromLegacy({
      legacyDb: legacy,
      targetDb: target,
      coreDb: core,
      group: "ingest",
      dropFromLegacy: true,
    });
    console.info(
      `[library-split-migration:drop-true] post-split legacy.has-ingest_jobs=${hasTable(legacy, "ingest_jobs")} ` +
        `target.ingest_jobs.count=${tableRowCount(target, "ingest_jobs")}`,
    );

    try {
      expect(tableRowCount(target, "ingest_jobs")).toBe(1);
      expect(hasTable(legacy, "ingest_jobs")).toBe(false);
      expect(hasTable(legacy, "ingest_job_events")).toBe(false);
    } catch (err) {
      dumpSplitSnapshot("drop-true-failure", {
        legacy,
        target,
        coreDb: core,
        group: "ingest",
        markerKey: "migration_phase3_ingest_split",
        capturedError: err,
      });
      throw err;
    }
  });

  it("preserves the legacy source tables when dropFromLegacy=false", () => {
    const legacy = open();
    const target = open();
    const core = open();
    ensureLibrarySchema(core, "core");
    seedLegacyAcrossGroups(legacy);

    splitGroupFromLegacy({
      legacyDb: legacy,
      targetDb: target,
      coreDb: core,
      group: "ingest",
      dropFromLegacy: false,
    });
    console.info(
      `[library-split-migration:drop-false] post-split legacy.has-ingest_jobs=${hasTable(legacy, "ingest_jobs")} ` +
        `legacy.ingest_jobs.count=${safeTableRowCount(legacy, "ingest_jobs")} ` +
        `target.ingest_jobs.count=${tableRowCount(target, "ingest_jobs")}`,
    );

    try {
      expect(tableRowCount(target, "ingest_jobs")).toBe(1);
      expect(hasTable(legacy, "ingest_jobs")).toBe(true);
      expect(tableRowCount(legacy, "ingest_jobs")).toBe(1);
    } catch (err) {
      dumpSplitSnapshot("drop-false-failure", {
        legacy,
        target,
        coreDb: core,
        group: "ingest",
        markerKey: "migration_phase3_ingest_split",
        capturedError: err,
      });
      throw err;
    }
  });
});

describe("splitGroupFromLegacy — group routing", () => {
  it("never copies rows from other groups into the target", () => {
    const legacy = open();
    const target = open();
    const core = open();
    ensureLibrarySchema(core, "core");
    seedLegacyAcrossGroups(legacy);

    splitGroupFromLegacy({
      legacyDb: legacy,
      targetDb: target,
      coreDb: core,
      group: "playback",
      dropFromLegacy: false,
    });
    console.info(
      `[library-split-migration:routing-playback] target.tables=${JSON.stringify(listTables(target))}`,
    );

    try {
      // playback rows landed
      expect(tableRowCount(target, "media_formats")).toBe(1);
      // The target was schema-bootstrapped only for playback — core/metadata/
      // ingest/templates tables must not exist on it.
      expect(hasTable(target, "media_items")).toBe(false);
      expect(hasTable(target, "media_files")).toBe(false);
      expect(hasTable(target, "ingest_jobs")).toBe(false);
      expect(hasTable(target, "media_templates")).toBe(false);
    } catch (err) {
      dumpSplitSnapshot("routing-playback-failure", {
        legacy,
        target,
        coreDb: core,
        group: "playback",
        markerKey: "migration_phase3_playback_split",
        capturedError: err,
      });
      throw err;
    }
  });

  it("templates group is desktop-only — splitting it still works in isolation", () => {
    const legacy = open();
    const target = open();
    const core = open();
    ensureLibrarySchema(core, "core");
    seedLegacyAcrossGroups(legacy);

    splitGroupFromLegacy({
      legacyDb: legacy,
      targetDb: target,
      coreDb: core,
      group: "templates",
      dropFromLegacy: false,
    });

    const marker = core
      .prepare("SELECT value FROM app_settings WHERE key = 'migration_phase3_templates_split';")
      .get() as { value?: string } | undefined;
    console.info(
      `[library-split-migration:routing-templates] target.media_templates.count=${tableRowCount(target, "media_templates")} ` +
        `marker.value=${JSON.stringify(marker?.value)}`,
    );

    try {
      expect(tableRowCount(target, "media_templates")).toBe(1);
      expect(marker?.value).toBe("1");
    } catch (err) {
      dumpSplitSnapshot("routing-templates-failure", {
        legacy,
        target,
        coreDb: core,
        group: "templates",
        markerKey: "migration_phase3_templates_split",
        capturedError: err,
      });
      throw err;
    }
  });
});

describe("splitGroupFromLegacy — fresh-install path", () => {
  it("marks the split done and returns copied=true when the legacy DB never had this group's tables", () => {
    // Fresh install: a brand-new legacy file has nothing in it.
    const legacy = open();
    const target = open();

    console.info(
      `[library-split-migration:fresh-install] empty legacy — running split for core dropFromLegacy=true`,
    );
    const result = splitGroupFromLegacy({
      legacyDb: legacy,
      targetDb: target,
      coreDb: target,
      group: "core",
      dropFromLegacy: true,
    });
    console.info(
      `[library-split-migration:fresh-install] result=${JSON.stringify(result)}`,
    );

    const marker = target
      .prepare("SELECT value FROM app_settings WHERE key = 'migration_phase3_core_split';")
      .get() as { value?: string } | undefined;

    try {
      // ensureLibrarySchema(target, "core") inside the helper creates the target
      // shape; the function returns copied=true because the per-group marker
      // path is the only success exit, and tablesProcessed is empty (nothing to
      // copy from legacy).
      expect(result.copied).toBe(true);
      expect(result.tablesProcessed).toEqual([]);
      expect(marker?.value).toBe("1");
    } catch (err) {
      dumpSplitSnapshot("fresh-install-failure", {
        legacy,
        target,
        coreDb: target,
        group: "core",
        markerKey: "migration_phase3_core_split",
        capturedError: err,
        extraNotes: { result },
      });
      throw err;
    }
  });

  it("does not throw when called multiple times on a fresh install (idempotent under empty legacy)", () => {
    const legacy = open();
    const target = open();

    console.info(
      `[library-split-migration:fresh-idempotent] first invocation`,
    );
    splitGroupFromLegacy({
      legacyDb: legacy,
      targetDb: target,
      coreDb: target,
      group: "core",
      dropFromLegacy: true,
    });

    console.info(
      `[library-split-migration:fresh-idempotent] second invocation (must not throw)`,
    );
    try {
      expect(() =>
        splitGroupFromLegacy({
          legacyDb: legacy,
          targetDb: target,
          coreDb: target,
          group: "core",
          dropFromLegacy: true,
        })
      ).not.toThrow();
    } catch (err) {
      dumpSplitSnapshot("fresh-idempotent-failure", {
        legacy,
        target,
        coreDb: target,
        group: "core",
        markerKey: "migration_phase3_core_split",
        capturedError: err,
      });
      throw err;
    }
  });
});

// ---------------------------------------------------------------------------
// Part F @bugfix @regression-proof — FK-parent tables survive DROP under FK=ON
//
// Root cause: openSqliteDb opens with PRAGMA foreign_keys = ON. Under FK
// enforcement, `DROP TABLE IF EXISTS <parent>` when a child still references
// the parent is rejected SILENTLY — no error, no drop, no indication.
// Tables that are FK-parents of tables in a *different* group (still present
// in the legacy file at drop time) therefore survived the drop loop, producing
// the `.pre-split.bak` 3-table asymmetry:
//   people, playlists, media_files all survived while their siblings were gone.
//
// Fix (commit 7ae41973): the drop loop is wrapped in `PRAGMA foreign_keys = OFF`
// with a `finally` restore so FK-parent tables drop regardless of still-present
// cross-group children.
//
// Pre-fix verification (standalone SQLite repro):
//   CREATE TABLE parent (id TEXT PRIMARY KEY);
//   CREATE TABLE child (id TEXT, parent_id TEXT REFERENCES parent(id));
//   INSERT INTO parent VALUES ('p1');
//   INSERT INTO child VALUES ('c1','p1');
//   PRAGMA foreign_keys = ON;
//   DROP TABLE IF EXISTS parent;  -- exit 0, parent still exists
//
// The test below sets PRAGMA foreign_keys = ON on the legacy connection BEFORE
// calling splitGroupFromLegacy — that is the minimal reproduction of the bug
// precondition. Post-fix the parent tables are gone; pre-fix they survive.
// ---------------------------------------------------------------------------

describe("splitGroupFromLegacy — @bugfix @regression-proof FK-parent drop under FK=ON", () => {
  /**
   * @bugfix library-split-migration-fk-parent-drop
   * @regression-proof
   *
   * Precondition: the legacy DB connection has PRAGMA foreign_keys = ON (which
   * is how openSqliteDb opens it). Without this pragma the bug does not trigger.
   *
   * Seeds three cross-group FK relationships that reproduce the original
   * 3-table asymmetry:
   *   - media_files (metadata) ← media_formats (playback) via file_id
   *   - playlists (core) ← playlist_items (core) via playlist_id
   *   - people (metadata) ← media_roles (metadata) via person_id
   *
   * Splits core group (drops playlists + playlist_items from legacy) then
   * metadata group (drops media_files + people + media_roles from legacy).
   *
   * Assertion: after both splits, media_files, people, and playlists are ALL
   * absent from the legacy DB. Pre-fix they survive. Post-fix they're gone.
   * Also asserts the legacy connection's foreign_keys pragma is restored to 1.
   */
  it("media_files, people, playlists all absent from legacy after drop — FK-parent silent-survivor bug", () => {
    const legacy = new Database(":memory:") as unknown as SqliteDatabase;
    const coreDb = open();
    const metaDb = open();

    // THE PRECONDITION: enable FK enforcement on the legacy connection.
    // This is what openSqliteDb does in production and is what triggered the bug.
    legacy.exec("PRAGMA foreign_keys = ON;");
    console.info(
      `[library-split-migration:fk-parent-drop:setup] legacy opened with PRAGMA foreign_keys=ON (bug precondition)`,
    );

    // Populate the legacy DB with the full all-groups schema (single-arg).
    ensureLibrarySchema(legacy);

    // Seed a media_item (parent of everything).
    legacy.prepare(
      `INSERT INTO media_items (id, type, title, added_at, updated_at, has_files, progress_pct)
       VALUES ('mi1', 'movie', 'Test Film', 't0', 't0', 0, 0);`
    ).run();

    // Seed people (metadata group — FK parent of media_roles).
    legacy.prepare(
      `INSERT INTO people (id, name) VALUES ('p1', 'Alice');`
    ).run();

    // Seed media_files (metadata group — FK parent of media_formats from playback).
    legacy.prepare(
      `INSERT INTO media_files (id, media_id, filename, added_at, status)
       VALUES ('f1', 'mi1', 'film.mkv', 't0', 'local');`
    ).run();

    // Seed playlists (core group — FK parent of playlist_items).
    // Columns: id, name, slug, is_system, created_at (no updated_at).
    legacy.prepare(
      `INSERT INTO playlists (id, name, is_system, created_at)
       VALUES ('pl1', 'Watch Later', 0, 't0');`
    ).run();

    // Seed playlist_items (core group — FK child of playlists).
    // Columns: id, playlist_id, media_id, added_at (no `position`).
    legacy.prepare(
      `INSERT INTO playlist_items (id, playlist_id, media_id, added_at)
       VALUES ('pi1', 'pl1', 'mi1', 't0');`
    ).run();

    // Seed media_roles (metadata group — FK child of people AND media_items).
    // Columns: id, media_id, person_id, role, order_index (no `position`).
    legacy.prepare(
      `INSERT INTO media_roles (id, media_id, person_id, role, order_index)
       VALUES ('mr1', 'mi1', 'p1', 'director', 1);`
    ).run();

    // Seed media_formats (playback group — FK child of media_files).
    legacy.prepare(
      `INSERT INTO media_formats (id, media_id, file_id, quality, codec, size_mb)
       VALUES ('fmt1', 'mi1', 'f1', '1080p', 'h264', 1500);`
    ).run();

    console.info(
      `[library-split-migration:fk-parent-drop:pre-core-split] legacy tables=${JSON.stringify(listTables(legacy))}`,
    );

    // Split core (drops playlists + playlist_items from legacy, dropFromLegacy=true).
    splitGroupFromLegacy({
      legacyDb: legacy,
      targetDb: coreDb,
      coreDb,
      group: "core",
      dropFromLegacy: true,
    });
    console.info(
      `[library-split-migration:fk-parent-drop:post-core-split] legacy tables=${JSON.stringify(listTables(legacy))}`,
    );

    // Split metadata (drops media_files + people + media_roles from legacy, dropFromLegacy=true).
    // media_formats (playback) is still present — this is the cross-group FK scenario.
    splitGroupFromLegacy({
      legacyDb: legacy,
      targetDb: metaDb,
      coreDb,
      group: "metadata",
      dropFromLegacy: true,
    });
    const survivorNames = listTables(legacy);
    console.info(
      `[library-split-migration:fk-parent-drop:post-metadata-split] legacy tables=${JSON.stringify(survivorNames)}`,
    );

    // --- REGRESSION-PROOF ASSERTION ---
    // Pre-fix: all three survived (DROP TABLE IF EXISTS was a silent no-op under FK=ON).
    // Post-fix: all three are gone.
    try {
      expect(survivorNames).not.toContain("media_files");
      expect(survivorNames).not.toContain("people");
      expect(survivorNames).not.toContain("playlists");
    } catch (err) {
      dumpSplitSnapshot("fk-parent-drop-failure", {
        legacy,
        target: metaDb,
        coreDb,
        group: "metadata",
        markerKey: "migration_phase3_metadata_split",
        capturedError: err,
        extraNotes: {
          warning:
            "Pre-fix bug: under FK=ON, DROP TABLE IF EXISTS silently no-ops on FK-parent tables. If survivors includes media_files/people/playlists, the FK=OFF wrap is broken.",
          survivorNames,
        },
      });
      throw err;
    }
  });

  it("legacy connection's PRAGMA foreign_keys is restored to 1 after the drop loop (fix's finally must not leave FK disabled)", () => {
    const legacy = new Database(":memory:") as unknown as SqliteDatabase;
    const coreDb = open();

    // Start with FK=ON — the production precondition.
    legacy.exec("PRAGMA foreign_keys = ON;");
    ensureLibrarySchema(legacy);

    // Seed minimal data so the drop loop actually runs.
    legacy.prepare(
      `INSERT INTO media_items (id, type, title, added_at, updated_at, has_files, progress_pct)
       VALUES ('mi1', 'movie', 'Film', 't0', 't0', 0, 0);`
    ).run();
    legacy.prepare(
      `INSERT INTO playlists (id, name, is_system, created_at)
       VALUES ('pl1', 'PL', 0, 't0');`
    ).run();
    console.info(
      `[library-split-migration:fk-restore:pre] legacy PRAGMA foreign_keys=ON, seed complete`,
    );

    splitGroupFromLegacy({
      legacyDb: legacy,
      targetDb: coreDb,
      coreDb,
      group: "core",
      dropFromLegacy: true,
    });

    // After the call, the legacy connection must have FK enforcement restored.
    const fkRow = (legacy as unknown as Database)
      .prepare("PRAGMA foreign_keys;")
      .get() as { foreign_keys?: number } | undefined;
    console.info(
      `[library-split-migration:fk-restore:post] legacy PRAGMA foreign_keys=${fkRow?.foreign_keys} (expected 1)`,
    );
    try {
      expect(fkRow?.foreign_keys).toBe(1);
    } catch (err) {
      dumpSplitSnapshot("fk-restore-failure", {
        legacy,
        target: coreDb,
        coreDb,
        group: "core",
        markerKey: "migration_phase3_core_split",
        capturedError: err,
        extraNotes: { fkRow },
      });
      throw err;
    }
  });
});

describe("splitGroupFromLegacy — partial-failure recovery", () => {
  it("recovers cleanly on a re-run after the FIRST attempt is aborted before the marker is written", () => {
    // Simulate a process-kill mid-copy: we run the helper against a
    // target that's been pre-populated to look like an interrupted previous
    // attempt — schema present, some rows already inserted, no marker.
    const legacy = open();
    const target = open();
    seedLegacyAcrossGroups(legacy);

    // Pre-bootstrap the target's core schema + insert a partial row, as if a
    // prior run crashed after one INSERT but before the marker write.
    ensureLibrarySchema(target, "core");
    target
      .prepare(
        `INSERT INTO media_items (id, type, title, added_at, updated_at, has_files, progress_pct)
         VALUES (?, ?, ?, ?, ?, ?, ?);`
      )
      .run("m1", "movie", "Stale Title", "t-old", "t-old", 0, 0);
    console.info(
      `[library-split-migration:recovery-rerun:pre] stale m1 in target before split; marker absent`,
    );

    // The marker is absent, so the next invocation runs the full copy.
    const result = splitGroupFromLegacy({
      legacyDb: legacy,
      targetDb: target,
      coreDb: target,
      group: "core",
      dropFromLegacy: false,
    });
    console.info(`[library-split-migration:recovery-rerun:first-call] result=${JSON.stringify(result)}`);

    const restored = target
      .prepare("SELECT title FROM media_items WHERE id = ?;")
      .get("m1") as { title?: string } | undefined;
    console.info(
      `[library-split-migration:recovery-rerun:first-call] restored.title=${JSON.stringify(restored?.title)} ` +
        `media_items.count=${tableRowCount(target, "media_items")}`,
    );

    try {
      expect(result.copied).toBe(true);
      // INSERT OR REPLACE in the helper overwrites the stale row with the
      // legacy authoritative value.
      expect(restored?.title).toBe("Movie One");
      expect(tableRowCount(target, "media_items")).toBe(2);
    } catch (err) {
      dumpSplitSnapshot("recovery-rerun-first-call-failure", {
        legacy,
        target,
        coreDb: target,
        group: "core",
        markerKey: "migration_phase3_core_split",
        capturedError: err,
        extraNotes: { result, restored },
      });
      throw err;
    }

    // Marker now exists — subsequent reruns are no-ops.
    const second = splitGroupFromLegacy({
      legacyDb: legacy,
      targetDb: target,
      coreDb: target,
      group: "core",
      dropFromLegacy: false,
    });
    console.info(
      `[library-split-migration:recovery-rerun:second-call] result=${JSON.stringify(second)}`,
    );
    try {
      expect(second.copied).toBe(false);
    } catch (err) {
      dumpSplitSnapshot("recovery-rerun-second-call-failure", {
        legacy,
        target,
        coreDb: target,
        group: "core",
        markerKey: "migration_phase3_core_split",
        capturedError: err,
        extraNotes: { second },
      });
      throw err;
    }
  });

  it("rolls back the in-flight transaction when an INSERT fails mid-copy", () => {
    const legacy = open();
    const target = open();
    seedLegacyAcrossGroups(legacy);
    // Add a second core row so we have multiple to insert.
    legacy
      .prepare(
        `INSERT INTO media_items (id, type, title, added_at, updated_at, has_files, progress_pct)
         VALUES (?, ?, ?, ?, ?, ?, ?);`
      )
      .run("m3", "movie", "Third", "t0", "t0", 0, 0);

    ensureLibrarySchema(target, "core");

    // Wrap target.prepare so the INSERT statement fails on its second .run().
    const realPrepare = target.prepare.bind(target);
    let insertCalls = 0;
    (target as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      const stmt = realPrepare(sql) as { run: (...args: unknown[]) => unknown };
      if (sql.toUpperCase().includes("INSERT OR REPLACE INTO ") && sql.toLowerCase().includes("media_items")) {
        const origRun = stmt.run.bind(stmt);
        stmt.run = (...args: unknown[]) => {
          insertCalls += 1;
          if (insertCalls === 2) {
            console.info(
              `[library-split-migration:rollback:trap] simulated failure on insertCalls=${insertCalls}`,
            );
            throw new Error("simulated mid-copy failure");
          }
          return origRun(...args);
        };
      }
      return stmt;
    };
    console.info(
      `[library-split-migration:rollback] starting split with INSERT trap (fails on 2nd call)`,
    );

    try {
      expect(() =>
        splitGroupFromLegacy({
          legacyDb: legacy,
          targetDb: target,
          coreDb: target,
          group: "core",
          dropFromLegacy: false,
        })
      ).toThrow("simulated mid-copy failure");
    } catch (err) {
      dumpSplitSnapshot("rollback-no-throw-failure", {
        legacy,
        target,
        coreDb: target,
        group: "core",
        markerKey: "migration_phase3_core_split",
        capturedError: err,
        extraNotes: { insertCalls },
      });
      throw err;
    }

    // The transaction rolled back — target media_items should be empty (no
    // partial row landed) and the marker MUST NOT be set.
    const marker = target
      .prepare("SELECT value FROM app_settings WHERE key = 'migration_phase3_core_split';")
      .get() as { value?: string } | undefined;
    console.info(
      `[library-split-migration:rollback:post-throw] marker.value=${JSON.stringify(marker?.value)} ` +
        `target.media_items.count=${tableRowCount(target, "media_items")} insertCalls=${insertCalls}`,
    );
    try {
      expect(marker?.value).toBeUndefined();
      expect(tableRowCount(target, "media_items")).toBe(0);
    } catch (err) {
      dumpSplitSnapshot("rollback-state-failure", {
        legacy,
        target,
        coreDb: target,
        group: "core",
        markerKey: "migration_phase3_core_split",
        capturedError: err,
        extraNotes: { marker, insertCalls },
      });
      throw err;
    }
  });
});
