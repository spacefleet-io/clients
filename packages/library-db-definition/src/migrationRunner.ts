/**
 * Shared per-group migration runner for the SpaceBadger library DB.
 *
 * Phase 7 of the library-db unification (plan: when-we-change-how-happy-otter.md):
 * both clients evolve per-group schema via the SAME `user_version`-gated runner.
 * Mirrors the Phase 1 sync/async DDL split: a sync runner for desktop's
 * better-sqlite3 / bun:sqlite drivers, and an async runner for mobile's
 * Promise-based `react-native-sqlite-storage`.
 *
 * Baseline: `user_version=0` corresponds to the "post-`ensureLibrarySchema(db, group)`"
 * state. v1 is the first migration applied AFTER the baseline. Mobile's existing
 * playback v2 (`drop_media_playback_blob_v2`) lives on the v1=baseline+v2=normalize
 * shape — i.e. mobile pre-Phase-7 packed the baseline as v1 itself; Phase 7.2 keeps
 * that shape (baseline + v2 normalize) for byte-identical compatibility.
 *
 * Invariants enforced by both runners:
 *   - Strictly monotonic versions (no duplicates, no out-of-order).
 *   - All versions are positive integers (>= 1).
 *   - Skips migrations at or below the current `user_version` (idempotent reruns).
 *   - Bumps `user_version` AFTER each `up()` runs — so a mid-batch failure leaves
 *     the DB at the last-successful version, and a rerun resumes from there.
 *   - `group` is a label passed through to logs; the actual SQL lives in `up()`.
 */
import { LibraryFormatTooNewError } from "./compatibility";
import type { LibraryDbGroup } from "./manifest";
import type { AsyncSqliteDb, SqliteDb } from "./migrations";

/**
 * The `group` argument is purely informational — it labels log events so
 * operators can identify which DB is migrating. The actual SQL is in each
 * migration's `up()` callback (which operates on the supplied `db` handle).
 * Accepts both the strict `LibraryDbGroup` (e.g. "core", "playback") and
 * arbitrary labels — useful for the shared mobile runner that re-uses the
 * runner for the cold-bootstrap combined-snapshot DB.
 */
export type MigrationGroupLabel = LibraryDbGroup | (string & {});

export type LibraryMigration<DbT> = {
  version: number;
  description: string;
  up: (db: DbT) => void;
};

export type AsyncLibraryMigration<DbT> = {
  version: number;
  description: string;
  up: (db: DbT) => Promise<void> | void;
};

export type MigrationLogger = (event: string, data: Record<string, unknown>) => void;

export type RunMigrationsOptions = {
  log?: MigrationLogger;
};

export type RunMigrationsResult = {
  from: number;
  to: number;
  applied: number[];
};

const validateMigrations = (
  migrations: ReadonlyArray<{ version: number }>,
  group: MigrationGroupLabel
) => {
  let lastVersion = 0;
  const seen = new Set<number>();
  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version < 1) {
      throw new Error(
        `invalid_migration_version:${group}:${migration.version}`
      );
    }
    if (seen.has(migration.version)) {
      throw new Error(
        `duplicate_migration_version:${group}:${migration.version}`
      );
    }
    if (migration.version <= lastVersion) {
      throw new Error(
        `non_monotonic_migration_versions:${group}:expected_gt_${lastVersion}_got_${migration.version}`
      );
    }
    seen.add(migration.version);
    lastVersion = migration.version;
  }
};

// ---------------------------------------------------------------------------
// Sync runner — for desktop (better-sqlite3 / bun:sqlite). PRAGMA user_version
// is read+written through the sync `exec` + `prepare(...).all()` shape.
// ---------------------------------------------------------------------------

const readUserVersionSync = (db: SqliteDb): number => {
  const rows = db.prepare("PRAGMA user_version;").all() as Array<{ user_version?: number }>;
  if (!rows.length) return 0;
  const raw = rows[0]?.user_version;
  const value = Number(raw ?? 0);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
};

const writeUserVersionSync = (db: SqliteDb, version: number): void => {
  if (!Number.isInteger(version) || version < 0) {
    throw new Error(`invalid_user_version:${version}`);
  }
  // PRAGMA user_version does not accept parameter binding — interpolate the
  // validated integer directly.
  db.exec(`PRAGMA user_version = ${version};`);
};

