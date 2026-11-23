/**
 * Step-handler tests for `offlineDownloadStepHandler`. The step is the
 * single-engine-step pipeline for `kind: "download"` jobs (Phase 2 of the
 * let-s-talk-about-offline plan): fetch chunks → decrypt → concat per
 * track → ffmpeg mux → atomic rename → register `media_local_downloads`
 * row.
 *
 * The tests stub the storage bridge, ffmpeg, and the registerLocalDownload
 * hook via the `configureBadgerOfflineDeps` registry so no real IO touches
 * the disk *outside* a per-test temp dir. The mux step still calls into
 * the real `runFfmpeg`; we mock the `@space/ffmpeg` module wholesale so
 * the test never spawns a subprocess.
 *
 * Tests log generously: every test emits phase markers
 * and dumps a snapshot on failure.
 */

import { mkdtempSync, rmSync, existsSync, readdirSync, promises as fsAsync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runFfmpegMock } = vi.hoisted(() => ({
  runFfmpegMock: vi.fn(),
}));

vi.mock("@space/ffmpeg", () => ({
  runFfmpeg: runFfmpegMock,
  runFfprobe: vi.fn(),
  createFfmpegTask: vi.fn(),
}));

import { offlineDownloadStepHandler } from "../src/modules/badger/steps/offlineDownload";
import {
  configureBadgerOfflineDeps,
  createOfflineAwaitCredentials,
  __resetBadgerOfflineDeps,
  type BadgerOfflineDeps,
} from "../src/modules/badger/offlineDownloadDeps";
import type { StepHandlerCtx } from "../src/core/jobs/engineV2";
import type { IngestJobRecord } from "@space/runtime-jobs";
import type { StoredStepRecord } from "../src/core/jobs/stepStore";
import type { OfflineDownloadManifest } from "../src/modules/badger/steps/offlineDownload";

const SUITE = "badger-offline-download-step";

