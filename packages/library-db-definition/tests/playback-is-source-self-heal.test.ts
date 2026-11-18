/**
 * @bugfix existing-media-source-not-flagged
 * @regression-proof
 * @level unit
 *
 * Prior-format-open test for the SELF-HEALING `is_source` backfill.
 *
 * The original backfill (playback-is-source-backfill.test.ts) only ran inside
 * the `if (!columns.includes("is_source"))` ALTER branch — i.e. exactly once,
 * when the column was first added. Two real shapes slip past it:
 *
 *   1. FRESH DB — `is_source` arrives via the CREATE TABLE DDL (DEFAULT 0), so
 *      the ALTER branch never fires and the backfill never ran. Every format
 *      stays is_source = 0 → nothing protected → the highest/only quality is
 *      deletable.
 *   2. v1 OP-STREAM RE-APPLY — formats inserted from pre-is_source op-stream
 *      entries land as is_source = 0 even on a previously-migrated DB.
 *
 * The fixtures below model shape (1): the `is_source` column ALREADY exists
 * (so the ALTER short-circuits) and rows are unflagged. Pre-fix,
 * `ensureLibrarySchema(db, "playback")` is a no-op on these rows. Post-fix, the
 * unconditional self-healing backfill flags the highest-resolution row per
 * file — without overriding any file that already has an explicit flag.
 */
import { describe, expect, it } from "vitest";
import { ensureLibrarySchema, type SqliteDb } from "../src/migrations";

const SUITE = "playback-is-source-self-heal";

type FormatRow = {
  id: string;
  media_id: string;
  file_id: string;
  quality: string;
  codec: string;
  size_mb: number;
  is_source: number;
};

type FakeDb = SqliteDb & {
  _rows: FormatRow[];
  _columns: string[];
};

/**
 * In-memory fake. Unlike the original backfill test's fake, here `is_source`
 * is ALREADY in the column set from construction — modelling a fresh DB whose
 * column came from the CREATE TABLE DDL. The ALTER branch must NOT fire; the
 * self-healing backfill must still run.
 *
 * Supported surface: PRAGMA table_info(media_formats), SELECT * FROM
 * media_formats, parameterised UPDATE media_formats SET is_source = 1 WHERE
 * id = ?. Everything else (CREATE TABLE/INDEX, other ALTERs) is a no-op.
 */
