/**
 * `badger.export.estimate` / `badger.export.submit` (OFFL-FILE-01, ACCT-EXPORT-01, OFFL-QUAL-01, OFFL-SAFE-02).
 *
 * Export = plain files in a folder the user picked, at the highest stored quality, never tracked by the app: the
 * handlers submit one `kind: "export"` job per file and never touch `media_local_downloads`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IngestJobRecord } from "@space/runtime-jobs";
import {
  createBadgerExportEstimateHandler,
  createBadgerExportSubmitHandler,
  type BadgerExportHandlerDeps,
  type ExportJobPayload,
} from "../src/modules/badger/export";

const SUITE = "badger-export-handlers";
const log = (phase: string, data?: unknown) =>
  console.info(`[${SUITE}:${phase}]${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const fmt = (id: string, fileId: string, quality: string, chunkBytes: number) => ({
  id,
  fileId,
  quality,
  initKey: `${id}-init`,
  initSize: 100,
  chunks: [
    { key: `${id}-c0`, sizeBytes: chunkBytes, startSeconds: 0 },
    { key: `${id}-c1`, sizeBytes: chunkBytes, startSeconds: 4 },
  ],
});

const MOVIE = {
  id: "movie-1",
  title: "Lattice",
  year: "1999",
  type: "movie" as const,
  files: [{ id: "movie-file", filename: "lattice.mkv", season: null, episode: null }],
  formats: [fmt("m-720", "movie-file", "720p", 1000), fmt("m-1080", "movie-file", "1080p", 3000), fmt("m-480", "movie-file", "480p", 500)],
  audioTracks: [
    { id: "a-en", fileId: "movie-file", language: "eng", label: "English", isDefault: true, initKey: "a-en-init", initSize: 10, chunks: [{ key: "a-en-c0", sizeBytes: 200, startSeconds: 0 }] },
    { id: "a-fr", fileId: "movie-file", language: "fra", label: "Français", isDefault: false, initKey: "a-fr-init", initSize: 10, chunks: [{ key: "a-fr-c0", sizeBytes: 200, startSeconds: 0 }] },
  ],
  subtitleTracks: [
    { id: "s-en", fileId: "movie-file", language: "eng", label: "English", objectKey: "s-en-key", format: "srt", isDefault: false },
    { id: "s-ja", fileId: "movie-file", language: "jpn", label: "Signs", objectKey: "s-ja-key", format: "ass", isDefault: false },
  ],
  episodes: [],
};

const SHOW = {
  id: "show-1",
  title: "Dr.Who",
  year: "2005",
  type: "tv" as const,
  files: [
    { id: "ep-1", filename: "e1.mkv", season: 1, episode: 1 },
    { id: "ep-2", filename: "e2.mkv", season: 1, episode: 2 },
  ],
  formats: [fmt("e1-720", "ep-1", "720p", 1000), fmt("e2-720", "ep-2", "720p", 1000)],
  audioTracks: [],
  subtitleTracks: [],
  episodes: [
    { id: "x1", seasonNumber: 1, episodeNumber: 1, name: "Rose" },
    { id: "x2", seasonNumber: 1, episodeNumber: 2, name: "The End of the World" },
  ],
};

const EMPTY = { ...MOVIE, id: "movie-empty", title: "No Files", files: [], formats: [], audioTracks: [], subtitleTracks: [] };

let destDir: string;
let submitted: IngestJobRecord[];
let freeBytes: number;
let token: string | null;
/** The export payload of a submitted job (the job record types it as a plain record). */
const exportPayload = (job: IngestJobRecord): ExportJobPayload => job.payload as unknown as ExportJobPayload;

const makeDeps = (): BadgerExportHandlerDeps => {
  const details: Record<string, unknown> = { [MOVIE.id]: MOVIE, [SHOW.id]: SHOW, [EMPTY.id]: EMPTY };
  return {
    engine: { submit: vi.fn(async (job: IngestJobRecord) => void submitted.push(job)) } as unknown as BadgerExportHandlerDeps["engine"],
    libraryDb: {
      isOpen: () => true,
      call: vi.fn(async (method: string, args: unknown[]) => {
        if (method === "getMediaDetails") return details[String(args[0])] ?? null;
        if (method === "listMedia")
          return [
            { id: MOVIE.id, type: "movie", title: MOVIE.title, hasFiles: true },
            { id: SHOW.id, type: "tv", title: SHOW.title, hasFiles: true },
            { id: EMPTY.id, type: "movie", title: EMPTY.title, hasFiles: false },
          ];
        throw new Error(`unexpected libraryDb.call ${method}`);
      }),
      listLocalDownloads: vi.fn(async () => {
        throw new Error("export must never read or write media_local_downloads");
      }),
    } as unknown as BadgerExportHandlerDeps["libraryDb"],
    resolveToken: () => token,
    resolveLibraryKey: () => "key",
    freeBytesAt: (dir) => {
      log("statfs", { dir });
      return freeBytes;
    },
  };
};

beforeEach(() => {
  destDir = mkdtempSync(joinPath(tmpdir(), "sf-export-handlers-"));
  submitted = [];
  freeBytes = 50 * 1024 ** 3;
  token = "tok";
});

afterEach(() => {
  rmSync(destDir, { recursive: true, force: true });
});

