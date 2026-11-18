/**
 * @test-id MOBILE-LIB-PLAYBACK-BLOB-MIG-001
 * @level unit
 * @bugfix Phase 4 — drop media_playback_blob from mobile in favor of the
 *   normalized playback tables that desktop already uses.
 * @regression-proof Pin the one-time migration:
 *   1. seeded media_playback_blob rows explode into the normalized tables
 *   2. media_playback_blob is dropped after the run
 *   3. the rows produced match what downstream consumers
 *      (loadPlaybackPayload / getMediaDetails) expect
 *   4. a second run is a no-op (table already gone) — no throw, no diff
 *   5. partial-crash retry (blob still present after a previous data move)
 *      converges to the same normalized rows thanks to stable IDs +
 *      INSERT OR REPLACE
 *
 *   Without this test, a future refactor of normalizePlaybackBlobRows could
 *   silently drop chunk rows, swap column orders, or break the idempotency
 *   contract that gates `user_version=2`.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native-quick-crypto", () => ({
  default: {
    randomBytes: (size: number) => {
      const buf = Buffer.alloc(size);
      for (let i = 0; i < size; i += 1) buf[i] = Math.floor(Math.random() * 256);
      return buf;
    },
  },
}));

const { normalizePlaybackBlobRows } = await import(
  "../src/lib/library/playbackBlobMigration"
);

type FakeRow = Record<string, unknown>;

/**
 * Minimal fake that mimics react-native-sqlite-storage's surface for the
 * tables the migration touches. We don't need a real SQL engine — the
 * migration's hot path is:
 *   1. SELECT name FROM sqlite_master WHERE type='table' AND name='media_playback_blob'
 *   2. SELECT media_id, payload, updated_at FROM media_playback_blob
 *   3. sqlBatch([INSERTs + DELETEs])
 *   4. DROP TABLE IF EXISTS media_playback_blob
 *
 * The fake tracks per-table rows + a tables registry, parses the small
 * subset of SQL the migration emits, and records every statement for
 * assertions.
 */
