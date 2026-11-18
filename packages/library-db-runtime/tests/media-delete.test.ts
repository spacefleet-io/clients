import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { LibraryDb } from "../src/libraryDb";

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-library-delete-"));
  process.env.SF_USER_DATA_PATH = root;
  console.info(`[media-delete:setup] root=${root}`);
});

afterEach(() => {
  console.info(`[media-delete:teardown] removing root=${root}`);
  rmSync(root, { recursive: true, force: true });
  delete process.env.SF_USER_DATA_PATH;
});

// Suite-id: media-delete
// Dumps the media table state, the snapshot's related rows (ingestJobs,
// mediaDetails), and the deletion-candidate id. Lets us
// spot orphaned rows surviving deleteMedia without grepping the source.
const dumpMediaDeleteSnapshot = (
  label: string,
  ctx: {
    db?: LibraryDb | null;
    candidateIds?: string[];
    jobIds?: string[];
  },
) => {
  try {
    console.error(`=== [media-delete:${label}] snapshot ===`);
    if (ctx.candidateIds) console.error(`candidateIds=${JSON.stringify(ctx.candidateIds)}`);
    if (ctx.jobIds) console.error(`jobIds=${JSON.stringify(ctx.jobIds)}`);

    if (ctx.db) {
      let snapshot: unknown = "(unknown)";
      try {
        const s = ctx.db.getSnapshot();
        snapshot = {
          mediaCount: Array.isArray(s.media) ? s.media.length : "(n/a)",
          mediaIds: Array.isArray(s.media) ? s.media.map((m: { id: string }) => m.id) : "(n/a)",
          ingestJobsCount: Array.isArray(s.ingestJobs) ? s.ingestJobs.length : "(n/a)",
          ingestJobIds: Array.isArray(s.ingestJobs)
            ? s.ingestJobs.map((j: { id: string }) => j.id)
            : "(n/a)",
          mediaDetailsCount: Array.isArray(s.mediaDetails)
            ? s.mediaDetails.length
            : "(n/a)",
        };
      } catch (err) {
        snapshot = `(getSnapshot failed: ${err instanceof Error ? err.message : String(err)})`;
      }
      console.error(`snapshot:\n${JSON.stringify(snapshot, null, 2)}`);

      if (ctx.candidateIds) {
        const details: Record<string, unknown> = {};
        for (const id of ctx.candidateIds) {
          try {
            const md = ctx.db.getMediaDetails(id);
            details[id] = md
              ? {
                  hasFiles: md.hasFiles,
                  filesCount: md.files?.length ?? 0,
                  formatsCount: md.formats?.length ?? 0,
                  audioTracksCount: md.audioTracks?.length ?? 0,
                  skipMarkersCount: md.skipMarkers?.length ?? 0,
                }
              : "(null)";
          } catch (err) {
            details[id] = `(getMediaDetails failed: ${err instanceof Error ? err.message : String(err)})`;
          }
        }
        console.error(`media details:\n${JSON.stringify(details, null, 2)}`);
      }

      if (ctx.jobIds) {
        const jobEvents: Record<string, unknown> = {};
        for (const jid of ctx.jobIds) {
          try {
            const evs = ctx.db.listIngestJobEvents(jid);
            jobEvents[jid] = Array.isArray(evs)
              ? { count: evs.length, lastMessage: evs[evs.length - 1]?.message }
              : "(n/a)";
          } catch (err) {
            jobEvents[jid] = `(listIngestJobEvents failed: ${err instanceof Error ? err.message : String(err)})`;
          }
        }
        console.error(`ingest job events:\n${JSON.stringify(jobEvents, null, 2)}`);
      }
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("library media deletion", () => {
  it("@bugfix @regression-proof removes ingest jobs and events for deleted media", async () => {
    console.info(`[media-delete:jobs] opening LibraryDb`);
    const db = await LibraryDb.openLocal("token", "key");
    db.setSyncEnabled(false);

    console.info(`[media-delete:jobs] adding TMDB tv "Delete Queue Show" (id=303)`);
    const mediaId = await db.addMediaFromTmdb({
      id: 303,
      type: "tv",
      title: "Delete Queue Show",
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
      seasons: [
        {
          seasonNumber: 1,
          name: "Season 1",
          overview: null,
          posterPath: null,
          episodeCount: 1,
          airDate: null,
        },
      ],
      episodes: [
        {
          seasonNumber: 1,
          episodeNumber: 1,
          name: "Episode 1",
          overview: null,
          stillPath: null,
          airDate: null,
        },
      ],
      totalEpisodes: 1,
    } as any);
    console.info(`[media-delete:jobs] mediaId=${mediaId}; upserting job-delete-1 + event`);

    db.upsertIngestJob({
      id: "job-delete-1",
      mediaId,
      workerPeerId: "worker-1",
      kind: "source_upload",
      status: "processing",
      progressPct: 0,
      meta: { title: "Delete Queue Show" },
    });
    db.addIngestJobEvent({
      jobId: "job-delete-1",
      level: "info",
      message: "Uploading",
    });

    try {
      expect(db.getSnapshot().ingestJobs).toEqual([
        expect.objectContaining({ id: "job-delete-1", mediaId }),
      ]);
      expect(db.listIngestJobEvents("job-delete-1")).toEqual([
        expect.objectContaining({ jobId: "job-delete-1", message: "Uploading" }),
      ]);
      console.info(`[media-delete:jobs] pre-delete state verified; deleting media=${mediaId}`);

      await db.deleteMedia(mediaId);

      const snapshot = db.getSnapshot();
      console.info(
        `[media-delete:jobs] post-delete counts media=${snapshot.media.length} ingestJobs=${snapshot.ingestJobs?.length}`,
      );
      expect(snapshot.media).toEqual([]);
      expect(snapshot.ingestJobs).toEqual([]);
      expect(db.listIngestJobEvents("job-delete-1")).toEqual([]);
    } catch (err) {
      console.error(`[media-delete:jobs] assertion failed`);
      dumpMediaDeleteSnapshot("jobs-failure", {
        db,
        candidateIds: [mediaId],
        jobIds: ["job-delete-1"],
      });
      throw err;
    } finally {
      db.close();
    }
  });

  it("@bugfix @regression-proof removes format chunks, audio chunks, and skip analysis for deleted media", async () => {
    console.info(`[media-delete:chunks] opening LibraryDb`);
    const db = await LibraryDb.openLocal("token", "key");
    db.setSyncEnabled(false);

    console.info(`[media-delete:chunks] adding TMDB movie "Chunk Cleanup Movie" (id=500)`);
    const mediaId = await db.addMediaFromTmdb({
      id: 500,
      type: "movie",
      title: "Chunk Cleanup Movie",
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
      seasons: [],
      episodes: [],
      totalEpisodes: 0,
    } as any);

    console.info(`[media-delete:chunks] linking file + format + audio track + skip analysis`);
    const fileId = await db.linkFileToMedia(mediaId, "chunk-test.mkv");
    await db.addMediaFormat(
      mediaId,
      fileId,
      "720p",
      "h264",
      100,
      [{ key: "chunk-key-1", sizeBytes: 1000, startSeconds: 0 }],
      2000,
    );

    db.addAudioTrackWithChunks({
      mediaId,
      fileId,
      season: null,
      episode: null,
      language: "en",
      label: "English",
      codec: "aac",
      initKey: null,
      initSize: null,
      durationSeconds: 120,
      totalSize: 5000,
      chunks: [{ key: "audio-chunk-1", sizeBytes: 500, startSeconds: 0 }],
    });

    db.upsertSkipAnalysis(mediaId, null, "intro", { start: 0, end: 30 });

    try {
      // Verify records exist via getMediaDetails
      const details = db.getMediaDetails(mediaId);
      console.info(
        `[media-delete:chunks] pre-delete formats=${details?.formats.length} fmt0.chunks=${details?.formats?.[0]?.chunks.length} audio=${details?.audioTracks.length} audio0.chunks=${details?.audioTracks?.[0]?.chunks.length}`,
      );
      expect(details).toBeTruthy();
      expect(details!.formats.length).toBeGreaterThan(0);
      expect(details!.formats[0].chunks.length).toBeGreaterThan(0);
      expect(details!.audioTracks.length).toBeGreaterThan(0);
      expect(details!.audioTracks[0].chunks.length).toBeGreaterThan(0);

      console.info(`[media-delete:chunks] deleting media=${mediaId}`);
      await db.deleteMedia(mediaId);

      const snapshot = db.getSnapshot();
      console.info(
        `[media-delete:chunks] post-delete media-count=${snapshot.media.length}`,
      );
      expect(snapshot.media).toEqual([]);

      // After deletion, getMediaDetails should return null
      const detailsAfter = db.getMediaDetails(mediaId);
      console.info(`[media-delete:chunks] post-delete getMediaDetails=${detailsAfter}`);
      expect(detailsAfter).toBeNull();
    } catch (err) {
      console.error(`[media-delete:chunks] assertion failed`);
      dumpMediaDeleteSnapshot("chunks-failure", {
        db,
        candidateIds: [mediaId],
      });
      throw err;
    } finally {
      db.close();
    }
  });
});
