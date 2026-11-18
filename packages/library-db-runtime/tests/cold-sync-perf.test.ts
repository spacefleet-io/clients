/**
 * @test-id LIB-COLD-SYNC-PERF-001
 * @level integration (real-engine, bun:sqlite)
 *
 * Cold-sync is the dominant first-launch UX cost on both clients: the
 * server pushes a snapshot of every `media.upsert` op, and the client
 * pipes them through buildOpStatements + per-group transactions before
 * the library list can render. Phase 4 perf (mobile library-perf.test.ts)
 * measured the playback-batch hot path with hand-rolled SQL; what was
 * missing was a real-engine perf gate on the SHARED builder at the
 * full library scale the architecture is now serving.
 *
 * This test synthesizes 1000 media.upsert ops (representative payload:
 * cast, episodes, files, formats with chunks, audio tracks, subtitles,
 * chapters, skip markers), pipes them through buildOpStatements, and
 * executes the per-group {sql, params} batches in real bun:sqlite
 * transactions — one transaction per group, mirroring how desktop and
 * mobile both flush.
 *
 * The budget mirrors mobile's playback hot path (2200ms for the most
 * expensive group on 500 items × 3 formats × 20 chunks). At 1000 items
 * with one format + smaller chunks we expect well under the per-group
 * budget; failure indicates the shared builder grew an O(n²) loop, or
 * statement preparation inside the hot path was reintroduced.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import {
  ALL_LIBRARY_DB_GROUPS,
  getGroupDdlStatements,
  type LibraryDbGroup,
} from "@space/library-db-definition";
import { buildOpStatements, type IdGenerator } from "@space/library-db-definition/ops";
import type { LibraryOp } from "@space/shared/libraryOps";
import type { MediaDetails } from "@space/shared";

const uuid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();

const seededIds = (): IdGenerator => {
  let n = 0;
  return () => `gen-${String(++n).padStart(7, "0")}`;
};

type SqlBinding = string | number | bigint | boolean | null | Uint8Array;

const isSqlBinding = (value: unknown): value is SqlBinding =>
  value === null ||
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "bigint" ||
  typeof value === "boolean" ||
  value instanceof Uint8Array;

const toBindings = (params: ReadonlyArray<unknown>): SqlBinding[] =>
  params.map((param) => {
    if (!isSqlBinding(param)) throw new Error(`unsupported sqlite binding: ${typeof param}`);
    return param;
  });

const openGroupDb = (group: LibraryDbGroup): Database => {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode=WAL;");
  // Mirror the real runtime's policy: foreign_keys=ON only on core, OFF on
  // all the others. App-layer cascade is what we're stress-testing.
  db.exec(group === "core" ? "PRAGMA foreign_keys=ON;" : "PRAGMA foreign_keys=OFF;");
  for (const stmt of getGroupDdlStatements(group)) db.exec(stmt);
  return db;
};

const generateMediaDetails = (index: number): MediaDetails => {
  const id = `m-${String(index).padStart(5, "0")}`;
  const type = index % 3 === 0 ? "tv" : "movie";
  const seasonCount = type === "tv" ? 1 + (index % 3) : 0;
  const episodeCount = type === "tv" ? 8 + (index % 15) : 0;
  return {
    id,
    type,
    tmdbId: 10_000 + index,
    externalIds: { imdb: `tt${100_000 + index}` },
    title: `Title ${index}`,
    originalTitle: `Original ${index}`,
    originalLanguage: "en",
    overview: `Overview for ${index}`,
    year: String(2000 + (index % 26)),
    rating: 5 + (index % 5),
    posterPath: `/poster/${id}.jpg`,
    backdropPath: `/backdrop/${id}.jpg`,
    genres: [28, 18, (index % 7) + 10],
    addedAt: nowIso(),
    updatedAt: nowIso(),
    hasFiles: index % 2 === 0,
    progressPct: (index * 7) % 100,
    lastWatchedAt: index % 3 === 0 ? nowIso() : null,
    totalEpisodes: episodeCount || null,
    episodeCount,
    cast: Array.from({ length: 5 }, (_, i) => ({
      id: `${id}-role-${i}`,
      personId: `${id}-person-${i}`,
      tmdbId: 50_000 + index * 100 + i,
      name: `Actor ${i} of ${index}`,
      role: i === 0 ? "Lead" : "Supporting",
      profilePath: `/p/${i}.jpg`,
    })),
    playlistIds: [],
    seasons: Array.from({ length: seasonCount }, (_, i) => ({
      id: `${id}-s${i}`,
      seasonNumber: i + 1,
      name: `Season ${i + 1}`,
      overview: null,
      posterPath: null,
      episodeCount: Math.ceil(episodeCount / Math.max(seasonCount, 1)),
      airDate: `${2020 + i}-01-15`,
    })),
    episodes: Array.from({ length: episodeCount }, (_, i) => ({
      id: `${id}-e${i}`,
      seasonNumber: (i % Math.max(seasonCount, 1)) + 1,
      episodeNumber: i + 1,
      name: `Episode ${i + 1}`,
      overview: null,
      stillPath: null,
      airDate: `2020-${String((i % 12) + 1).padStart(2, "0")}-01`,
    })),
    trailers: [
      {
        provider: "youtube",
        key: `${id}-trailer-1`,
        name: "Trailer",
        language: "en",
      },
    ],
    files: [
      {
        id: `${id}-file-1`,
        filename: `${id}.mkv`,
        season: null,
        episode: null,
        desiredFormats: [{ quality: "1080p", codec: "h264", bitrateKbps: 5000 }],
      },
    ] as MediaDetails["files"],
    formats: [
      {
        id: `${id}-fmt-1`,
        mediaId: id,
        fileId: `${id}-file-1`,
        quality: "1080p",
        codec: "h264",
        codecString: "avc1.640028",
        bitrateKbps: 5000,
        sizeMb: 1500,
        initKey: null,
        initSize: null,
        durationSeconds: 7200,
        totalSize: 1_500_000_000,
        chunks: Array.from({ length: 6 }, (_, j) => ({
          key: `${id}-c-${j}`,
          sizeBytes: 4_000_000,
          startSeconds: j * 6,
        })),
        isSource: true,
      },
    ] as MediaDetails["formats"],
    audioTracks: [
      {
        id: `${id}-audio-1`,
        mediaId: id,
        fileId: `${id}-file-1`,
        episodeId: null,
        language: "en",
        label: "English",
        isDefault: true,
        source: "embedded",
        codec: "aac",
        codecString: null,
        initKey: null,
        initSize: null,
        durationSeconds: 7200,
        totalSize: 200_000_000,
        chunks: Array.from({ length: 3 }, (_, j) => ({
          key: `${id}-ac-${j}`,
          sizeBytes: 1_000_000,
          startSeconds: j * 6,
        })),
      },
    ] as MediaDetails["audioTracks"],
    subtitleTracks: [],
    subtitles: [
      {
        id: `${id}-sub-1`,
        mediaId: id,
        fileId: `${id}-file-1`,
        episodeId: null,
        language: "en",
        label: "English",
        objectKey: `${id}-sub-obj`,
        format: "vtt",
        isDefault: true,
        source: "embedded",
        createdAt: nowIso(),
      },
    ] as MediaDetails["subtitles"],
    chapters: [
      {
        id: `${id}-chap-1`,
        formatId: `${id}-fmt-1`,
        title: "Chapter 1",
        startSeconds: 0,
      },
    ] as MediaDetails["chapters"],
    skipMarkers: [],
    hasLocalFiles: false,
  };
};

const generateUpsertOps = (count: number): ReadonlyArray<LibraryOp> => {
  const ops: LibraryOp[] = [];
  for (let i = 0; i < count; i++) {
    ops.push({
      id: `op-upsert-${i}`,
      type: "media.upsert",
      createdAt: nowIso(),
      payload: { details: generateMediaDetails(i) },
    });
  }
  return ops;
};

type GroupDbs = Readonly<Record<LibraryDbGroup, Database>>;

const openAllDbs = (): GroupDbs => {
  const out: Partial<Record<LibraryDbGroup, Database>> = {};
  for (const group of ALL_LIBRARY_DB_GROUPS) out[group] = openGroupDb(group);
  return out as GroupDbs;
};

const closeAllDbs = (dbs: GroupDbs) => {
  for (const db of Object.values(dbs)) db.close();
};

/**
 * Apply ops the way the runtime actually does: build statements once,
 * then run a single per-group transaction containing every statement
 * for that group across all ops.
 */