export const runMigrations = (
  db: SqliteDb,
  group: MigrationGroupLabel,
  migrations: ReadonlyArray<LibraryMigration<SqliteDb>>,
  options?: RunMigrationsOptions
): RunMigrationsResult => {
  validateMigrations(migrations, group);
  const log = options?.log;
  // `targetVersion` is the highest known migration version — and `0` (the
  // baseline `user_version`) when the registry is empty. The downgrade check
  // must run BEFORE the empty-registry early return below: an empty registry
  // means `targetVersion = 0`, so a group at `user_version > 0` (written by a
  // future client) is exactly the "currentVersion exceeds the highest known
  // migration" downgrade condition. Returning early on `length === 0` without
  // this check would bypass the throw and leave schema downgrade-protection
  // non-functional for a build whose registries are all empty (today: every
  // desktop group).
  const targetVersion =
    migrations.length > 0 ? migrations[migrations.length - 1]!.version : 0;
  const currentVersion = readUserVersionSync(db);

  if (currentVersion > targetVersion) {
    // A `user_version` higher than the highest known migration means a newer
    // client already migrated this group's schema past what this build knows.
    // `targetVersion` is exactly the surface-#1 version this build supports.
    // Route the downgrade-block through the unified typed error (surface
    // "schema") so the Part D gate and UI turn it into a clean "library
    // created by a newer version" prompt instead of a cryptic failure.
    throw new LibraryFormatTooNewError({
      surface: "schema",
      observed: currentVersion,
      supported: targetVersion,
      group: String(group),
    });
  }
  if (migrations.length === 0) {
    // No registered migrations — nothing to apply. `currentVersion` is
    // necessarily 0 here (a higher value already threw above, since
    // `targetVersion` is 0), i.e. the legitimate fresh-baseline case.
    return { from: currentVersion, to: currentVersion, applied: [] };
  }
  if (currentVersion === targetVersion) {
    log?.("library.migrations.up_to_date", { group, version: currentVersion });
    return { from: currentVersion, to: currentVersion, applied: [] };
  }

  const pending = migrations.filter((m) => m.version > currentVersion);
  log?.("library.migrations.start", {
    group,
    from: currentVersion,
    to: targetVersion,
    count: pending.length,
  });

  const applied: number[] = [];
  for (const migration of pending) {
    log?.("library.migrations.apply", {
      group,
      version: migration.version,
      description: migration.description,
    });
    try {
      migration.up(db);
      writeUserVersionSync(db, migration.version);
      applied.push(migration.version);
    } catch (error) {
      log?.("library.migrations.failed", {
        group,
        version: migration.version,
        description: migration.description,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  log?.("library.migrations.complete", {
    group,
    from: currentVersion,
    to: targetVersion,
    applied,
  });

  return { from: currentVersion, to: targetVersion, applied };
};

// ---------------------------------------------------------------------------
// Async runner — for mobile (react-native-sqlite-storage). The driver's only
// shared contract here is `exec(sql)`; user_version reads come back as a
// generic shape via a single executeSql call wrapped by the caller's adapter.
// We require a slightly richer shape — `query(sql)` returning rows — so the
// runner can read `PRAGMA user_version` without poking driver internals.
// ---------------------------------------------------------------------------

export type AsyncSqliteRunnerDb = AsyncSqliteDb & {
  query: (sql: string) => Promise<ReadonlyArray<Record<string, unknown>>>;
};

const readUserVersionAsync = async (db: AsyncSqliteRunnerDb): Promise<number> => {
  const rows = await db.query("PRAGMA user_version;");
  if (!rows.length) return 0;
  const raw = (rows[0] as { user_version?: number })?.user_version;
  const value = Number(raw ?? 0);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
};

const writeUserVersionAsync = async (db: AsyncSqliteRunnerDb, version: number): Promise<void> => {
  if (!Number.isInteger(version) || version < 0) {
    throw new Error(`invalid_user_version:${version}`);
  }
  await db.exec(`PRAGMA user_version = ${version};`);
};

export const runMigrationsAsync = async <DbT extends AsyncSqliteRunnerDb>(
  db: DbT,
  group: MigrationGroupLabel,
  migrations: ReadonlyArray<AsyncLibraryMigration<DbT>>,
  options?: RunMigrationsOptions
): Promise<RunMigrationsResult> => {
  validateMigrations(migrations, group);
  const log = options?.log;
  // Downgrade check runs BEFORE the empty-registry early return — see the sync
  // runner's `runMigrations` above for the full rationale. `targetVersion` is
  // the highest known migration version, or `0` (baseline) for an empty
  // registry; a `user_version` above it is the surface-#1 forward skew.
  const targetVersion =
    migrations.length > 0 ? migrations[migrations.length - 1]!.version : 0;
  const currentVersion = await readUserVersionAsync(db);

  if (currentVersion > targetVersion) {
    throw new LibraryFormatTooNewError({
      surface: "schema",
      observed: currentVersion,
      supported: targetVersion,
      group: String(group),
    });
  }
  if (migrations.length === 0) {
    // No registered migrations — `currentVersion` is necessarily 0 here (a
    // higher value already threw above). The legitimate fresh-baseline case.
    return { from: currentVersion, to: currentVersion, applied: [] };
  }
  if (currentVersion === targetVersion) {
    log?.("library.migrations.up_to_date", { group, version: currentVersion });
    return { from: currentVersion, to: currentVersion, applied: [] };
  }

  const pending = migrations.filter((m) => m.version > currentVersion);
  log?.("library.migrations.start", {
    group,
    from: currentVersion,
    to: targetVersion,
    count: pending.length,
  });

  const applied: number[] = [];
  for (const migration of pending) {
    log?.("library.migrations.apply", {
      group,
      version: migration.version,
      description: migration.description,
    });
    try {
      await migration.up(db);
      await writeUserVersionAsync(db, migration.version);
      applied.push(migration.version);
    } catch (error) {
      log?.("library.migrations.failed", {
        group,
        version: migration.version,
        description: migration.description,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  log?.("library.migrations.complete", {
    group,
    from: currentVersion,
    to: targetVersion,
    applied,
  });

  return { from: currentVersion, to: targetVersion, applied };
};