const makeFakeDb = () => {
  const tables = new Map<string, FakeRow[]>();
  const allStatements: Array<{ sql: string; params: unknown[] }> = [];

  const ensureTable = (name: string) => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name)!;
  };

  const sqliteMasterRows = () => {
    const rows: FakeRow[] = [];
    for (const name of tables.keys()) rows.push({ name, type: "table" });
    return rows;
  };

  const runOne = (rawSql: string, params: unknown[] = []) => {
    allStatements.push({ sql: rawSql, params: [...params] });
    const sql = rawSql.trim();
    const upper = sql.toUpperCase();

    if (upper.startsWith("SELECT NAME FROM SQLITE_MASTER")) {
      const match = /name\s*=\s*'([^']+)'/i.exec(sql);
      const wanted = match?.[1];
      const rows = sqliteMasterRows().filter((r) => !wanted || r.name === wanted);
      return { rows };
    }

    if (upper.startsWith("SELECT MEDIA_ID, PAYLOAD, UPDATED_AT FROM MEDIA_PLAYBACK_BLOB")) {
      return { rows: [...ensureTable("media_playback_blob")] };
    }

    if (upper.startsWith("DROP TABLE IF EXISTS MEDIA_PLAYBACK_BLOB")) {
      tables.delete("media_playback_blob");
      return { rows: [] };
    }
    if (upper.startsWith("DROP TABLE")) {
      const match = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([A-Za-z_]+)/i.exec(sql);
      if (match) tables.delete(match[1]);
      return { rows: [] };
    }

    if (upper.startsWith("INSERT OR REPLACE INTO MEDIA_FORMATS")) {
      const [
        id,
        media_id,
        file_id,
        quality,
        codec,
        codec_string,
        bitrate_kbps,
        init_key,
        init_size,
        duration_seconds,
        total_size,
        size_mb,
      ] = params;
      const row = {
        id,
        media_id,
        file_id,
        quality,
        codec,
        codec_string,
        bitrate_kbps,
        init_key,
        init_size,
        duration_seconds,
        total_size,
        size_mb,
      } satisfies FakeRow;
      const t = ensureTable("media_formats");
      const existingIdx = t.findIndex((r) => r.id === id);
      if (existingIdx >= 0) t[existingIdx] = row;
      else t.push(row);
      return { rows: [] };
    }

    if (upper.startsWith("INSERT OR REPLACE INTO MEDIA_FORMAT_CHUNKS")) {
      const [id, format_id, chunk_key, order_index, size_bytes, start_seconds] = params;
      const row = { id, format_id, chunk_key, order_index, size_bytes, start_seconds };
      const t = ensureTable("media_format_chunks");
      const existingIdx = t.findIndex((r) => r.id === id);
      if (existingIdx >= 0) t[existingIdx] = row;
      else t.push(row);
      return { rows: [] };
    }

    if (upper.startsWith("INSERT OR REPLACE INTO MEDIA_AUDIO_TRACKS")) {
      const [
        id,
        media_id,
        file_id,
        episode_id,
        language,
        label,
        is_default,
        source,
        codec,
        codec_string,
        init_key,
        init_size,
        duration_seconds,
        total_size,
        created_at,
      ] = params;
      const row = {
        id,
        media_id,
        file_id,
        episode_id,
        language,
        label,
        is_default,
        source,
        codec,
        codec_string,
        init_key,
        init_size,
        duration_seconds,
        total_size,
        created_at,
      } satisfies FakeRow;
      const t = ensureTable("media_audio_tracks");
      const existingIdx = t.findIndex((r) => r.id === id);
      if (existingIdx >= 0) t[existingIdx] = row;
      else t.push(row);
      return { rows: [] };
    }

    if (upper.startsWith("INSERT OR REPLACE INTO MEDIA_AUDIO_CHUNKS")) {
      const [id, track_id, chunk_key, order_index, size_bytes, start_seconds] = params;
      const row = { id, track_id, chunk_key, order_index, size_bytes, start_seconds };
      const t = ensureTable("media_audio_chunks");
      const existingIdx = t.findIndex((r) => r.id === id);
      if (existingIdx >= 0) t[existingIdx] = row;
      else t.push(row);
      return { rows: [] };
    }

    if (upper.startsWith("INSERT OR REPLACE INTO MEDIA_SUBTITLES")) {
      const [
        id,
        media_id,
        file_id,
        episode_id,
        language,
        label,
        object_key,
        format,
        is_default,
        source,
        created_at,
      ] = params;
      const row = {
        id,
        media_id,
        file_id,
        episode_id,
        language,
        label,
        object_key,
        format,
        is_default,
        source,
        created_at,
      } satisfies FakeRow;
      const t = ensureTable("media_subtitles");
      const existingIdx = t.findIndex((r) => r.id === id);
      if (existingIdx >= 0) t[existingIdx] = row;
      else t.push(row);
      return { rows: [] };
    }

    if (upper.startsWith("INSERT OR REPLACE INTO MEDIA_CHAPTERS")) {
      const [id, format_id, title, start_seconds] = params;
      const row = { id, format_id, title, start_seconds };
      const t = ensureTable("media_chapters");
      const existingIdx = t.findIndex((r) => r.id === id);
      if (existingIdx >= 0) t[existingIdx] = row;
      else t.push(row);
      return { rows: [] };
    }

    if (upper.startsWith("DELETE FROM MEDIA_FORMAT_CHUNKS WHERE FORMAT_ID IN")) {
      const mediaId = params[0];
      const formatIds = new Set(
        ensureTable("media_formats")
          .filter((r) => r.media_id === mediaId)
          .map((r) => r.id)
      );
      tables.set(
        "media_format_chunks",
        ensureTable("media_format_chunks").filter((r) => !formatIds.has(r.format_id))
      );
      return { rows: [] };
    }
    if (upper.startsWith("DELETE FROM MEDIA_CHAPTERS WHERE FORMAT_ID IN")) {
      const mediaId = params[0];
      const formatIds = new Set(
        ensureTable("media_formats")
          .filter((r) => r.media_id === mediaId)
          .map((r) => r.id)
      );
      tables.set(
        "media_chapters",
        ensureTable("media_chapters").filter((r) => !formatIds.has(r.format_id))
      );
      return { rows: [] };
    }
    if (upper.startsWith("DELETE FROM MEDIA_FORMATS WHERE MEDIA_ID")) {
      const mediaId = params[0];
      tables.set("media_formats", ensureTable("media_formats").filter((r) => r.media_id !== mediaId));
      return { rows: [] };
    }
    if (upper.startsWith("DELETE FROM MEDIA_AUDIO_CHUNKS WHERE TRACK_ID IN")) {
      const mediaId = params[0];
      const trackIds = new Set(
        ensureTable("media_audio_tracks")
          .filter((r) => r.media_id === mediaId)
          .map((r) => r.id)
      );
      tables.set(
        "media_audio_chunks",
        ensureTable("media_audio_chunks").filter((r) => !trackIds.has(r.track_id))
      );
      return { rows: [] };
    }
    if (upper.startsWith("DELETE FROM MEDIA_AUDIO_TRACKS WHERE MEDIA_ID")) {
      const mediaId = params[0];
      tables.set(
        "media_audio_tracks",
        ensureTable("media_audio_tracks").filter((r) => r.media_id !== mediaId)
      );
      return { rows: [] };
    }
    if (upper.startsWith("DELETE FROM MEDIA_SUBTITLES WHERE MEDIA_ID")) {
      const mediaId = params[0];
      tables.set(
        "media_subtitles",
        ensureTable("media_subtitles").filter((r) => r.media_id !== mediaId)
      );
      return { rows: [] };
    }

    throw new Error(`fake_db_unsupported_sql: ${upper.slice(0, 80)}`);
  };

  const executeSql = async (sql: string, params: unknown[] = []) => {
    const { rows } = runOne(sql, params);
    return [
      {
        rows: {
          length: rows.length,
          item: (i: number) => rows[i],
        },
      },
    ];
  };

  const sqlBatch = async (statements: Array<[string, unknown[]]>) => {
    for (const [sql, params] of statements) runOne(sql, params);
  };

  const seedBlob = (mediaId: string, payload: unknown, updatedAt = "2025-01-01T00:00:00.000Z") => {
    const t = ensureTable("media_playback_blob");
    const idx = t.findIndex((r) => r.media_id === mediaId);
    const row = { media_id: mediaId, payload: JSON.stringify(payload), updated_at: updatedAt };
    if (idx >= 0) t[idx] = row;
    else t.push(row);
  };

  return {
    executeSql,
    sqlBatch,
    tables,
    statements: allStatements,
    seedBlob,
    ensurePlaybackSchema: () => {
      // Pre-create the normalized empty tables (matches what
      // ensureLibrarySchemaAsync(db,"playback") does in production).
      ensureTable("media_formats");
      ensureTable("media_format_chunks");
      ensureTable("media_audio_tracks");
      ensureTable("media_audio_chunks");
      ensureTable("media_subtitles");
      ensureTable("media_chapters");
    },
    ensureBlobTable: () => ensureTable("media_playback_blob"),
  };
};