const dumpSnapshot = (
  label: string,
  ctx: {
    stagingExists?: boolean;
    stagingContents?: string[];
    finalDirContents?: string[];
    recordedProgress?: Array<[number, string?, string?]>;
    recordedOutputs?: Array<Record<string, unknown>>;
    ffmpegCalls?: unknown[];
    registerCalls?: unknown[];
    downloadCalls?: unknown[];
    error?: unknown;
    extra?: Record<string, unknown>;
  } = {}
) => {
  try {
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    if (ctx.stagingExists !== undefined) console.error(`stagingExists: ${ctx.stagingExists}`);
    if (ctx.stagingContents) console.error(`stagingContents:\n${JSON.stringify(ctx.stagingContents, null, 2)}`);
    if (ctx.finalDirContents) console.error(`finalDirContents:\n${JSON.stringify(ctx.finalDirContents, null, 2)}`);
    if (ctx.recordedProgress) console.error(`recordedProgress(${ctx.recordedProgress.length}):\n${JSON.stringify(ctx.recordedProgress, null, 2)}`);
    if (ctx.recordedOutputs) console.error(`recordedOutputs(${ctx.recordedOutputs.length}):\n${JSON.stringify(ctx.recordedOutputs, null, 2)}`);
    if (ctx.ffmpegCalls) console.error(`ffmpegCalls(${ctx.ffmpegCalls.length}):\n${JSON.stringify(ctx.ffmpegCalls, null, 2)}`);
    if (ctx.registerCalls) console.error(`registerCalls(${ctx.registerCalls.length}):\n${JSON.stringify(ctx.registerCalls, null, 2)}`);
    if (ctx.downloadCalls) console.error(`downloadCalls(${ctx.downloadCalls.length}):\n${JSON.stringify(ctx.downloadCalls, null, 2)}`);
    if (ctx.error) {
      const e = ctx.error;
      console.error(`error: ${e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ""}` : String(e)}`);
    }
    if (ctx.extra) console.error(`extra:\n${JSON.stringify(ctx.extra, null, 2)}`);
    console.error(`=== [${SUITE}:${label}] end snapshot ===`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

const ts = "2026-01-01T00:00:00.000Z";

const makeJob = (overrides: Partial<IngestJobRecord> = {}): IngestJobRecord => ({
  jobId: "offline-job-1",
  app: "badger",
  kind: "download",
  lane: "upload",
  status: "running",
  stageCode: "running",
  stageLabel: "Running",
  progress: { mode: "fraction", completed: 0, total: 100, unit: "percent" },
  progressPct: 0,
  payload: {},
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
  groupId: "media-1",
  mediaId: "media-1",
  variant: null,
  parentJobIds: [],
  dismissedAt: null,
  uploadSpeedBytesPerSec: null,
  ...overrides,
});

const makeStep = (overrides: Partial<StoredStepRecord> = {}): StoredStepRecord => ({
  stepId: "offline-job-1:offline_download",
  jobId: "offline-job-1",
  ordinal: 0,
  kind: "offline_download",
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
  ...overrides,
});

interface Recorded {
  progress: Array<[number, string?, string?]>;
  outputs: Array<Record<string, unknown>>;
}

const makeCtx = (
  job: IngestJobRecord,
  step: StoredStepRecord,
  signal: AbortSignal = new AbortController().signal
): StepHandlerCtx & { recorded: Recorded } => {
  const recorded: Recorded = { progress: [], outputs: [] };
  return {
    job,
    step,
    signal,
    reportProgress: (pct, label, code) => {
      recorded.progress.push([pct, label, code]);
    },
    emitOutputs: (out) => {
      recorded.outputs.push(out);
      for (const [k, v] of Object.entries(out)) {
        (step.outputs as Record<string, unknown>)[k] = v;
      }
    },
    recorded,
  };
};

const baseManifest = (): OfflineDownloadManifest => ({
  videoInitKey: "video-init-key",
  videoInitSize: 1024,
  videoChunks: [
    { key: "video-chunk-0", sizeBytes: 4096, orderIndex: 0 },
    { key: "video-chunk-1", sizeBytes: 4096, orderIndex: 1 },
  ],
  audioTracks: [
    {
      trackId: "audio-0",
      language: "eng",
      label: "English",
      isDefault: true,
      initKey: "audio-init-0",
      initSize: 512,
      chunks: [
        { key: "audio-chunk-0", sizeBytes: 1024, orderIndex: 0 },
      ],
    },
  ],
  subtitles: [
    {
      subtitleId: "sub-0",
      language: "eng",
      label: "English SRT",
      format: "srt",
      objectKey: "sub-eng-srt",
      sizeBytes: 256,
      isDefault: true,
    },
  ],
  filenameInputs: {
    kind: "movie",
    title: "The Test Movie",
    year: 2026,
  },
});

const basePayload = (manifest = baseManifest()) => ({
  fileId: "file-1",
  mediaId: "media-1",
  quality: "1080p",
  formatId: "format-1",
  container: "mkv",
  expectedBytes: 1024 + 4096 * 2 + 512 + 1024 + 256,
  libraryId: "lib-test",
  manifest,
});

describe(SUITE, () => {
  let tempRoot: string;
  let registerCalls: Array<unknown[]> = [];
  let downloadCalls: Array<{ token: string; objectKey: string }> = [];

  beforeEach(() => {
    tempRoot = mkdtempSync(joinPath(tmpdir(), "spacefleet-offline-step-"));
    registerCalls = [];
    downloadCalls = [];
    runFfmpegMock.mockReset();
    // Default ffmpeg behaviour: create the final output file (empty placeholder)
    // and resolve. Tests override per-case for cancellation/failure.
    runFfmpegMock.mockImplementation(async (args: string[]) => {
      // Last arg is the output path.
      const outputPath = args[args.length - 1];
      await fsAsync.writeFile(outputPath, Buffer.from("mux-output-marker"));
      console.info(`[ffmpeg-mock] wrote stub mux output to ${outputPath} args=${args.length}`);
      return { stdout: "", stderr: "", code: 0 };
    });
    console.info(`[${SUITE}:setup] tempRoot=${tempRoot}`);
  });

  afterEach(() => {
    __resetBadgerOfflineDeps();
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[${SUITE}:teardown] rmSync failed:`, err);
    }
    console.info(`[${SUITE}:teardown] done`);
  });

  const installDeps = (overrides: Partial<BadgerOfflineDeps> = {}) => {
    const deps: BadgerOfflineDeps = {
      // RT-SEC-05: the credentials come from the runtime's memory, never from the job payload
      awaitCredentials: async () => ({ token: "test-token", libraryKeyBase64: "test-key-base64" }),
      downloadObject: async (token: string, objectKey: string) => {
        downloadCalls.push({ token, objectKey });
        // Encode a tiny deterministic plaintext per object key. The decrypt
        // step is mocked too, so the actual bytes don't have to be valid
        // AES-GCM ciphertext.
        return new Uint8Array(Buffer.from(`enc:${objectKey}`));
      },
      decrypt: (encrypted: Uint8Array, _key: string) => {
        // Strip the `enc:` prefix to model "decryption" deterministically.
        const text = Buffer.from(encrypted).toString("utf8");
        const stripped = text.startsWith("enc:") ? text.slice(4) : text;
        return Buffer.from(`plain:${stripped}`);
      },
      resolveOfflineDir: (libraryId: string) => joinPath(tempRoot, "offline", libraryId),
      registerLocalDownload: async (input) => {
        registerCalls.push([input]);
        return { inserted: 1 };
      },
      ...overrides,
    };
    configureBadgerOfflineDeps(deps);
  };

  it("happy path: downloads chunks, mux runs, atomic-renames out of staging, registers row", async () => {
    console.info(`[${SUITE}:happy] start`);
    installDeps();
    const manifest = baseManifest();
    const payload = basePayload(manifest);
    const job = makeJob({ payload: payload as unknown as Record<string, unknown> });
    const step = makeStep();
    const ctx = makeCtx(job, step);

    try {
      await offlineDownloadStepHandler(ctx);
      console.info(`[${SUITE}:happy] handler resolved`);

      // Staging dir should be cleaned up after success.
      const stagingDir = joinPath(tempRoot, "offline", "lib-test", `.tmp-${job.jobId}`);
      expect(existsSync(stagingDir)).toBe(false);

      // Final dir has exactly one file.
      const finalDir = joinPath(tempRoot, "offline", "lib-test");
      const finalContents = readdirSync(finalDir);
      expect(finalContents).toHaveLength(1);
      expect(finalContents[0]).toMatch(/The Test Movie \(2026\)\.mkv/);

      // Register hook was invoked with the expected shape.
      expect(registerCalls).toHaveLength(1);
      const [registerArg] = registerCalls[0] as [Record<string, unknown>];
      expect(registerArg.fileId).toBe("file-1");
      expect(registerArg.mediaId).toBe("media-1");
      expect(registerArg.quality).toBe("1080p");
      expect(registerArg.container).toBe("mkv");
      expect(registerArg.localPath).toBe(joinPath(finalDir, finalContents[0]));
      expect(typeof registerArg.totalBytes).toBe("number");
      expect(registerArg.totalBytes as number).toBeGreaterThan(0);

      // ffmpeg was called once.
      expect(runFfmpegMock).toHaveBeenCalledTimes(1);

      // downloadObject was called for every chunk + init.
      // 1 video init + 2 video chunks + 1 audio init + 1 audio chunk + 1 sub = 6
      expect(downloadCalls).toHaveLength(6);
      const keys = downloadCalls.map((c) => c.objectKey).sort();
      expect(keys).toEqual([
        "audio-chunk-0",
        "audio-init-0",
        "sub-eng-srt",
        "video-chunk-0",
        "video-chunk-1",
        "video-init-key",
      ]);

      // emitOutputs called with downloadResult.
      expect(ctx.recorded.outputs).toHaveLength(1);
      const downloadResult = ctx.recorded.outputs[0].downloadResult as {
        localPath: string;
        totalBytes: number;
        container: string;
        skippedSubsForContainer: string[];
      };
      expect(downloadResult.container).toBe("mkv");
      expect(downloadResult.skippedSubsForContainer).toEqual([]);
      expect(downloadResult.localPath).toBe(joinPath(finalDir, finalContents[0]));

      // Progress labels mention each phase.
      const labels = ctx.recorded.progress.map((p) => p[1]).filter(Boolean);
      expect(labels).toContain("Downloading video");
      expect(labels.some((l) => l?.includes("audio"))).toBe(true);
      expect(labels).toContain("Muxing tracks");
      // Final 100% emit.
      expect(ctx.recorded.progress.at(-1)?.[0]).toBe(100);
    } catch (err) {
      dumpSnapshot("happy", {
        recordedProgress: ctx.recorded.progress,
        recordedOutputs: ctx.recorded.outputs,
        registerCalls,
        downloadCalls,
        ffmpegCalls: runFfmpegMock.mock.calls,
        error: err,
      });
      throw err;
    }
  });

  // @req RT-SEC-05[runtime] the token and the library key come from the runtime's memory, not from the job payload
  it("downloads with the in-memory credentials while the persisted payload carries neither", async () => {
    const decryptKeys: string[] = [];
    installDeps({
      awaitCredentials: async () => ({ token: "memory-token", libraryKeyBase64: "memory-key" }),
      decrypt: (encrypted: Uint8Array, key: string) => {
        decryptKeys.push(key);
        return Buffer.from(encrypted);
      },
    });
    const payload = basePayload();
    expect(payload).not.toHaveProperty("token");
    expect(payload).not.toHaveProperty("libraryKeyBase64");
    const ctx = makeCtx(makeJob({ payload: payload as unknown as Record<string, unknown> }), makeStep());
    await offlineDownloadStepHandler(ctx);
    expect(downloadCalls.length).toBeGreaterThan(0);
    expect(downloadCalls.every((c) => c.token === "memory-token")).toBe(true);
    expect(decryptKeys.length).toBeGreaterThan(0);
    expect(decryptKeys.every((k) => k === "memory-key")).toBe(true);
  });

  it("fails with STEP_OFFLINE_DOWNLOAD_MISSING_TOKEN when the credentials never arrive, without downloading", async () => {
    installDeps({ awaitCredentials: async () => null });
    const ctx = makeCtx(makeJob({ payload: basePayload() as unknown as Record<string, unknown> }), makeStep());
    await expect(offlineDownloadStepHandler(ctx)).rejects.toThrow("STEP_OFFLINE_DOWNLOAD_MISSING_TOKEN");
    expect(downloadCalls).toHaveLength(0);
  });

  // A job resumed at boot runs before the desktop pushes the key: it waits for it instead of failing.
  it("awaitCredentials waits for the pushed token and key, and gives up with null when they never come", async () => {
    vi.useFakeTimers();
    try {
      let token: string | null = null;
      let key: string | null = null;
      const signal = new AbortController().signal;
      const awaitCredentials = createOfflineAwaitCredentials({
        resolveToken: () => token,
        resolveLibraryKey: () => key,
        authWaitMs: 2_000,
        authPollMs: 5,
      });
      const pending = awaitCredentials({ jobId: "j1", signal });
      await vi.advanceTimersByTimeAsync(20);
      token = "pushed-token";
      await vi.advanceTimersByTimeAsync(40);
      key = "pushed-key";
      await vi.advanceTimersByTimeAsync(20);
      await expect(pending).resolves.toEqual({ token: "pushed-token", libraryKeyBase64: "pushed-key" });

      const never = createOfflineAwaitCredentials({
        resolveToken: () => null,
        resolveLibraryKey: () => null,
        authWaitMs: 30,
        authPollMs: 5,
      });
      const expired = never({ jobId: "j2", signal });
      await vi.advanceTimersByTimeAsync(40);
      await expect(expired).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // Resume-aware behaviour: cancellation now PRESERVES the staging dir so a
  // retry can resume from the last persisted chunk. The sidecar at
  // `<staging>/.resume.json` records the orderIndex of completed chunks.
  it("cancellation mid-flight PRESERVES staging dir + sidecar (resume support); no DB row inserted", async () => {
    console.info(`[${SUITE}:cancel] start`);
    const controller = new AbortController();
    installDeps({
      downloadObject: async (token, objectKey) => {
        downloadCalls.push({ token, objectKey });
        // The mock receives the call BEFORE the bytes are decrypted +
        // appended. Aborting on call 3 means:
        //   1. video-init-key   → fully completed (downloaded → decrypted →
        //                         appended → sidecar updated [-1])
        //   2. video-chunk-0    → fully completed (downloaded → decrypted →
        //                         appended → sidecar updated [-1, 0])
        //   3. video-chunk-1    → controller.abort() fires inside this call;
        //                         downloadObject returns; the post-download
        //                         ensureNotAborted() throws CANCELLED before
        //                         decrypt + append + sidecar update can run.
        // Result: sidecar records [-1, 0] (init + chunk0), not chunk1.
        if (downloadCalls.length === 3) {
          controller.abort();
        }
        return new Uint8Array(Buffer.from(`enc:${objectKey}`));
      },
    });
    const manifest = baseManifest();
    const payload = basePayload(manifest);
    const job = makeJob({ payload: payload as unknown as Record<string, unknown> });
    const step = makeStep();
    const ctx = makeCtx(job, step, controller.signal);

    let caught: unknown = null;
    try {
      try {
        await offlineDownloadStepHandler(ctx);
      } catch (err) {
        caught = err;
      }
      console.info(`[${SUITE}:cancel] handler threw=${caught instanceof Error ? caught.message : String(caught)}`);
      expect(caught).toBeTruthy();
      expect(caught instanceof Error && caught.message).toBe("CANCELLED");

      // RESUME CHANGE: staging dir is now PRESERVED on cancel/fail.
      const stagingDir = joinPath(tempRoot, "offline", "lib-test", `.tmp-${job.jobId}`);
      expect(existsSync(stagingDir)).toBe(true);
      console.info(
        `[${SUITE}:cancel] staging preserved at ${stagingDir} — contents: ${JSON.stringify(readdirSync(stagingDir))}`
      );

      // Sidecar exists and is parseable.
      const sidecarPath = joinPath(stagingDir, ".resume.json");
      expect(existsSync(sidecarPath)).toBe(true);
      const sidecar = JSON.parse(
        await fsAsync.readFile(sidecarPath, "utf8")
      ) as {
        schemaVersion: number;
        jobId: string;
        outputs: Record<string, { completedOrderIndices: number[]; onDiskBytes: number }>;
      };
      expect(sidecar.schemaVersion).toBe(1);
      expect(sidecar.jobId).toBe(job.jobId);
      // The video output should have 2 completed entries: INIT_ORDER_INDEX (-1)
      // and chunk orderIndex 0 (the second downloaded object).
      const videoEntry = sidecar.outputs["video.mp4"];
      expect(videoEntry).toBeDefined();
      expect(videoEntry.completedOrderIndices.sort()).toEqual([-1, 0]);
      expect(videoEntry.onDiskBytes).toBeGreaterThan(0);

      // No final file was produced.
      const finalDir = joinPath(tempRoot, "offline", "lib-test");
      const finalContents = existsSync(finalDir)
        ? readdirSync(finalDir).filter((n) => !n.startsWith(".tmp-"))
        : [];
      expect(finalContents).toHaveLength(0);

      // registerLocalDownload was NOT called.
      expect(registerCalls).toHaveLength(0);
    } catch (err) {
      dumpSnapshot("cancel", {
        recordedProgress: ctx.recorded.progress,
        recordedOutputs: ctx.recorded.outputs,
        registerCalls,
        downloadCalls,
        ffmpegCalls: runFfmpegMock.mock.calls,
        error: err,
      });
      throw err;
    }
  });

  it("ffmpeg failure PRESERVES staging dir (resume support) + propagates error; no DB row written", async () => {
    console.info(`[${SUITE}:ffmpeg-fail] start`);
    installDeps();
    runFfmpegMock.mockReset();
    runFfmpegMock.mockRejectedValueOnce(new Error("ffmpeg crashed (synthetic)"));
    const manifest = baseManifest();
    const payload = basePayload(manifest);
    const job = makeJob({ payload: payload as unknown as Record<string, unknown> });
    const step = makeStep();
    const ctx = makeCtx(job, step);

    let caught: unknown = null;
    try {
      try {
        await offlineDownloadStepHandler(ctx);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeTruthy();
      expect(caught instanceof Error && caught.message).toBe("ffmpeg crashed (synthetic)");

      // RESUME CHANGE: staging dir is now PRESERVED on cancel/fail so a
      // mux-step retry doesn't have to re-download every chunk first.
      const stagingDir = joinPath(tempRoot, "offline", "lib-test", `.tmp-${job.jobId}`);
      expect(existsSync(stagingDir)).toBe(true);
      // Sidecar exists and recorded every chunk we downloaded before mux
      // (init + 2 chunks for video, init + 1 chunk for audio, 1 sub).
      const sidecar = JSON.parse(
        await fsAsync.readFile(joinPath(stagingDir, ".resume.json"), "utf8")
      ) as {
        outputs: Record<string, { completedOrderIndices: number[]; onDiskBytes: number }>;
      };
      const videoEntry = sidecar.outputs["video.mp4"];
      expect(videoEntry).toBeDefined();
      expect(videoEntry.completedOrderIndices.sort()).toEqual([-1, 0, 1]);

      const finalDir = joinPath(tempRoot, "offline", "lib-test");
      const finalContents = existsSync(finalDir)
        ? readdirSync(finalDir).filter((n) => !n.startsWith(".tmp-"))
        : [];
      expect(finalContents).toHaveLength(0);

      expect(registerCalls).toHaveLength(0);
    } catch (err) {
      dumpSnapshot("ffmpeg-fail", {
        recordedProgress: ctx.recorded.progress,
        recordedOutputs: ctx.recorded.outputs,
        registerCalls,
        downloadCalls,
        ffmpegCalls: runFfmpegMock.mock.calls,
        error: err,
      });
      throw err;
    }
  });

  it("MP4 container skips ASS subtitles and records them on skippedSubsForContainer", async () => {
    console.info(`[${SUITE}:mp4-skip-ass] start`);
    installDeps();
    const manifest = baseManifest();
    // Replace the SRT sub with one ASS (incompatible with MP4) + one SRT.
    manifest.subtitles = [
      {
        subtitleId: "sub-ass",
        language: "fre",
        label: "French ASS",
        format: "ass",
        objectKey: "sub-fre-ass",
        sizeBytes: 256,
        isDefault: false,
      },
      {
        subtitleId: "sub-srt",
        language: "eng",
        label: "English SRT",
        format: "srt",
        objectKey: "sub-eng-srt",
        sizeBytes: 256,
        isDefault: true,
      },
    ];
    const payload = { ...basePayload(manifest), container: "mp4" };
    const job = makeJob({ payload: payload as unknown as Record<string, unknown> });
    const step = makeStep();
    const ctx = makeCtx(job, step);

    try {
      await offlineDownloadStepHandler(ctx);
      const downloadResult = ctx.recorded.outputs[0]?.downloadResult as {
        skippedSubsForContainer: string[];
      };
      expect(downloadResult.skippedSubsForContainer).toEqual(["fre"]);
      // Only the SRT sub object was fetched; the ASS one was skipped.
      const subFetches = downloadCalls.filter((c) => c.objectKey.startsWith("sub-"));
      expect(subFetches.map((c) => c.objectKey)).toEqual(["sub-eng-srt"]);
      // Output file must be .mp4
      const finalDir = joinPath(tempRoot, "offline", "lib-test");
      const finalContents = readdirSync(finalDir);
      expect(finalContents[0]).toMatch(/\.mp4$/);
    } catch (err) {
      dumpSnapshot("mp4-skip-ass", {
        recordedProgress: ctx.recorded.progress,
        recordedOutputs: ctx.recorded.outputs,
        downloadCalls,
        ffmpegCalls: runFfmpegMock.mock.calls,
        error: err,
      });
      throw err;
    }
  });

  it("episode filename uses Show - S02E03 - Title.mkv format", async () => {
    console.info(`[${SUITE}:episode-name] start`);
    installDeps();
    const manifest = baseManifest();
    manifest.filenameInputs = {
      kind: "episode",
      showTitle: "Westworld",
      seasonNumber: 2,
      episodeNumber: 3,
      episodeTitle: "Virtù e Fortuna",
    };
    const payload = basePayload(manifest);
    const job = makeJob({ payload: payload as unknown as Record<string, unknown> });
    const step = makeStep();
    const ctx = makeCtx(job, step);

    try {
      await offlineDownloadStepHandler(ctx);
      const finalDir = joinPath(tempRoot, "offline", "lib-test");
      const finalContents = readdirSync(finalDir);
      expect(finalContents).toHaveLength(1);
      // The "ù" should be preserved (Unicode passthrough); ASCII spaces and
      // hyphens are part of the sanitizer-approved set.
      expect(finalContents[0]).toBe("Westworld - S02E03 - Virtù e Fortuna.mkv");
    } catch (err) {
      dumpSnapshot("episode-name", {
        finalDirContents: existsSync(joinPath(tempRoot, "offline", "lib-test"))
          ? readdirSync(joinPath(tempRoot, "offline", "lib-test"))
          : [],
        error: err,
      });
      throw err;
    }
  });

  it("filename collision appends ` (2)` before extension", async () => {
    console.info(`[${SUITE}:collision] start`);
    installDeps();
    const finalDir = joinPath(tempRoot, "offline", "lib-test");
    // Pre-create the offline dir + a colliding name.
    await fsAsync.mkdir(finalDir, { recursive: true });
    await fsAsync.writeFile(joinPath(finalDir, "The Test Movie (2026).mkv"), "preexisting");

    const manifest = baseManifest();
    const payload = basePayload(manifest);
    const job = makeJob({ payload: payload as unknown as Record<string, unknown> });
    const step = makeStep();
    const ctx = makeCtx(job, step);

    try {
      await offlineDownloadStepHandler(ctx);
      const finalContents = readdirSync(finalDir).sort();
      expect(finalContents).toContain("The Test Movie (2026).mkv");
      expect(finalContents).toContain("The Test Movie (2026) (2).mkv");
    } catch (err) {
      dumpSnapshot("collision", {
        finalDirContents: existsSync(finalDir) ? readdirSync(finalDir) : [],
        error: err,
      });
      throw err;
    }
  });

  // -------------------------------------------------------------------------
  // Resume-from-partial-download (v2 upgrade) tests
  // -------------------------------------------------------------------------

  /**
   * 5-chunk video manifest used by tests 3 + 4 to make the "pick up where we
   * left off" arithmetic obvious. No audio init / no audio chunks / no subs
   * so the test surface stays focused on the chunk-skip path. Audio is left
   * with a single track + chunk so the mux still has the same args shape as
   * baseManifest.
   */
  const fiveChunkVideoManifest = (): OfflineDownloadManifest => ({
    videoInitKey: "video-init",
    videoInitSize: 256,
    videoChunks: [
      { key: "video-chunk-0", sizeBytes: 1024, orderIndex: 0 },
      { key: "video-chunk-1", sizeBytes: 1024, orderIndex: 1 },
      { key: "video-chunk-2", sizeBytes: 1024, orderIndex: 2 },
      { key: "video-chunk-3", sizeBytes: 1024, orderIndex: 3 },
      { key: "video-chunk-4", sizeBytes: 1024, orderIndex: 4 },
    ],
    audioTracks: [],
    subtitles: [],
    filenameInputs: {
      kind: "movie",
      title: "Resume Test Movie",
      year: 2026,
    },
  });

  it("@bugfix @resume clean-run sidecar is created during flight and wiped with staging on success", async () => {
    console.info(`[${SUITE}:resume-clean] start`);
    installDeps();
    const manifest = fiveChunkVideoManifest();
    const payload = {
      ...basePayload(manifest),
      expectedBytes: 256 + 1024 * 5,
    };
    const job = makeJob({
      jobId: "resume-clean-job",
      payload: payload as unknown as Record<string, unknown>,
    });
    const step = makeStep({ jobId: "resume-clean-job", stepId: "resume-clean-job:offline_download" });
    const ctx = makeCtx(job, step);

    // We'll poke the sidecar during the run to prove it exists mid-flight.
    // The dep wrapper checks for the sidecar after the second download
    // call and verifies it contains the first chunk's orderIndex.
    let midflightSidecarSnapshot: unknown = null;
    const stagingDir = joinPath(tempRoot, "offline", "lib-test", `.tmp-${job.jobId}`);
    installDeps({
      downloadObject: async (token, objectKey) => {
        downloadCalls.push({ token, objectKey });
        if (downloadCalls.length === 2) {
          try {
            const raw = await fsAsync.readFile(
              joinPath(stagingDir, ".resume.json"),
              "utf8"
            );
            midflightSidecarSnapshot = JSON.parse(raw);
          } catch (err) {
            console.warn(`[${SUITE}:resume-clean] sidecar read failed mid-flight:`, err);
          }
        }
        return new Uint8Array(Buffer.from(`enc:${objectKey}`));
      },
    });

    try {
      await offlineDownloadStepHandler(ctx);
      // Mid-flight, the sidecar already had the first download recorded
      // (init segment under sentinel -1).
      expect(midflightSidecarSnapshot).toBeTruthy();
      const snap = midflightSidecarSnapshot as {
        schemaVersion: number;
        jobId: string;
        outputs: Record<string, { completedOrderIndices: number[] }>;
      };
      expect(snap.schemaVersion).toBe(1);
      expect(snap.jobId).toBe(job.jobId);
      expect(snap.outputs["video.mp4"]).toBeDefined();
      expect(snap.outputs["video.mp4"].completedOrderIndices).toEqual([-1]);

      // Post-success: staging dir + sidecar wiped together.
      expect(existsSync(stagingDir)).toBe(false);
      // Final file exists.
      const finalDir = joinPath(tempRoot, "offline", "lib-test");
      const finalContents = readdirSync(finalDir).filter((n) => !n.startsWith(".tmp-"));
      expect(finalContents).toHaveLength(1);
      expect(finalContents[0]).toMatch(/Resume Test Movie \(2026\)\.mkv/);
      expect(registerCalls).toHaveLength(1);
    } catch (err) {
      dumpSnapshot("resume-clean", {
        recordedProgress: ctx.recorded.progress,
        registerCalls,
        downloadCalls,
        error: err,
        extra: { midflightSidecarSnapshot },
      });
      throw err;
    }
  });

  it("@bugfix @resume mid-flight abort leaves sidecar with completed chunks recorded", async () => {
    console.info(`[${SUITE}:resume-abort] start`);
    const controller = new AbortController();
    // Plan: init + 2 chunks succeed → abort fires → chunks 3, 4 never start.
    // (download call sequence: 1 init + 5 chunks = 6 calls; abort on call 4
    // means we kept chunks 0 + 1 completed.)
    installDeps({
      downloadObject: async (token, objectKey) => {
        downloadCalls.push({ token, objectKey });
        if (downloadCalls.length === 4) {
          // 4th call = init done + chunk0 done + chunk1 done → about to
          // start chunk2; aborting now stops the loop before the next
          // chunk's bytes hit disk.
          controller.abort();
        }
        return new Uint8Array(Buffer.from(`enc:${objectKey}`));
      },
    });
    const manifest = fiveChunkVideoManifest();
    const payload = {
      ...basePayload(manifest),
      expectedBytes: 256 + 1024 * 5,
    };
    const job = makeJob({
      jobId: "resume-abort-job",
      payload: payload as unknown as Record<string, unknown>,
    });
    const step = makeStep({ jobId: "resume-abort-job", stepId: "resume-abort-job:offline_download" });
    const ctx = makeCtx(job, step, controller.signal);

    let caught: unknown = null;
    try {
      try {
        await offlineDownloadStepHandler(ctx);
      } catch (err) {
        caught = err;
      }
      expect(caught instanceof Error && caught.message).toBe("CANCELLED");

      const stagingDir = joinPath(tempRoot, "offline", "lib-test", `.tmp-${job.jobId}`);
      expect(existsSync(stagingDir)).toBe(true);
      const sidecar = JSON.parse(
        await fsAsync.readFile(joinPath(stagingDir, ".resume.json"), "utf8")
      ) as {
        outputs: Record<string, { completedOrderIndices: number[]; onDiskBytes: number }>;
      };
      // Init (-1) + 2 chunks (0, 1) all completed before abort.
      expect(sidecar.outputs["video.mp4"].completedOrderIndices.sort((a, b) => a - b)).toEqual([-1, 0, 1]);
      // Intermediate file has exactly init + 2 chunks worth of plaintext on
      // disk. Plaintext model in mocks is "plain:<objectKey>" → length:
      //   init      = "plain:video-init"     (16 chars)
      //   chunk 0   = "plain:video-chunk-0"  (19 chars)
      //   chunk 1   = "plain:video-chunk-1"  (19 chars)
      const expectedBytes = "plain:video-init".length +
        "plain:video-chunk-0".length +
        "plain:video-chunk-1".length;
      const videoStat = await fsAsync.stat(joinPath(stagingDir, "video.mp4"));
      expect(videoStat.size).toBe(expectedBytes);
      expect(sidecar.outputs["video.mp4"].onDiskBytes).toBe(expectedBytes);
    } catch (err) {
      dumpSnapshot("resume-abort", {
        recordedProgress: ctx.recorded.progress,
        registerCalls,
        downloadCalls,
        error: err,
      });
      throw err;
    }
  });

  it("@bugfix @resume RESUME picks up where left off — only missing chunks are fetched", async () => {
    console.info(`[${SUITE}:resume-pickup] start`);
    const manifest = fiveChunkVideoManifest();
    const payload = {
      ...basePayload(manifest),
      expectedBytes: 256 + 1024 * 5,
    };
    const job = makeJob({
      jobId: "resume-pickup-job",
      payload: payload as unknown as Record<string, unknown>,
    });
    const step = makeStep({ jobId: "resume-pickup-job", stepId: "resume-pickup-job:offline_download" });
    const ctx = makeCtx(job, step);

    // Pre-seed: write the staging dir + a video.mp4 with init + chunks 0+1
    // bytes + a matching sidecar.
    const stagingDir = joinPath(tempRoot, "offline", "lib-test", `.tmp-${job.jobId}`);
    await fsAsync.mkdir(stagingDir, { recursive: true });
    const initBytes = Buffer.from("plain:video-init");
    const chunk0Bytes = Buffer.from("plain:video-chunk-0");
    const chunk1Bytes = Buffer.from("plain:video-chunk-1");
    const preSeededVideo = Buffer.concat([initBytes, chunk0Bytes, chunk1Bytes]);
    await fsAsync.writeFile(joinPath(stagingDir, "video.mp4"), preSeededVideo);
    await fsAsync.writeFile(
      joinPath(stagingDir, ".resume.json"),
      JSON.stringify({
        schemaVersion: 1,
        jobId: job.jobId,
        outputs: {
          "video.mp4": {
            completedOrderIndices: [-1, 0, 1],
            onDiskBytes: preSeededVideo.length,
          },
        },
      })
    );
    console.info(
      `[${SUITE}:resume-pickup] pre-seeded staging=${stagingDir} bytes=${preSeededVideo.length}`
    );

    installDeps();

    try {
      await offlineDownloadStepHandler(ctx);
      // The download bridge MUST have skipped the pre-seeded keys:
      //   - video-init  (already on disk per sidecar)
      //   - video-chunk-0
      //   - video-chunk-1
      // and only fetched the remaining three.
      const fetched = downloadCalls.map((c) => c.objectKey).sort();
      expect(fetched).toEqual(["video-chunk-2", "video-chunk-3", "video-chunk-4"]);
      // Final muxed file exists.
      const finalDir = joinPath(tempRoot, "offline", "lib-test");
      const finalContents = readdirSync(finalDir).filter((n) => !n.startsWith(".tmp-"));
      expect(finalContents).toHaveLength(1);
      // Sidecar gone alongside staging dir.
      expect(existsSync(stagingDir)).toBe(false);
      expect(registerCalls).toHaveLength(1);
    } catch (err) {
      dumpSnapshot("resume-pickup", {
        recordedProgress: ctx.recorded.progress,
        registerCalls,
        downloadCalls,
        error: err,
      });
      throw err;
    }
  });

  it("@bugfix @resume sidecar corruption (size mismatch) forces clean restart and re-fetches everything", async () => {
    console.info(`[${SUITE}:resume-corrupt] start`);
    const manifest = fiveChunkVideoManifest();
    const payload = {
      ...basePayload(manifest),
      expectedBytes: 256 + 1024 * 5,
    };
    const job = makeJob({
      jobId: "resume-corrupt-job",
      payload: payload as unknown as Record<string, unknown>,
    });
    const step = makeStep({ jobId: "resume-corrupt-job", stepId: "resume-corrupt-job:offline_download" });
    const ctx = makeCtx(job, step);

    // Pre-seed: sidecar SAYS the intermediate has 100 bytes but the actual
    // file is 20 bytes (sidecar overstates → undersized intermediate →
    // hydrate returns "corrupt" → staging gets wiped + fresh run starts).
    const stagingDir = joinPath(tempRoot, "offline", "lib-test", `.tmp-${job.jobId}`);
    await fsAsync.mkdir(stagingDir, { recursive: true });
    await fsAsync.writeFile(joinPath(stagingDir, "video.mp4"), Buffer.alloc(20, 0xab));
    await fsAsync.writeFile(
      joinPath(stagingDir, ".resume.json"),
      JSON.stringify({
        schemaVersion: 1,
        jobId: job.jobId,
        outputs: {
          "video.mp4": {
            completedOrderIndices: [-1, 0, 1, 2, 3, 4],
            onDiskBytes: 100,
          },
        },
      })
    );

    installDeps();

    try {
      await offlineDownloadStepHandler(ctx);
      // EVERY chunk including init must have been re-fetched.
      const fetched = downloadCalls.map((c) => c.objectKey).sort();
      expect(fetched).toEqual([
        "video-chunk-0",
        "video-chunk-1",
        "video-chunk-2",
        "video-chunk-3",
        "video-chunk-4",
        "video-init",
      ]);
      // Final muxed file exists in the offline dir.
      const finalDir = joinPath(tempRoot, "offline", "lib-test");
      const finalContents = readdirSync(finalDir).filter((n) => !n.startsWith(".tmp-"));
      expect(finalContents).toHaveLength(1);
      // Sidecar + staging gone.
      expect(existsSync(stagingDir)).toBe(false);
      expect(registerCalls).toHaveLength(1);
    } catch (err) {
      dumpSnapshot("resume-corrupt", {
        recordedProgress: ctx.recorded.progress,
        registerCalls,
        downloadCalls,
        error: err,
      });
      throw err;
    }
  });
});

// Reference unused import to silence lint while keeping the import warm
// for potential future tests that inspect file stat output.
void statSync;
