/**
 * Step-handler tests for `offlineDownloadStepHandler` (OFFL-FILE-03): "Save offline" copies the title's storage
 * objects as stored (sealed SFV1, never decrypted) into the offline piece store, writes the item manifest, then records
 * the `media_local_downloads` row (schema_version 2, container "pieces", local_path = manifest).
 *
 * The storage bridge and the DB hook are stubbed through `configureBadgerOfflineDeps`; pieces land in a per-test temp
 * dir. Every test logs phase markers and dumps a snapshot on failure.
 */

import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  offlinePiecePath,
  offlinePieceItemPath,
  readOfflinePieceManifest,
} from "@space/library-db-runtime/offlinePieceStore";
import { parseOfflineDiskSpaceError } from "@space/shared/offlineDiskSpace";
import { offlineDownloadStepHandler } from "../src/modules/badger/steps/offlineDownload";
import {
  configureBadgerOfflineDeps,
  createOfflineAwaitCredentials,
  __resetBadgerOfflineDeps,
  FREE_DISK_SAFETY_MARGIN_BYTES,
  type BadgerOfflineDeps,
} from "../src/modules/badger/offlineDownloadDeps";
import type { StepHandlerCtx } from "@space/runtime-jobs-engine/engineV2";
import type { IngestJobRecord } from "@space/runtime-jobs";
import type { StoredStepRecord } from "@space/runtime-jobs-engine/stepStore";
import type { OfflineDownloadManifest } from "../src/modules/badger/steps/offlineDownload";

const SUITE = "badger-offline-download-step";

const listTree = (dir: string, prefix = ""): string[] => {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listTree(joinPath(dir, entry.name), rel));
    else out.push(rel);
  }
  return out.sort();
};