const samplePayload = (mediaId: string) => ({
  formats: [
    {
      id: "fmt-1080p",
      mediaId,
      fileId: "file-1",
      quality: "1080p",
      codec: "h264",
      codecString: "avc1.640028",
      bitrateKbps: 5000,
      sizeMb: 1500,
      initKey: "init.mp4",
      initSize: 1024,
      durationSeconds: 5400,
      totalSize: 1_500_000_000,
      chunks: [
        { key: "chunk-0", sizeBytes: 4_000_000, startSeconds: 0 },
        { key: "chunk-1", sizeBytes: 4_000_000, startSeconds: 6 },
        { key: "chunk-2", sizeBytes: 4_000_000, startSeconds: 12 },
      ],
    },
    {
      id: "fmt-720p",
      mediaId,
      fileId: "file-1",
      quality: "720p",
      codec: "h264",
      codecString: null,
      bitrateKbps: 2500,
      sizeMb: 700,
      initKey: null,
      initSize: null,
      durationSeconds: null,
      totalSize: null,
      chunks: [{ key: "chunk-0-720", sizeBytes: 2_000_000, startSeconds: 0 }],
    },
  ],
  audioTracks: [
    {
      id: "audio-en",
      mediaId,
      fileId: "file-1",
      episodeId: null,
      language: "en",
      label: "English",
      isDefault: true,
      source: "embedded",
      codec: "aac",
      codecString: "mp4a.40.2",
      initKey: null,
      initSize: null,
      durationSeconds: 5400,
      totalSize: 100_000_000,
      chunks: [
        { key: "audio-en-0", sizeBytes: 500_000, startSeconds: 0 },
        { key: "audio-en-1", sizeBytes: 500_000, startSeconds: 6 },
      ],
    },
  ],
  subtitles: [
    {
      id: "sub-en",
      mediaId,
      fileId: "file-1",
      episodeId: null,
      language: "en",
      label: "English",
      objectKey: "subs/en.vtt",
      format: "vtt",
      isDefault: false,
      source: "external",
      createdAt: "2025-01-01T00:00:00.000Z",
    },
  ],
  chapters: [
    { id: "chap-1", formatId: "fmt-1080p", title: "Intro", startSeconds: 0 },
    { id: "chap-2", formatId: "fmt-1080p", title: "Act 1", startSeconds: 120 },
  ],
});

