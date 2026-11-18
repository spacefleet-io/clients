/**
 * @test-id LIB-DB-PLAYBACK-IS-SOURCE-001
 * @level unit
 *
 * Prior-format-open test for the additive `is_source` column on
 * `media_formats`. Per the library-format rule: any schema change must
 * ship with a test that opens a pre-migration fixture and verifies the
 * migration applies correctly. This file covers the schema surface for the
 * post-ingest quality-management feature (see plan
 * `virtual-puzzling-sketch.md`, Phase 1).
 *
 * Pre-migration fixture: a `media_formats` table that lacks the `is_source`
 * column (the shape pre-Phase-1 produced). `ensureLibrarySchema(db, "playback")`
 * detects the missing column via `PRAGMA table_info`, issues the
 * `ALTER TABLE … ADD COLUMN is_source INTEGER NOT NULL DEFAULT 0;`, then runs
 * the JS-driven backfill so each file_id has exactly one row with
 * is_source = 1 (the row with the highest available resolution — lowest
 * QUALITY_RANK).
 *
 * Pre-fix this test FAILS at the column-info assertion (no is_source column
 * after ensureLibrarySchema). Post-fix it PASSES end-to-end.
 */
import { describe, expect, it } from "vitest";
import { ensureLibrarySchema, type SqliteDb } from "../src/migrations";

const SUITE = "playback-is-source-backfill";

