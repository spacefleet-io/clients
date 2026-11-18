/**
 * @bugfix @regression-proof
 *
 * Issue #25: `getSnapshot()` embedded EVERY ingest job event ever recorded,
 * so the snapshot — published on each library write and pulled by the
 * desktop — grew for the whole life of a library (~1 MB in the field). No
 * renderer reads job events from the snapshot (job progress comes from the
 * V2 jobs API; per-job history stays available via `listIngestJobEvents`),
 * so the snapshot no longer carries them and its size is independent of the
 * event history.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { LibraryDb } from "../src/libraryDb";

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-snapshot-job-events-"));
  process.env.SF_USER_DATA_PATH = root;
  console.info(`[snapshot-job-events:setup] root=${root}`);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.SF_USER_DATA_PATH;
});

describe("library snapshot job-event growth (#25) @bugfix @regression-proof", () => {
  it("snapshot size does not grow with the ingest job event history", async () => {
    const db = await LibraryDb.openLocal("token", "key");
    db.setSyncEnabled(false);
    try {
      const mediaId = await db.addMediaFromCatalog({
        id: 404,
        type: "movie",
        title: "Snapshot Growth",
        originalTitle: null,
        originalLanguage: "en",
        overview: null,
        year: "2026",
        rating: null,
        posterPath: null,
        backdropPath: null,
        genres: [],
        cast: [],
        trailers: [],
      } as never);
      db.upsertIngestJob({
        id: "job-growth-1",
        mediaId: String(mediaId),
        workerPeerId: "worker-1",
        kind: "source_ingest",
        status: "running",
        progressPct: 0,
      } as never);
      const bytesBefore = JSON.stringify(db.getSnapshot()).length;
      const events = 500;
      for (let i = 0; i < events; i += 1) {
        await db.addIngestJobEvent({
          jobId: "job-growth-1",
          level: "info",
          message: `progress ${i}`,
          meta: { pct: i % 100, stage: "transcode", detail: "x".repeat(120) },
        });
      }
      const snapshot = db.getSnapshot();
      const bytesAfter = JSON.stringify(snapshot).length;
      console.info(
        `[snapshot-job-events:size] events=${events} bytesBefore=${bytesBefore} bytesAfter=${bytesAfter} growth=${bytesAfter - bytesBefore}`
      );
      expect("ingestJobEvents" in snapshot).toBe(false);
      // Only the job row's updatedAt/progress can move; nothing per event.
      expect(bytesAfter - bytesBefore).toBeLessThan(1_000);
      // History is still there for the per-job reader.
      expect(db.listIngestJobEvents("job-growth-1")).toHaveLength(events);
      expect(snapshot.ingestJobs).toEqual([expect.objectContaining({ id: "job-growth-1" })]);
    } finally {
      db.close();
    }
  });
});
