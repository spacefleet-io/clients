/**
 * @test-id MOBILE-LIB-MIG-001
 * @level unit
 * @why Mobile had no migration system; bumping mobileSql.ts silently skipped the
 *   ALTER on already-installed devices. The runner uses PRAGMA user_version
 *   per split DB so future column adds apply on upgrade.
 */
import { describe, expect, it, vi } from "vitest";

// libraryMigrations transitively imports react-native-quick-crypto via the
// Phase 4 playback-blob migration helper. Mock it so vitest's transform
// doesn't choke on the package's source-level TypeScript.
vi.mock("react-native-quick-crypto", () => ({
  default: {
    randomBytes: (size: number) => Buffer.alloc(size),
  },
}));

const {
  coreMigrations,
  metadataMigrations,
  playbackMigrations,
  runMigrations,
  snapshotMigrations,
} = await import("../src/lib/libraryMigrations");
const { LibraryFormatTooNewError } = await import("@space/library-db-definition");
type Migration = Parameters<typeof runMigrations>[1][number];

type Row = Record<string, unknown>;

type FakeDb = {
  executeSql: (sql: string, params?: unknown[]) => Promise<Array<{ rows: { length: number; item: (i: number) => Row } }>>;
  state: {
    userVersion: number;
    statements: string[];
    tables: Set<string>;
  };
};

const makeFakeDb = (initialUserVersion = 0): FakeDb => {
  const state = {
    userVersion: initialUserVersion,
    statements: [] as string[],
    tables: new Set<string>(),
  };

  const executeSql = async (sql: string) => {
    const trimmed = sql.trim();
    state.statements.push(trimmed);

    if (/^PRAGMA\s+user_version\s*=/i.test(trimmed)) {
      const match = /=\s*(\d+)/.exec(trimmed);
      if (match) state.userVersion = Number(match[1]);
      return [{ rows: { length: 0, item: () => ({}) } }];
    }
    if (/^PRAGMA\s+user_version\s*;?$/i.test(trimmed)) {
      const value = state.userVersion;
      return [
        {
          rows: {
            length: 1,
            item: (_i: number) => ({ user_version: value }),
          },
        },
      ];
    }
    if (/^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+/i.test(trimmed)) {
      const match = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([A-Za-z0-9_]+)/i.exec(trimmed);
      if (match) state.tables.add(match[1]);
    }
    if (/^CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+/i.test(trimmed)) {
      // Indexes are tracked implicitly, no-op
    }
    return [{ rows: { length: 0, item: () => ({}) } }];
  };

  return { executeSql, state };
};

const dbAsSqlite = (db: FakeDb) => db as unknown as Parameters<typeof runMigrations>[0];