describe("badger.export.estimate", () => {
  it("counts every file of the whole library at its highest quality and reads free space on the picked folder's disk", async () => {
    const result = await createBadgerExportEstimateHandler(makeDeps())({ all: true, destDir, container: "mkv" });
    log("estimate-all", result);
    // movie: 1080p video (100 + 2*3000) + 2 audio (2*210) + 2 subs (2*10KiB); show: 2 × 720p (100 + 2*1000).
    const movieBytes = 100 + 6000 + 420 + 2 * 10 * 1024;
    expect(result.count).toBe(3);
    expect(result.totalBytes).toBe(movieBytes + 2 * 2100);
    expect(result.freeBytesAvailable).toBe(freeBytes);
    expect(result.sufficientSpace).toBe(true);
    expect(result.skipped).toEqual([{ mediaId: EMPTY.id, reason: "no-file" }]);
  });

  it("reports not enough space when the files plus the safety margin do not fit (OFFL-SAFE-02)", async () => {
    freeBytes = 1000;
    const result = await createBadgerExportEstimateHandler(makeDeps())({ mediaIds: [MOVIE.id], destDir, container: "mkv" });
    log("estimate-small-disk", result);
    expect(result.sufficientSpace).toBe(false);
  });
});

describe("badger.export.submit", () => {
  it("one movie: one export job at the highest stored quality, flat into the picked folder, never tracked", async () => {
    const deps = makeDeps();
    const result = await createBadgerExportSubmitHandler(deps)({ mediaIds: [MOVIE.id], destDir, container: "mkv", layout: "flat" });
    log("submit-movie", { result, jobs: submitted.map((j) => ({ kind: j.kind, payload: j.payload })) });
    expect("submitted" in result && result.submitted).toHaveLength(1);
    expect(submitted).toHaveLength(1);
    const job = submitted[0];
    const payload = exportPayload(job);
    expect(job.kind).toBe("export");
    expect(job.lane).toBe("upload");
    expect(payload.quality).toBe("1080p");
    expect(payload.manifest.videoChunks.map((c) => c.key)).toEqual(["m-1080-c0", "m-1080-c1"]);
    expect(payload.manifest.audioTracks.map((t) => t.trackId)).toEqual(["a-en", "a-fr"]);
    expect(payload.manifest.subtitles.map((s) => s.subtitleId)).toEqual(["s-en", "s-ja"]);
    expect(payload.destDir).toBe(destDir);
    expect(payload.layout).toBe("flat");
    expect(payload.filename).toBe("Lattice (1999)");
    expect(JSON.stringify(job.payload)).not.toContain("tok");
    expect(deps.libraryDb.listLocalDownloads).not.toHaveBeenCalled();
  });

  it("MP4 keeps only the subtitles MP4 can hold (srt/vtt)", async () => {
    await createBadgerExportSubmitHandler(makeDeps())({ mediaIds: [MOVIE.id], destDir, container: "mp4", layout: "flat" });
    const payload = exportPayload(submitted[0]);
    log("submit-mp4", payload.manifest.subtitles);
    expect(payload.manifest.subtitles.map((s) => s.subtitleId)).toEqual(["s-en"]);
    expect(payload.skippedSubsForContainer).toEqual(["jpn"]);
  });

  it("one episode: only the picked file of the show", async () => {
    await createBadgerExportSubmitHandler(makeDeps())({ mediaIds: [SHOW.id], fileIds: ["ep-2"], destDir, container: "mkv", layout: "flat" });
    log("submit-episode", submitted.map((j) => j.payload));
    expect(submitted).toHaveLength(1);
    const payload = exportPayload(submitted[0]);
    expect(payload.fileId).toBe("ep-2");
    expect(payload.manifest.filenameInputs).toEqual({ kind: "episode", showTitle: "Dr.Who", seasonNumber: 1, episodeNumber: 2, episodeTitle: "The End of the World" });
    expect(payload.hints).toEqual({ season: 1, episode: 2 });
  });

  it("download everything: every file of every title, library layout", async () => {
    const result = await createBadgerExportSubmitHandler(makeDeps())({ all: true, destDir, container: "mkv", layout: "library" });
    log("submit-all", { result, files: submitted.map((j) => exportPayload(j).fileId) });
    expect(submitted.map((j) => exportPayload(j).fileId).sort()).toEqual(["ep-1", "ep-2", "movie-file"]);
    expect(submitted.every((j) => exportPayload(j).layout === "library")).toBe(true);
    expect("skipped" in result && result.skipped).toEqual([{ mediaId: EMPTY.id, reason: "no-file" }]);
  });

  it("refuses when the picked folder's disk is too small, submits nothing", async () => {
    freeBytes = 1000;
    const result = await createBadgerExportSubmitHandler(makeDeps())({ all: true, destDir, container: "mkv", layout: "library" });
    log("submit-small-disk", result);
    expect(result).toMatchObject({ errorCode: "insufficient_disk_space", freeBytes: 1000 });
    expect(submitted).toHaveLength(0);
  });

  it("refuses a folder it cannot write to", async () => {
    const result = await createBadgerExportSubmitHandler(makeDeps())({ mediaIds: [MOVIE.id], destDir: joinPath(destDir, "missing"), container: "mkv", layout: "flat" });
    log("submit-missing-dir", result);
    expect(result).toEqual({ errorCode: "dest_not_writable" });
    expect(submitted).toHaveLength(0);
  });

  it("refuses when signed out", async () => {
    token = null;
    const result = await createBadgerExportSubmitHandler(makeDeps())({ mediaIds: [MOVIE.id], destDir, container: "mkv", layout: "flat" });
    log("submit-signed-out", result);
    expect(result).toEqual({ errorCode: "not_authenticated" });
  });
});