const dumpBackfillSnapshot = (
  label: string,
  ctx: {
    columns?: ReadonlyArray<string>;
    rowsBefore?: ReadonlyArray<unknown>;
    rowsAfter?: ReadonlyArray<unknown>;
    expectedFlags?: Record<string, number>;
    actualFlags?: Record<string, number | undefined>;
    perFileWinnerCounts?: Record<string, number>;
    candidateSet?: ReadonlyArray<string>;
  },
) => {
  try {
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    if (ctx.columns) {
      console.error(`media_formats columns (${ctx.columns.length}): ${JSON.stringify(ctx.columns)}`);
      console.error(`  is_source present: ${ctx.columns.includes("is_source")}`);
    }
    if (ctx.rowsBefore) {
      console.error(`rows BEFORE migration (${ctx.rowsBefore.length}):\n${JSON.stringify(ctx.rowsBefore, null, 2)}`);
    }
    if (ctx.rowsAfter) {
      console.error(`rows AFTER migration (${ctx.rowsAfter.length}):\n${JSON.stringify(ctx.rowsAfter, null, 2)}`);
    }
    if (ctx.expectedFlags) {
      console.error(`expected is_source flag transitions:\n${JSON.stringify(ctx.expectedFlags, null, 2)}`);
    }
    if (ctx.actualFlags) {
      console.error(`actual is_source flag transitions:\n${JSON.stringify(ctx.actualFlags, null, 2)}`);
    }
    if (ctx.perFileWinnerCounts) {
      console.error(`per-file winner counts (is_source=1 rows):\n${JSON.stringify(ctx.perFileWinnerCounts, null, 2)}`);
    }
    if (ctx.candidateSet) {
      console.error(`backfill candidate set (rows considered): ${JSON.stringify(ctx.candidateSet)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

// ---------------------------------------------------------------------------
// In-memory SQLite fake — covers exactly the surface the migration uses:
// `PRAGMA table_info(media_formats)`, `ALTER TABLE media_formats ADD COLUMN …`,
// `SELECT id, file_id, quality FROM media_formats`, and parameterised
// `UPDATE media_formats SET is_source = 1 WHERE id = ?`. All other CREATE
// TABLE / CREATE INDEX statements are accepted as no-ops — we only care about
// the media_formats table state for this test.
// ---------------------------------------------------------------------------

type FormatRow = {
  id: string;
  media_id: string;
  file_id: string;
  quality: string;
  codec: string;
  size_mb: number;
  is_source?: number;
};

type FakeDb = SqliteDb & {
  _columns: string[];
  _rows: FormatRow[];
};

const buildFakeDb = (initial: {
  /** Pre-migration column set for media_formats (no `is_source`). */
  columns: string[];
  /** Pre-migration rows (no `is_source` field). */
  rows: Omit<FormatRow, "is_source">[];
}): FakeDb => {
  const state = {
    columns: [...initial.columns],
    rows: initial.rows.map((row) => ({ ...row })) as FormatRow[],
  };

  const db: SqliteDb = {
    exec: (sql: string) => {
      // ALTER TABLE media_formats ADD COLUMN <name> <type> [NOT NULL DEFAULT <v>] ;
      const alter = sql.match(/^\s*ALTER\s+TABLE\s+media_formats\s+ADD\s+COLUMN\s+(\w+)\b/i);
      if (alter) {
        const name = alter[1]!;
        if (!state.columns.includes(name)) {
          state.columns.push(name);
          // Apply DEFAULT to existing rows. For is_source the default is 0.
          if (name === "is_source") {
            for (const row of state.rows) {
              if (row.is_source === undefined) row.is_source = 0;
            }
          }
        }
        return undefined;
      }
      // Everything else (CREATE TABLE, CREATE INDEX, etc.) is a no-op for this test.
      return undefined;
    },
    prepare: (sql: string) => ({
      all: (...params: unknown[]) => {
        if (/PRAGMA\s+table_info\(\s*media_formats\s*\)/i.test(sql)) {
          return state.columns.map((name) => ({ name }));
        }
        if (/PRAGMA\s+table_info\(/i.test(sql)) {
          // Any other PRAGMA table_info for unrelated tables — return empty.
          return [];
        }
        if (/SELECT\s+id\s*,\s*file_id\s*,\s*quality\s+FROM\s+media_formats/i.test(sql)) {
          return state.rows.map((row) => ({
            id: row.id,
            file_id: row.file_id,
            quality: row.quality,
          }));
        }
        if (/SELECT\s+\*\s+FROM\s+media_formats/i.test(sql)) {
          return state.rows.map((row) => ({ ...row }));
        }
        // Permit unrelated SELECTs (e.g. legacy migration probes) — return empty.
        // params accepted to match the SqliteDb shape but unused here.
        void params;
        return [];
      },
      run: (...args: unknown[]) => {
        const updateMatch = sql.match(/^\s*UPDATE\s+media_formats\s+SET\s+is_source\s*=\s*1\s+WHERE\s+id\s*=\s*\?/i);
        if (updateMatch) {
          const targetId = String(args[0] ?? "");
          for (const row of state.rows) {
            if (row.id === targetId) row.is_source = 1;
          }
        }
        return undefined;
      },
    }),
  };

  const fake: FakeDb = db as FakeDb;
  Object.defineProperty(fake, "_columns", {
    get: () => state.columns,
  });
  Object.defineProperty(fake, "_rows", {
    get: () => state.rows,
  });
  return fake;
};

const baselineFormatColumns = [
  "id",
  "media_id",
  "file_id",
  "quality",
  "codec",
  "codec_string",
  "bitrate_kbps",
  "init_key",
  "init_size",
  "duration_seconds",
  "total_size",
  "size_mb",
];

describe("media_formats.is_source — prior-format-open + backfill", () => {
  it("adds the is_source column when missing", () => {
    console.info(`[${SUITE}:setup] building fake DB with baseline columns (no is_source), 0 rows`);
    const db = buildFakeDb({ columns: baselineFormatColumns, rows: [] });

    console.info(`[${SUITE}:precondition] is_source present BEFORE migration: ${db._columns.includes("is_source")}`);
    expect(db._columns).not.toContain("is_source");

    console.info(`[${SUITE}:exec] calling ensureLibrarySchema(db, "playback")`);
    ensureLibrarySchema(db, "playback");
    console.info(`[${SUITE}:postcondition] is_source present AFTER migration: ${db._columns.includes("is_source")}`);

    try {
      expect(db._columns).toContain("is_source");
    } catch (err) {
      dumpBackfillSnapshot("column-not-added", { columns: db._columns });
      throw err;
    }
  });

  it("multi-quality file: backfills is_source = 1 on the highest-resolution row only", () => {
    console.info(`[${SUITE}:setup] building fake DB with 3 formats for 1 file (360/720/1080)`);
    const initialRows = [
      // Pre-migration fixture: three formats for one file, ranging 360p → 1080p.
      { id: "fmt-360", media_id: "m1", file_id: "f1", quality: "360p", codec: "h264", size_mb: 100 },
      { id: "fmt-720", media_id: "m1", file_id: "f1", quality: "720p", codec: "h264", size_mb: 300 },
      { id: "fmt-1080", media_id: "m1", file_id: "f1", quality: "1080p", codec: "h264", size_mb: 800 },
    ];
    const db = buildFakeDb({ columns: baselineFormatColumns, rows: initialRows });

    console.info(`[${SUITE}:exec] running ensureLibrarySchema(db, "playback") with ${db._rows.length} pre-rows`);
    ensureLibrarySchema(db, "playback");

    const byId = new Map(db._rows.map((row) => [row.id, row]));
    const actualFlags = {
      "fmt-1080": byId.get("fmt-1080")?.is_source,
      "fmt-720": byId.get("fmt-720")?.is_source,
      "fmt-360": byId.get("fmt-360")?.is_source,
    };
    console.info(`[${SUITE}:check] actual flags=${JSON.stringify(actualFlags)} expected={fmt-1080:1,fmt-720:0,fmt-360:0}`);

    try {
      expect(byId.get("fmt-1080")?.is_source).toBe(1);
      expect(byId.get("fmt-720")?.is_source).toBe(0);
      expect(byId.get("fmt-360")?.is_source).toBe(0);
    } catch (err) {
      dumpBackfillSnapshot("multi-quality-mismatch", {
        rowsBefore: initialRows,
        rowsAfter: db._rows,
        expectedFlags: { "fmt-1080": 1, "fmt-720": 0, "fmt-360": 0 },
        actualFlags,
        candidateSet: db._rows.map((row) => row.id),
      });
      throw err;
    }
  });

  it("single-quality file: the only row becomes is_source = 1", () => {
    console.info(`[${SUITE}:setup] building fake DB with 1 format for 1 file (360p only)`);
    const initialRows = [
      { id: "fmt-360-only", media_id: "m2", file_id: "f2", quality: "360p", codec: "h264", size_mb: 120 },
    ];
    const db = buildFakeDb({ columns: baselineFormatColumns, rows: initialRows });

    console.info(`[${SUITE}:exec] running ensureLibrarySchema(db, "playback")`);
    ensureLibrarySchema(db, "playback");
    console.info(`[${SUITE}:check] sole-row is_source=${db._rows[0]?.is_source} expected=1`);

    try {
      expect(db._rows[0]?.is_source).toBe(1);
    } catch (err) {
      dumpBackfillSnapshot("single-quality-mismatch", {
        rowsBefore: initialRows,
        rowsAfter: db._rows,
        expectedFlags: { "fmt-360-only": 1 },
        actualFlags: { "fmt-360-only": db._rows[0]?.is_source },
      });
      throw err;
    }
  });

  it("two files, multiple qualities each: backfill is scoped per file_id", () => {
    console.info(`[${SUITE}:setup] building fake DB with 5 formats across 3 files (fA:2 fB:1 fC:2)`);
    const initialRows = [
      // File A: 240p + 720p — winner is 720p.
      { id: "a-240", media_id: "m1", file_id: "fA", quality: "240p", codec: "h264", size_mb: 50 },
      { id: "a-720", media_id: "m1", file_id: "fA", quality: "720p", codec: "h264", size_mb: 300 },
      // File B: 480p only — winner is 480p.
      { id: "b-480", media_id: "m2", file_id: "fB", quality: "480p", codec: "h264", size_mb: 180 },
      // File C: 360p + 1080p — winner is 1080p.
      { id: "c-360", media_id: "m3", file_id: "fC", quality: "360p", codec: "h264", size_mb: 100 },
      { id: "c-1080", media_id: "m3", file_id: "fC", quality: "1080p", codec: "h264", size_mb: 900 },
    ];
    const db = buildFakeDb({ columns: baselineFormatColumns, rows: initialRows });

    console.info(`[${SUITE}:exec] running ensureLibrarySchema(db, "playback") with ${db._rows.length} pre-rows`);
    ensureLibrarySchema(db, "playback");

    const byId = new Map(db._rows.map((row) => [row.id, row]));
    // Exactly one is_source = 1 row per file.
    const perFile = new Map<string, number>();
    for (const row of db._rows) {
      if (row.is_source === 1) perFile.set(row.file_id, (perFile.get(row.file_id) ?? 0) + 1);
    }
    const perFileObj = Object.fromEntries(perFile);
    console.info(`[${SUITE}:check] per-file winner counts=${JSON.stringify(perFileObj)} expected={fA:1,fB:1,fC:1}`);

    try {
      expect(byId.get("a-720")?.is_source).toBe(1);
      expect(byId.get("a-240")?.is_source).toBe(0);
      expect(byId.get("b-480")?.is_source).toBe(1);
      expect(byId.get("c-1080")?.is_source).toBe(1);
      expect(byId.get("c-360")?.is_source).toBe(0);
      expect(perFile.get("fA")).toBe(1);
      expect(perFile.get("fB")).toBe(1);
      expect(perFile.get("fC")).toBe(1);
    } catch (err) {
      dumpBackfillSnapshot("multi-file-per-file-scoping-mismatch", {
        rowsBefore: initialRows,
        rowsAfter: db._rows,
        expectedFlags: { "a-720": 1, "a-240": 0, "b-480": 1, "c-1080": 1, "c-360": 0 },
        actualFlags: {
          "a-720": byId.get("a-720")?.is_source,
          "a-240": byId.get("a-240")?.is_source,
          "b-480": byId.get("b-480")?.is_source,
          "c-1080": byId.get("c-1080")?.is_source,
          "c-360": byId.get("c-360")?.is_source,
        },
        perFileWinnerCounts: perFileObj,
      });
      throw err;
    }
  });

  it("unknown quality strings are ranked last — never picked over a known quality", () => {
    console.info(`[${SUITE}:setup] building fake DB with unknown 8k-future quality alongside 1080p`);
    const initialRows = [
      { id: "x-unknown", media_id: "m1", file_id: "fX", quality: "8k-future", codec: "av1", size_mb: 2000 },
      { id: "x-1080", media_id: "m1", file_id: "fX", quality: "1080p", codec: "h264", size_mb: 800 },
    ];
    const db = buildFakeDb({ columns: baselineFormatColumns, rows: initialRows });

    console.info(`[${SUITE}:exec] running ensureLibrarySchema(db, "playback")`);
    ensureLibrarySchema(db, "playback");

    const byId = new Map(db._rows.map((row) => [row.id, row]));
    const actualFlags = {
      "x-1080": byId.get("x-1080")?.is_source,
      "x-unknown": byId.get("x-unknown")?.is_source,
    };
    console.info(`[${SUITE}:check] actual=${JSON.stringify(actualFlags)} expected={x-1080:1,x-unknown:0}`);

    try {
      expect(byId.get("x-1080")?.is_source).toBe(1);
      expect(byId.get("x-unknown")?.is_source).toBe(0);
    } catch (err) {
      dumpBackfillSnapshot("unknown-quality-ranked-too-high", {
        rowsBefore: initialRows,
        rowsAfter: db._rows,
        expectedFlags: { "x-1080": 1, "x-unknown": 0 },
        actualFlags,
      });
      throw err;
    }
  });

  it("empty media_formats table: ALTER runs, no rows to backfill, no error", () => {
    console.info(`[${SUITE}:setup] building empty fake DB (no rows, baseline columns)`);
    const db = buildFakeDb({ columns: baselineFormatColumns, rows: [] });

    console.info(`[${SUITE}:exec] running ensureLibrarySchema(db, "playback") with empty rows`);
    try {
      expect(() => ensureLibrarySchema(db, "playback")).not.toThrow();
      expect(db._columns).toContain("is_source");
      expect(db._rows.length).toBe(0);
    } catch (err) {
      dumpBackfillSnapshot("empty-table-failed", {
        columns: db._columns,
        rowsAfter: db._rows,
      });
      throw err;
    }
  });

  it("re-running ensureLibrarySchema is a no-op once is_source is present", () => {
    console.info(`[${SUITE}:setup] building fake DB with 2 formats for is_source idempotency test`);
    const initialRows = [
      { id: "r-360", media_id: "m1", file_id: "f1", quality: "360p", codec: "h264", size_mb: 100 },
      { id: "r-720", media_id: "m1", file_id: "f1", quality: "720p", codec: "h264", size_mb: 300 },
    ];
    const db = buildFakeDb({ columns: baselineFormatColumns, rows: initialRows });

    // First run: backfills.
    console.info(`[${SUITE}:exec] first ensureLibrarySchema run (column missing → ALTER + backfill)`);
    ensureLibrarySchema(db, "playback");
    const after1 = db._rows.map((row) => ({ id: row.id, is_source: row.is_source }));
    console.info(`[${SUITE}:after-run-1] flags=${JSON.stringify(after1)}`);
    try {
      expect(after1).toContainEqual({ id: "r-720", is_source: 1 });
      expect(after1).toContainEqual({ id: "r-360", is_source: 0 });
    } catch (err) {
      dumpBackfillSnapshot("run1-backfill-wrong", {
        rowsBefore: initialRows,
        rowsAfter: db._rows,
      });
      throw err;
    }

    // Manually flip the lower row to is_source = 1 to simulate a hand-edit
    // (or a future ingest event). The migration MUST NOT touch this on rerun.
    console.info(`[${SUITE}:hand-edit] flipping r-360 is_source=1 to simulate post-migration user action`);
    db._rows.find((row) => row.id === "r-360")!.is_source = 1;

    // Second run: column already present → ALTER short-circuits, backfill is
    // not re-invoked. The manual flip survives.
    console.info(`[${SUITE}:exec] second ensureLibrarySchema run (column present → expected no-op)`);
    ensureLibrarySchema(db, "playback");
    const after2 = db._rows.map((row) => ({ id: row.id, is_source: row.is_source }));
    console.info(`[${SUITE}:after-run-2] flags=${JSON.stringify(after2)} expected={r-360:1,r-720:1}`);

    try {
      expect(db._rows.find((row) => row.id === "r-360")?.is_source).toBe(1);
      expect(db._rows.find((row) => row.id === "r-720")?.is_source).toBe(1);
    } catch (err) {
      dumpBackfillSnapshot("re-run-clobbered-hand-edit", {
        rowsBefore: initialRows,
        rowsAfter: db._rows,
        expectedFlags: { "r-360": 1, "r-720": 1 },
        actualFlags: {
          "r-360": db._rows.find((row) => row.id === "r-360")?.is_source,
          "r-720": db._rows.find((row) => row.id === "r-720")?.is_source,
        },
      });
      throw err;
    }
  });

  it("new DDL path (fresh DB) creates media_formats with is_source already present (no ALTER, no backfill)", () => {
    console.info(`[${SUITE}:setup] fresh-DB scenario (empty columns + empty rows)`);
    // Fresh-install scenario: no pre-migration rows, no pre-migration columns —
    // the column comes in via the CREATE TABLE in playbackDdl. The fake test
    // here only confirms the integration doesn't crash on a fully-empty DB,
    // since CREATE TABLE statements are no-ops in this in-memory fake. The
    // multi-group-migrations.test.ts already pins that the CREATE TABLE DDL
    // includes is_source via the playbackDdl constant.
    const db = buildFakeDb({ columns: [], rows: [] });
    console.info(`[${SUITE}:exec] running ensureLibrarySchema(db, "playback") on fresh DB`);
    try {
      expect(() => ensureLibrarySchema(db, "playback")).not.toThrow();
    } catch (err) {
      dumpBackfillSnapshot("fresh-db-threw", {
        columns: db._columns,
        rowsAfter: db._rows,
      });
      throw err;
    }
  });
});

describe("playbackDdl — CREATE TABLE includes is_source column", () => {
  it("the baseline CREATE TABLE for media_formats declares is_source", async () => {
    // Direct read of the DDL constant via the public getter. Pins that the
    // shape mobile (async path) gets on a fresh DB matches the post-ALTER
    // shape desktop (sync path) gets on an upgraded DB.
    console.info(`[${SUITE}:setup] importing getGroupDdlStatements`);
    const { getGroupDdlStatements } = await import("../src/migrations");
    const stmts = getGroupDdlStatements("playback");
    console.info(`[${SUITE}:check] playback DDL statement count=${stmts.length}`);
    const createMediaFormats = stmts.find((s) => /CREATE TABLE IF NOT EXISTS\s+media_formats\b/i.test(s));

    try {
      expect(createMediaFormats).toBeDefined();
      expect(createMediaFormats!).toMatch(/is_source\s+INTEGER\s+NOT\s+NULL\s+DEFAULT\s+0/i);
    } catch (err) {
      console.error(`=== [${SUITE}:ddl-declaration-missing] snapshot ===`);
      console.error(`createMediaFormats statement (if any):\n${String(createMediaFormats ?? "(none found)")}`);
      console.error(`all playback DDL statements:\n${JSON.stringify(stmts, null, 2)}`);
      throw err;
    }
  });
});
