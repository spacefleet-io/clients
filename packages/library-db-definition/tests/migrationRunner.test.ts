/**
 * @test-id LIB-DB-MIGRATION-RUNNER-001
 * @level unit
 * @why Phase 7 of the library-db unification — both clients evolve per-group
 *   schema via the SAME `user_version`-gated runner. Sync (desktop) and async
 *   (mobile) variants must share invariants: strict monotonic versions,
 *   idempotent reruns, per-migration version bumps so mid-batch failures
 *   leave the DB at the last-successful version.
 */
import { describe, expect, it, vi } from "vitest";
import {
  type AsyncLibraryMigration,
  type AsyncSqliteRunnerDb,
  type LibraryMigration,
  runMigrations,
  runMigrationsAsync,
} from "../src/migrationRunner";
import type { SqliteDb } from "../src/migrations";
import { LibraryFormatTooNewError } from "../src/compatibility";

const SUITE = "migrationRunner";

const dumpRunnerSnapshot = (
  label: string,
  ctx: {
    flavor?: "sync" | "async";
    initialUserVersion?: number;
    currentUserVersion?: number;
    targetUserVersion?: number;
    expectedUserVersion?: number;
    registry?: ReadonlyArray<{ version: number; description: string }>;
    appliedSet?: ReadonlyArray<number>;
    result?: { from: number; to: number; applied: ReadonlyArray<number> };
    spyCallCounts?: Record<string, number>;
    logCalls?: ReadonlyArray<unknown>;
    execLogSample?: ReadonlyArray<string>;
    caughtError?: unknown;
    expectedThrowSubstr?: string;
  },
) => {
  try {
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    if (ctx.flavor) console.error(`flavor: ${ctx.flavor}`);
    if (ctx.initialUserVersion !== undefined) console.error(`initial user_version: ${ctx.initialUserVersion}`);
    if (ctx.currentUserVersion !== undefined) console.error(`current user_version: ${ctx.currentUserVersion}${ctx.expectedUserVersion !== undefined ? ` (expected ${ctx.expectedUserVersion})` : ""}`);
    if (ctx.targetUserVersion !== undefined) console.error(`target user_version: ${ctx.targetUserVersion}`);
    if (ctx.registry) console.error(`migration registry:\n${JSON.stringify(ctx.registry, null, 2)}`);
    if (ctx.appliedSet) console.error(`applied set: ${JSON.stringify(ctx.appliedSet)}`);
    if (ctx.result) console.error(`result: ${JSON.stringify(ctx.result)}`);
    if (ctx.spyCallCounts) console.error(`spy call counts:\n${JSON.stringify(ctx.spyCallCounts, null, 2)}`);
    if (ctx.logCalls) {
      console.error(`log calls:\n${JSON.stringify(ctx.logCalls, null, 2)}`);
    }
    if (ctx.execLogSample) {
      console.error(`exec log (last 10):\n${JSON.stringify(ctx.execLogSample.slice(-10), null, 2)}`);
    }
    if (ctx.caughtError !== undefined) {
      const e = ctx.caughtError;
      console.error(`caught: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
      if (e instanceof LibraryFormatTooNewError) {
        console.error(`  surface=${e.surface} observed=${e.observed} supported=${e.supported} group=${e.group}`);
      }
    }
    if (ctx.expectedThrowSubstr) console.error(`expected throw substring: ${ctx.expectedThrowSubstr}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

const registrySummary = (migs: ReadonlyArray<{ version: number; description: string }>) =>
  migs.map((m) => ({ version: m.version, description: m.description }));

// ---------------------------------------------------------------------------
// Sync in-memory mock — enough surface for the runner: exec()/prepare()/all().
// `user_version` is tracked as a field, mutated when the runner issues
// `PRAGMA user_version = N`.
// ---------------------------------------------------------------------------

type SyncMockDb = SqliteDb & {
  _userVersion: number;
  _execLog: string[];
};

const buildSyncMockDb = (initialUserVersion = 0): SyncMockDb => {
  const state = {
    userVersion: initialUserVersion,
    execLog: [] as string[],
  };
  const db: SyncMockDb = {
    _userVersion: initialUserVersion,
    _execLog: state.execLog,
    exec: (sql: string) => {
      state.execLog.push(sql);
      const match = sql.match(/^\s*PRAGMA\s+user_version\s*=\s*(\d+)\s*;?\s*$/i);
      if (match) {
        state.userVersion = Number(match[1]);
        db._userVersion = state.userVersion;
      }
      return undefined;
    },
    prepare: (sql: string) => ({
      all: () => {
        if (/^\s*PRAGMA\s+user_version\s*;?\s*$/i.test(sql)) {
          return [{ user_version: state.userVersion }];
        }
        return [];
      },
      run: () => undefined,
    }),
  };
  return db;
};

// ---------------------------------------------------------------------------
// Async in-memory mock — exec() + query() with the same `user_version` state
// machine.
// ---------------------------------------------------------------------------

type AsyncMockDb = AsyncSqliteRunnerDb & {
  _userVersion: number;
  _execLog: string[];
};

const buildAsyncMockDb = (initialUserVersion = 0): AsyncMockDb => {
  const state = {
    userVersion: initialUserVersion,
    execLog: [] as string[],
  };
  const db: AsyncMockDb = {
    _userVersion: initialUserVersion,
    _execLog: state.execLog,
    exec: async (sql: string) => {
      state.execLog.push(sql);
      const match = sql.match(/^\s*PRAGMA\s+user_version\s*=\s*(\d+)\s*;?\s*$/i);
      if (match) {
        state.userVersion = Number(match[1]);
        db._userVersion = state.userVersion;
      }
    },
    query: async (sql: string) => {
      if (/^\s*PRAGMA\s+user_version\s*;?\s*$/i.test(sql)) {
        return [{ user_version: state.userVersion }];
      }
      return [];
    },
  };
  return db;
};

describe("runMigrations (sync)", () => {
  it("returns no-op on empty array", () => {
    console.info(`[${SUITE}:sync:setup] empty registry @ user_version=0`);
    const db = buildSyncMockDb();
    const result = runMigrations(db, "core", []);
    console.info(`[${SUITE}:sync:exec] result=${JSON.stringify(result)} user_version=${db._userVersion}`);

    try {
      expect(result).toEqual({ from: 0, to: 0, applied: [] });
      expect(db._userVersion).toBe(0);
    } catch (err) {
      dumpRunnerSnapshot("sync-empty-no-op-wrong", {
        flavor: "sync",
        currentUserVersion: db._userVersion,
        result,
        registry: [],
      });
      throw err;
    }
  });

  it("does not throw on empty array when user_version is 0 (fresh-baseline)", () => {
    // The legitimate fresh-desktop baseline: a group with no registered
    // migrations at user_version 0. Must stay a clean no-op — the downgrade
    // check (which now runs before the empty-array return) sees 0 > 0 = false.
    // Asserts the return value too, mirroring the async fresh-baseline test.
    console.info(`[${SUITE}:sync:setup] fresh baseline empty registry @ user_version=0`);
    const db = buildSyncMockDb(0);

    try {
      expect(runMigrations(db, "core", [])).toEqual({ from: 0, to: 0, applied: [] });
    } catch (err) {
      dumpRunnerSnapshot("sync-fresh-baseline-broken", {
        flavor: "sync",
        currentUserVersion: db._userVersion,
        registry: [],
      });
      throw err;
    }
  });

  it("@bugfix @regression-proof empty registry + user_version > 0 throws LibraryFormatTooNewError", () => {
    // Regression proof for the empty-registry downgrade hole. Before the fix,
    // `runMigrations` returned early on `migrations.length === 0` BEFORE the
    // downgrade check ran — so a group at user_version > 0 with an empty
    // registry silently returned {from:0,to:0} instead of refusing. Every
    // desktop group's registry is empty today, so desktop schema
    // downgrade-protection was non-functional. Post-fix the downgrade check
    // runs first: an empty registry means highest-known-version = 0, so a
    // user_version above 0 is a forward skew and must throw.
    // Pre-fix this test FAILS (no throw); post-fix it PASSES.
    console.info(`[${SUITE}:sync:setup] @bugfix empty registry + user_version=3 (must throw LibraryFormatTooNewError)`);
    const db = buildSyncMockDb(3);
    let caught: LibraryFormatTooNewError | undefined;
    try {
      runMigrations(db, "core", []);
    } catch (e) {
      caught = e as LibraryFormatTooNewError;
    }
    console.info(`[${SUITE}:sync:exec] caught=${caught?.name} surface=${caught?.surface} observed=${caught?.observed} supported=${caught?.supported} group=${caught?.group}`);

    try {
      expect(caught).toBeInstanceOf(LibraryFormatTooNewError);
      expect(caught!.surface).toBe("schema");
      expect(caught!.observed).toBe(3);
      expect(caught!.supported).toBe(0);
      expect(caught!.group).toBe("core");
      // user_version unchanged — the runner throws before touching the DB.
      expect(db._userVersion).toBe(3);
    } catch (err) {
      dumpRunnerSnapshot("empty-registry-downgrade-bug-regressed", {
        flavor: "sync",
        currentUserVersion: db._userVersion,
        expectedUserVersion: 3,
        registry: [],
        caughtError: caught,
      });
      throw err;
    }
  });

  it("applies pending migrations in order and bumps user_version after each", () => {
    console.info(`[${SUITE}:sync:setup] empty db, 2-migration registry`);
    const db = buildSyncMockDb();
    const upSpy1 = vi.fn();
    const upSpy2 = vi.fn();
    const migrations: ReadonlyArray<LibraryMigration<SqliteDb>> = [
      { version: 1, description: "baseline", up: upSpy1 },
      { version: 2, description: "follow-up", up: upSpy2 },
    ];
    const result = runMigrations(db, "playback", migrations);
    console.info(`[${SUITE}:sync:exec] result=${JSON.stringify(result)} v1=${upSpy1.mock.calls.length} v2=${upSpy2.mock.calls.length}`);

    try {
      expect(upSpy1).toHaveBeenCalledTimes(1);
      expect(upSpy2).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ from: 0, to: 2, applied: [1, 2] });
      expect(db._userVersion).toBe(2);
    } catch (err) {
      dumpRunnerSnapshot("apply-pending-wrong", {
        flavor: "sync",
        currentUserVersion: db._userVersion,
        registry: registrySummary(migrations),
        result,
        spyCallCounts: { v1: upSpy1.mock.calls.length, v2: upSpy2.mock.calls.length },
      });
      throw err;
    }
  });

  it("skips migrations at or below current user_version", () => {
    console.info(`[${SUITE}:sync:setup] db @ user_version=1, 2-mig registry — should only apply v2`);
    const db = buildSyncMockDb(1);
    const upSpy1 = vi.fn();
    const upSpy2 = vi.fn();
    const migrations: ReadonlyArray<LibraryMigration<SqliteDb>> = [
      { version: 1, description: "baseline", up: upSpy1 },
      { version: 2, description: "follow-up", up: upSpy2 },
    ];
    const result = runMigrations(db, "playback", migrations);
    console.info(`[${SUITE}:sync:exec] result=${JSON.stringify(result)} v1-skipped=${upSpy1.mock.calls.length === 0} v2-applied=${upSpy2.mock.calls.length === 1}`);

    try {
      expect(upSpy1).not.toHaveBeenCalled();
      expect(upSpy2).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ from: 1, to: 2, applied: [2] });
      expect(db._userVersion).toBe(2);
    } catch (err) {
      dumpRunnerSnapshot("skip-already-applied-wrong", {
        flavor: "sync",
        initialUserVersion: 1,
        currentUserVersion: db._userVersion,
        registry: registrySummary(migrations),
        result,
        spyCallCounts: { v1: upSpy1.mock.calls.length, v2: upSpy2.mock.calls.length },
      });
      throw err;
    }
  });

  it("is a no-op when current user_version equals target", () => {
    console.info(`[${SUITE}:sync:setup] db @ user_version=2, target=2 — pure no-op`);
    const db = buildSyncMockDb(2);
    const upSpy = vi.fn();
    const migrations: ReadonlyArray<LibraryMigration<SqliteDb>> = [
      { version: 1, description: "baseline", up: vi.fn() },
      { version: 2, description: "follow-up", up: upSpy },
    ];
    const result = runMigrations(db, "playback", migrations);
    console.info(`[${SUITE}:sync:exec] result=${JSON.stringify(result)} spy-called=${upSpy.mock.calls.length === 0 ? "no" : upSpy.mock.calls.length}`);

    try {
      expect(upSpy).not.toHaveBeenCalled();
      expect(result).toEqual({ from: 2, to: 2, applied: [] });
      expect(db._userVersion).toBe(2);
    } catch (err) {
      dumpRunnerSnapshot("equal-version-noop-wrong", {
        flavor: "sync",
        initialUserVersion: 2,
        currentUserVersion: db._userVersion,
        registry: registrySummary(migrations),
        result,
        spyCallCounts: { v2: upSpy.mock.calls.length },
      });
      throw err;
    }
  });

  it("rejects downgrade attempts (current > target) — throws LibraryFormatTooNewError", () => {
    // Previously threw a generic Error matching /migration_downgrade_blocked:core:current_5_target_1/.
    // Part C routed the downgrade block into the unified typed error so the UI
    // gets a clean "app too old" signal rather than a cryptic string match.
    console.info(`[${SUITE}:sync:setup] db @ user_version=5, registry tops out at v1 → must throw`);
    const db = buildSyncMockDb(5);
    const migrations: ReadonlyArray<LibraryMigration<SqliteDb>> = [
      { version: 1, description: "baseline", up: vi.fn() },
    ];
    let caught: LibraryFormatTooNewError | undefined;
    try {
      runMigrations(db, "core", migrations);
    } catch (e) {
      caught = e as LibraryFormatTooNewError;
    }
    console.info(`[${SUITE}:sync:exec] caught=${caught?.name} surface=${caught?.surface}`);

    try {
      expect(caught).toBeInstanceOf(LibraryFormatTooNewError);
      expect(caught!.surface).toBe("schema");
      expect(caught!.observed).toBe(5);
      expect(caught!.supported).toBe(1);
      expect(caught!.group).toBe("core");
      // user_version must be unchanged — the runner throws before any up() runs.
      expect(db._userVersion).toBe(5);
    } catch (err) {
      dumpRunnerSnapshot("downgrade-rejection-wrong", {
        flavor: "sync",
        currentUserVersion: db._userVersion,
        expectedUserVersion: 5,
        registry: registrySummary(migrations),
        caughtError: caught,
      });
      throw err;
    }
  });

  it("leaves user_version at last-successful version when a migration throws mid-batch", () => {
    console.info(`[${SUITE}:sync:setup] 3-mig registry; v2 throws — user_version must stay at 1`);
    const db = buildSyncMockDb();
    const upSpy1 = vi.fn();
    const upSpy2 = vi.fn(() => {
      throw new Error("boom");
    });
    const upSpy3 = vi.fn();
    const migrations: ReadonlyArray<LibraryMigration<SqliteDb>> = [
      { version: 1, description: "first", up: upSpy1 },
      { version: 2, description: "fails", up: upSpy2 },
      { version: 3, description: "never_runs", up: upSpy3 },
    ];
    console.info(`[${SUITE}:sync:exec] expecting throw /boom/`);

    try {
      expect(() => runMigrations(db, "ingest", migrations)).toThrow(/boom/);
      expect(upSpy1).toHaveBeenCalledTimes(1);
      expect(upSpy2).toHaveBeenCalledTimes(1);
      expect(upSpy3).not.toHaveBeenCalled();
      expect(db._userVersion).toBe(1);
    } catch (err) {
      dumpRunnerSnapshot("mid-batch-throw-state-wrong", {
        flavor: "sync",
        currentUserVersion: db._userVersion,
        expectedUserVersion: 1,
        registry: registrySummary(migrations),
        spyCallCounts: {
          v1: upSpy1.mock.calls.length,
          v2: upSpy2.mock.calls.length,
          v3: upSpy3.mock.calls.length,
        },
        execLogSample: db._execLog,
      });
      throw err;
    }
  });

  it("throws on duplicate migration versions", () => {
    console.info(`[${SUITE}:sync:setup] registry with duplicate version=1`);
    const db = buildSyncMockDb();
    const migrations: ReadonlyArray<LibraryMigration<SqliteDb>> = [
      { version: 1, description: "a", up: vi.fn() },
      { version: 1, description: "b", up: vi.fn() },
    ];
    try {
      expect(() => runMigrations(db, "core", migrations)).toThrow(
        /duplicate_migration_version:core:1/
      );
    } catch (err) {
      dumpRunnerSnapshot("duplicate-version-not-thrown", {
        flavor: "sync",
        registry: registrySummary(migrations),
        expectedThrowSubstr: "duplicate_migration_version:core:1",
      });
      throw err;
    }
  });

  it("throws on out-of-order migration versions", () => {
    console.info(`[${SUITE}:sync:setup] registry with out-of-order (v2 before v1)`);
    const db = buildSyncMockDb();
    const migrations: ReadonlyArray<LibraryMigration<SqliteDb>> = [
      { version: 2, description: "later", up: vi.fn() },
      { version: 1, description: "earlier", up: vi.fn() },
    ];
    try {
      expect(() => runMigrations(db, "metadata", migrations)).toThrow(
        /non_monotonic_migration_versions:metadata/
      );
    } catch (err) {
      dumpRunnerSnapshot("non-monotonic-not-thrown", {
        flavor: "sync",
        registry: registrySummary(migrations),
        expectedThrowSubstr: "non_monotonic_migration_versions:metadata",
      });
      throw err;
    }
  });

  it("throws on non-positive or non-integer versions", () => {
    console.info(`[${SUITE}:sync:setup] testing v=0 (must throw) and v=1.5 (must throw)`);
    const db = buildSyncMockDb();
    try {
      expect(() =>
        runMigrations(db, "core", [{ version: 0, description: "zero", up: vi.fn() }])
      ).toThrow(/invalid_migration_version:core:0/);
      expect(() =>
        runMigrations(db, "core", [{ version: 1.5, description: "float", up: vi.fn() }])
      ).toThrow(/invalid_migration_version:core:1\.5/);
    } catch (err) {
      dumpRunnerSnapshot("invalid-version-not-thrown", {
        flavor: "sync",
        expectedThrowSubstr: "invalid_migration_version:core:0|1.5",
      });
      throw err;
    }
  });

  it("passes group through to the logger", () => {
    console.info(`[${SUITE}:sync:setup] templates group; spy logger`);
    const db = buildSyncMockDb();
    const log = vi.fn();
    runMigrations(db, "templates", [{ version: 1, description: "t", up: vi.fn() }], {
      log,
    });
    const events = log.mock.calls.map((args) => args[0]);
    console.info(`[${SUITE}:sync:exec] log events=${JSON.stringify(events)}`);

    try {
      expect(events).toContain("library.migrations.start");
      expect(events).toContain("library.migrations.apply");
      expect(events).toContain("library.migrations.complete");
      for (const call of log.mock.calls) {
        expect(call[1]).toMatchObject({ group: "templates" });
      }
    } catch (err) {
      dumpRunnerSnapshot("logger-events-missing", {
        flavor: "sync",
        logCalls: log.mock.calls,
      });
      throw err;
    }
  });
});

