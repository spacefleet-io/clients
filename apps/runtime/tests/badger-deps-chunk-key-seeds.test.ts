/**
 * @test-id LIB-FMT-11-INGEST-002
 * @level unit (deps adapter with a fake library DB and fake upload, real job_state.json on a temp dir)
 * @req LIB-FMT-11
 * @req LIB-FMT-14
 * @why Ingest may name chunks after a seed only once the account's library is converted to change types 4
 *   (`isPackedPlaybackLayout`). Before that, the upload and the library writes must stay exactly as they are today:
 *   no seed flag to the uploader, no `chunkKeySeed` field in `addMediaFormat` / `addAudioTrackWithChunks`. A job
 *   resumed in a new process must hand the library the same seed, and only when the recovered keys are the seed's.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chunkKeyFromSeed } from "@space/ingest-core/chunkKeySeeds";
import type { ProducedMedia } from "@space/ingest-core/mediaProcessor";
import type { BadgerLibraryDbService } from "../src/modules/badgerLibraryDb";
import {
  __resetBadgerStepDepsAdapter,
  buildBadgerStepDeps,
  recoverProducedMediaFromState,
  type ProduceMediaOutputsFn,
  type UploadProducedMediaFn,
} from "../src/modules/badger/steps/deps-adapter";

const PLACEMENT = "0b9a3c52-6f1e-4d7a-9c11-2e5f8d3a7b40";
const SEED = Buffer.from([...Array(16).keys()]).toString("base64");
const EMPTY_PRODUCED: ProducedMedia = { videoFormats: [], audioTracks: [], subtitleTracks: [] };
const ORIGINAL_TRANSCODE_DIR = process.env.SF_TRANSCODE_DIR;

let scratch = "";

beforeEach(() => {
  __resetBadgerStepDepsAdapter();
  scratch = mkdtempSync(join(tmpdir(), "sf-chunk-key-seeds-"));
  process.env.SF_TRANSCODE_DIR = scratch;
});

afterEach(() => {
  __resetBadgerStepDepsAdapter();
  if (ORIGINAL_TRANSCODE_DIR === undefined) delete process.env.SF_TRANSCODE_DIR;
  else process.env.SF_TRANSCODE_DIR = ORIGINAL_TRANSCODE_DIR;
  rmSync(scratch, { recursive: true, force: true });
});

type Calls = Array<[string, unknown[]]>;

/** `packed`: what `isPackedPlaybackLayout` answers; "missing" = a library DB without the method (it throws). */
const buildDeps = (packed: boolean | "missing", calls: Calls = []) => {
  const libraryDb = {
    isOpen: () => true,
    call: vi.fn(async (method: string, args: unknown[] = []) => {
      calls.push([method, args]);
      if (method === "isPackedPlaybackLayout") {
        if (packed === "missing") throw new Error("unknown method isPackedPlaybackLayout");
        return packed;
      }
      if (method === "addMediaFormat") return "fmt-1";
      if (method === "linkFileToMedia") return "file-1";
      return null;
    }),
  } as unknown as BadgerLibraryDbService;
  const uploadProducedMedia = vi.fn(async () => ({ produced: EMPTY_PRODUCED, uploadedKeys: [] }));
  const deps = buildBadgerStepDeps({
    libraryDb,
    produceMediaOutputs: vi.fn() as unknown as ProduceMediaOutputsFn,
    uploadProducedMedia: uploadProducedMedia as unknown as UploadProducedMediaFn,
    resolveToken: () => "tok",
    resolveLibraryKey: () => "a".repeat(44),
  });
  return { deps, uploadProducedMedia };
};

const uploadInput = (jobId: string) => ({
  userId: "user-1",
  jobId,
  token: "tok",
  scope: "source" as const,
  placementId: PLACEMENT,
  signal: new AbortController().signal,
});

