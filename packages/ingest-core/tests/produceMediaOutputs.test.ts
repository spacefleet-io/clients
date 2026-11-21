/**
 * @bugfix @regression-proof
 *
 * Phase F split — `produceMediaOutputs` (encode-only entrypoint).
 *
 * Carve invariant: `produceMediaOutputs` runs ffprobe + every requested
 * ffmpeg encode and writes DASH segments to disk via
 * `ResumableJobStateStore`, but **never** uploads, never encrypts a chunk,
 * and never flips `segments[].uploaded`. The store's `uploaded === false`
 * is the per-chunk idempotency key the upload step reads.
 *
 * This test pins:
 *  - source-only run produces a `video-source` output with `uploaded:false`
 *    on every segment + init
 *  - source + fallback produces both video outputs (source + 360p)
 *  - mixed audio/subtitle tracks land in state with the right id shape
 *  - chapters from the probe are preserved on the video-source output
 *  - per-track audio/subtitle ordering matches the probe's stream order
 *  - `job_state.json` is written and parses cleanly
 *  - `produced` returned from `produceMediaOutputs` has empty chunks (the
 *    pre-upload metadata-only view)
 */

import { mkdtempSync, rmSync, promises as fs } from "node:fs";
import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SUITE = "produceMediaOutputs";

