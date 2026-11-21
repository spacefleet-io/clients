/**
 * `export_file` step (OFFL-FILE-01 / ACCT-EXPORT-01): fetch the stored pieces, decrypt, mux one plain MKV/MP4 in a
 * staging folder on the destination disk, then move it into the picked folder under a free name (OFFL-FILE-02, #618).
 * Never registered as offline content; a failed export leaves nothing behind (OFFL-SAFE-01).
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runFfmpegMock } = vi.hoisted(() => ({ runFfmpegMock: vi.fn() }));
vi.mock("@space/ffmpeg", () => ({ runFfmpeg: runFfmpegMock, runFfprobe: vi.fn(), createFfmpegTask: vi.fn() }));

import { exportFileStepHandler } from "../src/modules/badger/steps/exportFile";
import { configureBadgerOfflineDeps, __resetBadgerOfflineDeps, type BadgerOfflineDeps } from "../src/modules/badger/offlineDownloadDeps";
import type { ExportJobPayload } from "../src/modules/badger/export";
import type { StepHandlerCtx } from "../src/core/jobs/engineV2";
import type { IngestJobRecord } from "@space/runtime-jobs";
import type { StoredStepRecord } from "../src/core/jobs/stepStore";

const SUITE = "badger-export-step";
const log = (phase: string, data?: unknown) =>
  console.info(`[${SUITE}:${phase}]${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const tree = (dir: string, prefix = ""): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? [`${prefix}${e.name}/`, ...tree(joinPath(dir, e.name), `${prefix}${e.name}/`)] : [`${prefix}${e.name}`],
      )
    : [];

const ts = "2026-11-21T00:00:00.000Z";

let destDir: string;
let downloads: string[];
let registerCalls: unknown[];

const payloadFor = (overrides: Partial<ExportJobPayload> = {}): ExportJobPayload => ({
  fileId: "movie-file",
  mediaId: "movie-1",
  quality: "1080p",
  container: "mkv",
  layout: "flat",
  destDir,
  expectedBytes: 4000,
  filename: "Lattice (1999)",
  skippedSubsForContainer: [],
  manifest: {
    videoInitKey: "v-init",
    videoInitSize: 10,
    videoChunks: [
      { key: "v-c0", sizeBytes: 1000, orderIndex: 0 },
      { key: "v-c1", sizeBytes: 1000, orderIndex: 1 },
    ],
    audioTracks: [
      { trackId: "a-en", language: "eng", label: "English", isDefault: true, initKey: "a-init", initSize: 10, chunks: [{ key: "a-c0", sizeBytes: 100, orderIndex: 0 }] },
      { trackId: "a-fr", language: "fra", label: "Français", isDefault: false, initKey: null, initSize: null, chunks: [{ key: "a-fr-c0", sizeBytes: 100, orderIndex: 0 }] },
    ],
    subtitles: [{ subtitleId: "s-en", language: "eng", label: "English", format: "srt", objectKey: "s-key", sizeBytes: 10240, isDefault: false }],
    filenameInputs: { kind: "movie", title: "Lattice", year: 1999 },
  },
  ...overrides,
});

const makeJob = (payload: ExportJobPayload, jobId = "export-job-1"): IngestJobRecord => ({
  jobId,
  app: "badger",
  kind: "export",
  lane: "upload",
  status: "running",
  stageCode: "running",
  stageLabel: "Running",
  progress: { mode: "fraction", completed: 0, total: 100, unit: "percent" },
  progressPct: 0,
  payload: payload as unknown as Record<string, unknown>,
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
  groupId: payload.mediaId,
  mediaId: payload.mediaId,
  variant: null,
  parentJobIds: [],
  dismissedAt: null,
  uploadSpeedBytesPerSec: null,
});

const makeCtx = (job: IngestJobRecord) => {
  const step: StoredStepRecord = {
    stepId: `${job.jobId}:export_file`,
    jobId: job.jobId,
    ordinal: 0,
    kind: "export_file",
    status: "running",
    progressPct: 0,
    errorCode: null,
    errorMessage: null,
    startedAt: ts,
    finishedAt: null,
    app: "badger",
    lane: "upload",
    dependsOn: [],
    payload: {},
    outputs: {},
    createdAt: ts,
    updatedAt: ts,
  };
  const progress: Array<[number, string?, string?]> = [];
  const outputs: Array<Record<string, unknown>> = [];
  const ctx: StepHandlerCtx = {
    job,
    step,
    signal: new AbortController().signal,
    reportProgress: (pct, label, code) => void progress.push([pct, label, code]),
    emitOutputs: (out) => void outputs.push(out),
  };
  return { ctx, progress, outputs };
};

beforeEach(() => {
  destDir = mkdtempSync(joinPath(tmpdir(), "sf-export-step-"));
  downloads = [];
  registerCalls = [];
  const deps: BadgerOfflineDeps = {
    awaitCredentials: async () => ({ token: "tok", libraryKeyBase64: "key" }),
    downloadObject: async (_token, key) => {
      downloads.push(key);
      return new TextEncoder().encode(`<${key}>`);
    },
    decrypt: (encrypted) => Buffer.from(encrypted),
    resolveOfflineDir: () => {
      throw new Error("export must not use the offline dir");
    },
    resolveFfmpegPath: () => "/opt/ffmpeg",
    registerLocalDownload: async (input) => {
      registerCalls.push(input);
      return { inserted: 1 };
    },
  };
  configureBadgerOfflineDeps(deps);
  runFfmpegMock.mockReset();
  runFfmpegMock.mockImplementation(async (args: string[]) => {
    writeFileSync(args[args.length - 1], "MUXED");
    return { code: 0 };
  });
});

afterEach(() => {
  __resetBadgerOfflineDeps();
  rmSync(destDir, { recursive: true, force: true });
});

describe("exportFileStepHandler", () => {
  it("writes one plain file into the picked folder with every audio and subtitle track, never registered offline", async () => {
    const { ctx, progress, outputs } = makeCtx(makeJob(payloadFor()));
    await exportFileStepHandler(ctx);
    const files = tree(destDir);
    const args = runFfmpegMock.mock.calls[0]?.[0] as string[];
    log("flat", { files, downloads, args, progress, outputs });
    expect(files).toEqual(["Lattice (1999).mkv"]);
    expect(readFileSync(joinPath(destDir, "Lattice (1999).mkv"), "utf8")).toBe("MUXED");
    expect(downloads).toEqual(["v-init", "v-c0", "v-c1", "a-init", "a-c0", "a-fr-c0", "s-key"]);
    expect(args.filter((a) => a === "-i")).toHaveLength(4);
    expect(args).toContain("-map");
    expect(args).toContain("language=fra");
    expect(registerCalls).toEqual([]);
    expect(outputs.at(-1)).toEqual({
      exportResult: { path: joinPath(destDir, "Lattice (1999).mkv"), totalBytes: 5, container: "mkv", skippedSubsForContainer: [] },
    });
    expect(progress.at(-1)?.[0]).toBe(100);
  });

  it("library layout: an episode lands in Shows/<Show>/Season NN/", async () => {
    const payload = payloadFor({
      layout: "library",
      container: "mp4",
      fileId: "ep-2",
      mediaId: "show-1",
      manifest: {
        ...payloadFor().manifest,
        filenameInputs: { kind: "episode", showTitle: "Dr.Who", seasonNumber: 1, episodeNumber: 2, episodeTitle: "The End of the World" },
      },
    });
    const { ctx } = makeCtx(makeJob(payload));
    await exportFileStepHandler(ctx);
    const files = tree(destDir);
    log("library", { files, args: runFfmpegMock.mock.calls[0]?.[0] });
    expect(files).toEqual(["Shows/", "Shows/Dr.Who/", "Shows/Dr.Who/Season 01/", "Shows/Dr.Who/Season 01/Dr.Who - S01E02 - The End of the World.mp4"]);
    expect(runFfmpegMock.mock.calls[0]?.[0]).toContain("mov_text");
  });

  it("a file already there in another letter case is kept; the export gets a suffix (#618)", async () => {
    writeFileSync(joinPath(destDir, "lattice (1999).MKV"), "theirs");
    const { ctx } = makeCtx(makeJob(payloadFor()));
    await exportFileStepHandler(ctx);
    const files = tree(destDir).sort();
    log("collision", files);
    expect(files).toEqual(["Lattice (1999) (2).mkv", "lattice (1999).MKV"]);
    expect(readFileSync(joinPath(destDir, "lattice (1999).MKV"), "utf8")).toBe("theirs");
  });

  it("a failed mux leaves nothing in the folder: no partial file, no staging folder", async () => {
    mkdirSync(joinPath(destDir, "keep"));
    runFfmpegMock.mockImplementation(async (args: string[]) => {
      writeFileSync(args[args.length - 1], "HALF");
      throw new Error("ffmpeg exited 1");
    });
    const { ctx } = makeCtx(makeJob(payloadFor()));
    const err = await exportFileStepHandler(ctx).then(() => null, (e: unknown) => e);
    const files = tree(destDir);
    log("mux-failure", { err: String(err), files });
    expect(String(err)).toContain("ffmpeg exited 1");
    expect(files).toEqual(["keep/"]);
  });

  it("two exports of the same title finishing together get two names", async () => {
    const a = makeCtx(makeJob(payloadFor(), "job-a"));
    const b = makeCtx(makeJob(payloadFor(), "job-b"));
    await Promise.all([exportFileStepHandler(a.ctx), exportFileStepHandler(b.ctx)]);
    const files = tree(destDir).sort();
    log("concurrent", files);
    expect(files).toEqual(["Lattice (1999) (2).mkv", "Lattice (1999).mkv"]);
  });
});