describe("runMigrationsAsync (async)", () => {
  it("returns no-op on empty array", async () => {
    console.info(`[${SUITE}:async:setup] empty registry @ user_version=0`);
    const db = buildAsyncMockDb();
    const result = await runMigrationsAsync(db, "core", []);
    console.info(`[${SUITE}:async:exec] result=${JSON.stringify(result)} user_version=${db._userVersion}`);

    try {
      expect(result).toEqual({ from: 0, to: 0, applied: [] });
      expect(db._userVersion).toBe(0);
    } catch (err) {
      dumpRunnerSnapshot("async-empty-no-op-wrong", {
        flavor: "async",
        currentUserVersion: db._userVersion,
        result,
        registry: [],
      });
      throw err;
    }
  });

  it("does not throw on empty array when user_version is 0 (fresh-baseline)", async () => {
    // Async mirror of the sync fresh-baseline case — clean no-op, no throw.
    console.info(`[${SUITE}:async:setup] fresh baseline empty registry`);
    const db = buildAsyncMockDb(0);
    try {
      await expect(runMigrationsAsync(db, "core", [])).resolves.toEqual({
        from: 0,
        to: 0,
        applied: [],
      });
    } catch (err) {
      dumpRunnerSnapshot("async-fresh-baseline-broken", {
        flavor: "async",
        currentUserVersion: db._userVersion,
        registry: [],
      });
      throw err;
    }
  });

  it("@bugfix @regression-proof empty registry + user_version > 0 throws LibraryFormatTooNewError (async)", async () => {
    // Async mirror of the sync empty-registry regression proof — the
    // empty-array early return must not fire before the downgrade check.
    // Pre-fix this test FAILS (no throw); post-fix it PASSES.
    console.info(`[${SUITE}:async:setup] @bugfix empty registry + user_version=3 (must throw async)`);
    const db = buildAsyncMockDb(3);
    let caught: LibraryFormatTooNewError | undefined;
    try {
      await runMigrationsAsync(db, "core", []);
    } catch (e) {
      caught = e as LibraryFormatTooNewError;
    }
    console.info(`[${SUITE}:async:exec] caught=${caught?.name} surface=${caught?.surface} observed=${caught?.observed}`);

    try {
      expect(caught).toBeInstanceOf(LibraryFormatTooNewError);
      expect(caught!.surface).toBe("schema");
      expect(caught!.observed).toBe(3);
      expect(caught!.supported).toBe(0);
      expect(caught!.group).toBe("core");
      expect(db._userVersion).toBe(3);
    } catch (err) {
      dumpRunnerSnapshot("async-empty-registry-downgrade-bug-regressed", {
        flavor: "async",
        currentUserVersion: db._userVersion,
        expectedUserVersion: 3,
        caughtError: caught,
      });
      throw err;
    }
  });

  it("applies pending migrations in order and bumps user_version after each", async () => {
    console.info(`[${SUITE}:async:setup] empty db, 2-migration async registry`);
    const db = buildAsyncMockDb();
    const upSpy1 = vi.fn(async () => {});
    const upSpy2 = vi.fn(async () => {});
    const migrations: ReadonlyArray<AsyncLibraryMigration<typeof db>> = [
      { version: 1, description: "baseline", up: upSpy1 },
      { version: 2, description: "follow-up", up: upSpy2 },
    ];
    const result = await runMigrationsAsync(db, "playback", migrations);
    console.info(`[${SUITE}:async:exec] result=${JSON.stringify(result)} v1=${upSpy1.mock.calls.length} v2=${upSpy2.mock.calls.length}`);

    try {
      expect(upSpy1).toHaveBeenCalledTimes(1);
      expect(upSpy2).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ from: 0, to: 2, applied: [1, 2] });
      expect(db._userVersion).toBe(2);
    } catch (err) {
      dumpRunnerSnapshot("async-apply-pending-wrong", {
        flavor: "async",
        currentUserVersion: db._userVersion,
        registry: registrySummary(migrations),
        result,
        spyCallCounts: { v1: upSpy1.mock.calls.length, v2: upSpy2.mock.calls.length },
      });
      throw err;
    }
  });

  it("skips migrations at or below current user_version", async () => {
    console.info(`[${SUITE}:async:setup] db @ user_version=1, 2-mig registry — should only apply v2`);
    const db = buildAsyncMockDb(1);
    const upSpy1 = vi.fn(async () => {});
    const upSpy2 = vi.fn(async () => {});
    const migrations: ReadonlyArray<AsyncLibraryMigration<typeof db>> = [
      { version: 1, description: "baseline", up: upSpy1 },
      { version: 2, description: "follow-up", up: upSpy2 },
    ];
    const result = await runMigrationsAsync(db, "playback", migrations);
    console.info(`[${SUITE}:async:exec] result=${JSON.stringify(result)} v1=${upSpy1.mock.calls.length} v2=${upSpy2.mock.calls.length}`);

    try {
      expect(upSpy1).not.toHaveBeenCalled();
      expect(upSpy2).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ from: 1, to: 2, applied: [2] });
      expect(db._userVersion).toBe(2);
    } catch (err) {
      dumpRunnerSnapshot("async-skip-applied-wrong", {
        flavor: "async",
        initialUserVersion: 1,
        currentUserVersion: db._userVersion,
        registry: registrySummary(migrations),
        result,
        spyCallCounts: { v1: upSpy1.mock.calls.length, v2: upSpy2.mock.calls.length },
      });
      throw err;
    }
  });

  it("leaves user_version at last-successful version when a migration rejects mid-batch", async () => {
    console.info(`[${SUITE}:async:setup] 3-mig registry; v2 rejects — user_version must stay at 1`);
    const db = buildAsyncMockDb();
    const upSpy1 = vi.fn(async () => {});
    const upSpy2 = vi.fn(async () => {
      throw new Error("async-boom");
    });
    const upSpy3 = vi.fn(async () => {});
    const migrations: ReadonlyArray<AsyncLibraryMigration<typeof db>> = [
      { version: 1, description: "first", up: upSpy1 },
      { version: 2, description: "fails", up: upSpy2 },
      { version: 3, description: "never_runs", up: upSpy3 },
    ];

    try {
      await expect(runMigrationsAsync(db, "ingest", migrations)).rejects.toThrow(
        /async-boom/
      );
      expect(upSpy1).toHaveBeenCalledTimes(1);
      expect(upSpy2).toHaveBeenCalledTimes(1);
      expect(upSpy3).not.toHaveBeenCalled();
      expect(db._userVersion).toBe(1);
    } catch (err) {
      dumpRunnerSnapshot("async-mid-batch-reject-state-wrong", {
        flavor: "async",
        currentUserVersion: db._userVersion,
        expectedUserVersion: 1,
        registry: registrySummary(migrations),
        spyCallCounts: {
          v1: upSpy1.mock.calls.length,
          v2: upSpy2.mock.calls.length,
          v3: upSpy3.mock.calls.length,
        },
        execLogSample: db._execLog,
      });
      throw err;
    }
  });

  it("rejects downgrade attempts — throws LibraryFormatTooNewError (async)", async () => {
    // Mirror of the sync downgrade test above. Same Part C change applies to
    // runMigrationsAsync: generic error replaced with typed LibraryFormatTooNewError.
    console.info(`[${SUITE}:async:setup] db @ user_version=5; registry tops at v1`);
    const db = buildAsyncMockDb(5);
    const migrations: ReadonlyArray<AsyncLibraryMigration<typeof db>> = [
      { version: 1, description: "baseline", up: vi.fn(async () => {}) },
    ];
    let caught: LibraryFormatTooNewError | undefined;
    try {
      await runMigrationsAsync(db, "core", migrations);
    } catch (e) {
      caught = e as LibraryFormatTooNewError;
    }
    console.info(`[${SUITE}:async:exec] caught=${caught?.name} surface=${caught?.surface}`);

    try {
      expect(caught).toBeInstanceOf(LibraryFormatTooNewError);
      expect(caught!.surface).toBe("schema");
      expect(caught!.observed).toBe(5);
      expect(caught!.supported).toBe(1);
      expect(caught!.group).toBe("core");
      expect(db._userVersion).toBe(5);
    } catch (err) {
      dumpRunnerSnapshot("async-downgrade-rejection-wrong", {
        flavor: "async",
        currentUserVersion: db._userVersion,
        expectedUserVersion: 5,
        registry: registrySummary(migrations),
        caughtError: caught,
      });
      throw err;
    }
  });

  it("throws on duplicate / out-of-order / invalid versions", async () => {
    console.info(`[${SUITE}:async:setup] testing duplicate/non-monotonic/invalid versions in async path`);
    const db = buildAsyncMockDb();
    try {
      await expect(
        runMigrationsAsync(db, "core", [
          { version: 1, description: "a", up: vi.fn(async () => {}) },
          { version: 1, description: "b", up: vi.fn(async () => {}) },
        ])
      ).rejects.toThrow(/duplicate_migration_version:core:1/);
      await expect(
        runMigrationsAsync(db, "metadata", [
          { version: 2, description: "later", up: vi.fn(async () => {}) },
          { version: 1, description: "earlier", up: vi.fn(async () => {}) },
        ])
      ).rejects.toThrow(/non_monotonic_migration_versions:metadata/);
      await expect(
        runMigrationsAsync(db, "core", [
          { version: 0, description: "zero", up: vi.fn(async () => {}) },
        ])
      ).rejects.toThrow(/invalid_migration_version:core:0/);
    } catch (err) {
      dumpRunnerSnapshot("async-validation-not-thrown", {
        flavor: "async",
        expectedThrowSubstr: "duplicate/non_monotonic/invalid",
      });
      throw err;
    }
  });

  it("passes group through to the logger", async () => {
    console.info(`[${SUITE}:async:setup] templates group; spy logger (async)`);
    const db = buildAsyncMockDb();
    const log = vi.fn();
    await runMigrationsAsync(
      db,
      "templates",
      [{ version: 1, description: "t", up: vi.fn(async () => {}) }],
      { log }
    );
    const events = log.mock.calls.map((args) => args[0]);
    console.info(`[${SUITE}:async:exec] log events=${JSON.stringify(events)}`);

    try {
      expect(events).toContain("library.migrations.start");
      expect(events).toContain("library.migrations.apply");
      expect(events).toContain("library.migrations.complete");
      for (const call of log.mock.calls) {
        expect(call[1]).toMatchObject({ group: "templates" });
      }
    } catch (err) {
      dumpRunnerSnapshot("async-logger-events-missing", {
        flavor: "async",
        logCalls: log.mock.calls,
      });
      throw err;
    }
  });

  it("supports synchronous up() (returns void, not Promise)", async () => {
    console.info(`[${SUITE}:async:setup] async runner with synchronous (void) up() body`);
    const db = buildAsyncMockDb();
    let ran = false;
    const migrations: ReadonlyArray<AsyncLibraryMigration<typeof db>> = [
      {
        version: 1,
        description: "sync_up",
        up: () => {
          ran = true;
        },
      },
    ];
    const result = await runMigrationsAsync(db, "core", migrations);
    console.info(`[${SUITE}:async:exec] ran=${ran} result=${JSON.stringify(result)} user_version=${db._userVersion}`);

    try {
      expect(ran).toBe(true);
      expect(result.applied).toEqual([1]);
      expect(db._userVersion).toBe(1);
    } catch (err) {
      dumpRunnerSnapshot("async-sync-up-not-supported", {
        flavor: "async",
        currentUserVersion: db._userVersion,
        registry: registrySummary(migrations),
        result,
      });
      throw err;
    }
  });
});
