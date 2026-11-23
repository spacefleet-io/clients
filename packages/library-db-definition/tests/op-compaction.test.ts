import { describe, expect, it } from "vitest";
import { compactLibraryOps } from "../src/opCompaction";
import type { LibraryOp } from "@space/shared/libraryOps";

const SUITE = "op-compaction";

const dumpCompactionSnapshot = (
  label: string,
  ctx: {
    inputOps?: ReadonlyArray<unknown>;
    compactedOps?: ReadonlyArray<unknown>;
    expectedIds?: ReadonlyArray<string>;
    actualIds?: ReadonlyArray<string>;
  },
) => {
  try {
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    if (ctx.inputOps) {
      console.error(`input op count: ${ctx.inputOps.length}`);
      console.error(`input ops:\n${JSON.stringify(ctx.inputOps, null, 2)}`);
    }
    if (ctx.compactedOps) {
      console.error(`compacted op count: ${ctx.compactedOps.length}`);
      console.error(`compacted ops:\n${JSON.stringify(ctx.compactedOps, null, 2)}`);
    }
    if (ctx.expectedIds) {
      console.error(`expected ids: ${JSON.stringify(ctx.expectedIds)}`);
    }
    if (ctx.actualIds) {
      console.error(`actual ids: ${JSON.stringify(ctx.actualIds)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("compactLibraryOps", () => {
  it("keeps only latest upsert/progress/setting and preserves deletes", () => {
    console.info(`[${SUITE}:setup] building input op stream (9 ops covering setting/upsert/progress/delete/playlist)`);
    const ops = [
      { id: "1", type: "setting.set", createdAt: "t1", payload: { key: "ui.lang", value: "en", updatedAt: "t1" } },
      { id: "2", type: "media.upsert", createdAt: "t2", payload: { details: { id: "m1" } } },
      { id: "3", type: "media.progress", createdAt: "t3", payload: { mediaId: "m1", progressPct: 10, lastWatchedAt: null, updatedAt: "t3" } },
      { id: "4", type: "media.progress", createdAt: "t4", payload: { mediaId: "m1", progressPct: 40, lastWatchedAt: null, updatedAt: "t4" } },
      { id: "5", type: "media.upsert", createdAt: "t5", payload: { details: { id: "m1" } } },
      { id: "6", type: "setting.set", createdAt: "t6", payload: { key: "ui.lang", value: "fr", updatedAt: "t6" } },
      { id: "7", type: "media.delete", createdAt: "t7", payload: { mediaId: "m1" } },
      { id: "8", type: "media.delete", createdAt: "t8", payload: { mediaId: "m1" } },
      { id: "9", type: "playlist.create", createdAt: "t9", payload: { id: "p1", name: "x", slug: null, isSystem: false, createdAt: "t9" } },
    ] as any;
    console.info(`[${SUITE}:setup] input op count=${ops.length}`);

    console.info(`[${SUITE}:exec] calling compactLibraryOps`);
    const compacted = compactLibraryOps(ops);
    const actualIds = compacted.map((op: any) => op.id);
    const expectedIds = ["6", "8", "9"];
    console.info(`[${SUITE}:exec] compacted op count=${compacted.length} actualIds=${JSON.stringify(actualIds)} expectedIds=${JSON.stringify(expectedIds)}`);

    try {
      expect(actualIds).toEqual(expectedIds);
    } catch (err) {
      dumpCompactionSnapshot("compaction-mismatch", {
        inputOps: ops,
        compactedOps: compacted,
        expectedIds,
        actualIds,
      });
      throw err;
    }
  });
});

describe("compactLibraryOps keeps the newest change, not the last to arrive", () => {
  // @req LIB-SYNC-08[runtime]
  // @req LIB-SYNC-08[badger-desktop]
  it("picks the greatest timestamp per upsert / progress / setting key, ties go to the later arrival", () => {
    const ops = [
      { id: "u-new", type: "media.upsert", createdAt: "2", payload: { details: { id: "m1", updatedAt: "2026-01-03" } } },
      { id: "u-old", type: "media.upsert", createdAt: "1", payload: { details: { id: "m1", updatedAt: "2026-01-01" } } },
      { id: "p-new", type: "media.progress", createdAt: "2", payload: { mediaId: "m1", progressPct: 50, lastWatchedAt: null, updatedAt: "2026-01-03" } },
      { id: "p-old", type: "media.progress", createdAt: "1", payload: { mediaId: "m1", progressPct: 10, lastWatchedAt: null, updatedAt: "2026-01-01" } },
      { id: "s-new", type: "setting.set", createdAt: "2", payload: { key: "k", value: "new", updatedAt: "2026-01-03" } },
      { id: "s-old", type: "setting.set", createdAt: "1", payload: { key: "k", value: "old", updatedAt: "2026-01-01" } },
      { id: "s-tie", type: "setting.set", createdAt: "3", payload: { key: "k", value: "tie", updatedAt: "2026-01-03" } },
    ] as unknown as LibraryOp[];
    console.info(`[${SUITE}:newest-wins] input ids=${JSON.stringify(ops.map((o) => o.id))}`);
    const actualIds = compactLibraryOps(ops).map((op) => op.id);
    console.info(`[${SUITE}:newest-wins] actualIds=${JSON.stringify(actualIds)}`);
    expect(actualIds).toEqual(["u-new", "p-new", "s-tie"]);
  });
});

describe("compactLibraryOps drops the playback of a title deleted later in the batch", () => {
  // @bugfix @regression-proof LIB-SYNC-22: a device replaying "add a film, delete it" kept the film's playback rows.
  // @req LIB-SYNC-22[runtime]
  it("drops version-4 playback and episode ops before the delete, keeps the ones of a re-add after it", () => {
    const set = (id: string, mediaId: string) =>
      ({ id, type: "media.file.playback.set", createdAt: id, payload: { mediaId, fileId: "f1", updatedAt: id, formats: [], audioTracks: [], subtitles: [], chapters: [] } });
    const ops = [
      set("set-m1-before", "m1"),
      { id: "pdel-m1-before", type: "media.file.playback.delete", createdAt: "2", payload: { mediaId: "m1", fileId: null } },
      { id: "ep-m1-before", type: "media.episode.delete", createdAt: "3", payload: { mediaId: "m1", episodeId: "e1", seasonNumber: 1, episodeNumber: 1, fileIds: [] } },
      set("set-m2", "m2"),
      { id: "del-m1", type: "media.delete", createdAt: "4", payload: { mediaId: "m1" } },
      set("set-m1-readd", "m1"),
    ] as unknown as LibraryOp[];
    console.info(`[${SUITE}:delete-drops-playback] input ids=${JSON.stringify(ops.map((o) => o.id))}`);
    const actualIds = compactLibraryOps(ops).map((op) => op.id);
    console.info(`[${SUITE}:delete-drops-playback] actualIds=${JSON.stringify(actualIds)}`);
    expect(actualIds).toEqual(["set-m2", "del-m1", "set-m1-readd"]);
  });
});
