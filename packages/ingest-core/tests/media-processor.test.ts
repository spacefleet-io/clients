import { mkdtempSync, rmSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ProducedMedia } from "../src/mediaProcessor";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SUITE = "media-processor";

const dumpProcessorSnapshot = (
  label: string,
  ctx: {
    ffmpegInvocations?: ReadonlyArray<ReadonlyArray<string>>;
    uploadCallTrace?: ReadonlyArray<{ args: ReadonlyArray<unknown>; result?: unknown }>;
    outputPaths?: ReadonlyArray<string>;
    produced?: unknown;
  },
) => {
  try {
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    if (ctx.ffmpegInvocations) {
      console.error(`ffmpeg cmd args (${ctx.ffmpegInvocations.length} invocations):`);
      ctx.ffmpegInvocations.forEach((args, idx) => {
        console.error(`  #${idx}: ${JSON.stringify(args)}`);
      });
    }
    if (ctx.uploadCallTrace) {
      console.error(
        `upload mock call trace (${ctx.uploadCallTrace.length}):\n${JSON.stringify(ctx.uploadCallTrace, null, 2)}`,
      );
    }
    if (ctx.outputPaths) {
      console.error(`output paths produced (${ctx.outputPaths.length}):\n${JSON.stringify(ctx.outputPaths, null, 2)}`);
    }
    if (ctx.produced !== undefined) {
      console.error(`produced manifest:\n${JSON.stringify(ctx.produced, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

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
  await fs.writeFile(join(dirname(mpdPath), "init.m4s"), "init");
  await fs.writeFile(join(dirname(mpdPath), "seg-00001.m4s"), "seg-1");
  await fs.writeFile(join(dirname(mpdPath), "seg-00002.m4s"), "seg-2");
  const codecs = codecType === "video" ? "avc1.640028" : "mp4a.40.2";
  await fs.writeFile(
    mpdPath,
    [
      `<MPD><Period><AdaptationSet contentType="${codecType}" codecs="${codecs}">`,
      '<SegmentTemplate timescale="1">',
      "<SegmentTimeline>",
      '<S t="0" d="4" />',
      '<S d="4" />',
      "</SegmentTimeline>",
      "</SegmentTemplate>",
      "</AdaptationSet></Period></MPD>",
    ].join("")
  );
};

/** Upload runtime over an in-memory store, so a resume's existence check sees what was uploaded. */
const createUploadRuntime = () => {
  const stored = new Set<string>();
  return {
    uploadStorageObject: vi.fn(async (_token: string, objectKey: string) => {
      const key = `persisted-${objectKey}`;
      stored.add(key);
      return key;
    }),
    headStorageObjects: vi.fn(async (_token: string, keys: string[]) =>
      Object.fromEntries(keys.map((key) => [key, stored.has(key)]))
    ),
  };
};

describe("media processor", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sf-media-processor-"));
    console.info(`[${SUITE}:setup] temp root=${root}`);
    runFfprobeMock.mockReset();
    runFfmpegMock.mockReset();
    createFfmpegTaskMock.mockReset();
    runFfmpegMock.mockResolvedValue({ stdout: "", stderr: "" });
    createFfmpegTaskMock.mockImplementation((args: string[]) => {
      const mpdPath = args.find((value) => value.endsWith(".mpd")) ?? args[args.length - 1];
      const codecType = args.some((value) => value === "0:v:0") ? "video" : "audio";
      const promise = setupDashOutput(mpdPath, codecType).then(() => ({ stdout: "", stderr: "" }));
      return { promise, cancel: vi.fn() };
    });
  });

  afterEach(() => {
    console.info(`[${SUITE}:teardown] removing temp root=${root}`);
    rmSync(root, { recursive: true, force: true });
  });

  it("resumes completed outputs without re-encoding or re-uploading", async () => {
    console.info(`[${SUITE}:resume] first run + second run on same payload`);
    const { configureMediaIngestRuntime, processMediaJob } = await import("../src/mediaProcessor");
    const uploads = createUploadRuntime();
    configureMediaIngestRuntime({
      resolveJobDir: (userId, jobId) => join(root, "jobs", userId, jobId),
      encryptMediaObject: (bytes) => bytes,
      uploadStorageObject: uploads.uploadStorageObject,
      headStorageObjects: uploads.headStorageObjects,
    });

    runFfprobeMock.mockResolvedValue({
      streams: [
        { codec_type: "video", codec_name: "h264", width: 1920, height: 1080 },
        { codec_type: "audio", codec_name: "aac", tags: { language: "eng", title: "Main" } },
      ],
      data: { format: { duration: "60" }, chapters: [] },
    });

    const payload = {
      token: "token",
      userId: "user-1",
      jobId: "job-1",
      placementId: "placement-job-1",
      inputPath: "/tmp/input.mp4",
      includeSource: true,
      includeFallback: false,
      includeAudio: true,
      includeSubtitles: false,
      includeChapters: false,
    };

    const first = await processMediaJob(payload);
    console.info(
      `[${SUITE}:resume] first run — ffmpeg invocations=${createFfmpegTaskMock.mock.calls.length}, uploads=${uploads.uploadStorageObject.mock.calls.length}, videoFormats=${first.produced.videoFormats.length}, audioTracks=${first.produced.audioTracks.length}`,
    );
    if (
      first.produced.videoFormats.length !== 1 ||
      first.produced.audioTracks.length !== 1 ||
      createFfmpegTaskMock.mock.calls.length !== 2
    ) {
      dumpProcessorSnapshot("first-run-unexpected-shape", {
        ffmpegInvocations: createFfmpegTaskMock.mock.calls.map((c) => c[0] as string[]),
        uploadCallTrace: uploads.uploadStorageObject.mock.calls.map((c) => ({ args: c })),
        produced: first.produced,
      });
    }
    expect(first.produced.videoFormats).toHaveLength(1);
    expect(first.produced.audioTracks).toHaveLength(1);
    expect(createFfmpegTaskMock).toHaveBeenCalledTimes(2);
    expect(uploads.uploadStorageObject).toHaveBeenCalled();

    createFfmpegTaskMock.mockClear();
    uploads.uploadStorageObject.mockClear();

    console.info(`[${SUITE}:resume] second run — expecting NO ffmpeg + NO uploads`);
    const second = await processMediaJob(payload);
    console.info(
      `[${SUITE}:resume] second run — ffmpeg invocations=${createFfmpegTaskMock.mock.calls.length}, uploads=${uploads.uploadStorageObject.mock.calls.length}`,
    );
    if (createFfmpegTaskMock.mock.calls.length > 0 || uploads.uploadStorageObject.mock.calls.length > 0) {
      dumpProcessorSnapshot("second-run-rework-detected", {
        ffmpegInvocations: createFfmpegTaskMock.mock.calls.map((c) => c[0] as string[]),
        uploadCallTrace: uploads.uploadStorageObject.mock.calls.map((c) => ({ args: c })),
        produced: second.produced,
      });
    }
    expect(second.produced.videoFormats).toHaveLength(1);
    expect(second.produced.audioTracks).toHaveLength(1);
    expect(createFfmpegTaskMock).not.toHaveBeenCalled();
    expect(uploads.uploadStorageObject).not.toHaveBeenCalled();
  });

  // @bugfix @regression-proof F3 (ultimate stress, issue #25): a source with
  // zero audio streams (screen recording, silent film, test clip) is
  // legitimate media. Ingest MUST succeed with a video format and no audio
  // tracks instead of throwing NO_AUDIO_STREAM after the video was already
  // encoded (which left a media row with no formats).
  it("@bugfix @regression-proof ingests a silent source (no audio stream) with video and zero audio tracks", async () => {
    console.info(`[${SUITE}:no-audio] silent source must ingest: video format, zero audio tracks`);
    const { configureMediaIngestRuntime, processMediaJob } = await import("../src/mediaProcessor");
    const uploads = createUploadRuntime();
    configureMediaIngestRuntime({
      resolveJobDir: (userId, jobId) => join(root, "jobs", userId, jobId),
      encryptMediaObject: (bytes) => bytes,
      uploadStorageObject: uploads.uploadStorageObject,
    });

    runFfprobeMock.mockResolvedValue({
      streams: [{ codec_type: "video", codec_name: "h264", width: 1920, height: 1080 }],
      data: { format: { duration: "60" }, chapters: [] },
    });

    let produced: ProducedMedia | undefined;
    let failure: unknown;
    try {
      const result = await processMediaJob({
        token: "token",
        userId: "user-1",
        jobId: "job-no-audio",
        placementId: "placement-no-audio",
        inputPath: "/tmp/input.mp4",
        includeSource: true,
        includeFallback: false,
        includeAudio: true,
        includeSubtitles: false,
      });
      produced = result.produced;
    } catch (err) {
      failure = err;
    }
    if (failure || !produced) {
      dumpProcessorSnapshot("silent-source-ingest-failed", {
        ffmpegInvocations: createFfmpegTaskMock.mock.calls.map((c) => c[0] as string[]),
        uploadCallTrace: uploads.uploadStorageObject.mock.calls.map((c) => ({ args: c })),
      });
      console.error(
        `[${SUITE}:no-audio] ingest threw: ${failure instanceof Error ? failure.message : String(failure)}`
      );
    }
    expect(failure).toBeUndefined();
    expect(produced?.videoFormats).toHaveLength(1);
    expect(produced?.videoFormats[0]?.chunks.length).toBeGreaterThan(0);
    expect(produced?.audioTracks).toHaveLength(0);
    // Only the video encode ran — no audio ffmpeg invocation for a silent source.
    expect(createFfmpegTaskMock).toHaveBeenCalledTimes(1);
  });

  it("@bugfix @regression-proof delegates encrypted media uploads through the single high-level upload transport", async () => {
    console.info(`[${SUITE}:upload-transport] uploading single encrypted file via tunnel`);
    const { configureMediaIngestRuntime, uploadEncryptedFile } = await import("../src/mediaProcessor");
    const inputPath = join(root, "tunnel.bin");
    const payload = Buffer.from("tunnel-payload");
    await fs.writeFile(inputPath, payload);
    const uploads = createUploadRuntime();

    configureMediaIngestRuntime({
      encryptMediaObject: (bytes) => bytes,
      uploadStorageObject: uploads.uploadStorageObject,
    });

    const uploaded = await uploadEncryptedFile("token", inputPath);
    console.info(
      `[${SUITE}:upload-transport] uploaded sizeBytes=${uploaded.sizeBytes} checksum_len=${uploaded.checksum.length} upload_calls=${uploads.uploadStorageObject.mock.calls.length}`,
    );
    if (uploaded.sizeBytes !== payload.length || uploaded.checksum.length !== 64) {
      dumpProcessorSnapshot("upload-transport-shape", {
        uploadCallTrace: uploads.uploadStorageObject.mock.calls.map((c) => ({ args: c })),
      });
    }
    expect(uploaded.sizeBytes).toBe(payload.length);
    expect(uploaded.checksum).toHaveLength(64);
    expect(uploads.uploadStorageObject).toHaveBeenCalledTimes(1);
    expect(uploads.uploadStorageObject).toHaveBeenCalledWith(
      "token",
      expect.any(String),
      payload,
      expect.objectContaining({
        objectNamespace: "library",
        logicalRef: inputPath,
        contentType: "application/octet-stream",
        clientType: "desktop",
        clientVersion: "ingest-core",
      })
    );
  });

  it("@bugfix @regression-proof prefers full-object upload transport over sequential frame uploads when available", async () => {
    console.info(`[${SUITE}:full-object-upload] preferring single-object transport`);
    const { configureMediaIngestRuntime, uploadEncryptedFile } = await import("../src/mediaProcessor");
    const inputPath = join(root, "fast-upload.bin");
    const payload = Buffer.from("fast-upload-payload");
    await fs.writeFile(inputPath, payload);
    const uploadStorageObject = vi.fn(async (_token: string, objectKey: string, encryptedPayload: Uint8Array) => {
      expect(Buffer.from(encryptedPayload)).toEqual(payload);
      return `persisted-${objectKey}`;
    });

    configureMediaIngestRuntime({
      encryptMediaObject: (bytes) => bytes,
      uploadStorageObject,
    });

    const uploaded = await uploadEncryptedFile("token", inputPath);
    console.info(
      `[${SUITE}:full-object-upload] sizeBytes=${uploaded.sizeBytes} checksum_len=${uploaded.checksum.length} upload_calls=${uploadStorageObject.mock.calls.length}`,
    );
    expect(uploaded.sizeBytes).toBe(payload.length);
    expect(uploaded.checksum).toHaveLength(64);
    expect(uploadStorageObject).toHaveBeenCalledTimes(1);
  });

  it("rejects files with no video stream (audio-only)", async () => {
    console.info(`[${SUITE}:no-video] expecting NO_VIDEO_STREAM throw`);
    const { configureMediaIngestRuntime, processMediaJob } = await import("../src/mediaProcessor");
    const uploads = createUploadRuntime();
    configureMediaIngestRuntime({
      resolveJobDir: (userId, jobId) => join(root, "jobs", userId, jobId),
      encryptMediaObject: (bytes) => bytes,
      uploadStorageObject: uploads.uploadStorageObject,
    });

    runFfprobeMock.mockResolvedValue({
      streams: [{ codec_type: "audio", codec_name: "aac", channels: 2, tags: { language: "eng" } }],
      data: { format: { duration: "60" }, chapters: [] },
    });

    await expect(
      processMediaJob({
        token: "token",
        userId: "user-1",
        jobId: "job-no-video",
        placementId: "placement-no-video",
        inputPath: "/tmp/audio-only.m4a",
        includeSource: true,
        includeFallback: false,
        includeAudio: true,
        includeSubtitles: false,
      })
    ).rejects.toThrow("NO_VIDEO_STREAM");
  });

  it("resolves PGS image subtitles to SUP copy format", async () => {
    const { resolveSubtitleOutput } = await import("../src/mediaProcessor");
    expect(resolveSubtitleOutput("hdmv_pgs_subtitle")).toEqual({
      format: "sup",
      codecArgs: ["-c:s", "copy"],
    });
  });

  it("resolves DVD/VOB subtitles to MKV copy format", async () => {
    const { resolveSubtitleOutput } = await import("../src/mediaProcessor");
    expect(resolveSubtitleOutput("dvd_subtitle")).toEqual({
      format: "mkv",
      codecArgs: ["-c:s", "copy", "-f", "matroska"],
    });
    expect(resolveSubtitleOutput("vobsub")).toEqual({
      format: "mkv",
      codecArgs: ["-c:s", "copy", "-f", "matroska"],
    });
  });

  it("resolves text subtitles to SRT format", async () => {
    const { resolveSubtitleOutput } = await import("../src/mediaProcessor");
    expect(resolveSubtitleOutput("subrip")).toEqual({ format: "srt", codecArgs: ["-c:s", "srt"] });
    expect(resolveSubtitleOutput("ass")).toEqual({ format: "srt", codecArgs: ["-c:s", "srt"] });
  });

  it("falls back to SRT for unknown subtitle codecs", async () => {
    const { resolveSubtitleOutput } = await import("../src/mediaProcessor");
    expect(resolveSubtitleOutput("unknown_codec")).toEqual({ format: "srt", codecArgs: ["-c:s", "srt"] });
  });

  it("fails fast when tunnel runtime is not configured", async () => {
    console.info(`[${SUITE}:unconfigured-tunnel] expecting INGEST_RUNTIME_NOT_CONFIGURED throw`);
    const { configureMediaIngestRuntime, uploadEncryptedFile } = await import("../src/mediaProcessor");
    const inputPath = join(root, "broken.bin");
    await fs.writeFile(inputPath, Buffer.from("x"));

    configureMediaIngestRuntime({
      encryptMediaObject: (bytes) => bytes,
      uploadStorageObject: undefined,
    });

    await expect(uploadEncryptedFile("token", inputPath)).rejects.toThrow("INGEST_RUNTIME_NOT_CONFIGURED");
  });
});
