/**
 * @req STOR-BW-01[badger-desktop]
 * @req STOR-BW-09[badger-desktop]
 * @req OFFL-AUTO-01
 *
 * While the merged traffic state is high a user-started offline download is SLOWED (average rate at or under
 * HIGH_TRAFFIC_DOWNLOAD_BYTES_PER_SEC after each object), shows it, never errors, and is back at full speed when the
 * state is normal again. While the silo serving its objects is saturated (the gateway gives an export zero bytes then)
 * it is held between chunks instead, shows it, and carries on by itself where it left off when the silo lifts; the hold
 * wins over the slowdown. Nothing fails either way. Neither starts, prefetches or re-queues anything on its own: they
 * only pace chunks of the job the user submitted.
 */

import { mkdtempSync, rmSync, promises as fsAsync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runFfmpegMock } = vi.hoisted(() => ({ runFfmpegMock: vi.fn() }));

vi.mock("@space/ffmpeg", () => ({
  runFfmpeg: runFfmpegMock,
  runFfprobe: vi.fn(),
  createFfmpegTask: vi.fn(),
}));

import { offlineDownloadStepHandler, type OfflineDownloadManifest } from "../src/modules/badger/steps/offlineDownload";
import type { StorageTraffic } from "@space/shared/storageTunnel";
import {
  HELD_SATURATED_STAGE_CODE,
  SLOWED_HIGH_TRAFFIC_STAGE_CODE,
} from "@space/shared/storageTrafficStage";
import {
  HELD_SATURATED_STAGE_LABEL,
  HIGH_TRAFFIC_DOWNLOAD_BYTES_PER_SEC,
  SLOWED_HIGH_TRAFFIC_STAGE_LABEL,
} from "../src/modules/badger/offlineTrafficGate";
import {
  __resetBadgerOfflineDeps,
  configureBadgerOfflineDeps,
  type BadgerOfflineDeps,
} from "../src/modules/badger/offlineDownloadDeps";
import type { StepHandlerCtx } from "../src/core/jobs/engineV2";
import type { IngestJobRecord } from "@space/runtime-jobs";
import type { StoredStepRecord } from "../src/core/jobs/stepStore";

const ts = "2026-01-01T00:00:00.000Z";
const POLL_MS = 60_000;

