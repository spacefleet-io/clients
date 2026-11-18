/**
 * @test-id LIB-DB-OP-STREAM-V2-IS-SOURCE-001
 * @level unit
 *
 * Prior-format-open test for the OP_STREAM_VERSION bump from 1 → 2.
 *
 * v2 introduces `is_source` as the 13th column of the
 * `INSERT OR REPLACE INTO media_formats` statement emitted by
 * `appendMediaPlayback` for the `media.upsert` op. v1 payloads were authored
 * without an `isSource` field on `MediaFormat`. Per the library-
 * format rule, every op-stream version bump ships with a test that takes a
 * pre-bump payload and verifies it still replays correctly.
 *
 * The "correct" v1-replay behaviour:
 *   - `buildOpStatements` MUST NOT throw on the missing `isSource` field.
 *   - The emitted SQL is the v2 shape (13 columns). The 13th param defaults
 *     to `0` (= is_source `false`) for v1 payloads. This is safe because the
 *     local SQLite column DEFAULT is `0`, the storage round-trip is
 *     consistent, and the next source-job commit re-derives is_source via the
 *     Phase 2 logic.
 *   - A v2 payload (with `isSource: true`) emits `1` as the 13th param.
 *
 * Pre-fix (v1 builder, 12-column INSERT) this test fails: the SQL shape and
 * column count don't match the v2 expectations.
 * Post-fix (v2 builder, 13-column INSERT with is_source) it passes.
 *
 * Later, additive within v2: `preview_sheets` (MPV-PREV-01) follows as the
 * 14th column, so `is_source` is pinned by position (index 12), not as the
 * last param. A format without `previewSheets` fills that column with a
 * subquery keeping the stored record (5 params: media, id, file, quality, id).
 */
import { describe, expect, it } from "vitest";
import type { MediaDetails, MediaFormat } from "@space/shared";
import type { LibraryOp } from "@space/shared/libraryOps";
import {
  buildOpStatements,
  OP_STREAM_VERSION,
  MIN_SUPPORTED_OP_STREAM_VERSION,
  type IdGenerator,
} from "../src/ops";

const SUITE = "op-stream-v2-is-source";

const seededIds = (): IdGenerator => {
  let n = 0;
  return () => `gen-${String(++n).padStart(3, "0")}`;
};

const baseDetails = (overrides: Partial<MediaDetails>): MediaDetails => ({
  id: "media-1",
  type: "movie",
  tmdbId: 42,
  externalIds: { imdb: "tt0001" },
  title: "Example",
  originalTitle: null,
  originalLanguage: "en",
  overview: null,
  year: "2020",
  rating: null,
  posterPath: null,
  backdropPath: null,
  genres: [],
  addedAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
  hasFiles: true,
  progressPct: 0,
  lastWatchedAt: null,
  totalEpisodes: null,
  episodeCount: 0,
  cast: [],
  playlistIds: [],
  seasons: [],
  episodes: [],
  trailers: [],
  files: [
    {
      id: "file-1",
      filename: "movie.mkv",
      season: null,
      episode: null,
      desiredFormats: [],
    },
  ] as MediaDetails["files"],
  formats: [],
  audioTracks: [],
  subtitleTracks: [],
  subtitles: [],
  chapters: [],
  skipMarkers: [],
  hasLocalFiles: false,
  ...overrides,
});

/**
 * A pre-v2 `MediaFormat` shape: every v1 field present, NO `isSource`. We
 * cast the literal to `MediaFormat` to model the historical type — the new
 * `MediaFormat` makes `isSource` optional, so this also represents what a
 * legitimate older publisher would emit on the wire (a JSON payload with no
 * `is_source` key).
 */
const v1Format = (): MediaFormat =>
  ({
    id: "fmt-v1",
    mediaId: "media-1",
    fileId: "file-1",
    quality: "1080p",
    codec: "h264",
    codecString: null,
    bitrateKbps: 5000,
    sizeMb: 1500,
    initKey: null,
    initSize: null,
    durationSeconds: 7200,
    totalSize: 1_500_000_000,
    chunks: [],
    // isSource omitted on purpose — v1 wire shape.
  }) as MediaFormat;

const v2SourceFormat = (): MediaFormat => ({
  id: "fmt-v2-source",
  mediaId: "media-1",
  fileId: "file-1",
  quality: "1080p",
  codec: "h264",
  codecString: null,
  bitrateKbps: 5000,
  sizeMb: 1500,
  initKey: null,
  initSize: null,
  durationSeconds: 7200,
  totalSize: 1_500_000_000,
  chunks: [],
  isSource: true,
});

