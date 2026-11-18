/**
 * @bugfix @regression-proof retranscode-progress-stuck-at-1pct (issue #25 P14,
 * ultimate stress run 1791294602218864000, c005: three replan 720p jobs
 * a663775e / cfdcab54 / abb6127b flagged job-stuck at progressPct=1 for
 * 180 s+, yet all succeeded 7-9 min later).
 *
 * Root cause: a replan (retranscode) encode streams the source into ffmpeg
 * stdin, so produceMediaOutputs skips probe and only knows the duration from
 * `inputDurationSeconds`. The adapter never passed it → durationMs=null →
 * ffmpeg's out_time never became a percentage → progress pinned at the
 * floor (1 %) until the step finished.
 *
 * Fix: forward the source format row's `durationSeconds`; when an older row
 * lacks it, report the share of source pieces streamed into ffmpeg.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildBadgerStepDeps,
  type ProduceMediaOutputsFn,
  type UploadProducedMediaFn,
} from "../src/modules/badger/steps/deps-adapter";
import type { BadgerLibraryDbService } from "../src/modules/badgerLibraryDb";

const SUITE = "badger-retranscode-progress";
const EMPTY_PRODUCED = { videoFormats: [], audioTracks: [], subtitleTracks: [] };

type ProducePayload = {
  jobId: string;
  userId: string;
  inputDurationSeconds?: number | null;
  inputStream?: AsyncIterable<Uint8Array>;
};

describe(`[${SUITE}] replan encode reports real progress`, () => {
  let stagingRoot = "";

  beforeEach(() => {
    stagingRoot = mkdtempSync(join(tmpdir(), "sf-retranscode-progress-"));
    process.env.SF_TRANSCODE_DIR = stagingRoot;
    console.info(`[${SUITE}:beforeEach] stagingRoot=${stagingRoot}`);
  });

  afterEach(() => {
    delete process.env.SF_TRANSCODE_DIR;
    rmSync(stagingRoot, { recursive: true, force: true });
  });

  const run = async (sourceDurationSeconds: number | null, chunkCount: number) => {
    const row = {
      id: "fmt-src",
      fileId: "f-1",
      quality: "1080p",
      initKey: "init.k",
      durationSeconds: sourceDurationSeconds,
      chunks: Array.from({ length: chunkCount }, (_, i) => ({ key: `c${i}` })),
    };
    const libraryDb = {
      isOpen: () => true,
      call: vi.fn(async (method: string) => {
        if (method === "listMediaFormats") return [row];
        throw new Error(`unexpected libraryDb.call: ${method}`);
      }),
    } as unknown as BadgerLibraryDbService;
    const payloads: ProducePayload[] = [];
    const produceMediaOutputs = vi.fn(async (payload: ProducePayload) => {
      payloads.push(payload);
      // Consume the stream like ffmpeg's stdin pump does.
      if (payload.inputStream) for await (const chunk of payload.inputStream) void chunk;
      return {
        jobDir: join(stagingRoot, payload.userId, payload.jobId),
        stateStore: { getState: () => ({ outputs: [{ id: "video-720p-h264", kind: "video", segments: [{}] }] }) },
        encoder: "cpu",
        produced: EMPTY_PRODUCED,
      };
    });
    const deps = buildBadgerStepDeps({
      libraryDb,
      produceMediaOutputs: produceMediaOutputs as unknown as ProduceMediaOutputsFn,
      uploadProducedMedia: vi.fn() as unknown as UploadProducedMediaFn,
      downloadAndDecryptObject: vi.fn(async () => Buffer.from("x")),
      resolveToken: () => "tok",
      resolveLibraryKey: () => "a".repeat(44),
      authWaitMs: 1_000,
      authPollMs: 10,
    });
    const progress: number[] = [];
    await deps.retranscodeFormat!({
      userId: "user-1",
      jobId: "job-a663775e",
      mediaId: "m-1",
      fileId: "f-1",
      targetVariant: "720p",
      sourceFormatId: "fmt-src",
      sourceVariant: "1080p",
      signal: new AbortController().signal,
      onProgress: (stage, pct) => {
        if (stage === "transcoding") progress.push(pct);
      },
    });
    console.info(
      `[${SUITE}] sourceDurationSeconds=${sourceDurationSeconds} chunks=${chunkCount} inputDurationSeconds=${payloads[0]?.inputDurationSeconds} progress=${JSON.stringify(progress)}`
    );
    return { payload: payloads[0], progress };
  };

  it("forwards the source row's duration so ffmpeg out_time becomes a percentage", async () => {
    const { payload } = await run(1440, 4);
    expect(payload.inputDurationSeconds).toBe(1440);
  });

  it("source row without a duration → progress follows the streamed source pieces, monotonic, below 100", async () => {
    const { payload, progress } = await run(null, 9);
    expect(payload.inputDurationSeconds).toBeNull();
    expect(progress.length).toBe(9);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(progress[0]).toBeGreaterThan(1);
    expect(progress.at(-1)).toBe(99);
  });
});
