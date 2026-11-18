/**
 * @test-id LIB-DB-MIGRATIONS-MULTI-001
 * @level unit
 * @why Phase 1 of the library-db unification — ensureLibrarySchema gained a
 *   group-aware signature so each per-group SQLite file (Phase 3 desktop +
 *   Phase 2 mobile) can be created from the same shared runner. The legacy
 *   single-arg signature must keep working byte-for-byte for today's
 *   monolithic desktop until Phase 3 lands.
 */
import { describe, expect, it } from "vitest";
import {
  ensureAllLibrarySchemas,
  ensureLibrarySchema,
  type LibraryDbSet,
  type SqliteDb,
} from "../src/migrations";
import { ALL_LIBRARY_DB_GROUPS, tableGroups, type LibraryDbGroup } from "../src/manifest";
import { straySystemPlaylistsQuery } from "../src/systemPlaylists";

const SUITE = "multi-group-migrations";

/** The first statement `ensureSystemPlaylists` prepares (LIB-SYNC-10): marks that the system-playlist pass ran. */
const SYSTEM_PLAYLISTS_MARKER = straySystemPlaylistsQuery()[0];

const buildMockDb = () => {
  const executed: string[] = [];
  const prepared: string[] = [];
  const db: SqliteDb = {
    exec: (sql: string) => {
      executed.push(sql);
      return undefined;
    },
    prepare: (sql: string) => {
      prepared.push(sql);
      return {
        all: () => [],
        run: () => undefined,
      };
    },
  };
  return { db, executed, prepared };
};

const tablesInExecutedSql = (executed: string[]): Set<string> => {
  const sql = executed.join("\n");
  const matches = sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z_]+)/g);
  const tables = new Set<string>();
  for (const match of matches) {
    tables.add(match[1]!);
  }
  return tables;
};

const expectedTablesForGroup = (group: LibraryDbGroup): string[] =>
  Object.entries(tableGroups)
    .filter(([, g]) => g === group)
    .map(([name]) => name);

