/**
 * Handler tests for the five `badger.offline.*` commands. The handlers
 * orchestrate over EngineV2 + BadgerLibraryDbService + the offline deps
 * registry; the tests stub all three.
 *
 * Tests log generously: every test emits phase markers
 * and dumps a snapshot on failure.
 */

import { mkdtempSync, rmSync, promises as fsAsync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createBadgerOfflineEstimateHandler,
  createBadgerOfflineSubmitHandler,
  createBadgerOfflineDeleteHandler,
  createBadgerOfflineListHandler,
  createBadgerOfflineReconcileHandler,
  type BadgerOfflineHandlerDeps,
} from "../src/modules/badger/offlineDownload";
import type { BadgerLibraryDbService } from "../src/modules/badgerLibraryDb";
import type { EngineV2 } from "../src/core/jobs/engineV2";
import type { IngestJobRecord } from "@space/runtime-jobs";

const SUITE = "badger-offline-handlers";

const dump = (label: string, ctx: Record<string, unknown> = {}) => {
  try {
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    for (const [key, value] of Object.entries(ctx)) {
      console.error(`${key}:\n${JSON.stringify(value, null, 2)}`);
    }
    console.error(`=== [${SUITE}:${label}] end snapshot ===`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

// ---------------------------------------------------------------------------
// Stub builders. We deliberately type these as the bare interfaces from the
// production code; `vi.fn()` carries the call history.
// ---------------------------------------------------------------------------

interface MockLibraryDbState {
  open: boolean;
  mediaDetails: Map<string, Record<string, unknown>>;
  localRows: Array<{
    id: string;
    fileId: string;
    mediaId: string;
    quality: string;
    formatId: string;
    container: string;
    localPath: string;
    totalBytes: number;
    downloadedAt: string;
    lastVerifiedAt: string | null;
    runtimeJobId: string | null;
  }>;
  registerCalls: Array<Record<string, unknown>>;
  dropCalls: Array<Record<string, unknown>>;
  touchCalls: Array<{ fileIds: string[]; verifiedAt: string }>;
}

const buildMockLibraryDb = (state: MockLibraryDbState): BadgerLibraryDbService => {
  return {
    isOpen: () => state.open,
    call: vi.fn(async (method: string, args: unknown[]) => {
      if (method === "getMediaDetails") {
        const mediaId = String(args[0]);
        return state.mediaDetails.get(mediaId) ?? null;
      }
      throw new Error(`Mock unsupported method: ${method}`);
    }),
    listLocalDownloads: vi.fn(async (mediaIds?: string[]) => {
      if (mediaIds && mediaIds.length > 0) {
        const filterSet = new Set(mediaIds);
        return state.localRows.filter((r) => filterSet.has(r.mediaId));
      }
      return [...state.localRows];
    }),
    registerLocalDownload: vi.fn(async (input: Record<string, unknown>) => {
      state.registerCalls.push(input);
      state.localRows.push({
        id: String(input.id),
        fileId: String(input.fileId),
        mediaId: String(input.mediaId),
        quality: String(input.quality),
        formatId: String(input.formatId),
        container: String(input.container),
        localPath: String(input.localPath),
        totalBytes: Number(input.totalBytes),
        downloadedAt: String(input.downloadedAt),
        lastVerifiedAt: null,
        runtimeJobId: input.runtimeJobId === null ? null : String(input.runtimeJobId),
      });
      return { inserted: 1 };
    }),
    dropLocalDownloads: vi.fn(async (scope: Record<string, unknown>) => {
      state.dropCalls.push(scope);
      let removed = 0;
      if (scope.type === "media") {
        const before = state.localRows.length;
        state.localRows = state.localRows.filter((r) => r.mediaId !== scope.mediaId);
        removed = before - state.localRows.length;
      } else if (scope.type === "file") {
        const before = state.localRows.length;
        state.localRows = state.localRows.filter((r) => r.fileId !== scope.fileId);
        removed = before - state.localRows.length;
      } else if (scope.type === "files") {
        const fileIds = scope.fileIds as string[];
        const before = state.localRows.length;
        state.localRows = state.localRows.filter((r) => !fileIds.includes(r.fileId));
        removed = before - state.localRows.length;
      }
      return { deleted: removed };
    }),
    touchLocalDownloadsVerified: vi.fn(async (fileIds: string[], verifiedAt: string) => {
      state.touchCalls.push({ fileIds, verifiedAt });
      const idSet = new Set(fileIds);
      let touched = 0;
      for (const row of state.localRows) {
        if (idSet.has(row.fileId)) {
          row.lastVerifiedAt = verifiedAt;
          touched += 1;
        }
      }
      return { touched };
    }),
  } as unknown as BadgerLibraryDbService;
};

interface MockEngineState {
  jobs: IngestJobRecord[];
  submitCalls: Array<IngestJobRecord>;
  cancelCalls: Array<{ jobId: string; reason: string }>;
}

const buildMockEngine = (state: MockEngineState): EngineV2 => {
  return {
    submit: vi.fn(async (job: IngestJobRecord) => {
      state.submitCalls.push(job);
      state.jobs.push(job);
      return { jobId: job.jobId };
    }),
    cancel: vi.fn(async (jobId: string, reason: string) => {
      state.cancelCalls.push({ jobId, reason });
      // Mark the job as cancelled in our state.
      const idx = state.jobs.findIndex((j) => j.jobId === jobId);
      if (idx >= 0) {
        state.jobs[idx] = { ...state.jobs[idx], status: "cancelled" };
      }
      return { cancelledIds: [jobId] };
    }),
    list: vi.fn(async () => ({ jobs: [...state.jobs], maxEventId: 0 })),
    get: vi.fn(async (jobId: string) => {
      const job = state.jobs.find((j) => j.jobId === jobId);
      if (!job) return null;
      return { job, steps: [] };
    }),
    start: vi.fn(),
    stop: vi.fn(),
    updateJobPayload: vi.fn(),
    dismiss: vi.fn(),
    retry: vi.fn(),
    getByDedupe: vi.fn(),
    registerHandler: vi.fn(),
    subscribe: vi.fn(),
    setLaneCaps: vi.fn(),
  } as unknown as EngineV2;
};

const buildDeps = (overrides: Partial<BadgerOfflineHandlerDeps> & {
  libraryDb: BadgerLibraryDbService;
  engine: EngineV2;
  offlineRoot: string;
}): BadgerOfflineHandlerDeps => ({
  engine: overrides.engine,
  libraryDb: overrides.libraryDb,
  resolveToken: overrides.resolveToken ?? (() => "test-token"),
  resolveLibraryKey: overrides.resolveLibraryKey ?? (() => "test-key-base64"),
  resolveOfflineDir:
    overrides.resolveOfflineDir ??
    ((libraryId: string) => joinPath(overrides.offlineRoot, libraryId)),
  resolveLibraryId: overrides.resolveLibraryId,
});

// ---------------------------------------------------------------------------
// Shared media-details fixtures.
// ---------------------------------------------------------------------------

// TV show fixture with 3 episodes across 2 seasons. Used by the season-scope
// delete tests and the fileIds narrow-scope estimate/submit tests.
//   - S1E1 → file-s1e1, format-s1e1-1080p
//   - S1E2 → file-s1e2, format-s1e2-1080p
//   - S2E1 → file-s2e1, format-s2e1-1080p
const fixtureShowDetailsThreeEpisodes = () => ({
  id: "media-show-1",
  title: "Test Show",
  year: "2026",
  type: "tv",
  files: [
    { id: "file-s1e1", filename: "s1e1.mkv", season: 1, episode: 1 },
    { id: "file-s1e2", filename: "s1e2.mkv", season: 1, episode: 2 },
    { id: "file-s2e1", filename: "s2e1.mkv", season: 2, episode: 1 },
  ],
  formats: [
    {
      id: "format-s1e1-1080p",
      fileId: "file-s1e1",
      quality: "1080p",
      initKey: "s1e1-init",
      initSize: 100,
      chunks: [{ key: "s1e1-chunk-0", sizeBytes: 1000, startSeconds: null }],
    },
    {
      id: "format-s1e2-1080p",
      fileId: "file-s1e2",
      quality: "1080p",
      initKey: "s1e2-init",
      initSize: 100,
      chunks: [{ key: "s1e2-chunk-0", sizeBytes: 1000, startSeconds: null }],
    },
    {
      id: "format-s2e1-1080p",
      fileId: "file-s2e1",
      quality: "1080p",
      initKey: "s2e1-init",
      initSize: 100,
      chunks: [{ key: "s2e1-chunk-0", sizeBytes: 1000, startSeconds: null }],
    },
  ],
  audioTracks: [],
  subtitleTracks: [],
  episodes: [
    { id: "ep-1-1", seasonNumber: 1, episodeNumber: 1, name: "S1E1" },
    { id: "ep-1-2", seasonNumber: 1, episodeNumber: 2, name: "S1E2" },
    { id: "ep-2-1", seasonNumber: 2, episodeNumber: 1, name: "S2E1" },
  ],
});

const fixtureMovieDetails = () => ({
  id: "media-movie-1",
  title: "Test Movie",
  year: "2026",
  type: "movie",
  files: [
    { id: "file-movie-1", filename: "/disk/movie.mkv", season: null, episode: null },
  ],
  formats: [
    {
      id: "format-1080",
      fileId: "file-movie-1",
      quality: "1080p",
      initKey: "movie-1080-init",
      initSize: 1024,
      chunks: [
        { key: "movie-1080-chunk-0", sizeBytes: 4096, startSeconds: null },
        { key: "movie-1080-chunk-1", sizeBytes: 4096, startSeconds: null },
      ],
    },
    {
      id: "format-720",
      fileId: "file-movie-1",
      quality: "720p",
      initKey: "movie-720-init",
      initSize: 1024,
      chunks: [
        { key: "movie-720-chunk-0", sizeBytes: 2048, startSeconds: null },
      ],
    },
  ],
  audioTracks: [
    {
      id: "audio-eng",
      fileId: "file-movie-1",
      language: "eng",
      label: "English",
      isDefault: true,
      initKey: "audio-eng-init",
      initSize: 512,
      chunks: [{ key: "audio-eng-chunk-0", sizeBytes: 1024, startSeconds: null }],
    },
  ],
  subtitleTracks: [
    {
      id: "sub-eng-srt",
      fileId: "file-movie-1",
      language: "eng",
      label: "English",
      objectKey: "sub-eng-srt-key",
      format: "srt",
      isDefault: true,
    },
    {
      id: "sub-fre-ass",
      fileId: "file-movie-1",
      language: "fre",
      label: "French",
      objectKey: "sub-fre-ass-key",
      format: "ass",
      isDefault: false,
    },
  ],
  episodes: [],
});

describe(SUITE, () => {
  let tempRoot: string;
  let libState: MockLibraryDbState;
  let engineState: MockEngineState;
  let libraryDb: BadgerLibraryDbService;
  let engine: EngineV2;

  beforeEach(() => {
    tempRoot = mkdtempSync(joinPath(tmpdir(), "spacefleet-offline-handlers-"));
    libState = {
      open: true,
      mediaDetails: new Map(),
      localRows: [],
      registerCalls: [],
      dropCalls: [],
      touchCalls: [],
    };
    engineState = { jobs: [], submitCalls: [], cancelCalls: [] };
    libraryDb = buildMockLibraryDb(libState);
    engine = buildMockEngine(engineState);
    console.info(`[${SUITE}:setup] tempRoot=${tempRoot}`);
  });

  afterEach(() => {
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[${SUITE}:teardown] rmSync failed:`, err);
    }
  });

  // -------------------------------------------------------------------------
  // estimate_size
  // -------------------------------------------------------------------------

  describe("estimate", () => {
    it("returns per-item bytes + filename + alreadyLocal=false for a fresh movie", async () => {
      console.info(`[${SUITE}:estimate-fresh-movie] start`);
      libState.mediaDetails.set("media-movie-1", fixtureMovieDetails());
      const deps = buildDeps({ libraryDb, engine, offlineRoot: tempRoot });
      const handler = createBadgerOfflineEstimateHandler(deps);

      const result = await handler({
        mediaIds: ["media-movie-1"],
        quality: "1080p",
        container: "mkv",
      });
      try {
        expect(result.items).toHaveLength(1);
        expect(result.items[0].mediaId).toBe("media-movie-1");
        expect(result.items[0].fileId).toBe("file-movie-1");
        expect(result.items[0].selectedQuality).toBe("1080p");
        expect(result.items[0].alreadyLocal).toBe(false);
        expect(result.items[0].expectedFilename).toBe("Test Movie (2026).mkv");
        // 1024 (init) + 4096*2 (chunks) = 9216
        expect(result.items[0].videoBytes).toBe(1024 + 4096 * 2);
        // audio: 512 + 1024 = 1536
        expect(result.items[0].audioBytes).toBe(512 + 1024);
        // 2 subs * 10 KB each
        expect(result.items[0].subtitleBytes).toBe(20 * 1024);
        expect(result.items[0].skippedSubsForContainer).toEqual([]);
        expect(result.sufficientSpace).toBe(true);
        expect(result.totalBytes).toBe(
          result.items[0].videoBytes + result.items[0].audioBytes + result.items[0].subtitleBytes
        );
      } catch (err) {
        dump("estimate-fresh-movie", { result });
        throw err;
      }
    });

    it("falls back to best ≤ preferred when the exact quality is unavailable", async () => {
      console.info(`[${SUITE}:estimate-fallback] start`);
      libState.mediaDetails.set("media-movie-1", fixtureMovieDetails());
      const deps = buildDeps({ libraryDb, engine, offlineRoot: tempRoot });
      const handler = createBadgerOfflineEstimateHandler(deps);

      // 2160p preferred — fixture only has 1080p + 720p, so 1080p is the
      // best <= preferred.
      const result = await handler({
        mediaIds: ["media-movie-1"],
        quality: "2160p",
        container: "mkv",
      });
      try {
        expect(result.items[0].selectedQuality).toBe("1080p");
      } catch (err) {
        dump("estimate-fallback", { result });
        throw err;
      }
    });

    // @req OFFL-QUAL-01[runtime,badger-desktop]
    it("OFFL-QUAL-01 lists every quality with its size; no pick = highest; a pick downloads that quality", async () => {
      console.info(`[${SUITE}:OFFL-QUAL-01 choices] start`);
      libState.mediaDetails.set("media-movie-1", fixtureMovieDetails());
      const deps = buildDeps({ libraryDb, engine, offlineRoot: tempRoot });
      const handler = createBadgerOfflineEstimateHandler(deps);

      const unpicked = await handler({ mediaIds: ["media-movie-1"], container: "mkv" });
      const picked = await handler({ mediaIds: ["media-movie-1"], quality: "720p", container: "mkv" });
      console.info(`[${SUITE}:OFFL-QUAL-01 choices] unpicked`, JSON.stringify({ choices: unpicked.qualityChoices, prompt: unpicked.prompt, q: unpicked.items[0]?.selectedQuality }));
      console.info(`[${SUITE}:OFFL-QUAL-01 choices] picked`, JSON.stringify({ q: picked.items[0]?.selectedQuality, total: picked.totalBytes }));
      try {
        const extra = 512 + 1024 + 20 * 1024;
        expect(unpicked.prompt).toBe(true);
        expect(unpicked.qualityChoices).toEqual([
          { quality: "1080p", totalBytes: 1024 + 4096 * 2 + extra, fallbacks: [] },
          { quality: "720p", totalBytes: 1024 + 2048 + extra, fallbacks: [] },
        ]);
        expect(unpicked.items[0].selectedQuality).toBe("1080p");
        expect(unpicked.totalBytes).toBe(unpicked.qualityChoices[0].totalBytes);
        expect(picked.items[0].selectedQuality).toBe("720p");
        expect(picked.totalBytes).toBe(unpicked.qualityChoices[1].totalBytes);
      } catch (err) {
        dump("OFFL-QUAL-01 choices", { unpicked, picked });
        throw err;
      }
    });

    // @req OFFL-QUAL-01[runtime,badger-desktop]
    it("OFFL-QUAL-01 single quality: no prompt", async () => {
      const fixture = fixtureMovieDetails();
      fixture.formats = fixture.formats.filter((f) => f.quality === "720p");
      libState.mediaDetails.set("media-movie-1", fixture);
      const handler = createBadgerOfflineEstimateHandler(buildDeps({ libraryDb, engine, offlineRoot: tempRoot }));
      const result = await handler({ mediaIds: ["media-movie-1"], container: "mkv" });
      console.info(`[${SUITE}:OFFL-QUAL-01 single]`, JSON.stringify({ choices: result.qualityChoices, prompt: result.prompt }));
      expect(result.prompt).toBe(false);
      expect(result.qualityChoices.map((c) => c.quality)).toEqual(["720p"]);
      expect(result.items[0].selectedQuality).toBe("720p");
    });

    // @req OFFL-QUAL-01[runtime,badger-desktop]
    it("OFFL-QUAL-01 season batch: one set of choices; episodes without the pick get the nearest lower, counted", async () => {
      const fixture = fixtureShowDetailsThreeEpisodes();
      // s1e1: 1080p + 720p; s1e2: 480p only; s2e1: 1080p only. Pick 720p → s1e1 720p, s1e2 480p (nearest lower), s2e1 1080p (nearest higher).
      fixture.formats = [
        fixture.formats[0]!,
        { ...fixture.formats[0]!, id: "format-s1e1-720p", quality: "720p", chunks: [{ key: "s1e1-720-chunk-0", sizeBytes: 500, startSeconds: null }] },
        { ...fixture.formats[1]!, id: "format-s1e2-480p", quality: "480p", chunks: [{ key: "s1e2-480-chunk-0", sizeBytes: 200, startSeconds: null }] },
        fixture.formats[2]!,
      ];
      libState.mediaDetails.set("media-show-1", fixture);
      const handler = createBadgerOfflineEstimateHandler(buildDeps({ libraryDb, engine, offlineRoot: tempRoot }));
      const fileIds = ["file-s1e1", "file-s1e2", "file-s2e1"];
      const unpicked = await handler({ mediaIds: ["media-show-1"], container: "mkv", fileIds });
      const picked = await handler({ mediaIds: ["media-show-1"], quality: "720p", container: "mkv", fileIds });
      console.info(`[${SUITE}:OFFL-QUAL-01 batch] choices`, JSON.stringify(unpicked.qualityChoices));
      console.info(`[${SUITE}:OFFL-QUAL-01 batch] picked`, JSON.stringify(picked.items.map((i) => [i.fileId, i.selectedQuality])));
      try {
        expect(unpicked.prompt).toBe(true);
        expect(unpicked.qualityChoices.map((c) => c.quality)).toEqual(["1080p", "720p", "480p"]);
        expect(unpicked.qualityChoices[1]).toEqual({
          quality: "720p",
          totalBytes: 600 + 300 + 1100,
          fallbacks: [
            { quality: "1080p", count: 1 },
            { quality: "480p", count: 1 },
          ],
        });
        expect(picked.items.map((i) => [i.fileId, i.selectedQuality])).toEqual([
          ["file-s1e1", "720p"],
          ["file-s1e2", "480p"],
          ["file-s2e1", "1080p"],
        ]);
        expect(picked.totalBytes).toBe(unpicked.qualityChoices[1].totalBytes);
      } catch (err) {
        dump("OFFL-QUAL-01 batch", { unpicked, picked });
        throw err;
      }
    });

    it("MP4 mode flags ASS subs in skippedSubsForContainer", async () => {
      console.info(`[${SUITE}:estimate-mp4-skips-ass] start`);
      libState.mediaDetails.set("media-movie-1", fixtureMovieDetails());
      const deps = buildDeps({ libraryDb, engine, offlineRoot: tempRoot });
      const handler = createBadgerOfflineEstimateHandler(deps);

      const result = await handler({
        mediaIds: ["media-movie-1"],
        quality: "1080p",
        container: "mp4",
      });
      try {
        expect(result.items[0].skippedSubsForContainer).toEqual(["fre"]);
        // Only SRT counted in subtitleBytes (10 KB), not the 2 * 10 KB the
        // MKV path counted.
        expect(result.items[0].subtitleBytes).toBe(10 * 1024);
      } catch (err) {
        dump("estimate-mp4-skips-ass", { result });
        throw err;
      }
    });

    it("marks already-local items via the listLocalDownloads bookkeeping", async () => {
      console.info(`[${SUITE}:estimate-already-local] start`);
      libState.mediaDetails.set("media-movie-1", fixtureMovieDetails());
      libState.localRows.push({
        id: "local-1",
        fileId: "file-movie-1",
        mediaId: "media-movie-1",
        quality: "1080p",
        formatId: "format-1080",
        container: "mkv",
        localPath: "/disk/offline/Test Movie (2026).mkv",
        totalBytes: 9216,
        downloadedAt: "2026-01-01T00:00:00.000Z",
        lastVerifiedAt: null,
        runtimeJobId: null,
      });
      const deps = buildDeps({ libraryDb, engine, offlineRoot: tempRoot });
      const handler = createBadgerOfflineEstimateHandler(deps);

      const result = await handler({
        mediaIds: ["media-movie-1"],
        quality: "1080p",
        container: "mkv",
      });
      try {
        expect(result.items[0].alreadyLocal).toBe(true);
        // totalBytes counts only NOT-yet-local items.
        expect(result.totalBytes).toBe(0);
      } catch (err) {
        dump("estimate-already-local", { result });
        throw err;
      }
    });

    it("reports skipped media for unavailable qualities", async () => {
      console.info(`[${SUITE}:estimate-no-quality] start`);
      const fixture = fixtureMovieDetails();
      // Empty out formats — no quality to match.
      fixture.formats = [];
      libState.mediaDetails.set("media-movie-1", fixture);
      const deps = buildDeps({ libraryDb, engine, offlineRoot: tempRoot });
      const handler = createBadgerOfflineEstimateHandler(deps);

      const result = await handler({
        mediaIds: ["media-movie-1"],
        quality: "1080p",
        container: "mkv",
      });
      try {
        expect(result.items).toHaveLength(0);
        expect(result.skipped).toEqual([
          { mediaId: "media-movie-1", reason: "no-quality-available" },
        ]);
      } catch (err) {
        dump("estimate-no-quality", { result });
        throw err;
      }
    });

    it("fileIds narrow-scope filter restricts the estimate to the listed files", async () => {
      console.info(`[${SUITE}:estimate-fileids-narrow-scope] start`);
      // TV show with 3 files — estimate fileIds=[file-s1e1, file-s2e1]
      // (cross-season subset). Expect 2 items, exactly those fileIds.
      libState.mediaDetails.set("media-show-1", fixtureShowDetailsThreeEpisodes());
      const deps = buildDeps({ libraryDb, engine, offlineRoot: tempRoot });
      const handler = createBadgerOfflineEstimateHandler(deps);

      const result = await handler({
        mediaIds: ["media-show-1"],
        quality: "1080p",
        container: "mkv",
        fileIds: ["file-s1e1", "file-s2e1"],
      });
      try {
        const itemFileIds = result.items.map((i) => i.fileId).sort();
        console.info("[estimate-fileids-narrow-scope] item fileIds", itemFileIds);
        expect(itemFileIds).toEqual(["file-s1e1", "file-s2e1"]);
        // file-s1e2 must NOT appear.
        expect(itemFileIds).not.toContain("file-s1e2");
        // No "skipped" rows for the excluded file — narrow-scope is silent.
        expect(result.skipped).toEqual([]);
      } catch (err) {
        dump("estimate-fileids-narrow-scope", { result });
        throw err;
      }
    });

    it("empty fileIds array behaves like no filter (defensive)", async () => {
      console.info(`[${SUITE}:estimate-fileids-empty] start`);
      // Defensive: an inadvertent `fileIds: []` should not silently
      // produce zero items — falls back to legacy single-file behaviour.
      libState.mediaDetails.set("media-movie-1", fixtureMovieDetails());
      const deps = buildDeps({ libraryDb, engine, offlineRoot: tempRoot });
      const handler = createBadgerOfflineEstimateHandler(deps);

      const result = await handler({
        mediaIds: ["media-movie-1"],
        quality: "1080p",
        container: "mkv",
        fileIds: [],
      });
      try {
        expect(result.items).toHaveLength(1);
        expect(result.items[0].fileId).toBe("file-movie-1");
      } catch (err) {
        dump("estimate-fileids-empty", { result });
        throw err;
      }
    });
  });

  // -------------------------------------------------------------------------
  // download_submit
  // -------------------------------------------------------------------------

  describe("submit", () => {
    it("submits one engine job per non-already-local item", async () => {
      console.info(`[${SUITE}:submit-fresh] start`);
      libState.mediaDetails.set("media-movie-1", fixtureMovieDetails());
      const deps = buildDeps({ libraryDb, engine, offlineRoot: tempRoot });
      const handler = createBadgerOfflineSubmitHandler(deps);

      const result = await handler({
        mediaIds: ["media-movie-1"],
        quality: "1080p",
        container: "mkv",
        skipAlreadyLocal: true,
      });
      try {
        if ("errorCode" in result) {
          throw new Error(`expected success, got error ${JSON.stringify(result)}`);
        }
        expect(result.submitted).toHaveLength(1);
        expect(result.submitted[0].mediaId).toBe("media-movie-1");
        expect(result.submitted[0].fileId).toBe("file-movie-1");
        expect(result.submitted[0].groupId).toBe("media-movie-1");

        expect(engineState.submitCalls).toHaveLength(1);
        const job = engineState.submitCalls[0];
        expect(job.kind).toBe("download");
        expect(job.lane).toBe("upload");
        const p = job.payload as Record<string, unknown>;
        expect(p.fileId).toBe("file-movie-1");
        expect(p.quality).toBe("1080p");
        expect(p.formatId).toBe("format-1080");
        expect(p.container).toBe("mkv");
        // @req RT-SEC-05[runtime] the engine persists the payload: no token and no library key in it
        expect(p).not.toHaveProperty("token");
        expect(p).not.toHaveProperty("libraryKeyBase64");
        expect(JSON.stringify(job)).not.toContain("test-key-base64");
        expect(JSON.stringify(job)).not.toContain("test-token");
        expect(typeof (p.manifest as Record<string, unknown>).videoChunks).toBe("object");
      } catch (err) {
        dump("submit-fresh", { result, engineState });
        throw err;
      }
    });

    // @req OFFL-QUAL-01[runtime,badger-desktop]
    it("OFFL-QUAL-01 submit downloads the quality picked in the prompt", async () => {
      libState.mediaDetails.set("media-movie-1", fixtureMovieDetails());
      const handler = createBadgerOfflineSubmitHandler(buildDeps({ libraryDb, engine, offlineRoot: tempRoot }));
      const result = await handler({ mediaIds: ["media-movie-1"], quality: "720p", container: "mkv", skipAlreadyLocal: true });
      const p = engineState.submitCalls[0]?.payload as Record<string, unknown> | undefined;
      console.info(`[${SUITE}:OFFL-QUAL-01 submit]`, JSON.stringify({ result, quality: p?.quality, formatId: p?.formatId }));
      expect("errorCode" in result).toBe(false);
      expect(p?.quality).toBe("720p");
      expect(p?.formatId).toBe("format-720");
    });

    // @bugfix offline-download-job-uuid-label-2026-06-04
    // @regression-proof The jobs sidebar showed raw UUIDs for offline-save jobs.
    // The submit handler now stamps payload.filename (friendly, ext-stripped) +
    // payload.hints (season/episode) so NEW download jobs are self-describing for
    // the sidebar adapter without needing the manifest fallback.
    it("[@bugfix][@regression-proof] stamps a friendly payload.filename for a MOVIE job (no hints)", async () => {
      console.info(`[${SUITE}:submit-stamp-movie] start`);
      libState.mediaDetails.set("media-movie-1", fixtureMovieDetails());
      const deps = buildDeps({ libraryDb, engine, offlineRoot: tempRoot });
      const handler = createBadgerOfflineSubmitHandler(deps);
      const result = await handler({
        mediaIds: ["media-movie-1"],
        quality: "1080p",
        container: "mkv",
        skipAlreadyLocal: true,
      });
      try {
        if ("errorCode" in result) throw new Error(`expected success, got ${JSON.stringify(result)}`);
        const p = engineState.submitCalls[0].payload as Record<string, unknown>;
        // Friendly label = expectedFilename ("Test Movie (2026).mkv") minus the ".mkv".
        expect(p.filename).toBe("Test Movie (2026)");
        expect(p.hints).toBeUndefined(); // movies carry no S/E hints
      } catch (err) {
        dump("submit-stamp-movie", { result, engineState });
        throw err;
      }
    });

    it("[@bugfix][@regression-proof] stamps a friendly payload.filename + S/E hints for a TV EPISODE job", async () => {
      console.info(`[${SUITE}:submit-stamp-tv] start`);
      libState.mediaDetails.set("media-show-1", fixtureShowDetailsThreeEpisodes());
      const deps = buildDeps({ libraryDb, engine, offlineRoot: tempRoot });
      const handler = createBadgerOfflineSubmitHandler(deps);
      const result = await handler({
        mediaIds: ["media-show-1"],
        fileIds: ["file-s1e1"], // narrow-scope to S01E01
        quality: "1080p",
        container: "mkv",
        skipAlreadyLocal: true,
      });
      try {
        if ("errorCode" in result) throw new Error(`expected success, got ${JSON.stringify(result)}`);
        const p = engineState.submitCalls[0].payload as Record<string, unknown>;
        expect(p.filename).toBe("Test Show - S01E01 - S1E1");
        expect(p.hints).toEqual({ season: 1, episode: 1 });
      } catch (err) {
        dump("submit-stamp-tv", { result, engineState });
        throw err;
      }
    });

    it("returns insufficient_disk_space when free bytes are below required + safety margin", async () => {
      console.info(`[${SUITE}:submit-insufficient-disk] start`);
      libState.mediaDetails.set("media-movie-1", fixtureMovieDetails());
      // Override resolveOfflineDir to a fake path with negligible free bytes
      // by returning a non-existent path; statfs will fall back to a parent
      // that DOES exist, but we can simulate "no space" by spying on
      // statfsSync. Simplest path: make the offline dir non-existent and
      // mock the deps to return 0 free bytes via a custom statfs wrapper —
      // but our handler uses node:fs's statfsSync directly. We can't easily
      // monkey-patch fs from a test, so instead simulate "no space" by
      // making expectedBytes huge via a manifest with massive chunks.
      const fixture = fixtureMovieDetails();
      // Inflate the chunk size so the requirement exceeds anyone's free
      // space (50 PB).
      fixture.formats[0].chunks = [
        { key: "k", sizeBytes: 50 * 1024 * 1024 * 1024 * 1024 * 1024, startSeconds: null },
      ];
      libState.mediaDetails.set("media-movie-1", fixture);
      const deps = buildDeps({ libraryDb, engine, offlineRoot: tempRoot });
      const handler = createBadgerOfflineSubmitHandler(deps);

      const result = await handler({
        mediaIds: ["media-movie-1"],
        quality: "1080p",
        container: "mkv",
        skipAlreadyLocal: true,
      });
      try {
        expect("errorCode" in result).toBe(true);
        if ("errorCode" in result) {
          expect(result.errorCode).toBe("insufficient_disk_space");
          expect(result.requiredBytes).toBeGreaterThan(0);
          expect(typeof result.freeBytes).toBe("number");
        }
        // No engine.submit calls.
        expect(engineState.submitCalls).toHaveLength(0);
      } catch (err) {
        dump("submit-insufficient-disk", { result, engineState });
        throw err;
      }
    });

    it("returns not_authenticated when token is null", async () => {
      console.info(`[${SUITE}:submit-no-auth] start`);
      libState.mediaDetails.set("media-movie-1", fixtureMovieDetails());
      const deps = buildDeps({
        libraryDb,
        engine,
        offlineRoot: tempRoot,
        resolveToken: () => null,
      });
      const handler = createBadgerOfflineSubmitHandler(deps);

      const result = await handler({
        mediaIds: ["media-movie-1"],
        quality: "1080p",
        container: "mkv",
        skipAlreadyLocal: true,
      });
      try {
        expect("errorCode" in result).toBe(true);
        if ("errorCode" in result) {
          expect(result.errorCode).toBe("not_authenticated");
        }
      } catch (err) {
        dump("submit-no-auth", { result });
        throw err;
      }
    });

    it("smart-fill skips already-local items when skipAlreadyLocal is true", async () => {
      console.info(`[${SUITE}:submit-skip-already-local] start`);
      libState.mediaDetails.set("media-movie-1", fixtureMovieDetails());
      libState.localRows.push({
        id: "local-1",
        fileId: "file-movie-1",
        mediaId: "media-movie-1",
        quality: "1080p",
        formatId: "format-1080",
        container: "mkv",
        localPath: "/disk/offline/Test Movie (2026).mkv",
        totalBytes: 9216,
        downloadedAt: "2026-01-01T00:00:00.000Z",
        lastVerifiedAt: null,
        runtimeJobId: null,
      });
      const deps = buildDeps({ libraryDb, engine, offlineRoot: tempRoot });
      const handler = createBadgerOfflineSubmitHandler(deps);

      const result = await handler({
        mediaIds: ["media-movie-1"],
        quality: "1080p",
        container: "mkv",
        skipAlreadyLocal: true,
      });
      try {
        if ("errorCode" in result) {
          throw new Error(`unexpected error ${JSON.stringify(result)}`);
        }
        expect(result.submitted).toHaveLength(0);
        expect(result.skipped).toEqual([
          { mediaId: "media-movie-1", reason: "already-local" },
        ]);
        expect(engineState.submitCalls).toHaveLength(0);
      } catch (err) {
        dump("submit-skip-already-local", { result, engineState });
        throw err;
      }
    });

    it("fileIds narrow-scope filter restricts submission to the listed files", async () => {
      console.info(`[${SUITE}:submit-fileids-narrow-scope] start`);
      // TV show fixture with three files (S1E1, S1E2, S2E1). Each has its
      // own 1080p format. We submit with fileIds=[file-s1e2] and expect ONE
      // job, fileId=file-s1e2.
      libState.mediaDetails.set("media-show-1", fixtureShowDetailsThreeEpisodes());
      const deps = buildDeps({ libraryDb, engine, offlineRoot: tempRoot });
      const handler = createBadgerOfflineSubmitHandler(deps);

      const result = await handler({
        mediaIds: ["media-show-1"],
        quality: "1080p",
        container: "mkv",
        skipAlreadyLocal: true,
        fileIds: ["file-s1e2"],
      });
      try {
        if ("errorCode" in result) {
          throw new Error(`unexpected error ${JSON.stringify(result)}`);
        }
        console.info("[submit-fileids-narrow-scope] submitted", {
          ids: result.submitted.map((s) => s.fileId),
        });
        expect(result.submitted).toHaveLength(1);
        expect(result.submitted[0].fileId).toBe("file-s1e2");
        expect(engineState.submitCalls).toHaveLength(1);
        const p = engineState.submitCalls[0].payload as Record<string, unknown>;
        expect(p.fileId).toBe("file-s1e2");
      } catch (err) {
        dump("submit-fileids-narrow-scope", { result, engineState });
        throw err;
      }
    });
  });

  // -------------------------------------------------------------------------
  // delete_local
  // -------------------------------------------------------------------------

  describe("delete", () => {
    it("unlinks the file, drops the DB row, returns freedBytes", async () => {
      console.info(`[${SUITE}:delete-happy] start`);
      const filePath = joinPath(tempRoot, "Test Movie (2026).mkv");
      writeFileSync(filePath, Buffer.alloc(9216));
      libState.localRows.push({
        id: "local-1",
        fileId: "file-movie-1",
        mediaId: "media-movie-1",
        quality: "1080p",
        formatId: "format-1080",
        container: "mkv",
        localPath: filePath,
        totalBytes: 9216,
        downloadedAt: "2026-01-01T00:00:00.000Z",
        lastVerifiedAt: null,
        runtimeJobId: null,
      });
      const deps = buildDeps({ libraryDb, engine, offlineRoot: tempRoot });
      const handler = createBadgerOfflineDeleteHandler(deps);

      const result = await handler({
        scope: { type: "media", mediaId: "media-movie-1" },
      });
      try {
        expect(result.deleted).toBe(1);
        expect(result.freedBytes).toBe(9216);
        expect(result.cancelledJobIds).toEqual([]);
        // The file is gone.
        expect(existsSync(filePath)).toBe(false);
        // DB row dropped.
        expect(libState.localRows).toHaveLength(0);
        expect(libState.dropCalls).toHaveLength(1);
        expect(libState.dropCalls[0]).toEqual({ type: "media", mediaId: "media-movie-1" });
      } catch (err) {
        dump("delete-happy", { result, libState });
        throw err;
      }
    });

    it("season scope deletes ONLY files in (mediaId AND seasonNumber)", async () => {
      console.info(`[${SUITE}:delete-season-scope] start`);
      // 3 episodes across 2 seasons; all saved locally. Issue a season=1
      // delete; expect both S1 rows gone, S2 row preserved.
      libState.mediaDetails.set("media-show-1", fixtureShowDetailsThreeEpisodes());
      const fileS1E1 = joinPath(tempRoot, "show-s1e1.mkv");
      const fileS1E2 = joinPath(tempRoot, "show-s1e2.mkv");
      const fileS2E1 = joinPath(tempRoot, "show-s2e1.mkv");
      writeFileSync(fileS1E1, Buffer.alloc(1100));
      writeFileSync(fileS1E2, Buffer.alloc(1100));
      writeFileSync(fileS2E1, Buffer.alloc(1100));
      const base = {
        mediaId: "media-show-1",
        quality: "1080p",
        formatId: "fmt",
        container: "mkv",
        totalBytes: 1100,
        downloadedAt: "2026-01-01T00:00:00.000Z",
        lastVerifiedAt: null,
        runtimeJobId: null,
      };
      libState.localRows.push({ id: "row-1", fileId: "file-s1e1", localPath: fileS1E1, ...base });
      libState.localRows.push({ id: "row-2", fileId: "file-s1e2", localPath: fileS1E2, ...base });
      libState.localRows.push({ id: "row-3", fileId: "file-s2e1", localPath: fileS2E1, ...base });

      const deps = buildDeps({ libraryDb, engine, offlineRoot: tempRoot });
      const handler = createBadgerOfflineDeleteHandler(deps);

      const result = await handler({
        scope: { type: "season", mediaId: "media-show-1", seasonNumber: 1 },
      });
      try {
        console.info(
          "[delete-season-scope] result + remaining rows",
          { result, remaining: libState.localRows.map((r) => r.fileId) },
        );
        // S1 rows deleted (2 files unlinked, ~2200 bytes freed).
        expect(result.deleted).toBe(2);
        expect(result.freedBytes).toBe(2200);
        // S1 files gone on disk.
        expect(existsSync(fileS1E1)).toBe(false);
        expect(existsSync(fileS1E2)).toBe(false);
        // S2 untouched.
        expect(existsSync(fileS2E1)).toBe(true);
        // DB row bookkeeping: S2 row survives.
        const remaining = libState.localRows.map((r) => r.fileId);
        expect(remaining).toEqual(["file-s2e1"]);
        // Drop call used the "files" variant with both S1 fileIds.
        expect(libState.dropCalls).toHaveLength(1);
        expect(libState.dropCalls[0].type).toBe("files");
        expect((libState.dropCalls[0] as { fileIds: string[] }).fileIds.sort()).toEqual(
          ["file-s1e1", "file-s1e2"],
        );
      } catch (err) {
        dump("delete-season-scope", { result, libState });
        throw err;
      }
    });

    it("season scope cancels only in-flight download jobs for that season's files", async () => {
      console.info(`[${SUITE}:delete-season-scope-cancels-jobs] start`);
      libState.mediaDetails.set("media-show-1", fixtureShowDetailsThreeEpisodes());
      const fileS1E1 = joinPath(tempRoot, "show-s1e1.mkv");
      writeFileSync(fileS1E1, Buffer.alloc(100));
      libState.localRows.push({
        id: "row-1",
        fileId: "file-s1e1",
        mediaId: "media-show-1",
        quality: "1080p",
        formatId: "fmt",
        container: "mkv",
        localPath: fileS1E1,
        totalBytes: 100,
        downloadedAt: "2026-01-01T00:00:00.000Z",
        lastVerifiedAt: null,
        runtimeJobId: "job-s1e1",
      });
      // Two in-flight jobs: one for the season-1 file (should be cancelled),
      // one for the season-2 file (should NOT be cancelled).
      const ts = new Date().toISOString();
      const baseJob = {
        app: "badger" as const,
        kind: "download" as const,
        lane: "upload" as const,
        status: "running" as IngestJobRecord["status"],
        stageCode: "downloading",
        stageLabel: "Downloading",
        progress: { mode: "fraction" as const, completed: 50, total: 100, unit: "percent" as const },
        progressPct: 50,
        outputs: {},
        errorCode: null,
        errorMessage: null,
        retryable: false,
        cancelRequested: false,
        priority: 70,
        dedupeKey: null,
        createdAt: ts,
        updatedAt: ts,
        startedAt: ts,
        finishedAt: null,
        groupId: "media-show-1",
        mediaId: "media-show-1",
        variant: null,
        parentJobIds: [],
        dismissedAt: null,
        uploadSpeedBytesPerSec: null,
      } satisfies Omit<IngestJobRecord, "jobId" | "payload">;
      engineState.jobs.push({
        ...baseJob,
        jobId: "job-s1e1",
        payload: { fileId: "file-s1e1", mediaId: "media-show-1" },
      });
      engineState.jobs.push({
        ...baseJob,
        jobId: "job-s2e1",
        payload: { fileId: "file-s2e1", mediaId: "media-show-1" },
      });

      const deps = buildDeps({ libraryDb, engine, offlineRoot: tempRoot });
      const handler = createBadgerOfflineDeleteHandler(deps);

      const result = await handler({
        scope: { type: "season", mediaId: "media-show-1", seasonNumber: 1 },
      });
      try {
        console.info(
          "[delete-season-scope-cancels-jobs] cancel calls",
          { calls: engineState.cancelCalls, returnedIds: result.cancelledJobIds },
        );
        // Only the S1 job was cancelled.
        expect(engineState.cancelCalls).toEqual([
          { jobId: "job-s1e1", reason: "offline-delete" },
        ]);
        expect(result.cancelledJobIds).toEqual(["job-s1e1"]);
      } catch (err) {
        dump("delete-season-scope-cancels-jobs", { result, engineState });
        throw err;
      }
    });

    it("cancels in-flight download jobs before unlinking", async () => {
      console.info(`[${SUITE}:delete-cancels-job] start`);
      const filePath = joinPath(tempRoot, "Test Movie (2026).mkv");
      writeFileSync(filePath, Buffer.alloc(100));
      libState.localRows.push({
        id: "local-1",
        fileId: "file-movie-1",
        mediaId: "media-movie-1",
        quality: "1080p",
        formatId: "format-1080",
        container: "mkv",
        localPath: filePath,
        totalBytes: 100,
        downloadedAt: "2026-01-01T00:00:00.000Z",
        lastVerifiedAt: null,
        runtimeJobId: "old-job-1",
      });
      // Inject a non-terminal download job for the same media.
      const ts = new Date().toISOString();
      engineState.jobs.push({
        jobId: "inflight-job-1",
        app: "badger",
        kind: "download",
        lane: "upload",
        status: "running",
        stageCode: "downloading",
        stageLabel: "Downloading",
        progress: { mode: "fraction", completed: 50, total: 100, unit: "percent" },
        progressPct: 50,
        payload: { fileId: "file-movie-1", mediaId: "media-movie-1" },
        outputs: {},
        errorCode: null,
        errorMessage: null,
        retryable: false,
        cancelRequested: false,
        priority: 70,
        dedupeKey: null,
        createdAt: ts,
        updatedAt: ts,
        startedAt: ts,
        finishedAt: null,
        groupId: "media-movie-1",
        mediaId: "media-movie-1",
        variant: null,
        parentJobIds: [],
        dismissedAt: null,
        uploadSpeedBytesPerSec: null,
      });
      const deps = buildDeps({ libraryDb, engine, offlineRoot: tempRoot });
      const handler = createBadgerOfflineDeleteHandler(deps);

      const result = await handler({
        scope: { type: "media", mediaId: "media-movie-1" },
      });
      try {
        expect(result.cancelledJobIds).toContain("inflight-job-1");
        expect(engineState.cancelCalls).toEqual([
          { jobId: "inflight-job-1", reason: "offline-delete" },
        ]);
        expect(result.deleted).toBe(1);
      } catch (err) {
        dump("delete-cancels-job", { result, engineState, libState });
        throw err;
      }
    });
  });

  // -------------------------------------------------------------------------
  // list_local
  // -------------------------------------------------------------------------

  describe("list", () => {
    it("returns entries verbatim from listLocalDownloads", async () => {
      console.info(`[${SUITE}:list] start`);
      libState.localRows.push({
        id: "local-1",
        fileId: "file-1",
        mediaId: "media-1",
        quality: "720p",
        formatId: "format-1",
        container: "mkv",
        localPath: "/disk/offline/Test.mkv",
        totalBytes: 1234,
        downloadedAt: "2026-01-01T00:00:00.000Z",
        lastVerifiedAt: null,
        runtimeJobId: null,
      });
      const deps = buildDeps({ libraryDb, engine, offlineRoot: tempRoot });
      const handler = createBadgerOfflineListHandler(deps);

      const result = await handler({});
      try {
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0]).toEqual({
          mediaId: "media-1",
          fileId: "file-1",
          quality: "720p",
          container: "mkv",
          totalBytes: 1234,
          downloadedAt: "2026-01-01T00:00:00.000Z",
          localPath: "/disk/offline/Test.mkv",
        });
      } catch (err) {
        dump("list", { result });
        throw err;
      }
    });
  });

  // -------------------------------------------------------------------------
  // reconcile
  // -------------------------------------------------------------------------

  describe("reconcile", () => {
    it("drops rows whose file is gone (ENOENT)", async () => {
      console.info(`[${SUITE}:reconcile-missing] start`);
      const gonePath = joinPath(tempRoot, "vanished.mkv");
      // Do NOT write the file.
      libState.localRows.push({
        id: "local-1",
        fileId: "file-1",
        mediaId: "media-1",
        quality: "720p",
        formatId: "format-1",
        container: "mkv",
        localPath: gonePath,
        totalBytes: 1024,
        downloadedAt: "2026-01-01T00:00:00.000Z",
        lastVerifiedAt: null,
        runtimeJobId: null,
      });
      const deps = buildDeps({ libraryDb, engine, offlineRoot: tempRoot });
      const handler = createBadgerOfflineReconcileHandler(deps);

      const result = await handler({});
      try {
        expect(result.dropped).toEqual([
          { mediaId: "media-1", fileId: "file-1", reason: "missing" },
        ]);
        expect(libState.dropCalls).toHaveLength(1);
        expect(libState.dropCalls[0]).toEqual({ type: "files", fileIds: ["file-1"] });
      } catch (err) {
        dump("reconcile-missing", { result, libState });
        throw err;
      }
    });

    it("drops rows whose on-disk size doesn't match recorded totalBytes", async () => {
      console.info(`[${SUITE}:reconcile-size-mismatch] start`);
      const mismatchPath = joinPath(tempRoot, "mismatched.mkv");
      writeFileSync(mismatchPath, Buffer.alloc(50)); // Real size 50; row claims 1024
      libState.localRows.push({
        id: "local-1",
        fileId: "file-1",
        mediaId: "media-1",
        quality: "720p",
        formatId: "format-1",
        container: "mkv",
        localPath: mismatchPath,
        totalBytes: 1024,
        downloadedAt: "2026-01-01T00:00:00.000Z",
        lastVerifiedAt: null,
        runtimeJobId: null,
      });
      const deps = buildDeps({ libraryDb, engine, offlineRoot: tempRoot });
      const handler = createBadgerOfflineReconcileHandler(deps);

      const result = await handler({});
      try {
        expect(result.dropped).toEqual([
          { mediaId: "media-1", fileId: "file-1", reason: "size_mismatch" },
        ]);
      } catch (err) {
        dump("reconcile-size-mismatch", { result, libState });
        throw err;
      }
    });

    it("stamps last_verified_at on surviving rows", async () => {
      console.info(`[${SUITE}:reconcile-survivor] start`);
      const surviorPath = joinPath(tempRoot, "ok.mkv");
      writeFileSync(surviorPath, Buffer.alloc(1024));
      libState.localRows.push({
        id: "local-1",
        fileId: "file-1",
        mediaId: "media-1",
        quality: "720p",
        formatId: "format-1",
        container: "mkv",
        localPath: surviorPath,
        totalBytes: 1024,
        downloadedAt: "2026-01-01T00:00:00.000Z",
        lastVerifiedAt: null,
        runtimeJobId: null,
      });
      const deps = buildDeps({ libraryDb, engine, offlineRoot: tempRoot });
      const handler = createBadgerOfflineReconcileHandler(deps);

      const result = await handler({});
      try {
        expect(result.dropped).toHaveLength(0);
        expect(libState.touchCalls).toHaveLength(1);
        expect(libState.touchCalls[0].fileIds).toEqual(["file-1"]);
        expect(typeof libState.touchCalls[0].verifiedAt).toBe("string");
      } catch (err) {
        dump("reconcile-survivor", { result, libState });
        throw err;
      }
    });
  });
});

// Reference unused import to keep the import warm — fsAsync is brought in for
// potential async-write fixtures; the current tests only use sync writes.
void fsAsync;
