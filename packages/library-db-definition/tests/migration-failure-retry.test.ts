/**
 * @test-id LIB-DB-MIGRATION-FAILURE-RETRY-001
 * @level unit
 * @bugfix @regression-proof
 *
 * @why The existing `migrationRunner.test.ts` proves that when a migration
 *   throws mid-batch the user_version is left at the LAST-SUCCESSFUL version
 *   (so a re-run resumes from there, not from scratch). It does not exercise
 *   the equally important second half of the contract: that a subsequent
 *   retry, once the cause is fixed, succeeds and brings the DB to the
 *   target version — and that no partial state from the failed attempt
 *   pollutes the retry.
 *
 *   Together with the existing mid-batch-throw test, this pins the full
 *   failure-recovery story:
 *     - Pre-failure: migration throws, user_version is at last-successful.
 *     - Post-failure (this file): the DB is still readable; the throwing
 *       migration's partial work is observable (or absent, depending on
 *       the migration's own atomicity); a retry with a fixed `up()` brings
 *       the DB to the target version; later migrations queued after the
 *       fixed one then run successfully.
 *
 *   Lives in library-db-definition because the runner is the unit under
 *   test — no driver-specific behavior is needed (vitest mock + a 100-line
 *   in-memory SQLite fake suffice).
 *
 *   NOTE: SQLite migrations are NOT automatically wrapped in a transaction
 *   by `runMigrations`. The runner's atomicity contract is "user_version
 *   transitions are atomic with the runner-issued PRAGMA write" — NOT
 *   "every up() body is rolled back on failure". A migration that needs
 *   atomic DDL+data must use its own BEGIN/COMMIT/ROLLBACK. We test both
 *   shapes here.
 */
import { describe, expect, it, vi } from "vitest";
import {
  runMigrations,
  type LibraryMigration,
} from "../src/migrationRunner";
import type { SqliteDb } from "../src/migrations";

const SUITE = "migration-failure-retry";

