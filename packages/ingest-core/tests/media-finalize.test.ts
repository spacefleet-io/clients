import { mkdtempSync, rmSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResumableJobStateStore } from "@space/content-core";
import { UploadSessionManager } from "@space/content-core/storageTransport";
import { finalizeMediaJob } from "../src/mediaFinalize";

const SUITE = "media-finalize";

const dumpFinalizeSnapshot = (
  label: string,
  ctx: {
    jobDir?: string;
    outputs?: ReadonlyArray<unknown>;
    produced?: unknown;
    audioTracks?: ReadonlyArray<unknown>;
    expectedLabels?: ReadonlyArray<string>;
    actualLabels?: ReadonlyArray<string | null | undefined>;
  },
) => {
  try {
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    if (ctx.jobDir) {
      console.error(`job dir: ${ctx.jobDir}`);
    }
    if (ctx.outputs) {
      console.error(`outputs registered on state (${ctx.outputs.length}):\n${JSON.stringify(ctx.outputs, null, 2)}`);
    }
    if (ctx.produced !== undefined) {
      console.error(`produced manifest:\n${JSON.stringify(ctx.produced, null, 2)}`);
    }
    if (ctx.audioTracks) {
      console.error(`audio tracks produced (${ctx.audioTracks.length}):\n${JSON.stringify(ctx.audioTracks, null, 2)}`);
    }
    if (ctx.expectedLabels) {
      console.error(`expected labels: ${JSON.stringify(ctx.expectedLabels)}`);
    }
    if (ctx.actualLabels) {
      console.error(`actual labels: ${JSON.stringify(ctx.actualLabels)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("media finalize", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sf-media-finalize-"));
    console.info(`[${SUITE}:setup] created temp root=${root}`);
  });

  afterEach(() => {
    console.info(`[${SUITE}:teardown] removing temp root=${root}`);
    rmSync(root, { recursive: true, force: true });
    vi.resetModules();
  });

  it("@bugfix @regression-proof uses Audio fallback only when output.label is undefined, preserves actual labels", async () => {
    const jobDir = join(root, "job-labels");
    console.info(`[${SUITE}:setup] job dir=${jobDir} — creating audio-ja (label="Japanese") + audio-en (label undefined)`);
    await fs.mkdir(join(jobDir, "audio-ja"), { recursive: true });
    await fs.mkdir(join(jobDir, "audio-en"), { recursive: true });
    await fs.writeFile(join(jobDir, "input.mp4"), "input");
    await fs.writeFile(join(jobDir, "audio-ja", "init.m4s"), "ja-init");
    await fs.writeFile(join(jobDir, "audio-ja", "seg-1.m4s"), "ja-seg");
    await fs.writeFile(join(jobDir, "audio-en", "init.m4s"), "en-init");
    await fs.writeFile(join(jobDir, "audio-en", "seg-1.m4s"), "en-seg");

    console.info(`[${SUITE}:setup] opening ResumableJobStateStore`);
    const stateStore = await ResumableJobStateStore.open({
      jobDir,
      inputPath: join(jobDir, "input.mp4"),
      userId: "user-1",
    });
    const state = stateStore.getState();
    state.outputs.push(
      {
        id: "audio-ja",
        kind: "audio",
        codec: "aac",
        segmentSeconds: 12,
        outputDir: join(jobDir, "audio-ja"),
        init: { path: join(jobDir, "audio-ja", "init.m4s") },
        segments: [{ path: join(jobDir, "audio-ja", "seg-1.m4s") }],
        language: "ja",
        label: "Japanese",
        encodingComplete: true,
      },
      {
        id: "audio-en",
        kind: "audio",
        codec: "aac",
        segmentSeconds: 12,
        outputDir: join(jobDir, "audio-en"),
        init: { path: join(jobDir, "audio-en", "init.m4s") },
        segments: [{ path: join(jobDir, "audio-en", "seg-1.m4s") }],
        language: "en",
        // label intentionally omitted — tests the fallback
        encodingComplete: true,
      }
    );
    console.info(`[${SUITE}:setup] state.outputs registered (${state.outputs.length}): ja-with-label + en-without-label`);
    await stateStore.save();

    const sessionManager = new UploadSessionManager(stateStore);
    console.info(`[${SUITE}:exec] calling finalizeMediaJob (audioStreamCount=2, includeAudio=true, duration=60s)`);
    const produced = await finalizeMediaJob({
      stateStore,
      placementId: "placement-finalize",
      state,
      sessionManager,
      subtitleStates: [],
      audioStreamCount: 2,
      includeAudio: true,
      inputPath: join(jobDir, "input.mp4"),
      jobDir,
      durationSeconds: 60,
      chapterBoundaries: [],
      onUploadProgress: () => {},
      // Fresh job: nothing is uploaded yet, so there is nothing to verify.
      headObjects: async () => ({}),
      uploadFile: async (filePath) => {
        const bytes = await fs.readFile(filePath);
        return { key: `key-${filePath.split("/").pop()}`, sizeBytes: bytes.length, checksum: "c" };
      },
    });
    const actualLabels = produced.audioTracks.map((t) => t.label);
    console.info(`[${SUITE}:exec] finalizeMediaJob produced ${produced.audioTracks.length} audio tracks; labels=${JSON.stringify(actualLabels)}`);

    try {
      // Track with explicit label should preserve it
      expect(produced.audioTracks[0].label).toBe("Japanese");
      // Track without label now falls back to language.toUpperCase()
      expect(produced.audioTracks[1].label).toBe("EN");
    } catch (err) {
      dumpFinalizeSnapshot("audio-label-fallback-mismatch", {
        jobDir,
        outputs: state.outputs,
        produced,
        audioTracks: produced.audioTracks,
        expectedLabels: ["Japanese", "EN"],
        actualLabels,
      });
      throw err;
    }
  });
});
