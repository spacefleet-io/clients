/**
 * Phase 3 legacy-split migration.
 *
 * Phase 3 of the library-db unification (plan: when-we-change-how-happy-otter.md)
 * splits the desktop's single `library.sqlite` file into five group-scoped
 * files: `library.{core,metadata,playback,ingest,templates}.sqlite`.
 *
 * This helper copies one group's tables out of the legacy single-file DB
 * into a freshly-opened per-group DB, then drops those tables from the
 * legacy file. Each group's split is idempotent via a marker row in
 * `core.app_settings` so reruns are safe.
 *
 * The hybrid routing model in `LibraryDb` keeps the legacy `this.db` / `this.orm`
 * around for groups that haven't been split yet — each per-group commit moves
 * one group's tables out and points that group's queries at the new file.
 */
import { tableGroups, type LibraryDbGroup } from "@space/library-db-definition";
import { ensureLibrarySchema } from "@space/library-db-definition/migrations";
import type { SqliteDatabase } from "./db";

const markerKey = (group: LibraryDbGroup) => `migration_phase3_${group}_split`;

const nowIso = () => new Date().toISOString();

const tablesForGroup = (group: LibraryDbGroup): string[] =>
  Object.entries(tableGroups)
    .filter(([, g]) => g === group)
    .map(([table]) => table);

const hasTable = (db: SqliteDatabase, table: string) => {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1;")
    .get(table) as { name?: string } | undefined;
  return Boolean(row?.name);
};

const tableColumns = (db: SqliteDatabase, table: string): string[] => {
  const rows = db.prepare(`PRAGMA table_info(${table});`).all() as Array<{ name?: string }>;
  return rows.map((row) => String(row?.name ?? "")).filter((name) => name.length > 0);
};

const escapeIdent = (value: string) => `"${value.replace(/"/g, '""')}"`;

const isSplitDone = (coreDb: SqliteDatabase, group: LibraryDbGroup): boolean => {
  if (!hasTable(coreDb, "app_settings")) return false;
  const row = coreDb
    .prepare("SELECT value FROM app_settings WHERE key = ? LIMIT 1;")
    .get(markerKey(group)) as { value?: string } | undefined;
  return Boolean(row?.value);
};

const markSplitDone = (coreDb: SqliteDatabase, group: LibraryDbGroup): void => {
  coreDb
    .prepare(
      "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?);"
    )
    .run(markerKey(group), "1", nowIso());
};

/**
 * Copy one group's tables from the legacy DB into the per-group target DB.
 * Idempotent — repeat calls become a no-op once the marker is set.
 *
 * `coreDb` is where the per-group marker lives. For the `core` split itself,
 * pass the target as `coreDb`.
 *
 * Phase 3.1: this only COPIES — legacy tables stay in place so existing
 * `this.orm`/`this.db` code paths continue working unchanged until a follow-up
 * routing commit flips reads/writes to the per-group ORM. The final commit
 * in Phase 3 drops the legacy copies and renames the legacy file to
 * `.pre-split.bak`.
 */
