/**
 * @req OFFL-AUTO-01
 *
 * Offline downloads are only ever created by an explicit
 * `badger.offline.download.submit` command. Every other offline command
 * (estimate, list, reconcile, delete), and opening the offline module itself,
 * must never enqueue an engine job nor fetch a storage object.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createBadgerOfflineDeleteHandler,
  createBadgerOfflineEstimateHandler,
  createBadgerOfflineListHandler,
  createBadgerOfflineReconcileHandler,
  createBadgerOfflineSubmitHandler,
  type BadgerOfflineHandlerDeps,
} from "../src/modules/badger/offlineDownload";
import { configureBadgerOfflineDeps } from "../src/modules/badger/offlineDownloadDeps";
import type { BadgerLibraryDbService } from "../src/modules/badgerLibraryDb";
import type { EngineV2 } from "@space/runtime-jobs-engine/engineV2";

const movieDetails = {
  id: "media-movie-1",
  title: "Test Movie",
  year: "2026",
  type: "movie",
  files: [{ id: "file-movie-1", filename: "/disk/movie.mkv", season: null, episode: null }],
  formats: [
    {
      id: "format-1080",
      fileId: "file-movie-1",
      quality: "1080p",
      initKey: "movie-1080-init",
      initSize: 1024,
      chunks: [{ key: "movie-1080-chunk-0", sizeBytes: 4096, startSeconds: null }],
    },
  ],
  audioTracks: [],
  subtitleTracks: [],
  episodes: [],
};

describe("badger offline never downloads on its own", () => {
  let tempRoot: string;
  let deps: BadgerOfflineHandlerDeps;
  const submit = vi.fn(async (job: { jobId: string }) => ({ jobId: job.jobId }));
  const downloadObject = vi.fn(async () => new Uint8Array());

  beforeEach(() => {
    tempRoot = mkdtempSync(joinPath(tmpdir(), "spacefleet-offline-auto-"));
    submit.mockClear();
    downloadObject.mockClear();
    configureBadgerOfflineDeps({
      downloadObject,
      decrypt: vi.fn(),
      resolveOfflineDir: (libraryId: string) => joinPath(tempRoot, libraryId),
    } as unknown as Parameters<typeof configureBadgerOfflineDeps>[0]);
    const libraryDb = {
      isOpen: () => true,
      call: vi.fn(async () => movieDetails),
      listLocalDownloads: vi.fn(async () => []),
      dropLocalDownloads: vi.fn(async () => ({ deleted: 0 })),
      registerLocalDownload: vi.fn(async () => ({ inserted: 1 })),
      touchLocalDownloadsVerified: vi.fn(async () => ({ touched: 0 })),
    } as unknown as BadgerLibraryDbService;
    const engine = {
      submit,
      cancel: vi.fn(async () => ({ cancelledIds: [] })),
      list: vi.fn(async () => ({ jobs: [], maxEventId: 0 })),
      get: vi.fn(async () => null),
    } as unknown as EngineV2;
    deps = {
      engine,
      libraryDb,
      resolveToken: () => "test-token",
      resolveLibraryKey: () => "test-key-base64",
      resolveOfflineDir: (libraryId: string) => joinPath(tempRoot, libraryId),
    } as unknown as BadgerOfflineHandlerDeps;
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("estimate, list, reconcile and delete never enqueue a job or fetch an object", async () => {
    await createBadgerOfflineEstimateHandler(deps)({
      mediaIds: ["media-movie-1"],
      quality: "1080p",
      container: "mkv",
    });
    await createBadgerOfflineListHandler(deps)({});
    await createBadgerOfflineReconcileHandler(deps)({});
    await createBadgerOfflineDeleteHandler(deps)({ scope: { type: "media", mediaId: "media-movie-1" } });

    expect(submit).not.toHaveBeenCalled();
    expect(downloadObject).not.toHaveBeenCalled();
  });

  it("only the explicit submit command enqueues a download job", async () => {
    const result = await createBadgerOfflineSubmitHandler(deps)({
      mediaIds: ["media-movie-1"],
      quality: "1080p",
      container: "mkv",
      skipAlreadyLocal: true,
    });

    expect("errorCode" in result).toBe(false);
    expect(submit).toHaveBeenCalledTimes(1);
    // Enqueueing is not downloading: the engine runs the step, not the handler.
    expect(downloadObject).not.toHaveBeenCalled();
  });
});
