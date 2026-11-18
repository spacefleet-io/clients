import { describe, expect, test } from "vitest";
import type {
  IngestJob,
  IngestJobEvent,
  MediaDetails,
} from "@space/shared";
import type { LibraryOp } from "@space/shared/libraryOps";
import {
  buildOpStatements,
  buildMediaCoreStatements,
  buildMediaMetadataStatements,
  buildMediaPlaybackStatements,
  buildMediaDeleteStatements,
  UnknownOpTypeError,
  type IdGenerator,
} from "../src/ops";

const SUITE = "ops";

type StatementShape = { sql: string; params: ReadonlyArray<unknown> };

const dumpOpsSnapshot = (
  label: string,
  ctx: {
    op?: LibraryOp;
    opType?: string;
    groupsObserved?: ReadonlyArray<string>;
    expectedGroups?: ReadonlyArray<string>;
    perGroupCounts?: Record<string, number>;
    perGroupStatements?: Record<string, ReadonlyArray<StatementShape>>;
    expectedParam?: { position: number | string; expected: unknown; actual: unknown };
    roundTripDiff?: { input?: unknown; output?: unknown };
    sqlSnippet?: string;
    paramsSnapshot?: ReadonlyArray<unknown>;
  },
) => {
  try {
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    if (ctx.opType) console.error(`op.type: ${ctx.opType}`);
    if (ctx.op) console.error(`op payload:\n${JSON.stringify(ctx.op, null, 2)}`);
    if (ctx.groupsObserved) console.error(`groups observed: ${JSON.stringify(ctx.groupsObserved)}`);
    if (ctx.expectedGroups) console.error(`groups expected: ${JSON.stringify(ctx.expectedGroups)}`);
    if (ctx.perGroupCounts) console.error(`per-group counts:\n${JSON.stringify(ctx.perGroupCounts, null, 2)}`);
    if (ctx.perGroupStatements) {
      console.error(`per-group statements:\n${JSON.stringify(ctx.perGroupStatements, null, 2)}`);
    }
    if (ctx.expectedParam) {
      console.error(`expected param at ${ctx.expectedParam.position}: expected=${JSON.stringify(ctx.expectedParam.expected)} actual=${JSON.stringify(ctx.expectedParam.actual)}`);
    }
    if (ctx.sqlSnippet) {
      console.error(`sql snippet:\n${ctx.sqlSnippet}`);
    }
    if (ctx.paramsSnapshot) {
      console.error(`params snapshot: ${JSON.stringify(ctx.paramsSnapshot)}`);
    }
    if (ctx.roundTripDiff) {
      console.error(`round-trip diff:\n${JSON.stringify(ctx.roundTripDiff, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

const summarizeOut = (
  out: Record<string, ReadonlyArray<StatementShape> | undefined>,
): { groups: string[]; counts: Record<string, number>; statements: Record<string, StatementShape[]> } => {
  const groups = Object.keys(out);
  const counts: Record<string, number> = {};
  const statements: Record<string, StatementShape[]> = {};
  for (const g of groups) {
    const list = out[g] ?? [];
    counts[g] = list.length;
    statements[g] = list.map((s) => ({ sql: s.sql, params: s.params }));
  }
  return { groups, counts, statements };
};

const fixedIds = (prefix = "id"): IdGenerator => {
  let n = 0;
  return () => `${prefix}-${++n}`;
};

const baseDetails = (overrides: Partial<MediaDetails> = {}): MediaDetails => ({
  id: "media-1",
  type: "movie",
  catalogId: 42,
  title: "Test",
  originalTitle: "Test OT",
  originalLanguage: "en",
  overview: "ov",
  year: "2020",
  rating: 8.5,
  posterPath: "/p.png",
  backdropPath: "/b.png",
  genres: [28, 18],
  addedAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-02T00:00:00.000Z",
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

const job: IngestJob = {
  id: "job-1",
  mediaId: "media-1",
  fileId: "file-1",
  workerPeerId: "peer-1",
  ownerClientId: "client-1",
  kind: "transcode",
  status: "processing",
  progressPct: 42,
  errorCode: null,
  errorMessage: null,
  meta: { foo: "bar" },
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T01:00:00.000Z",
  completedAt: null,
};

const jobEvent: IngestJobEvent = {
  id: "evt-1",
  jobId: "job-1",
  level: "info",
  message: "started",
  meta: null,
  createdAt: "2024-01-01T00:00:00.000Z",
};

const opMeta = { id: "op-1", createdAt: "2024-01-01T00:00:00.000Z" };

describe("buildOpStatements — playlist ops", () => {
  test("playlist.create writes to core only", () => {
    console.info(`[${SUITE}:setup] op.type=playlist.create id=pl-1`);
    const op: LibraryOp = {
      ...opMeta,
      type: "playlist.create",
      payload: {
        id: "pl-1",
        name: "Favs",
        slug: "favs",
        isSystem: false,
        createdAt: "2024-01-01T00:00:00.000Z",
      },
    };
    const out = buildOpStatements(op, fixedIds());
    const summary = summarizeOut(out);
    console.info(`[${SUITE}:exec] groups=${JSON.stringify(summary.groups)} counts=${JSON.stringify(summary.counts)}`);

    try {
      expect(Object.keys(out)).toEqual(["core"]);
      expect(out.core).toHaveLength(1);
      expect(out.core![0]!.sql).toContain("INSERT OR REPLACE INTO playlists");
      expect(out.core![0]!.params).toEqual([
        "pl-1",
        "Favs",
        "favs",
        0,
        "2024-01-01T00:00:00.000Z",
      ]);
    } catch (err) {
      dumpOpsSnapshot("playlist-create-mismatch", {
        op,
        opType: op.type,
        groupsObserved: summary.groups,
        expectedGroups: ["core"],
        perGroupCounts: summary.counts,
        perGroupStatements: summary.statements,
      });
      throw err;
    }
  });

  test("playlist.delete excludes system playlists in the WHERE", () => {
    console.info(`[${SUITE}:setup] op.type=playlist.delete id=pl-1`);
    const op: LibraryOp = {
      ...opMeta,
      type: "playlist.delete",
      payload: { id: "pl-1" },
    };
    const out = buildOpStatements(op, fixedIds());
    const summary = summarizeOut(out);

    try {
      expect(out.core![0]!.sql).toContain("is_system = 0");
      expect(out.core![0]!.params).toEqual(["pl-1"]);
    } catch (err) {
      dumpOpsSnapshot("playlist-delete-shape-wrong", {
        op,
        opType: op.type,
        perGroupStatements: summary.statements,
        sqlSnippet: out.core?.[0]?.sql,
        paramsSnapshot: out.core?.[0]?.params,
      });
      throw err;
    }
  });

  test("playlist.item.add + remove route to core", () => {
    const add: LibraryOp = {
      ...opMeta,
      type: "playlist.item.add",
      payload: {
        id: "pli-1",
        playlistId: "pl-1",
        mediaId: "m-1",
        addedAt: "2024-01-01T00:00:00.000Z",
      },
    };
    const rm: LibraryOp = {
      ...opMeta,
      type: "playlist.item.remove",
      payload: { playlistId: "pl-1", mediaId: "m-1" },
    };
    const outAdd = buildOpStatements(add, fixedIds());
    const outRm = buildOpStatements(rm, fixedIds());
    console.info(`[${SUITE}:exec] add-groups=${JSON.stringify(Object.keys(outAdd))} rm-groups=${JSON.stringify(Object.keys(outRm))}`);

    try {
      expect(outAdd.core![0]!.sql).toContain("INSERT OR IGNORE INTO playlist_items");
      expect(outRm.core![0]!.sql).toContain("DELETE FROM playlist_items");
    } catch (err) {
      dumpOpsSnapshot("playlist-item-routing-wrong", {
        opType: "playlist.item.add+remove",
        perGroupStatements: {
          add_core: outAdd.core?.map((s) => ({ sql: s.sql, params: s.params })) ?? [],
          rm_core: outRm.core?.map((s) => ({ sql: s.sql, params: s.params })) ?? [],
        },
      });
      throw err;
    }
  });
});

describe("buildOpStatements — media.upsert", () => {
  test("fans out across core, metadata, playback", () => {
    console.info(`[${SUITE}:setup] op.type=media.upsert with baseDetails (default fields)`);
    const op: LibraryOp = {
      ...opMeta,
      type: "media.upsert",
      payload: { details: baseDetails() },
    };
    const out = buildOpStatements(op, fixedIds());
    const summary = summarizeOut(out);
    console.info(`[${SUITE}:exec] media.upsert groups=${JSON.stringify(summary.groups.sort())} counts=${JSON.stringify(summary.counts)}`);

    try {
      expect(Object.keys(out).sort()).toEqual(["core", "metadata", "playback", "templates"]);
      expect(out.core!.some((s) => s.sql.includes("media_items"))).toBe(true);
      expect(out.metadata!.some((s) => s.sql.includes("DELETE FROM media_files"))).toBe(true);
      expect(out.playback!.some((s) => s.sql.includes("DELETE FROM media_formats"))).toBe(true);
      expect(out.templates![0]!.sql).toContain("DELETE FROM media_skip_analysis");
    } catch (err) {
      dumpOpsSnapshot("media-upsert-fanout-wrong", {
        op,
        opType: op.type,
        groupsObserved: summary.groups,
        expectedGroups: ["core", "metadata", "playback", "templates"],
        perGroupCounts: summary.counts,
        perGroupStatements: summary.statements,
      });
      throw err;
    }
  });

  test("uses idGen for the catalog id row", () => {
    console.info(`[${SUITE}:setup] op.type=media.upsert catalogId=7`);
    const op: LibraryOp = {
      ...opMeta,
      type: "media.upsert",
      payload: {
        details: baseDetails({
          catalogId: 7,
          genres: [],
        }),
      },
    };
    const out = buildOpStatements(op, fixedIds("uuid"));
    const externalIdInsert = out.core!.find((s) =>
      s.sql.includes("INSERT OR IGNORE INTO media_external_ids")
    );
    console.info(`[${SUITE}:exec] externalIdInsert defined=${externalIdInsert !== undefined} params=${JSON.stringify(externalIdInsert?.params)}`);

    try {
      expect(externalIdInsert).toBeDefined();
      expect(externalIdInsert!.params[0]).toBe("uuid-1");
      expect(externalIdInsert!.params[3]).toBe("catalog");
    } catch (err) {
      dumpOpsSnapshot("media-upsert-extid-idGen-wrong", {
        op,
        opType: op.type,
        perGroupStatements: summarizeOut(out).statements,
        paramsSnapshot: externalIdInsert?.params,
      });
      throw err;
    }
  });

  test("preserves order_index for cast", () => {
    console.info(`[${SUITE}:setup] op.type=media.upsert with 2 cast roles (role-a, role-b)`);
    const op: LibraryOp = {
      ...opMeta,
      type: "media.upsert",
      payload: {
        details: baseDetails({
          cast: [
            {
              id: "role-a",
              personId: "p-a",
              catalogId: null,
              name: "A",
              role: "lead",
              profilePath: null,
            },
            {
              id: "role-b",
              personId: "p-b",
              catalogId: null,
              name: "B",
              role: "supporting",
              profilePath: null,
            },
          ],
        }),
      },
    };
    const out = buildOpStatements(op, fixedIds());
    const roleInserts = out.metadata!.filter((s) =>
      s.sql.includes("INSERT OR REPLACE INTO media_roles")
    );
    const orderIndices = roleInserts.map((s) => s.params[4]);
    console.info(`[${SUITE}:exec] roleInserts.length=${roleInserts.length} order_index values=${JSON.stringify(orderIndices)}`);

    try {
      expect(roleInserts).toHaveLength(2);
      expect(roleInserts[0]!.params[4]).toBe(0);
      expect(roleInserts[1]!.params[4]).toBe(1);
    } catch (err) {
      dumpOpsSnapshot("cast-order-index-wrong", {
        opType: op.type,
        perGroupStatements: { roleInserts: roleInserts.map((s) => ({ sql: s.sql, params: s.params })) },
        paramsSnapshot: orderIndices,
      });
      throw err;
    }
  });

  test("playback chunks carry their order_index", () => {
    console.info(`[${SUITE}:setup] op.type=media.upsert with 1 format containing 2 chunks (c1, c2)`);
    const op: LibraryOp = {
      ...opMeta,
      type: "media.upsert",
      payload: {
        details: baseDetails({
          formats: [
            {
              id: "fmt-1",
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
              chunks: [
                { key: "c1", sizeBytes: 100, startSeconds: 0 },
                { key: "c2", sizeBytes: 200, startSeconds: 60 },
              ],
              isSource: true,
            },
          ],
        }),
      },
    };
    const out = buildOpStatements(op, fixedIds());
    const chunkInserts = out.playback!.filter((s) =>
      s.sql.includes("INSERT OR REPLACE INTO media_format_chunks")
    );
    console.info(`[${SUITE}:exec] chunkInserts.length=${chunkInserts.length} order_index values=${JSON.stringify(chunkInserts.map((s) => s.params[3]))}`);

    try {
      expect(chunkInserts).toHaveLength(2);
      expect(chunkInserts[0]!.params[3]).toBe(0);
      expect(chunkInserts[1]!.params[3]).toBe(1);
    } catch (err) {
      dumpOpsSnapshot("chunk-order-index-wrong", {
        opType: op.type,
        perGroupStatements: { chunkInserts: chunkInserts.map((s) => ({ sql: s.sql, params: s.params })) },
      });
      throw err;
    }
  });
});

describe("buildOpStatements — media.delete", () => {
  test("cascades across core, metadata, playback, ingest, templates", () => {
    console.info(`[${SUITE}:setup] op.type=media.delete mediaId=m-x`);
    const op: LibraryOp = {
      ...opMeta,
      type: "media.delete",
      payload: { mediaId: "m-x" },
    };
    const out = buildOpStatements(op, fixedIds());
    const summary = summarizeOut(out);
    console.info(`[${SUITE}:exec] media.delete groups=${JSON.stringify(summary.groups.sort())} counts=${JSON.stringify(summary.counts)}`);

    try {
      expect(Object.keys(out).sort()).toEqual([
        "core",
        "ingest",
        "metadata",
        "playback",
        "templates",
      ]);
      expect(out.core!.some((s) => s.sql.includes("DELETE FROM media_items"))).toBe(true);
      expect(out.ingest!.some((s) => s.sql.includes("DELETE FROM ingest_jobs"))).toBe(true);
      expect(out.templates![0]!.sql).toContain("media_skip_analysis");
    } catch (err) {
      dumpOpsSnapshot("media-delete-cascade-wrong", {
        op,
        opType: op.type,
        groupsObserved: summary.groups,
        expectedGroups: ["core", "ingest", "metadata", "playback", "templates"],
        perGroupCounts: summary.counts,
        perGroupStatements: summary.statements,
      });
      throw err;
    }
  });

  test("uses correlated subqueries for format/audio chunk cascades", () => {
    console.info(`[${SUITE}:setup] direct buildMediaDeleteStatements("m-y")`);
    const out = buildMediaDeleteStatements("m-y");
    const sqls = out.playback!.map((s) => s.sql);
    console.info(`[${SUITE}:exec] playback delete sqls count=${sqls.length}`);

    try {
      expect(
        sqls.some(
          (sql) =>
            sql.includes("media_format_chunks") &&
            sql.includes("SELECT id FROM media_formats WHERE media_id = ?")
        )
      ).toBe(true);
      expect(
        sqls.some(
          (sql) =>
            sql.includes("media_audio_chunks") &&
            sql.includes("SELECT id FROM media_audio_tracks WHERE media_id = ?")
        )
      ).toBe(true);
    } catch (err) {
      dumpOpsSnapshot("correlated-subquery-cascade-missing", {
        opType: "media.delete",
        perGroupStatements: { playback: out.playback?.map((s) => ({ sql: s.sql, params: s.params })) ?? [] },
      });
      throw err;
    }
  });
});

describe("buildOpStatements — media.progress + setting.set", () => {
  test("media.progress updates only core", () => {
    console.info(`[${SUITE}:setup] op.type=media.progress mediaId=m-1 pct=75`);
    const op: LibraryOp = {
      ...opMeta,
      type: "media.progress",
      payload: {
        mediaId: "m-1",
        progressPct: 75,
        lastWatchedAt: "2024-02-01T00:00:00.000Z",
        updatedAt: "2024-02-01T00:00:00.000Z",
      },
    };
    const out = buildOpStatements(op, fixedIds());
    const summary = summarizeOut(out);
    console.info(`[${SUITE}:exec] groups=${JSON.stringify(summary.groups)} core-params=${JSON.stringify(out.core?.[0]?.params)}`);

    try {
      expect(Object.keys(out)).toEqual(["core"]);
      expect(out.core![0]!.sql).toContain("UPDATE media_items SET progress_pct");
      expect(out.core![0]!.params).toEqual([
        75,
        "2024-02-01T00:00:00.000Z",
        "m-1",
        "2024-02-01T00:00:00.000Z",
      ]);
    } catch (err) {
      dumpOpsSnapshot("media-progress-shape-wrong", {
        op,
        opType: op.type,
        perGroupStatements: summary.statements,
      });
      throw err;
    }
  });

  test("setting.set upserts into app_settings", () => {
    console.info(`[${SUITE}:setup] op.type=setting.set key=theme value=dark`);
    const op: LibraryOp = {
      ...opMeta,
      type: "setting.set",
      payload: { key: "theme", value: "dark", updatedAt: "2024-01-01" },
    };
    const out = buildOpStatements(op, fixedIds());

    try {
      expect(out.core![0]!.sql).toContain("INSERT INTO app_settings");
      expect(out.core![0]!.params).toEqual(["theme", "dark", "2024-01-01"]);
    } catch (err) {
      dumpOpsSnapshot("setting-set-shape-wrong", {
        op,
        opType: op.type,
        perGroupStatements: summarizeOut(out).statements,
      });
      throw err;
    }
  });
});

describe("buildOpStatements — ingest ops", () => {
  test("ingest.job.upsert writes to ingest with clamped progress + serialized meta", () => {
    console.info(`[${SUITE}:setup] op.type=ingest.job.upsert progressPct=150 (will clamp to 100)`);
    const op: LibraryOp = {
      ...opMeta,
      type: "ingest.job.upsert",
      payload: { job: { ...job, progressPct: 150 } },
    };
    const out = buildOpStatements(op, fixedIds());
    console.info(`[${SUITE}:exec] params[7]=${JSON.stringify(out.ingest?.[0]?.params[7])} params[10]=${JSON.stringify(out.ingest?.[0]?.params[10])}`);

    try {
      expect(Object.keys(out)).toEqual(["ingest"]);
      expect(out.ingest![0]!.sql).toContain("INSERT INTO ingest_jobs");
      expect(out.ingest![0]!.sql).toContain("ON CONFLICT(id) DO UPDATE");
      expect(out.ingest![0]!.params[7]).toBe(100); // clamped
      expect(out.ingest![0]!.params[10]).toBe(JSON.stringify({ foo: "bar" }));
    } catch (err) {
      dumpOpsSnapshot("ingest-upsert-shape-wrong", {
        op,
        opType: op.type,
        perGroupStatements: summarizeOut(out).statements,
        expectedParam: { position: "params[7]", expected: 100, actual: out.ingest?.[0]?.params[7] },
      });
      throw err;
    }
  });

  test("ingest.job.delete cascades events first", () => {
    console.info(`[${SUITE}:setup] op.type=ingest.job.delete jobId=job-x`);
    const op: LibraryOp = {
      ...opMeta,
      type: "ingest.job.delete",
      payload: { jobId: "job-x" },
    };
    const out = buildOpStatements(op, fixedIds());
    console.info(`[${SUITE}:exec] ingest stmt count=${out.ingest?.length} order=${JSON.stringify((out.ingest ?? []).map((s) => s.sql.slice(0, 30)))}`);

    try {
      expect(out.ingest).toHaveLength(2);
      expect(out.ingest![0]!.sql).toContain("DELETE FROM ingest_job_events");
      expect(out.ingest![1]!.sql).toContain("DELETE FROM ingest_jobs");
    } catch (err) {
      dumpOpsSnapshot("ingest-delete-cascade-wrong", {
        op,
        opType: op.type,
        perGroupStatements: summarizeOut(out).statements,
      });
      throw err;
    }
  });

  test("ingest.job.event.add writes to ingest with serialized meta", () => {
    console.info(`[${SUITE}:setup] op.type=ingest.job.event.add meta={extra:1}`);
    const op: LibraryOp = {
      ...opMeta,
      type: "ingest.job.event.add",
      payload: { event: { ...jobEvent, meta: { extra: 1 } } },
    };
    const out = buildOpStatements(op, fixedIds());

    try {
      expect(out.ingest![0]!.params[4]).toBe(JSON.stringify({ extra: 1 }));
    } catch (err) {
      dumpOpsSnapshot("ingest-event-meta-serialization-wrong", {
        op,
        opType: op.type,
        perGroupStatements: summarizeOut(out).statements,
        expectedParam: { position: "params[4]", expected: JSON.stringify({ extra: 1 }), actual: out.ingest?.[0]?.params[4] },
      });
      throw err;
    }
  });

  test("ingest.job.history.clear scopes to terminal statuses + media id", () => {
    console.info(`[${SUITE}:setup] op.type=ingest.job.history.clear mediaId=m-1`);
    const op: LibraryOp = {
      ...opMeta,
      type: "ingest.job.history.clear",
      payload: { mediaId: "m-1" },
    };
    const out = buildOpStatements(op, fixedIds());
    console.info(`[${SUITE}:exec] ingest stmt count=${out.ingest?.length}`);

    try {
      expect(out.ingest).toHaveLength(2);
      const [eventsDelete, jobsDelete] = out.ingest!;
      expect(eventsDelete!.sql).toContain("status IN (?, ?, ?)");
      expect(eventsDelete!.params).toEqual(["m-1", "completed", "failed", "cancelled"]);
      expect(jobsDelete!.params).toEqual(["m-1", "completed", "failed", "cancelled"]);
    } catch (err) {
      dumpOpsSnapshot("history-clear-scope-wrong", {
        op,
        opType: op.type,
        perGroupStatements: summarizeOut(out).statements,
      });
      throw err;
    }
  });
});

describe("per-op-class helpers (test/targeted use)", () => {
  test("buildMediaCoreStatements only emits core", () => {
    console.info(`[${SUITE}:setup] direct buildMediaCoreStatements call`);
    const out = buildMediaCoreStatements(baseDetails(), fixedIds());
    try {
      expect(Object.keys(out)).toEqual(["core"]);
    } catch (err) {
      dumpOpsSnapshot("core-only-helper-leaked", {
        opType: "buildMediaCoreStatements",
        groupsObserved: Object.keys(out),
        expectedGroups: ["core"],
        perGroupCounts: summarizeOut(out).counts,
      });
      throw err;
    }
  });

  test("buildMediaMetadataStatements only emits metadata", () => {
    const out = buildMediaMetadataStatements(baseDetails(), fixedIds());
    try {
      expect(Object.keys(out)).toEqual(["metadata"]);
    } catch (err) {
      dumpOpsSnapshot("metadata-only-helper-leaked", {
        opType: "buildMediaMetadataStatements",
        groupsObserved: Object.keys(out),
        expectedGroups: ["metadata"],
        perGroupCounts: summarizeOut(out).counts,
      });
      throw err;
    }
  });

  test("buildMediaPlaybackStatements only emits playback", () => {
    const out = buildMediaPlaybackStatements(baseDetails(), fixedIds());
    try {
      expect(Object.keys(out)).toEqual(["playback"]);
    } catch (err) {
      dumpOpsSnapshot("playback-only-helper-leaked", {
        opType: "buildMediaPlaybackStatements",
        groupsObserved: Object.keys(out),
        expectedGroups: ["playback"],
        perGroupCounts: summarizeOut(out).counts,
      });
      throw err;
    }
  });
});

describe("unknown op", () => {
  test("throws UnknownOpTypeError — unknown types past the version gate are a bug, not silently skipped", () => {
    // Previously this block asserted `expect(out).toEqual({})` — the old
    // silent-skip (default: break) behavior. Part B replaced that with
    // `throw new UnknownOpTypeError(op.type)`. An unknown type reaching
    // buildOpStatements after the Part D version gate has already run means
    // a new variant was added without a builder, or the op is corrupt — it
    // must fail loud so callers see a real error rather than silently losing
    // data.
    console.info(`[${SUITE}:setup] op.type='unknown.future' (must throw)`);
    const unknown = {
      id: "op-x",
      type: "unknown.future",
      createdAt: "2024-01-01",
      payload: {},
    } as unknown as LibraryOp;
    try {
      expect(() => buildOpStatements(unknown, fixedIds())).toThrow(UnknownOpTypeError);
    } catch (err) {
      console.error(`[${SUITE}:unknown-op-did-not-throw] op type='unknown.future' was silently consumed`);
      throw err;
    }
  });

  test("thrown UnknownOpTypeError carries the op type string in .opType", () => {
    console.info(`[${SUITE}:setup] op.type='unknown.future' (must include .opType field on error)`);
    const unknown = {
      id: "op-x",
      type: "unknown.future",
      createdAt: "2024-01-01",
      payload: {},
    } as unknown as LibraryOp;
    let caught: UnknownOpTypeError | undefined;
    try {
      buildOpStatements(unknown, fixedIds());
    } catch (e) {
      caught = e as UnknownOpTypeError;
    }
    console.info(`[${SUITE}:exec] caught instance=${caught instanceof UnknownOpTypeError} opType=${caught?.opType}`);

    try {
      expect(caught).toBeInstanceOf(UnknownOpTypeError);
      expect(caught!.opType).toBe("unknown.future");
    } catch (err) {
      console.error(`=== [${SUITE}:unknown-op-error-shape-wrong] snapshot ===`);
      console.error(`caught error: ${caught ? `${caught.name}: ${caught.message}` : "(no error)"}`);
      console.error(`caught.opType: ${caught?.opType}`);
      throw err;
    }
  });
});
