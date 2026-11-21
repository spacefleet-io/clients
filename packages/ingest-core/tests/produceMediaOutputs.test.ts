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
      // Subtitle extraction writes every track of the run in one ffmpeg call:
      // each `subtitle-<N>.<fmt>` positional arg is an output file (no `.mpd`).
      const subtitleOutputs = args.filter((value) => typeof value === "string" && /subtitle-\d+\.\w+$/.test(value));
      if (subtitleOutputs.length > 0) {
        const promise = Promise.all(subtitleOutputs.map(setupSubtitleOutput)).then(() => ({ stdout: "", stderr: "" }));
        return { promise, cancel: vi.fn() };
      }
      // One audio run writes every track's DASH output: each `.mpd` arg is one output.
      const mpdPaths = args.filter((value) => value.endsWith(".mpd"));
      const codecType = args.some((value) => value === "0:v:0") ? "video" : "audio";
      const promise = Promise.all((mpdPaths.length > 0 ? mpdPaths : [args[args.length - 1]!]).map((mpdPath) => setupDashOutput(mpdPath, codecType))).then(() => ({ stdout: "", stderr: "" }));
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

  /** @req INGS-JOBS-06[runtime] */
  it("@perf extracts every subtitle track in ONE ffmpeg run, and on resume only the missing ones", async () => {
    console.info(`[${SUITE}:subs-one-pass:setup] 3 subtitles (one PGS bitmap), source-free run`);
    const { configureMediaIngestRuntime, produceMediaOutputs } = await import("../src/mediaProcessor");
    configureMediaIngestRuntime({
      resolveJobDir: (userId, jobId) => join(root, "jobs", userId, jobId),
      encryptMediaObject: vi.fn(() => Buffer.alloc(0)),
      uploadStorageObject: vi.fn(async () => "would-not-run"),
    });
    runFfprobeMock.mockResolvedValue({
      streams: [
        { codec_type: "video", codec_name: "h264", width: 1920, height: 1080 },
        { codec_type: "subtitle", codec_name: "subrip", tags: { language: "eng", title: "EN" } },
        { codec_type: "subtitle", codec_name: "hdmv_pgs_subtitle", tags: { language: "fra", title: "FR" } },
        { codec_type: "subtitle", codec_name: "subrip", tags: { language: "ger", title: "DE" } },
      ],
      data: { format: { duration: "120" }, chapters: [] },
    });
    const spec = {
      userId: "u1",
      jobId: "j-subs-one-pass",
      inputPath: "/tmp/movie.mkv",
      includeSource: false,
      includeFallback: false,
      includeAudio: false,
      includeSubtitles: true,
      includeChapters: false,
    };
    const subtitleCalls = () =>
      createFfmpegTaskMock.mock.calls
        .map((call) => call[0] as string[])
        .filter((args) => args.some((value) => /subtitle-\d+\.\w+$/.test(value)));
    const mapPairs = (args: string[]) =>
      args.flatMap((value, i) => (value === "-map" ? [`${args[i + 1]} -> ${args.slice(i + 2).find((v) => /subtitle-\d+\.\w+$/.test(v))?.split("/").pop()}`] : []));

    const logs: string[] = [];
    const first = await produceMediaOutputs({ ...spec, onLog: (line: string) => logs.push(line) });
    const firstCalls = subtitleCalls();
    console.info(`[${SUITE}:subs-one-pass:run1] subtitle ffmpeg calls=${firstCalls.length} maps=${JSON.stringify(firstCalls.map(mapPairs))}`);
    if (firstCalls.length !== 1) {
      console.error(`[${SUITE}:subs-one-pass:run1] all ffmpeg args:\n${JSON.stringify(createFfmpegTaskMock.mock.calls.map((c) => c[0]), null, 2)}`);
      dumpProduceSnapshot("subs-one-pass-run1", { stateSubtitles: first.stateStore.getState().subtitles });
    }
    expect(firstCalls).toHaveLength(1);
    // Only one input read, each `-map 0:s:N` followed by its own output, in stream order.
    expect(firstCalls[0].filter((value) => value === "-i")).toHaveLength(1);
    expect(mapPairs(firstCalls[0])).toEqual(["0:s:0 -> subtitle-0.srt", "0:s:1 -> subtitle-1.sup", "0:s:2 -> subtitle-2.srt"]);
    expect(logs.some((line) => line.includes("subtitles: extracting 3 track(s) in one pass"))).toBe(true);
    const firstSubs = first.stateStore.getState().subtitles;
    expect(firstSubs.map((s) => s.id)).toEqual(["sub-0", "sub-1", "sub-2"]);
    expect(firstSubs.map((s) => s.format)).toEqual(["srt", "sup", "srt"]);
    for (const sub of firstSubs) expect(existsSync(sub.path)).toBe(true);

    // Resume: one output got lost; the next run extracts just that track, still in one call.
    await fs.rm(firstSubs[1].path);
    createFfmpegTaskMock.mockClear();
    const second = await produceMediaOutputs(spec);
    const secondCalls = subtitleCalls();
    console.info(`[${SUITE}:subs-one-pass:run2] subtitle ffmpeg calls=${secondCalls.length} maps=${JSON.stringify(secondCalls.map(mapPairs))}`);
    if (secondCalls.length !== 1) {
      dumpProduceSnapshot("subs-one-pass-resume", { stateSubtitles: second.stateStore.getState().subtitles });
    }
    expect(secondCalls).toHaveLength(1);
    expect(mapPairs(secondCalls[0])).toEqual(["0:s:1 -> subtitle-1.sup"]);
    expect(second.stateStore.getState().subtitles.map((s) => s.id)).toEqual(["sub-0", "sub-1", "sub-2"]);

    // Nothing missing: no subtitle ffmpeg run at all.
    createFfmpegTaskMock.mockClear();
    await produceMediaOutputs(spec);
    console.info(`[${SUITE}:subs-one-pass:run3] subtitle ffmpeg calls=${subtitleCalls().length}`);
    expect(subtitleCalls()).toHaveLength(0);
  });

  /** @req INGS-JOBS-07[runtime] */
  it("@perf encodes every audio track in ONE ffmpeg run (own DASH output each), and on resume only the unfinished ones", async () => {
    console.info(`[${SUITE}:audio-one-pass:setup] 3 audios: aac stereo (copy), eac3 5.1(side) (aac + standard layout), ac3 stereo (aac)`);
    // Loaded after the per-test mock setup, like every case in this file.
    const { configureMediaIngestRuntime, produceMediaOutputs } = await import("../src/mediaProcessor");
    configureMediaIngestRuntime({
      resolveJobDir: (userId, jobId) => join(root, "jobs", userId, jobId),
      encryptMediaObject: vi.fn(() => Buffer.alloc(0)),
      uploadStorageObject: vi.fn(async () => "would-not-run"),
    });
    runFfprobeMock.mockResolvedValue({
      streams: [
        { codec_type: "video", codec_name: "h264", width: 1920, height: 1080 },
        { codec_type: "audio", codec_name: "aac", channel_layout: "stereo", tags: { language: "eng" } },
        { codec_type: "audio", codec_name: "eac3", channel_layout: "5.1(side)", tags: { language: "fre" } },
        { codec_type: "audio", codec_name: "ac3", channel_layout: "stereo", tags: { language: "ger" } },
      ],
      data: { format: { duration: "120" }, chapters: [] },
    });
    const spec = {
      userId: "u1",
      jobId: "j-audio-one-pass",
      inputPath: "/tmp/movie.mkv",
      includeSource: false,
      includeFallback: false,
      includeAudio: true,
      includeSubtitles: false,
      includeChapters: false,
    };
    const audioCalls = () =>
      createFfmpegTaskMock.mock.calls
        .map((call) => call[0] as string[])
        .filter((args) => args.some((value) => /^0:a:\d+$/.test(value)));
    // Each output: its `-map 0:a:N`, then that output's args up to its manifest.
    const outputsOf = (args: string[]) => {
      const outputs: Array<{ map: string; args: string[]; mpd: string }> = [];
      let current: { map: string; args: string[] } | null = null;
      for (let i = 0; i < args.length; i += 1) {
        if (args[i] === "-map") {
          current = { map: args[i + 1]!, args: [] };
          i += 1;
        } else if (current && args[i]!.endsWith(".mpd")) {
          outputs.push({ ...current, mpd: args[i]!.split("/").slice(-2).join("/") });
          current = null;
        } else if (current) {
          current.args.push(args[i]!);
        }
      }
      return outputs;
    };

    const logs: string[] = [];
    const first = await produceMediaOutputs({ ...spec, onLog: (line: string) => logs.push(line) });
    const firstCalls = audioCalls();
    console.info(`[${SUITE}:audio-one-pass:run1] audio ffmpeg calls=${firstCalls.length} outputs=${JSON.stringify(firstCalls.map(outputsOf), null, 1)}`);
    if (firstCalls.length !== 1) {
      console.error(`[${SUITE}:audio-one-pass:run1] all ffmpeg args:\n${JSON.stringify(createFfmpegTaskMock.mock.calls.map((c) => c[0]), null, 2)}`);
      dumpProduceSnapshot("audio-one-pass-run1", { stateOutputs: first.stateStore.getState().outputs });
    }
    expect(firstCalls).toHaveLength(1);
    expect(firstCalls[0]!.filter((value) => value === "-i")).toHaveLength(1);
    const outputs = outputsOf(firstCalls[0]!);
    expect(outputs.map((o) => `${o.map} -> ${o.mpd}`)).toEqual([
      "0:a:0 -> audio-0/manifest.mpd",
      "0:a:1 -> audio-1/manifest.mpd",
      "0:a:2 -> audio-2/manifest.mpd",
    ]);
    // Per-output codec args, same as the run-per-track recipe: AAC copied, others encoded to AAC with their standard layout.
    expect(outputs[0]!.args.slice(0, 2)).toEqual(["-c:a", "copy"]);
    expect(outputs[1]!.args.slice(0, 4)).toEqual(["-c:a", "aac", "-af", "aformat=channel_layouts=5.1"]);
    expect(outputs[2]!.args.slice(0, 4)).toEqual(["-c:a", "aac", "-af", "aformat=channel_layouts=stereo"]);
    // Same DASH layout per output as the run-per-track recipe.
    for (const o of outputs) {
      expect(o.args).toEqual(expect.arrayContaining(["-f", "dash", "-init_seg_name", "init-$RepresentationID$.mp4", "-media_seg_name", "seg-$Number%05d$.m4s"]));
    }
    expect(logs.some((line) => line.includes("audio: encoding 3 track(s) in one pass"))).toBe(true);
    const firstAudio = first.stateStore.getState().outputs.filter((o) => o.kind === "audio");
    expect(firstAudio.map((o) => `${o.id}:${o.encodingComplete}:${o.segments.length}`)).toEqual([
      "audio-0:true:3",
      "audio-1:true:3",
      "audio-2:true:3",
    ]);

    // Resume: one track lost a segment; the next run encodes just that track, still in one call.
    await fs.rm(firstAudio[2]!.segments[1]!.path);
    createFfmpegTaskMock.mockClear();
    const second = await produceMediaOutputs(spec);
    const secondCalls = audioCalls();
    console.info(`[${SUITE}:audio-one-pass:run2] audio ffmpeg calls=${secondCalls.length} outputs=${JSON.stringify(secondCalls.map(outputsOf).map((os) => os.map((o) => o.map)))}`);
    if (secondCalls.length !== 1) {
      dumpProduceSnapshot("audio-one-pass-resume", { stateOutputs: second.stateStore.getState().outputs });
    }
    expect(secondCalls).toHaveLength(1);
    expect(outputsOf(secondCalls[0]!).map((o) => o.map)).toEqual(["0:a:2"]);
    expect(second.stateStore.getState().outputs.filter((o) => o.kind === "audio").every((o) => o.encodingComplete)).toBe(true);
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
