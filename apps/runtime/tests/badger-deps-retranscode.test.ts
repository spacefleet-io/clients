/**
 * Tests for the Phase 7 `retranscodeFormat` dep implementation in
 * `buildBadgerStepDeps`. These are the integration tests for the streaming
 * pipeline: chunk fetch ordering, async iterable shape, ffmpeg invocation
 * via the Phase 3 `produceMediaOutputs` path in streaming mode, abort
 * propagation.
 *
 * Heavy mocking — both `libraryDb.call`, `downloadAndDecryptObject`, and
 * `produceMediaOutputs` are vi.fn() spies. We're not testing ffmpeg here;
 * we're testing that the streaming dep:
 *   - reads the right source row from library-db
 *   - hands produceMediaOutputs an `inputStream` (async iterable) that
 *     yields init bytes first, then each chunk's bytes in order, each
 *     triggering exactly one downloadAndDecryptObject call
 *   - sets `inputPath` to a synthetic placeholder (not a concat.txt path)
 *     since stream mode bypasses the on-disk concat demuxer
 *   - invokes produceMediaOutputs with targetVariants: [target] +
 *     sourceQualityOverride
 *   - fails loud on missing token / missing library key / missing chunks /
 *     unknown variant
 *   - honours signal.aborted between chunk yields (no extra downloads
 *     after abort)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBadgerStepDeps, type ProduceMediaOutputsFn } from "../src/modules/badger/steps/deps-adapter";
import type { BadgerStepDeps } from "../src/modules/badger/steps/deps";
import type { BadgerLibraryDbService } from "../src/modules/badgerLibraryDb";
import { StorageTunnelError } from "@space/shared/storageTunnel";

const SUITE = "badger-deps-retranscode";

const jsonReplacer = (_key: string, value: unknown) => {
  if (value instanceof Uint8Array) {
    return `<Uint8Array bytes=${value.byteLength}>`;
  }
  if (value instanceof Buffer) {
    return `<Buffer bytes=${value.byteLength}>`;
  }
  return value;
};

const dumpBadgerDepsRetranscodeSnapshot = (
  label: string,
  ctx: {
    jobId?: string;
    userId?: string;
    fileId?: string;
    mediaId?: string;
    targetVariant?: string;
    sourceVariant?: string;
    sourceFormatId?: string;
    rows?: unknown;
    libraryDbCalls?: unknown;
    libraryDbCallsCount?: number;
    produceMediaOutputsCalls?: number;
    produceMediaOutputsArgs?: unknown;
    downloadCallCount?: number;
    downloadedKeys?: unknown;
    collectedChunks?: unknown;
    inputStreamDefined?: boolean;
    inputPath?: string;
    targetVariants?: unknown;
    result?: unknown;
    stagingRoot?: string;
    abortReason?: string;
    expected?: unknown;
    actual?: unknown;
    extra?: Record<string, unknown>;
    error?: unknown;
  } = {}
) => {
  try {
    console.error(`=== [${SUITE}:${label}] badger-deps-retranscode snapshot ===`);
    if (ctx.jobId !== undefined) console.error(`jobId: ${ctx.jobId}`);
    if (ctx.userId !== undefined) console.error(`userId: ${ctx.userId}`);
    if (ctx.fileId !== undefined) console.error(`fileId: ${ctx.fileId}`);
    if (ctx.mediaId !== undefined) console.error(`mediaId: ${ctx.mediaId}`);
    if (ctx.targetVariant !== undefined) console.error(`targetVariant: ${ctx.targetVariant}`);
    if (ctx.sourceVariant !== undefined) console.error(`sourceVariant: ${ctx.sourceVariant}`);
    if (ctx.sourceFormatId !== undefined) console.error(`sourceFormatId: ${ctx.sourceFormatId}`);
    if (ctx.rows !== undefined) {
      console.error(`rows:\n${JSON.stringify(ctx.rows, jsonReplacer, 2)}`);
    }
    if (ctx.libraryDbCalls !== undefined) {
      console.error(`libraryDbCalls:\n${JSON.stringify(ctx.libraryDbCalls, jsonReplacer, 2)}`);
    }
    if (ctx.libraryDbCallsCount !== undefined) {
      console.error(`libraryDbCallsCount: ${ctx.libraryDbCallsCount}`);
    }
    if (ctx.produceMediaOutputsCalls !== undefined) {
      console.error(`produceMediaOutputsCalls: ${ctx.produceMediaOutputsCalls}`);
    }
    if (ctx.produceMediaOutputsArgs !== undefined) {
      console.error(`produceMediaOutputsArgs:\n${JSON.stringify(ctx.produceMediaOutputsArgs, jsonReplacer, 2)}`);
    }
    if (ctx.downloadCallCount !== undefined) console.error(`downloadCallCount: ${ctx.downloadCallCount}`);
    if (ctx.downloadedKeys !== undefined) {
      console.error(`downloadedKeys:\n${JSON.stringify(ctx.downloadedKeys, jsonReplacer, 2)}`);
    }
    if (ctx.collectedChunks !== undefined) {
      console.error(`collectedChunks:\n${JSON.stringify(ctx.collectedChunks, jsonReplacer, 2)}`);
    }
    if (ctx.inputStreamDefined !== undefined) {
      console.error(`inputStreamDefined: ${ctx.inputStreamDefined}`);
    }
    if (ctx.inputPath !== undefined) console.error(`inputPath: ${ctx.inputPath}`);
    if (ctx.targetVariants !== undefined) {
      console.error(`targetVariants: ${JSON.stringify(ctx.targetVariants)}`);
    }
    if (ctx.result !== undefined) {
      console.error(`result:\n${JSON.stringify(ctx.result, jsonReplacer, 2)}`);
    }
    if (ctx.stagingRoot !== undefined) console.error(`stagingRoot: ${ctx.stagingRoot}`);
    if (ctx.abortReason !== undefined) console.error(`abortReason: ${ctx.abortReason}`);
    if (ctx.expected !== undefined) {
      console.error(`expected:\n${JSON.stringify(ctx.expected, jsonReplacer, 2)}`);
    }
    if (ctx.actual !== undefined) {
      console.error(`actual:\n${JSON.stringify(ctx.actual, jsonReplacer, 2)}`);
    }
    if (ctx.extra !== undefined) {
      console.error(`extra:\n${JSON.stringify(ctx.extra, jsonReplacer, 2)}`);
    }
    if (ctx.error !== undefined) {
      const e = ctx.error;
      console.error(`error: ${e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ""}` : String(e)}`);
    }
    console.error(`=== [${SUITE}:${label}] end snapshot ===`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

type FormatRow = {
  id: string;
  fileId: string;
  quality: string;
  initKey: string | null;
  chunks: Array<{ key: string }>;
};

const buildLibraryDb = (rows: FormatRow[]) => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    libraryDb: {
      isOpen: () => true,
      call: vi.fn(async (method: string, args: unknown[] = []) => {
        calls.push({ method, args });
        if (method === "listMediaFormatsForFile") {
          return null;
        }
        if (method === "listMediaFormats") {
          return rows;
        }
        throw new Error(`unexpected libraryDb.call: ${method}`);
      }),
    } as unknown as BadgerLibraryDbService,
    calls,
  };
};

describe("buildBadgerStepDeps.retranscodeFormat — streaming pipeline", () => {
  console.info(`[${SUITE}:describe] entering "buildBadgerStepDeps.retranscodeFormat — streaming pipeline"`);
  let stagingRoot = "";

  beforeEach(() => {
    stagingRoot = mkdtempSync(join(tmpdir(), "sf-retrans-"));
    process.env.SF_TRANSCODE_DIR = stagingRoot;
    console.info(`[${SUITE}:beforeEach] stagingRoot=${stagingRoot}`);
  });

  afterEach(() => {
    delete process.env.SF_TRANSCODE_DIR;
    rmSync(stagingRoot, { recursive: true, force: true });
    console.info(`[${SUITE}:afterEach] cleaned stagingRoot`);
  });

  type ProduceMediaOutputsMock = ReturnType<typeof vi.fn>;

  const defaultProduceMock = (consumeStream = true): ProduceMediaOutputsMock =>
    vi.fn(
      async (input: {
        jobId: string;
        userId: string;
        inputStream?: AsyncIterable<Uint8Array>;
      }) => {
        if (consumeStream && input.inputStream) {
          for await (const _chunk of input.inputStream) {
            void _chunk;
          }
        }
        return {
          jobDir: join(stagingRoot, input.userId, input.jobId),
          stateStore: {
            getState: () => ({
              outputs: [
                {
                  id: "video-720p-h264",
                  kind: "video",
                  segments: [{}, {}, {}],
                },
              ],
            }),
          },
          encoder: "cpu",
          produced: { videoFormats: [], audioTracks: [], subtitleTracks: [] },
        };
      }
    );

  const buildDeps = (
    rows: FormatRow[],
    overrides: {
      downloadAndDecryptObject?: (
        token: string,
        objectKey: string,
        libraryKeyBase64: string
      ) => Promise<Buffer>;
      produceMediaOutputs?: ProduceMediaOutputsMock;
      resolveToken?: () => string | null;
      resolveLibraryKey?: () => string | null;
      sourceDownloadRetryDelaysMs?: readonly number[];
    } = {}
  ) => {
    const { libraryDb, calls } = buildLibraryDb(rows);
    const produceMediaOutputs =
      overrides.produceMediaOutputs ?? defaultProduceMock();
    const downloadAndDecryptObject =
      overrides.downloadAndDecryptObject ??
      vi.fn(async (_token: string, objectKey: string) => {
        return Buffer.from(`decrypted:${objectKey}`);
      });
    const deps = buildBadgerStepDeps({
      libraryDb,
      produceMediaOutputs: produceMediaOutputs as unknown as ProduceMediaOutputsFn,
      uploadProducedMedia: vi.fn(async () => ({
        produced: { videoFormats: [], audioTracks: [], subtitleTracks: [] },
        uploadedKeys: [],
      })),
      downloadAndDecryptObject,
      resolveToken: overrides.resolveToken ?? (() => "tok-1"),
      resolveLibraryKey: overrides.resolveLibraryKey ?? (() => "a".repeat(44)),
      // These tests assert the fail-loud codes; the bounded readiness wait
      // itself is covered by badger-deps-auth-wait.test.ts.
      authWaitMs: 0,
      ...(overrides.sourceDownloadRetryDelaysMs
        ? { sourceDownloadRetryDelaysMs: overrides.sourceDownloadRetryDelaysMs }
        : {}),
    });
    return { deps, libraryDb, calls, produceMediaOutputs, downloadAndDecryptObject };
  };

  it("provides an inputStream to produceMediaOutputs (no concat.txt, no temp staging)", async () => {
    const label = "provides-inputStream-no-concat";
    console.info(`[${SUITE}:${label}] start`);
    const { deps, produceMediaOutputs } = buildDeps([
      {
        id: "fmt-src",
        fileId: "f-1",
        quality: "1080p",
        initKey: "init.k",
        chunks: [{ key: "chunk-1" }, { key: "chunk-2" }, { key: "chunk-3" }],
      },
    ]);

    console.info(`[${SUITE}:${label}] invoking retranscodeFormat job-rt-1 fileId=f-1 target=720p`);
    const result = await deps.retranscodeFormat!({
      userId: "user-1",
      jobId: "job-rt-1",
      fileId: "f-1",
      targetVariant: "720p",
      sourceFormatId: "fmt-src",
      sourceVariant: "1080p",
      mediaId: "m-1",
      signal: new AbortController().signal,
    });

    const args = produceMediaOutputs.mock.calls[0][0];
    console.info(`[${SUITE}:${label}] produceMediaOutputs called ${produceMediaOutputs.mock.calls.length}x, inputPath=${String(args?.inputPath)} targetVariants=${JSON.stringify(args?.targetVariants)} result.variant=${String(result?.variant)} segmentCount=${String(result?.segmentCount)}`);
    try {
      expect(produceMediaOutputs).toHaveBeenCalledTimes(1);
      expect(args.inputStream).toBeDefined();
      expect(typeof args.inputStream[Symbol.asyncIterator]).toBe("function");
      expect(args.inputPath).not.toMatch(/concat\.txt$/);
      expect(args.inputPath).toMatch(/^retranscode-stream:/);
      expect(args.targetVariants).toEqual(["720p"]);
      expect(args.includeFallback).toBe(false);
      expect(args.includeSource).toBe(false);
      expect(args.includeAudio).toBe(false);
      expect(args.includeSubtitles).toBe(false);
      expect(args.includeChapters).toBe(false);
      expect(args.sourceQualityOverride).toBe("1080p");
      expect(result.variant).toBe("720p");
      expect(result.segmentCount).toBe(3);
    } catch (err) {
      dumpBadgerDepsRetranscodeSnapshot(label, {
        jobId: "job-rt-1",
        userId: "user-1",
        fileId: "f-1",
        mediaId: "m-1",
        targetVariant: "720p",
        sourceVariant: "1080p",
        sourceFormatId: "fmt-src",
        produceMediaOutputsCalls: produceMediaOutputs.mock.calls.length,
        produceMediaOutputsArgs: args,
        inputStreamDefined: args?.inputStream !== undefined,
        inputPath: args?.inputPath,
        targetVariants: args?.targetVariants,
        result,
        stagingRoot,
        expected: {
          calls: 1,
          inputPathStartsWith: "retranscode-stream:",
          targetVariants: ["720p"],
          variant: "720p",
          segmentCount: 3,
        },
        actual: {
          calls: produceMediaOutputs.mock.calls.length,
          inputPath: args?.inputPath,
          targetVariants: args?.targetVariants,
          variant: result?.variant,
          segmentCount: result?.segmentCount,
        },
        error: err,
      });
      throw err;
    }
  });

  it("streams init bytes first, then chunks in order — one download per yield", async () => {
    const label = "streams-init-then-chunks-in-order";
    console.info(`[${SUITE}:${label}] start`);
    const { deps, downloadAndDecryptObject } = buildDeps([
      {
        id: "fmt-src",
        fileId: "f-1",
        quality: "1080p",
        initKey: "init.k",
        chunks: [{ key: "chunk-1" }, { key: "chunk-2" }, { key: "chunk-3" }],
      },
    ]);

    console.info(`[${SUITE}:${label}] invoking retranscodeFormat`);
    await deps.retranscodeFormat!({
      userId: "user-1",
      jobId: "job-rt-1",
      fileId: "f-1",
      targetVariant: "720p",
      sourceFormatId: "fmt-src",
      sourceVariant: "1080p",
      mediaId: "m-1",
      signal: new AbortController().signal,
    });

    const dadMock = downloadAndDecryptObject as unknown as {
      mock: { calls: unknown[][] };
    };
    const downloadedKeys = dadMock.mock.calls.map((c) => c[1]);
    console.info(`[${SUITE}:${label}] downloadCallCount=${dadMock.mock.calls.length} downloadedKeys=${JSON.stringify(downloadedKeys)}`);
    try {
      expect(downloadAndDecryptObject).toHaveBeenCalledTimes(4);
      expect(downloadedKeys).toEqual(["init.k", "chunk-1", "chunk-2", "chunk-3"]);
    } catch (err) {
      dumpBadgerDepsRetranscodeSnapshot(label, {
        jobId: "job-rt-1",
        downloadCallCount: dadMock.mock.calls.length,
        downloadedKeys,
        expected: { count: 4, keys: ["init.k", "chunk-1", "chunk-2", "chunk-3"] },
        actual: { count: dadMock.mock.calls.length, keys: downloadedKeys },
        error: err,
      });
      throw err;
    }
  });

  it("the inputStream yields init bytes then chunk bytes (verified by manual iteration)", async () => {
    console.info(`[${SUITE}:manual-iter] start`);
    let capturedStream: AsyncIterable<Uint8Array> | undefined;
    const captureMock: ProduceMediaOutputsMock = vi.fn(
      async (input: {
        userId: string;
        jobId: string;
        inputStream?: AsyncIterable<Uint8Array>;
      }) => {
        capturedStream = input.inputStream;
        return {
          jobDir: join(stagingRoot, input.userId, input.jobId),
          stateStore: {
            getState: () => ({
              outputs: [{ id: "v", kind: "video", segments: [{}] }],
            }),
          },
          encoder: "cpu",
          produced: { videoFormats: [], audioTracks: [], subtitleTracks: [] },
        };
      }
    );

    const { deps, downloadAndDecryptObject } = buildDeps(
      [
        {
          id: "fmt-src",
          fileId: "f-1",
          quality: "1080p",
          initKey: "init.k",
          chunks: [{ key: "c1" }, { key: "c2" }],
        },
      ],
      {
        produceMediaOutputs: captureMock,
        downloadAndDecryptObject: vi.fn(async (_t: string, key: string) =>
          Buffer.from(`bytes:${key}`)
        ),
      }
    );

    console.info(`[${SUITE}:manual-iter] invoking retranscodeFormat (capture mock skips drain)`);
    await deps.retranscodeFormat!({
      userId: "user-1",
      jobId: "job-rt-iter",
      fileId: "f-1",
      targetVariant: "480p",
      sourceFormatId: "fmt-src",
      sourceVariant: "1080p",
      mediaId: "m-1",
      signal: new AbortController().signal,
    });

    const label = "manual-iter-yields-init-then-chunks";
    const dadMock = downloadAndDecryptObject as unknown as {
      mock: { calls: unknown[][] };
    };
    console.info(`[${SUITE}:${label}] capturedStream defined=${capturedStream !== undefined} downloadsBeforeDrain=${dadMock.mock.calls.length}`);
    try {
      expect(capturedStream).toBeDefined();
      // Capture mock skips the drain, so downloads haven't fired yet.
      expect(downloadAndDecryptObject).toHaveBeenCalledTimes(0);
    } catch (err) {
      dumpBadgerDepsRetranscodeSnapshot(label, {
        jobId: "job-rt-iter",
        inputStreamDefined: capturedStream !== undefined,
        downloadCallCount: dadMock.mock.calls.length,
        expected: { streamDefined: true, downloadsBeforeDrain: 0 },
        actual: {
          streamDefined: capturedStream !== undefined,
          downloadsBeforeDrain: dadMock.mock.calls.length,
        },
        error: err,
      });
      throw err;
    }

    console.info(`[${SUITE}:${label}] draining captured stream manually`);
    const collected: string[] = [];
    for await (const chunk of capturedStream!) {
      collected.push(Buffer.from(chunk).toString());
    }
    const keys = dadMock.mock.calls.map((c) => c[1]);
    console.info(`[${SUITE}:${label}] collected=${JSON.stringify(collected)} downloadCallCount=${dadMock.mock.calls.length} keys=${JSON.stringify(keys)}`);
    try {
      expect(collected).toEqual(["bytes:init.k", "bytes:c1", "bytes:c2"]);
      expect(downloadAndDecryptObject).toHaveBeenCalledTimes(3);
      expect(keys).toEqual(["init.k", "c1", "c2"]);
    } catch (err) {
      dumpBadgerDepsRetranscodeSnapshot(label, {
        jobId: "job-rt-iter",
        collectedChunks: collected,
        downloadCallCount: dadMock.mock.calls.length,
        downloadedKeys: keys,
        expected: {
          collected: ["bytes:init.k", "bytes:c1", "bytes:c2"],
          downloads: 3,
          keys: ["init.k", "c1", "c2"],
        },
        actual: { collected, downloads: dadMock.mock.calls.length, keys },
        error: err,
      });
      throw err;
    }
  });

  // @bugfix @regression-proof — ultimate-stress F2: a failed hardware encode
  // must be retryable on CPU, which needs a FRESH copy of the source stream
  // (the first one is consumed by the failed ffmpeg).
  it("provides reopenInputStream that replays the whole source from scratch (CPU retry)", async () => {
    const label = "reopen-input-stream-replays-source";
    console.info(`[${SUITE}:${label}] start`);
    let captured:
      | { first: AsyncIterable<Uint8Array>; reopen: () => AsyncIterable<Uint8Array> }
      | undefined;
    const captureMock: ProduceMediaOutputsMock = vi.fn(
      async (input: {
        userId: string;
        jobId: string;
        inputStream?: AsyncIterable<Uint8Array>;
        reopenInputStream?: () => AsyncIterable<Uint8Array>;
      }) => {
        if (input.inputStream && input.reopenInputStream) {
          captured = { first: input.inputStream, reopen: input.reopenInputStream };
        }
        return {
          jobDir: join(stagingRoot, input.userId, input.jobId),
          stateStore: {
            getState: () => ({
              outputs: [{ id: "v", kind: "video", segments: [{}] }],
            }),
          },
          encoder: "cpu",
          produced: { videoFormats: [], audioTracks: [], subtitleTracks: [] },
        };
      }
    );
    const { deps, downloadAndDecryptObject } = buildDeps(
      [
        {
          id: "fmt-src",
          fileId: "f-1",
          quality: "1080p",
          initKey: "init.k",
          chunks: [{ key: "c1" }, { key: "c2" }],
        },
      ],
      {
        produceMediaOutputs: captureMock,
        downloadAndDecryptObject: vi.fn(async (_t: string, key: string) =>
          Buffer.from(`bytes:${key}`)
        ),
      }
    );
    await deps.retranscodeFormat!({
      userId: "user-1",
      jobId: "job-rt-reopen",
      fileId: "f-1",
      targetVariant: "480p",
      sourceFormatId: "fmt-src",
      sourceVariant: "1080p",
      mediaId: "m-1",
      signal: new AbortController().signal,
    });
    expect(captured).toBeDefined();
    const drain = async (stream: AsyncIterable<Uint8Array>) => {
      const out: string[] = [];
      for await (const chunk of stream) out.push(Buffer.from(chunk).toString());
      return out;
    };
    const expected = ["bytes:init.k", "bytes:c1", "bytes:c2"];
    // Drain the original (the failed hardware attempt), then the replay.
    expect(await drain(captured!.first)).toEqual(expected);
    expect(await drain(captured!.reopen())).toEqual(expected);
    console.info(
      `[${SUITE}:${label}] downloads=${(downloadAndDecryptObject as unknown as { mock: { calls: unknown[][] } }).mock.calls.length}`
    );
    expect(downloadAndDecryptObject).toHaveBeenCalledTimes(6);
  });

  it("fails loud when no token is available (STEP_RETRANSCODE_AUTH_NOT_READY)", async () => {
    const label = "fails-when-no-token";
    console.info(`[${SUITE}:${label}] start`);
    const { deps } = buildDeps(
      [
        {
          id: "fmt-src",
          fileId: "f-1",
          quality: "1080p",
          initKey: "init.k",
          chunks: [{ key: "c1" }],
        },
      ],
      { resolveToken: () => null }
    );

    console.info(`[${SUITE}:${label}] invoking retranscodeFormat expecting STEP_RETRANSCODE_AUTH_NOT_READY`);
    try {
      await expect(
        deps.retranscodeFormat!({
          userId: "user-1",
          jobId: "job-no-token",
          mediaId: "m-1",
          fileId: "f-1",
          targetVariant: "720p",
          sourceFormatId: "fmt-src",
          sourceVariant: "1080p",
          signal: new AbortController().signal,
        })
      ).rejects.toThrow("STEP_RETRANSCODE_AUTH_NOT_READY");
    } catch (err) {
      dumpBadgerDepsRetranscodeSnapshot(label, {
        jobId: "job-no-token",
        expected: { throws: "STEP_RETRANSCODE_AUTH_NOT_READY" },
        actual: { error: err instanceof Error ? err.message : String(err) },
        error: err,
      });
      throw err;
    }
  });

  it("fails loud when no library key is available (STEP_RETRANSCODE_LIBRARY_KEY_MISSING)", async () => {
    const label = "fails-when-no-library-key";
    console.info(`[${SUITE}:${label}] start`);
    const { deps } = buildDeps(
      [
        {
          id: "fmt-src",
          fileId: "f-1",
          quality: "1080p",
          initKey: "init.k",
          chunks: [{ key: "c1" }],
        },
      ],
      { resolveLibraryKey: () => null }
    );

    console.info(`[${SUITE}:${label}] invoking retranscodeFormat expecting STEP_RETRANSCODE_LIBRARY_KEY_MISSING`);
    try {
      await expect(
        deps.retranscodeFormat!({
          userId: "user-1",
          jobId: "job-no-key",
          mediaId: "m-1",
          fileId: "f-1",
          targetVariant: "720p",
          sourceFormatId: "fmt-src",
          sourceVariant: "1080p",
          signal: new AbortController().signal,
        })
      ).rejects.toThrow("STEP_RETRANSCODE_LIBRARY_KEY_MISSING");
    } catch (err) {
      dumpBadgerDepsRetranscodeSnapshot(label, {
        jobId: "job-no-key",
        expected: { throws: "STEP_RETRANSCODE_LIBRARY_KEY_MISSING" },
        actual: { error: err instanceof Error ? err.message : String(err) },
        error: err,
      });
      throw err;
    }
  });

  it("fails loud when the source format is missing initKey or chunks", async () => {
    const label = "fails-when-source-format-empty";
    console.info(`[${SUITE}:${label}] start`);
    const { deps } = buildDeps([
      {
        id: "fmt-src",
        fileId: "f-1",
        quality: "1080p",
        initKey: null,
        chunks: [{ key: "c1" }],
      },
    ]);

    console.info(`[${SUITE}:${label}] invoking retranscodeFormat expecting STEP_RETRANSCODE_SOURCE_FORMAT_EMPTY`);
    try {
      await expect(
        deps.retranscodeFormat!({
          userId: "user-1",
          jobId: "job-no-init",
          mediaId: "m-1",
          fileId: "f-1",
          targetVariant: "720p",
          sourceFormatId: "fmt-src",
          sourceVariant: "1080p",
          signal: new AbortController().signal,
        })
      ).rejects.toThrow("STEP_RETRANSCODE_SOURCE_FORMAT_EMPTY");
    } catch (err) {
      dumpBadgerDepsRetranscodeSnapshot(label, {
        jobId: "job-no-init",
        expected: { throws: "STEP_RETRANSCODE_SOURCE_FORMAT_EMPTY" },
        actual: { error: err instanceof Error ? err.message : String(err) },
        error: err,
      });
      throw err;
    }
  });

  it("fails loud when the targetVariant is not a known preset (STEP_RETRANSCODE_VARIANT_UNSUPPORTED)", async () => {
    const label = "fails-when-targetVariant-unsupported";
    console.info(`[${SUITE}:${label}] start`);
    const { deps } = buildDeps([
      {
        id: "fmt-src",
        fileId: "f-1",
        quality: "1080p",
        initKey: "init.k",
        chunks: [{ key: "c1" }],
      },
    ]);

    console.info(`[${SUITE}:${label}] invoking retranscodeFormat with bad variant=9999p expecting STEP_RETRANSCODE_VARIANT_UNSUPPORTED`);
    try {
      await expect(
        deps.retranscodeFormat!({
          userId: "user-1",
          jobId: "job-bad-variant",
          mediaId: "m-1",
          fileId: "f-1",
          targetVariant: "9999p",
          sourceFormatId: "fmt-src",
          sourceVariant: "1080p",
          signal: new AbortController().signal,
        })
      ).rejects.toThrow("STEP_RETRANSCODE_VARIANT_UNSUPPORTED");
    } catch (err) {
      dumpBadgerDepsRetranscodeSnapshot(label, {
        jobId: "job-bad-variant",
        targetVariant: "9999p",
        expected: { throws: "STEP_RETRANSCODE_VARIANT_UNSUPPORTED" },
        actual: { error: err instanceof Error ? err.message : String(err) },
        error: err,
      });
      throw err;
    }
  });

  it("honours signal.aborted between chunk yields (no extra downloads after abort)", async () => {
    const label = "honours-abort-between-chunks";
    console.info(`[${SUITE}:${label}] start`);
    const controller = new AbortController();
    let downloadCount = 0;
    const { deps } = buildDeps(
      [
        {
          id: "fmt-src",
          fileId: "f-1",
          quality: "1080p",
          initKey: "init.k",
          chunks: [{ key: "c1" }, { key: "c2" }, { key: "c3" }],
        },
      ],
      {
        downloadAndDecryptObject: vi.fn(async (_token, key) => {
          downloadCount += 1;
          console.info(`[${SUITE}:${label}] download ${downloadCount}: key=${key}`);
          if (downloadCount === 2) {
            console.info(`[${SUITE}:${label}] aborting on 2nd download`);
            controller.abort();
          }
          return Buffer.from(`bytes:${key}`);
        }),
      }
    );

    console.info(`[${SUITE}:${label}] invoking retranscodeFormat expecting CANCELLED`);
    try {
      await expect(
        deps.retranscodeFormat!({
          userId: "user-1",
          jobId: "job-cancel",
          mediaId: "m-1",
          fileId: "f-1",
          targetVariant: "720p",
          sourceFormatId: "fmt-src",
          sourceVariant: "1080p",
          signal: controller.signal,
        })
      ).rejects.toThrow("CANCELLED");
    } catch (err) {
      dumpBadgerDepsRetranscodeSnapshot(label, {
        jobId: "job-cancel",
        downloadCallCount: downloadCount,
        expected: { throws: "CANCELLED" },
        actual: { error: err instanceof Error ? err.message : String(err) },
        error: err,
      });
      throw err;
    }

    console.info(`[${SUITE}:${label}] downloadCount=${downloadCount} (expected 2..3)`);
    try {
      expect(downloadCount).toBeLessThan(4);
      expect(downloadCount).toBeGreaterThanOrEqual(2);
    } catch (err) {
      dumpBadgerDepsRetranscodeSnapshot(label, {
        jobId: "job-cancel",
        downloadCallCount: downloadCount,
        abortReason: "controller.abort() at downloadCount===2",
        expected: { downloadCount: ">=2 && <4" },
        actual: { downloadCount },
        error: err,
      });
      throw err;
    }
  });

  describe("source download survives a storage-gateway restart", () => {
    const ROW: FormatRow = {
      id: "fmt-src",
      fileId: "f-1",
      quality: "1080p",
      initKey: "init.k",
      chunks: [{ key: "c1" }, { key: "c2" }, { key: "c3" }],
    };
    const EXPECTED_PIECES = ["init.k", "c1", "c2", "c3"];
    // Bun's fetch error when the gateway port is closed (the M1 N5 failure).
    const connectionRefused = () =>
      Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), {
        code: "ConnectionRefused",
      });

    /** Drains the stream (and optionally the CPU-retry replay), recording each piece. */
    const collectingProduceMock = (collected: string[], replay = false) =>
      vi.fn(
        async (input: {
          jobId: string;
          userId: string;
          inputStream?: AsyncIterable<Uint8Array>;
          reopenInputStream?: () => AsyncIterable<Uint8Array>;
        }) => {
          const streams = [input.inputStream!];
          if (replay) streams.push(input.reopenInputStream!());
          for (const stream of streams) {
            for await (const piece of stream) {
              collected.push(Buffer.from(piece).toString().replace(/^bytes:/, ""));
            }
          }
          return {
            jobDir: join(stagingRoot, input.userId, input.jobId),
            stateStore: { getState: () => ({ outputs: [{ id: "v", kind: "video", segments: [{}] }] }) },
            encoder: "cpu",
            produced: { videoFormats: [], audioTracks: [], subtitleTracks: [] },
          };
        }
      );

    const run = (deps: BadgerStepDeps, jobId: string, signal: AbortSignal, onLog?: (line: string) => void) =>
      deps.retranscodeFormat!({
        userId: "user-1",
        jobId,
        mediaId: "m-1",
        fileId: "f-1",
        targetVariant: "720p",
        sourceFormatId: "fmt-src",
        sourceVariant: "1080p",
        signal,
        onLog,
      });
    // Zero-length backoffs: the schedule's length bounds the retries, no real waiting.
    const NO_WAIT = [0, 0, 0];

    /** Download mock that throws `failures[key]` errors (in order) before succeeding. */
    const flakyDownload = (failures: Record<string, Array<() => Error>>, calls: string[]) =>
      vi.fn(async (_token: string, key: string) => {
        calls.push(key);
        const next = failures[key]?.shift();
        if (next) throw next();
        return Buffer.from(`bytes:${key}`);
      });

    it("@bugfix @regression-proof retries a ConnectionRefused download once and streams every piece in order", async () => {
      const label = "retry-connection-refused";
      const calls: string[] = [];
      const collected: string[] = [];
      const { deps } = buildDeps([ROW], {
        downloadAndDecryptObject: flakyDownload({ c2: [connectionRefused] }, calls),
        produceMediaOutputs: collectingProduceMock(collected),
        sourceDownloadRetryDelaysMs: NO_WAIT,
      });
      try {
        const result = await run(deps, "job-retry-refused", new AbortController().signal);
        expect(result.variant).toBe("720p");
        expect(collected).toEqual(EXPECTED_PIECES);
        expect(calls).toEqual(["init.k", "c1", "c2", "c2", "c3"]);
      } catch (err) {
        dumpBadgerDepsRetranscodeSnapshot(label, { downloadedKeys: calls, collectedChunks: collected, error: err });
        throw err;
      }
    });

    it("@bugfix @regression-proof retries a 404 invalid_session (restarted gateway forgot the session)", async () => {
      const label = "retry-invalid-session";
      const calls: string[] = [];
      const collected: string[] = [];
      const { deps } = buildDeps([ROW], {
        downloadAndDecryptObject: flakyDownload(
          {
            "init.k": [() => new StorageTunnelError(503, { error: "gateway_starting" })],
            c1: [() => new StorageTunnelError(404, { error: "invalid_session" })],
          },
          calls
        ),
        produceMediaOutputs: collectingProduceMock(collected),
        sourceDownloadRetryDelaysMs: NO_WAIT,
      });
      try {
        await run(deps, "job-retry-session", new AbortController().signal);
        expect(collected).toEqual(EXPECTED_PIECES);
        expect(calls).toEqual(["init.k", "init.k", "c1", "c1", "c2", "c3"]);
      } catch (err) {
        dumpBadgerDepsRetranscodeSnapshot(label, { downloadedKeys: calls, collectedChunks: collected, error: err });
        throw err;
      }
    });

    it("@bugfix @regression-proof does not retry a non-transient decrypt failure", async () => {
      const label = "no-retry-gcm";
      const calls: string[] = [];
      const { deps } = buildDeps([ROW], {
        downloadAndDecryptObject: flakyDownload(
          {
            c1: [() => new Error("Unsupported state or unable to authenticate data")],
          },
          calls
        ),
        produceMediaOutputs: collectingProduceMock([]),
        sourceDownloadRetryDelaysMs: NO_WAIT,
      });
      try {
        await expect(run(deps, "job-no-retry", new AbortController().signal)).rejects.toThrow(
          "Unsupported state or unable to authenticate data"
        );
        expect(calls).toEqual(["init.k", "c1"]);
      } catch (err) {
        dumpBadgerDepsRetranscodeSnapshot(label, { downloadedKeys: calls, error: err });
        throw err;
      }
    });

    it("@bugfix @regression-proof does not retry a 4xx other than invalid_session", async () => {
      const label = "no-retry-403";
      const calls: string[] = [];
      const { deps } = buildDeps([ROW], {
        downloadAndDecryptObject: flakyDownload(
          { "init.k": [() => new StorageTunnelError(403, { error: "forbidden" })] },
          calls
        ),
        produceMediaOutputs: collectingProduceMock([]),
        sourceDownloadRetryDelaysMs: NO_WAIT,
      });
      try {
        await expect(run(deps, "job-no-retry-403", new AbortController().signal)).rejects.toThrow("forbidden");
        expect(calls).toEqual(["init.k"]);
      } catch (err) {
        dumpBadgerDepsRetranscodeSnapshot(label, { downloadedKeys: calls, error: err });
        throw err;
      }
    });

    it("@bugfix @regression-proof a persistent outage fails after the bounded budget with the original error", async () => {
      const label = "persistent-outage";
      const calls: string[] = [];
      const { deps } = buildDeps([ROW], {
        downloadAndDecryptObject: flakyDownload(
          { c2: Array.from({ length: 10 }, () => connectionRefused) },
          calls
        ),
        produceMediaOutputs: collectingProduceMock([]),
        sourceDownloadRetryDelaysMs: NO_WAIT,
      });
      try {
        await expect(run(deps, "job-outage", new AbortController().signal)).rejects.toThrow(
          /^Unable to connect\. Is the computer able to access the url\?$/
        );
        // 1 attempt + 3 retries, then give up.
        expect(calls).toEqual(["init.k", "c1", "c2", "c2", "c2", "c2"]);
      } catch (err) {
        dumpBadgerDepsRetranscodeSnapshot(label, { downloadedKeys: calls, error: err });
        throw err;
      }
    });

    it("@bugfix @regression-proof abort during the retry backoff stops at once with CANCELLED", async () => {
      const label = "abort-during-backoff";
      const controller = new AbortController();
      const calls: string[] = [];
      const { deps } = buildDeps([ROW], {
        downloadAndDecryptObject: vi.fn(async (_token: string, key: string) => {
          calls.push(key);
          if (key === "c1") throw connectionRefused();
          return Buffer.from(`bytes:${key}`);
        }),
        produceMediaOutputs: collectingProduceMock([]),
        // A backoff far longer than the test timeout: only abort can end it.
        sourceDownloadRetryDelaysMs: [600_000],
      });
      // The retry log line is emitted right before the backoff wait starts.
      let onRetryLogged!: () => void;
      const retryLogged = new Promise<void>((resolve) => (onRetryLogged = resolve));
      const pending = run(deps, "job-abort-backoff", controller.signal, (line) => {
        if (line.includes("retrying source download")) onRetryLogged();
      });
      try {
        await retryLogged;
        controller.abort();
        await expect(pending).rejects.toThrow("CANCELLED");
        expect(calls).toEqual(["init.k", "c1"]);
      } catch (err) {
        dumpBadgerDepsRetranscodeSnapshot(label, { downloadedKeys: calls, error: err });
        throw err;
      }
    });

    it("@bugfix @regression-proof the CPU-retry replay stream retries transient failures too", async () => {
      const label = "replay-retries";
      const calls: string[] = [];
      const collected: string[] = [];
      // c3 succeeds on the first pass, then fails once on the replay.
      let c3Calls = 0;
      const { deps } = buildDeps([ROW], {
        downloadAndDecryptObject: vi.fn(async (_token: string, key: string) => {
          calls.push(key);
          if (key === "c3" && ++c3Calls === 2) throw connectionRefused();
          return Buffer.from(`bytes:${key}`);
        }),
        produceMediaOutputs: collectingProduceMock(collected, true),
        sourceDownloadRetryDelaysMs: NO_WAIT,
      });
      try {
        await run(deps, "job-replay", new AbortController().signal);
        expect(collected).toEqual([...EXPECTED_PIECES, ...EXPECTED_PIECES]);
        expect(calls).toEqual(["init.k", "c1", "c2", "c3", "init.k", "c1", "c2", "c3", "c3"]);
      } catch (err) {
        dumpBadgerDepsRetranscodeSnapshot(label, { downloadedKeys: calls, collectedChunks: collected, error: err });
        throw err;
      }
    });
  });
});
