/**
 * @test-id LIB-FMT-11-INGEST-001
 * @level unit (real job state on a temp dir, fake storage upload, no network)
 * @req LIB-FMT-11
 * @req LIB-FMT-14
 * @why Change types 4 (vault v4) keeps one 16-byte seed per chunk list instead of every key, so a seeded upload
 *   must store chunk i under exactly the key every reader derives (the shared test vectors), keep those keys across
 *   a resume, and never mix seeded and random keys in one list. An account that is not switched must upload exactly
 *   as before: random keys, no seed anywhere in the job state or in what ingest hands the library.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { promises as fs, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ResumableJobStateStore } from "@space/content-core";
import { UploadSessionManager } from "@space/content-core/storageTransport";
import {
  base64ToBytes,
  chunkListKeys,
  chunkListToJson,
  packSeededChunkList,
  seedChunkKey,
} from "@space/library-db-definition/chunkLists";
import { chunkKeyFromSeed, newChunkKeySeed, verifiedChunkKeySeed } from "../src/chunkKeySeeds";
import { finalizeMediaJob } from "../src/mediaFinalize";

type SeedKeyVector = { seedHex: string; placementId: string; index: number; key: string };
const vectors = JSON.parse(
  readFileSync(join(__dirname, "../../library-db-definition/test-vectors/chunk-lists.json"), "utf8")
) as { seedKeys: SeedKeyVector[] };

const PLACEMENT = "0b9a3c52-6f1e-4d7a-9c11-2e5f8d3a7b40";
const hexToBase64 = (hex: string) => Buffer.from(hex, "hex").toString("base64");

describe("chunk key seeds (LIB-FMT-11 key mode 2)", () => {
  it("derives every seed key test vector", () => {
    expect(vectors.seedKeys.length).toBeGreaterThan(0);
    for (const vector of vectors.seedKeys) {
      expect(chunkKeyFromSeed(hexToBase64(vector.seedHex), vector.placementId, vector.index)).toBe(vector.key);
    }
  });

  it("verifies a seed only against the keys it derives, in order", () => {
    const seed = newChunkKeySeed();
    expect(base64ToBytes(seed)).toHaveLength(16);
    const keys = [0, 1, 2].map((i) => chunkKeyFromSeed(seed, PLACEMENT, i));
    expect(verifiedChunkKeySeed(seed, keys)).toBe(seed);
    expect(verifiedChunkKeySeed(seed, [keys[0]!, keys[2]!])).toBeNull(); // a missing chunk shifts the indexes
    expect(verifiedChunkKeySeed(seed, [...keys.slice(0, 2), `media/${PLACEMENT}/00000000-0000-4000-8000-000000000000`])).toBeNull();
    expect(verifiedChunkKeySeed(newChunkKeySeed(), keys)).toBeNull();
    expect(verifiedChunkKeySeed(seed, [])).toBeNull();
    expect(verifiedChunkKeySeed(undefined, keys)).toBeNull();
  });

  it("keeps the playback op of a 3 h 2160p seeded file far under the 1 MiB op cap", () => {
    // 2 s segments (the shortest we cut) over 3 h: 5400 chunks of up to 30 MB each.
    const count = 3 * 3600 / 2;
    const seed = base64ToBytes(newChunkKeySeed());
    const list = packSeededChunkList({
      placementId: PLACEMENT,
      seed,
      sizes: Array.from({ length: count }, (_, i) => 30_000_000 - i),
      starts: Array.from({ length: count }, (_, i) => i * 2.002),
    });
    expect(chunkListKeys(list)[count - 1]).toBe(seedChunkKey(seed, PLACEMENT, count - 1));
    const bytes = Buffer.byteLength(JSON.stringify(chunkListToJson(list)));
    console.info(`[chunk-key-seeds] 3 h 2160p seeded list: ${count} chunks, ${bytes} bytes of JSON`);
    expect(bytes).toBeLessThan(1024 * 1024);
  });
});

describe("finalizeMediaJob chunk keys", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sf-chunk-key-seeds-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** A job dir with one finished 1080p video output (3 chunks) and one audio output (2 chunks). */
  const makeJob = async (name: string) => {
    const jobDir = join(root, name);
    for (const dir of ["video", "audio"]) await fs.mkdir(join(jobDir, dir), { recursive: true });
    await fs.writeFile(join(jobDir, "input.mp4"), "input");
    const file = async (rel: string) => {
      await fs.writeFile(join(jobDir, rel), `bytes of ${rel}`);
      return { path: join(jobDir, rel) };
    };
    const stateStore = await ResumableJobStateStore.open({ jobDir, inputPath: join(jobDir, "input.mp4"), userId: "user-1" });
    const state = stateStore.getState();
    state.outputs.push(
      {
        id: "video-1080p",
        kind: "video",
        quality: "1080p",
        codec: "h264",
        segmentSeconds: 6,
        outputDir: join(jobDir, "video"),
        init: await file("video/init.m4s"),
        segments: [await file("video/seg-1.m4s"), await file("video/seg-2.m4s"), await file("video/seg-3.m4s")],
        durationSeconds: 18,
        encodingComplete: true,
      },
      {
        id: "audio-en",
        kind: "audio",
        codec: "aac",
        segmentSeconds: 6,
        outputDir: join(jobDir, "audio"),
        init: await file("audio/init.m4s"),
        segments: [await file("audio/seg-1.m4s"), await file("audio/seg-2.m4s")],
        language: "en",
        label: "English",
        encodingComplete: true,
      }
    );
    await stateStore.save();
    return { jobDir, stateStore };
  };

  type UploadCall = { path: string; objectKey?: string };

  const run = async (
    job: { jobDir: string; stateStore: ResumableJobStateStore },
    opts: { seedChunkKeys: boolean; calls: UploadCall[]; failOn?: string; present?: Set<string> }
  ) => {
    let randomCounter = 0;
    const state = job.stateStore.getState();
    return finalizeMediaJob({
      stateStore: job.stateStore,
      placementId: PLACEMENT,
      seedChunkKeys: opts.seedChunkKeys,
      state,
      sessionManager: new UploadSessionManager(job.stateStore),
      subtitleStates: [],
      audioStreamCount: 1,
      includeAudio: true,
      inputPath: join(job.jobDir, "input.mp4"),
      jobDir: job.jobDir,
      durationSeconds: 18,
      chapterBoundaries: [],
      onUploadProgress: () => {},
      headObjects: async (keys) => Object.fromEntries(keys.map((key) => [key, opts.present?.has(key) ?? true])),
      uploadFile: async (filePath, options) => {
        opts.calls.push({ path: filePath, ...(options?.objectKey ? { objectKey: options.objectKey } : {}) });
        if (opts.failOn && filePath.endsWith(opts.failOn)) throw new Error("network down");
        const bytes = await fs.readFile(filePath);
        // The gateway stores a caller-chosen key as is; otherwise it picks a random one.
        const key = options?.objectKey ?? `media/${PLACEMENT}/random-${(randomCounter += 1)}`;
        return { key, sizeBytes: bytes.length, checksum: "c" };
      },
    });
  };

  const persistedOutputs = (jobDir: string) =>
    (JSON.parse(readFileSync(join(jobDir, "job_state.json"), "utf8")) as { outputs: Array<{ id: string; chunkKeySeed?: string }> })
      .outputs;

  it("an unswitched account uploads exactly as before: no caller key, no seed anywhere", async () => {
    const job = await makeJob("unswitched");
    const calls: UploadCall[] = [];
    const produced = await run(job, { seedChunkKeys: false, calls });

    expect(calls).toHaveLength(7);
    expect(calls.every((call) => call.objectKey === undefined)).toBe(true);
    expect(persistedOutputs(job.jobDir).every((output) => !("chunkKeySeed" in output))).toBe(true);
    expect("chunkKeySeed" in produced.videoFormats[0]!).toBe(false);
    expect("chunkKeySeed" in produced.audioTracks[0]!).toBe(false);
    expect(produced.videoFormats[0]!.chunks.map((chunk) => chunk.key).every((key) => key.includes("/random-"))).toBe(true);
  });

  it("a switched account stores chunk i under the seed's key i and hands the seed to the library", async () => {
    const job = await makeJob("switched");
    const calls: UploadCall[] = [];
    const produced = await run(job, { seedChunkKeys: true, calls });

    const seeds = Object.fromEntries(persistedOutputs(job.jobDir).map((output) => [output.id, output.chunkKeySeed]));
    const videoSeed = seeds["video-1080p"]!;
    const audioSeed = seeds["audio-en"]!;
    expect(base64ToBytes(videoSeed)).toHaveLength(16);
    expect(audioSeed).not.toBe(videoSeed);

    const video = produced.videoFormats[0]!;
    expect(video.chunkKeySeed).toBe(videoSeed);
    expect(video.chunks.map((chunk) => chunk.key)).toEqual(
      [0, 1, 2].map((i) => seedChunkKey(base64ToBytes(videoSeed), PLACEMENT, i))
    );
    expect(produced.audioTracks[0]!.chunkKeySeed).toBe(audioSeed);
    expect(produced.audioTracks[0]!.chunks.map((chunk) => chunk.key)).toEqual(
      [0, 1].map((i) => chunkKeyFromSeed(audioSeed, PLACEMENT, i))
    );
    // Init segments are not part of a chunk list: they keep a random key.
    expect(calls.filter((call) => call.path.endsWith("init.m4s")).every((call) => call.objectKey === undefined)).toBe(true);
    expect(video.initKey).toContain("/random-");
  });

  it("a resumed switched upload keeps the persisted seed, so a re-uploaded chunk lands on the same key", async () => {
    const job = await makeJob("resume");
    const first: UploadCall[] = [];
    await expect(run(job, { seedChunkKeys: true, calls: first, failOn: "video/seg-3.m4s" })).rejects.toThrow("network down");
    const seedBefore = persistedOutputs(job.jobDir).find((output) => output.id === "video-1080p")!.chunkKeySeed!;
    expect(seedBefore).toBeTruthy();

    // A new process: the state comes back from disk.
    const reopened = await ResumableJobStateStore.open({
      jobDir: job.jobDir,
      inputPath: join(job.jobDir, "input.mp4"),
      userId: "user-1",
    });
    const second: UploadCall[] = [];
    const produced = await run({ jobDir: job.jobDir, stateStore: reopened }, { seedChunkKeys: true, calls: second });

    const expected = [0, 1, 2].map((i) => chunkKeyFromSeed(seedBefore, PLACEMENT, i));
    expect(produced.videoFormats[0]!.chunkKeySeed).toBe(seedBefore);
    expect(produced.videoFormats[0]!.chunks.map((chunk) => chunk.key)).toEqual(expected);
    expect(second.find((call) => call.path.endsWith("video/seg-3.m4s"))?.objectKey).toBe(expected[2]);
    expect(first.find((call) => call.path.endsWith("video/seg-3.m4s"))?.objectKey).toBe(expected[2]);
  });

  it("an output that already uploaded a chunk under a random key stays random to the end", async () => {
    const job = await makeJob("started-random");
    // An unswitched run stored the first chunk under a random key (persisted); the account switched before the retry.
    const randomKey = `media/${PLACEMENT}/11111111-2222-4333-8444-555555555555`;
    const firstChunk = job.stateStore.getState().outputs[0]!.segments[0]!;
    Object.assign(firstChunk, { uploaded: true, key: randomKey, sizeBytes: 20, checksum: "c" });
    await job.stateStore.save();
    const calls: UploadCall[] = [];
    const produced = await run(job, { seedChunkKeys: true, calls, present: new Set([randomKey]) });

    expect(produced.videoFormats[0]!.chunks[0]!.key).toBe(randomKey);
    // The audio output had not started: it is seeded.
    expect(produced.audioTracks[0]!.chunkKeySeed).toBeTruthy();

    const video = produced.videoFormats[0]!;
    expect(video.chunkKeySeed).toBeUndefined();
    expect(persistedOutputs(job.jobDir).find((output) => output.id === "video-1080p")!.chunkKeySeed).toBeUndefined();
    expect(calls.filter((call) => call.path.includes("/video/")).every((call) => call.objectKey === undefined)).toBe(true);
    expect(video.chunks.slice(1).map((chunk) => chunk.key).every((key) => key.includes("/random-"))).toBe(true);
  });
});
