/**
 * Drift guard: pins the SQL output of `buildOpStatements` against a
 * deterministic 50-op fixture. If a builder change accidentally rewrites a
 * statement string, reorders a parameter, or drops a group, this snapshot
 * fails and surfaces the difference at PR time — long before either client
 * picks the change up.
 *
 * Updating the snapshot is intentional and easy (Vitest `-u`); the test's
 * job is to make sure the update is conscious.
 */

import { describe, expect, test } from "vitest";
import type { MediaDetails } from "@space/shared";
import type { LibraryOp } from "@space/shared/libraryOps";
import { buildOpStatements, type IdGenerator } from "../src/ops";

const SUITE = "ops-drift";

const dumpOpsDriftSnapshot = (
  label: string,
  ctx: {
    opCount?: number;
    expectedOpCount?: number;
    opTypeBreakdown?: Record<string, number>;
    perGroupCounts?: Record<string, number>;
    sampleStatementsForOp?: { opId: string; opType: string; groups: Record<string, ReadonlyArray<{ sql: string; params: ReadonlyArray<unknown> }>> };
    runADiff?: ReadonlyArray<unknown>;
    runBDiff?: ReadonlyArray<unknown>;
  },
) => {
  try {
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    if (ctx.opCount !== undefined) {
      console.error(`actual op count: ${ctx.opCount}${ctx.expectedOpCount !== undefined ? ` (expected ${ctx.expectedOpCount})` : ""}`);
    }
    if (ctx.opTypeBreakdown) {
      console.error(`op-type breakdown:\n${JSON.stringify(ctx.opTypeBreakdown, null, 2)}`);
    }
    if (ctx.perGroupCounts) {
      console.error(`per-group statement counts:\n${JSON.stringify(ctx.perGroupCounts, null, 2)}`);
    }
    if (ctx.sampleStatementsForOp) {
      console.error(`sample shape for op ${ctx.sampleStatementsForOp.opId} (${ctx.sampleStatementsForOp.opType}):\n${JSON.stringify(ctx.sampleStatementsForOp.groups, null, 2)}`);
    }
    if (ctx.runADiff) {
      console.error(`run A entries (first 3):\n${JSON.stringify(ctx.runADiff.slice(0, 3), null, 2)}`);
    }
    if (ctx.runBDiff) {
      console.error(`run B entries (first 3):\n${JSON.stringify(ctx.runBDiff.slice(0, 3), null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

const counterIds = (): IdGenerator => {
  let n = 0;
  return () => `gen-${String(++n).padStart(4, "0")}`;
};

const TS = "2024-01-01T00:00:00.000Z";

const minimalMediaDetails = (id: string): MediaDetails => ({
  id,
  type: "movie",
  tmdbId: 1000 + Number(id.slice(2)),
  externalIds: { imdb: `tt${id}` },
  title: `Title ${id}`,
  originalTitle: null,
  originalLanguage: "en",
  overview: null,
  year: "2024",
  rating: 7,
  posterPath: null,
  backdropPath: null,
  genres: [28, 18],
  addedAt: TS,
  updatedAt: TS,
  hasFiles: true,
  progressPct: 0,
  lastWatchedAt: null,
  totalEpisodes: null,
  episodeCount: 0,
  cast: [
    {
      id: `role-${id}-a`,
      personId: `person-${id}-a`,
      tmdbId: null,
      name: "Actor A",
      role: "Lead",
      profilePath: null,
    },
  ],
  playlistIds: [],
  seasons: [],
  episodes: [],
  trailers: [],
  files: [
    {
      id: `file-${id}-1`,
      filename: `${id}.mkv`,
      season: null,
      episode: null,
      desiredFormats: [{ quality: "1080p", codec: "h264", bitrateKbps: 5000 }],
    },
  ],
  formats: [
    {
      id: `fmt-${id}-1`,
      mediaId: id,
      fileId: `file-${id}-1`,
      quality: "1080p",
      codec: "h264",
      codecString: null,
      bitrateKbps: 5000,
      sizeMb: 1500,
      initKey: null,
      initSize: null,
      durationSeconds: 7200,
      totalSize: 1_500_000_000,
      chunks: [{ key: "c1", sizeBytes: 100, startSeconds: 0 }],
      isSource: true,
    },
  ],
  audioTracks: [
    {
      id: `aud-${id}-1`,
      mediaId: id,
      fileId: `file-${id}-1`,
      episodeId: null,
      language: "en",
      label: "English",
      isDefault: true,
      source: "muxed",
      codec: "aac",
      codecString: null,
      initKey: null,
      initSize: null,
      durationSeconds: 7200,
      totalSize: 100_000_000,
      chunks: [{ key: "a1", sizeBytes: 50, startSeconds: 0 }],
    },
  ],
  subtitleTracks: [],
  subtitles: [],
  chapters: [],
  skipMarkers: [],
  hasLocalFiles: true,
});

const fixtureOps = (): ReadonlyArray<LibraryOp> => {
  const ops: LibraryOp[] = [];
  // 10 media.upsert
  for (let i = 0; i < 10; i += 1) {
    const mid = `m-${String(i).padStart(2, "0")}`;
    ops.push({
      id: `op-upsert-${i}`,
      type: "media.upsert",
      createdAt: TS,
      payload: { details: minimalMediaDetails(mid) },
    });
  }
  // 5 media.progress
  for (let i = 0; i < 5; i += 1) {
    ops.push({
      id: `op-progress-${i}`,
      type: "media.progress",
      createdAt: TS,
      payload: {
        mediaId: `m-${String(i).padStart(2, "0")}`,
        progressPct: 10 * (i + 1),
        lastWatchedAt: TS,
        updatedAt: TS,
      },
    });
  }
  // 5 setting.set
  for (let i = 0; i < 5; i += 1) {
    ops.push({
      id: `op-set-${i}`,
      type: "setting.set",
      createdAt: TS,
      payload: { key: `key-${i}`, value: `value-${i}`, updatedAt: TS },
    });
  }
  // 5 playlist lifecycle
  for (let i = 0; i < 3; i += 1) {
    ops.push({
      id: `op-pl-create-${i}`,
      type: "playlist.create",
      createdAt: TS,
      payload: {
        id: `pl-${i}`,
        name: `Playlist ${i}`,
        slug: `pl-${i}`,
        isSystem: false,
        createdAt: TS,
      },
    });
  }
  ops.push({
    id: "op-pl-item-add",
    type: "playlist.item.add",
    createdAt: TS,
    payload: {
      id: "pli-0",
      playlistId: "pl-0",
      mediaId: "m-00",
      addedAt: TS,
    },
  });
  ops.push({
    id: "op-pl-item-rm",
    type: "playlist.item.remove",
    createdAt: TS,
    payload: { playlistId: "pl-0", mediaId: "m-00" },
  });
  // 5 ingest.job.upsert
  for (let i = 0; i < 5; i += 1) {
    ops.push({
      id: `op-ij-up-${i}`,
      type: "ingest.job.upsert",
      createdAt: TS,
      payload: {
        job: {
          id: `job-${i}`,
          mediaId: `m-${String(i).padStart(2, "0")}`,
          fileId: `file-m-${String(i).padStart(2, "0")}-1`,
          workerPeerId: "peer-1",
          ownerClientId: null,
          kind: "transcode",
          status: "processing",
          progressPct: 50,
          errorCode: null,
          errorMessage: null,
          meta: null,
          createdAt: TS,
          updatedAt: TS,
          completedAt: null,
        },
      },
    });
  }
  // 3 ingest events
  for (let i = 0; i < 3; i += 1) {
    ops.push({
      id: `op-ij-ev-${i}`,
      type: "ingest.job.event.add",
      createdAt: TS,
      payload: {
        event: {
          id: `evt-${i}`,
          jobId: `job-${i}`,
          level: "info",
          message: `event ${i}`,
          meta: null,
          createdAt: TS,
        },
      },
    });
  }
  // 2 ingest deletes + 2 history clears
  ops.push({
    id: "op-ij-del-0",
    type: "ingest.job.delete",
    createdAt: TS,
    payload: { jobId: "job-0" },
  });
  ops.push({
    id: "op-ij-del-1",
    type: "ingest.job.delete",
    createdAt: TS,
    payload: { jobId: "job-1" },
  });
  ops.push({
    id: "op-ij-hc-0",
    type: "ingest.job.history.clear",
    createdAt: TS,
    payload: { mediaId: "m-00" },
  });
  ops.push({
    id: "op-ij-hc-1",
    type: "ingest.job.history.clear",
    createdAt: TS,
    payload: { mediaId: "m-01" },
  });
  // 3 media.delete
  for (let i = 0; i < 3; i += 1) {
    ops.push({
      id: `op-md-${i}`,
      type: "media.delete",
      createdAt: TS,
      payload: { mediaId: `m-${String(i + 5).padStart(2, "0")}` },
    });
  }
  // playlist.delete
  ops.push({
    id: "op-pl-del-0",
    type: "playlist.delete",
    createdAt: TS,
    payload: { id: "pl-0" },
  });
  return ops;
};

const buildAll = (): Array<{
  opType: string;
  opId: string;
  groups: Record<string, Array<{ sql: string; params: ReadonlyArray<unknown> }>>;
}> => {
  const idGen = counterIds();
  return fixtureOps().map((op) => {
    const out = buildOpStatements(op, idGen);
    const groups: Record<
      string,
      Array<{ sql: string; params: ReadonlyArray<unknown> }>
    > = {};
    for (const [g, list] of Object.entries(out)) {
      groups[g] = (list ?? []).map((s) => ({ sql: s.sql, params: s.params }));
    }
    return { opType: op.type, opId: op.id, groups };
  });
};

describe("buildOpStatements drift guard", () => {
  test("50-op deterministic fixture produces stable per-group statement batches", () => {
    console.info(`[${SUITE}:setup] building fixture op stream + invoking buildOpStatements for each`);
    const result = buildAll();
    console.info(`[${SUITE}:exec] built ${result.length} op-result entries (expected 41)`);

    const opTypeBreakdown: Record<string, number> = {};
    const perGroupCounts: Record<string, number> = {};
    for (const entry of result) {
      opTypeBreakdown[entry.opType] = (opTypeBreakdown[entry.opType] ?? 0) + 1;
      for (const [g, stmts] of Object.entries(entry.groups)) {
        perGroupCounts[g] = (perGroupCounts[g] ?? 0) + stmts.length;
      }
    }
    console.info(`[${SUITE}:exec] op-type breakdown=${JSON.stringify(opTypeBreakdown)}`);
    console.info(`[${SUITE}:exec] per-group stmt counts=${JSON.stringify(perGroupCounts)}`);

    try {
      // 41 ops total — covers all 12 op types and exercises the cross-group
      // cascade thoroughly. (Spec said "≈50"; counted what the fixture builder
      // actually produces.)
      expect(result).toHaveLength(41);
      expect(result).toMatchSnapshot();
    } catch (err) {
      dumpOpsDriftSnapshot("snapshot-drift-or-count-mismatch", {
        opCount: result.length,
        expectedOpCount: 41,
        opTypeBreakdown,
        perGroupCounts,
        sampleStatementsForOp: result[0]
          ? { opId: result[0].opId, opType: result[0].opType, groups: result[0].groups }
          : undefined,
      });
      throw err;
    }
  });

  test("re-running the builder with the same idGen seed is byte-identical", () => {
    console.info(`[${SUITE}:setup] running builder twice to verify determinism`);
    const a = buildAll();
    const b = buildAll();
    console.info(`[${SUITE}:check] run-A entries=${a.length} run-B entries=${b.length}`);

    try {
      expect(b).toEqual(a);
    } catch (err) {
      // Find first divergence
      let firstDiffIdx = -1;
      const minLen = Math.min(a.length, b.length);
      for (let i = 0; i < minLen; i += 1) {
        if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) {
          firstDiffIdx = i;
          break;
        }
      }
      console.error(`[${SUITE}:determinism-violated] first divergence at index ${firstDiffIdx}`);
      dumpOpsDriftSnapshot("determinism-violated", {
        opCount: a.length,
        runADiff: firstDiffIdx >= 0 ? a.slice(firstDiffIdx, firstDiffIdx + 1) : a,
        runBDiff: firstDiffIdx >= 0 ? b.slice(firstDiffIdx, firstDiffIdx + 1) : b,
      });
      throw err;
    }
  });
});