const makeJob = (payload: Record<string, unknown>): IngestJobRecord => ({
  jobId: "offline-job-1",
  app: "badger",
  kind: "download",
  lane: "upload",
  status: "running",
  stageCode: "running",
  stageLabel: "Running",
  progress: { mode: "fraction", completed: 0, total: 100, unit: "percent" },
  progressPct: 0,
  payload,
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

const manifest: OfflineDownloadManifest = {
  videoInitKey: "video-init-key",
  videoInitSize: 1024,
  videoChunks: [
    { key: "video-chunk-0", sizeBytes: 4096, orderIndex: 0 },
    { key: "video-chunk-1", sizeBytes: 4096, orderIndex: 1 },
    { key: "video-chunk-2", sizeBytes: 4096, orderIndex: 2 },
  ],
  audioTracks: [],
  subtitles: [],
  filenameInputs: { kind: "movie", title: "The Test Movie", year: 2026 },
};

const payload = {
  fileId: "file-1",
  mediaId: "media-1",
  quality: "1080p",
  formatId: "format-1",
  container: "mkv",
  expectedBytes: 1024 + 4096 * 3,
  libraryId: "lib-test",
  manifest,
};

const report = (overrides: Partial<StorageTraffic> = {}): StorageTraffic => ({
  state: "normal",
  playbackBufferSeconds: null,
  saturated: false,
  qualityCap: null,
  playbackStopped: false,
  ...overrides,
});

/** The fake ciphertext of `objectKey`, padded to exactly `totalBytes` so the pacing arithmetic is exact (0 = unpadded). */
const encryptedObject = (objectKey: string, totalBytes: number): Uint8Array => {
  const body = Buffer.from(`enc:${objectKey}`);
  return new Uint8Array(Buffer.concat([body, Buffer.alloc(Math.max(0, totalBytes - body.byteLength))]));
};

describe("offline download while its silo is saturated", () => {
  let tempRoot: string;
  let downloadCalls: string[];
  let callTimes: number[];
  let progress: Array<[number, string | undefined, string | undefined]>;
  let silo: Pick<StorageTraffic, "saturated">;
  let merged: StorageTraffic["state"];
  let objectBytes: number;
  let refreshCalls: number;
  let abort: AbortController;

  beforeEach(() => {
    vi.useFakeTimers();
    tempRoot = mkdtempSync(joinPath(tmpdir(), "spacefleet-offline-traffic-"));
    downloadCalls = [];
    callTimes = [];
    progress = [];
    waiters = [];
    refreshCalls = 0;
    silo = { saturated: false };
    merged = "normal";
    objectBytes = 0;
    abort = new AbortController();
    runFfmpegMock.mockReset();
    runFfmpegMock.mockImplementation(async (args: string[]) => {
      await fsAsync.writeFile(args[args.length - 1], Buffer.from("mux-output-marker"));
      return { stdout: "", stderr: "", code: 0 };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetBadgerOfflineDeps();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  /** `saturatedAt`: the silo saturates with the report of that download (1-based), as the gateway's `session.ack` would say. */
  const installDeps = (saturatedAt: number | null, overrides: Partial<BadgerOfflineDeps> = {}) => {
    configureBadgerOfflineDeps({
      awaitCredentials: async () => ({ token: "test-token", libraryKeyBase64: "test-key-base64" }),
      downloadObject: async (_token, objectKey, options) => {
        downloadCalls.push(objectKey);
        callTimes.push(Date.now());
        notify();
        if (saturatedAt !== null && downloadCalls.length === saturatedAt) silo = { saturated: true };
        options?.onTraffic?.(report({ ...silo, state: merged }));
        return encryptedObject(objectKey, objectBytes);
      },
      decrypt: (encrypted) => Buffer.from(`plain:${Buffer.from(encrypted).toString("utf8").slice(4)}`),
      resolveOfflineDir: (libraryId) => joinPath(tempRoot, "offline", libraryId),
      registerLocalDownload: async () => ({ inserted: 1 }),
      traffic: {
        current: () => ({ state: merged, playbackBufferSeconds: merged === "high" ? 30 : null, observedAt: Date.now() }),
        refresh: async () => {
          refreshCalls += 1;
          notify();
          return report({ ...silo, state: merged });
        },
      },
      ...overrides,
    });
  };

  const run = () => {
    const ctx: StepHandlerCtx = {
      job: makeJob(payload as unknown as Record<string, unknown>),
      step: makeStep(),
      signal: abort.signal,
      reportProgress: (pct, label, code) => {
        progress.push([pct, label, code]);
        notify();
      },
      emitOutputs: () => undefined,
    };
    return offlineDownloadStepHandler(ctx);
  };

  const heldReports = () => progress.filter((entry) => entry[2] === HELD_SATURATED_STAGE_CODE);
  const slowedReports = () => progress.filter((entry) => entry[2] === SLOWED_HIGH_TRAFFIC_STAGE_CODE);

  // Real file I/O completes outside the fake clock: wait on the events the code under test
  // emits (progress, downloads, refreshes) rather than on elapsed time.
  let waiters: Array<{ predicate: () => boolean; resolve: () => void }> = [];
  const notify = () => {
    waiters = waiters.filter((waiter) => {
      if (!waiter.predicate()) return true;
      waiter.resolve();
      return false;
    });
  };
  const until = (predicate: () => boolean): Promise<void> => {
    if (predicate()) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    waiters.push({ predicate, resolve });
    return promise;
  };
  // The pacing / polling sleeps are registered once the previous object's real file I/O has finished: yield to the
  // real event loop (fs is not faked) until one is pending, then move the fake clock.
  const timerPending = async (): Promise<void> => {
    while (vi.getTimerCount() === 0) await fsAsync.stat(tempRoot);
  };

  it("downloads straight through when the silo is not saturated", async () => {
    installDeps(null);
    await run();
    expect(downloadCalls).toEqual(["video-init-key", "video-chunk-0", "video-chunk-1", "video-chunk-2"]);
    expect(heldReports()).toEqual([]);
    expect(refreshCalls).toBe(0);
  });

  // Objects of 250 000 bytes at 500 000 bytes/s: each object earns 500 ms on the (fake) clock. The wait follows the
  // fetch, so after the k-th object the next one may start only once k * 500 ms have passed since the first began.
  const SLOW_OBJECT_BYTES = 250_000;
  const SLOW_OBJECT_MS = (SLOW_OBJECT_BYTES / HIGH_TRAFFIC_DOWNLOAD_BYTES_PER_SEC) * 1000;

  it("slows the download to the high-traffic rate, never holds or fails it, and shows the slowed stage", async () => {
    expect(HIGH_TRAFFIC_DOWNLOAD_BYTES_PER_SEC).toBe(500_000);
    merged = "high";
    objectBytes = SLOW_OBJECT_BYTES;
    installDeps(null);
    const done = run();
    for (let fetched = 1; fetched <= 4; fetched += 1) {
      await until(() => downloadCalls.length === fetched);
      await timerPending();
      await vi.advanceTimersByTimeAsync(SLOW_OBJECT_MS - 1);
      // The next object is not asked for before its share of the time has passed.
      expect(downloadCalls).toHaveLength(fetched);
      await vi.advanceTimersByTimeAsync(1);
    }
    await done;
    expect(downloadCalls).toEqual(["video-init-key", "video-chunk-0", "video-chunk-1", "video-chunk-2"]);
    callTimes.forEach((time, index) => expect(time - callTimes[0]).toBe(index * SLOW_OBJECT_MS));
    // Shown as slowed (the stage is kept while the download's own progress reports come in); the held notice is for
    // saturation only and nothing was polled.
    expect(slowedReports().length).toBeGreaterThan(0);
    expect(slowedReports().every((entry) => entry[1] === SLOWED_HIGH_TRAFFIC_STAGE_LABEL)).toBe(true);
    expect(heldReports()).toEqual([]);
    expect(refreshCalls).toBe(0);
  });

  it("keeps the slowed stage shown while the download's own progress reports come in", async () => {
    merged = "high";
    objectBytes = SLOW_OBJECT_BYTES;
    installDeps(null);
    const done = run();
    for (let fetched = 1; fetched <= 4; fetched += 1) {
      await until(() => downloadCalls.length === fetched);
      await timerPending();
      await vi.advanceTimersByTimeAsync(SLOW_OBJECT_MS);
    }
    await done;
    const firstSlowedAt = progress.findIndex((entry) => entry[2] === SLOWED_HIGH_TRAFFIC_STAGE_CODE);
    const downloadingStages = progress.slice(firstSlowedAt).filter((entry) => entry[2] === "downloading");
    expect(downloadingStages).toEqual([]);
  });

  it("goes back to full speed and to the previous stage when traffic is normal again", async () => {
    merged = "high";
    objectBytes = SLOW_OBJECT_BYTES;
    installDeps(null, {
      downloadObject: async (_token, objectKey, options) => {
        downloadCalls.push(objectKey);
        callTimes.push(Date.now());
        notify();
        // Traffic is back to normal with the second object.
        if (downloadCalls.length === 2) merged = "normal";
        options?.onTraffic?.(report({ state: merged }));
        return encryptedObject(objectKey, objectBytes);
      },
    });
    const done = run();
    await until(() => downloadCalls.length === 1);
    await timerPending();
    await vi.advanceTimersByTimeAsync(SLOW_OBJECT_MS);
    // No more time is given: everything after the second object runs at full speed.
    await done;
    expect(downloadCalls).toHaveLength(4);
    expect(callTimes[1] - callTimes[0]).toBe(SLOW_OBJECT_MS);
    expect(callTimes[2]).toBe(callTimes[1]);
    expect(callTimes[3]).toBe(callTimes[1]);
    expect(slowedReports().length).toBeGreaterThan(0);
    const slowedAt = progress.findLastIndex((entry) => entry[2] === SLOWED_HIGH_TRAFFIC_STAGE_CODE);
    expect(progress[slowedAt + 1]?.[2]).toBe("downloading");
    expect(heldReports()).toEqual([]);
  });

  it("is not slowed while traffic is normal", async () => {
    objectBytes = SLOW_OBJECT_BYTES;
    installDeps(null);
    await run();
    expect(downloadCalls).toHaveLength(4);
    expect(new Set(callTimes).size).toBe(1);
    expect(slowedReports()).toEqual([]);
  });

  it("the saturated hold wins over the slowdown while both apply, and the slowed stage returns when it lifts", async () => {
    merged = "high";
    objectBytes = SLOW_OBJECT_BYTES;
    installDeps(2);
    const done = run();
    await until(() => downloadCalls.length === 1);
    await timerPending();
    await vi.advanceTimersByTimeAsync(SLOW_OBJECT_MS);
    // The second object's report says saturated while the merged state is still high.
    await until(() => heldReports().length >= 1);
    // The slowdown wait of the second object ends (its own progress report keeps the hold shown); the hold then polls the silo.
    await timerPending();
    await vi.advanceTimersByTimeAsync(SLOW_OBJECT_MS);
    await timerPending();
    const heldAt = progress.findIndex((entry) => entry[2] === HELD_SATURATED_STAGE_CODE);
    expect(progress.slice(heldAt).filter((entry) => entry[2] === SLOWED_HIGH_TRAFFIC_STAGE_CODE)).toEqual([]);
    // The silo has lifted by the next poll.
    silo = { saturated: false };
    await timerPending();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await until(() => refreshCalls === 1);
    await until(() => downloadCalls.length === 3);
    // Still high, no longer saturated: the shown stage is the slowed one again.
    const lastHeldAt = progress.findLastIndex((entry) => entry[2] === HELD_SATURATED_STAGE_CODE);
    expect(progress[lastHeldAt + 1]?.[2]).toBe(SLOWED_HIGH_TRAFFIC_STAGE_CODE);
    for (let fetched = 3; fetched <= 4; fetched += 1) {
      await until(() => downloadCalls.length === fetched);
      await timerPending();
      await vi.advanceTimersByTimeAsync(SLOW_OBJECT_MS);
    }
    await done;
    expect(downloadCalls).toHaveLength(4);
    expect(heldReports().length).toBeGreaterThan(0);
  });

  it("holds between chunks while the silo is saturated, polls it at most once a minute, and carries on when it lifts", async () => {
    installDeps(2);
    const done = run();
    // Init + chunk 0 downloaded; the silo saturated with chunk 0's report.
    await until(() => heldReports().length === 1);
    expect(downloadCalls).toEqual(["video-init-key", "video-chunk-0"]);

    await timerPending();
    await vi.advanceTimersByTimeAsync(POLL_MS - 1);
    expect(refreshCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await until(() => refreshCalls === 1);
    expect(downloadCalls).toHaveLength(2);

    await timerPending();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await until(() => refreshCalls === 2);
    expect(downloadCalls).toHaveLength(2);

    silo = { saturated: false };
    await timerPending();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await done;

    expect(downloadCalls).toEqual(["video-init-key", "video-chunk-0", "video-chunk-1", "video-chunk-2"]);
    // Nothing failed or restarted while held: the hold stage stays shown, with its own label, until it lifts.
    expect(heldReports().length).toBeGreaterThan(0);
    expect(heldReports().every((entry) => entry[1] === HELD_SATURATED_STAGE_LABEL)).toBe(true);
    const lastHeldAt = progress.findLastIndex((entry) => entry[2] === HELD_SATURATED_STAGE_CODE);
    // The stage that was running before the hold is shown again once it lifts.
    expect(progress[lastHeldAt + 1]?.[2]).toBe("downloading");
  });

  it("shows the hold of a read the gateway withholds, and clears it from the report that comes with the first bytes", async () => {
    const release = Promise.withResolvers<void>();
    installDeps(null, {
      downloadObject: async (_token, objectKey, options) => {
        downloadCalls.push(objectKey);
        notify();
        if (downloadCalls.length === 2) {
          options?.onTraffic?.(report({ saturated: true }));
          await release.promise;
          options?.onTraffic?.(report({ saturated: false }));
        }
        return new Uint8Array(Buffer.from(`enc:${objectKey}`));
      },
    });
    const done = run();
    await until(() => heldReports().length === 1);
    expect(downloadCalls).toEqual(["video-init-key", "video-chunk-0"]);
    release.resolve();
    await done;
    expect(refreshCalls).toBe(0);
    expect(downloadCalls).toHaveLength(4);
    expect(heldReports()).toHaveLength(1);
  });

  it("does not hold when the silo's report is unknown", async () => {
    installDeps(2, {
      traffic: {
        current: () => ({ state: "normal", playbackBufferSeconds: null, observedAt: Date.now() }),
        refresh: async () => {
          refreshCalls += 1;
          // The silo's report is unknown from now on (the later objects' acks no longer say saturated either).
          silo = { saturated: false };
          notify();
          return null;
        },
      },
    });
    const done = run();
    await until(() => heldReports().length === 1);
    await timerPending();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await done;
    expect(refreshCalls).toBe(1);
    expect(downloadCalls).toHaveLength(4);
  });

  it("stops waiting when the job is cancelled while held, without fetching anything more", async () => {
    installDeps(1);
    const done = run();
    await until(() => heldReports().length === 1);
    abort.abort();
    await expect(done).rejects.toThrow("CANCELLED");
    expect(downloadCalls).toEqual(["video-init-key"]);
  });

  /** The object download of the `throwOn`-th call (1-based) throws a tunnel read timeout, as a withheld flow does. */
  const installThrowingDeps = (throwOn: number) => {
    installDeps(null, {
      downloadObject: async (_token, objectKey, options) => {
        downloadCalls.push(objectKey);
        notify();
        if (downloadCalls.length === throwOn) {
          silo = { saturated: true };
          throw new Error("ws_read_timeout");
        }
        options?.onTraffic?.(report({ ...silo }));
        return encryptedObject(objectKey, objectBytes);
      },
    });
  };

  it("holds an object whose download times out while the silo is saturated, retries it when it lifts, and does not fail", async () => {
    installThrowingDeps(2);
    const done = run();
    await until(() => heldReports().length === 1);
    // The throw refreshed the silo's report once; nothing is fetched meanwhile.
    expect(downloadCalls).toEqual(["video-init-key", "video-chunk-0"]);
    expect(refreshCalls).toBe(1);

    await timerPending();
    await vi.advanceTimersByTimeAsync(POLL_MS - 1);
    expect(refreshCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await until(() => refreshCalls === 2);
    expect(downloadCalls).toHaveLength(2);

    silo = { saturated: false };
    await timerPending();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await done;

    // The same object is retried, then the rest follow.
    expect(downloadCalls).toEqual(["video-init-key", "video-chunk-0", "video-chunk-0", "video-chunk-1", "video-chunk-2"]);
    expect(heldReports().every((entry) => entry[1] === HELD_SATURATED_STAGE_LABEL)).toBe(true);
  });

  it("still fails when a download throws while the silo is not saturated", async () => {
    installDeps(null, {
      downloadObject: async (_token, objectKey) => {
        downloadCalls.push(objectKey);
        if (downloadCalls.length === 2) throw new Error("ws_read_timeout");
        return encryptedObject(objectKey, objectBytes);
      },
    });
    await expect(run()).rejects.toThrow("ws_read_timeout");
    expect(downloadCalls).toEqual(["video-init-key", "video-chunk-0"]);
    expect(refreshCalls).toBe(1);
    expect(heldReports()).toEqual([]);
  });

  it("stops waiting when the job is cancelled while held after a timed-out download, without retrying", async () => {
    installThrowingDeps(2);
    const done = run();
    await until(() => heldReports().length === 1);
    abort.abort();
    await expect(done).rejects.toThrow("CANCELLED");
    expect(downloadCalls).toEqual(["video-init-key", "video-chunk-0"]);
  });

  it("OFFL-AUTO-01: carrying on after a hold fetches only the submitted job's own remaining chunks", async () => {
    installDeps(2);
    const done = run();
    await until(() => heldReports().length === 1);
    silo = { saturated: false };
    await timerPending();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await done;
    const submitted = new Set(["video-init-key", ...manifest.videoChunks.map((chunk) => chunk.key)]);
    expect(downloadCalls.every((key) => submitted.has(key))).toBe(true);
    expect(new Set(downloadCalls).size).toBe(downloadCalls.length);
  });
});
