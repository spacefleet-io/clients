/**
 * @test-id LIB-OP-WRITE-STORM-001
 * @level integration (real-engine, bun:sqlite, full LibraryDb, in-memory fake API)
 * @bugfix @regression-proof issue #25 (library write storm)
 *
 * The ultimate run saw the library version climb by hundreds per minute.
 * Every local write queued its own op and every op was its own encrypted
 * PUT /library/db/ops (one server version each, one SSE meta fan-out each,
 * one GET meta for the compaction check each):
 *
 *   - an ingest commit (linkFileToMedia, addMediaFormat, N audio tracks,
 *     M subtitles, chapters, markMediaPlayable) re-serialised the FULL
 *     media details into a fresh `media.upsert` op on every step, so one
 *     logical "this quality is ready" change uploaded ~15 upserts of
 *     tens of KB each, each one superseding the previous;
 *   - playback progress (renderer saves every ~0.5 s) uploaded one
 *     `media.progress` (+ one `setting.set` per episode) every save.
 *
 * Fix under test: ops still waiting in the queue are coalesced with the
 * same latest-state-wins rule every receiver already applies
 * (compactLibraryOps), and a queue holding only progress-class ops waits
 * `LibraryDb.progressOpsFlushDelayMs` before uploading, while any other op
 * still flushes promptly (taking the coalesced progress along).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  LibraryDb,
  decodeServerOps,
  drained,
  fake,
  ingestCommit,
  log,
  maxProgressUploads,
  openSynced,
  pendingCount,
  restoreRealApi,
  seedMovie,
  summarize,
  waitFor,
} from "./support/opWriteStormHarness";

afterAll(restoreRealApi);

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-op-write-storm-"));
  process.env.SF_USER_DATA_PATH = root;
  fake.reset();
  log("setup", { root });
});

afterEach(() => {
  log("teardown", { root, fake: fake.dump() });
  rmSync(root, { recursive: true, force: true });
  delete process.env.SF_USER_DATA_PATH;
});

// Tests
// ---------------------------------------------------------------------------
describe("issue #25 — one logical library change uploads one op, not one per write", () => {
  it("@bugfix @regression-proof an ingest commit (15 writes for one quality) uploads at most one media.upsert", async () => {
    const db = await openSynced();
    try {
      const mediaId = await seedMovie(db, 25_101, "Write Storm Movie");
      await waitFor("seed flushed", () => drained(db));
      const before = fake.version;

      log("phase:ingest-commit 1080p (link, format, chapters, 6 audio, 4 subs, playable)");
      await ingestCommit(db, mediaId, "1080p");
      await waitFor("commit ops flushed", () => drained(db));

      const serverOps = await decodeServerOps(before);
      const summary = summarize(serverOps);
      log("result:ingest-commit", summary);
      const upserts = serverOps.filter((entry) => entry.op.type === "media.upsert");
      // The surviving upsert must carry the FINAL state (replayable on its own).
      const last = upserts.at(-1)?.op;
      expect(last?.type).toBe("media.upsert");
      if (last?.type === "media.upsert") {
        log("result:last-upsert", {
          hasFiles: last.payload.details.hasFiles,
          formats: last.payload.details.formats?.length,
          audioTracks: last.payload.details.audioTracks?.length,
          subtitles: last.payload.details.subtitles?.length,
        });
        expect(last.payload.details.hasFiles).toBe(true);
        expect(last.payload.details.audioTracks?.length).toBe(6);
        expect(last.payload.details.subtitles?.length).toBe(4);
      }
      expect(upserts.length).toBeLessThanOrEqual(1);
    } finally {
      db.close();
    }
  }, 30_000);

  it("@bugfix @regression-proof a playback session's progress saves are coalesced, and the last value reaches the server", async () => {
    const previousDelay = LibraryDb.progressOpsFlushDelayMs;
    LibraryDb.progressOpsFlushDelayMs = 1_500;
    const db = await openSynced();
    try {
      const mediaId = await seedMovie(db, 25_102, "Write Storm Playback");
      await waitFor("seed flushed", () => drained(db));
      const before = fake.version;

      log("phase:playback 20 saves, 100 ms apart (renderer cadence compressed 5x)");
      let pct = 10;
      const startedAt = performance.now();
      for (let index = 0; index < 20; index += 1) {
        pct = 10 + index * 0.25;
        void db.setProgress(mediaId, pct);
        await Bun.sleep(100);
      }
      const savesElapsedMs = performance.now() - startedAt;
      await waitFor("progress flushed", () => drained(db), 10_000);

      const serverOps = await decodeServerOps(before);
      const summary = summarize(serverOps);
      log("result:playback", summary);
      const progressOps = serverOps.filter((entry) => entry.op.type === "media.progress");
      const lastProgress = progressOps.at(-1)?.op;
      expect(lastProgress?.type === "media.progress" ? lastProgress.payload.progressPct : null).toBe(pct);
      // Bound from the MEASURED loop time (a CPU-starved runner stretches the 20 sleeps past 3 s and
      // legitimately opens a third window, CI run 11783 / #278), with the flush's real drain size
      // (in-flight head + one late save) baked in: see maxProgressUploads. Nominally ~2 s of saves
      // is at most 4 uploads; one upload per save (the regression) is 20.
      const maxUploads = maxProgressUploads(savesElapsedMs, LibraryDb.progressOpsFlushDelayMs);
      log("result:playback-bound", { savesElapsedMs: Math.round(savesElapsedMs), maxUploads, uploads: progressOps.length });
      expect(progressOps.length).toBeLessThanOrEqual(maxUploads);
    } finally {
      db.close();
      LibraryDb.progressOpsFlushDelayMs = previousDelay;
    }
  }, 30_000);

  it("@bugfix @regression-proof one progress flush drains exactly the in-flight head plus the latest save that arrived during it (the 2x in the upload bound)", async () => {
    const previousDelay = LibraryDb.progressOpsFlushDelayMs;
    LibraryDb.progressOpsFlushDelayMs = 50;
    const db = await openSynced();
    let release: () => void = () => undefined;
    try {
      const mediaId = await seedMovie(db, 25_105, "Write Storm Two Per Flush");
      await waitFor("seed flushed", () => drained(db));
      const before = fake.version;
      const putsBefore = fake.putsStarted;

      // Deterministic, no clock: park the first PUT so the flush stays in flight while more saves land.
      fake.putGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      void db.setProgress(mediaId, 11);
      await waitFor("head PUT in flight", () => fake.putsStarted === putsBefore + 1);
      // Any further timer would now take a minute: the extra upload below must come from the SAME flush loop.
      LibraryDb.progressOpsFlushDelayMs = 60_000;
      await db.setProgress(mediaId, 12);
      await db.setProgress(mediaId, 13);
      // The in-flight head is never compacted away; 12 and 13 coalesce into one op behind it.
      expect(pendingCount(db)).toBe(2);

      fake.putGate = null;
      release();
      await waitFor("single flush drained head + latest", () => drained(db), 3_000);
      const progress = (await decodeServerOps(before)).flatMap((entry) => (entry.op.type === "media.progress" ? [entry.op.payload.progressPct] : []));
      log("result:two-per-flush", { progress });
      expect(progress).toEqual([11, 13]);
    } finally {
      fake.putGate = null;
      release();
      db.close();
      LibraryDb.progressOpsFlushDelayMs = previousDelay;
    }
  }, 30_000);

  it("maxProgressUploads (arithmetic only, drift guard for the helper): 2*(floor(elapsed/delay)+1), and 20 uploads exceeds it for plausible loop times", () => {
    // Pure arithmetic on a fake clock (elapsed ms are inputs): the nominal 20 x 100 ms session against the
    // 1.5 s delay, a starved 3.1 s / 4.6 s session that opens extra windows, and the degenerate zero.
    expect(maxProgressUploads(0, 1_500)).toBe(2);
    expect(maxProgressUploads(2_000, 1_500)).toBe(4);
    expect(maxProgressUploads(3_100, 1_500)).toBe(6);
    expect(maxProgressUploads(4_600, 1_500)).toBe(8);
    // The pre-fix behaviour uploaded every save (20) however long the loop took; a loop would need to
    // stretch past ~13.5 s of wall time before 20 uploads fit under the bound.
    for (const elapsedMs of [2_000, 3_100, 4_600, 10_000]) {
      expect(20).toBeGreaterThan(maxProgressUploads(elapsedMs, 1_500));
    }
  });

  it("@bugfix @regression-proof a non-progress write is not held back by a pending progress op", async () => {
    const previousDelay = LibraryDb.progressOpsFlushDelayMs;
    LibraryDb.progressOpsFlushDelayMs = 60_000;
    const db = await openSynced();
    try {
      const mediaId = await seedMovie(db, 25_103, "Write Storm Mixed");
      await waitFor("seed flushed", () => drained(db));
      const before = fake.version;

      log("phase:mixed progress save, then a library write 50 ms later");
      void db.setProgress(mediaId, 42);
      await Bun.sleep(50);
      await db.markMediaPlayable(mediaId);
      // Must flush on the normal 250 ms debounce, carrying the progress along.
      await waitFor("mixed queue flushed promptly", () => drained(db), 3_000);
      const serverOps = await decodeServerOps(before);
      log("result:mixed", summarize(serverOps));
      expect(serverOps.map((entry) => entry.op.type).sort()).toEqual(["media.progress", "media.upsert"]);
    } finally {
      db.close();
      LibraryDb.progressOpsFlushDelayMs = previousDelay;
    }
  }, 30_000);

  it("@bugfix @regression-proof a write that changes nothing does not upload another media.upsert", async () => {
    const db = await openSynced();
    try {
      const mediaId = await seedMovie(db, 25_104, "Write Storm Noop");
      await ingestCommit(db, mediaId, "720p");
      await waitFor("ingest flushed", () => drained(db));
      const before = fake.version;

      log("phase:noop markMediaPlayable on an already playable media, x3");
      for (let index = 0; index < 3; index += 1) {
        await db.markMediaPlayable(mediaId);
        await waitFor(`noop ${index} settled`, () => drained(db));
      }
      const serverOps = await decodeServerOps(before);
      log("result:noop", summarize(serverOps));
      expect(serverOps.filter((entry) => entry.op.type === "media.upsert").length).toBe(0);
    } finally {
      db.close();
    }
  }, 30_000);
});