const dumpProduceSnapshot = (
  label: string,
  ctx: {
    outputSpec?: unknown;
    stateOutputs?: ReadonlyArray<unknown>;
    stateSubtitles?: ReadonlyArray<unknown>;
    producedFiles?: ReadonlyArray<{ path: string; size: number | "missing" }>;
    warnings?: ReadonlyArray<string>;
    stagesObserved?: ReadonlyArray<string>;
  },
) => {
  try {
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    if (ctx.outputSpec !== undefined) {
      console.error(`requested output spec:\n${JSON.stringify(ctx.outputSpec, null, 2)}`);
    }
    if (ctx.stateOutputs) {
      console.error(
        `state.outputs (${ctx.stateOutputs.length}):\n${JSON.stringify(ctx.stateOutputs, null, 2)}`,
      );
    }
    if (ctx.stateSubtitles) {
      console.error(
        `state.subtitles (${ctx.stateSubtitles.length}):\n${JSON.stringify(ctx.stateSubtitles, null, 2)}`,
      );
    }
    if (ctx.producedFiles) {
      console.error(
        `produced files on disk (${ctx.producedFiles.length}):\n${JSON.stringify(ctx.producedFiles, null, 2)}`,
      );
    }
    if (ctx.warnings) {
      console.error(`warnings (${ctx.warnings.length}):\n${JSON.stringify(ctx.warnings, null, 2)}`);
    }
    if (ctx.stagesObserved) {
      console.error(`progress stages observed: ${JSON.stringify(ctx.stagesObserved)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

const inspectFiles = (paths: ReadonlyArray<string>) =>
  paths.map((p) => ({ path: p, size: existsSync(p) ? statSync(p).size : ("missing" as const) }));

const runFfprobeMock = vi.fn();
const runFfmpegMock = vi.fn();
const createFfmpegTaskMock = vi.fn();

vi.mock("@space/ffmpeg", () => ({
  runFfprobe: runFfprobeMock,
  runFfmpeg: runFfmpegMock,
  createFfmpegTask: createFfmpegTaskMock,
}));

const setupDashOutput = async (mpdPath: string, codecType: "video" | "audio") => {
  await fs.mkdir(dirname(mpdPath), { recursive: true });
  await fs.writeFile(join(dirname(mpdPath), "init-0.mp4"), "init");
  await fs.writeFile(join(dirname(mpdPath), "seg-00001.m4s"), "seg-1");
  await fs.writeFile(join(dirname(mpdPath), "seg-00002.m4s"), "seg-2");
  await fs.writeFile(join(dirname(mpdPath), "seg-00003.m4s"), "seg-3");
  const codecs = codecType === "video" ? "avc1.640028" : "mp4a.40.2";
  await fs.writeFile(
    mpdPath,
    [
      `<MPD><Period><AdaptationSet contentType="${codecType}" codecs="${codecs}">`,
      '<SegmentTemplate timescale="1">',
      "<SegmentTimeline>",
      '<S t="0" d="12" />',
      '<S d="12" />',
      '<S d="12" />',
      "</SegmentTimeline>",
      "</SegmentTemplate>",
      "</AdaptationSet></Period></MPD>",
    ].join("")
  );
};

const setupSubtitleOutput = async (subtitlePath: string) => {
  await fs.mkdir(dirname(subtitlePath), { recursive: true });
  await fs.writeFile(subtitlePath, "1\n00:00:01,000 --> 00:00:02,000\nSub line\n");
};

describe("produceMediaOutputs (encode-only entrypoint)", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sf-produce-outputs-"));
    console.info(`[${SUITE}:setup] temp root=${root}`);
    runFfprobeMock.mockReset();
    runFfmpegMock.mockReset();
    createFfmpegTaskMock.mockReset();
    runFfmpegMock.mockResolvedValue({ stdout: "", stderr: "" });
    createFfmpegTaskMock.mockImplementation((args: string[]) => {
      // Subtitle extraction uses the LAST positional arg as the output file
      // (not an `.mpd`). Detect that shape first.
      const last = args[args.length - 1];
      const isSubtitle = typeof last === "string" && /subtitle-\d+\.\w+$/.test(last);
      if (isSubtitle) {
        const promise = setupSubtitleOutput(last).then(() => ({ stdout: "", stderr: "" }));
        return { promise, cancel: vi.fn() };
      }
      const mpdPath = args.find((value) => value.endsWith(".mpd")) ?? last;
      const codecType = args.some((value) => value === "0:v:0") ? "video" : "audio";
      const promise = setupDashOutput(mpdPath, codecType).then(() => ({ stdout: "", stderr: "" }));
      return { promise, cancel: vi.fn() };
    });
  });

  afterEach(() => {
    console.info(`[${SUITE}:teardown] removing temp root=${root}`);
    rmSync(root, { recursive: true, force: true });
  });

  it("source-only run never flips segments[].uploaded; job_state.json is written", async () => {
    const outputSpec = {
      userId: "u1",
      jobId: "j-source-only",
      includeSource: true,
      includeFallback: false,
      includeAudio: true,
      includeSubtitles: false,
      includeChapters: false,
    };
    console.info(`[${SUITE}:source-only:setup] spec=${JSON.stringify(outputSpec)}`);
    const { configureMediaIngestRuntime, produceMediaOutputs } = await import(
      "../src/mediaProcessor"
    );
    configureMediaIngestRuntime({
      resolveJobDir: (userId, jobId) => join(root, "jobs", userId, jobId),
      encryptMediaObject: vi.fn(() => {
        throw new Error("encryptMediaObject must NOT be called by produceMediaOutputs");
      }),
      uploadStorageObject: vi.fn(async () => {
        throw new Error("uploadStorageObject must NOT be called by produceMediaOutputs");
      }),
    });

    runFfprobeMock.mockResolvedValue({
      streams: [
        { codec_type: "video", codec_name: "h264", width: 1920, height: 1080 },
        { codec_type: "audio", codec_name: "aac", tags: { language: "eng" } },
      ],
      data: { format: { duration: "120" }, chapters: [] },
    });

    console.info(`[${SUITE}:source-only:run] invoking produceMediaOutputs`);
    const result = await produceMediaOutputs({
      userId: "u1",
      jobId: "j-source-only",
      inputPath: "/tmp/movie.mkv",
      includeSource: true,
      includeFallback: false,
      includeAudio: true,
      includeSubtitles: false,
      includeChapters: false,
    });

    const state = result.stateStore.getState();
    console.info(
      `[${SUITE}:source-only:assert] state.outputs=${state.outputs.length} state.subtitles=${state.subtitles.length}`,
    );
    const sourceOutput = state.outputs.find((o) => o.id === "video-source");
    if (!sourceOutput) {
      dumpProduceSnapshot("source-only-no-source-output", { outputSpec, stateOutputs: state.outputs });
    }
    expect(sourceOutput).toBeDefined();
    expect(sourceOutput!.segments.length).toBeGreaterThan(0);
    const uploadedSegment = sourceOutput!.segments.find((s) => s.uploaded === true);
    if (uploadedSegment) {
      dumpProduceSnapshot("source-only-segment-uploaded-true", {
        outputSpec,
        stateOutputs: state.outputs,
        producedFiles: inspectFiles(sourceOutput!.segments.map((s) => s.path)),
      });
    }
    for (const segment of sourceOutput!.segments) {
      expect(segment.uploaded).toBe(false);
      expect(segment.key).toBeUndefined();
    }
    expect(sourceOutput!.init?.uploaded).toBeFalsy();

    const audioOutput = state.outputs.find((o) => o.id === "audio-0");
    expect(audioOutput).toBeDefined();
    for (const segment of audioOutput!.segments) {
      expect(segment.uploaded).toBe(false);
    }

    // job_state.json must be on disk and parseable.
    const stateOnDisk = await fs.readFile(
      join(root, "jobs", "u1", "j-source-only", "job_state.json"),
      "utf8"
    );
    const parsed = JSON.parse(stateOnDisk);
    expect(parsed.outputs).toBeDefined();
    expect(parsed.outputs.find((o: any) => o.id === "video-source")).toBeDefined();

    // produced view is metadata-only; chunks are empty.
    if (
      result.produced.videoFormats.length !== 1 ||
      result.produced.videoFormats[0].chunks.length !== 0 ||
      result.produced.audioTracks.length !== 1
    ) {
      dumpProduceSnapshot("source-only-produced-shape", { outputSpec, stateOutputs: state.outputs });
    }
    expect(result.produced.videoFormats).toHaveLength(1);
    expect(result.produced.videoFormats[0].chunks).toEqual([]);
    expect(result.produced.audioTracks).toHaveLength(1);
    expect(result.produced.audioTracks[0].chunks).toEqual([]);
  });

  it("source + fallback produces both video outputs with all uploaded:false", async () => {
    console.info(`[${SUITE}:source-plus-fb:setup] expecting source + 360p fallback outputs`);
    const { configureMediaIngestRuntime, produceMediaOutputs } = await import(
      "../src/mediaProcessor"
    );
    configureMediaIngestRuntime({
      resolveJobDir: (userId, jobId) => join(root, "jobs", userId, jobId),
      encryptMediaObject: vi.fn(() => Buffer.alloc(0)),
      uploadStorageObject: vi.fn(async () => "would-not-run"),
    });

    runFfprobeMock.mockResolvedValue({
      streams: [
        { codec_type: "video", codec_name: "h264", width: 1920, height: 1080 },
        { codec_type: "audio", codec_name: "aac", tags: { language: "eng" } },
      ],
      data: { format: { duration: "60" }, chapters: [] },
    });

    const result = await produceMediaOutputs({
      userId: "u1",
      jobId: "j-source-plus-fb",
      inputPath: "/tmp/movie.mkv",
      includeSource: true,
      includeFallback: true,
      includeAudio: true,
      includeSubtitles: false,
      includeChapters: false,
    });

    const state = result.stateStore.getState();
    console.info(`[${SUITE}:source-plus-fb:assert] state.outputs=${state.outputs.length}`);
    const sourceOutput = state.outputs.find((o) => o.id === "video-source");
    const fallbackOutput = state.outputs.find((o) => o.id === "video-360p-h264");
    if (!sourceOutput || !fallbackOutput) {
      dumpProduceSnapshot("source-plus-fb-missing-output", {
        outputSpec: { includeSource: true, includeFallback: true, includeAudio: true },
        stateOutputs: state.outputs,
      });
    }
    expect(sourceOutput).toBeDefined();
    expect(fallbackOutput).toBeDefined();
    for (const segment of sourceOutput!.segments) {
      expect(segment.uploaded).toBe(false);
    }
    for (const segment of fallbackOutput!.segments) {
      expect(segment.uploaded).toBe(false);
    }
    expect(fallbackOutput!.quality).toBe("360p");
    expect(fallbackOutput!.codec).toBe("h264");
  });

  it("preserves chapter boundaries on the source video output", async () => {
    console.info(`[${SUITE}:chapters:setup] feeding ffprobe 3-chapter data`);
    const { configureMediaIngestRuntime, produceMediaOutputs } = await import(
      "../src/mediaProcessor"
    );
    configureMediaIngestRuntime({
      resolveJobDir: (userId, jobId) => join(root, "jobs", userId, jobId),
      encryptMediaObject: vi.fn(() => Buffer.alloc(0)),
      uploadStorageObject: vi.fn(async () => "would-not-run"),
    });

    runFfprobeMock.mockResolvedValue({
      streams: [
        { codec_type: "video", codec_name: "h264", width: 1920, height: 1080 },
        { codec_type: "audio", codec_name: "aac", tags: { language: "eng" } },
      ],
      data: {
        format: { duration: "5400" },
        chapters: [
          { start_time: "0", tags: { title: "Cold open" } },
          { start_time: "300", tags: { title: "Act 1" } },
          { start_time: "1800", tags: { title: "Act 2" } },
        ],
      },
    });

    const result = await produceMediaOutputs({
      userId: "u1",
      jobId: "j-with-chapters",
      inputPath: "/tmp/movie.mkv",
      includeSource: true,
      includeFallback: false,
      includeAudio: true,
      includeSubtitles: false,
      includeChapters: true,
    });

    const state = result.stateStore.getState();
    const sourceOutput = state.outputs.find((o) => o.id === "video-source");
    console.info(`[${SUITE}:chapters:assert] chapters=${JSON.stringify(sourceOutput?.chapters)}`);
    if (sourceOutput?.chapters?.length !== 3) {
      dumpProduceSnapshot("chapters-wrong-count", {
        outputSpec: { includeChapters: true },
        stateOutputs: state.outputs,
      });
    }
    expect(sourceOutput?.chapters).toHaveLength(3);
    expect(sourceOutput?.chapters?.[0]).toEqual({
      title: "Cold open",
      startSeconds: 0,
    });
    expect(sourceOutput?.chapters?.[1]).toEqual({
      title: "Act 1",
      startSeconds: 300,
    });
  });

  it("mixed audio + subtitle tracks land in state with correct id ordering", async () => {
    console.info(`[${SUITE}:mixed-tracks:setup] 3 audios + 2 subtitles in stream order`);
    const { configureMediaIngestRuntime, produceMediaOutputs } = await import(
      "../src/mediaProcessor"
    );
    configureMediaIngestRuntime({
      resolveJobDir: (userId, jobId) => join(root, "jobs", userId, jobId),
      encryptMediaObject: vi.fn(() => Buffer.alloc(0)),
      uploadStorageObject: vi.fn(async () => "would-not-run"),
    });

    runFfprobeMock.mockResolvedValue({
      streams: [
        { codec_type: "video", codec_name: "h264", width: 1920, height: 1080 },
        { codec_type: "audio", codec_name: "aac", tags: { language: "eng", title: "Main" } },
        { codec_type: "audio", codec_name: "aac", tags: { language: "fra", title: "VF" } },
        { codec_type: "audio", codec_name: "ac3", tags: { language: "jpn", title: "OG" } },
        { codec_type: "subtitle", codec_name: "subrip", tags: { language: "eng", title: "EN" } },
        { codec_type: "subtitle", codec_name: "subrip", tags: { language: "fra", title: "FR" } },
      ],
      data: { format: { duration: "120" }, chapters: [] },
    });

    const result = await produceMediaOutputs({
      userId: "u1",
      jobId: "j-multi-track",
      inputPath: "/tmp/movie.mkv",
      includeSource: true,
      includeFallback: false,
      includeAudio: true,
      includeSubtitles: true,
      includeChapters: false,
    });

    const state = result.stateStore.getState();

    const audioIds = state.outputs.filter((o) => o.kind === "audio").map((o) => o.id);
    console.info(
      `[${SUITE}:mixed-tracks:assert] audioIds=${JSON.stringify(audioIds)} subtitleIds=${JSON.stringify(state.subtitles.map((s) => s.id))}`,
    );
    if (JSON.stringify(audioIds) !== JSON.stringify(["audio-0", "audio-1", "audio-2"])) {
      dumpProduceSnapshot("mixed-tracks-audio-order-mismatch", {
        stateOutputs: state.outputs,
        stateSubtitles: state.subtitles,
      });
    }
    // Ordering preservation: audio-0, audio-1, audio-2 in stream order.
    expect(audioIds).toEqual(["audio-0", "audio-1", "audio-2"]);

    const audio0 = state.outputs.find((o) => o.id === "audio-0");
    const audio1 = state.outputs.find((o) => o.id === "audio-1");
    const audio2 = state.outputs.find((o) => o.id === "audio-2");
    expect(audio0?.language).toBe("eng");
    expect(audio0?.label).toBe("Main");
    expect(audio1?.language).toBe("fra");
    expect(audio1?.label).toBe("VF");
    expect(audio2?.language).toBe("jpn");
    expect(audio2?.label).toBe("OG");

    const subtitleIds = state.subtitles.map((s) => s.id);
    expect(subtitleIds).toEqual(["sub-0", "sub-1"]);
    expect(state.subtitles[0].language).toBe("eng");
    expect(state.subtitles[0].label).toBe("EN");
    expect(state.subtitles[1].language).toBe("fra");
    expect(state.subtitles[1].label).toBe("FR");
  });

  it("does NOT emit uploading-stage progress (only transcoding)", async () => {
    console.info(`[${SUITE}:no-upload-stage:setup] verifying produce path is encode-only`);
    const { configureMediaIngestRuntime, produceMediaOutputs } = await import(
      "../src/mediaProcessor"
    );
    configureMediaIngestRuntime({
      resolveJobDir: (userId, jobId) => join(root, "jobs", userId, jobId),
      encryptMediaObject: vi.fn(() => Buffer.alloc(0)),
      uploadStorageObject: vi.fn(async () => "would-not-run"),
    });

    runFfprobeMock.mockResolvedValue({
      streams: [
        { codec_type: "video", codec_name: "h264", width: 1920, height: 1080 },
        { codec_type: "audio", codec_name: "aac", tags: { language: "eng" } },
      ],
      data: { format: { duration: "60" }, chapters: [] },
    });

    const stages: string[] = [];
    await produceMediaOutputs({
      userId: "u1",
      jobId: "j-progress",
      inputPath: "/tmp/movie.mkv",
      includeSource: true,
      includeFallback: false,
      includeAudio: true,
      includeSubtitles: false,
      includeChapters: false,
      onProgress: (stage) => stages.push(stage),
    });
    console.info(`[${SUITE}:no-upload-stage:assert] observed stages=${JSON.stringify(stages)}`);
    if (stages.some((s) => s !== "transcoding")) {
      dumpProduceSnapshot("no-upload-stage-leaked", { stagesObserved: stages });
    }

    // Whatever progress was emitted, none of it carries the upload stage.
    for (const stage of stages) {
      expect(stage).toBe("transcoding");
    }
  });
});