const dumpSnapshot = (label: string, ctx: Record<string, unknown>) => {
  console.error(`=== [${SUITE}:${label}] snapshot ===`);
  for (const [k, v] of Object.entries(ctx)) {
    if (v instanceof Error) console.error(`${k}: ${v.name}: ${v.message}\n${v.stack ?? ""}`);
    else console.error(`${k}: ${JSON.stringify(v, null, 2)}`);
  }
  console.error(`=== [${SUITE}:${label}] end snapshot ===`);
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

const makeStep = (): StoredStepRecord => ({
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
});

const makeCtx = (job: IngestJobRecord, signal: AbortSignal = new AbortController().signal) => {
  const recorded = { progress: [] as Array<[number, string?, string?]>, outputs: [] as Array<Record<string, unknown>> };
  const ctx: StepHandlerCtx & { recorded: typeof recorded } = {
    job,
    step: makeStep(),
    signal,
    reportProgress: (pct, label, code) => {
      recorded.progress.push([pct, label, code]);
    },
    emitOutputs: (out) => {
      recorded.outputs.push(out);
    },
    recorded,
  };
  return ctx;
};

// Sizes match the sealed stub bytes `sealed:<key>` so the totals are checkable.
const sealedBytes = (key: string) => new Uint8Array(Buffer.from(`sealed:${key}`));
const sz = (key: string) => sealedBytes(key).byteLength;

const baseManifest = (): OfflineDownloadManifest => ({
  videoInitKey: "video-init-key",
  videoInitSize: sz("video-init-key"),
  videoChunks: [
    { key: "video-chunk-1", sizeBytes: sz("video-chunk-1"), orderIndex: 1, startSeconds: 6 },
    { key: "video-chunk-0", sizeBytes: sz("video-chunk-0"), orderIndex: 0, startSeconds: 0 },
  ],
  video: { codecString: "avc1.640028", bitrateKbps: 4000, durationSeconds: 12 },
  audioTracks: [
    {
      trackId: "audio-0",
      language: "eng",
      label: "English",
      isDefault: true,
      initKey: "audio-init-0",
      initSize: sz("audio-init-0"),
      chunks: [{ key: "audio-chunk-0", sizeBytes: sz("audio-chunk-0"), orderIndex: 0, startSeconds: 0 }],
      codecString: "mp4a.40.2",
      durationSeconds: 12,
    },
    {
      trackId: "audio-1",
      language: "fra",
      label: "Français",
      isDefault: false,
      initKey: "audio-init-1",
      initSize: sz("audio-init-1"),
      chunks: [{ key: "audio-chunk-1", sizeBytes: sz("audio-chunk-1"), orderIndex: 0, startSeconds: 0 }],
    },
  ],
  subtitles: [
    { subtitleId: "sub-0", language: "eng", label: "English", format: "srt", objectKey: "sub-eng", sizeBytes: sz("sub-eng"), isDefault: true },
    { subtitleId: "sub-1", language: "fra", label: "Français", format: "ass", objectKey: "sub-fra", sizeBytes: sz("sub-fra"), isDefault: false },
  ],
  filenameInputs: { kind: "movie", title: "The Test Movie", year: 2026 },
});

const ALL_KEYS = [
  "audio-chunk-0",
  "audio-chunk-1",
  "audio-init-0",
  "audio-init-1",
  "sub-eng",
  "sub-fra",
  "video-chunk-0",
  "video-chunk-1",
  "video-init-key",
];

const basePayload = (extra: Record<string, unknown> = {}, manifest = baseManifest()) => ({
  fileId: "file-1",
  mediaId: "media-1",
  quality: "1080p",
  formatId: "format-1",
  libraryId: "lib-test",
  manifest,
  ...extra,
});

describe(SUITE, () => {
  let tempRoot: string;
  let offlineRoot: string;
  let registerCalls: Array<Parameters<BadgerOfflineDeps["registerLocalDownload"]>[0]> = [];
  let downloadCalls: Array<{ token: string; objectKey: string }> = [];
  let decryptCalls = 0;

  beforeEach(() => {
    tempRoot = mkdtempSync(joinPath(tmpdir(), "spacefleet-offline-step-"));
    offlineRoot = joinPath(tempRoot, "offline", "lib-test");
    registerCalls = [];
    downloadCalls = [];
    decryptCalls = 0;
    console.info(`[${SUITE}:setup] tempRoot=${tempRoot}`);
  });

  afterEach(() => {
    __resetBadgerOfflineDeps();
    rmSync(tempRoot, { recursive: true, force: true });
    console.info(`[${SUITE}:teardown] done`);
  });

  const installDeps = (overrides: Partial<BadgerOfflineDeps> = {}) => {
    const deps: BadgerOfflineDeps = {
      // RT-SEC-05: the credentials come from the runtime's memory, never from the job payload
      awaitCredentials: async () => ({ token: "test-token", libraryKeyBase64: "test-key-base64" }),
      downloadObject: async (token, objectKey) => {
        downloadCalls.push({ token, objectKey });
        return sealedBytes(objectKey);
      },
      decrypt: (encrypted) => {
        decryptCalls += 1;
        return Buffer.from(encrypted);
      },
      resolveOfflineDir: (libraryId) => joinPath(tempRoot, "offline", libraryId),
      freeDiskBytes: async () => 10 * 1024 * 1024 * 1024,
      registerLocalDownload: async (input) => {
        registerCalls.push(input);
        return { inserted: 1 };
      },
      ...overrides,
    };
    configureBadgerOfflineDeps(deps);
  };

  // @req OFFL-FILE-03[runtime] the sealed objects are kept as stored, each apart, plus the item manifest
  it("stores every sealed object as is, writes the manifest, then registers a pieces row", async () => {
    installDeps();
    const ctx = makeCtx(makeJob({ payload: basePayload() }));
    try {
      console.info(`[${SUITE}:happy] phase=run`);
      await offlineDownloadStepHandler(ctx);
      const tree = listTree(offlineRoot);
      console.info(`[${SUITE}:happy] phase=assert tree=${JSON.stringify(tree)}`);

      expect(decryptCalls).toBe(0);
      expect(downloadCalls.map((c) => c.objectKey).sort()).toEqual(ALL_KEYS);
      expect(downloadCalls.every((c) => c.token === "test-token")).toBe(true);
      for (const key of ALL_KEYS) {
        expect(readFileSync(offlinePiecePath(offlineRoot, key)).toString("utf8")).toBe(`sealed:${key}`);
      }
      // objects/ holds the 9 pieces, items/ the one manifest; no .part, no plain file.
      expect(tree.filter((p) => p.startsWith("objects/"))).toHaveLength(ALL_KEYS.length);
      expect(tree.filter((p) => p.startsWith("items/"))).toHaveLength(1);
      expect(tree.some((p) => p.endsWith(".part") || /\.(mkv|mp4)$/.test(p))).toBe(false);

      const manifestPath = offlinePieceItemPath(offlineRoot, "file-1");
      const manifest = await readOfflinePieceManifest(manifestPath);
      console.info(`[${SUITE}:happy] manifest=${JSON.stringify(manifest)}`);
      const totalBytes = ALL_KEYS.reduce((sum, k) => sum + sz(k), 0);
      expect(manifest).toMatchObject({
        version: 2,
        fileId: "file-1",
        mediaId: "media-1",
        formatId: "format-1",
        quality: "1080p",
        totalBytes,
        video: {
          id: "format-1",
          bitrateKbps: 4000,
          track: {
            initKey: "video-init-key",
            codecString: "avc1.640028",
            durationSeconds: 12,
            chunks: [
              { key: "video-chunk-0", startSeconds: 0 },
              { key: "video-chunk-1", startSeconds: 6 },
            ],
          },
        },
      });
      expect(manifest.audio.map((a) => [a.id, a.language, a.isDefault, a.track.initKey])).toEqual([
        ["audio-0", "eng", true, "audio-init-0"],
        ["audio-1", "fra", false, "audio-init-1"],
      ]);
      expect(manifest.audio[1].track.codecString).toBeNull();
      // Pieces keep every subtitle, ASS included (no container to refuse it).
      expect(manifest.subtitles.map((s) => s.objectKey)).toEqual(["sub-eng", "sub-fra"]);
      expect(manifest.objects.map((o) => o.key).sort()).toEqual(ALL_KEYS);

      expect(registerCalls).toHaveLength(1);
      expect(registerCalls[0]).toMatchObject({
        fileId: "file-1",
        mediaId: "media-1",
        quality: "1080p",
        formatId: "format-1",
        container: "pieces",
        localPath: manifestPath,
        totalBytes,
        runtimeJobId: "offline-job-1",
        schemaVersion: 2,
      });
      expect(ctx.recorded.outputs).toEqual([
        { downloadResult: { localPath: manifestPath, totalBytes, container: "pieces", skippedSubsForContainer: [] } },
      ]);
      expect(ctx.recorded.progress.at(-1)?.[0]).toBe(100);
      expect(ctx.recorded.progress.some(([, label]) => label === "Downloading video")).toBe(true);
    } catch (err) {
      dumpSnapshot("happy", { tree: listTree(offlineRoot), downloadCalls, registerCalls, progress: ctx.recorded.progress, err });
      throw err;
    }
  });

  it("fetches a key listed twice only once", async () => {
    installDeps();
    const manifest = baseManifest();
    manifest.subtitles.push({ ...manifest.subtitles[0], subtitleId: "sub-dup" });
    await offlineDownloadStepHandler(makeCtx(makeJob({ payload: basePayload({}, manifest) })));
    console.info(`[${SUITE}:dedupe] downloads=${JSON.stringify(downloadCalls.map((c) => c.objectKey))}`);
    expect(downloadCalls.filter((c) => c.objectKey === "sub-eng")).toHaveLength(1);
  });

  // @req RT-SEC-05[runtime] the token comes from the runtime's memory, not from the job payload
  it("fails with STEP_OFFLINE_DOWNLOAD_MISSING_TOKEN when the credentials never arrive, without downloading", async () => {
    installDeps({ awaitCredentials: async () => null });
    const payload = basePayload();
    expect(payload).not.toHaveProperty("token");
    await expect(offlineDownloadStepHandler(makeCtx(makeJob({ payload })))).rejects.toThrow(
      "STEP_OFFLINE_DOWNLOAD_MISSING_TOKEN"
    );
    expect(downloadCalls).toHaveLength(0);
    expect(registerCalls).toHaveLength(0);
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

  // @req OFFL-SAFE-01[runtime] a partial save is not counted: no manifest, no row; finished pieces stay for a retry
  it("cancel mid-flight keeps the finished pieces and writes no manifest and no row", async () => {
    const controller = new AbortController();
    installDeps({
      downloadObject: async (token, objectKey) => {
        downloadCalls.push({ token, objectKey });
        if (downloadCalls.length === 3) controller.abort();
        return sealedBytes(objectKey);
      },
    });
    const ctx = makeCtx(makeJob({ payload: basePayload() }), controller.signal);
    await expect(offlineDownloadStepHandler(ctx)).rejects.toThrow("CANCELLED");
    const tree = listTree(offlineRoot);
    console.info(`[${SUITE}:cancel] downloads=${downloadCalls.length} tree=${JSON.stringify(tree)}`);
    expect(existsSync(offlinePieceItemPath(offlineRoot, "file-1"))).toBe(false);
    expect(registerCalls).toHaveLength(0);
    expect(ctx.recorded.outputs).toHaveLength(0);
    // The two pieces written before the abort are kept; the third was fetched as the abort landed and is not written.
    expect(tree.filter((p) => p.startsWith("objects/") && !p.endsWith(".part"))).toHaveLength(2);
  });

  it("a retry fetches only the pieces not here yet", async () => {
    installDeps();
    mkdirSync(joinPath(offlineRoot, "objects"), { recursive: true });
    for (const key of ["video-init-key", "video-chunk-0", "audio-init-0"]) {
      writeFileSync(offlinePiecePath(offlineRoot, key), sealedBytes(key));
    }
    await offlineDownloadStepHandler(makeCtx(makeJob({ payload: basePayload() })));
    const fetched = downloadCalls.map((c) => c.objectKey).sort();
    console.info(`[${SUITE}:resume] fetched=${JSON.stringify(fetched)}`);
    expect(fetched).toEqual(ALL_KEYS.filter((k) => !["video-init-key", "video-chunk-0", "audio-init-0"].includes(k)));
    expect(registerCalls).toHaveLength(1);
  });

  // @req OFFL-SAFE-02[runtime] the save is refused before anything is fetched when the missing pieces do not fit
  it("refuses with the structured disk-space error before any download when the pieces do not fit", async () => {
    const missing = ALL_KEYS.reduce((sum, k) => sum + sz(k), 0);
    const free = missing + FREE_DISK_SAFETY_MARGIN_BYTES - 1;
    let credentialsAsked = false;
    installDeps({
      freeDiskBytes: async () => free,
      awaitCredentials: async () => {
        credentialsAsked = true;
        return { token: "t", libraryKeyBase64: "k" };
      },
    });
    let error: unknown;
    try {
      await offlineDownloadStepHandler(makeCtx(makeJob({ payload: basePayload() })));
    } catch (err) {
      error = err;
    }
    console.info(`[${SUITE}:space] error=${error instanceof Error ? error.message : String(error)}`);
    expect(parseOfflineDiskSpaceError(error instanceof Error ? error.message : null)).toEqual({
      requiredBytes: missing,
      freeBytes: free,
    });
    expect(credentialsAsked).toBe(false);
    expect(downloadCalls).toHaveLength(0);
    expect(listTree(offlineRoot)).toEqual([]);
  });

  it("needs no free space when every piece is already here", async () => {
    installDeps();
    mkdirSync(joinPath(offlineRoot, "objects"), { recursive: true });
    for (const key of ALL_KEYS) writeFileSync(offlinePiecePath(offlineRoot, key), sealedBytes(key));
    installDeps({ freeDiskBytes: async () => 0 });
    await offlineDownloadStepHandler(makeCtx(makeJob({ payload: basePayload() })));
    expect(downloadCalls).toHaveLength(0);
    expect(registerCalls).toHaveLength(1);
  });

  // @req OFFL-MIGR-01[runtime] the old plain file goes once the pieces are recorded, only from inside the offline dir
  it("removes the legacy plain file inside the offline dir after the row is recorded", async () => {
    mkdirSync(offlineRoot, { recursive: true });
    const legacy = joinPath(offlineRoot, "The Test Movie (2026).mkv");
    writeFileSync(legacy, "plain");
    installDeps({
      registerLocalDownload: async (input) => {
        console.info(`[${SUITE}:legacy] register sees legacy present=${existsSync(legacy)}`);
        expect(existsSync(legacy)).toBe(true);
        registerCalls.push(input);
        return { inserted: 1 };
      },
    });
    await offlineDownloadStepHandler(makeCtx(makeJob({ payload: basePayload({ legacyLocalPath: legacy }) })));
    expect(registerCalls).toHaveLength(1);
    expect(existsSync(legacy)).toBe(false);
  });

  it("leaves a legacy path outside the offline dir alone", async () => {
    const outside = joinPath(tempRoot, "Movies", "export.mkv");
    mkdirSync(joinPath(tempRoot, "Movies"), { recursive: true });
    writeFileSync(outside, "user export");
    installDeps();
    await offlineDownloadStepHandler(makeCtx(makeJob({ payload: basePayload({ legacyLocalPath: outside }) })));
    console.info(`[${SUITE}:legacy-outside] exists=${existsSync(outside)}`);
    expect(existsSync(outside)).toBe(true);
    expect(registerCalls).toHaveLength(1);
  });

  it("fails with STEP_OFFLINE_DOWNLOAD_NO_VIDEO_CHUNKS when the format has no video", async () => {
    installDeps();
    const manifest = baseManifest();
    manifest.videoChunks = [];
    await expect(
      offlineDownloadStepHandler(makeCtx(makeJob({ payload: basePayload({}, manifest) })))
    ).rejects.toThrow("STEP_OFFLINE_DOWNLOAD_NO_VIDEO_CHUNKS");
    expect(downloadCalls).toHaveLength(0);
  });
});