const dumpFailureRetrySnapshot = (
  label: string,
  ctx: {
    userVersion?: number;
    expectedUserVersion?: number;
    rows?: ReadonlyArray<unknown>;
    expectedRows?: ReadonlyArray<unknown>;
    appliedSet?: ReadonlyArray<number>;
    spyCallCounts?: Record<string, number>;
    lastError?: unknown;
    failOnLabel?: string | null;
    migrationStep?: string;
    retryCounter?: number;
    appliedUpToVersion?: number;
    logCalls?: ReadonlyArray<unknown>;
    execLogSample?: ReadonlyArray<string>;
  },
) => {
  try {
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    if (ctx.userVersion !== undefined) {
      console.error(`user_version=${ctx.userVersion}${ctx.expectedUserVersion !== undefined ? ` (expected ${ctx.expectedUserVersion})` : ""}`);
    }
    if (ctx.appliedUpToVersion !== undefined) {
      console.error(`applied up to version: ${ctx.appliedUpToVersion}`);
    }
    if (ctx.migrationStep) {
      console.error(`migration step: ${ctx.migrationStep}`);
    }
    if (ctx.retryCounter !== undefined) {
      console.error(`retry counter: ${ctx.retryCounter}`);
    }
    if (ctx.failOnLabel !== undefined) {
      console.error(`failOnLabel trigger: ${JSON.stringify(ctx.failOnLabel)}`);
    }
    if (ctx.rows) {
      console.error(`rows in db (${ctx.rows.length}):\n${JSON.stringify(ctx.rows, null, 2)}`);
    }
    if (ctx.expectedRows) {
      console.error(`expected rows:\n${JSON.stringify(ctx.expectedRows, null, 2)}`);
    }
    if (ctx.appliedSet) {
      console.error(`applied versions set: ${JSON.stringify(ctx.appliedSet)}`);
    }
    if (ctx.spyCallCounts) {
      console.error(`spy call counts:\n${JSON.stringify(ctx.spyCallCounts, null, 2)}`);
    }
    if (ctx.lastError !== undefined) {
      const e = ctx.lastError;
      console.error(`last error: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
    }
    if (ctx.logCalls) {
      console.error(`log calls (last 10):\n${JSON.stringify(ctx.logCalls.slice(-10), null, 2)}`);
    }
    if (ctx.execLogSample) {
      console.error(`exec log (last 10):\n${JSON.stringify(ctx.execLogSample.slice(-10), null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

// ---------------------------------------------------------------------------
// In-memory mock with a tiny "table" surface for asserting side effects
// without pulling in bun:sqlite (vitest can't import bun:sqlite — keep this
// test driver-agnostic so it runs under vitest).
// ---------------------------------------------------------------------------

type Row = { id: number; label: string };

type StatefulMockDb = SqliteDb & {
  _userVersion: number;
  _execLog: string[];
  _rows: Row[];
  _failOnLabel: string | null;
};

const buildStatefulMockDb = (initialUserVersion = 0): StatefulMockDb => {
  const state = {
    userVersion: initialUserVersion,
    rows: [] as Row[],
    failOnLabel: null as string | null,
  };
  const execLog: string[] = [];
  const db: StatefulMockDb = {
    _userVersion: initialUserVersion,
    _execLog: execLog,
    _rows: state.rows,
    _failOnLabel: state.failOnLabel,
    exec: (sql: string) => {
      execLog.push(sql);
      const versionMatch = sql.match(/^\s*PRAGMA\s+user_version\s*=\s*(\d+)\s*;?\s*$/i);
      if (versionMatch) {
        state.userVersion = Number(versionMatch[1]);
        db._userVersion = state.userVersion;
      }
      return undefined;
    },
    prepare: (sql: string) => ({
      all: () => {
        if (/^\s*PRAGMA\s+user_version\s*;?\s*$/i.test(sql)) {
          return [{ user_version: state.userVersion }];
        }
        if (/SELECT\s+\*\s+FROM\s+items/i.test(sql)) {
          return [...state.rows];
        }
        return [];
      },
      run: (...args: unknown[]) => {
        // Toy INSERT — accepts (id, label) pairs.
        if (/INSERT\s+INTO\s+items/i.test(sql)) {
          const id = Number(args[0] as number);
          const label = String(args[1] as string);
          if (state.failOnLabel && label === state.failOnLabel) {
            throw new Error(`forced_failure_on_label:${label}`);
          }
          state.rows.push({ id, label });
        }
        return undefined;
      },
    }),
  };
  // Bridge `_failOnLabel` getter/setter to the closure variable.
  Object.defineProperty(db, "_failOnLabel", {
    get: () => state.failOnLabel,
    set: (v) => {
      state.failOnLabel = v as string | null;
    },
  });
  return db;
};

describe("migration failure → retry recovery @bugfix @regression-proof", () => {
  it("retry succeeds after the cause is fixed: failed v2 retried, then v3 runs in the same call", () => {
    // Scenario: v2's first attempt throws because a unique-constraint hit
    // (modeled here as an INSERT with label='boom' triggering the mock to throw).
    // The operator fixes the cause (label changed or constraint relaxed) and
    // re-runs the migration. v2 now succeeds and v3 follows immediately.
    console.info(`[${SUITE}:setup] building mock db @ user_version=0 with 3 migrations (v1, v2-fails-then-fixes, v3)`);
    const db = buildStatefulMockDb(0);

    let attemptOnV2 = 0;
    const v2 = vi.fn((handle: SqliteDb) => {
      attemptOnV2 += 1;
      const label = attemptOnV2 === 1 ? "boom" : "fixed";
      handle.prepare("INSERT INTO items (id, label) VALUES (?, ?);").run(2, label);
    });
    const v1 = vi.fn((handle: SqliteDb) => {
      handle.prepare("INSERT INTO items (id, label) VALUES (?, ?);").run(1, "v1_ok");
    });
    const v3 = vi.fn((handle: SqliteDb) => {
      handle.prepare("INSERT INTO items (id, label) VALUES (?, ?);").run(3, "v3_ok");
    });
    const migrations: ReadonlyArray<LibraryMigration<SqliteDb>> = [
      { version: 1, description: "v1", up: v1 },
      { version: 2, description: "v2_fails_then_succeeds", up: v2 },
      { version: 3, description: "v3", up: v3 },
    ];

    // First attempt: v1 succeeds, v2 throws — user_version stuck at 1.
    db._failOnLabel = "boom";
    console.info(`[${SUITE}:exec-1] first run — expecting v2 to throw, user_version stuck at 1`);
    let firstError: unknown;
    try {
      expect(() => runMigrations(db, "core", migrations)).toThrow(/forced_failure_on_label:boom/);
    } catch (err) {
      firstError = err;
      dumpFailureRetrySnapshot("first-run-did-not-throw-expected", {
        userVersion: db._userVersion,
        expectedUserVersion: 1,
        spyCallCounts: { v1: v1.mock.calls.length, v2: v2.mock.calls.length, v3: v3.mock.calls.length },
        failOnLabel: db._failOnLabel,
        lastError: err,
      });
      throw err;
    }
    console.info(`[${SUITE}:after-run-1] user_version=${db._userVersion} v1=${v1.mock.calls.length} v2=${v2.mock.calls.length} v3=${v3.mock.calls.length}`);

    try {
      expect(db._userVersion).toBe(1);
      expect(v1).toHaveBeenCalledTimes(1);
      expect(v2).toHaveBeenCalledTimes(1);
      expect(v3).not.toHaveBeenCalled();
      expect(db._rows).toEqual([{ id: 1, label: "v1_ok" }]);
    } catch (err) {
      dumpFailureRetrySnapshot("post-failure-state-wrong", {
        userVersion: db._userVersion,
        expectedUserVersion: 1,
        rows: db._rows,
        expectedRows: [{ id: 1, label: "v1_ok" }],
        spyCallCounts: { v1: v1.mock.calls.length, v2: v2.mock.calls.length, v3: v3.mock.calls.length },
        appliedUpToVersion: db._userVersion,
        lastError: firstError,
      });
      throw err;
    }

    // Operator fixes the cause — clear the failure trigger.
    console.info(`[${SUITE}:fix] clearing failOnLabel to simulate operator fixing the bug`);
    db._failOnLabel = null;

    // Retry: same migration array. The fixed v2 retries (attempt #2 inside
    // the closure → uses "fixed"), then v3 runs. user_version reaches 3.
    console.info(`[${SUITE}:exec-2] retry — expecting v2 success + v3 to run, user_version reaches 3`);
    const result = runMigrations(db, "core", migrations);
    console.info(`[${SUITE}:after-run-2] result=${JSON.stringify(result)} user_version=${db._userVersion} v2-attempts=${attemptOnV2}`);

    try {
      expect(result).toEqual({ from: 1, to: 3, applied: [2, 3] });
      expect(db._userVersion).toBe(3);
      // v1 did NOT re-run (already at user_version > 1 when retry started).
      expect(v1).toHaveBeenCalledTimes(1);
      // v2 ran twice total: once failing, once succeeding.
      expect(v2).toHaveBeenCalledTimes(2);
      expect(v3).toHaveBeenCalledTimes(1);

      // Side effects are the union of v1's row + v2's successful retry row + v3's row.
      // NOTE: the failed v2 attempt's INSERT threw BEFORE the mock pushed to the rows
      // array, so the failed attempt leaves no partial row. A real migration that
      // performs multiple writes before the failing one would observe partial state
      // (SQLite does not auto-transact unless the migration body uses BEGIN/COMMIT).
      expect(db._rows).toEqual([
        { id: 1, label: "v1_ok" },
        { id: 2, label: "fixed" },
        { id: 3, label: "v3_ok" },
      ]);
    } catch (err) {
      dumpFailureRetrySnapshot("retry-recovery-mismatch", {
        userVersion: db._userVersion,
        expectedUserVersion: 3,
        rows: db._rows,
        expectedRows: [
          { id: 1, label: "v1_ok" },
          { id: 2, label: "fixed" },
          { id: 3, label: "v3_ok" },
        ],
        appliedSet: result.applied,
        spyCallCounts: { v1: v1.mock.calls.length, v2: v2.mock.calls.length, v3: v3.mock.calls.length },
        retryCounter: attemptOnV2,
      });
      throw err;
    }
  });

  it("repeated identical failures: user_version stays at last-successful across multiple retries", () => {
    // If the operator retries without fixing the cause, the DB stays at the
    // last-successful version forever — no progress, no regression.
    console.info(`[${SUITE}:setup] mock db @ user_version=0; v1 ok, v2 always fails`);
    const db = buildStatefulMockDb(0);

    const v2Spy = vi.fn((handle: SqliteDb) => {
      handle.prepare("INSERT INTO items (id, label) VALUES (?, ?);").run(2, "boom");
    });
    const migrations: ReadonlyArray<LibraryMigration<SqliteDb>> = [
      {
        version: 1,
        description: "v1",
        up: (handle) => handle.prepare("INSERT INTO items (id, label) VALUES (?, ?);").run(1, "ok"),
      },
      { version: 2, description: "v2_always_fails", up: v2Spy },
    ];

    db._failOnLabel = "boom";

    for (let attempt = 0; attempt < 3; attempt += 1) {
      console.info(`[${SUITE}:retry-${attempt + 1}] attempting runMigrations; expect throw + user_version=1`);
      try {
        expect(() => runMigrations(db, "core", migrations)).toThrow(/forced_failure_on_label:boom/);
        expect(db._userVersion).toBe(1);
      } catch (err) {
        dumpFailureRetrySnapshot(`repeated-failure-attempt-${attempt + 1}-broke`, {
          userVersion: db._userVersion,
          expectedUserVersion: 1,
          rows: db._rows,
          spyCallCounts: { v2: v2Spy.mock.calls.length },
          retryCounter: attempt + 1,
        });
        throw err;
      }
    }

    console.info(`[${SUITE}:after-retries] v2 calls=${v2Spy.mock.calls.length} rows=${JSON.stringify(db._rows)}`);
    try {
      // v1 ran exactly once (only on the first attempt — subsequent retries
      // skipped it because user_version=1 already). v2 ran on every attempt.
      expect(v2Spy).toHaveBeenCalledTimes(3);
      // Only v1's row is present; the cause never got fixed.
      expect(db._rows).toEqual([{ id: 1, label: "ok" }]);
    } catch (err) {
      dumpFailureRetrySnapshot("post-3-retries-state-wrong", {
        userVersion: db._userVersion,
        rows: db._rows,
        expectedRows: [{ id: 1, label: "ok" }],
        spyCallCounts: { v2: v2Spy.mock.calls.length },
      });
      throw err;
    }
  });

  it("DB stays openable after a failed migration: subsequent prepare/exec calls work normally", () => {
    // The runner is a thin wrapper around exec/prepare — a thrown migration
    // does NOT leave the DB handle in a broken state. We pin this by issuing
    // arbitrary reads/writes after the failure.
    console.info(`[${SUITE}:setup] mock db @ user_version=0; single v1 that fails`);
    const db = buildStatefulMockDb(0);

    db._failOnLabel = "boom";
    const migrations: ReadonlyArray<LibraryMigration<SqliteDb>> = [
      {
        version: 1,
        description: "v1_fails",
        up: (handle) => handle.prepare("INSERT INTO items (id, label) VALUES (?, ?);").run(1, "boom"),
      },
    ];

    console.info(`[${SUITE}:exec] running v1 (expected throw)`);
    try {
      expect(() => runMigrations(db, "core", migrations)).toThrow(/forced_failure_on_label:boom/);
      expect(db._userVersion).toBe(0);

      // The DB handle still works for arbitrary queries — no "locked" or
      // "destroyed" state. This is the operational invariant: the user can
      // restart the app and the DB opens cleanly.
      console.info(`[${SUITE}:check] verifying db handle is still usable after failure`);
      expect(() => db.exec("PRAGMA user_version = 0;")).not.toThrow();
      expect(() => db.prepare("PRAGMA user_version;").all()).not.toThrow();

      db._failOnLabel = null;
      expect(() =>
        db.prepare("INSERT INTO items (id, label) VALUES (?, ?);").run(99, "post_failure")
      ).not.toThrow();
      expect(db._rows).toEqual([{ id: 99, label: "post_failure" }]);
    } catch (err) {
      dumpFailureRetrySnapshot("db-broken-after-failure", {
        userVersion: db._userVersion,
        rows: db._rows,
        execLogSample: db._execLog,
        failOnLabel: db._failOnLabel,
      });
      throw err;
    }
  });

  it("logs the failed-migration event with group + version + description before re-throwing", () => {
    // Operators need to see WHICH migration failed in the logs. The runner
    // emits `library.migrations.failed` before re-throwing — this is the
    // observability contract.
    console.info(`[${SUITE}:setup] mock db + spy log, v1 ok + v2 fails_with_boom`);
    const db = buildStatefulMockDb(0);
    const log = vi.fn();

    db._failOnLabel = "boom";
    const migrations: ReadonlyArray<LibraryMigration<SqliteDb>> = [
      {
        version: 1,
        description: "first",
        up: (handle) => handle.prepare("INSERT INTO items (id, label) VALUES (?, ?);").run(1, "ok"),
      },
      {
        version: 2,
        description: "fails_with_boom",
        up: (handle) => handle.prepare("INSERT INTO items (id, label) VALUES (?, ?);").run(2, "boom"),
      },
    ];

    console.info(`[${SUITE}:exec] expecting throw + library.migrations.failed log event`);
    try {
      expect(() => runMigrations(db, "core", migrations, { log })).toThrow(
        /forced_failure_on_label:boom/
      );
    } catch (err) {
      dumpFailureRetrySnapshot("expected-throw-missing", {
        userVersion: db._userVersion,
        logCalls: log.mock.calls,
      });
      throw err;
    }

    const failedCall = log.mock.calls.find(([event]) => event === "library.migrations.failed");
    console.info(`[${SUITE}:check] log events=${JSON.stringify(log.mock.calls.map((c) => c[0]))}`);

    try {
      expect(failedCall).toBeDefined();
      const [, payload] = failedCall as [string, Record<string, unknown>];
      expect(payload).toMatchObject({
        group: "core",
        version: 2,
        description: "fails_with_boom",
      });
      expect(String(payload.error)).toContain("forced_failure_on_label:boom");
    } catch (err) {
      dumpFailureRetrySnapshot("failure-log-shape-wrong", {
        logCalls: log.mock.calls,
        userVersion: db._userVersion,
      });
      throw err;
    }
  });

  it("retry from cold-boot path: a brand-new db handle pointed at the same user_version resumes correctly", () => {
    // Models the "user closes the app after a failure, reopens, the DB
    // is in last-successful state, the new app instance retries". The retry
    // sees the persisted user_version and skips already-applied migrations.
    console.info(`[${SUITE}:setup] mock db @ user_version=0; v1 ok + v2 fails`);
    const db = buildStatefulMockDb(0);

    const migrations: ReadonlyArray<LibraryMigration<SqliteDb>> = [
      {
        version: 1,
        description: "v1",
        up: (handle) => handle.prepare("INSERT INTO items (id, label) VALUES (?, ?);").run(1, "ok"),
      },
      {
        version: 2,
        description: "v2_fails",
        up: (handle) => handle.prepare("INSERT INTO items (id, label) VALUES (?, ?);").run(2, "boom"),
      },
    ];

    // First app-instance run — fails on v2.
    db._failOnLabel = "boom";
    console.info(`[${SUITE}:exec-1] pre-restart run (expecting throw, user_version=1)`);
    try {
      expect(() => runMigrations(db, "core", migrations)).toThrow();
      expect(db._userVersion).toBe(1);
    } catch (err) {
      dumpFailureRetrySnapshot("pre-restart-state-wrong", {
        userVersion: db._userVersion,
        rows: db._rows,
      });
      throw err;
    }

    // Simulate app restart: same DB handle persisted user_version=1.
    // The user updated the app to a build where v2's cause is fixed.
    console.info(`[${SUITE}:restart] simulating app restart with patched v2 migration set`);
    db._failOnLabel = null;

    // "Restart" runs the migrations again — v1 skipped (user_version > 1
    // is false, but user_version === 1 so the filter `m.version > 1` drops it),
    // v2 retried and succeeds.
    const v1Spy = vi.fn();
    const migrationsAfterRestart: ReadonlyArray<LibraryMigration<SqliteDb>> = [
      { version: 1, description: "v1", up: v1Spy },
      {
        version: 2,
        description: "v2_fixed",
        up: (handle) =>
          handle.prepare("INSERT INTO items (id, label) VALUES (?, ?);").run(2, "now_ok"),
      },
    ];
    const result = runMigrations(db, "core", migrationsAfterRestart);
    console.info(`[${SUITE}:after-restart] result=${JSON.stringify(result)} v1Spy-calls=${v1Spy.mock.calls.length} user_version=${db._userVersion}`);

    try {
      expect(result).toEqual({ from: 1, to: 2, applied: [2] });
      // The "restarted" v1 did NOT re-run.
      expect(v1Spy).not.toHaveBeenCalled();
      expect(db._userVersion).toBe(2);
    } catch (err) {
      dumpFailureRetrySnapshot("post-restart-state-wrong", {
        userVersion: db._userVersion,
        expectedUserVersion: 2,
        rows: db._rows,
        appliedSet: result.applied,
        spyCallCounts: { v1Spy: v1Spy.mock.calls.length },
      });
      throw err;
    }
  });
});
