/**
 * @test-id PARROT-INGEST-IMPORT-THROUGHPUT-001
 * @req PAR-UP-13[parrot] @req PAR-UP-14[parrot] @req INGS-JOBS-01[parrot] @req INGS-JOBS-04[parrot]
 * @level unit
 * @why PAR-UP-13 / PAR-UP-14: Chris's 24-song album took 3 min 05 s on 2026-11-26 because each song waited for the one
 *      before it to upload, get its light copy and be published (one snapshot PUT per song). Against a fake server as
 *      slow as his line (scaled to a tenth), the songs of an album upload side by side and the library goes out in a
 *      few batched snapshot PUTs, not one per song.
 * @covers packages/parrot-ingest/src/importer.ts
 */
import { describe, expect, it } from "bun:test";
import { testLog } from "./helpers";
import { timeSlowAlbumImport } from "./slowServer";

const log = testLog("PARROT-INGEST-IMPORT-THROUGHPUT-001");

describe("album import throughput", () => {
  it("uploads songs side by side and publishes in batches", async () => {
    const lines: string[] = [];
    const run = await timeSlowAlbumImport({ songs: 24, bytesPerSong: 1_000_000, scale: 0.1, log: (line) => lines.push(line) });
    log("import timed", { ms: run.ms, realMs: run.realMs, publishes: run.publishes, peak: run.peakSongsUploading, failed: run.result.failed });
    expect(run.result.failed).toEqual([]);
    expect(run.result.imported).toHaveLength(24);
    expect(run.peakSongsUploading).toBeGreaterThanOrEqual(2);
    expect(run.publishes).toBeGreaterThanOrEqual(1);
    expect(run.publishes).toBeLessThanOrEqual(6);
    // The light copies are made too (PAR-FMT-02), each logged.
    expect(lines.filter((line) => line.startsWith("[parrot-light-copy]"))).toHaveLength(24);
  }, 60_000);
});
