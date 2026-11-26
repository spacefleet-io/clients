/**
 * #25 library write storm — op rate / size bench. NOT part of any suite
 * (not a *.test.ts file, so `bun test` never discovers it); run it by path
 * under bun's runner (mock.module + bun:sqlite):
 *
 *   cd packages/library-db-runtime
 *   bun test ./scripts/op-write-rate.bench.ts
 *
 * Drives the REAL LibraryDb against the in-memory fake API of
 * tests/support/opWriteStormHarness.ts and reports what reaches the server
 * (one server version per op) for:
 *   - ingest: three quality commits of one movie (the runtime's commit
 *     writes: link, format, chapters, 6 audio, 4 subtitles, playable);
 *   - playback: an episode watched for SF_OP_RATE_PLAY_SECONDS (default 60)
 *     with the renderer's real cadence (one progress save every 500 ms),
 *     then flushPending() (what logout / shutdown drains).
 *
 * Wall-clock sleeps are the point (the debounce / deferral timers are real),
 * so no fake timers.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, it } from "bun:test";
import {
  decodeServerOps,
  drained,
  fake,
  ingestCommit,
  log,
  openSynced,
  restoreRealApi,
  seedMovie,
  summarize,
  waitFor,
} from "../tests/support/opWriteStormHarness";

afterAll(restoreRealApi);

const PLAY_SECONDS = Number(process.env.SF_OP_RATE_PLAY_SECONDS ?? 60);
const SAVE_EVERY_MS = 500;

describe("#25 op write-rate bench", () => {
  it("ingest + playback session", async () => {
    const root = mkdtempSync(join(tmpdir(), "sf-op-rate-bench-"));
    process.env.SF_USER_DATA_PATH = root;
    fake.reset();
    const db = await openSynced();
    try {
      const movieId = await seedMovie(db, 25_201, "Bench Movie");
      const showId = await db.addMediaFromCatalog({
        id: 25_202,
        type: "tv",
        title: "Bench Show",
        originalTitle: null,
        originalLanguage: "en",
        overview: null,
        year: "2026",
        posterPath: null,
        backdropPath: null,
        genres: [],
        cast: [],
        trailers: [],
        totalEpisodes: 10,
        seasons: [],
        episodes: Array.from({ length: 10 }, (_, index) => ({
          seasonNumber: 1,
          episodeNumber: index + 1,
          name: `Episode ${index + 1}`,
          overview: null,
          stillPath: null,
          airDate: null,
        })),
      });
      await waitFor("seed flushed", () => drained(db));
      const episodeId = db.getMediaDetails(showId)?.episodes?.[0]?.id ?? null;
      log("bench:seeded", { movieId, showId, episodeId });

      // --- ingest -------------------------------------------------------
      const ingestFrom = fake.version;
      const ingestStarted = Date.now();
      for (const quality of ["2160p", "1080p", "720p"]) {
        await ingestCommit(db, movieId, quality);
        // Quality commits land minutes apart in a real ingest (each waits for
        // its transcode + upload); 1 s keeps them outside one flush debounce.
        await Bun.sleep(1_000);
      }
      await waitFor("ingest flushed", () => drained(db), 60_000);
      const ingestMs = Date.now() - ingestStarted;
      const ingest = summarize(await decodeServerOps(ingestFrom));
      log("bench:ingest", { ...ingest, wallMs: ingestMs, commits: 3, writes: 3 * 14 });

      // --- playback -----------------------------------------------------
      const playFrom = fake.version;
      const playStarted = Date.now();
      const saves = Math.round((PLAY_SECONDS * 1000) / SAVE_EVERY_MS);
      for (let index = 0; index < saves; index += 1) {
        void db.setProgress(showId, (index / saves) * 100, episodeId, {
          positionSeconds: (index * SAVE_EVERY_MS) / 1000,
          durationSeconds: 2_700,
        });
        await Bun.sleep(SAVE_EVERY_MS);
      }
      const playMs = Date.now() - playStarted;
      const opsDuringPlay = summarize(await decodeServerOps(playFrom));
      await db.flushPending();
      const playback = summarize(await decodeServerOps(playFrom));
      log("bench:playback", {
        saves,
        playSeconds: Math.round(playMs / 1000),
        uploadedDuringPlay: opsDuringPlay.ops,
        opsPerMinuteDuringPlay: Math.round((opsDuringPlay.ops / playMs) * 60_000),
        afterFlushPending: playback,
      });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
      delete process.env.SF_USER_DATA_PATH;
    }
  }, 600_000);
});