export const splitGroupFromLegacy = (params: {
  legacyDb: SqliteDatabase;
  targetDb: SqliteDatabase;
  coreDb: SqliteDatabase;
  group: LibraryDbGroup;
  dropFromLegacy?: boolean;
}): { copied: boolean; tablesProcessed: string[] } => {
  const { legacyDb, targetDb, coreDb, group, dropFromLegacy = false } = params;

  // Ensure target has this group's schema (creates tables + indexes).
  ensureLibrarySchema(targetDb, group);

  // For the core group, the marker row lives in the target itself (which IS
  // coreDb at split time). For other groups, the marker lives in the already-
  // split core DB so a partially-completed multi-group split is still
  // recoverable.
  if (isSplitDone(coreDb, group)) {
    return { copied: false, tablesProcessed: [] };
  }

  const groupTables = tablesForGroup(group);
  const tablesProcessed: string[] = [];

  for (const table of groupTables) {
    if (!hasTable(legacyDb, table)) {
      // Legacy DB never had this table (fresh install or earlier group split
      // already removed it). Nothing to copy.
      continue;
    }

    const legacyCols = tableColumns(legacyDb, table);
    const targetCols = new Set(tableColumns(targetDb, table));
    const sharedCols = legacyCols.filter((col) => targetCols.has(col));
    if (sharedCols.length === 0) {
      // Defensive: schema mismatch with no overlap — skip rather than crash.
      // ensureLibrarySchema should have populated targetCols above; an empty
      // intersection means the legacy table has a wildly divergent shape.
      continue;
    }

    const colList = sharedCols.map(escapeIdent).join(", ");
    let rows = legacyDb
      .prepare(`SELECT ${colList} FROM ${escapeIdent(table)};`)
      .all() as Array<Record<string, unknown>>;

    if (table === "app_settings") {
      // The `migration_phase3_<group>_split` keys are CLIENT-LOCAL state
      // describing whether THIS client's per-group SQLite files have been
      // populated. Snapshots can be uploaded by any client (cross-device
      // sync), so a snapshot's app_settings may carry markers set by the
      // uploader. If those leak into the new coreDb here, subsequent
      // initializeMetadataDb / initializePlaybackDb / etc. invocations
      // call `isSplitDone(coreDb, group)` which returns true →
      // splitGroupFromLegacy early-returns → no copy runs → those groups'
      // tables stay stuck in legacy and per-group DBs end up empty.
      // Surfaced as silent metadata loss after a remote-snapshot resync —
      // @bugfix #library-split-marker-leak. Migration markers are reset
      // locally at the end of each group's split via `markSplitDone`, so
      // dropping them here is safe.
      rows = rows.filter(
        (row) => !String(row.key ?? "").startsWith("migration_phase3_")
      );
    }

    if (rows.length > 0) {
      const placeholders = sharedCols.map(() => "?").join(", ");
      const insertStmt = targetDb.prepare(
        `INSERT OR REPLACE INTO ${escapeIdent(table)} (${colList}) VALUES (${placeholders});`
      );
      const tx = targetDb.transaction
        ? targetDb.transaction((batch: Array<Record<string, unknown>>) => {
            for (const row of batch) {
              insertStmt.run(...sharedCols.map((col) => row[col] ?? null));
            }
          })
        : null;
      if (tx) {
        tx(rows);
      } else {
        // bun:sqlite path — no transaction() helper; wrap in BEGIN/COMMIT.
        targetDb.exec("BEGIN;");
        try {
          for (const row of rows) {
            insertStmt.run(...sharedCols.map((col) => row[col] ?? null));
          }
          targetDb.exec("COMMIT;");
        } catch (error) {
          targetDb.exec("ROLLBACK;");
          throw error;
        }
      }
    }

    tablesProcessed.push(table);
  }

  // Optionally drop the legacy copies. Each per-group commit (Phases 3.1–3.4)
  // keeps dropFromLegacy=false so that the legacy `this.db` still serves
  // reads/writes while routing is rewritten group-by-group. The final
  // Phase 3.5 commit calls this with dropFromLegacy=true once all five
  // per-group ORMs own their queries.
  if (dropFromLegacy) {
    // The legacy DB is opened with `PRAGMA foreign_keys = ON` (openSqliteDb).
    // With FK enforcement on, `DROP TABLE` on a table still referenced by a
    // FK from another *not-yet-dropped* table is rejected — and under
    // `IF EXISTS` SQLite rejects it SILENTLY as a no-op (no error to catch).
    // Each group's split drops a subset of legacy tables, and FK parents
    // are routinely referenced by children in a *different* group still
    // present in the legacy file (e.g. metadata's `media_files` is
    // referenced by playback's `media_formats`), so a naive drop loop
    // leaves every FK-parent table behind — the `.pre-split.bak`
    // 3-table-asymmetry bug (library-manifest-encoding-mismatch finding,
    // §Secondary 2: `people` / `playlists` / `media_files` all survived).
    //
    // Disable FK enforcement for the drop loop so a parent table drops
    // regardless of a still-present child. This is correct here: the legacy
    // file is being torn down to `.pre-split.bak` and never read again —
    // there is no integrity to preserve in it. Restore the prior pragma
    // afterwards so the legacy connection's semantics are unchanged for any
    // remaining use before the file is renamed.
    const fkRow = legacyDb.prepare("PRAGMA foreign_keys;").get() as
      | { foreign_keys?: number }
      | undefined;
    const fkWasOn = Boolean(fkRow?.foreign_keys);
    legacyDb.exec("PRAGMA foreign_keys = OFF;");
    try {
      for (const table of tablesProcessed) {
        legacyDb.exec(`DROP TABLE IF EXISTS ${escapeIdent(table)};`);
      }
    } finally {
      if (fkWasOn) {
        legacyDb.exec("PRAGMA foreign_keys = ON;");
      }
    }
  }

  markSplitDone(coreDb, group);

  return { copied: true, tablesProcessed };
};
