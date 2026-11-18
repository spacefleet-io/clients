import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { LibraryDb } from "../src/libraryDb";

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-skip-markers-"));
  process.env.SF_USER_DATA_PATH = root;
  console.info(`[skip-markers-runtime:setup] root=${root}`);
});

afterEach(() => {
  console.info(`[skip-markers-runtime:teardown] removing root=${root}`);
  rmSync(root, { recursive: true, force: true });
  delete process.env.SF_USER_DATA_PATH;
});

// Suite-id: skip-markers-runtime (disambiguates from the E2E suite of the
// same domain). Dumps the skip-marker table state per episode and the
// surrounding mediaDetails snapshot so cross-scope leaks are obvious.
const dumpSkipMarkersSnapshot = (
  label: string,
  ctx: {
    db?: LibraryDb | null;
    mediaIds?: string[];
    episodeIds?: (string | null)[];
  },
) => {
  try {
    console.error(`=== [skip-markers-runtime:${label}] snapshot ===`);
    if (ctx.mediaIds) console.error(`mediaIds=${JSON.stringify(ctx.mediaIds)}`);
    if (ctx.episodeIds) console.error(`episodeIds=${JSON.stringify(ctx.episodeIds)}`);

    if (ctx.db) {
      const perMedia: Record<string, unknown> = {};
      for (const mid of ctx.mediaIds ?? []) {
        try {
          const md = ctx.db.getMediaDetails(mid);
          perMedia[mid] = md
            ? {
                episodeIds: md.episodes.map((e) => ({ id: e.id, episodeNumber: e.episodeNumber })),
                skipMarkers: md.skipMarkers.map((m) => ({
                  episodeId: m.episodeId,
                  type: m.type,
                  startSeconds: m.startSeconds,
                  endSeconds: m.endSeconds,
                  source: m.source,
                  confidence: m.confidence,
                })),
              }
            : "(null)";
        } catch (err) {
          perMedia[mid] = `(getMediaDetails failed: ${err instanceof Error ? err.message : String(err)})`;
        }
      }
      console.error(`per-media details:\n${JSON.stringify(perMedia, null, 2)}`);

      let snapshotSummary: unknown = "(unknown)";
      try {
        const s = ctx.db.getSnapshot();
        snapshotSummary = {
          mediaDetailsCount: Array.isArray(s.mediaDetails) ? s.mediaDetails.length : "(n/a)",
          totalSkipMarkers: Array.isArray(s.mediaDetails)
            ? s.mediaDetails.reduce(
                (sum: number, md: { skipMarkers?: unknown[] }) =>
                  sum + (Array.isArray(md.skipMarkers) ? md.skipMarkers.length : 0),
                0,
              )
            : "(n/a)",
        };
      } catch (err) {
        snapshotSummary = `(getSnapshot failed: ${err instanceof Error ? err.message : String(err)})`;
      }
      console.error(`snapshot summary:\n${JSON.stringify(snapshotSummary, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("library skip markers", () => {
  it("persists skip markers in media details and snapshots", async () => {
    console.info(`[skip-markers-runtime:persist] opening LibraryDb`);
    const db = await LibraryDb.openLocal("token", "key");
    db.setSyncEnabled(false);

    console.info(`[skip-markers-runtime:persist] adding catalog tv "Skip Test Show" (id=101)`);
    const mediaId = await db.addMediaFromCatalog({
      id: 101,
      type: "tv",
      title: "Skip Test Show",
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

    const initialDetails = db.getMediaDetails(mediaId);
    const episodeId = initialDetails?.episodes[0]?.id ?? null;
    console.info(
      `[skip-markers-runtime:persist] mediaId=${mediaId} episodes.length=${initialDetails?.episodes.length} episodeId=${episodeId}`,
    );

    try {
      expect(initialDetails?.episodes).toHaveLength(1);
      expect(episodeId).toBeTruthy();

      console.info(
        `[skip-markers-runtime:persist] replaceSkipMarkers — intro + credits`,
      );
      db.replaceSkipMarkers(mediaId, episodeId, [
        { type: "intro", startSeconds: 12, endSeconds: 48, source: "internal", confidence: 0.93 },
        { type: "credits", startSeconds: 3180, endSeconds: 3285, source: "internal", confidence: 0.88 },
      ]);

      const details = db.getMediaDetails(mediaId);
      console.info(
        `[skip-markers-runtime:persist] post-write skipMarkers.length=${details?.skipMarkers.length}`,
      );
      expect(details?.skipMarkers).toEqual([
        expect.objectContaining({
          mediaId,
          episodeId,
          type: "intro",
          startSeconds: 12,
          endSeconds: 48,
          source: "internal",
          confidence: 0.93,
        }),
        expect.objectContaining({
          mediaId,
          episodeId,
          type: "credits",
          startSeconds: 3180,
          endSeconds: 3285,
          source: "internal",
          confidence: 0.88,
        }),
      ]);

      const snapshot = db.getSnapshot();
      console.info(
        `[skip-markers-runtime:persist] snapshot.mediaDetails[0].skipMarkers.length=${snapshot.mediaDetails?.[0]?.skipMarkers?.length}`,
      );
      expect(snapshot.mediaDetails?.[0]?.skipMarkers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "intro", episodeId }),
          expect.objectContaining({ type: "credits", episodeId }),
        ])
      );

      db.close();
      console.info(`[skip-markers-runtime:persist] db closed; reopening for persistence check`);

      const reopened = await LibraryDb.openLocal("token", "key");
      reopened.setSyncEnabled(false);
      try {
        const reopenedDetails = reopened.getMediaDetails(mediaId);
        console.info(
          `[skip-markers-runtime:persist] reopened skipMarkers.length=${reopenedDetails?.skipMarkers.length}`,
        );
        expect(reopenedDetails?.skipMarkers).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: "intro", episodeId }),
            expect.objectContaining({ type: "credits", episodeId }),
          ])
        );
      } catch (err) {
        console.error(`[skip-markers-runtime:persist] reopened assertion failed`);
        dumpSkipMarkersSnapshot("persist-failure-reopened", {
          db: reopened,
          mediaIds: [mediaId],
          episodeIds: [episodeId],
        });
        reopened.close();
        throw err;
      }
      reopened.close();
    } catch (err) {
      console.error(`[skip-markers-runtime:persist] assertion failed`);
      try {
        dumpSkipMarkersSnapshot("persist-failure", {
          db,
          mediaIds: [mediaId],
          episodeIds: [episodeId],
        });
      } catch {
        // db may already be closed
      }
      throw err;
    }
  });

  it("replaces markers within one scope without touching other episode scopes", async () => {
    console.info(`[skip-markers-runtime:scope] opening LibraryDb`);
    const db = await LibraryDb.openLocal("token", "key");
    db.setSyncEnabled(false);

    console.info(`[skip-markers-runtime:scope] adding catalog tv "Scoped Skip Show" (id=202)`);
    const mediaId = await db.addMediaFromCatalog({
      id: 202,
      type: "tv",
      title: "Scoped Skip Show",
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
          episodeCount: 2,
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
        {
          seasonNumber: 1,
          episodeNumber: 2,
          name: "Episode 2",
          overview: null,
          stillPath: null,
          airDate: null,
        },
      ],
      totalEpisodes: 2,
    } as any);

    const details = db.getMediaDetails(mediaId);
    const episodeOneId = details?.episodes.find((episode) => episode.episodeNumber === 1)?.id ?? null;
    const episodeTwoId = details?.episodes.find((episode) => episode.episodeNumber === 2)?.id ?? null;
    console.info(
      `[skip-markers-runtime:scope] mediaId=${mediaId} episodeOne=${episodeOneId} episodeTwo=${episodeTwoId}`,
    );

    try {
      expect(episodeOneId).toBeTruthy();
      expect(episodeTwoId).toBeTruthy();

      console.info(`[skip-markers-runtime:scope] writing intro on ep1`);
      db.replaceSkipMarkers(mediaId, episodeOneId, [
        { type: "intro", startSeconds: 10, endSeconds: 40, source: "internal" },
      ]);
      console.info(`[skip-markers-runtime:scope] writing intro on ep2`);
      db.replaceSkipMarkers(mediaId, episodeTwoId, [
        { type: "intro", startSeconds: 11, endSeconds: 41, source: "internal" },
      ]);
      console.info(`[skip-markers-runtime:scope] REPLACING ep1 with credits (intro should be gone)`);
      db.replaceSkipMarkers(mediaId, episodeOneId, [
        { type: "credits", startSeconds: 3000, endSeconds: 3100, source: "internal" },
      ]);

      const updatedDetails = db.getMediaDetails(mediaId);
      console.info(
        `[skip-markers-runtime:scope] post-write skipMarkers=${JSON.stringify(updatedDetails?.skipMarkers.map((m) => ({ episodeId: m.episodeId, type: m.type })))}`,
      );
      expect(updatedDetails?.skipMarkers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ episodeId: episodeOneId, type: "credits" }),
          expect.objectContaining({ episodeId: episodeTwoId, type: "intro" }),
        ])
      );
      expect(updatedDetails?.skipMarkers).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ episodeId: episodeOneId, type: "intro" })])
      );
    } catch (err) {
      console.error(`[skip-markers-runtime:scope] assertion failed`);
      dumpSkipMarkersSnapshot("scope-failure", {
        db,
        mediaIds: [mediaId],
        episodeIds: [episodeOneId, episodeTwoId],
      });
      throw err;
    } finally {
      db.close();
    }
  });
});
