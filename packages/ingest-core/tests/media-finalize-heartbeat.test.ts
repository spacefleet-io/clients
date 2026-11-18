/**
 * @bugfix @regression-proof
 *
 * Round-10 — heartbeat logging in `finalizeMediaJob`.
 *
 * Symptom: a fresh source ingest reached extract 99% with 257 progress
 * events in ~75s, then went silent for 10+ minutes with zero progress
 * and no errors. We had no signal which sub-phase of `finalizeMediaJob`
 * was hung — `collectUploadTotals`, the upload `Promise.all`, or the
 * post-upload `stateStore.save`.
 *
 * Fix: each sub-phase emits a `[finalize] <label> start` line at entry
 * and `[finalize] <label> done in Nms` at exit via `console.info`. Logs
 * land in `/tmp/spacefleet-runtime/runtime.log` automatically, so any
 * future hang narrows down to the last `start` line without a `done`.
 *
 * This test asserts the log shape and ordering rather than wall-clock
 * durations (which are non-deterministic).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { ResumableJobStateStore } from "@space/content-core";
import { UploadSessionManager } from "@space/content-core/storageTransport";
import { finalizeMediaJob } from "../src/mediaFinalize";

const SUITE = "media-finalize-heartbeat";

const dumpHeartbeatSnapshot = (
  label: string,
  ctx: {
    jobDir?: string;
    finalizeLines?: ReadonlyArray<string>;
    expectedPhases?: ReadonlyArray<string>;
    startOrder?: ReadonlyArray<string>;
    uploadStart?: string;
  },
) => {
  try {
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    if (ctx.jobDir) console.error(`job dir: ${ctx.jobDir}`);
    if (ctx.finalizeLines) {
      console.error(
        `heartbeat tick count (finalize lines)=${ctx.finalizeLines.length}\n${JSON.stringify(ctx.finalizeLines, null, 2)}`,
      );
      const lastLine = ctx.finalizeLines[ctx.finalizeLines.length - 1];
      console.error(`last finalize line: ${JSON.stringify(lastLine)}`);
    }
    if (ctx.expectedPhases) {
      console.error(`expected phases: ${JSON.stringify(ctx.expectedPhases)}`);
    }
    if (ctx.startOrder) {
      console.error(`observed start order: ${JSON.stringify(ctx.startOrder)}`);
    }
    if (typeof ctx.uploadStart === "string") {
      console.error(`uploadStart line: ${JSON.stringify(ctx.uploadStart)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("@bugfix @regression-proof Round-10 — finalizeMediaJob heartbeat logging", () => {
  let root = "";
  let infoSpy: MockInstance<typeof console.info>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sf-finalize-heartbeat-"));
    console.info(`[${SUITE}:setup] temp root=${root}`);
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
    console.info(`[${SUITE}:teardown] removing temp root=${root}`);
    rmSync(root, { recursive: true, force: true });
    vi.resetModules();
  });

  const finalizeLines = (): string[] =>
    infoSpy.mock.calls
      .map((call) => String(call[0] ?? ""))
      .filter((line) => line.startsWith("[finalize] "));

  const setupFixture = async (jobName: string) => {
    const jobDir = join(root, jobName);
    console.info(`[${SUITE}:setup] fixture jobDir=${jobDir} — preparing 1 video + 1 audio output`);
    await fs.mkdir(join(jobDir, "video"), { recursive: true });
    await fs.mkdir(join(jobDir, "audio"), { recursive: true });
    await fs.writeFile(join(jobDir, "input.mp4"), "input");
    await fs.writeFile(join(jobDir, "video", "init.m4s"), "video-init");
    await fs.writeFile(join(jobDir, "video", "seg-1.m4s"), "video-seg");
    await fs.writeFile(join(jobDir, "audio", "init.m4s"), "audio-init");
    await fs.writeFile(join(jobDir, "audio", "seg-1.m4s"), "audio-seg");

    const stateStore = await ResumableJobStateStore.open({
      jobDir,
      inputPath: join(jobDir, "input.mp4"),
      userId: "user-1",
    });
    const state = stateStore.getState();
    state.outputs.push(
      {
        id: "video-source",
        kind: "video",
        quality: "1080p",
        codec: "h264",
        codecString: "avc1.640028",
        segmentSeconds: 12,
        outputDir: join(jobDir, "video"),
        init: { path: join(jobDir, "video", "init.m4s") },
        segments: [{ path: join(jobDir, "video", "seg-1.m4s"), startSeconds: 0 }],
        durationSeconds: 60,
        encodingComplete: true,
      },
      {
        id: "audio-0",
        kind: "audio",
        quality: "audio",
        codec: "aac",
        segmentSeconds: 12,
        outputDir: join(jobDir, "audio"),
        init: { path: join(jobDir, "audio", "init.m4s") },
        segments: [{ path: join(jobDir, "audio", "seg-1.m4s"), startSeconds: 0 }],
        durationSeconds: 60,
        language: "eng",
        label: "Main",
        encodingComplete: true,
      }
    );
    await stateStore.save();
    return { jobDir, stateStore, state };
  };

  it("emits start+done heartbeat lines for each sub-phase", async () => {
    const { jobDir, stateStore, state } = await setupFixture("job-heartbeat");
    console.info(`[${SUITE}:run] invoking finalizeMediaJob for jobDir=${jobDir}`);

    await finalizeMediaJob({
      stateStore,
      placementId: "placement-heartbeat",
      state,
      sessionManager: new UploadSessionManager(stateStore),
      subtitleStates: [],
      audioStreamCount: 1,
      includeAudio: true,
      inputPath: join(jobDir, "input.mp4"),
      jobDir,
      durationSeconds: 60,
      chapterBoundaries: [],
      onUploadProgress: () => {},
      headObjects: async () => ({}),
      uploadFile: async (filePath) => {
        const bytes = await fs.readFile(filePath);
        return {
          key: `k-${filePath.split("/").pop()}`,
          sizeBytes: bytes.length,
          checksum: "c",
        };
      },
    });

    const lines = finalizeLines();
    console.info(`[${SUITE}:assert] captured ${lines.length} [finalize] heartbeat lines`);
    const expectedPhases = [
      "stateStore.save#pre-upload",
      "collectUploadTotals",
      "upload(",
      "stateStore.save#post-upload",
      "buildProducedMedia",
    ];
    for (const phase of expectedPhases) {
      const startLines = lines.filter((l) => l.includes(`${phase}`) && l.endsWith(" start"));
      const doneLines = lines.filter((l) => l.includes(`${phase}`) && / done in \d+ms$/.test(l));
      if (startLines.length !== 1 || doneLines.length !== 1) {
        dumpHeartbeatSnapshot("phase-missing", { jobDir, finalizeLines: lines, expectedPhases });
      }
      expect(startLines).toHaveLength(1);
      expect(doneLines).toHaveLength(1);
    }

    const startSequence = lines.filter((l) => l.endsWith(" start"));
    const startOrder = startSequence.map((line) => {
      for (const phase of expectedPhases) {
        if (line.includes(phase)) return phase;
      }
      return line;
    });
    if (JSON.stringify(startOrder) !== JSON.stringify(expectedPhases)) {
      dumpHeartbeatSnapshot("phase-order-mismatch", { jobDir, finalizeLines: lines, expectedPhases, startOrder });
    }
    expect(startOrder).toEqual(expectedPhases);
    console.info(`[${SUITE}:assert] all ${expectedPhases.length} phases emitted start+done in order`);
  });

  it("upload phase label encodes the chunk count for live debugging", async () => {
    const { jobDir, stateStore, state } = await setupFixture("job-chunk-count");
    console.info(`[${SUITE}:run] invoking finalizeMediaJob for jobDir=${jobDir} (chunk-count test)`);

    await finalizeMediaJob({
      stateStore,
      placementId: "placement-heartbeat",
      state,
      sessionManager: new UploadSessionManager(stateStore),
      subtitleStates: [],
      audioStreamCount: 1,
      includeAudio: true,
      inputPath: join(jobDir, "input.mp4"),
      jobDir,
      durationSeconds: 60,
      chapterBoundaries: [],
      onUploadProgress: () => {},
      headObjects: async () => ({}),
      uploadFile: async (filePath) => {
        const bytes = await fs.readFile(filePath);
        return {
          key: `k-${filePath.split("/").pop()}`,
          sizeBytes: bytes.length,
          checksum: "c",
        };
      },
    });

    const lines = finalizeLines();
    console.info(`[${SUITE}:assert] captured ${lines.length} heartbeat lines for chunk-count assertion`);
    // 4 uploads queued (video init, video seg, audio init, audio seg).
    const uploadStart = lines.find((l) => l.startsWith("[finalize] upload(") && l.endsWith(" start"));
    if (!uploadStart || !/upload\(\d+_chunks\) start$/.test(uploadStart) || !uploadStart.includes("upload(4_chunks)")) {
      dumpHeartbeatSnapshot("upload-label-mismatch", { jobDir, finalizeLines: lines, uploadStart: uploadStart ?? "(undefined)" });
    }
    expect(uploadStart).toBeDefined();
    expect(uploadStart).toMatch(/upload\(\d+_chunks\) start$/);
    expect(uploadStart).toContain("upload(4_chunks)");
  });
});