// Dump-on-failure helper (per "Tests log generously"). Pins the FakeDb's
// observable state (user_version, applied tables, executed SQL) plus the
// migration runner result / log calls. Body in try/catch so a dump failure
// can never mask the real assertion.
const dumpMigrationSnapshot = (
  label: string,
  db: FakeDb | null,
  ctx: Record<string, unknown> = {},
) => {
  try {
    console.error(`=== [library-migrations:${label}] state snapshot ===`);
    if (db) {
      console.error(
        `db.state.userVersion=${db.state.userVersion} tables=${JSON.stringify(Array.from(db.state.tables))}`,
      );
      console.error(
        `db.state.statements (${db.state.statements.length}):\n${JSON.stringify(db.state.statements, null, 2)}`,
      );
    } else {
      console.error(`db=(none)`);
    }
    console.error(`ctx:\n${JSON.stringify(ctx, null, 2)}`);
    console.error(`=== [library-migrations:${label}] end snapshot ===`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("runMigrations", () => {
  // @req LIB-FMT-01
  it("applies all migrations on a fresh DB and writes user_version", async () => {
    const db = makeFakeDb(0);
    const log = vi.fn();
    const targetVersion = coreMigrations[coreMigrations.length - 1]!.version;
    console.info(
      `[library-migrations:fresh-all] fresh core DB (user_version=0), ${coreMigrations.length} migrations, target=${targetVersion}`,
    );
    const result = await runMigrations(dbAsSqlite(db), coreMigrations, { dbName: "core", log });
    console.info(
      `[library-migrations:fresh-all] result from=${result.from} to=${result.to} applied=${JSON.stringify(result.applied)} db.userVersion=${db.state.userVersion}`,
    );

    if (db.state.userVersion !== targetVersion || result.from !== 0 || result.to !== targetVersion) {
      dumpMigrationSnapshot("fresh-all", db, { result, targetVersion, logCalls: log.mock.calls });
    }
    expect(db.state.userVersion).toBe(coreMigrations[coreMigrations.length - 1]!.version);
    expect(result.from).toBe(0);
    expect(result.to).toBe(coreMigrations[coreMigrations.length - 1]!.version);
    expect(result.applied).toEqual(coreMigrations.map((m) => m.version));
    expect(log).toHaveBeenCalledWith("library.migrations.start", expect.objectContaining({ db: "core", from: 0 }));
    expect(log).toHaveBeenCalledWith("library.migrations.complete", expect.objectContaining({ db: "core" }));
  });

  it("is a no-op when user_version equals target version", async () => {
    const target = coreMigrations[coreMigrations.length - 1]!.version;
    const db = makeFakeDb(target);
    const log = vi.fn();
    console.info(`[library-migrations:noop-up-to-date] DB already at target user_version=${target}`);

    const result = await runMigrations(dbAsSqlite(db), coreMigrations, { dbName: "core", log });
    console.info(
      `[library-migrations:noop-up-to-date] result applied=${JSON.stringify(result.applied)} from=${result.from} to=${result.to}`,
    );

    if (result.applied.length !== 0 || result.from !== target || result.to !== target) {
      dumpMigrationSnapshot("noop-up-to-date", db, { target, result, logCalls: log.mock.calls });
    }
    expect(result.applied).toEqual([]);
    expect(result.from).toBe(target);
    expect(result.to).toBe(target);
    expect(log).toHaveBeenCalledWith("library.migrations.up_to_date", expect.objectContaining({ db: "core" }));
    expect(log).not.toHaveBeenCalledWith("library.migrations.apply", expect.anything());
  });

  it("running twice on a fresh DB is idempotent (second run is no-op)", async () => {
    const db = makeFakeDb(0);
    const log = vi.fn();

    console.info(`[library-migrations:idempotent] first run on fresh DB`);
    await runMigrations(dbAsSqlite(db), coreMigrations, { dbName: "core", log });
    const stateAfterFirst = db.state.userVersion;
    const statementsAfterFirst = db.state.statements.length;
    console.info(
      `[library-migrations:idempotent] after first: userVersion=${stateAfterFirst} statements=${statementsAfterFirst}; running second time`,
    );

    const second = await runMigrations(dbAsSqlite(db), coreMigrations, { dbName: "core", log });
    const additionalStatements = db.state.statements.slice(statementsAfterFirst);
    console.info(
      `[library-migrations:idempotent] second.applied=${JSON.stringify(second.applied)} userVersion=${db.state.userVersion} additionalStatements=${JSON.stringify(additionalStatements)}`,
    );

    const onlyPragmaReads = additionalStatements.every((s) => /^PRAGMA\s+user_version/i.test(s));
    if (second.applied.length !== 0 || db.state.userVersion !== stateAfterFirst || !onlyPragmaReads) {
      dumpMigrationSnapshot("idempotent", db, { second, stateAfterFirst, statementsAfterFirst, additionalStatements });
    }
    expect(second.applied).toEqual([]);
    expect(db.state.userVersion).toBe(stateAfterFirst);
    expect(db.state.statements.length).toBeGreaterThan(statementsAfterFirst); // only the PRAGMA read counted
    // Second run only emitted the `user_version` SELECT, not the schema CREATE TABLE statements.
    expect(additionalStatements.every((s) => /^PRAGMA\s+user_version/i.test(s))).toBe(true);
  });

  it("applies only forward migrations from the current user_version", async () => {
    const migrations: Migration[] = [
      {
        version: 1,
        description: "v1",
        up: async (db) => {
          await db.executeSql("CREATE TABLE IF NOT EXISTS t1 (id TEXT);");
        },
      },
      {
        version: 2,
        description: "v2",
        up: async (db) => {
          await db.executeSql("CREATE TABLE IF NOT EXISTS t2 (id TEXT);");
        },
      },
      {
        version: 3,
        description: "v3",
        up: async (db) => {
          await db.executeSql("CREATE TABLE IF NOT EXISTS t3 (id TEXT);");
        },
      },
    ];

    const db = makeFakeDb(1);
    console.info(`[library-migrations:forward-only] DB at user_version=1, 3 migrations [1,2,3] → expect only [2,3] applied`);
    const result = await runMigrations(dbAsSqlite(db), migrations, { dbName: "test" });
    console.info(
      `[library-migrations:forward-only] applied=${JSON.stringify(result.applied)} userVersion=${db.state.userVersion} tables=${JSON.stringify(Array.from(db.state.tables))}`,
    );

    if (
      JSON.stringify(result.applied) !== JSON.stringify([2, 3]) ||
      db.state.userVersion !== 3 ||
      db.state.tables.has("t1") ||
      !db.state.tables.has("t2") ||
      !db.state.tables.has("t3")
    ) {
      dumpMigrationSnapshot("forward-only", db, { result });
    }
    expect(result.applied).toEqual([2, 3]);
    expect(db.state.userVersion).toBe(3);
    expect(db.state.tables.has("t1")).toBe(false); // v1 was already applied (per user_version=1) so we did NOT re-run it
    expect(db.state.tables.has("t2")).toBe(true);
    expect(db.state.tables.has("t3")).toBe(true);
  });

  it("rejects a downgrade scenario with the typed LibraryFormatTooNewError", async () => {
    const migrations: Migration[] = [
      { version: 1, description: "v1", up: async () => undefined },
    ];
    const db = makeFakeDb(5); // Pretend the DB is ahead of code
    console.info(`[library-migrations:downgrade-block] DB at user_version=5 but only migration v1 in code → expect LibraryFormatTooNewError`);

    // Part C routes the downgrade-block through the unified typed error
    // (surface "schema") instead of a generic `migration_downgrade_blocked`
    // string — the Part D gate / UI turns it into a clean "library created by
    // a newer version" prompt.
    await expect(
      runMigrations(dbAsSqlite(db), migrations, { dbName: "test" })
    ).rejects.toBeInstanceOf(LibraryFormatTooNewError);

    const error = await runMigrations(dbAsSqlite(db), migrations, { dbName: "test" }).catch(
      (caught) => caught
    );
    console.info(
      `[library-migrations:downgrade-block] caught isLibFmtTooNew=${error instanceof LibraryFormatTooNewError} surface=${error?.surface} observed=${error?.observed} supported=${error?.supported}`,
    );
    if (
      !(error instanceof LibraryFormatTooNewError) ||
      error.surface !== "schema" ||
      error.observed !== 5 ||
      error.supported !== 1
    ) {
      dumpMigrationSnapshot("downgrade-block", db, {
        errorName: error?.constructor?.name,
        surface: error?.surface,
        observed: error?.observed,
        supported: error?.supported,
      });
    }
    expect(error).toBeInstanceOf(LibraryFormatTooNewError);
    expect(error.surface).toBe("schema");
    expect(error.observed).toBe(5);
    expect(error.supported).toBe(1);
  });

  it("rejects duplicate migration versions in the input list", async () => {
    const migrations: Migration[] = [
      { version: 1, description: "v1", up: async () => undefined },
      { version: 1, description: "v1-dup", up: async () => undefined },
    ];
    const db = makeFakeDb(0);
    console.info(`[library-migrations:reject-duplicate] versions=[1,1] → expect /duplicate_migration_version:1/`);

    try {
      await expect(runMigrations(dbAsSqlite(db), migrations, { dbName: "test" })).rejects.toThrow(
        /duplicate_migration_version:1/
      );
    } catch (err) {
      dumpMigrationSnapshot("reject-duplicate", db, { versions: migrations.map((m) => m.version), err: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  });

  it("rejects non-monotonic migration versions", async () => {
    const migrations: Migration[] = [
      { version: 2, description: "v2", up: async () => undefined },
      { version: 1, description: "v1", up: async () => undefined },
    ];
    const db = makeFakeDb(0);
    console.info(`[library-migrations:reject-non-monotonic] versions=[2,1] → expect /non_monotonic_migration_versions/`);

    try {
      await expect(runMigrations(dbAsSqlite(db), migrations, { dbName: "test" })).rejects.toThrow(
        /non_monotonic_migration_versions/
      );
    } catch (err) {
      dumpMigrationSnapshot("reject-non-monotonic", db, { versions: migrations.map((m) => m.version), err: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  });

  it("returns empty result when migrations list is empty", async () => {
    const db = makeFakeDb(0);
    console.info(`[library-migrations:empty-list] empty migration list → expect {from:0,to:0,applied:[]}`);
    const result = await runMigrations(dbAsSqlite(db), [], { dbName: "test" });
    console.info(`[library-migrations:empty-list] result=${JSON.stringify(result)}`);
    if (JSON.stringify(result) !== JSON.stringify({ from: 0, to: 0, applied: [] })) {
      dumpMigrationSnapshot("empty-list", db, { result });
    }
    expect(result).toEqual({ from: 0, to: 0, applied: [] });
  });

  it("does not advance user_version when a migration throws", async () => {
    const failingMigrations: Migration[] = [
      {
        version: 1,
        description: "good",
        up: async (db) => {
          await db.executeSql("CREATE TABLE IF NOT EXISTS good (id TEXT);");
        },
      },
      {
        version: 2,
        description: "bad",
        up: async () => {
          throw new Error("boom");
        },
      },
      {
        version: 3,
        description: "later",
        up: async () => undefined,
      },
    ];

    const db = makeFakeDb(0);
    const log = vi.fn();
    console.info(`[library-migrations:partial-on-throw] migrations [1 good, 2 bad(throws), 3 later] → expect userVersion stays at 1`);
    await expect(
      runMigrations(dbAsSqlite(db), failingMigrations, { dbName: "test", log })
    ).rejects.toThrow(/boom/);
    console.info(
      `[library-migrations:partial-on-throw] post-throw userVersion=${db.state.userVersion} tables=${JSON.stringify(Array.from(db.state.tables))}`,
    );

    // user_version should be 1 (committed by the first migration, before the failure)
    if (db.state.userVersion !== 1 || !db.state.tables.has("good")) {
      dumpMigrationSnapshot("partial-on-throw", db, { logCalls: log.mock.calls });
    }
    expect(db.state.userVersion).toBe(1);
    expect(db.state.tables.has("good")).toBe(true);
    expect(log).toHaveBeenCalledWith(
      "library.migrations.failed",
      expect.objectContaining({ version: 2, description: "bad" })
    );
  });
});

describe("baseline migration lists", () => {
  it("coreMigrations creates the expected baseline tables", async () => {
    const db = makeFakeDb(0);
    console.info(`[library-migrations:baseline-core] running ${coreMigrations.length} core migrations on fresh DB`);
    await runMigrations(dbAsSqlite(db), coreMigrations, { dbName: "core" });
    console.info(`[library-migrations:baseline-core] tables=${JSON.stringify(Array.from(db.state.tables))}`);
    if (!db.state.tables.has("media_items") || !db.state.tables.has("playlists")) {
      dumpMigrationSnapshot("baseline-core", db);
    }
    expect(db.state.tables.has("media_items")).toBe(true);
    expect(db.state.tables.has("playlists")).toBe(true);
  });

  it("metadataMigrations creates the metadata baseline tables", async () => {
    const db = makeFakeDb(0);
    const target = metadataMigrations[metadataMigrations.length - 1]!.version;
    console.info(`[library-migrations:baseline-metadata] running ${metadataMigrations.length} metadata migrations, target=${target}`);
    await runMigrations(dbAsSqlite(db), metadataMigrations, { dbName: "metadata" });
    console.info(`[library-migrations:baseline-metadata] userVersion=${db.state.userVersion} tables=${JSON.stringify(Array.from(db.state.tables))}`);
    // mobileMetadataSchemaStatements covers metadata-side tables; we confirm the runner reached completion
    if (db.state.userVersion !== target) dumpMigrationSnapshot("baseline-metadata", db, { target });
    expect(db.state.userVersion).toBe(metadataMigrations[metadataMigrations.length - 1]!.version);
  });

  it("playbackMigrations creates the playback baseline tables", async () => {
    const db = makeFakeDb(0);
    const target = playbackMigrations[playbackMigrations.length - 1]!.version;
    console.info(`[library-migrations:baseline-playback] running ${playbackMigrations.length} playback migrations, target=${target}`);
    await runMigrations(dbAsSqlite(db), playbackMigrations, { dbName: "playback" });
    console.info(`[library-migrations:baseline-playback] userVersion=${db.state.userVersion} tables=${JSON.stringify(Array.from(db.state.tables))}`);
    if (db.state.userVersion !== target) dumpMigrationSnapshot("baseline-playback", db, { target });
    expect(db.state.userVersion).toBe(playbackMigrations[playbackMigrations.length - 1]!.version);
  });

  it("snapshotMigrations creates the snapshot baseline tables", async () => {
    const db = makeFakeDb(0);
    const target = snapshotMigrations[snapshotMigrations.length - 1]!.version;
    console.info(`[library-migrations:baseline-snapshot] running ${snapshotMigrations.length} snapshot migrations, target=${target}`);
    await runMigrations(dbAsSqlite(db), snapshotMigrations, { dbName: "snapshot" });
    console.info(`[library-migrations:baseline-snapshot] userVersion=${db.state.userVersion} tables=${JSON.stringify(Array.from(db.state.tables))}`);
    if (db.state.userVersion !== target) dumpMigrationSnapshot("baseline-snapshot", db, { target });
    expect(db.state.userVersion).toBe(snapshotMigrations[snapshotMigrations.length - 1]!.version);
  });
});

describe("index layout pass (LIB-FMT-01: a layout change is a registered migration)", () => {
  it("playback v3 drops the duplicate chunk indexes and core v2 adds the media_items indexes on an installed device", async () => {
    // An installed device sits at playback v2 / core v1; the pass must bring it forward by indexes only.
    const playbackDb = makeFakeDb(2);
    const coreDb = makeFakeDb(1);
    console.info(`[library-migrations:index-layout] playback registry=${JSON.stringify(playbackMigrations.map((m) => m.version))} core registry=${JSON.stringify(coreMigrations.map((m) => m.version))}`);
    // Up to playback v3 / core v2 only: later passes (playback v4 adds a column, core v3 rewrites rows) have their own tests.
    const upToV3 = playbackMigrations.filter((m) => m.version <= 3);
    const playbackResult = await runMigrations(dbAsSqlite(playbackDb), upToV3, { dbName: "playback" });
    const coreResult = await runMigrations(dbAsSqlite(coreDb), coreMigrations.filter((m) => m.version <= 2), { dbName: "core" });
    console.info(`[library-migrations:index-layout] playback=${JSON.stringify(playbackResult)} core=${JSON.stringify(coreResult)}`);
    try {
      expect(playbackResult.applied).toEqual([3]);
      expect(coreResult.applied).toEqual([2]);
      const playbackSql = playbackDb.state.statements.join("\n");
      expect(playbackSql).toContain("DROP INDEX IF EXISTS media_format_chunks_format_id_idx");
      expect(playbackSql).toContain("DROP INDEX IF EXISTS media_audio_chunks_track_id_idx");
      expect(playbackSql).not.toMatch(/DROP (TABLE|COLUMN)|ALTER TABLE/i);
      const coreSql = coreDb.state.statements.join("\n");
      expect(coreSql).toContain("media_items_added_at_idx ON media_items(added_at)");
      expect(coreSql).toContain("media_items_updated_at_idx ON media_items(updated_at)");
    } catch (err) {
      dumpMigrationSnapshot("index-layout-failure", playbackDb, { playbackResult, coreResult });
      throw err;
    }
  });
});

describe("OCR twin link column (PLAY-TRACK-05)", () => {
  // @req PLAY-TRACK-05
  it("playback v4 adds media_subtitles.derived_from_subtitle_id on an installed device that lacks it", async () => {
    const db = makeFakeDb(3);
    // Up to v4 only: the v5 column pass has its own test below.
    const result = await runMigrations(dbAsSqlite(db), playbackMigrations.filter((m) => m.version <= 4), { dbName: "playback" });
    console.info(`[library-migrations:v4] result=${JSON.stringify(result)} statements=${JSON.stringify(db.state.statements)}`);
    try {
      expect(result.applied).toEqual([4]);
      expect(db.state.statements).toContain("PRAGMA table_info(media_subtitles);");
      expect(db.state.statements).toContain("ALTER TABLE media_subtitles ADD COLUMN derived_from_subtitle_id TEXT;");
      expect(db.state.userVersion).toBe(4);
    } catch (err) {
      dumpMigrationSnapshot("v4-failure", db, { result });
      throw err;
    }
  });

  // @req PLAY-TRACK-05
  it("playback v4 leaves a DB that already has the column alone", async () => {
    const db = makeFakeDb(3);
    const executeSql = db.executeSql;
    db.executeSql = async (sql, params) => {
      if (/^PRAGMA table_info\(media_subtitles\)/i.test(sql.trim())) {
        db.state.statements.push(sql.trim());
        const columns = [{ name: "id" }, { name: "source" }, { name: "derived_from_subtitle_id" }];
        return [{ rows: { length: columns.length, item: (i: number) => columns[i]! } }];
      }
      return executeSql(sql, params);
    };
    const result = await runMigrations(dbAsSqlite(db), playbackMigrations.filter((m) => m.version <= 4), { dbName: "playback" });
    console.info(`[library-migrations:v4-present] result=${JSON.stringify(result)} statements=${JSON.stringify(db.state.statements)}`);
    expect(result.applied).toEqual([4]);
    expect(db.state.statements.join("\n")).not.toMatch(/ALTER TABLE/i);
  });
});

describe("seek-bar preview sheets column (MPV-PREV-01)", () => {
  // The desktop import records the sheets on media_formats.preview_sheets and the media.upsert op replays that
  // column here, so an installed device must have it before the op arrives.
  it("playback v5 adds media_formats.preview_sheets on an installed device that lacks it", async () => {
    const db = makeFakeDb(4);
    const result = await runMigrations(dbAsSqlite(db), playbackMigrations, { dbName: "playback" });
    console.info(`[library-migrations:v5] result=${JSON.stringify(result)} statements=${JSON.stringify(db.state.statements)}`);
    try {
      expect(result.applied).toEqual([5]);
      expect(db.state.statements).toContain("PRAGMA table_info(media_formats);");
      expect(db.state.statements).toContain("ALTER TABLE media_formats ADD COLUMN preview_sheets TEXT;");
      expect(db.state.userVersion).toBe(5);
    } catch (err) {
      dumpMigrationSnapshot("v5-failure", db, { result });
      throw err;
    }
  });

  it("playback v5 leaves a DB that already has the column alone", async () => {
    const db = makeFakeDb(4);
    const executeSql = db.executeSql;
    db.executeSql = async (sql, params) => {
      if (/^PRAGMA table_info\(media_formats\)/i.test(sql.trim())) {
        db.state.statements.push(sql.trim());
        const columns = [{ name: "id" }, { name: "is_source" }, { name: "preview_sheets" }];
        return [{ rows: { length: columns.length, item: (i: number) => columns[i]! } }];
      }
      return executeSql(sql, params);
    };
    const result = await runMigrations(dbAsSqlite(db), playbackMigrations, { dbName: "playback" });
    console.info(`[library-migrations:v5-present] result=${JSON.stringify(result)} statements=${JSON.stringify(db.state.statements)}`);
    expect(result.applied).toEqual([5]);
    expect(db.state.statements.join("\n")).not.toMatch(/ALTER TABLE/i);
  });
});