describe("chunk key seeds through the deps adapter", () => {
  it.each([
    [true, true],
    [false, false],
    ["missing" as const, false],
  ])("isPackedPlaybackLayout=%s → seeds chunk keys: %s", async (packed, seeds) => {
    const { deps, uploadProducedMedia } = buildDeps(packed);
    await deps.uploadOutputs(uploadInput(`job-${String(packed)}`));
    const args = (uploadProducedMedia.mock.calls[0] as unknown[] | undefined)?.[0] as Record<string, unknown>;
    if (seeds) expect(args.seedChunkKeys).toBe(true);
    // Unswitched: the uploader input is exactly today's, without the flag at all.
    else expect("seedChunkKeys" in args).toBe(false);
  });

  it("format commit hands the seed to addMediaFormat only when the produced format has one", async () => {
    const calls: Calls = [];
    const { deps } = buildDeps(true, calls);
    const format = (chunkKeySeed?: string): ProducedMedia["videoFormats"][number] => ({
      quality: "360p",
      codec: "h264",
      codecString: null,
      initKey: `media/${PLACEMENT}/init`,
      initSize: 10,
      durationSeconds: 12,
      totalSize: 30,
      chunks: [0, 1].map((i) => ({ key: chunkKeyFromSeed(SEED, PLACEMENT, i), sizeBytes: 10, startSeconds: i * 6 })),
      ...(chunkKeySeed ? { chunkKeySeed } : {}),
    });
    for (const [jobId, seed] of [["fmt-seeded", SEED], ["fmt-random", undefined]] as const) {
      await deps.commit({
        userId: "user-1",
        jobId,
        mediaId: "media-1",
        filename: "/tmp/Orchard.mkv",
        scope: "format",
        variant: "360p",
        produced: { ...EMPTY_PRODUCED, videoFormats: [format(seed)] },
        sourceFileId: "file-src",
        signal: new AbortController().signal,
      });
    }
    const options = calls.filter(([method]) => method === "addMediaFormat").map(([, args]) => args[7] as Record<string, unknown>);
    expect(options).toHaveLength(2);
    expect(options[0]!.chunkKeySeed).toBe(SEED);
    expect("chunkKeySeed" in options[1]!).toBe(false);
  });

  it("a job recovered from disk carries its seed only when the uploaded keys are the seed's", () => {
    const writeState = (jobId: string, keys: string[]) => {
      const dir = join(scratch, "user-1", jobId);
      mkdirSync(dir, { recursive: true });
      const segment = (key: string, i: number) => ({ path: `/x/seg-${i}`, key, uploaded: true, sizeBytes: 10, startSeconds: i * 6 });
      const output = (id: string, kind: "video" | "audio") => ({
        id,
        kind,
        quality: "1080p",
        segmentSeconds: 6,
        outputDir: "/x",
        init: { path: "/x/init", key: `media/${PLACEMENT}/init-${id}`, uploaded: true, sizeBytes: 5 },
        segments: keys.map(segment),
        encodingComplete: true,
        chunkKeySeed: SEED,
      });
      writeFileSync(
        join(dir, "job_state.json"),
        JSON.stringify({ version: 1, outputs: [output("video", "video"), output("audio", "audio")], subtitles: [] })
      );
    };
    const seededKeys = [0, 1, 2].map((i) => chunkKeyFromSeed(SEED, PLACEMENT, i));
    writeState("job-seeded", seededKeys);
    writeState("job-mismatch", [seededKeys[0]!, `media/${PLACEMENT}/random-2`, seededKeys[2]!]);

    const seeded = recoverProducedMediaFromState("user-1", "job-seeded");
    expect(seeded?.videoFormats[0]?.chunkKeySeed).toBe(SEED);
    expect(seeded?.audioTracks[0]?.chunkKeySeed).toBe(SEED);
    const mismatch = recoverProducedMediaFromState("user-1", "job-mismatch");
    expect(mismatch?.videoFormats[0]).toBeDefined();
    expect("chunkKeySeed" in mismatch!.videoFormats[0]!).toBe(false);
  });
});