const applyOpsRuntimeStyle = (
  ops: ReadonlyArray<LibraryOp>,
  dbs: GroupDbs,
  label = "default",
): { totalMs: number; perGroupMs: Partial<Record<LibraryDbGroup, number>>; perGroupStmtCount: Partial<Record<LibraryDbGroup, number>>; } => {
  const idGen = seededIds();
  const buildStart = performance.now();
  const built = ops.map((op) => buildOpStatements(op, idGen));
  const buildMs = performance.now() - buildStart;
  console.info(
    `[cold-sync-perf:${label}:build] ops=${ops.length} buildOpStatements elapsed=${buildMs.toFixed(1)}ms`,
  );
  const perGroupMs: Partial<Record<LibraryDbGroup, number>> = {};
  const perGroupStmtCount: Partial<Record<LibraryDbGroup, number>> = {};
  const totalStart = performance.now();
  for (const group of ALL_LIBRARY_DB_GROUPS) {
    const db = dbs[group];
    let count = 0;
    const txStart = performance.now();
    const tx = db.transaction(() => {
      for (const stmts of built) {
        const list = stmts[group];
        if (!list) continue;
        for (const stmt of list) {
          db.prepare(stmt.sql).run(...toBindings(stmt.params));
          count++;
        }
      }
    });
    tx();
    const elapsed = performance.now() - txStart;
    perGroupMs[group] = elapsed;
    perGroupStmtCount[group] = count;
    console.info(
      `[cold-sync-perf:${label}:tx] group=${group} stmts=${count} elapsed=${elapsed.toFixed(1)}ms throughput=${count > 0 ? (count / (elapsed / 1000)).toFixed(0) : "n/a"}/s`,
    );
  }
  const totalMs = performance.now() - totalStart;
  return { totalMs, perGroupMs, perGroupStmtCount };
};

