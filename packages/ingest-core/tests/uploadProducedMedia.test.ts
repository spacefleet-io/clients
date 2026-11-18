/**
 * @bugfix @regression-proof
 *
 * Phase F split — `uploadProducedMedia` (upload-only entrypoint).
 *
 * Invariants pinned here:
 *  - full upload of every pending chunk via a fake gateway (encryption +
 *    push happen here, not in produceMediaOutputs)
 *  - partial-resume: segments marked `uploaded: true` before the call are
 *    skipped — the fake gateway sees exactly the un-uploaded ones
 *  - `scope: "source"` vs `scope: "format"` selectivity (source pushes
 *    video-source + audio + subs; format pushes only the variant)
 *  - linear `onProgress` ticks (≥5 distinct progress values during a
 *    multi-chunk run — proves the upload step's progress is real, not
 *    a single 100% terminal emit)
 *  - no re-upload on already-uploaded segments (the resume case fires
 *    zero upload calls and returns a `ProducedMedia` with pre-existing keys)
 *
 * Sister doc: produceMediaOutputs.test.ts — same fake ffprobe/ffmpeg seam,
 * but here we seed the state store directly with completed encodes so we
 * can drive uploadProducedMedia without round-tripping through encode.
 */

import { mkdtempSync, rmSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as MediaProcessorModule from "../src/mediaProcessor";

const SUITE = "uploadProducedMedia";

const dumpUploadSnapshot = (
  label: string,
  ctx: {
    uploadPayloads?: ReadonlyArray<{ key: string; size?: number }>;
    gatewayRequestCount?: number;
    gatewayResponseTail?: ReadonlyArray<string>;
    retryCounter?: number;
    progressSamples?: ReadonlyArray<{ stage: string; pct: number }>;
    produced?: unknown;
    uploadedKeys?: ReadonlyArray<string>;
  },
) => {
  try {
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    if (ctx.uploadPayloads) {
      console.error(
        `upload payloads (${ctx.uploadPayloads.length}):\n${JSON.stringify(ctx.uploadPayloads, null, 2)}`,
      );
    }
    if (typeof ctx.gatewayRequestCount === "number") {
      console.error(`gateway request count: ${ctx.gatewayRequestCount}`);
    }
    if (ctx.gatewayResponseTail) {
      console.error(`gateway response tail (last 10):\n${JSON.stringify(ctx.gatewayResponseTail.slice(-10), null, 2)}`);
    }
    if (typeof ctx.retryCounter === "number") {
      console.error(`retry counter: ${ctx.retryCounter}`);
    }
    if (ctx.progressSamples) {
      const last20 = ctx.progressSamples.slice(-20);
      console.error(`progress samples (${ctx.progressSamples.length}; last 20):\n${JSON.stringify(last20, null, 2)}`);
      console.error(`distinct pct values: ${new Set(ctx.progressSamples.map((s) => s.pct)).size}`);
    }
    if (ctx.produced !== undefined) {
      console.error(`produced manifest:\n${JSON.stringify(ctx.produced, null, 2)}`);
    }
    if (ctx.uploadedKeys) {
      console.error(`uploadedKeys (${ctx.uploadedKeys.length}): ${JSON.stringify(ctx.uploadedKeys)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

// Even though uploadProducedMedia doesn't call ffmpeg, the runtime mock has
// to be present so the module import doesn't pull a real binary.
const runFfprobeMock = vi.fn();
const runFfmpegMock = vi.fn();
const createFfmpegTaskMock = vi.fn();
vi.mock("@space/ffmpeg", () => ({
  runFfprobe: runFfprobeMock,
  runFfmpeg: runFfmpegMock,
  createFfmpegTask: createFfmpegTaskMock,
}));

/**
 * Materialize a fully-encoded job state on disk: writes `job_state.json`
 * plus matching segment + init files for each output described.
 */
const seedEncodedState = async (
  jobDir: string,
  spec: {
    video?: { id: string; quality: string; codec?: string; segments: number };
    fallback?: { id: string; quality: string; codec?: string; segments: number };
    audios?: Array<{ id: string; language: string; label: string; segments: number }>;
    subtitles?: Array<{ id: string; language: string; label: string }>;
  }
) => {
  await fs.mkdir(jobDir, { recursive: true });
  const outputs: any[] = [];
  const addVideoLike = async (
    id: string,
    quality: string,
    codec: string,
    kind: "video" | "audio",
    segCount: number,
    extras: Record<string, unknown> = {}
  ) => {
    const outputDir = join(jobDir, "outputs", id);
    await fs.mkdir(outputDir, { recursive: true });
    const initPath = join(outputDir, "init-0.mp4");
    await fs.writeFile(initPath, Buffer.from(`init-${id}`));
    const segments: any[] = [];
    for (let i = 0; i < segCount; i++) {
      const segPath = join(outputDir, `seg-${String(i + 1).padStart(5, "0")}.m4s`);
      await fs.writeFile(segPath, Buffer.from(`seg-${id}-${i}-` + "x".repeat(256)));
      segments.push({
        path: segPath,
        startSeconds: i * 12,
        uploaded: false,
      });
    }
    outputs.push({
      id,
      kind,
      quality,
      codec,
      codecString: kind === "video" ? "avc1.640028" : "mp4a.40.2",
      segmentSeconds: 12,
      outputDir,
      init: { path: initPath },
      segments,
      durationSeconds: 60,
      encodingComplete: true,
      ...extras,
    });
  };
  if (spec.video) {
    await addVideoLike(spec.video.id, spec.video.quality, spec.video.codec ?? "h264", "video", spec.video.segments);
  }
  if (spec.fallback) {
    await addVideoLike(spec.fallback.id, spec.fallback.quality, spec.fallback.codec ?? "h264", "video", spec.fallback.segments);
  }
  if (spec.audios) {
    for (const audio of spec.audios) {
      await addVideoLike(audio.id, "audio", "aac", "audio", audio.segments, {
        language: audio.language,
        label: audio.label,
      });
    }
  }
  const subtitles: any[] = [];
  if (spec.subtitles) {
    const subDir = join(jobDir, "subtitles");
    await fs.mkdir(subDir, { recursive: true });
    for (let i = 0; i < spec.subtitles.length; i++) {
      const sub = spec.subtitles[i];
      const subPath = join(subDir, `subtitle-${i}.srt`);
      await fs.writeFile(subPath, `1\n00:00:01,000 --> 00:00:02,000\n${sub.language}\n`);
      subtitles.push({
        id: sub.id,
        path: subPath,
        language: sub.language,
        label: sub.label,
        format: "srt",
      });
    }
  }
  const state = {
    version: 1,
    inputPath: "/tmp/movie.mkv",
    userId: "u1",
    createdAt: new Date().toISOString(),
    outputs,
    subtitles,
  };
  await fs.writeFile(join(jobDir, "job_state.json"), JSON.stringify(state, null, 2));
};

/** Resolve the job dir the same way the runtime does. */
const resolveJobDirInRoot = (root: string, userId: string, jobId: string) =>
  join(root, "jobs", userId, jobId);

describe("uploadProducedMedia (upload-only entrypoint)", () => {
  let root = "";
  let configureMediaIngestRuntime: typeof MediaProcessorModule.configureMediaIngestRuntime;
  let uploadProducedMedia: typeof MediaProcessorModule.uploadProducedMedia;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "sf-upload-produced-"));
    console.info(`[${SUITE}:setup] temp root=${root}`);
    runFfprobeMock.mockReset();
    runFfmpegMock.mockReset();
    createFfmpegTaskMock.mockReset();
    const mod = await import("../src/mediaProcessor");
    configureMediaIngestRuntime = mod.configureMediaIngestRuntime;
    uploadProducedMedia = mod.uploadProducedMedia;
    configureMediaIngestRuntime({
      resolveJobDir: (userId: string, jobId: string) =>
        resolveJobDirInRoot(root, userId, jobId),
      // Resumed objects are still in storage unless a test says otherwise.
      headStorageObjects: async (_token: string, keys: string[]) =>
        Object.fromEntries(keys.map((key) => [key, true])),
    });
  });

  afterEach(() => {
    console.info(`[${SUITE}:teardown] removing temp root=${root}`);
    rmSync(root, { recursive: true, force: true });
  });

  it("uploads every pending chunk through the runtime gateway (scope=source)", async () => {
    console.info(`[${SUITE}:full-upload:setup] seeding 1 video (4 segs) + 1 audio (4 segs) + 1 subtitle`);
    const jobDir = resolveJobDirInRoot(root, "u1", "j-full-upload");
    await seedEncodedState(jobDir, {
      video: { id: "video-source", quality: "1080p", segments: 4 },
      audios: [{ id: "audio-0", language: "eng", label: "Main", segments: 4 }],
      subtitles: [{ id: "sub-0", language: "eng", label: "EN" }],
    });

    const uploads: Array<{ key: string; size: number }> = [];
    configureMediaIngestRuntime({
      encryptMediaObject: (bytes: Buffer) => Buffer.concat([Buffer.from("ENC:"), bytes]),
      uploadStorageObject: vi.fn(async (_token: string, key: string, payload: Uint8Array) => {
        uploads.push({ key, size: payload.byteLength });
        return key;
      }),
    });

    console.info(`[${SUITE}:full-upload:run] invoking uploadProducedMedia scope=source`);
    const result = await uploadProducedMedia({
      token: "tok",
      userId: "u1",
      jobId: "j-full-upload",
      placementId: "placement-full-upload",
      scope: "source",
    });
    console.info(
      `[${SUITE}:full-upload:assert] uploads=${uploads.length} uploadedKeys=${result.uploadedKeys.length}`,
    );

    // video-source: init + 4 segments = 5 objects
    // audio-0:     init + 4 segments = 5 objects
    // sub-0:                            1 object
    // Total: 11 uploaded objects, all distinct keys.
    if (uploads.length !== 11 || new Set(uploads.map((u) => u.key)).size !== 11) {
      dumpUploadSnapshot("full-upload-count-mismatch", {
        uploadPayloads: uploads,
        gatewayRequestCount: uploads.length,
        produced: result.produced,
        uploadedKeys: result.uploadedKeys,
      });
    }
    expect(uploads.length).toBe(11);
    expect(new Set(uploads.map((u) => u.key)).size).toBe(11);

    // Produced shape: one video format with 4 chunks, one audio track with 4 chunks, one subtitle.
    expect(result.produced.videoFormats).toHaveLength(1);
    expect(result.produced.videoFormats[0].chunks).toHaveLength(4);
    expect(result.produced.audioTracks).toHaveLength(1);
    expect(result.produced.audioTracks[0].chunks).toHaveLength(4);
    expect(result.produced.subtitleTracks).toHaveLength(1);

    // Returned uploadedKeys covers everything uploaded this call.
    expect(result.uploadedKeys.length).toBe(11);
  });

  it("partial resume: segments already uploaded are not re-pushed", async () => {
    console.info(`[${SUITE}:partial-resume:setup] seeding 6+6 then marking first 3 of each uploaded`);
    const jobDir = resolveJobDirInRoot(root, "u1", "j-partial-resume");
    await seedEncodedState(jobDir, {
      video: { id: "video-source", quality: "1080p", segments: 6 },
      audios: [{ id: "audio-0", language: "eng", label: "Main", segments: 6 }],
    });

    // Pre-flip the first half of every output to uploaded:true so the upload
    // step skips them — this is what `ResumableJobStateStore` looks like on
    // disk after a crash mid-upload.
    const raw = await fs.readFile(join(jobDir, "job_state.json"), "utf8");
    const state = JSON.parse(raw);
    for (const output of state.outputs) {
      output.init.uploaded = true;
      output.init.key = `pre-${output.id}-init`;
      output.init.sizeBytes = 4;
      for (let i = 0; i < 3; i++) {
        output.segments[i].uploaded = true;
        output.segments[i].key = `pre-${output.id}-${i}`;
        output.segments[i].sizeBytes = 260;
      }
    }
    await fs.writeFile(join(jobDir, "job_state.json"), JSON.stringify(state, null, 2));

    const uploads: string[] = [];
    configureMediaIngestRuntime({
      encryptMediaObject: (bytes: Buffer) => bytes,
      uploadStorageObject: vi.fn(async (_token: string, key: string) => {
        uploads.push(key);
        return key;
      }),
    });

    console.info(`[${SUITE}:partial-resume:run] invoking uploadProducedMedia scope=source`);
    const result = await uploadProducedMedia({
      token: "tok",
      userId: "u1",
      jobId: "j-partial-resume",
      placementId: "placement-partial-resume",
      scope: "source",
    });
    console.info(
      `[${SUITE}:partial-resume:assert] new_uploads=${uploads.length} (expected 6 — latter half × 2 outputs)`,
    );
    if (uploads.length !== 6) {
      dumpUploadSnapshot("partial-resume-wrong-upload-count", {
        uploadPayloads: uploads.map((key) => ({ key })),
        gatewayRequestCount: uploads.length,
        produced: result.produced,
      });
    }

    // Only the LATTER half of each output's segments uploaded: 3 each ×2
    // outputs = 6 segments. Init was already up. No subtitles in this run.
    expect(uploads.length).toBe(6);

    // Produced still includes ALL 6 chunks per output — pre-existing keys
    // are preserved alongside the freshly-uploaded ones.
    expect(result.produced.videoFormats[0].chunks).toHaveLength(6);
    expect(result.produced.audioTracks[0].chunks).toHaveLength(6);
    // Pre-existing keys survive.
    const videoChunkKeys = result.produced.videoFormats[0].chunks.map((c) => c.key);
    if (
      videoChunkKeys[0] !== "pre-video-source-0" ||
      videoChunkKeys[1] !== "pre-video-source-1" ||
      videoChunkKeys[2] !== "pre-video-source-2"
    ) {
      dumpUploadSnapshot("partial-resume-keys-not-preserved", {
        uploadPayloads: uploads.map((key) => ({ key })),
        produced: result.produced,
      });
    }
    expect(videoChunkKeys.slice(0, 3)).toEqual([
      "pre-video-source-0",
      "pre-video-source-1",
      "pre-video-source-2",
    ]);
  });

  // Issue #25 P16: the startup storage GC deleted objects a requeued format
  // job had already uploaded; the resumed upload trusted `uploaded=true`,
  // skipped them, and the commit pointed at missing keys (source_missing).
  it("@bugfix @regression-proof resume re-uploads uploaded=true objects that storage no longer has", async () => {
    const label = "resume-heals-missing";
    const jobDir = resolveJobDirInRoot(root, "u1", "j-resume-heal");
    await seedEncodedState(jobDir, {
      video: { id: "video-source", quality: "1080p", segments: 6 },
      audios: [{ id: "audio-0", language: "eng", label: "Main", segments: 6 }],
    });
    const raw = await fs.readFile(join(jobDir, "job_state.json"), "utf8");
    const state = JSON.parse(raw);
    for (const output of state.outputs) {
      output.init.uploaded = true;
      output.init.key = `pre-${output.id}-init`;
      output.init.sizeBytes = 4;
      for (let i = 0; i < 3; i++) {
        output.segments[i].uploaded = true;
        output.segments[i].key = `pre-${output.id}-${i}`;
        output.segments[i].sizeBytes = 260;
      }
    }
    await fs.writeFile(join(jobDir, "job_state.json"), JSON.stringify(state, null, 2));

    // The GC deleted the video init and video segment 1 between the crash and
    // the resume; everything else marked uploaded is still stored.
    const gcDeleted = new Set(["pre-video-source-init", "pre-video-source-1"]);
    const headCalls: string[][] = [];
    const uploads: string[] = [];
    configureMediaIngestRuntime({
      encryptMediaObject: (bytes: Buffer) => bytes,
      uploadStorageObject: vi.fn(async (_token: string, key: string) => {
        uploads.push(key);
        return key;
      }),
      headStorageObjects: vi.fn(async (_token: string, keys: string[]) => {
        headCalls.push([...keys]);
        return Object.fromEntries(keys.map((key) => [key, !gcDeleted.has(key)]));
      }),
    });

    const result = await uploadProducedMedia({
      token: "tok",
      userId: "u1",
      jobId: "j-resume-heal",
      placementId: "placement-resume-heal",
      scope: "source",
    });
    const committedKeys = [
      ...result.produced.videoFormats.flatMap((f: { initKey: string; chunks: Array<{ key: string }> }) => [f.initKey, ...f.chunks.map((c) => c.key)]),
      ...result.produced.audioTracks.flatMap((t: { initKey: string; chunks: Array<{ key: string }> }) => [t.initKey, ...t.chunks.map((c) => c.key)]),
    ];
    console.info(
      `[${SUITE}:${label}:assert] headCalls=${JSON.stringify(headCalls)} uploads=${uploads.length} ` +
        `committedKeys=${JSON.stringify(committedKeys)} uploadedKeys=${JSON.stringify(result.uploadedKeys)}`,
    );
    if (uploads.length !== 8 || committedKeys.some((key) => gcDeleted.has(key))) {
      dumpUploadSnapshot(`${label}-wrong`, {
        uploadPayloads: uploads.map((key) => ({ key })),
        gatewayRequestCount: uploads.length,
        produced: result.produced,
      });
    }

    // One batched check over the 8 resumed keys (init + 3 segments × 2 outputs).
    expect(headCalls).toHaveLength(1);
    expect([...headCalls[0]].sort()).toEqual(
      ["video-source", "audio-0"].flatMap((id) => [`pre-${id}-init`, `pre-${id}-0`, `pre-${id}-1`, `pre-${id}-2`]).sort(),
    );
    // 6 never-uploaded segments + the 2 objects the GC deleted.
    expect(uploads).toHaveLength(8);
    // The produced media (what commit writes) never points at a deleted key,
    // and still-stored resumed keys are kept as-is.
    expect(committedKeys.filter((key) => gcDeleted.has(key))).toEqual([]);
    expect(committedKeys).toEqual(expect.arrayContaining(["pre-video-source-0", "pre-video-source-2", "pre-audio-0-init", "pre-audio-0-1"]));
    expect(result.produced.videoFormats[0].chunks).toHaveLength(6);
    // The healed objects count as uploaded by this run.
    expect(result.uploadedKeys).toHaveLength(8);
    const persisted = JSON.parse(await fs.readFile(join(jobDir, "job_state.json"), "utf8"));
    const video = persisted.outputs.find((o: { id: string }) => o.id === "video-source");
    expect(video.init.uploaded).toBe(true);
    expect(video.init.key).not.toBe("pre-video-source-init");
  });

  // Same incident, second hand-back path: after a SIGTERM mid-upload the
  // upload ledger (`completedParts`) still holds the key of the last file it
  // uploaded, while that file's segment stays `uploaded=false`. The resume
  // reused that key without uploading — even after the GC had deleted it.
  it("@bugfix @regression-proof resume never reuses an upload-ledger key that storage no longer has", async () => {
    const label = "resume-ledger-stale";
    const jobDir = resolveJobDirInRoot(root, "u1", "j-resume-ledger");
    await seedEncodedState(jobDir, {
      video: { id: "video-source", quality: "1080p", segments: 3 },
    });
    const state = JSON.parse(await fs.readFile(join(jobDir, "job_state.json"), "utf8"));
    const video = state.outputs[0];
    video.init.uploaded = true;
    video.init.key = "pre-init";
    video.init.sizeBytes = 4;
    // Segment 1 finished uploading as the process died: in the ledger only.
    video.completedParts = [
      { partNumber: 0, etag: "pre-ledger-seg-1", sizeBytes: 260, checksum: "c", path: video.segments[0].path },
    ];
    await fs.writeFile(join(jobDir, "job_state.json"), JSON.stringify(state, null, 2));

    const gcDeleted = new Set(["pre-ledger-seg-1"]);
    const headCalls: string[][] = [];
    const uploads: string[] = [];
    configureMediaIngestRuntime({
      encryptMediaObject: (bytes: Buffer) => bytes,
      uploadStorageObject: vi.fn(async (_token: string, key: string) => {
        uploads.push(key);
        return key;
      }),
      headStorageObjects: vi.fn(async (_token: string, keys: string[]) => {
        headCalls.push([...keys]);
        return Object.fromEntries(keys.map((key) => [key, !gcDeleted.has(key)]));
      }),
    });

    const result = await uploadProducedMedia({
      token: "tok",
      userId: "u1",
      jobId: "j-resume-ledger",
      placementId: "placement-resume-ledger",
      scope: "source",
    });
    const chunkKeys = result.produced.videoFormats[0].chunks.map((c: { key: string }) => c.key);
    const persisted = JSON.parse(await fs.readFile(join(jobDir, "job_state.json"), "utf8"));
    console.info(
      `[${SUITE}:${label}:assert] headCalls=${JSON.stringify(headCalls)} uploads=${JSON.stringify(uploads)} ` +
        `chunkKeys=${JSON.stringify(chunkKeys)} ledger=${JSON.stringify(persisted.outputs[0].completedParts)}`,
    );
    expect(headCalls).toHaveLength(1);
    expect([...headCalls[0]].sort()).toEqual(["pre-init", "pre-ledger-seg-1"]);
    // All 3 segments uploaded for real; the deleted ledger key is never committed.
    expect(uploads).toHaveLength(3);
    expect(chunkKeys).not.toContain("pre-ledger-seg-1");
    expect(chunkKeys.every((key: string) => uploads.includes(key))).toBe(true);
    expect(result.produced.videoFormats[0].initKey).toBe("pre-init");
  });

  it("@bugfix @regression-proof resume re-uploads every resumed object when the existence check fails", async () => {
    const label = "resume-check-fails";
    const jobDir = resolveJobDirInRoot(root, "u1", "j-resume-check-fails");
    await seedEncodedState(jobDir, {
      video: { id: "video-source", quality: "1080p", segments: 2 },
      audios: [{ id: "audio-0", language: "eng", label: "Main", segments: 2 }],
    });
    const raw = await fs.readFile(join(jobDir, "job_state.json"), "utf8");
    const state = JSON.parse(raw);
    for (const output of state.outputs) {
      output.init.uploaded = true;
      output.init.key = `pre-${output.id}-init`;
      output.init.sizeBytes = 4;
      for (const [i, segment] of output.segments.entries()) {
        segment.uploaded = true;
        segment.key = `pre-${output.id}-${i}`;
        segment.sizeBytes = 260;
      }
    }
    await fs.writeFile(join(jobDir, "job_state.json"), JSON.stringify(state, null, 2));

    const uploads: string[] = [];
    configureMediaIngestRuntime({
      encryptMediaObject: (bytes: Buffer) => bytes,
      uploadStorageObject: vi.fn(async (_token: string, key: string) => {
        uploads.push(key);
        return key;
      }),
      headStorageObjects: vi.fn(async () => {
        throw new Error("storage_head_failed: gateway_502");
      }),
    });

    const result = await uploadProducedMedia({
      token: "tok",
      userId: "u1",
      jobId: "j-resume-check-fails",
      placementId: "placement-resume-check-fails",
      scope: "source",
    });
    console.info(`[${SUITE}:${label}:assert] uploads=${uploads.length} produced=${JSON.stringify(result.produced.videoFormats[0])}`);
    // Unconfirmed = re-upload: 2 outputs × (init + 2 segments).
    expect(uploads).toHaveLength(6);
    expect(result.produced.videoFormats[0].initKey).not.toBe("pre-video-source-init");
  });

  it("re-running on a fully-uploaded state fires ZERO new upload calls", async () => {
    console.info(`[${SUITE}:already-done:setup] every segment marked uploaded`);
    const jobDir = resolveJobDirInRoot(root, "u1", "j-already-done");
    await seedEncodedState(jobDir, {
      video: { id: "video-source", quality: "1080p", segments: 3 },
      audios: [{ id: "audio-0", language: "eng", label: "Main", segments: 3 }],
    });
    // Flip everything to uploaded.
    const raw = await fs.readFile(join(jobDir, "job_state.json"), "utf8");
    const state = JSON.parse(raw);
    for (const output of state.outputs) {
      output.init.uploaded = true;
      output.init.key = `done-${output.id}-init`;
      output.init.sizeBytes = 4;
      for (let i = 0; i < output.segments.length; i++) {
        output.segments[i].uploaded = true;
        output.segments[i].key = `done-${output.id}-${i}`;
        output.segments[i].sizeBytes = 260;
      }
    }
    await fs.writeFile(join(jobDir, "job_state.json"), JSON.stringify(state, null, 2));

    const uploadCalls: string[] = [];
    configureMediaIngestRuntime({
      encryptMediaObject: (bytes: Buffer) => bytes,
      uploadStorageObject: vi.fn(async (_token: string, key: string) => {
        uploadCalls.push(key);
        return key;
      }),
    });

    console.info(`[${SUITE}:already-done:run] invoking uploadProducedMedia (expecting NO uploads)`);
    const result = await uploadProducedMedia({
      token: "tok",
      userId: "u1",
      jobId: "j-already-done",
      placementId: "placement-already-done",
      scope: "source",
    });
    console.info(
      `[${SUITE}:already-done:assert] new_uploads=${uploadCalls.length} uploadedKeys=${result.uploadedKeys.length}`,
    );
    if (uploadCalls.length > 0 || result.uploadedKeys.length > 0) {
      dumpUploadSnapshot("already-done-unexpected-uploads", {
        uploadPayloads: uploadCalls.map((key) => ({ key })),
        gatewayRequestCount: uploadCalls.length,
        produced: result.produced,
        uploadedKeys: result.uploadedKeys,
      });
    }

    expect(uploadCalls).toHaveLength(0);
    expect(result.produced.videoFormats[0].chunks).toHaveLength(3);
    expect(result.uploadedKeys.length).toBe(0); // nothing uploaded THIS call
  });

  it("scope='format' uploads only the matching variant (no audio, no source video)", async () => {
    console.info(`[${SUITE}:scope-format:setup] seeding source + 360p fallback + audio`);
    const jobDir = resolveJobDirInRoot(root, "u1", "j-format-scope");
    await seedEncodedState(jobDir, {
      video: { id: "video-source", quality: "1080p", segments: 3 },
      fallback: { id: "video-360p-h264", quality: "360p", segments: 3 },
      audios: [{ id: "audio-0", language: "eng", label: "Main", segments: 3 }],
    });

    const uploads: string[] = [];
    configureMediaIngestRuntime({
      encryptMediaObject: (bytes: Buffer) => bytes,
      uploadStorageObject: vi.fn(async (_token: string, key: string) => {
        uploads.push(key);
        return key;
      }),
    });

    console.info(`[${SUITE}:scope-format:run] invoking uploadProducedMedia scope=format variant=360p`);
    const result = await uploadProducedMedia({
      token: "tok",
      userId: "u1",
      jobId: "j-format-scope",
      placementId: "placement-format-scope",
      scope: "format",
      variant: "360p",
    });
    console.info(`[${SUITE}:scope-format:assert] uploads=${uploads.length} (expected 4)`);
    if (uploads.length !== 4 || result.produced.videoFormats.length !== 1 || result.produced.videoFormats[0].quality !== "360p") {
      dumpUploadSnapshot("scope-format-leak", {
        uploadPayloads: uploads.map((key) => ({ key })),
        gatewayRequestCount: uploads.length,
        produced: result.produced,
      });
    }

    // Only fallback's init + 3 segments should upload = 4 objects.
    expect(uploads.length).toBe(4);
    // Produced contains exactly one video format (the 360p variant), no audio.
    expect(result.produced.videoFormats).toHaveLength(1);
    expect(result.produced.videoFormats[0].quality).toBe("360p");
    expect(result.produced.audioTracks).toHaveLength(0);
    expect(result.produced.subtitleTracks).toHaveLength(0);
  });

  it("scope='source' skips the fallback variant (variant goes through its own format job)", async () => {
    console.info(`[${SUITE}:scope-source-skip-fallback:setup] seeding source + fallback + audio`);
    const jobDir = resolveJobDirInRoot(root, "u1", "j-source-only-scope");
    await seedEncodedState(jobDir, {
      video: { id: "video-source", quality: "1080p", segments: 3 },
      fallback: { id: "video-360p-h264", quality: "360p", segments: 3 },
      audios: [{ id: "audio-0", language: "eng", label: "Main", segments: 3 }],
    });

    const uploads: string[] = [];
    configureMediaIngestRuntime({
      encryptMediaObject: (bytes: Buffer) => bytes,
      uploadStorageObject: vi.fn(async (_token: string, key: string) => {
        uploads.push(key);
        return key;
      }),
    });

    console.info(`[${SUITE}:scope-source-skip-fallback:run] invoking uploadProducedMedia scope=source`);
    const result = await uploadProducedMedia({
      token: "tok",
      userId: "u1",
      jobId: "j-source-only-scope",
      placementId: "placement-source-only-scope",
      scope: "source",
    });
    console.info(`[${SUITE}:scope-source-skip-fallback:assert] uploads=${uploads.length} (expected 8)`);
    if (uploads.length !== 8 || result.produced.videoFormats[0]?.quality !== "1080p") {
      dumpUploadSnapshot("scope-source-skip-fallback-leak", {
        uploadPayloads: uploads.map((key) => ({ key })),
        gatewayRequestCount: uploads.length,
        produced: result.produced,
      });
    }

    // source upload: video-source(init+3) + audio-0(init+3) = 8 objects.
    // The 360p variant must NOT participate.
    expect(uploads.length).toBe(8);
    expect(result.produced.videoFormats).toHaveLength(1);
    expect(result.produced.videoFormats[0].quality).toBe("1080p");
  });

  it("@bugfix @regression-proof emits ≥5 distinct progress samples during a multi-chunk run", async () => {
    console.info(`[${SUITE}:progress-linear:setup] seeding 10+10 segments for a multi-chunk run`);
    const jobDir = resolveJobDirInRoot(root, "u1", "j-progress-linear");
    // 10 segments + init = 11 video uploads (per output). Plus 10 audio + init
    // = 11 audio uploads. 22 total objects — enough to comfortably exceed
    // 5 distinct progress samples.
    await seedEncodedState(jobDir, {
      video: { id: "video-source", quality: "1080p", segments: 10 },
      audios: [{ id: "audio-0", language: "eng", label: "Main", segments: 10 }],
    });

    let inflightDelay = 0;
    configureMediaIngestRuntime({
      encryptMediaObject: (bytes: Buffer) => bytes,
      uploadStorageObject: vi.fn(async (_token: string, key: string) => {
        // Real uploads aren't instant — sprinkle a tiny async delay so the
        // throttle sees enough wall-clock time pass between samples.
        await new Promise((r) => setTimeout(r, 25 + (inflightDelay++ % 5) * 5));
        return key;
      }),
    });

    const samples: Array<{ stage: string; pct: number }> = [];
    console.info(`[${SUITE}:progress-linear:run] invoking uploadProducedMedia, collecting progress samples`);
    await uploadProducedMedia({
      token: "tok",
      userId: "u1",
      jobId: "j-progress-linear",
      placementId: "placement-progress-linear",
      scope: "source",
      onProgress: (stage, pct) => samples.push({ stage, pct }),
    });
    const distinctPcts = new Set(samples.map((s) => s.pct));
    console.info(
      `[${SUITE}:progress-linear:assert] samples=${samples.length} distinct_pcts=${distinctPcts.size}`,
    );

    // Every sample is on the uploading stage.
    const nonUploadingSample = samples.find((s) => s.stage !== "uploading");
    if (nonUploadingSample) {
      dumpUploadSnapshot("progress-linear-bad-stage", { progressSamples: samples });
    }
    for (const sample of samples) {
      expect(sample.stage).toBe("uploading");
    }
    // ≥5 distinct progress values from the multi-chunk run.
    if (distinctPcts.size < 5) {
      dumpUploadSnapshot("progress-linear-too-few-distinct", { progressSamples: samples });
    }
    expect(distinctPcts.size).toBeGreaterThanOrEqual(5);

    // Monotonically non-decreasing.
    let last = -1;
    for (const sample of samples) {
      if (sample.pct < last) {
        dumpUploadSnapshot("progress-linear-non-monotonic", { progressSamples: samples });
      }
      expect(sample.pct).toBeGreaterThanOrEqual(last);
      last = sample.pct;
    }
  });

  it("respects scope='source' chunk encryption (encryptMediaObject IS called)", async () => {
    console.info(`[${SUITE}:encrypt:setup] seeding 2-segment source, expecting 3 encrypt calls (init + 2)`);
    const jobDir = resolveJobDirInRoot(root, "u1", "j-encrypt");
    await seedEncodedState(jobDir, {
      video: { id: "video-source", quality: "1080p", segments: 2 },
    });

    const encryptCalls: number[] = [];
    configureMediaIngestRuntime({
      encryptMediaObject: vi.fn((bytes: Buffer) => {
        encryptCalls.push(bytes.length);
        // Pretend AES-GCM expansion: ciphertext is plaintext + 16-byte tag.
        return Buffer.concat([bytes, Buffer.alloc(16, 0xaa)]);
      }),
      uploadStorageObject: vi.fn(async (_token: string, key: string) => key),
    });

    await uploadProducedMedia({
      token: "tok",
      userId: "u1",
      jobId: "j-encrypt",
      placementId: "placement-encrypt",
      scope: "source",
    });
    console.info(`[${SUITE}:encrypt:assert] encryptCalls=${encryptCalls.length} sizes=${JSON.stringify(encryptCalls)}`);
    if (encryptCalls.length !== 3) {
      dumpUploadSnapshot("encrypt-wrong-call-count", { retryCounter: encryptCalls.length });
    }

    // 1 init + 2 segments = 3 encrypt calls.
    expect(encryptCalls.length).toBe(3);
  });

  it("throws AUTH_REQUIRED when token is empty", async () => {
    console.info(`[${SUITE}:auth-required:setup] empty token, expecting AUTH_REQUIRED throw`);
    const jobDir = resolveJobDirInRoot(root, "u1", "j-no-auth");
    await seedEncodedState(jobDir, {
      video: { id: "video-source", quality: "1080p", segments: 1 },
    });
    configureMediaIngestRuntime({
      encryptMediaObject: (bytes: Buffer) => bytes,
      uploadStorageObject: vi.fn(async (_t: string, k: string) => k),
    });
    await expect(
      uploadProducedMedia({
        token: "",
        userId: "u1",
        jobId: "j-no-auth",
        placementId: "placement-no-auth",
        scope: "source",
      })
    ).rejects.toThrow("AUTH_REQUIRED");
  });
});

// #145: one playable media = one placementId = one silo. Every object one
// job uploads (video init + segments, audio, subtitles) must carry the id the
// caller passed, and two media uploaded concurrently must never share one.
describe("uploadProducedMedia per-media placement", () => {
  let root = "";
  let uploadForPlacement: typeof MediaProcessorModule.uploadProducedMedia;
  const uploads: Array<{ placementId: string | undefined }> = [];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "sf-upload-placement-"));
    uploads.length = 0;
    console.info(`[${SUITE}:placement:setup] temp root=${root}`);
    // Loaded after the hoisted vi.mock("@space/ffmpeg") factory: a static
    // import would evaluate the factory before its top-level mocks exist.
    const mod: typeof MediaProcessorModule = await import("../src/mediaProcessor");
    uploadForPlacement = mod.uploadProducedMedia;
    mod.configureMediaIngestRuntime({
      resolveJobDir: (userId: string, jobId: string) => resolveJobDirInRoot(root, userId, jobId),
      headStorageObjects: async (_token: string, keys: string[]) =>
        Object.fromEntries(keys.map((key) => [key, true])),
      encryptMediaObject: (bytes: Buffer) => bytes,
      uploadStorageObject: vi.fn(
        async (_token: string, _key: string, _payload: Uint8Array, options?: { placementId?: string }) => {
          uploads.push({ placementId: options?.placementId });
          const index = uploads.length;
          // Yield so concurrent jobs interleave their uploads.
          const { promise, resolve } = Promise.withResolvers<void>();
          setImmediate(resolve);
          await promise;
          return `media/${options?.placementId}/obj-${index}`;
        },
      ),
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("every object of one media (video, audio, subtitle) carries the same placementId", async () => {
    await seedEncodedState(resolveJobDirInRoot(root, "u1", "j-one-media"), {
      video: { id: "video-source", quality: "1080p", segments: 3 },
      audios: [{ id: "audio-0", language: "eng", label: "Main", segments: 3 }],
      subtitles: [{ id: "sub-0", language: "eng", label: "EN" }],
    });

    const result = await uploadForPlacement({
      token: "tok",
      userId: "u1",
      jobId: "j-one-media",
      placementId: "placement-one-media",
      scope: "source",
    });
    const ids = [...new Set(uploads.map((u) => u.placementId))];
    console.info(
      `[${SUITE}:placement:one-media] uploads=${uploads.length} distinctPlacementIds=${JSON.stringify(ids)} ` +
        `uploadedKeys=${JSON.stringify(result.uploadedKeys)}`,
    );
    // init + 3 segs video, init + 3 segs audio, 1 subtitle.
    expect(uploads).toHaveLength(9);
    expect(ids).toEqual(["placement-one-media"]);
    expect(result.uploadedKeys.every((key) => key.startsWith("media/placement-one-media/"))).toBe(true);
    expect(result.produced.subtitleTracks[0]?.objectKey.startsWith("media/placement-one-media/")).toBe(true);
  });

  it("two jobs uploading concurrently carry their own, different placementIds", async () => {
    for (const jobId of ["j-media-a", "j-media-b"]) {
      await seedEncodedState(resolveJobDirInRoot(root, "u1", jobId), {
        video: { id: "video-source", quality: "1080p", segments: 4 },
        audios: [{ id: "audio-0", language: "eng", label: "Main", segments: 2 }],
      });
    }

    const [a, b] = await Promise.all([
      uploadForPlacement({ token: "tok", userId: "u1", jobId: "j-media-a", placementId: "placement-media-a", scope: "source" }),
      uploadForPlacement({ token: "tok", userId: "u1", jobId: "j-media-b", placementId: "placement-media-b", scope: "source" }),
    ]);
    const ids = [...new Set(uploads.map((u) => u.placementId))].sort();
    console.info(
      `[${SUITE}:placement:concurrent] uploads=${uploads.length} a=${a.uploadedKeys.length} b=${b.uploadedKeys.length} ` +
        `placementIds=${JSON.stringify(ids)}`,
    );
    expect(a.uploadedKeys).toHaveLength(8);
    expect(b.uploadedKeys).toHaveLength(8);
    expect(a.uploadedKeys.every((key) => key.startsWith("media/placement-media-a/"))).toBe(true);
    expect(b.uploadedKeys.every((key) => key.startsWith("media/placement-media-b/"))).toBe(true);
    expect(ids).toEqual(["placement-media-a", "placement-media-b"]);
    expect(uploads.filter((u) => u.placementId === "placement-media-a")).toHaveLength(8);
    expect(uploads.filter((u) => u.placementId === "placement-media-b")).toHaveLength(8);
  });
});
