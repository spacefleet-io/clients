import { describe, expect, it } from "vitest";
import { buildGhostLibraryItems, markMediaDeleted, pruneDeletedMediaIds } from "../src/renderer/src/lib/libraryGhosts";
import type { LabJob } from "../src/renderer/src/lib/labJobs";

const t = (key: string) => key;

// On assertion failure, dump the jobs/media inputs + computed ghost items so a
// ghost-suppression regression is diagnosable from CI alone (per "Tests log
// generously"). try/catch so a dump failure can't mask the real assertion.
const dumpGhostsSnapshot = (
  label: string,
  ctx: { jobs?: LabJob[]; media?: unknown[]; exclude?: Set<string>; items?: unknown },
) => {
  try {
    console.error(`=== [library-ghosts:${label}] snapshot ===`);
    console.error(
      `jobs=${JSON.stringify((ctx.jobs ?? []).map((j) => ({ id: j.id, status: j.status, matchedMediaId: j.matchedMediaId, matchedTo: j.matchedTo })))}`,
    );
    console.error(
      `media=${JSON.stringify((ctx.media ?? []).map((m) => ({ id: (m as { id?: string }).id, title: (m as { title?: string }).title, year: (m as { year?: string }).year, tmdbId: (m as { tmdbId?: number }).tmdbId })))}`,
    );
    if (ctx.exclude) console.error(`exclude=${JSON.stringify(Array.from(ctx.exclude))}`);
    console.error(`computed ghost items=${JSON.stringify(ctx.items, null, 2)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("buildGhostLibraryItems", () => {
  it("[@bugfix][@regression-proof] hides a ghost job when the matched title already exists in the library", () => {
    const jobs: LabJob[] = [
      {
        id: "job-1",
        filename: "/tmp/Lodgers - S01E01.mkv",
        status: "uploading",
        progress: 12,
        createdAt: "2026-03-20T10:00:00.000Z",
        matchedTo: {
          title: "Lodgers",
          year: "1994",
          posterPath: "/lodgers.jpg",
          type: "tv",
        },
      },
    ];
    const media = [
      {
        id: "media-1",
        type: "tv" as const,
        tmdbId: 901668,
        externalIds: { tmdb: 901668 },
        title: "Lodgers",
        originalTitle: "Lodgers",
        originalLanguage: "en",
        overview: null,
        year: "1994",
        rating: 8.4,
        posterPath: "/lodgers.jpg",
        backdropPath: null,
        genres: [],
        addedAt: "2026-03-20T09:59:00.000Z",
        updatedAt: "2026-03-20T09:59:00.000Z",
        hasFiles: false,
        progressPct: 0,
        lastWatchedAt: null,
        totalEpisodes: 236,
        episodeCount: 236,
      },
    ];

    console.info(`[library-ghosts:title-exists] 1 uploading job for "Lodgers" already in library; expecting 0 ghosts`);
    const items = buildGhostLibraryItems(jobs, media, t);
    if (items.length !== 0) {
      dumpGhostsSnapshot("title-exists", { jobs, media, items });
    }
    expect(items).toEqual([]);
  });

  it("[@bugfix][@regression-proof] excludes failed jobs from ghost items", () => {
    const jobs: LabJob[] = [
      {
        id: "job-failed",
        filename: "/tmp/Orphan.mkv",
        status: "failed",
        progress: 0,
        createdAt: "2026-03-20T10:00:00.000Z",
        matchedMediaId: "deleted-media-id",
        matchedTo: {
          title: "Orphan",
          year: "2009",
          posterPath: "/orphan.jpg",
          type: "movie",
        },
      },
    ];

    console.info(`[library-ghosts:failed-excluded] 1 failed job; expecting 0 ghosts`);
    const items = buildGhostLibraryItems(jobs, [], t);
    if (items.length !== 0) {
      dumpGhostsSnapshot("failed-excluded", { jobs, media: [], items });
    }
    expect(items).toEqual([]);
  });

  it("keeps a ghost job visible when the title is not in the library yet", () => {
    const jobs: LabJob[] = [
      {
        id: "job-2",
        filename: "/tmp/Orchard.mkv",
        status: "transcoding",
        progress: 40,
        createdAt: "2026-03-20T10:00:00.000Z",
        matchedTo: {
          title: "Orchard",
          year: "2017",
          posterPath: "/orchard.jpg",
          type: "movie",
        },
      },
    ];

    console.info(`[library-ghosts:title-absent] 1 transcoding job, empty library; expecting 1 visible ghost`);
    const items = buildGhostLibraryItems(jobs, [], t);
    if (items.length !== 1) {
      dumpGhostsSnapshot("title-absent", { jobs, media: [], items });
    }
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "job-2",
      title: "Orchard",
      type: "movie",
      progress: 40,
    });
  });

  it("[@bugfix][@regression-proof] suppresses ghosts for explicitly excluded media IDs", () => {
    const jobs: LabJob[] = [
      {
        id: "job-upload",
        filename: "/tmp/Breaking Bad - S01E01.mkv",
        status: "uploading",
        progress: 0,
        createdAt: "2026-03-20T10:00:00.000Z",
        matchedMediaId: "media-deleted",
        matchedTo: {
          title: "Breaking Bad",
          year: "2008",
          posterPath: "/bb.jpg",
          type: "tv",
        },
      },
    ];

    const exclude = new Set(["media-deleted"]);
    console.info(`[library-ghosts:excluded-ids] job matched to excluded media-deleted; expecting 0 ghosts`);
    const items = buildGhostLibraryItems(jobs, [], t, exclude);
    if (items.length !== 0) {
      dumpGhostsSnapshot("excluded-ids", { jobs, media: [], exclude, items });
    }
    expect(items).toEqual([]);
  });

  it("[@bugfix][@regression-proof] markMediaDeleted suppresses ghosts until pruned", () => {
    const jobs: LabJob[] = [
      {
        id: "job-stuck",
        filename: "/tmp/Dexter - S01E01.mkv",
        status: "uploading",
        progress: 0,
        createdAt: "2026-03-20T10:00:00.000Z",
        matchedMediaId: "media-dexter",
        matchedTo: {
          title: "Dexter",
          year: "2006",
          posterPath: "/dexter.jpg",
          type: "tv",
        },
      },
    ];

    // Before marking: job creates a ghost
    console.info(`[library-ghosts:mark-deleted] phase=before-mark expecting 1 ghost`);
    const before = buildGhostLibraryItems(jobs, [], t);
    if (before.length !== 1) dumpGhostsSnapshot("mark-deleted-before", { jobs, media: [], items: before });
    expect(before).toHaveLength(1);

    // After marking: ghost is suppressed
    console.info(`[library-ghosts:mark-deleted] phase=after-mark markMediaDeleted(media-dexter) expecting 0 ghosts`);
    markMediaDeleted("media-dexter");
    const afterMark = buildGhostLibraryItems(jobs, [], t);
    if (afterMark.length !== 0) dumpGhostsSnapshot("mark-deleted-after-mark", { jobs, media: [], items: afterMark });
    expect(afterMark).toEqual([]);

    // Prune with the job still referencing the media — stays suppressed
    console.info(`[library-ghosts:mark-deleted] phase=prune-with-ref pruneDeletedMediaIds(jobs) expecting still 0 ghosts`);
    pruneDeletedMediaIds(jobs);
    const afterPruneWithRef = buildGhostLibraryItems(jobs, [], t);
    if (afterPruneWithRef.length !== 0)
      dumpGhostsSnapshot("mark-deleted-prune-with-ref", { jobs, media: [], items: afterPruneWithRef });
    expect(afterPruneWithRef).toEqual([]);

    // Prune with no jobs referencing the media — deletion marker is cleaned up
    console.info(`[library-ghosts:mark-deleted] phase=prune-no-ref pruneDeletedMediaIds([]) expecting ghost restored (1)`);
    pruneDeletedMediaIds([]);
    const afterPruneNoRef = buildGhostLibraryItems(jobs, [], t);
    if (afterPruneNoRef.length !== 1)
      dumpGhostsSnapshot("mark-deleted-prune-no-ref", { jobs, media: [], items: afterPruneNoRef });
    expect(afterPruneNoRef).toHaveLength(1);
  });
});
