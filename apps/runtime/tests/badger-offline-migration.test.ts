/**
 * OFFL-MIGR-01: old plain-file offline copies (schema 1) are re-saved as sealed pieces after the library opens online.
 * The migration submits a re-save job carrying the old path (the step deletes it once the pieces are recorded),
 * removes the old file first when space is short, skips files whose save is already in flight (idempotent), drops
 * rows whose file left the library, and never touches a path outside the offline dir.
 *
 * Tests log generously: phase markers + state dumps before asserts.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IngestJobRecord } from "@space/runtime-jobs";
import type { EngineV2 } from "../src/core/jobs/engineV2";
import type { BadgerLibraryDbService } from "../src/modules/badgerLibraryDb";
import type { BadgerOfflineHandlerDeps } from "../src/modules/badger/offlineDownload";
import { migrateLegacyOfflineFiles } from "../src/modules/badger/offlineMigration";

const SUITE = "badger-offline-migration";
const MB = 1024 * 1024;

type Row = {
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
  schemaVersion: number;
};

const movieDetails = () => ({
  id: "media-movie-1",
  title: "Test Movie",
  year: "2026",
  type: "movie",
  files: [{ id: "file-movie-1", filename: "movie.mkv", season: null, episode: null }],
  formats: [
    {
      id: "format-1080",
      fileId: "file-movie-1",
      quality: "1080p",
      initKey: "movie-1080-init",
      initSize: 1024,
      chunks: [{ key: "movie-1080-chunk-0", sizeBytes: 4096, startSeconds: 0 }],
    },
    {
      id: "format-720",
      fileId: "file-movie-1",
      quality: "720p",
      initKey: "movie-720-init",
      initSize: 1024,
      chunks: [{ key: "movie-720-chunk-0", sizeBytes: 2048, startSeconds: 0 }],
    },
  ],
  audioTracks: [],
  subtitleTracks: [],
  episodes: [],
});

describe(SUITE, () => {
  let tempRoot: string;
  let offlineRoot: string;
  let rows: Row[];
  let jobs: IngestJobRecord[];
  let submitted: IngestJobRecord[];
  let dropCalls: Array<Record<string, unknown>>;
  let mediaDetails: Map<string, unknown>;
  let dbOpen: boolean;

  const libraryDb = () =>
    ({
      isOpen: () => dbOpen,
      call: vi.fn(async (method: string, args: unknown[]) => {
        if (method === "getMediaDetails") return mediaDetails.get(String(args[0])) ?? null;
        throw new Error(`Mock unsupported method: ${method}`);
      }),
      listLocalDownloads: vi.fn(async () => [...rows]),
      dropLocalDownloads: vi.fn(async (scope: Record<string, unknown>) => {
        dropCalls.push(scope);
        rows = rows.filter((r) => r.fileId !== scope.fileId);
        return { deleted: 1 };
      }),
    }) as unknown as BadgerLibraryDbService;

  const engine = () =>
    ({
      list: vi.fn(async () => ({ jobs: [...jobs], maxEventId: 0 })),
      submit: vi.fn(async (job: IngestJobRecord) => {
        submitted.push(job);
        jobs.push(job);
        return { jobId: job.jobId };
      }),
    }) as unknown as EngineV2;

  const deps = (freeBytes: number): BadgerOfflineHandlerDeps & { freeDiskBytes(dir: string): Promise<number> } => ({
    engine: engine(),
    libraryDb: libraryDb(),
    resolveToken: () => "test-token",
    resolveLibraryKey: () => "test-key-base64",
    resolveOfflineDir: (libraryId: string) => joinPath(tempRoot, libraryId),
    freeDiskBytes: async () => freeBytes,
  });

  const legacyRow = (localPath: string, overrides: Partial<Row> = {}): Row => ({
    id: "row-1",
    fileId: "file-movie-1",
    mediaId: "media-movie-1",
    quality: "720p",
    formatId: "format-720",
    container: "mkv",
    localPath,
    totalBytes: 5000,
    downloadedAt: "2026-01-01T00:00:00.000Z",
    lastVerifiedAt: null,
    runtimeJobId: null,
    schemaVersion: 1,
    ...overrides,
  });

  const writeLegacyFile = (name: string, size = 5000) => {
    const path = joinPath(offlineRoot, name);
    writeFileSync(path, Buffer.alloc(size));
    return path;
  };

  beforeEach(() => {
    tempRoot = mkdtempSync(joinPath(tmpdir(), "spacefleet-offline-migration-"));
    offlineRoot = joinPath(tempRoot, "default");
    mkdirSync(offlineRoot, { recursive: true });
    rows = [];
    jobs = [];
    submitted = [];
    dropCalls = [];
    mediaDetails = new Map([["media-movie-1", movieDetails()]]);
    dbOpen = true;
    console.info(`[${SUITE}:setup] offlineRoot=${offlineRoot}`);
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  // @req OFFL-MIGR-01[runtime]
  it("submits a re-save at the same quality carrying the old path; the old file stays until the pieces land", async () => {
    console.info(`[${SUITE}:resave] start`);
    const oldPath = writeLegacyFile("Test Movie (2026).mkv");
    rows.push(legacyRow(oldPath));
    const result = await migrateLegacyOfflineFiles(deps(10_000 * MB));
    const payload = submitted[0]?.payload as Record<string, unknown> | undefined;
    console.info(`[${SUITE}:resave] after`, { result, payload, oldFileStays: existsSync(oldPath) });
    expect(result).toMatchObject({ legacyRows: 1, submitted: 1, removedFirstForSpace: 0, dropped: 0, errors: 0 });
    expect(submitted).toHaveLength(1);
    expect(submitted[0].kind).toBe("download");
    expect(payload).toMatchObject({
      fileId: "file-movie-1",
      quality: "720p",
      formatId: "format-720",
      legacyLocalPath: oldPath,
    });
    expect(payload).not.toHaveProperty("container");
    expect(existsSync(oldPath)).toBe(true);
    expect(dropCalls).toEqual([]);
  });

  // @req OFFL-MIGR-01[runtime] @req OFFL-SAFE-02[runtime]
  it("short of space: removes the old file first, then submits", async () => {
    console.info(`[${SUITE}:short-space] start`);
    const oldPath = writeLegacyFile("Test Movie (2026).mkv");
    rows.push(legacyRow(oldPath));
    const result = await migrateLegacyOfflineFiles(deps(1 * MB));
    console.info(`[${SUITE}:short-space] after`, { result, oldFileStays: existsSync(oldPath) });
    expect(result).toMatchObject({ submitted: 1, removedFirstForSpace: 1, errors: 0 });
    expect(existsSync(oldPath)).toBe(false);
    // The row (the user's selection) stays until the pieces replace it.
    expect(rows).toHaveLength(1);
  });

  it("is idempotent: a file with a save in flight is skipped", async () => {
    console.info(`[${SUITE}:idempotent] start`);
    const oldPath = writeLegacyFile("Test Movie (2026).mkv");
    rows.push(legacyRow(oldPath));
    const first = await migrateLegacyOfflineFiles(deps(10_000 * MB));
    const second = await migrateLegacyOfflineFiles(deps(10_000 * MB));
    console.info(`[${SUITE}:idempotent] after`, { first, second, submitted: submitted.length });
    expect(first.submitted).toBe(1);
    expect(second).toMatchObject({ legacyRows: 1, submitted: 0, inFlight: 1 });
    expect(submitted).toHaveLength(1);
  });

  it("file gone from the library: old file and row dropped, nothing submitted", async () => {
    console.info(`[${SUITE}:gone] start`);
    const oldPath = writeLegacyFile("Gone (2020).mkv");
    rows.push(legacyRow(oldPath, { fileId: "file-gone", mediaId: "media-gone" }));
    const result = await migrateLegacyOfflineFiles(deps(10_000 * MB));
    console.info(`[${SUITE}:gone] after`, { result, dropCalls, oldFileStays: existsSync(oldPath) });
    expect(result).toMatchObject({ dropped: 1, submitted: 0, errors: 0 });
    expect(existsSync(oldPath)).toBe(false);
    expect(dropCalls).toEqual([{ type: "file", fileId: "file-gone" }]);
  });

  it("never removes a path outside the offline dir, even when short of space", async () => {
    console.info(`[${SUITE}:outside-root] start`);
    const userDir = joinPath(tempRoot, "My Videos");
    mkdirSync(userDir, { recursive: true });
    const userPath = joinPath(userDir, "Test Movie (2026).mkv");
    writeFileSync(userPath, Buffer.alloc(5000));
    const gonePath = joinPath(userDir, "Gone (2020).mkv");
    writeFileSync(gonePath, Buffer.alloc(5000));
    rows.push(legacyRow(userPath));
    rows.push(legacyRow(gonePath, { id: "row-2", fileId: "file-gone", mediaId: "media-gone" }));
    const result = await migrateLegacyOfflineFiles(deps(1 * MB));
    console.info(`[${SUITE}:outside-root] after`, {
      result,
      userFileStays: existsSync(userPath),
      goneFileStays: existsSync(gonePath),
    });
    expect(existsSync(userPath)).toBe(true);
    expect(existsSync(gonePath)).toBe(true);
    expect(result.submitted).toBe(1);
    expect(result.dropped).toBe(1);
  });

  it("leaves pieces rows (schema 2) alone and does nothing when the library is closed", async () => {
    console.info(`[${SUITE}:noop] start`);
    rows.push(legacyRow(joinPath(offlineRoot, "items", "x.json"), { container: "pieces", schemaVersion: 2 }));
    const withPieces = await migrateLegacyOfflineFiles(deps(10_000 * MB));
    const oldPath = writeLegacyFile("Test Movie (2026).mkv");
    rows = [legacyRow(oldPath)];
    dbOpen = false;
    const closed = await migrateLegacyOfflineFiles(deps(10_000 * MB));
    console.info(`[${SUITE}:noop] after`, { withPieces, closed, submitted: submitted.length });
    expect(withPieces).toMatchObject({ legacyRows: 0, submitted: 0 });
    expect(closed).toMatchObject({ legacyRows: 0, submitted: 0 });
    expect(submitted).toHaveLength(0);
    expect(existsSync(oldPath)).toBe(true);
  });
});
