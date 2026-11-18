/**
 * @test-id MOBILE-SEEK-PREVIEW-LATE-001
 * @level unit
 * @req MPV-PREV-04[badger-mobile,badger-tv]
 *
 * Chris 2026-11-02 (desktop): a video opened seconds after its import committed showed no previews for the whole
 * playback, although its sheets were recorded 3 minutes later. The phone / TV player read the record once, when the
 * session started (`usePlayerSession`), so it had the same gap. Mirrors
 * `apps/badger/desktop/tests/mpv-preview-sheets-late-record.test.ts`.
 *
 * Pins:
 *  1. while the played file has no record, the watch re-reads it each time another device's changes land, and hands
 *     it over once (then stops); this device's own writes (progress saves) never cause a re-read;
 *  2. the session starts the watch only for a streamed file without previews, and stops it with the playback;
 *  3. the library moves the synced revision only when remote ops or a snapshot land.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaPreviewSheets } from "@space/shared/previewSheets";
import { previewSheetsForFile, watchLatePreviewSheets } from "../src/lib/playback/seekPreviewSource";

const TAG = "[seek-preview-late-record]";

const sheets = (key: string): MediaPreviewSheets => ({
  version: 1,
  intervalSeconds: 5,
  pictureWidth: 160,
  pictureHeight: 66,
  columns: 10,
  rows: 10,
  pictureCount: 2740,
  sheets: [{ objectKey: key, sizeBytes: 67948, firstPicture: 0, pictureCount: 100 }],
});

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const harness = (initialRevision = 7) => {
  let revision = initialRevision;
  let record: MediaPreviewSheets | null = null;
  let failNext = false;
  const reads: number[] = [];
  const found: MediaPreviewSheets[] = [];
  const stop = watchLatePreviewSheets({
    readRevision: () => revision,
    sinceRevision: initialRevision,
    readPreviews: async () => {
      reads.push(revision);
      if (failNext) {
        failNext = false;
        throw new Error("db_busy");
      }
      return record;
    },
    onFound: (previews) => found.push(previews),
    intervalMs: 2000,
  });
  const tick = async (ms = 2000) => {
    await vi.advanceTimersByTimeAsync(ms);
  };
  return {
    stop,
    tick,
    reads,
    found,
    landRemote: (next: MediaPreviewSheets | null) => {
      revision += 1;
      record = next;
    },
    failNextRead: () => {
      failNext = true;
    },
  };
};

describe("late preview sheets on the phone / TV player (MPV-PREV-04)", () => {
  it("re-reads only after another device's changes land, and hands the record over once", async () => {
    const h = harness();
    console.info(TAG, "phase: nothing landed");
    await h.tick();
    await h.tick();
    expect(h.reads, "no re-read while the synced revision is unchanged").toEqual([]);

    console.info(TAG, "phase: an unrelated remote change (no record yet)");
    h.landRemote(null);
    await h.tick();
    console.info(TAG, "after unrelated change", JSON.stringify({ reads: h.reads, found: h.found.length }));
    expect(h.reads).toEqual([8]);
    expect(h.found).toEqual([]);

    console.info(TAG, "phase: a read fails, the next change reads again");
    h.failNextRead();
    h.landRemote(null);
    await h.tick();
    expect(h.reads).toEqual([8, 9]);

    console.info(TAG, "phase: the runtime records the sheets");
    h.landRemote(sheets("sheet-a"));
    await h.tick();
    console.info(TAG, "after record", JSON.stringify({ reads: h.reads, found: h.found.map((s) => s.sheets[0]?.objectKey) }));
    expect(h.found.map((s) => s.sheets[0]?.objectKey)).toEqual(["sheet-a"]);

    console.info(TAG, "phase: later changes after the hand-over");
    h.landRemote(sheets("sheet-b"));
    await h.tick();
    await h.tick();
    expect(h.reads, "the watch stopped once the record was handed over").toEqual([8, 9, 10]);
    expect(h.found).toHaveLength(1);
    h.stop();
  });

  it("stops with the playback: nothing is read or handed over afterwards", async () => {
    const h = harness();
    h.stop();
    h.landRemote(sheets("sheet-a"));
    await h.tick();
    console.info(TAG, "after stop", JSON.stringify({ reads: h.reads, found: h.found.length }));
    expect(h.reads).toEqual([]);
    expect(h.found).toEqual([]);
  });

  it("a record landing during the session's own read is still picked up (the watch starts from the read's revision)", async () => {
    // The session took revision 7 before reading the title; the record landed (8) before the watch started.
    let revision = 8;
    const found: string[] = [];
    const stop = watchLatePreviewSheets({
      readRevision: () => revision,
      sinceRevision: 7,
      readPreviews: async () => sheets("sheet-early"),
      onFound: (previews) => found.push(previews.sheets[0]!.objectKey),
      intervalMs: 2000,
    });
    await vi.advanceTimersByTimeAsync(2000);
    console.info(TAG, "early landing", JSON.stringify({ revision, found }));
    expect(found).toEqual(["sheet-early"]);
    revision += 1;
    stop();
  });

  it("the played file's record comes from its source format only", () => {
    const formats = [
      { fileId: "file-1", previewSheets: undefined },
      { fileId: "file-2", previewSheets: sheets("other-file") },
      { fileId: "file-1", previewSheets: sheets("sheet-a") },
    ];
    const record = previewSheetsForFile(formats, "file-1");
    console.info(TAG, "record for file", JSON.stringify({ key: record?.sheets[0]?.objectKey }));
    expect(record?.sheets[0]?.objectKey).toBe("sheet-a");
    expect(previewSheetsForFile([{ fileId: "file-1", previewSheets: undefined }], "file-1")).toBeNull();
  });
});

describe("wiring (MPV-PREV-04)", () => {
  const read = (path: string) => readFileSync(resolve(__dirname, "..", path), "utf8");

  it("the session watches only a streamed file without previews, and stops the watch with the playback", () => {
    const session = read("src/screens/player/usePlayerSession.ts");
    const watchAt = session.indexOf("watchLatePreviewSheets({");
    console.info(TAG, "session wiring", JSON.stringify({ watchAt }));
    expect(watchAt).toBeGreaterThan(0);
    expect(session).toMatch(/if \(!useOffline && !previews\) \{\s*\/\/[^\n]*\n\s*stopLatePreviews = watchLatePreviewSheets\(/);
    expect(session).toContain("readRevision: syncedLibraryRevision");
    expect(session).toContain("sinceRevision: detailsRevision");
    expect(session).toMatch(/mounted = false;\s*stopLatePreviews\?\.\(\);/);
    // The revision is taken before the title is read, so a record landing during that read is read again.
    expect(session.indexOf("const detailsRevision = syncedLibraryRevision();")).toBeLessThan(
      session.indexOf("live().getMediaDetails(mediaId, { chunks: false }),"),
    );
  });

  it("the synced revision moves when remote ops or a snapshot land, not on this device's own queued ops", () => {
    const db = read("src/lib/libraryDb.ts");
    const emit = db.slice(db.indexOf("private emitDataChanged("), db.indexOf("private emitDataChanged(") + 300);
    const queue = db.slice(db.indexOf("private async queueOp("), db.indexOf("private async queueOp(") + 400);
    console.info(TAG, "db wiring", JSON.stringify({ emitHasSynced: emit.includes("bumpSyncedLibraryRevision()"), queueHasSynced: queue.includes("bumpSyncedLibraryRevision") }));
    expect(emit).toContain("bumpSyncedLibraryRevision();");
    expect(queue).not.toContain("bumpSyncedLibraryRevision");
  });
});
