/**
 * @test-id PARROT-INGEST-PLAYBACK-GATE-001
 * @req PAR-UP-15[parrot]
 * @level unit
 * @why PAR-UP-15: Chris was playing songs while his album imported (2026-11-26). Like Badger's uploads while a video
 *      plays (#25), this computer's choice applies to Parrot imports: `throttle` keeps at most the gate's chunks in
 *      flight across every song, `pause` starts no new chunk (nor light copy) until the playing stops.
 * @covers packages/parrot-ingest/src/uploadGate.ts
 */
import { describe, expect, it } from "bun:test";
import { createUploadPlaybackGate } from "@space/content-core/storageTransport";
import { testLog } from "./helpers";
import { timeSlowAlbumImport } from "./slowServer";
import { createParrotChunkSlots } from "../src/uploadGate";

const log = testLog("PARROT-INGEST-PLAYBACK-GATE-001");

describe("uploads while playing", () => {
  it("throttle: at most two chunks in flight across the songs while a song plays", async () => {
    const gate = createUploadPlaybackGate();
    gate.update({ mode: "throttle", playbackActive: true, leaseMs: 60_000 });
    const run = await timeSlowAlbumImport({ songs: 6, bytesPerSong: 3_000_000, scale: 0.05, options: { uploadGate: gate } });
    log("throttled", { ms: run.ms, peakObjects: run.peakObjectsInFlight, peakSongs: run.peakSongsUploading });
    expect(run.result.imported).toHaveLength(6);
    expect(run.peakObjectsInFlight).toBeLessThanOrEqual(2);
  }, 60_000);

  it("pause: nothing is uploaded while a song plays; the import goes on once it stops", async () => {
    const gate = createUploadPlaybackGate();
    gate.update({ mode: "pause", playbackActive: true, leaseMs: 60_000 });
    let stoppedAt = Number.POSITIVE_INFINITY;
    const timer = setTimeout(() => {
      stoppedAt = Date.now();
      gate.update({ mode: "pause", playbackActive: false });
    }, 400);
    try {
      const run = await timeSlowAlbumImport({ songs: 3, bytesPerSong: 1_000_000, scale: 0.05, options: { uploadGate: gate } });
      const uploads = run.timeline.filter((event) => event.kind === "upload");
      const firstUploadAt = run.serverStartedAt + Math.min(...uploads.map((event) => event.start));
      log("paused", { ms: run.ms, firstUploadAfterStopMs: firstUploadAt - stoppedAt });
      expect(run.result.imported).toHaveLength(3);
      // No object reached the server before the playing stopped.
      expect(firstUploadAt).toBeGreaterThanOrEqual(stoppedAt);
    } finally {
      clearTimeout(timer);
    }
  }, 60_000);

  it("a cancel: no slot is handed out after it, and a chunk waiting for one stops", async () => {
    const gate = createUploadPlaybackGate();
    gate.update({ mode: "pause", playbackActive: true, leaseMs: 60_000 });
    const slots = createParrotChunkSlots(gate);
    const controller = new AbortController();
    const waiting = slots.take(controller.signal);
    controller.abort(new Error("user cancelled"));
    const answers = await Promise.allSettled([waiting, slots.take(controller.signal)]);
    log("cancelled", answers.map((answer) => answer.status));
    expect(answers.map((answer) => answer.status)).toEqual(["rejected", "rejected"]);
  });
});