const dumpMultiGroupSnapshot = (
  label: string,
  ctx: {
    group?: LibraryDbGroup | string;
    perGroupState?: Record<string, { executedCount: number; preparedCount: number; createdTables: string[] }>;
    diff?: Record<string, ReadonlyArray<string>>;
    appliedMarkers?: ReadonlyArray<string>;
    note?: string;
  } = {},
) => {
  try {
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    if (ctx.note) console.error(`note: ${ctx.note}`);
    if (ctx.group) console.error(`group: ${ctx.group}`);
    if (ctx.perGroupState) {
      console.error(`per-group migration state:\n${JSON.stringify(ctx.perGroupState, null, 2)}`);
    }
    if (ctx.appliedMarkers) {
      console.error(`applied backfill markers (SQL fragments):\n${JSON.stringify(ctx.appliedMarkers, null, 2)}`);
    }
    if (ctx.diff) {
      console.error(`diff:\n${JSON.stringify(ctx.diff, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

const summarizeMocks = (
  mocks: Record<string, ReturnType<typeof buildMockDb>>,
) => {
  const out: Record<string, { executedCount: number; preparedCount: number; createdTables: string[] }> = {};
  for (const [group, mock] of Object.entries(mocks)) {
    out[group] = {
      executedCount: mock.executed.length,
      preparedCount: mock.prepared.length,
      createdTables: [...tablesInExecutedSql(mock.executed)].sort(),
    };
  }
  return out;
};

describe("ensureLibrarySchema(db, group) — per-group form", () => {
  for (const group of ALL_LIBRARY_DB_GROUPS) {
    it(`creates exactly the tables in the "${group}" group`, () => {
      const expected = new Set(expectedTablesForGroup(group));
      console.info(
        `[${SUITE}:per-group:${group}] expectedTables=${[...expected].length} list=${JSON.stringify([...expected])}`,
      );
      const mock = buildMockDb();
      ensureLibrarySchema(mock.db, group);

      const createdTables = tablesInExecutedSql(mock.executed);
      console.info(
        `[${SUITE}:per-group:${group}] createdTables=${createdTables.size} list=${JSON.stringify([...createdTables])}`,
      );

      const missing = [...expected].filter((t) => !createdTables.has(t));
      const leaked = [...createdTables].filter((t) => !expected.has(t));
      try {
        // Every expected table is created.
        for (const tableName of expected) {
          expect(createdTables.has(tableName), `expected ${tableName} in ${group} group DDL`).toBe(true);
        }
        // No tables from other groups leak in.
        for (const tableName of createdTables) {
          expect(expected.has(tableName), `unexpected ${tableName} in ${group} group DDL`).toBe(true);
        }
      } catch (err) {
        dumpMultiGroupSnapshot("per-group-leak-or-missing", {
          group,
          diff: { missing, leaked },
          note: "per-group form must create exactly its tables — no leak from other groups",
        });
        throw err;
      }
    });
  }

  it("does NOT run cross-group backfills in per-group mode (no system-playlist pass)", () => {
    console.info(`[${SUITE}:cross-group-isolation] running ensureLibrarySchema(db, "core")`);
    const mock = buildMockDb();
    ensureLibrarySchema(mock.db, "core");
    const fragment = SYSTEM_PLAYLISTS_MARKER;
    const found = mock.prepared.some((sql) => sql.includes(fragment));
    console.info(`[${SUITE}:cross-group-isolation] backfill-fragment-found=${found}`);
    try {
      expect(found).toBe(false);
    } catch (err) {
      dumpMultiGroupSnapshot("per-group-ran-cross-group-backfill", {
        group: "core",
        perGroupState: { core: { executedCount: mock.executed.length, preparedCount: mock.prepared.length, createdTables: [...tablesInExecutedSql(mock.executed)].sort() } },
        appliedMarkers: mock.prepared.filter((s) => s.includes(fragment)),
        note: "per-group form must not invoke ensureDefaultPlaylists",
      });
      throw err;
    }
  });
});

describe("ensureLibrarySchema(db) — legacy single-arg form (backward compat)", () => {
  it("still creates all tables in one DB and runs cross-group backfills", () => {
    console.info(`[${SUITE}:legacy] running ensureLibrarySchema(db) — single-arg form`);
    const mock = buildMockDb();
    ensureLibrarySchema(mock.db);

    const createdTables = tablesInExecutedSql(mock.executed);
    console.info(
      `[${SUITE}:legacy] createdTables=${createdTables.size} preparedCount=${mock.prepared.length}`,
    );
    const expectedAll = Object.keys(tableGroups);
    const missing = expectedAll.filter((t) => !createdTables.has(t));
    const ranBackfill = mock.prepared.some((sql) => sql.includes(SYSTEM_PLAYLISTS_MARKER));
    try {
      // All groups represented.
      for (const tableName of expectedAll) {
        expect(createdTables.has(tableName), `legacy form must create ${tableName}`).toBe(true);
      }
      // System playlists pass ran (cross-group backfill marker, LIB-SYNC-10).
      expect(ranBackfill).toBe(true);
    } catch (err) {
      dumpMultiGroupSnapshot("legacy-form-incomplete", {
        group: "(legacy single-arg)",
        diff: { missing },
        appliedMarkers: mock.prepared.filter((s) => s.includes(SYSTEM_PLAYLISTS_MARKER)),
        note: `legacy single-arg form should create all tables + run cross-group backfills; ranBackfill=${ranBackfill}`,
      });
      throw err;
    }
  });
});

describe("ensureAllLibrarySchemas(dbs) — multi-DB consumers", () => {
  const buildDbSet = (groups: ReadonlyArray<LibraryDbGroup>): {
    set: LibraryDbSet;
    mocks: Record<string, ReturnType<typeof buildMockDb>>;
  } => {
    const mocks: Record<string, ReturnType<typeof buildMockDb>> = {};
    const set: LibraryDbSet = {};
    for (const group of groups) {
      const mock = buildMockDb();
      mocks[group] = mock;
      set[group] = mock.db;
    }
    return { set, mocks };
  };

  it("routes each group's tables to its own DB (desktop-style 5 DBs)", () => {
    console.info(
      `[${SUITE}:routing] building DB set for ALL groups=${JSON.stringify(ALL_LIBRARY_DB_GROUPS)}`,
    );
    const { set, mocks } = buildDbSet(ALL_LIBRARY_DB_GROUPS);
    ensureAllLibrarySchemas(set);
    const summary = summarizeMocks(mocks);
    console.info(`[${SUITE}:routing] per-group summary=${JSON.stringify(summary)}`);

    try {
      for (const group of ALL_LIBRARY_DB_GROUPS) {
        const createdTables = tablesInExecutedSql(mocks[group]!.executed);
        const expected = new Set(expectedTablesForGroup(group));
        for (const tableName of expected) {
          expect(createdTables.has(tableName), `${tableName} should land in ${group} DB`).toBe(true);
        }
        // Nothing from other groups landed here.
        for (const tableName of createdTables) {
          expect(expected.has(tableName), `${tableName} leaked into ${group} DB`).toBe(true);
        }
      }
    } catch (err) {
      dumpMultiGroupSnapshot("multi-db-routing-violation", {
        perGroupState: summary,
        note: "multi-DB routing leaked or omitted tables",
      });
      throw err;
    }
  });

  it("skips templates DB cleanly when mobile passes only 4 groups", () => {
    const mobileGroups: ReadonlyArray<LibraryDbGroup> = ["core", "metadata", "playback", "ingest"];
    console.info(`[${SUITE}:mobile-routing] running mobile-style 4-group set`);
    const { set, mocks } = buildDbSet(mobileGroups);
    ensureAllLibrarySchemas(set);
    const summary = summarizeMocks(mocks);
    console.info(`[${SUITE}:mobile-routing] per-group summary=${JSON.stringify(summary)}`);

    try {
      for (const group of mobileGroups) {
        const createdTables = tablesInExecutedSql(mocks[group]!.executed);
        const expected = new Set(expectedTablesForGroup(group));
        for (const tableName of expected) {
          expect(createdTables.has(tableName), `${tableName} should land in ${group} DB`).toBe(true);
        }
      }
      // No template tables anywhere.
      for (const group of mobileGroups) {
        const createdTables = tablesInExecutedSql(mocks[group]!.executed);
        for (const tableName of createdTables) {
          expect(tableGroups[tableName]).not.toBe("templates");
        }
      }
    } catch (err) {
      dumpMultiGroupSnapshot("mobile-omits-templates-violation", {
        perGroupState: summary,
        note: "mobile 4-group set should not create any templates table",
      });
      throw err;
    }
  });

  it("invokes ensureDefaultPlaylists only on the core DB", () => {
    console.info(`[${SUITE}:default-playlists-routing] running full 5-group set`);
    const { set, mocks } = buildDbSet(ALL_LIBRARY_DB_GROUPS);
    ensureAllLibrarySchemas(set);

    const marker = SYSTEM_PLAYLISTS_MARKER;
    const onCore = mocks.core!.prepared.some((sql) => sql.includes(marker));
    const stray = ALL_LIBRARY_DB_GROUPS
      .filter((g) => g !== "core")
      .filter((g) => mocks[g]!.prepared.some((sql) => sql.includes(marker)));
    console.info(`[${SUITE}:default-playlists-routing] onCore=${onCore} stray=${JSON.stringify(stray)}`);
    try {
      expect(onCore).toBe(true);
      for (const group of ALL_LIBRARY_DB_GROUPS.filter((g) => g !== "core")) {
        expect(
          mocks[group]!.prepared.some((sql) => sql.includes(marker)),
          `ensureDefaultPlaylists should not touch ${group} DB`,
        ).toBe(false);
      }
    } catch (err) {
      dumpMultiGroupSnapshot("default-playlists-leaked", {
        perGroupState: summarizeMocks(mocks),
        appliedMarkers: [marker],
        diff: { stray },
        note: "ensureDefaultPlaylists should run only on the core DB",
      });
      throw err;
    }
  });

  it("invokes the cross-DB has_files backfill marker check on core when core+metadata+playback are present", () => {
    console.info(`[${SUITE}:has-files-backfill-present] running core+metadata+playback`);
    const { set, mocks } = buildDbSet(["core", "metadata", "playback"]);
    ensureAllLibrarySchemas(set);

    const marker = `SELECT value FROM app_settings WHERE key = 'migration_v1_has_files_backfill'`;
    const found = mocks.core!.prepared.some((sql) => sql.includes(marker));
    console.info(`[${SUITE}:has-files-backfill-present] marker-found=${found}`);
    try {
      // The backfill checks the marker on core via app_settings SELECT.
      expect(found).toBe(true);
    } catch (err) {
      dumpMultiGroupSnapshot("has-files-backfill-missing", {
        perGroupState: summarizeMocks(mocks),
        appliedMarkers: [marker],
        note: "cross-DB has_files backfill should run when core+metadata+playback are present",
      });
      throw err;
    }
  });

  it("does NOT invoke the cross-DB has_files backfill when metadata or playback is missing", () => {
    console.info(`[${SUITE}:has-files-backfill-absent] running core only`);
    const { set, mocks } = buildDbSet(["core"]);
    ensureAllLibrarySchemas(set);

    const marker = `SELECT value FROM app_settings WHERE key = 'migration_v1_has_files_backfill'`;
    const found = mocks.core!.prepared.some((sql) => sql.includes(marker));
    console.info(`[${SUITE}:has-files-backfill-absent] marker-found=${found}`);
    try {
      expect(found).toBe(false);
    } catch (err) {
      dumpMultiGroupSnapshot("has-files-backfill-leaked-into-core-only", {
        perGroupState: summarizeMocks(mocks),
        appliedMarkers: [marker],
        note: "cross-DB has_files backfill should NOT run with only core present",
      });
      throw err;
    }
  });
});