const buildFakeDb = (rows: FormatRow[]): FakeDb => {
  const state = {
    columns: [
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
      "is_source",
    ],
    rows: rows.map((row) => ({ ...row })),
  };

  const db: SqliteDb = {
    exec: (sql: string) => {
      const alter = sql.match(/^\s*ALTER\s+TABLE\s+media_formats\s+ADD\s+COLUMN\s+(\w+)\b/i);
      if (alter) {
        const name = alter[1]!;
        if (!state.columns.includes(name)) state.columns.push(name);
      }
      return undefined;
    },
    prepare: (sql: string) => ({
      all: (...params: unknown[]) => {
        void params;
        if (/PRAGMA\s+table_info\(\s*media_formats\s*\)/i.test(sql)) {
          return state.columns.map((name) => ({ name }));
        }
        if (/PRAGMA\s+table_info\(/i.test(sql)) return [];
        if (/SELECT\s+\*\s+FROM\s+media_formats/i.test(sql)) {
          return state.rows.map((row) => ({ ...row }));
        }
        return [];
      },
      run: (...args: unknown[]) => {
        if (/^\s*UPDATE\s+media_formats\s+SET\s+is_source\s*=\s*1\s+WHERE\s+id\s*=\s*\?/i.test(sql)) {
          const targetId = String(args[0] ?? "");
          for (const row of state.rows) if (row.id === targetId) row.is_source = 1;
        }
        return undefined;
      },
    }),
  };

  const fake = db as FakeDb;
  Object.defineProperty(fake, "_rows", { get: () => state.rows });
  Object.defineProperty(fake, "_columns", { get: () => state.columns });
  return fake;
};

const fmt = (over: Partial<FormatRow> & Pick<FormatRow, "id" | "file_id" | "quality">): FormatRow => ({
  media_id: "m1",
  codec: "h264",
  size_mb: 100,
  is_source: 0,
  ...over,
});

const flagsById = (db: FakeDb) =>
  Object.fromEntries(db._rows.map((row) => [row.id, row.is_source]));

// Per-suite dump helper. On assertion failure, emit the full domain state this
// suite cares about — the column set (proves whether the ALTER branch could
// have fired), every row's flag, and the count of protected sources per file
// (the invariant: exactly one source per file). Body is wrapped in try/catch so
// a dump failure can never mask the real assertion failure. Snapshot is
// bracketed with `=== [suite:label] ===` so CI can grep the block out of logs.
const dumpSelfHealSnapshot = (label: string, db: FakeDb) => {
  try {
    const sourcesPerFile: Record<string, number> = {};
    for (const row of db._rows) {
      if (row.is_source === 1) sourcesPerFile[row.file_id] = (sourcesPerFile[row.file_id] ?? 0) + 1;
    }
    console.error(`=== [${SUITE}:${label}] state snapshot ===`);
    console.error(`columns: ${JSON.stringify(db._columns)}`);
    console.error(`is_source column present: ${db._columns.includes("is_source")}`);
    console.error(`flags by id: ${JSON.stringify(flagsById(db))}`);
    console.error(`protected sources per file: ${JSON.stringify(sourcesPerFile)}`);
    console.error(`rows:\n${JSON.stringify(db._rows, null, 2)}`);
    console.error(`=== [${SUITE}:${label}] end snapshot ===`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("media_formats.is_source — self-healing backfill (column already present)", () => {
  it("flags the highest quality for an unflagged file even though the ALTER branch never fires", () => {
    const rows = [
      fmt({ id: "f1-360", file_id: "f1", quality: "360p" }),
      fmt({ id: "f1-1080", file_id: "f1", quality: "1080p" }),
      fmt({ id: "f1-720", file_id: "f1", quality: "720p" }),
    ];
    console.info(`[${SUITE}:setup] building fake db with ${rows.length} unflagged formats for file f1`);
    const db = buildFakeDb(rows);
    console.info(`[${SUITE}:precondition] is_source column already present: ${db._columns.includes("is_source")}`);
    console.info(`[${SUITE}:precondition] flags BEFORE: ${JSON.stringify(flagsById(db))}`);
    // Pre-fix expectation this test guards against: all-zero stays all-zero.
    if (!db._rows.every((row) => row.is_source === 0)) {
      dumpSelfHealSnapshot("precondition-not-all-zero", db);
    }
    expect(db._rows.every((row) => row.is_source === 0)).toBe(true);

    console.info(`[${SUITE}:ensure-schema] running ensureLibrarySchema(db, "playback")`);
    ensureLibrarySchema(db, "playback");
    console.info(`[${SUITE}:postcondition] flags AFTER: ${JSON.stringify(flagsById(db))}`);

    try {
      expect(db._rows.find((r) => r.id === "f1-1080")?.is_source).toBe(1);
      expect(db._rows.find((r) => r.id === "f1-720")?.is_source).toBe(0);
      expect(db._rows.find((r) => r.id === "f1-360")?.is_source).toBe(0);
    } catch (err) {
      console.error(`[${SUITE}:fail] flags=${JSON.stringify(flagsById(db))} expected f1-1080=1 only`);
      dumpSelfHealSnapshot("flag-highest-quality-fail", db);
      throw err;
    }
  });

  it("never overrides a file that already has an explicit source — even on a lower-resolution row", () => {
    // f2 has an explicit (deliberate) flag on the 480p row; the self-heal must
    // leave it alone and must NOT additionally flag the 1080p.
    const rows = [
      fmt({ id: "f2-480", file_id: "f2", quality: "480p", is_source: 1 }),
      fmt({ id: "f2-1080", file_id: "f2", quality: "1080p", is_source: 0 }),
    ];
    console.info(`[${SUITE}:setup] building fake db: f2-480 pre-flagged is_source=1, f2-1080 unflagged`);
    const db = buildFakeDb(rows);
    console.info(`[${SUITE}:explicit-flag] flags BEFORE: ${JSON.stringify(flagsById(db))}`);

    console.info(`[${SUITE}:ensure-schema] running ensureLibrarySchema(db, "playback")`);
    ensureLibrarySchema(db, "playback");
    console.info(`[${SUITE}:explicit-flag] flags AFTER: ${JSON.stringify(flagsById(db))}`);

    try {
      expect(db._rows.find((r) => r.id === "f2-480")?.is_source).toBe(1);
      expect(db._rows.find((r) => r.id === "f2-1080")?.is_source).toBe(0);
    } catch (err) {
      console.error(`[${SUITE}:fail] explicit-flag clobbered: ${JSON.stringify(flagsById(db))}`);
      dumpSelfHealSnapshot("explicit-flag-clobbered", db);
      throw err;
    }
  });

  it("heals per-file across a mixed library (one unflagged file, one already-flagged file)", () => {
    const rows = [
      // f3: unflagged → should heal to f3-1080.
      fmt({ id: "f3-720", file_id: "f3", quality: "720p" }),
      fmt({ id: "f3-1080", file_id: "f3", quality: "1080p" }),
      // f4: already correct → untouched.
      fmt({ id: "f4-2160", file_id: "f4", quality: "2160p", is_source: 1 }),
      fmt({ id: "f4-720", file_id: "f4", quality: "720p" }),
    ];
    console.info(`[${SUITE}:setup] building mixed library: f3 unflagged (2 fmts), f4 pre-flagged at f4-2160 (2 fmts)`);
    const db = buildFakeDb(rows);
    console.info(`[${SUITE}:ensure-schema] running ensureLibrarySchema(db, "playback")`);
    ensureLibrarySchema(db, "playback");
    console.info(`[${SUITE}:mixed] flags AFTER: ${JSON.stringify(flagsById(db))}`);

    const sourcesPerFile = new Map<string, number>();
    for (const row of db._rows) {
      if (row.is_source === 1) sourcesPerFile.set(row.file_id, (sourcesPerFile.get(row.file_id) ?? 0) + 1);
    }
    console.info(`[${SUITE}:mixed] protected sources per file: ${JSON.stringify(Object.fromEntries(sourcesPerFile))}`);

    try {
      expect(db._rows.find((r) => r.id === "f3-1080")?.is_source).toBe(1);
      expect(db._rows.find((r) => r.id === "f3-720")?.is_source).toBe(0);
      expect(db._rows.find((r) => r.id === "f4-2160")?.is_source).toBe(1);
      expect(db._rows.find((r) => r.id === "f4-720")?.is_source).toBe(0);
      // Exactly one protected source per file.
      expect(sourcesPerFile.get("f3")).toBe(1);
      expect(sourcesPerFile.get("f4")).toBe(1);
    } catch (err) {
      console.error(`[${SUITE}:fail] mixed heal wrong: ${JSON.stringify(flagsById(db))}`);
      dumpSelfHealSnapshot("mixed-heal-wrong", db);
      throw err;
    }
  });

  it("is idempotent — a second open does not change an already-healed DB", () => {
    const rows = [
      fmt({ id: "f5-360", file_id: "f5", quality: "360p" }),
      fmt({ id: "f5-1080", file_id: "f5", quality: "1080p" }),
    ];
    console.info(`[${SUITE}:setup] building fake db for f5 (idempotency check, 2 fmts)`);
    const db = buildFakeDb(rows);
    console.info(`[${SUITE}:ensure-schema] first ensureLibrarySchema(db, "playback")`);
    ensureLibrarySchema(db, "playback");
    const afterFirst = JSON.stringify(flagsById(db));
    console.info(`[${SUITE}:idempotent] after first open: ${afterFirst}`);

    console.info(`[${SUITE}:ensure-schema] second ensureLibrarySchema(db, "playback")`);
    ensureLibrarySchema(db, "playback");
    const afterSecond = JSON.stringify(flagsById(db));
    console.info(`[${SUITE}:idempotent] after second open: ${afterSecond}`);

    try {
      expect(afterSecond).toBe(afterFirst);
      expect(db._rows.find((r) => r.id === "f5-1080")?.is_source).toBe(1);
    } catch (err) {
      console.error(`[${SUITE}:fail] not idempotent: first=${afterFirst} second=${afterSecond}`);
      dumpSelfHealSnapshot("not-idempotent", db);
      throw err;
    }
  });

  it("unknown quality strings are ranked last and never beat a known quality", () => {
    const rows = [
      fmt({ id: "f6-unknown", file_id: "f6", quality: "8k-future" }),
      fmt({ id: "f6-1080", file_id: "f6", quality: "1080p" }),
    ];
    console.info(`[${SUITE}:setup] building fake db for f6: known 1080p vs unknown "8k-future" quality`);
    const db = buildFakeDb(rows);
    console.info(`[${SUITE}:ensure-schema] running ensureLibrarySchema(db, "playback")`);
    ensureLibrarySchema(db, "playback");
    console.info(`[${SUITE}:unknown] flags AFTER: ${JSON.stringify(flagsById(db))}`);

    try {
      expect(db._rows.find((r) => r.id === "f6-1080")?.is_source).toBe(1);
      expect(db._rows.find((r) => r.id === "f6-unknown")?.is_source).toBe(0);
    } catch (err) {
      console.error(`[${SUITE}:fail] unknown ranked too high: ${JSON.stringify(flagsById(db))}`);
      dumpSelfHealSnapshot("unknown-ranked-too-high", db);
      throw err;
    }
  });
});
