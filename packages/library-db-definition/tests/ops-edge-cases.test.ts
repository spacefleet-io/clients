/**
 * @test-id LIB-DB-OPS-EDGE-001
 * @level unit
 * @why ops.test.ts and ops-golden.test.ts pin happy-path SQL routing.
 *   Production payloads also contain empty arrays, unicode strings,
 *   embedded quotes, malformed progress percentages, null metadata, and
 *   mixed-source external-id collisions. The shared builder needs to
 *   stay defensively correct for those — params are bound, not
 *   interpolated; clamping is consistent; null vs object distinction in
 *   ingest meta is preserved. A regression in any of these would slip
 *   past the golden snapshots (they pin a representative case, not
 *   every boundary).
 */
import { describe, expect, test } from "vitest";
import type {
  IngestJob,
  IngestJobEvent,
  IngestJobStatus,
  MediaDetails,
} from "@space/shared";
import type { LibraryOp } from "@space/shared/libraryOps";
import { buildOpStatements, type IdGenerator } from "../src/ops";

const SUITE = "ops-edge-cases";

type EdgeStatement = { sql: string; params: ReadonlyArray<unknown> };

const dumpEdgeCaseSnapshot = (
  label: string,
  ctx: {
    edgeCaseInput?: unknown;
    op?: LibraryOp;
    opType?: string;
    parsedOutput?: Record<string, ReadonlyArray<EdgeStatement> | undefined>;
    expectedParam?: { position: number | string; expected: unknown; actual: unknown };
    expectedClampOrCoercion?: string;
    errorOrWarningTrail?: ReadonlyArray<string>;
    deleteOrderActual?: ReadonlyArray<number>;
    deleteOrderExpected?: ReadonlyArray<number>;
    placeholderCount?: number;
    paramsCount?: number;
  },
) => {
  try {
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    if (ctx.opType) console.error(`op.type: ${ctx.opType}`);
    if (ctx.edgeCaseInput !== undefined) {
      console.error(`edge-case input:\n${JSON.stringify(ctx.edgeCaseInput, null, 2)}`);
    }
    if (ctx.op) {
      console.error(`full op:\n${JSON.stringify(ctx.op, null, 2)}`);
    }
    if (ctx.parsedOutput) {
      const summary: Record<string, EdgeStatement[]> = {};
      for (const [g, stmts] of Object.entries(ctx.parsedOutput)) {
        summary[g] = (stmts ?? []).map((s) => ({ sql: s.sql, params: s.params }));
      }
      console.error(`parsed buildOpStatements output:\n${JSON.stringify(summary, null, 2)}`);
    }
    if (ctx.expectedParam) {
      console.error(`expected param at ${ctx.expectedParam.position}: expected=${JSON.stringify(ctx.expectedParam.expected)} actual=${JSON.stringify(ctx.expectedParam.actual)}`);
    }
    if (ctx.expectedClampOrCoercion) {
      console.error(`expected clamp/coercion: ${ctx.expectedClampOrCoercion}`);
    }
    if (ctx.errorOrWarningTrail) {
      console.error(`error/warning trail:\n${JSON.stringify(ctx.errorOrWarningTrail, null, 2)}`);
    }
    if (ctx.deleteOrderActual !== undefined) {
      console.error(`delete order indexes (actual): ${JSON.stringify(ctx.deleteOrderActual)}`);
    }
    if (ctx.deleteOrderExpected !== undefined) {
      console.error(`delete order indexes (expected): ${JSON.stringify(ctx.deleteOrderExpected)}`);
    }
    if (ctx.placeholderCount !== undefined && ctx.paramsCount !== undefined) {
      console.error(`placeholder vs param mismatch: placeholders=${ctx.placeholderCount} params=${ctx.paramsCount}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

const fixedIds = (prefix = "id"): IdGenerator => {
  let n = 0;
  return () => `${prefix}-${++n}`;
};

const opMeta = { id: "op-edge", createdAt: "2024-01-01T00:00:00.000Z" };

const baseDetails = (overrides: Partial<MediaDetails> = {}): MediaDetails => ({
  id: "media-edge",
  type: "movie",
  tmdbId: 1,
  externalIds: {},
  title: "T",
  originalTitle: null,
  originalLanguage: "en",
  overview: null,
  year: "2020",
  rating: null,
  posterPath: null,
  backdropPath: null,
  genres: [],
  addedAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-02T00:00:00.000Z",
  hasFiles: false,
  progressPct: 0,
  lastWatchedAt: null,
  totalEpisodes: null,
  episodeCount: 0,
  cast: [],
  playlistIds: [],
  seasons: [],
  episodes: [],
  trailers: [],
  files: [],
  formats: [],
  audioTracks: [],
  subtitleTracks: [],
  subtitles: [],
  chapters: [],
  skipMarkers: [],
  hasLocalFiles: false,
  ...overrides,
});

const baseJob: IngestJob = {
  id: "job-edge",
  mediaId: "media-edge",
  fileId: null,
  workerPeerId: "peer-1",
  ownerClientId: null,
  kind: "transcode",
  status: "processing" as IngestJobStatus,
  progressPct: 0,
  errorCode: null,
  errorMessage: null,
  meta: null,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
  completedAt: null,
};

describe("media.upsert — empty nested arrays still emit DELETE preambles", () => {
  test("empty cast emits the media_roles DELETE but no role/people inserts", () => {
    console.info(`[${SUITE}:empty-cast] edge=cast:[] expect DELETE + no INSERTs`);
    const op: LibraryOp = {
      ...opMeta,
      type: "media.upsert",
      payload: { details: baseDetails({ cast: [] }) },
    };
    const out = buildOpStatements(op, fixedIds());
    const meta = out.metadata ?? [];

    try {
      expect(meta.some((s) => s.sql === "DELETE FROM media_roles WHERE media_id = ?;")).toBe(true);
      expect(meta.some((s) => s.sql.includes("INSERT OR REPLACE INTO media_roles"))).toBe(false);
      expect(meta.some((s) => s.sql.includes("INSERT OR REPLACE INTO people "))).toBe(false);
    } catch (err) {
      dumpEdgeCaseSnapshot("empty-cast-delete-or-inserts-wrong", {
        edgeCaseInput: { cast: [] },
        opType: op.type,
        parsedOutput: out,
      });
      throw err;
    }
  });

  test("empty trailers emits the trailer DELETE but no trailer inserts", () => {
    console.info(`[${SUITE}:empty-trailers] edge=trailers:[]`);
    const op: LibraryOp = {
      ...opMeta,
      type: "media.upsert",
      payload: { details: baseDetails({ trailers: [] }) },
    };
    const out = buildOpStatements(op, fixedIds());
    const sqls = (out.metadata ?? []).map((s) => s.sql);

    try {
      expect(sqls).toContain("DELETE FROM media_trailers WHERE media_id = ?;");
      expect(sqls.some((sql) => sql.startsWith("INSERT INTO media_trailers"))).toBe(false);
    } catch (err) {
      dumpEdgeCaseSnapshot("empty-trailers-wrong", {
        edgeCaseInput: { trailers: [] },
        opType: op.type,
        parsedOutput: out,
      });
      throw err;
    }
  });

  test("empty seasons + episodes emit DELETEs but no inserts", () => {
    console.info(`[${SUITE}:empty-seasons-episodes] edge=seasons:[],episodes:[]`);
    const op: LibraryOp = {
      ...opMeta,
      type: "media.upsert",
      payload: { details: baseDetails({ seasons: [], episodes: [] }) },
    };
    const out = buildOpStatements(op, fixedIds());
    const sqls = (out.metadata ?? []).map((s) => s.sql);

    try {
      expect(sqls).toContain("DELETE FROM media_seasons WHERE media_id = ?;");
      expect(sqls).toContain("DELETE FROM media_episodes WHERE media_id = ?;");
      expect(sqls.some((sql) => sql.includes("INSERT OR REPLACE INTO media_seasons"))).toBe(false);
      expect(sqls.some((sql) => sql.includes("INSERT OR REPLACE INTO media_episodes"))).toBe(false);
    } catch (err) {
      dumpEdgeCaseSnapshot("empty-seasons-episodes-wrong", {
        edgeCaseInput: { seasons: [], episodes: [] },
        opType: op.type,
        parsedOutput: out,
      });
      throw err;
    }
  });

  test("empty files emits both desired_formats + files DELETEs (in that order)", () => {
    console.info(`[${SUITE}:empty-files] edge=files:[]`);
    const op: LibraryOp = {
      ...opMeta,
      type: "media.upsert",
      payload: { details: baseDetails({ files: [] }) },
    };
    const out = buildOpStatements(op, fixedIds());
    const meta = out.metadata ?? [];
    const desiredIdx = meta.findIndex(
      (s) => s.sql === "DELETE FROM media_file_desired_formats WHERE media_id = ?;"
    );
    const filesIdx = meta.findIndex((s) => s.sql === "DELETE FROM media_files WHERE media_id = ?;");
    console.info(`[${SUITE}:exec] desiredIdx=${desiredIdx} filesIdx=${filesIdx} expected desired<files`);

    try {
      expect(desiredIdx).toBeGreaterThanOrEqual(0);
      expect(filesIdx).toBeGreaterThan(desiredIdx);
    } catch (err) {
      dumpEdgeCaseSnapshot("empty-files-delete-order-wrong", {
        edgeCaseInput: { files: [] },
        opType: op.type,
        parsedOutput: out,
        deleteOrderActual: [desiredIdx, filesIdx],
        deleteOrderExpected: ["desiredIdx", "filesIdx (greater)"] as unknown as number[],
      });
      throw err;
    }
  });

  test("empty playback arrays still clear via correlated subquery DELETEs", () => {
    console.info(`[${SUITE}:empty-playback] edge=formats/audio/subs/chapters all []`);
    const op: LibraryOp = {
      ...opMeta,
      type: "media.upsert",
      payload: {
        details: baseDetails({
          formats: [],
          audioTracks: [],
          subtitles: [],
          chapters: [],
        }),
      },
    };
    const out = buildOpStatements(op, fixedIds());
    const sqls = (out.playback ?? []).map((s) => s.sql);

    try {
      expect(
        sqls.some(
          (sql) =>
            sql.includes("DELETE FROM media_format_chunks") &&
            sql.includes("SELECT id FROM media_formats WHERE media_id = ?")
        )
      ).toBe(true);
      expect(
        sqls.some(
          (sql) =>
            sql.includes("DELETE FROM media_audio_chunks") &&
            sql.includes("SELECT id FROM media_audio_tracks WHERE media_id = ?")
        )
      ).toBe(true);
      expect(sqls).toContain("DELETE FROM media_formats WHERE media_id = ?;");
      expect(sqls).toContain("DELETE FROM media_audio_tracks WHERE media_id = ?;");
      expect(sqls).toContain("DELETE FROM media_subtitles WHERE media_id = ?;");
      // No inserts at all
      expect(sqls.some((sql) => sql.startsWith("INSERT"))).toBe(false);
    } catch (err) {
      dumpEdgeCaseSnapshot("empty-playback-cascade-wrong", {
        edgeCaseInput: { formats: [], audioTracks: [], subtitles: [], chapters: [] },
        opType: op.type,
        parsedOutput: out,
      });
      throw err;
    }
  });

  test("empty skipMarkers emits the skip-markers DELETE", () => {
    console.info(`[${SUITE}:empty-skipMarkers] edge=skipMarkers:[]`);
    const op: LibraryOp = {
      ...opMeta,
      type: "media.upsert",
      payload: { details: baseDetails({ skipMarkers: [] }) },
    };
    const out = buildOpStatements(op, fixedIds());
    const sqls = (out.metadata ?? []).map((s) => s.sql);

    try {
      expect(sqls).toContain("DELETE FROM media_skip_markers WHERE media_id = ?;");
      expect(sqls.some((sql) => sql.includes("INSERT OR REPLACE INTO media_skip_markers"))).toBe(false);
    } catch (err) {
      dumpEdgeCaseSnapshot("empty-skipMarkers-wrong", {
        edgeCaseInput: { skipMarkers: [] },
        opType: op.type,
        parsedOutput: out,
      });
      throw err;
    }
  });
});

describe("media.upsert — external ID handling", () => {
  test("null tmdbId + empty externalIds emits the DELETE only (no inserts)", () => {
    console.info(`[${SUITE}:extid:setup] tmdbId=null externalIds={}`);
    const op: LibraryOp = {
      ...opMeta,
      type: "media.upsert",
      payload: {
        details: baseDetails({ tmdbId: null, externalIds: {} }),
      },
    };
    const out = buildOpStatements(op, fixedIds());
    const core = out.core ?? [];

    try {
      expect(core.some((s) => s.sql.startsWith("DELETE FROM media_external_ids WHERE media_id = ?"))).toBe(true);
      expect(core.some((s) => s.sql.includes("INSERT OR IGNORE INTO media_external_ids"))).toBe(false);
    } catch (err) {
      dumpEdgeCaseSnapshot("extid-empty-inserts-leaked", {
        edgeCaseInput: { tmdbId: null, externalIds: {} },
        opType: op.type,
        parsedOutput: out,
      });
      throw err;
    }
  });

  test("tmdbId present + non-tmdb externalIds emits both kinds of insert", () => {
    console.info(`[${SUITE}:extid:setup] tmdbId=42 externalIds={imdb,tvdb}`);
    const op: LibraryOp = {
      ...opMeta,
      type: "media.upsert",
      payload: {
        details: baseDetails({
          tmdbId: 42,
          externalIds: { imdb: "tt0001", tvdb: "9999" },
        }),
      },
    };
    const out = buildOpStatements(op, fixedIds("ext"));
    const inserts = (out.core ?? []).filter((s) =>
      s.sql.includes("INSERT OR IGNORE INTO media_external_ids")
    );
    const sources = inserts.map((s) => s.params[3]);
    const ids = inserts.map((s) => s.params[0]);
    console.info(`[${SUITE}:extid:exec] inserts.length=${inserts.length} sources=${JSON.stringify(sources)} ids=${JSON.stringify(ids)}`);

    try {
      // 1 tmdb + 2 externalIds entries = 3 inserts
      expect(inserts).toHaveLength(3);
      expect(sources).toEqual(["tmdb", "imdb", "tvdb"]);
      // Generated UUIDs in stable order
      expect(ids).toEqual(["ext-1", "ext-2", "ext-3"]);
    } catch (err) {
      dumpEdgeCaseSnapshot("extid-multi-insert-wrong", {
        edgeCaseInput: { tmdbId: 42, externalIds: { imdb: "tt0001", tvdb: "9999" } },
        opType: op.type,
        parsedOutput: out,
        expectedParam: { position: "params[3] per insert (sources)", expected: ["tmdb", "imdb", "tvdb"], actual: sources },
      });
      throw err;
    }
  });

  test("externalIds with null/undefined value is skipped", () => {
    console.info(`[${SUITE}:extid:skip-null] externalIds={imdb:null,tvdb:undefined,anidb:'12345'} — only anidb should survive`);
    const op: LibraryOp = {
      ...opMeta,
      type: "media.upsert",
      payload: {
        details: baseDetails({
          tmdbId: null,
          // Forces the null/undefined skip branch even though the type doesn't normally allow it.
          externalIds: { imdb: null, tvdb: undefined, anidb: "12345" } as unknown as Record<
            string,
            string | number
          >,
        }),
      },
    };
    const out = buildOpStatements(op, fixedIds());
    const inserts = (out.core ?? []).filter((s) =>
      s.sql.includes("INSERT OR IGNORE INTO media_external_ids")
    );

    try {
      // Only anidb survives
      expect(inserts).toHaveLength(1);
      expect(inserts[0]!.params[3]).toBe("anidb");
      expect(inserts[0]!.params[4]).toBe("12345");
    } catch (err) {
      dumpEdgeCaseSnapshot("extid-null-not-skipped", {
        edgeCaseInput: { imdb: null, tvdb: undefined, anidb: "12345" },
        opType: op.type,
        parsedOutput: out,
        errorOrWarningTrail: [`inserts.length=${inserts.length} expected=1`],
      });
      throw err;
    }
  });

  test("tmdbId is coerced to string even when numeric", () => {
    console.info(`[${SUITE}:extid:tmdb-coerce] tmdbId=9876543210 (numeric, must coerce to string)`);
    const op: LibraryOp = {
      ...opMeta,
      type: "media.upsert",
      payload: { details: baseDetails({ tmdbId: 9876543210 }) },
    };
    const out = buildOpStatements(op, fixedIds());
    const tmdbInsert = (out.core ?? []).find(
      (s) =>
        s.sql.includes("INSERT OR IGNORE INTO media_external_ids") &&
        s.params[3] === "tmdb"
    );
    console.info(`[${SUITE}:extid:tmdb-coerce] tmdbInsert.params[4]=${JSON.stringify(tmdbInsert?.params[4])} type=${typeof tmdbInsert?.params[4]}`);

    try {
      expect(tmdbInsert).toBeDefined();
      expect(tmdbInsert!.params[4]).toBe("9876543210");
      expect(typeof tmdbInsert!.params[4]).toBe("string");
    } catch (err) {
      dumpEdgeCaseSnapshot("tmdbId-coercion-wrong", {
        edgeCaseInput: { tmdbId: 9876543210 },
        opType: op.type,
        parsedOutput: out,
        expectedClampOrCoercion: "tmdbId numeric → string",
        expectedParam: { position: "params[4]", expected: "9876543210 (string)", actual: tmdbInsert?.params[4] },
      });
      throw err;
    }
  });
});

describe("setting.set — unicode + embedded quotes are bound as params (not interpolated)", () => {
  test("embedded quotes don't break the SQL string — they're bound as params", () => {
    console.info(`[${SUITE}:setting:quotes] value contains SQL-injection-ish bytes`);
    const op: LibraryOp = {
      ...opMeta,
      type: "setting.set",
      payload: {
        key: "user.bio",
        value: "Robert'); DROP TABLE app_settings;--",
        updatedAt: "2024-01-01",
      },
    };
    const out = buildOpStatements(op, fixedIds());
    const stmt = out.core![0]!;

    try {
      expect(stmt.sql).toContain("INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)");
      expect(stmt.sql).toContain("WHERE excluded.updated_at >= app_settings.updated_at");
      expect(stmt.params[1]).toBe("Robert'); DROP TABLE app_settings;--");
    } catch (err) {
      dumpEdgeCaseSnapshot("embedded-quotes-not-bound", {
        edgeCaseInput: { value: "Robert'); DROP TABLE app_settings;--" },
        opType: op.type,
        parsedOutput: out,
        expectedParam: { position: "params[1]", expected: "Robert'); DROP TABLE app_settings;--", actual: stmt.params[1] },
      });
      throw err;
    }
  });

  test("unicode setting values are passed through as-is", () => {
    console.info(`[${SUITE}:setting:unicode] value contains kanji+emoji+accented`);
    const op: LibraryOp = {
      ...opMeta,
      type: "setting.set",
      payload: { key: "ui.greeting", value: "こんにちは 🚀 émoji", updatedAt: "2024-01-01" },
    };
    const out = buildOpStatements(op, fixedIds());

    try {
      expect(out.core![0]!.params[1]).toBe("こんにちは 🚀 émoji");
    } catch (err) {
      dumpEdgeCaseSnapshot("unicode-roundtrip-wrong", {
        edgeCaseInput: { value: "こんにちは 🚀 émoji" },
        opType: op.type,
        parsedOutput: out,
        expectedParam: { position: "params[1]", expected: "こんにちは 🚀 émoji", actual: out.core?.[0]?.params[1] },
      });
      throw err;
    }
  });

  test("very long setting values are not truncated by the builder", () => {
    console.info(`[${SUITE}:setting:big] value is 50,000 bytes`);
    const big = "x".repeat(50_000);
    const op: LibraryOp = {
      ...opMeta,
      type: "setting.set",
      payload: { key: "blob", value: big, updatedAt: "2024-01-01" },
    };
    const out = buildOpStatements(op, fixedIds());
    const len = (out.core![0]!.params[1] as string).length;
    console.info(`[${SUITE}:setting:big] observed length=${len} expected=50000`);

    try {
      expect(len).toBe(50_000);
    } catch (err) {
      dumpEdgeCaseSnapshot("big-value-truncated", {
        edgeCaseInput: { valueLength: 50_000 },
        opType: op.type,
        expectedParam: { position: "params[1].length", expected: 50_000, actual: len },
      });
      throw err;
    }
  });
});

describe("ingest ops — clamping, meta serialization, null vs object", () => {
  const checkClamp = (label: string, input: unknown, expected: number) => {
    console.info(`[${SUITE}:clamp:${label}] input=${JSON.stringify(input)} expect params[7]=${expected}`);
    const op: LibraryOp = {
      ...opMeta,
      type: "ingest.job.upsert",
      payload: { job: { ...baseJob, progressPct: input as number } },
    };
    const out = buildOpStatements(op, fixedIds());
    const actual = out.ingest![0]!.params[7];
    try {
      expect(actual).toBe(expected);
    } catch (err) {
      dumpEdgeCaseSnapshot(`clamp-${label}-wrong`, {
        edgeCaseInput: { progressPct: input },
        opType: op.type,
        parsedOutput: out,
        expectedClampOrCoercion: `progressPct ${input} → ${expected}`,
        expectedParam: { position: "params[7]", expected, actual },
      });
      throw err;
    }
  };

  test("progressPct clamps below 0 to 0", () => {
    checkClamp("below-zero", -25, 0);
  });

  test("progressPct clamps above 100 to 100", () => {
    checkClamp("above-100", 150, 100);
  });

  test("progressPct NaN coerces to 0", () => {
    checkClamp("NaN-to-0", Number.NaN, 0);
  });

  test("progressPct non-numeric string coerces to 0", () => {
    checkClamp("string-abc-to-0", "abc", 0);
  });

  test("progressPct float is rounded (not truncated)", () => {
    checkClamp("float-42.7-to-43", 42.7, 43);
  });

  test("ingest.job.upsert — null meta serialises to null (not the string 'null')", () => {
    console.info(`[${SUITE}:meta:null] job.meta=null — expect params[10]===null (not 'null')`);
    const op: LibraryOp = {
      ...opMeta,
      type: "ingest.job.upsert",
      payload: { job: { ...baseJob, meta: null } },
    };
    const out = buildOpStatements(op, fixedIds());
    const actual = out.ingest![0]!.params[10];
    try {
      expect(actual).toBeNull();
    } catch (err) {
      dumpEdgeCaseSnapshot("null-meta-serialization-wrong", {
        edgeCaseInput: { meta: null },
        opType: op.type,
        parsedOutput: out,
        expectedParam: { position: "params[10]", expected: null, actual },
      });
      throw err;
    }
  });

  test("ingest.job.upsert — empty object meta serialises to '{}'", () => {
    console.info(`[${SUITE}:meta:empty-obj] job.meta={} — expect params[10]==='{}'`);
    const op: LibraryOp = {
      ...opMeta,
      type: "ingest.job.upsert",
      payload: { job: { ...baseJob, meta: {} } },
    };
    const out = buildOpStatements(op, fixedIds());
    const actual = out.ingest![0]!.params[10];
    try {
      expect(actual).toBe("{}");
    } catch (err) {
      dumpEdgeCaseSnapshot("empty-obj-meta-serialization-wrong", {
        edgeCaseInput: { meta: {} },
        opType: op.type,
        parsedOutput: out,
        expectedParam: { position: "params[10]", expected: "{}", actual },
      });
      throw err;
    }
  });

  test("ingest.job.upsert — primitive meta (string/number) becomes null because metaJson rejects non-objects", () => {
    // The builder's metaJson helper only serialises plain objects. Anything
    // else collapses to null so the column stays a queryable JSON column
    // rather than a mixed-type bag.
    console.info(`[${SUITE}:meta:primitive] testing string + number meta both collapse to null`);
    const stringMeta: LibraryOp = {
      ...opMeta,
      type: "ingest.job.upsert",
      payload: {
        job: { ...baseJob, meta: "plain string" as unknown as Record<string, unknown> },
      },
    };
    const numberMeta: LibraryOp = {
      ...opMeta,
      type: "ingest.job.upsert",
      payload: {
        job: { ...baseJob, meta: 42 as unknown as Record<string, unknown> },
      },
    };
    const outStr = buildOpStatements(stringMeta, fixedIds());
    const outNum = buildOpStatements(numberMeta, fixedIds());

    try {
      expect(outStr.ingest![0]!.params[10]).toBeNull();
      expect(outNum.ingest![0]!.params[10]).toBeNull();
    } catch (err) {
      dumpEdgeCaseSnapshot("primitive-meta-not-collapsed", {
        edgeCaseInput: { stringMeta: "plain string", numberMeta: 42 },
        opType: "ingest.job.upsert",
        parsedOutput: outStr,
        errorOrWarningTrail: [
          `stringMeta params[10]=${JSON.stringify(outStr.ingest?.[0]?.params[10])}`,
          `numberMeta params[10]=${JSON.stringify(outNum.ingest?.[0]?.params[10])}`,
        ],
      });
      throw err;
    }
  });

  test("ingest.job.event.add — embedded quotes in message bind as params", () => {
    console.info(`[${SUITE}:event:quotes] message contains both single and double quotes`);
    const op: LibraryOp = {
      ...opMeta,
      type: "ingest.job.event.add",
      payload: {
        event: {
          id: "evt-1",
          jobId: "job-1",
          level: "error",
          message: "Worker said: \"can't find file 'foo.mkv'\"",
          meta: null,
          createdAt: "2024-01-01T00:00:00.000Z",
        } as IngestJobEvent,
      },
    };
    const out = buildOpStatements(op, fixedIds());
    try {
      expect(out.ingest![0]!.params[3]).toBe("Worker said: \"can't find file 'foo.mkv'\"");
    } catch (err) {
      dumpEdgeCaseSnapshot("event-quotes-not-bound", {
        edgeCaseInput: "Worker said: \"can't find file 'foo.mkv'\"",
        opType: op.type,
        parsedOutput: out,
        expectedParam: { position: "params[3]", expected: "Worker said: \"can't find file 'foo.mkv'\"", actual: out.ingest?.[0]?.params[3] },
      });
      throw err;
    }
  });

  test("ingest.job.event.add — null meta serialises to null, object meta serialises to JSON string", () => {
    console.info(`[${SUITE}:event:meta] testing null vs object meta serialisation`);
    const nullEvt: LibraryOp = {
      ...opMeta,
      type: "ingest.job.event.add",
      payload: {
        event: {
          id: "evt-1",
          jobId: "job-1",
          level: "info",
          message: "m",
          meta: null,
          createdAt: "2024-01-01T00:00:00.000Z",
        } as IngestJobEvent,
      },
    };
    const objEvt: LibraryOp = {
      ...opMeta,
      type: "ingest.job.event.add",
      payload: {
        event: {
          id: "evt-2",
          jobId: "job-1",
          level: "info",
          message: "m",
          meta: { stage: "upload", attempt: 3 },
          createdAt: "2024-01-01T00:00:00.000Z",
        } as IngestJobEvent,
      },
    };
    const outNull = buildOpStatements(nullEvt, fixedIds());
    const outObj = buildOpStatements(objEvt, fixedIds());

    try {
      expect(outNull.ingest![0]!.params[4]).toBeNull();
      expect(outObj.ingest![0]!.params[4]).toBe(
        JSON.stringify({ stage: "upload", attempt: 3 })
      );
    } catch (err) {
      dumpEdgeCaseSnapshot("event-meta-serialisation-wrong", {
        edgeCaseInput: { nullMeta: null, objMeta: { stage: "upload", attempt: 3 } },
        opType: "ingest.job.event.add",
        parsedOutput: outObj,
        errorOrWarningTrail: [
          `nullMeta params[4]=${JSON.stringify(outNull.ingest?.[0]?.params[4])}`,
          `objMeta params[4]=${JSON.stringify(outObj.ingest?.[0]?.params[4])}`,
        ],
      });
      throw err;
    }
  });

  test("ingest.job.history.clear — placeholder count matches TERMINAL_INGEST_STATUSES exactly", () => {
    console.info(`[${SUITE}:history-clear] expect 4 placeholders + 4 params on both ingest stmts`);
    const op: LibraryOp = {
      ...opMeta,
      type: "ingest.job.history.clear",
      payload: { mediaId: "m-1" },
    };
    const out = buildOpStatements(op, fixedIds());
    // Both statements should have the same placeholder count
    const [eventsDelete, jobsDelete] = out.ingest!;
    const placeholderMatches = (sql: string) => (sql.match(/\?/g) ?? []).length;
    const eventsPlaceholders = placeholderMatches(eventsDelete!.sql);
    const jobsPlaceholders = placeholderMatches(jobsDelete!.sql);
    console.info(`[${SUITE}:history-clear:exec] events: placeholders=${eventsPlaceholders} params=${eventsDelete!.params.length}; jobs: placeholders=${jobsPlaceholders} params=${jobsDelete!.params.length}`);

    try {
      expect(eventsPlaceholders).toBe(4); // 1 mediaId + 3 statuses
      expect(jobsPlaceholders).toBe(4);
      expect(eventsDelete!.params).toHaveLength(4);
      expect(jobsDelete!.params).toHaveLength(4);
    } catch (err) {
      dumpEdgeCaseSnapshot("history-clear-placeholder-mismatch", {
        edgeCaseInput: { mediaId: "m-1" },
        opType: op.type,
        parsedOutput: out,
        placeholderCount: eventsPlaceholders,
        paramsCount: eventsDelete!.params.length,
      });
      throw err;
    }
  });
});

describe("playlist ops — boolean coercion + system playlist semantics", () => {
  test("isSystem=true binds as 1 (SQLite has no native boolean)", () => {
    console.info(`[${SUITE}:playlist:isSystem-true] expect params[3]===1`);
    const op: LibraryOp = {
      ...opMeta,
      type: "playlist.create",
      payload: {
        id: "pl-sys",
        name: "Sys",
        slug: "sys",
        isSystem: true,
        createdAt: "2024-01-01T00:00:00.000Z",
      },
    };
    const out = buildOpStatements(op, fixedIds());
    try {
      expect(out.core![0]!.params[3]).toBe(1);
    } catch (err) {
      dumpEdgeCaseSnapshot("playlist-isSystem-true-not-coerced", {
        edgeCaseInput: { isSystem: true },
        opType: op.type,
        parsedOutput: out,
        expectedParam: { position: "params[3]", expected: 1, actual: out.core?.[0]?.params[3] },
      });
      throw err;
    }
  });

  test("isSystem=false binds as 0", () => {
    console.info(`[${SUITE}:playlist:isSystem-false] expect params[3]===0`);
    const op: LibraryOp = {
      ...opMeta,
      type: "playlist.create",
      payload: {
        id: "pl-norm",
        name: "Norm",
        slug: "norm",
        isSystem: false,
        createdAt: "2024-01-01T00:00:00.000Z",
      },
    };
    const out = buildOpStatements(op, fixedIds());
    try {
      expect(out.core![0]!.params[3]).toBe(0);
    } catch (err) {
      dumpEdgeCaseSnapshot("playlist-isSystem-false-not-coerced", {
        edgeCaseInput: { isSystem: false },
        opType: op.type,
        parsedOutput: out,
        expectedParam: { position: "params[3]", expected: 0, actual: out.core?.[0]?.params[3] },
      });
      throw err;
    }
  });

  test("playlist.delete skips system playlists via is_system = 0 clause", () => {
    // Defensive: the WHERE clause should be hardcoded into the SQL — not a
    // bind param — because we never want to delete the system "All Media"
    // playlist by accident.
    console.info(`[${SUITE}:playlist:delete-skip-system] sql must contain literal "is_system = 0"`);
    const op: LibraryOp = {
      ...opMeta,
      type: "playlist.delete",
      payload: { id: "pl-1" },
    };
    const out = buildOpStatements(op, fixedIds());
    try {
      expect(out.core![0]!.sql).toContain("is_system = 0");
      expect(out.core![0]!.params).toHaveLength(1);
    } catch (err) {
      dumpEdgeCaseSnapshot("playlist-delete-system-skip-wrong", {
        edgeCaseInput: { id: "pl-1" },
        opType: op.type,
        parsedOutput: out,
      });
      throw err;
    }
  });
});

describe("media.upsert — hasFiles boolean coercion", () => {
  test("hasFiles=true binds as 1 in media_items", () => {
    console.info(`[${SUITE}:hasFiles-true] expect params[12]===1`);
    const op: LibraryOp = {
      ...opMeta,
      type: "media.upsert",
      payload: { details: baseDetails({ hasFiles: true }) },
    };
    const out = buildOpStatements(op, fixedIds());
    const mediaInsert = out.core!.find((s) => s.sql.includes("INSERT INTO media_items"));
    try {
      expect(mediaInsert).toBeDefined();
      expect(mediaInsert!.params[12]).toBe(1); // has_files position
    } catch (err) {
      dumpEdgeCaseSnapshot("hasFiles-true-not-coerced", {
        edgeCaseInput: { hasFiles: true },
        opType: op.type,
        parsedOutput: out,
        expectedParam: { position: "params[12]", expected: 1, actual: mediaInsert?.params[12] },
      });
      throw err;
    }
  });

  test("hasFiles=false binds as 0 in media_items", () => {
    console.info(`[${SUITE}:hasFiles-false] expect params[12]===0`);
    const op: LibraryOp = {
      ...opMeta,
      type: "media.upsert",
      payload: { details: baseDetails({ hasFiles: false }) },
    };
    const out = buildOpStatements(op, fixedIds());
    const mediaInsert = out.core!.find((s) => s.sql.includes("INSERT INTO media_items"));
    try {
      expect(mediaInsert!.params[12]).toBe(0);
    } catch (err) {
      dumpEdgeCaseSnapshot("hasFiles-false-not-coerced", {
        edgeCaseInput: { hasFiles: false },
        opType: op.type,
        parsedOutput: out,
        expectedParam: { position: "params[12]", expected: 0, actual: mediaInsert?.params[12] },
      });
      throw err;
    }
  });
});

describe("media.delete — deterministic across-group emission order", () => {
  test("groups emitted always: core, metadata, playback, ingest, templates", () => {
    console.info(`[${SUITE}:media-delete:groups] expect Object.keys=[core,metadata,playback,ingest,templates]`);
    const op: LibraryOp = {
      ...opMeta,
      type: "media.delete",
      payload: { mediaId: "m-1" },
    };
    const out = buildOpStatements(op, fixedIds());
    try {
      expect(Object.keys(out)).toEqual(["core", "metadata", "playback", "ingest", "templates"]);
    } catch (err) {
      dumpEdgeCaseSnapshot("media-delete-groups-order-wrong", {
        opType: op.type,
        parsedOutput: out,
        deleteOrderActual: Object.keys(out) as unknown as number[],
        deleteOrderExpected: ["core", "metadata", "playback", "ingest", "templates"] as unknown as number[],
      });
      throw err;
    }
  });

  test("core delete order is preserved: external_ids → genres → playlist_items → media_items", () => {
    console.info(`[${SUITE}:media-delete:core-order] expect external_ids,genres,playlist_items,media_items at idx 0..3`);
    const op: LibraryOp = {
      ...opMeta,
      type: "media.delete",
      payload: { mediaId: "m-1" },
    };
    const out = buildOpStatements(op, fixedIds());
    const coreSqls = out.core!.map((s) => s.sql);
    const externalIdx = coreSqls.findIndex((sql) => sql.includes("media_external_ids"));
    const genresIdx = coreSqls.findIndex((sql) => sql.includes("media_genres"));
    const playlistIdx = coreSqls.findIndex((sql) => sql.includes("playlist_items"));
    const itemsIdx = coreSqls.findIndex((sql) => sql.endsWith("FROM media_items WHERE id = ?;"));
    console.info(`[${SUITE}:media-delete:core-order:exec] externalIdx=${externalIdx} genresIdx=${genresIdx} playlistIdx=${playlistIdx} itemsIdx=${itemsIdx}`);

    try {
      expect(externalIdx).toBe(0);
      expect(genresIdx).toBe(1);
      expect(playlistIdx).toBe(2);
      expect(itemsIdx).toBe(3); // media_items deleted last so cascades have something to scope on
    } catch (err) {
      dumpEdgeCaseSnapshot("core-delete-order-wrong", {
        opType: op.type,
        parsedOutput: out,
        deleteOrderActual: [externalIdx, genresIdx, playlistIdx, itemsIdx],
        deleteOrderExpected: [0, 1, 2, 3],
      });
      throw err;
    }
  });

  test("templates group emits the media_skip_analysis then the subtitle_ocr_attempts DELETE", () => {
    console.info(`[${SUITE}:media-delete:templates] expect skip_analysis + ocr attempts deletes`);
    const op: LibraryOp = {
      ...opMeta,
      type: "media.delete",
      payload: { mediaId: "m-1" },
    };
    const out = buildOpStatements(op, fixedIds());
    try {
      expect(out.templates).toHaveLength(2);
      expect(out.templates![0]!.sql).toContain("DELETE FROM media_skip_analysis WHERE media_id = ?");
      expect(out.templates![0]!.params).toEqual(["m-1"]);
      expect(out.templates![1]!.sql).toContain("DELETE FROM subtitle_ocr_attempts WHERE media_id = ?");
      expect(out.templates![1]!.params).toEqual(["m-1"]);
    } catch (err) {
      dumpEdgeCaseSnapshot("templates-delete-shape-wrong", {
        opType: op.type,
        parsedOutput: out,
      });
      throw err;
    }
  });
});

describe("buildOpStatements — invariants", () => {
  test("every statement has params as ReadonlyArray (never undefined)", () => {
    console.info(`[${SUITE}:invariants:every-op] iterating 12 op types to verify SQL/params invariants`);
    const allOps: LibraryOp[] = [
      {
        ...opMeta,
        type: "playlist.create",
        payload: { id: "p", name: "P", slug: "p", isSystem: false, createdAt: "t" },
      },
      { ...opMeta, type: "playlist.delete", payload: { id: "p" } },
      {
        ...opMeta,
        type: "playlist.item.add",
        payload: { id: "pi", playlistId: "p", mediaId: "m", addedAt: "t" },
      },
      { ...opMeta, type: "playlist.item.remove", payload: { playlistId: "p", mediaId: "m" } },
      { ...opMeta, type: "media.upsert", payload: { details: baseDetails() } },
      { ...opMeta, type: "media.delete", payload: { mediaId: "m" } },
      {
        ...opMeta,
        type: "media.progress",
        payload: { mediaId: "m", progressPct: 50, lastWatchedAt: "t", updatedAt: "t" },
      },
      { ...opMeta, type: "setting.set", payload: { key: "k", value: "v", updatedAt: "t" } },
      { ...opMeta, type: "ingest.job.upsert", payload: { job: baseJob } },
      { ...opMeta, type: "ingest.job.delete", payload: { jobId: "j" } },
      {
        ...opMeta,
        type: "ingest.job.event.add",
        payload: {
          event: {
            id: "e",
            jobId: "j",
            level: "info",
            message: "m",
            meta: null,
            createdAt: "t",
          } as IngestJobEvent,
        },
      },
      { ...opMeta, type: "ingest.job.history.clear", payload: { mediaId: "m" } },
    ];
    let currentOp: LibraryOp | undefined;
    let currentGroup: string | undefined;
    let currentStmt: { sql: string; params: ReadonlyArray<unknown> } | undefined;
    try {
      for (const op of allOps) {
        currentOp = op;
        const out = buildOpStatements(op, fixedIds());
        for (const [group, stmts] of Object.entries(out)) {
          currentGroup = group;
          for (const stmt of stmts!) {
            currentStmt = stmt;
            expect(Array.isArray(stmt.params)).toBe(true);
            expect(typeof stmt.sql).toBe("string");
            expect(stmt.sql.length).toBeGreaterThan(0);
            // Placeholder count matches param count
            const placeholders = (stmt.sql.match(/\?/g) ?? []).length;
            expect(placeholders).toBe(stmt.params.length);
          }
        }
      }
    } catch (err) {
      const placeholders = currentStmt ? (currentStmt.sql.match(/\?/g) ?? []).length : 0;
      dumpEdgeCaseSnapshot("invariant-violated", {
        op: currentOp,
        opType: currentOp?.type,
        errorOrWarningTrail: [
          `failing op.type=${currentOp?.type}`,
          `failing group=${currentGroup}`,
          `failing sql=${currentStmt?.sql}`,
          `failing params=${JSON.stringify(currentStmt?.params)}`,
        ],
        placeholderCount: placeholders,
        paramsCount: currentStmt?.params.length,
      });
      throw err;
    }
  });

  test("returned map never includes groups with empty arrays", () => {
    console.info(`[${SUITE}:invariants:no-empty-groups] media.progress should only emit core`);
    // The finalize() helper should drop any group whose list is empty rather
    // than emit `{ core: [] }`. Callers iterate `Object.entries(out)` directly.
    const op: LibraryOp = {
      ...opMeta,
      type: "media.progress",
      payload: { mediaId: "m", progressPct: 50, lastWatchedAt: "t", updatedAt: "t" },
    };
    const out = buildOpStatements(op, fixedIds());
    const summary = Object.entries(out).map(([g, list]) => [g, list?.length ?? 0]);
    console.info(`[${SUITE}:invariants:no-empty-groups:exec] groups+counts=${JSON.stringify(summary)}`);

    try {
      for (const [, list] of Object.entries(out)) {
        expect(list!.length).toBeGreaterThan(0);
      }
    } catch (err) {
      dumpEdgeCaseSnapshot("empty-group-leaked", {
        op,
        opType: op.type,
        parsedOutput: out,
        errorOrWarningTrail: [`groups+counts=${JSON.stringify(summary)}`],
      });
      throw err;
    }
  });
});