// On assertion failure, dump the normalized-table row counts, the recorded
// SQL statement tail, and the surviving table registry so a migration
// regression can be diagnosed offline without re-running by hand. Body is
// wrapped in try/catch so a dump failure can never mask the real assertion.
type FakeDb = ReturnType<typeof makeFakeDb>;
const dumpBlobMigrationSnapshot = (label: string, db: FakeDb) => {
  try {
    const tableNames = Array.from(db.tables.keys());
    const counts: Record<string, number> = {};
    for (const name of tableNames) counts[name] = db.tables.get(name)?.length ?? 0;
    const lastStatements = db.statements.slice(-12).map((s, i) => ({
      idx: db.statements.length - Math.min(12, db.statements.length) + i,
      sql: s.sql.trim().slice(0, 100),
      params: s.params,
    }));
    console.error(`=== [library-playback-blob-migration:${label}] snapshot ===`);
    console.error(`tables present: ${JSON.stringify(tableNames)}`);
    console.error(`blob-table still present: ${db.tables.has("media_playback_blob")}`);
    console.error(`row counts: ${JSON.stringify(counts)}`);
    console.error(`total statements recorded: ${db.statements.length}`);
    console.error(`last 12 statements:\n${JSON.stringify(lastStatements, null, 2)}`);
    console.error(`media_formats rows:\n${JSON.stringify(db.tables.get("media_formats") ?? [], null, 2)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("normalizePlaybackBlobRows — Phase 4 one-time migration", () => {
  it("explodes seeded blob payload into the six normalized tables", async () => {
    console.info(`[library-playback-blob-migration:setup] explode-test: building fake db + playback schema`);
    const db = makeFakeDb();
    db.ensurePlaybackSchema();
    db.ensureBlobTable();
    const mediaId = "media-A";
    db.seedBlob(mediaId, samplePayload(mediaId));
    console.info(`[library-playback-blob-migration:setup] seeded blob for mediaId=${mediaId}; tables=${JSON.stringify(Array.from(db.tables.keys()))}`);

    console.info(`[library-playback-blob-migration:run] normalizePlaybackBlobRows (explode)`);
    await normalizePlaybackBlobRows(db as never);
    console.info(`[library-playback-blob-migration:run] done; statements=${db.statements.length}`);

    try {
      const formats = db.tables.get("media_formats")!.filter((r) => r.media_id === mediaId);
      expect(formats).toHaveLength(2);
      expect(formats.map((f) => f.quality).sort()).toEqual(["1080p", "720p"]);
      expect(formats.find((f) => f.quality === "1080p")!.bitrate_kbps).toBe(5000);
      expect(formats.find((f) => f.quality === "1080p")!.size_mb).toBe(1500);

      const chunks = db.tables.get("media_format_chunks")!;
      expect(chunks).toHaveLength(4);
      const oneEighty = chunks.filter((c) => c.format_id === "fmt-1080p")
        .sort((a, b) => (a.order_index as number) - (b.order_index as number));
      expect(oneEighty.map((c) => c.chunk_key)).toEqual(["chunk-0", "chunk-1", "chunk-2"]);
      expect(oneEighty.map((c) => c.order_index)).toEqual([0, 1, 2]);

      const tracks = db.tables.get("media_audio_tracks")!;
      expect(tracks).toHaveLength(1);
      expect(tracks[0]!.language).toBe("en");
      expect(tracks[0]!.is_default).toBe(1);
      expect(tracks[0]!.codec).toBe("aac");

      const audioChunks = db.tables.get("media_audio_chunks")!
        .sort((a, b) => (a.order_index as number) - (b.order_index as number));
      expect(audioChunks.map((c) => c.chunk_key)).toEqual(["audio-en-0", "audio-en-1"]);

      const subs = db.tables.get("media_subtitles")!;
      expect(subs).toHaveLength(1);
      expect(subs[0]!.object_key).toBe("subs/en.vtt");
      expect(subs[0]!.format).toBe("vtt");

      const chapters = db.tables.get("media_chapters")!
        .sort((a, b) => (a.start_seconds as number) - (b.start_seconds as number));
      expect(chapters).toHaveLength(2);
      expect(chapters.map((c) => c.title)).toEqual(["Intro", "Act 1"]);
      expect(chapters.every((c) => c.format_id === "fmt-1080p")).toBe(true);
    } catch (err) {
      console.error(`[library-playback-blob-migration:explode] assertion failed — dumping state`);
      dumpBlobMigrationSnapshot("explode-assert-failure", db);
      throw err;
    }
  });

  it("drops media_playback_blob after the migration completes", async () => {
    console.info(`[library-playback-blob-migration:setup] drop-test: seeding media-B blob`);
    const db = makeFakeDb();
    db.ensurePlaybackSchema();
    db.ensureBlobTable();
    db.seedBlob("media-B", samplePayload("media-B"));

    console.info(`[library-playback-blob-migration:run] normalizePlaybackBlobRows (drop-check)`);
    await normalizePlaybackBlobRows(db as never);
    console.info(`[library-playback-blob-migration:run] done; blob-present=${db.tables.has("media_playback_blob")}`);

    if (db.tables.has("media_playback_blob")) {
      console.error(`[library-playback-blob-migration:drop] blob table NOT dropped — dumping state`);
      dumpBlobMigrationSnapshot("drop-assert-failure", db);
    }
    expect(db.tables.has("media_playback_blob")).toBe(false);
  });

  it("is a no-op when run a second time (table already dropped)", async () => {
    console.info(`[library-playback-blob-migration:setup] noop-2nd-run: seeding media-C blob`);
    const db = makeFakeDb();
    db.ensurePlaybackSchema();
    db.ensureBlobTable();
    db.seedBlob("media-C", samplePayload("media-C"));

    console.info(`[library-playback-blob-migration:run] first run`);
    await normalizePlaybackBlobRows(db as never);
    const formatsAfterFirst = db.tables.get("media_formats")!.length;
    const stmtsAfterFirst = db.statements.length;
    console.info(`[library-playback-blob-migration:run] first run done; formats=${formatsAfterFirst} statements=${stmtsAfterFirst}`);

    console.info(`[library-playback-blob-migration:run] second run (expect no-op)`);
    await expect(normalizePlaybackBlobRows(db as never)).resolves.toBeUndefined();

    const afterSecond = db.statements.slice(stmtsAfterFirst);
    console.info(`[library-playback-blob-migration:run] second run added ${afterSecond.length} statement(s): ${JSON.stringify(afterSecond.map((s) => s.sql.trim().slice(0, 60)))}`);
    try {
      expect(db.tables.get("media_formats")!.length).toBe(formatsAfterFirst);
      // Only the sqlite_master probe ran the second time.
      expect(afterSecond.length).toBe(1);
      expect(afterSecond[0]!.sql.toUpperCase()).toContain("SQLITE_MASTER");
    } catch (err) {
      console.error(`[library-playback-blob-migration:noop-2nd-run] assertion failed — second run was not a clean no-op`);
      console.error(`=== [library-playback-blob-migration:noop-2nd-run] second-run statements ===`);
      console.error(`${JSON.stringify(afterSecond, null, 2)}`);
      dumpBlobMigrationSnapshot("noop-2nd-run-assert-failure", db);
      throw err;
    }
  });

  it("is a no-op on fresh installs (blob table never existed)", async () => {
    console.info(`[library-playback-blob-migration:setup] fresh-install: playback schema only, NO blob table`);
    const db = makeFakeDb();
    db.ensurePlaybackSchema();
    // Note: no ensureBlobTable() — this is the fresh-install state.

    console.info(`[library-playback-blob-migration:run] normalizePlaybackBlobRows (fresh-install)`);
    await expect(normalizePlaybackBlobRows(db as never)).resolves.toBeUndefined();
    console.info(`[library-playback-blob-migration:run] done; media_formats=${db.tables.get("media_formats")!.length} blob-present=${db.tables.has("media_playback_blob")}`);

    try {
      expect(db.tables.get("media_formats")!.length).toBe(0);
      expect(db.tables.has("media_playback_blob")).toBe(false);
    } catch (err) {
      console.error(`[library-playback-blob-migration:fresh-install] assertion failed — fresh install was not a clean no-op`);
      dumpBlobMigrationSnapshot("fresh-install-assert-failure", db);
      throw err;
    }
  });

  it("partial-crash retry converges to the same normalized rows (idempotent via stable IDs)", async () => {
    console.info(`[library-playback-blob-migration:setup] partial-crash-retry: seeding media-D blob`);
    const db = makeFakeDb();
    db.ensurePlaybackSchema();
    db.ensureBlobTable();
    const mediaId = "media-D";
    db.seedBlob(mediaId, samplePayload(mediaId));

    console.info(`[library-playback-blob-migration:run] first run`);
    await normalizePlaybackBlobRows(db as never);
    console.info(`[library-playback-blob-migration:run] first run done; formats=${db.tables.get("media_formats")!.length} chunks=${db.tables.get("media_format_chunks")!.length}`);

    // Simulate a crash where the DROP TABLE was rolled back — re-create the
    // table and the row, then re-run.
    console.info(`[library-playback-blob-migration:crash-sim] re-creating blob table + re-seeding media-D, then re-running`);
    db.ensureBlobTable();
    db.seedBlob(mediaId, samplePayload(mediaId));

    console.info(`[library-playback-blob-migration:run] retry run (expect convergence via stable IDs)`);
    await normalizePlaybackBlobRows(db as never);
    console.info(`[library-playback-blob-migration:run] retry done; formats=${db.tables.get("media_formats")!.length} chunks=${db.tables.get("media_format_chunks")!.length} blob-present=${db.tables.has("media_playback_blob")}`);

    try {
      expect(db.tables.get("media_formats")!.length).toBe(2);
      expect(db.tables.get("media_format_chunks")!.length).toBe(4);
      expect(db.tables.get("media_audio_tracks")!.length).toBe(1);
      expect(db.tables.get("media_subtitles")!.length).toBe(1);
      expect(db.tables.get("media_chapters")!.length).toBe(2);
      expect(db.tables.has("media_playback_blob")).toBe(false);
    } catch (err) {
      console.error(`[library-playback-blob-migration:partial-crash-retry] assertion failed — retry did NOT converge to expected rows (duplicate-row regression?)`);
      dumpBlobMigrationSnapshot("partial-crash-retry-assert-failure", db);
      throw err;
    }
  });
});