const v2NonSourceFormat = (): MediaFormat => ({
  id: "fmt-v2-360p",
  mediaId: "media-1",
  fileId: "file-1",
  quality: "360p",
  codec: "h264",
  codecString: null,
  bitrateKbps: 5000,
  sizeMb: 1500,
  initKey: null,
  initSize: null,
  durationSeconds: 7200,
  totalSize: 200_000_000,
  chunks: [],
  isSource: false,
});

const findMediaFormatsInsert = (
  statements: ReadonlyArray<{ sql: string; params: ReadonlyArray<unknown> }>,
) => statements.filter((s) => s.sql.includes("INSERT OR REPLACE INTO media_formats"));

const dumpOpStreamSnapshot = (
  label: string,
  ctx: {
    op?: LibraryOp;
    inserts?: ReadonlyArray<{ sql: string; params: ReadonlyArray<unknown> }>;
    allPlaybackStatements?: ReadonlyArray<{ sql: string; params: ReadonlyArray<unknown> }>;
    expectedShape?: string;
    note?: string;
  } = {},
) => {
  try {
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    if (ctx.note) console.error(`note: ${ctx.note}`);
    console.error(
      `version constants: OP_STREAM_VERSION=${OP_STREAM_VERSION} MIN_SUPPORTED=${MIN_SUPPORTED_OP_STREAM_VERSION}`,
    );
    if (ctx.op) {
      console.error(`op:\n${JSON.stringify(ctx.op, null, 2)}`);
    }
    if (ctx.expectedShape) {
      console.error(`expected SQL shape: ${ctx.expectedShape}`);
    }
    if (ctx.inserts) {
      console.error(`media_formats inserts (${ctx.inserts.length}):`);
      ctx.inserts.forEach((stmt, idx) => {
        console.error(
          `  [${idx}] sql=${stmt.sql.slice(0, 200)}${stmt.sql.length > 200 ? "…" : ""}`,
        );
        console.error(
          `  [${idx}] paramCount=${stmt.params.length} params=${JSON.stringify(stmt.params)}`,
        );
        console.error(
          `  [${idx}] param[12](is_source)=${JSON.stringify(stmt.params[12])}`,
        );
      });
    }
    if (ctx.allPlaybackStatements) {
      console.error(`all playback-group statements (${ctx.allPlaybackStatements.length}):`);
      ctx.allPlaybackStatements.forEach((stmt, idx) => {
        console.error(`  [${idx}] ${stmt.sql.slice(0, 200)}`);
      });
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("OP_STREAM_VERSION bump 1 → 2 — version constants", () => {
  console.info(
    `[${SUITE}:setup] OP_STREAM_VERSION=${OP_STREAM_VERSION} MIN_SUPPORTED=${MIN_SUPPORTED_OP_STREAM_VERSION}`,
  );
  it("OP_STREAM_VERSION is 2 (this bump)", () => {
    try {
      expect(OP_STREAM_VERSION).toBe(2);
    } catch (err) {
      dumpOpStreamSnapshot("op-stream-version-mismatch", {
        note: `expected OP_STREAM_VERSION=2 for is_source bump; actual=${OP_STREAM_VERSION}`,
      });
      throw err;
    }
  });

  it("MIN_SUPPORTED_OP_STREAM_VERSION stays at 1 — v1 streams still readable", () => {
    try {
      expect(MIN_SUPPORTED_OP_STREAM_VERSION).toBe(1);
      expect(MIN_SUPPORTED_OP_STREAM_VERSION).toBeLessThan(OP_STREAM_VERSION);
    } catch (err) {
      dumpOpStreamSnapshot("min-supported-or-invariant-mismatch", {
        note: "v1 streams should still be accepted (min=1); also min < current",
      });
      throw err;
    }
  });
});

describe("op-stream v1 replay — pre-bump media.upsert payload", () => {
  it("media.upsert with a v1 format (no isSource) does NOT throw", () => {
    const op: LibraryOp = {
      id: "op-v1-replay",
      type: "media.upsert",
      createdAt: "2024-01-01T00:00:00.000Z",
      payload: { details: baseDetails({ formats: [v1Format()] }) },
    };

    console.info(`[${SUITE}:v1-replay-no-throw] running buildOpStatements on v1-shape format`);
    let thrown: unknown;
    try {
      buildOpStatements(op, seededIds());
    } catch (e) {
      thrown = e;
    }
    console.info(
      `[${SUITE}:v1-replay-no-throw] thrown=${thrown !== undefined} ${thrown ? `err=${(thrown as Error).message}` : ""}`,
    );
    try {
      expect(thrown).toBeUndefined();
    } catch (err) {
      dumpOpStreamSnapshot("v1-replay-threw", {
        op,
        note: `v1 payload must replay without throwing; got: ${thrown instanceof Error ? thrown.message : String(thrown)}`,
      });
      throw err;
    }
  });

  it("emits the v2 SQL shape with is_source = 0 for a v1 (no-isSource) format", () => {
    const op: LibraryOp = {
      id: "op-v1-replay",
      type: "media.upsert",
      createdAt: "2024-01-01T00:00:00.000Z",
      payload: { details: baseDetails({ formats: [v1Format()] }) },
    };

    console.info(`[${SUITE}:v1-shape-13-cols] expecting 13-col INSERT with last param=0`);
    const out = buildOpStatements(op, seededIds());
    const inserts = findMediaFormatsInsert(out.playback ?? []);
    console.info(
      `[${SUITE}:v1-shape-13-cols] insertsFound=${inserts.length} paramCount=${inserts[0]?.params.length ?? "n/a"} lastParam=${JSON.stringify(inserts[0]?.params[inserts[0]?.params.length - 1])}`,
    );
    try {
      expect(inserts).toHaveLength(1);
      const stmt = inserts[0]!;
      // 13-column v2 shape — verifies the SQL drift is the intentional one.
      expect(stmt.sql).toContain("is_source");
      expect(stmt.sql).toMatch(/VALUES \(\?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \(SELECT preview_sheets FROM media_formats/);
      // 13 column params + 5 carry-forward params (no previewSheets in the payload). The 13th (index 12) is is_source.
      expect(stmt.params).toHaveLength(18);
      expect(stmt.params[12]).toBe(0);
      expect(stmt.params.slice(13)).toEqual(["media-1", stmt.params[0], stmt.params[2], stmt.params[3], stmt.params[0]]);
    } catch (err) {
      dumpOpStreamSnapshot("v1-shape-13-cols-mismatch", {
        op,
        inserts,
        allPlaybackStatements: out.playback ?? [],
        expectedShape: "13-col INSERT; last param = 0",
        note: "v1 payload must emit v2 SQL shape with is_source defaulting to 0",
      });
      throw err;
    }
  });
});

describe("op-stream v2 — fresh media.upsert payload with isSource flag", () => {
  it("a v2 source format emits is_source = 1 as the 13th param", () => {
    const op: LibraryOp = {
      id: "op-v2-source",
      type: "media.upsert",
      createdAt: "2024-01-01T00:00:00.000Z",
      payload: { details: baseDetails({ formats: [v2SourceFormat()] }) },
    };
    console.info(`[${SUITE}:v2-source-1] expecting 13-col INSERT with last param=1`);
    const out = buildOpStatements(op, seededIds());
    const inserts = findMediaFormatsInsert(out.playback ?? []);
    console.info(
      `[${SUITE}:v2-source-1] insertsFound=${inserts.length} lastParam=${JSON.stringify(inserts[0]?.params[inserts[0]?.params.length - 1])}`,
    );
    try {
      expect(inserts).toHaveLength(1);
      expect(inserts[0]!.params).toHaveLength(18);
      expect(inserts[0]!.params[12]).toBe(1);
    } catch (err) {
      dumpOpStreamSnapshot("v2-source-not-1", {
        op,
        inserts,
        allPlaybackStatements: out.playback ?? [],
        expectedShape: "13-col INSERT; last param = 1",
        note: "v2 source format must emit is_source=1",
      });
      throw err;
    }
  });

  it("a v2 non-source format emits is_source = 0 as the 13th param", () => {
    const op: LibraryOp = {
      id: "op-v2-non-source",
      type: "media.upsert",
      createdAt: "2024-01-01T00:00:00.000Z",
      payload: { details: baseDetails({ formats: [v2NonSourceFormat()] }) },
    };
    console.info(`[${SUITE}:v2-non-source-0] expecting last param=0`);
    const out = buildOpStatements(op, seededIds());
    const inserts = findMediaFormatsInsert(out.playback ?? []);
    console.info(
      `[${SUITE}:v2-non-source-0] insertsFound=${inserts.length} lastParam=${JSON.stringify(inserts[0]?.params[inserts[0]?.params.length - 1])}`,
    );
    try {
      expect(inserts).toHaveLength(1);
      expect(inserts[0]!.params).toHaveLength(18);
      expect(inserts[0]!.params[12]).toBe(0);
    } catch (err) {
      dumpOpStreamSnapshot("v2-non-source-not-0", {
        op,
        inserts,
        allPlaybackStatements: out.playback ?? [],
        expectedShape: "13-col INSERT; last param = 0",
        note: "v2 non-source format must emit is_source=0",
      });
      throw err;
    }
  });

  it("mixed v2 payload: one source + one non-source emit (1, 0) in the expected slots", () => {
    const op: LibraryOp = {
      id: "op-v2-mixed",
      type: "media.upsert",
      createdAt: "2024-01-01T00:00:00.000Z",
      payload: {
        details: baseDetails({
          formats: [v2SourceFormat(), v2NonSourceFormat()],
        }),
      },
    };
    console.info(`[${SUITE}:v2-mixed] expecting 2 inserts with sources differing`);
    const out = buildOpStatements(op, seededIds());
    const inserts = findMediaFormatsInsert(out.playback ?? []);
    const sourceInsert = inserts.find((s) => s.params[0] === "fmt-v2-source");
    const nonSourceInsert = inserts.find((s) => s.params[0] === "fmt-v2-360p");
    console.info(
      `[${SUITE}:v2-mixed] insertsFound=${inserts.length} sourceFound=${sourceInsert !== undefined} nonSourceFound=${nonSourceInsert !== undefined}`,
    );
    try {
      expect(inserts).toHaveLength(2);
      expect(sourceInsert).toBeDefined();
      expect(nonSourceInsert).toBeDefined();
      expect(sourceInsert!.params[12]).toBe(1);
      expect(nonSourceInsert!.params[12]).toBe(0);
    } catch (err) {
      dumpOpStreamSnapshot("v2-mixed-mismatch", {
        op,
        inserts,
        allPlaybackStatements: out.playback ?? [],
        expectedShape: "2 inserts: source→1, non-source→0",
        note: "v2 mixed payload should emit exactly the (1, 0) source-of-truth pair",
      });
      throw err;
    }
  });
});

describe("v1 ↔ v2 SQL-shape parity — same column order, only is_source appended", () => {
  it("v1-shape (no isSource) and v2-shape (isSource set) emit the SAME SQL string", () => {
    // Both formats are processed by the same builder, so the SQL is shared.
    // Pin this so a future builder fork doesn't silently emit two different
    // statements for v1 vs v2 inputs.
    const v1Op: LibraryOp = {
      id: "op-shape-v1",
      type: "media.upsert",
      createdAt: "2024-01-01T00:00:00.000Z",
      payload: { details: baseDetails({ formats: [v1Format()] }) },
    };
    const v2Op: LibraryOp = {
      id: "op-shape-v2",
      type: "media.upsert",
      createdAt: "2024-01-01T00:00:00.000Z",
      payload: { details: baseDetails({ formats: [v2SourceFormat()] }) },
    };

    console.info(`[${SUITE}:shape-parity] running v1 + v2 builds, expecting identical SQL strings`);
    const v1Out = buildOpStatements(v1Op, seededIds()).playback ?? [];
    const v2Out = buildOpStatements(v2Op, seededIds()).playback ?? [];
    const v1Insert = findMediaFormatsInsert(v1Out)[0]!;
    const v2Insert = findMediaFormatsInsert(v2Out)[0]!;
    console.info(
      `[${SUITE}:shape-parity] v1.paramCount=${v1Insert.params.length} v2.paramCount=${v2Insert.params.length} sqlMatch=${v1Insert.sql === v2Insert.sql}`,
    );

    try {
      expect(v1Insert.sql).toBe(v2Insert.sql);
      expect(v1Insert.params).toHaveLength(v2Insert.params.length);
      // Only the is_source param (index 12) diverges between v1 (0) and v2 (1).
      for (let i = 0; i < v1Insert.params.length - 1; i += 1) {
        // The id, size, etc. differ by fixture; assert structural equality of
        // the FRAME, not the values. The crucial point is that the schemas
        // are identical column-by-column.
        expect(typeof v1Insert.params[i]).toBe(typeof v2Insert.params[i]);
      }
      expect(v1Insert.params[12]).toBe(0);
      expect(v2Insert.params[12]).toBe(1);
    } catch (err) {
      dumpOpStreamSnapshot("v1-v2-sql-parity-broken", {
        op: v1Op,
        inserts: [v1Insert, v2Insert],
        allPlaybackStatements: [...v1Out, ...v2Out],
        expectedShape: "v1.sql === v2.sql; only param[12] differs (0 vs 1)",
        note: "v1 and v2 inputs must produce identical SQL string — drift would split implementations",
      });
      throw err;
    }
  });
});