// Suite-id: cold-sync-perf
// The whole point is "did the perf budget hold". Dump per-phase timings,
// per-group statement counts, throughput, and row counts on failure — so the
// next reader can tell whether it's an O(n²) blow-up, prepare-in-hot-path,
// or just a normal CI hiccup.
const dumpPerfSnapshot = (
  label: string,
  ctx: {
    totalMs?: number;
    budgetMs?: number;
    perGroupMs?: Partial<Record<LibraryDbGroup, number>>;
    perGroupStmtCount?: Partial<Record<LibraryDbGroup, number>>;
    rowCountsByGroup?: Partial<Record<LibraryDbGroup, Record<string, number>>>;
    capturedError?: unknown;
    extraNotes?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [cold-sync-perf:${label}] snapshot ===`);
    if (ctx.totalMs !== undefined) {
      const ratio = ctx.budgetMs ? (ctx.totalMs / ctx.budgetMs).toFixed(2) : "n/a";
      console.error(
        `totalMs=${ctx.totalMs.toFixed(1)} budgetMs=${ctx.budgetMs ?? "n/a"} ratio=${ratio} (>1.0 means exceeded)`,
      );
    }
    if (ctx.perGroupMs) {
      for (const [group, ms] of Object.entries(ctx.perGroupMs)) {
        const stmts = ctx.perGroupStmtCount?.[group as LibraryDbGroup] ?? 0;
        console.error(
          `  group=${group} elapsed=${(ms as number).toFixed(1)}ms stmts=${stmts}`,
        );
      }
    }
    if (ctx.rowCountsByGroup) {
      for (const [group, tables] of Object.entries(ctx.rowCountsByGroup)) {
        console.error(`  group=${group} row-counts=${JSON.stringify(tables)}`);
      }
    }
    if (ctx.extraNotes) {
      console.error(`extraNotes=${JSON.stringify(ctx.extraNotes, null, 2)}`);
    }
    if (ctx.capturedError !== undefined) {
      const e = ctx.capturedError;
      console.error(`captured error=${e instanceof Error ? e.message : String(e)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("cold-sync — 1000 media.upsert ops via buildOpStatements", () => {
  it("applies 1000 representative-payload upserts in under 6 seconds end-to-end", () => {
    const dbs = openAllDbs();
    try {
      console.info(`[cold-sync-perf:e2e-1000] generating 1000 ops`);
      const ops = generateUpsertOps(1000);
      const start = performance.now();
      const stats = applyOpsRuntimeStyle(ops, dbs, "e2e-1000");
      const elapsed = performance.now() - start;
      console.info(
        `[cold-sync-perf:e2e-1000] total elapsed=${elapsed.toFixed(1)}ms budget=6000ms`,
      );
      // 1000 media × (4 core stmts + ~12 metadata stmts + ~14 playback stmts + 1 template stmt)
      // ≈ 31 000 prepared-statement executions across 5 transactions. Real
      // cold-sync today completes in ~1-2 s; the 6 s budget is a generous
      // ceiling that still catches an O(n²) regression or accidental
      // statement-preparation in the hot path.
      try {
        expect(elapsed).toBeLessThan(6000);
      } catch (err) {
        dumpPerfSnapshot("e2e-1000-budget-exceeded", {
          totalMs: elapsed,
          budgetMs: 6000,
          perGroupMs: stats.perGroupMs,
          perGroupStmtCount: stats.perGroupStmtCount,
          capturedError: err,
        });
        throw err;
      }
    } finally {
      closeAllDbs(dbs);
    }
    // The test's own 6 s budget is the assertion: the runner's 5 s default must not cut it off first (run 34650: 4977 ms).
  }, 30_000);

  it("row counts after cold sync match the synthetic input", () => {
    const dbs = openAllDbs();
    try {
      console.info(`[cold-sync-perf:row-count-1000] generating ops + applying`);
      const ops = generateUpsertOps(1000);
      const stats = applyOpsRuntimeStyle(ops, dbs, "row-count-1000");
      const mediaCount = (
        dbs.core.prepare("SELECT COUNT(*) AS cnt FROM media_items;").get() as { cnt: number }
      ).cnt;
      const fileCount = (
        dbs.metadata.prepare("SELECT COUNT(*) AS cnt FROM media_files;").get() as { cnt: number }
      ).cnt;
      const formatCount = (
        dbs.playback
          .prepare("SELECT COUNT(*) AS cnt FROM media_formats;")
          .get() as { cnt: number }
      ).cnt;
      const formatChunkCount = (
        dbs.playback
          .prepare("SELECT COUNT(*) AS cnt FROM media_format_chunks;")
          .get() as { cnt: number }
      ).cnt;
      const audioCount = (
        dbs.playback
          .prepare("SELECT COUNT(*) AS cnt FROM media_audio_tracks;")
          .get() as { cnt: number }
      ).cnt;
      console.info(
        `[cold-sync-perf:row-count-1000] media=${mediaCount} files=${fileCount} formats=${formatCount} ` +
          `formatChunks=${formatChunkCount} audio=${audioCount}`,
      );
      try {
        expect(mediaCount).toBe(1000);
        expect(fileCount).toBe(1000);
        expect(formatCount).toBe(1000);
        // 6 chunks per format × 1000 = 6000
        expect(formatChunkCount).toBe(6000);
        expect(audioCount).toBe(1000);
      } catch (err) {
        dumpPerfSnapshot("row-count-1000-mismatch", {
          totalMs: stats.totalMs,
          perGroupMs: stats.perGroupMs,
          perGroupStmtCount: stats.perGroupStmtCount,
          rowCountsByGroup: {
            core: { media_items: mediaCount },
            metadata: { media_files: fileCount },
            playback: {
              media_formats: formatCount,
              media_format_chunks: formatChunkCount,
              media_audio_tracks: audioCount,
            },
          },
          capturedError: err,
        });
        throw err;
      }
    } finally {
      closeAllDbs(dbs);
    }
  }, 30_000);

  it("playback transaction alone (the hot path) finishes under 2 seconds", () => {
    // Isolated playback-group budget — mirrors the mobile library-perf.test.ts
    // "playback batch application" gate, but on the SHARED builder rather
    // than hand-rolled SQL.
    const dbs = openAllDbs();
    try {
      const ops = generateUpsertOps(1000);
      const idGen = seededIds();
      const built = ops.map((op) => buildOpStatements(op, idGen));
      console.info(
        `[cold-sync-perf:playback-hotpath] starting isolated playback transaction (1000 ops)`,
      );
      const start = performance.now();
      let stmtCount = 0;
      const tx = dbs.playback.transaction(() => {
        for (const stmts of built) {
          const list = stmts.playback;
          if (!list) continue;
          for (const stmt of list) {
            dbs.playback.prepare(stmt.sql).run(...toBindings(stmt.params));
            stmtCount++;
          }
        }
      });
      tx();
      const elapsed = performance.now() - start;
      console.info(
        `[cold-sync-perf:playback-hotpath] elapsed=${elapsed.toFixed(1)}ms stmts=${stmtCount} budget=2000ms`,
      );
      try {
        expect(elapsed).toBeLessThan(2000);
      } catch (err) {
        dumpPerfSnapshot("playback-hotpath-budget-exceeded", {
          totalMs: elapsed,
          budgetMs: 2000,
          perGroupMs: { playback: elapsed },
          perGroupStmtCount: { playback: stmtCount },
          capturedError: err,
        });
        throw err;
      }
    } finally {
      closeAllDbs(dbs);
    }
  });

  it("re-applying the same 1000 ops is idempotent (INSERT OR REPLACE / OR IGNORE semantics)", () => {
    // Cold-sync after a refresh re-pushes the same payload. INSERT OR REPLACE
    // for primary tables and INSERT OR IGNORE for join tables means row counts
    // must NOT double. If a builder change accidentally swapped OR REPLACE
    // for INSERT, this test would catch the unique-constraint failure.
    const dbs = openAllDbs();
    try {
      console.info(`[cold-sync-perf:idempotent] generating 200 ops, applying twice`);
      const ops = generateUpsertOps(200);
      const stats1 = applyOpsRuntimeStyle(ops, dbs, "idempotent-pass1");
      const stats2 = applyOpsRuntimeStyle(ops, dbs, "idempotent-pass2");
      const mediaCount = (
        dbs.core.prepare("SELECT COUNT(*) AS cnt FROM media_items;").get() as { cnt: number }
      ).cnt;
      const genreCount = (
        dbs.core
          .prepare("SELECT COUNT(*) AS cnt FROM media_genres;")
          .get() as { cnt: number }
      ).cnt;
      const fileCount = (
        dbs.metadata.prepare("SELECT COUNT(*) AS cnt FROM media_files;").get() as { cnt: number }
      ).cnt;
      console.info(
        `[cold-sync-perf:idempotent] after-two-passes media=${mediaCount} genres=${genreCount} files=${fileCount} ` +
          `pass1.totalMs=${stats1.totalMs.toFixed(1)} pass2.totalMs=${stats2.totalMs.toFixed(1)}`,
      );
      try {
        expect(mediaCount).toBe(200);
        // 3 genres per item × 200 = 600, NOT 1200
        expect(genreCount).toBe(600);
        expect(fileCount).toBe(200);
      } catch (err) {
        dumpPerfSnapshot("idempotent-failure", {
          totalMs: stats2.totalMs,
          perGroupMs: stats2.perGroupMs,
          perGroupStmtCount: stats2.perGroupStmtCount,
          rowCountsByGroup: {
            core: { media_items: mediaCount, media_genres: genreCount },
            metadata: { media_files: fileCount },
          },
          capturedError: err,
          extraNotes: {
            warning:
              "If genreCount=1200 (=600*2), INSERT-OR-IGNORE may have been swapped for plain INSERT in the builder",
          },
        });
        throw err;
      }
    } finally {
      closeAllDbs(dbs);
    }
  });
});
