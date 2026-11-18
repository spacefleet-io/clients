/**
 * @bugfix @regression-proof
 *
 * effervescent-teapot Round-13 #2: post-commit storage-gateway cache warmup.
 *
 * Background — Round-12 forensics:
 * - User-facing failure: right after a fresh ingest commit completes, the
 *   user clicks Play and the storage-gateway takes ~2 s to serve a single
 *   4 MB chunk on localhost (source job
 *   `8fcea2da-6149-4c55-852a-6dcfbab8b5cc`). Decryption overhead + cold
 *   storage inode cache.
 * - That 2 s latency forced the launch-stalled fallback timer (5 s pre-fix)
 *   to fire and auto-degrade playback to 360p.
 * - Round-12 commit `119aa13f` extended the launch-stalled timer to 20 s as
 *   a temporary mitigation while the underlying cause was investigated.
 *
 * Round-13 #2 fix (this test guards):
 * - After a successful commit-step library write, the deps-adapter
 *   fire-and-forgets a `warmStorageCache(...)` call against the
 *   storage-gateway's `/storage/head` endpoint. That HEAD batch wakes the
 *   gateway's auth cache AND triggers an on-disk stat on every
 *   key, paging the inode + directory blocks into the OS cache. The first
 *   GET that follows reads data blocks at warm-cache speed.
 *
 * What this test asserts (the @regression-proof contract):
 * 1. Source-scope commit invokes the warmup hook EXACTLY once with the
 *    produced shape, the resolved token, userId, jobId. (a)
 * 2. Format-scope commit invokes the warmup hook exactly once. (a)
 * 3. Commit returns success even when the warmup hook throws
 *    SYNCHRONOUSLY. (b — fire-and-forget guarantee, sync path)
 * 4. Commit returns success even when the warmup hook rejects
 *    ASYNCHRONOUSLY. (b — fire-and-forget guarantee, async path)
 * 5. The warmup hook receives the correct produced object (so the real
 *    HTTP-driven impl can pull initKey + first N chunk keys server-side).
 *
 * Pre-fix (without the warmup wiring): there is NO call to any storage-
 * gateway cache primer post-commit. The first chunk fetch on Play pays the
 * cold-cache 2 s tax. The launch-stalled timer fires and degrades to 360p.
 *
 * What this test does NOT cover:
 * - The HTTP shape of the real warmup call (covered indirectly — the
 *   warmup module passes apiBase + token + the keys to fetch). The
 *   end-to-end perf claim ("first chunk fetch < N ms post-warmup") is a
 *   Layer-4 perf test concern, not a unit test.
 * - The launch-stalled timer in the desktop player (off-limits per
 *   Round-13 #2 task scope — desktop is purely the consumer).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetBadgerStepDepsAdapter,
  buildBadgerStepDeps,
  type ProcessMediaJobFn,
} from "../src/modules/badger/steps/deps-adapter";
import {
  collectWarmupKeys,
  WARMUP_TUNABLES,
  type WarmStorageCacheArgs,
  type WarmStorageCacheResult,
} from "../src/modules/badger/steps/cacheWarmup";
import type { ProducedMedia } from "@space/ingest-core/mediaProcessor";

const SUITE = "badger-deps-cache-warmup";

const jsonReplacer = (_key: string, value: unknown) => {
  if (value instanceof Uint8Array) {
    return `<Uint8Array bytes=${value.byteLength}>`;
  }
  if (value instanceof Buffer) {
    return `<Buffer bytes=${value.byteLength}>`;
  }
  return value;
};

const dumpBadgerCacheWarmupSnapshot = (
  label: string,
  ctx: {
    userId?: string;
    jobId?: string;
    mediaId?: string;
    scope?: string;
    variant?: string;
    sourceFileId?: string;
    produced?: unknown;
    collectedKeys?: unknown;
    collectedKeysCount?: number;
    warmupTunables?: unknown;
    warmupCallCount?: number;
    warmupArgs?: unknown;
    warmupResult?: unknown;
    commitResult?: unknown;
    fileId?: string | null;
    formatIds?: unknown;
    fetchCallCount?: number;
    fetchCallUrls?: unknown;
    fetchRequestUrl?: string;
    fetchRequestMethod?: string;
    fetchRequestHeaders?: unknown;
    fetchRequestBody?: unknown;
    fetchResponseStatus?: number;
    httpResult?: unknown;
    libraryDbCalls?: unknown;
    libraryDbCallCount?: number;
    token?: string | null;
    expected?: unknown;
    actual?: unknown;
    extra?: Record<string, unknown>;
    error?: unknown;
  } = {}
) => {
  try {
    console.error(`=== [${SUITE}:${label}] badger-deps-cache-warmup snapshot ===`);
    if (ctx.userId !== undefined) console.error(`userId: ${ctx.userId}`);
    if (ctx.jobId !== undefined) console.error(`jobId: ${ctx.jobId}`);
    if (ctx.mediaId !== undefined) console.error(`mediaId: ${ctx.mediaId}`);
    if (ctx.scope !== undefined) console.error(`scope: ${ctx.scope}`);
    if (ctx.variant !== undefined) console.error(`variant: ${ctx.variant}`);
    if (ctx.sourceFileId !== undefined) console.error(`sourceFileId: ${ctx.sourceFileId}`);
    if (ctx.produced !== undefined) {
      console.error(`produced:\n${JSON.stringify(ctx.produced, jsonReplacer, 2)}`);
    }
    if (ctx.collectedKeys !== undefined) {
      console.error(`collectedKeys:\n${JSON.stringify(ctx.collectedKeys, jsonReplacer, 2)}`);
    }
    if (ctx.collectedKeysCount !== undefined) {
      console.error(`collectedKeysCount: ${ctx.collectedKeysCount}`);
    }
    if (ctx.warmupTunables !== undefined) {
      console.error(`warmupTunables:\n${JSON.stringify(ctx.warmupTunables, jsonReplacer, 2)}`);
    }
    if (ctx.warmupCallCount !== undefined) {
      console.error(`warmupCallCount: ${ctx.warmupCallCount}`);
    }
    if (ctx.warmupArgs !== undefined) {
      console.error(`warmupArgs:\n${JSON.stringify(ctx.warmupArgs, jsonReplacer, 2)}`);
    }
    if (ctx.warmupResult !== undefined) {
      console.error(`warmupResult:\n${JSON.stringify(ctx.warmupResult, jsonReplacer, 2)}`);
    }
    if (ctx.commitResult !== undefined) {
      console.error(`commitResult:\n${JSON.stringify(ctx.commitResult, jsonReplacer, 2)}`);
    }
    if (ctx.fileId !== undefined) {
      console.error(`fileId: ${ctx.fileId ?? "(null)"}`);
    }
    if (ctx.formatIds !== undefined) {
      console.error(`formatIds:\n${JSON.stringify(ctx.formatIds, jsonReplacer, 2)}`);
    }
    if (ctx.fetchCallCount !== undefined) {
      console.error(`fetchCallCount: ${ctx.fetchCallCount}`);
    }
    if (ctx.fetchCallUrls !== undefined) {
      console.error(`fetchCallUrls:\n${JSON.stringify(ctx.fetchCallUrls, jsonReplacer, 2)}`);
    }
    if (ctx.fetchRequestUrl !== undefined) console.error(`fetchRequestUrl: ${ctx.fetchRequestUrl}`);
    if (ctx.fetchRequestMethod !== undefined) console.error(`fetchRequestMethod: ${ctx.fetchRequestMethod}`);
    if (ctx.fetchRequestHeaders !== undefined) {
      console.error(`fetchRequestHeaders:\n${JSON.stringify(ctx.fetchRequestHeaders, jsonReplacer, 2)}`);
    }
    if (ctx.fetchRequestBody !== undefined) {
      console.error(`fetchRequestBody:\n${JSON.stringify(ctx.fetchRequestBody, jsonReplacer, 2)}`);
    }
    if (ctx.fetchResponseStatus !== undefined) {
      console.error(`fetchResponseStatus: ${ctx.fetchResponseStatus}`);
    }
    if (ctx.httpResult !== undefined) {
      console.error(`httpResult:\n${JSON.stringify(ctx.httpResult, jsonReplacer, 2)}`);
    }
    if (ctx.libraryDbCalls !== undefined) {
      console.error(`libraryDbCalls:\n${JSON.stringify(ctx.libraryDbCalls, jsonReplacer, 2)}`);
    }
    if (ctx.libraryDbCallCount !== undefined) {
      console.error(`libraryDbCallCount: ${ctx.libraryDbCallCount}`);
    }
    if (ctx.token !== undefined) {
      console.error(`token: ${ctx.token === null ? "(null)" : ctx.token === "" ? "(empty-string)" : ctx.token}`);
    }
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

const buildProducedFixture = (): ProducedMedia => ({
  videoFormats: [
    {
      quality: "1080p",
      codec: "h264",
      codecString: "avc1.640028",
      initKey: "shards/dev/init-1080p",
      initSize: 2048,
      durationSeconds: 60,
      totalSize: 41_943_040,
      chunks: [
        { key: "shards/dev/seg-1080p-1", sizeBytes: 4_194_304, startSeconds: 0 },
        { key: "shards/dev/seg-1080p-2", sizeBytes: 4_194_304, startSeconds: 12 },
        { key: "shards/dev/seg-1080p-3", sizeBytes: 4_194_304, startSeconds: 24 },
        { key: "shards/dev/seg-1080p-4", sizeBytes: 4_194_304, startSeconds: 36 },
        { key: "shards/dev/seg-1080p-5", sizeBytes: 4_194_304, startSeconds: 48 },
        { key: "shards/dev/seg-1080p-6", sizeBytes: 4_194_304, startSeconds: 60 },
        { key: "shards/dev/seg-1080p-7", sizeBytes: 4_194_304, startSeconds: 72 },
      ],
    },
  ],
  audioTracks: [
    {
      language: "en",
      label: "English",
      codec: "aac",
      codecString: "mp4a.40.2",
      initKey: "shards/dev/audio-init-en",
      initSize: 512,
      durationSeconds: 60,
      totalSize: 600_000,
      chunks: [
        { key: "shards/dev/audio-en-1", sizeBytes: 100_000, startSeconds: 0 },
        { key: "shards/dev/audio-en-2", sizeBytes: 100_000, startSeconds: 12 },
        { key: "shards/dev/audio-en-3", sizeBytes: 100_000, startSeconds: 24 },
        { key: "shards/dev/audio-en-4", sizeBytes: 100_000, startSeconds: 36 },
        { key: "shards/dev/audio-en-5", sizeBytes: 100_000, startSeconds: 48 },
        { key: "shards/dev/audio-en-6", sizeBytes: 100_000, startSeconds: 60 },
      ],
      isDefault: true,
    },
  ],
  subtitleTracks: [],
});

const buildProcessMediaJobMock = (): ProcessMediaJobFn =>
  vi.fn(async () => {
    throw new Error("processMediaJob should NOT be called from commit-only test");
  }) as unknown as ProcessMediaJobFn;

const buildLibraryDb = () => {
  const calls: Array<{ method: string; args: unknown }> = [];
  return {
    calls,
    libraryDb: {
      call: vi.fn(async (method: string, args: unknown[]) => {
        calls.push({ method, args });
        // Round-12 #1: getMediaDetails is the FK pre-check on source-scope
        // commits. Return truthy so we proceed to the writes the warmup hooks
        // off.
        if (method === "getMediaDetails")
          return { id: "media-1", title: "Movie", type: "movie" };
        if (method === "linkFileToMedia") return "file-1";
        if (method === "addMediaFormat") return "fmt-1";
        return null;
      }),
    } as unknown as Parameters<typeof buildBadgerStepDeps>[0]["libraryDb"],
  };
};

beforeEach(() => {
  __resetBadgerStepDepsAdapter();
});

afterEach(() => {
  __resetBadgerStepDepsAdapter();
});

describe("@bugfix @regression-proof Round-13 #2 — collectWarmupKeys shape", () => {
  it("includes initKey + first N chunks per video format AND audio track", () => {
    const label = "shape-init-plus-first-N";
    console.info(`[${SUITE}:${label}] produced has 7 video+6 audio chunks; expects init+first-5 each = 12 keys`);
    const produced = buildProducedFixture();
    const keys = collectWarmupKeys(produced);
    console.info(`[${SUITE}:${label}] collected ${keys.length} keys: ${JSON.stringify(keys)}`);
    try {
      // Video: init + first 5 chunks (out of 7) = 6 keys
      // Audio: init + first 5 chunks (out of 6) = 6 keys
      // Total: 12 unique keys
      expect(keys).toContain("shards/dev/init-1080p");
      expect(keys).toContain("shards/dev/seg-1080p-1");
      expect(keys).toContain("shards/dev/seg-1080p-5");
      expect(keys).not.toContain("shards/dev/seg-1080p-6");
      expect(keys).not.toContain("shards/dev/seg-1080p-7");
      expect(keys).toContain("shards/dev/audio-init-en");
      expect(keys).toContain("shards/dev/audio-en-1");
      expect(keys).toContain("shards/dev/audio-en-5");
      expect(keys).not.toContain("shards/dev/audio-en-6");
      // 5 leading-chunks tunable validation — guards against future drift.
      expect(WARMUP_TUNABLES.leadingChunks).toBe(5);
    } catch (err) {
      dumpBadgerCacheWarmupSnapshot(label, {
        produced,
        collectedKeys: keys,
        collectedKeysCount: keys.length,
        warmupTunables: WARMUP_TUNABLES,
        expected: {
          includes: ["init-1080p", "seg-1080p-1", "seg-1080p-5", "audio-init-en", "audio-en-1", "audio-en-5"],
          excludes: ["seg-1080p-6", "seg-1080p-7", "audio-en-6"],
          leadingChunks: 5,
        },
        actual: { keys, leadingChunks: WARMUP_TUNABLES.leadingChunks },
        error: err,
      });
      throw err;
    }
  });

  it("dedupes repeated keys", () => {
    const label = "shape-dedupe";
    console.info(`[${SUITE}:${label}] initKey == chunk[0].key; expects 1 occurrence of shared-key in output`);
    const produced: ProducedMedia = {
      videoFormats: [
        {
          quality: "1080p",
          codec: "h264",
          codecString: null,
          initKey: "shared-key",
          initSize: 1,
          durationSeconds: 1,
          totalSize: 1,
          chunks: [
            { key: "shared-key", sizeBytes: 1 },
            { key: "unique-1", sizeBytes: 1 },
          ],
        },
      ],
      audioTracks: [],
      subtitleTracks: [],
    };
    const keys = collectWarmupKeys(produced);
    console.info(`[${SUITE}:${label}] collected: ${JSON.stringify(keys)}`);
    try {
      expect(keys.filter((k) => k === "shared-key")).toHaveLength(1);
      expect(keys).toContain("unique-1");
    } catch (err) {
      dumpBadgerCacheWarmupSnapshot(label, {
        produced,
        collectedKeys: keys,
        collectedKeysCount: keys.length,
        expected: { sharedKeyOccurrences: 1, includes: ["unique-1"] },
        actual: { sharedKeyOccurrences: keys.filter((k) => k === "shared-key").length, keys },
        error: err,
      });
      throw err;
    }
  });

  it("returns empty for empty produced", () => {
    const label = "shape-empty-produced";
    console.info(`[${SUITE}:${label}] empty produced; expects []`);
    const produced: ProducedMedia = { videoFormats: [], audioTracks: [], subtitleTracks: [] };
    const keys = collectWarmupKeys(produced);
    try {
      expect(keys).toEqual([]);
    } catch (err) {
      dumpBadgerCacheWarmupSnapshot(label, {
        produced,
        collectedKeys: keys,
        collectedKeysCount: keys.length,
        expected: [],
        actual: keys,
        error: err,
      });
      throw err;
    }
  });

  it("skips empty initKey strings (partial-encode disk-fallback shape)", () => {
    const label = "shape-skip-empty-init-key";
    console.info(`[${SUITE}:${label}] empty initKey + 1 chunk; expects ["real-chunk-1"] only`);
    const produced: ProducedMedia = {
      videoFormats: [
        {
          quality: "1080p",
          codec: "h264",
          codecString: null,
          initKey: "",
          initSize: 0,
          durationSeconds: null,
          totalSize: 1,
          chunks: [{ key: "real-chunk-1", sizeBytes: 1 }],
        },
      ],
      audioTracks: [],
      subtitleTracks: [],
    };
    const keys = collectWarmupKeys(produced);
    console.info(`[${SUITE}:${label}] collected: ${JSON.stringify(keys)}`);
    try {
      expect(keys).toEqual(["real-chunk-1"]);
    } catch (err) {
      dumpBadgerCacheWarmupSnapshot(label, {
        produced,
        collectedKeys: keys,
        collectedKeysCount: keys.length,
        expected: ["real-chunk-1"],
        actual: keys,
        error: err,
      });
      throw err;
    }
  });
});

describe("@bugfix @regression-proof Round-13 #2 — commit invokes warmup exactly once", () => {
  it("source-scope commit invokes warmup ONCE with produced + token + userId + jobId", async () => {
    const label = "source-commit-invokes-warmup-once";
    console.info(`[${SUITE}:${label}] source-scope commit; expects warmup called exactly once with correct args`);
    const { libraryDb, calls: libraryDbCalls } = buildLibraryDb();
    const warmupSpy = vi.fn(
      async (_args: WarmStorageCacheArgs): Promise<WarmStorageCacheResult> => ({
        dispatched: 0,
        ok: true,
      })
    );

    const deps = buildBadgerStepDeps({
      libraryDb,
      processMediaJob: buildProcessMediaJobMock(),
      resolveToken: () => "test-token",
      resolveLibraryKey: () => "lk",
      warmStorageCacheImpl: warmupSpy,
    });

    const ctrl = new AbortController();
    const produced = buildProducedFixture();
    console.info(`[${SUITE}:${label}] dispatching commit userId=u-warmup jobId=j-warmup scope=source`);
    const result = await deps.commit({
      userId: "u-warmup",
      jobId: "j-warmup",
      mediaId: "media-1",
      filename: "movie.mkv",
      scope: "source",
      produced,
      signal: ctrl.signal,
    });
    console.info(`[${SUITE}:${label}] commit result fileId=${result.fileId} formatIds=${JSON.stringify(result.formatIds)} warmupCallCount=${warmupSpy.mock.calls.length}`);

    try {
      expect(result.fileId).toBe("file-1");
      expect(result.formatIds).toEqual(["fmt-1"]);

      // (a) — exactly one warmup invocation per commit. Critical: NOT once
      // per video format, NOT once per produced asset.
      expect(warmupSpy).toHaveBeenCalledTimes(1);
      const args = warmupSpy.mock.calls[0]?.[0];
      expect(args?.userId).toBe("u-warmup");
      expect(args?.jobId).toBe("j-warmup");
      expect(args?.token).toBe("test-token");
      expect(args?.produced.videoFormats).toHaveLength(1);
      expect(args?.produced.videoFormats[0]?.initKey).toBe(
        "shards/dev/init-1080p"
      );
    } catch (err) {
      dumpBadgerCacheWarmupSnapshot(label, {
        userId: "u-warmup",
        jobId: "j-warmup",
        mediaId: "media-1",
        scope: "source",
        produced,
        commitResult: result,
        fileId: result.fileId,
        formatIds: result.formatIds,
        warmupCallCount: warmupSpy.mock.calls.length,
        warmupArgs: warmupSpy.mock.calls.map((c) => c[0]),
        libraryDbCalls,
        libraryDbCallCount: libraryDbCalls.length,
        expected: {
          fileId: "file-1",
          formatIds: ["fmt-1"],
          warmupCallCount: 1,
          firstArg: { userId: "u-warmup", jobId: "j-warmup", token: "test-token", videoFormatCount: 1, firstInitKey: "shards/dev/init-1080p" },
        },
        actual: { result, warmupCallCount: warmupSpy.mock.calls.length, firstArg: warmupSpy.mock.calls[0]?.[0] },
        error: err,
      });
      throw err;
    }
  });

  it("format-scope commit invokes warmup ONCE with produced", async () => {
    const label = "format-commit-invokes-warmup-once";
    console.info(`[${SUITE}:${label}] format-scope commit variant=360p; expects warmup called exactly once`);
    const { libraryDb, calls: libraryDbCalls } = buildLibraryDb();
    const warmupSpy = vi.fn(
      async (_args: WarmStorageCacheArgs): Promise<WarmStorageCacheResult> => ({
        dispatched: 0,
        ok: true,
      })
    );

    const deps = buildBadgerStepDeps({
      libraryDb,
      processMediaJob: buildProcessMediaJobMock(),
      resolveToken: () => "test-token",
      resolveLibraryKey: () => "lk",
      warmStorageCacheImpl: warmupSpy,
    });

    const ctrl = new AbortController();
    const produced = buildProducedFixture();
    const result = await deps.commit({
      userId: "u-warmup-fmt",
      jobId: "j-warmup-fmt",
      mediaId: "media-1",
      filename: "movie.mkv",
      scope: "format",
      variant: "360p",
      produced,
      sourceFileId: "parent-source-file-1",
      signal: ctrl.signal,
    });
    console.info(`[${SUITE}:${label}] commit result fileId=${result.fileId} warmupCallCount=${warmupSpy.mock.calls.length}`);

    try {
      expect(result.fileId).toBe("parent-source-file-1");
      expect(warmupSpy).toHaveBeenCalledTimes(1);
      const args = warmupSpy.mock.calls[0]?.[0];
      expect(args?.userId).toBe("u-warmup-fmt");
      expect(args?.jobId).toBe("j-warmup-fmt");
    } catch (err) {
      dumpBadgerCacheWarmupSnapshot(label, {
        userId: "u-warmup-fmt",
        jobId: "j-warmup-fmt",
        mediaId: "media-1",
        scope: "format",
        variant: "360p",
        sourceFileId: "parent-source-file-1",
        produced,
        commitResult: result,
        fileId: result.fileId,
        warmupCallCount: warmupSpy.mock.calls.length,
        warmupArgs: warmupSpy.mock.calls.map((c) => c[0]),
        libraryDbCalls,
        libraryDbCallCount: libraryDbCalls.length,
        expected: { fileId: "parent-source-file-1", warmupCallCount: 1, firstArg: { userId: "u-warmup-fmt", jobId: "j-warmup-fmt" } },
        actual: { result, warmupCallCount: warmupSpy.mock.calls.length, firstArg: warmupSpy.mock.calls[0]?.[0] },
        error: err,
      });
      throw err;
    }
  });
});

describe("@bugfix @regression-proof Round-13 #2 — fire-and-forget guarantee", () => {
  it("commit succeeds even when warmup throws SYNCHRONOUSLY", async () => {
    const label = "ff-sync-throw";
    console.info(`[${SUITE}:${label}] warmup throws sync; commit must NOT reject (fire-and-forget sync path)`);
    const { libraryDb, calls: libraryDbCalls } = buildLibraryDb();
    // Intentional sync throw — pre-fix this would propagate up the call
    // stack and fail the commit step. Post-fix the try/catch around the
    // invocation swallows it.
    const warmupSpy = vi.fn((_args: WarmStorageCacheArgs) => {
      throw new Error("warmup_blew_up_synchronously");
    }) as unknown as (
      args: WarmStorageCacheArgs
    ) => Promise<WarmStorageCacheResult>;
    const warmupMock = warmupSpy as unknown as ReturnType<typeof vi.fn>;

    const deps = buildBadgerStepDeps({
      libraryDb,
      processMediaJob: buildProcessMediaJobMock(),
      resolveToken: () => "test-token",
      resolveLibraryKey: () => "lk",
      warmStorageCacheImpl: warmupSpy,
    });

    const ctrl = new AbortController();
    const produced = buildProducedFixture();
    // (b — sync path) — commit must NOT reject.
    const result = await deps.commit({
      userId: "u-sync-throw",
      jobId: "j-sync-throw",
      mediaId: "media-1",
      filename: "movie.mkv",
      scope: "source",
      produced,
      signal: ctrl.signal,
    });
    console.info(`[${SUITE}:${label}] commit returned despite sync throw; result fileId=${result.fileId} formatIds=${JSON.stringify(result.formatIds)}`);

    try {
      expect(result.fileId).toBe("file-1");
      expect(result.formatIds).toEqual(["fmt-1"]);
      expect(warmupSpy).toHaveBeenCalledTimes(1);
    } catch (err) {
      dumpBadgerCacheWarmupSnapshot(label, {
        userId: "u-sync-throw",
        jobId: "j-sync-throw",
        mediaId: "media-1",
        scope: "source",
        produced,
        commitResult: result,
        fileId: result.fileId,
        formatIds: result.formatIds,
        warmupCallCount: warmupMock.mock.calls.length,
        libraryDbCalls,
        libraryDbCallCount: libraryDbCalls.length,
        expected: { fileId: "file-1", formatIds: ["fmt-1"], warmupCallCount: 1 },
        actual: { result, warmupCallCount: warmupMock.mock.calls.length },
        error: err,
      });
      throw err;
    }
  });

  it("commit succeeds even when warmup REJECTS asynchronously", async () => {
    const label = "ff-async-reject";
    console.info(`[${SUITE}:${label}] warmup rejects async; commit must NOT reject (fire-and-forget async path)`);
    const { libraryDb, calls: libraryDbCalls } = buildLibraryDb();
    // Async rejection — fire-and-forget on the inner Promise must catch this.
    const warmupSpy = vi.fn(
      async (_args: WarmStorageCacheArgs): Promise<WarmStorageCacheResult> => {
        throw new Error("warmup_async_failed");
      }
    );

    const deps = buildBadgerStepDeps({
      libraryDb,
      processMediaJob: buildProcessMediaJobMock(),
      resolveToken: () => "test-token",
      resolveLibraryKey: () => "lk",
      warmStorageCacheImpl: warmupSpy,
    });

    const ctrl = new AbortController();
    const produced = buildProducedFixture();
    const result = await deps.commit({
      userId: "u-async-reject",
      jobId: "j-async-reject",
      mediaId: "media-1",
      filename: "movie.mkv",
      scope: "source",
      produced,
      signal: ctrl.signal,
    });
    console.info(`[${SUITE}:${label}] commit returned despite async rejection; result fileId=${result.fileId}`);

    try {
      expect(result.fileId).toBe("file-1");
      expect(result.formatIds).toEqual(["fmt-1"]);
      expect(warmupSpy).toHaveBeenCalledTimes(1);
    } catch (err) {
      dumpBadgerCacheWarmupSnapshot(label, {
        userId: "u-async-reject",
        jobId: "j-async-reject",
        mediaId: "media-1",
        scope: "source",
        produced,
        commitResult: result,
        fileId: result.fileId,
        formatIds: result.formatIds,
        warmupCallCount: warmupSpy.mock.calls.length,
        libraryDbCalls,
        libraryDbCallCount: libraryDbCalls.length,
        expected: { fileId: "file-1", formatIds: ["fmt-1"], warmupCallCount: 1 },
        actual: { result, warmupCallCount: warmupSpy.mock.calls.length },
        error: err,
      });
      throw err;
    }

    // Allow the rejected promise's microtask to flush so vitest doesn't
    // surface an "unhandled promise rejection" between tests.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("commit succeeds and warmup is still invoked when token resolver returns null", async () => {
    const label = "ff-null-token-still-invokes-warmup";
    console.info(`[${SUITE}:${label}] resolveToken=null; warmup still called once with token=""`);
    // If auth-attach hasn't refreshed the token slot yet, the warmup
    // implementation handles the empty-token case internally (returns
    // dispatched:0). The deps-adapter still calls the hook once — what we
    // pass is the empty string. The commit step itself is unaffected.
    const { libraryDb, calls: libraryDbCalls } = buildLibraryDb();
    const warmupSpy = vi.fn(
      async (_args: WarmStorageCacheArgs): Promise<WarmStorageCacheResult> => ({
        dispatched: 0,
        ok: true,
        reason: "no_token",
      })
    );

    const deps = buildBadgerStepDeps({
      libraryDb,
      processMediaJob: buildProcessMediaJobMock(),
      resolveToken: () => null, // simulate auth-attach race
      resolveLibraryKey: () => "lk",
      warmStorageCacheImpl: warmupSpy,
    });

    const ctrl = new AbortController();
    const produced = buildProducedFixture();
    const result = await deps.commit({
      userId: "u-no-token",
      jobId: "j-no-token",
      mediaId: "media-1",
      filename: "movie.mkv",
      scope: "source",
      produced,
      signal: ctrl.signal,
    });
    console.info(`[${SUITE}:${label}] commit fileId=${result.fileId} warmupCallCount=${warmupSpy.mock.calls.length} token=${JSON.stringify(warmupSpy.mock.calls[0]?.[0]?.token)}`);

    try {
      expect(result.fileId).toBe("file-1");
      expect(warmupSpy).toHaveBeenCalledTimes(1);
      expect(warmupSpy.mock.calls[0]?.[0]?.token).toBe("");
    } catch (err) {
      dumpBadgerCacheWarmupSnapshot(label, {
        userId: "u-no-token",
        jobId: "j-no-token",
        mediaId: "media-1",
        scope: "source",
        produced,
        commitResult: result,
        fileId: result.fileId,
        warmupCallCount: warmupSpy.mock.calls.length,
        warmupArgs: warmupSpy.mock.calls.map((c) => c[0]),
        token: warmupSpy.mock.calls[0]?.[0]?.token,
        libraryDbCalls,
        libraryDbCallCount: libraryDbCalls.length,
        expected: { fileId: "file-1", warmupCallCount: 1, token: "" },
        actual: { fileId: result.fileId, warmupCallCount: warmupSpy.mock.calls.length, token: warmupSpy.mock.calls[0]?.[0]?.token },
        error: err,
      });
      throw err;
    }
  });
});

describe("@bugfix @regression-proof Round-13 #2 — warmStorageCache HTTP behavior", () => {
  it("no-ops when token is missing (auth not ready)", async () => {
    const label = "http-no-op-missing-token";
    console.info(`[${SUITE}:${label}] token=""; expects no fetch, reason=no_token, dispatched=0, ok=true`);
    // Inline import to avoid hoisting issues with the module under test.
    const { warmStorageCache } = await import(
      "../src/modules/badger/steps/cacheWarmup"
    );
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    const produced = buildProducedFixture();
    const result = await warmStorageCache({
      produced,
      token: "",
      userId: "u",
      jobId: "j",
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    console.info(`[${SUITE}:${label}] result=${JSON.stringify(result)} fetchCallCount=${fetchSpy.mock.calls.length}`);
    try {
      expect(result.dispatched).toBe(0);
      expect(result.ok).toBe(true);
      expect(result.reason).toBe("no_token");
      expect(fetchSpy).not.toHaveBeenCalled();
    } catch (err) {
      dumpBadgerCacheWarmupSnapshot(label, {
        produced,
        token: "",
        httpResult: result,
        fetchCallCount: fetchSpy.mock.calls.length,
        fetchCallUrls: (fetchSpy.mock.calls as unknown[][]).map((c) => String(c[0])),
        expected: { dispatched: 0, ok: true, reason: "no_token", fetchCallCount: 0 },
        actual: { ...result, fetchCallCount: fetchSpy.mock.calls.length },
        error: err,
      });
      throw err;
    }
  });

  it("no-ops when produced has no keys", async () => {
    const label = "http-no-op-empty-produced";
    console.info(`[${SUITE}:${label}] empty produced; expects no fetch, reason=no_keys, dispatched=0`);
    const { warmStorageCache } = await import(
      "../src/modules/badger/steps/cacheWarmup"
    );
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    const produced: ProducedMedia = { videoFormats: [], audioTracks: [], subtitleTracks: [] };
    const result = await warmStorageCache({
      produced,
      token: "tok",
      userId: "u",
      jobId: "j",
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    console.info(`[${SUITE}:${label}] result=${JSON.stringify(result)} fetchCallCount=${fetchSpy.mock.calls.length}`);
    try {
      expect(result.dispatched).toBe(0);
      expect(result.reason).toBe("no_keys");
      expect(fetchSpy).not.toHaveBeenCalled();
    } catch (err) {
      dumpBadgerCacheWarmupSnapshot(label, {
        produced,
        token: "tok",
        httpResult: result,
        fetchCallCount: fetchSpy.mock.calls.length,
        expected: { dispatched: 0, reason: "no_keys", fetchCallCount: 0 },
        actual: { ...result, fetchCallCount: fetchSpy.mock.calls.length },
        error: err,
      });
      throw err;
    }
  });

  it("posts a single batched request to /storage/head with the warmup keys", async () => {
    const label = "http-posts-batched-head";
    console.info(`[${SUITE}:${label}] expects 1 fetch to /storage/head POST with Bearer auth + warmup keys body`);
    const { warmStorageCache } = await import(
      "../src/modules/badger/steps/cacheWarmup"
    );
    const fetchSpy = vi.fn(
      async (_url: string | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ exists: {} }), { status: 200 })
    );
    const produced = buildProducedFixture();
    const result = await warmStorageCache({
      produced,
      token: "tok-abc",
      userId: "u",
      jobId: "j",
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    console.info(`[${SUITE}:${label}] result=${JSON.stringify(result)} fetchCallCount=${fetchSpy.mock.calls.length}`);
    try {
      expect(result.ok).toBe(true);
      expect(result.dispatched).toBeGreaterThan(0);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(String(url)).toMatch(/\/storage\/head$/);
      expect(init.method).toBe("POST");
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer tok-abc");
      expect(headers["X-Space-App"]).toBe("badger");
      const body = JSON.parse(String(init.body));
      expect(Array.isArray(body.keys)).toBe(true);
      expect(body.keys).toContain("shards/dev/init-1080p");
      expect(body.keys).toContain("shards/dev/seg-1080p-1");
    } catch (err) {
      const firstCall = fetchSpy.mock.calls[0] as [string, RequestInit] | undefined;
      const init = firstCall?.[1];
      const parsedBody = init?.body ? (() => { try { return JSON.parse(String(init.body)); } catch { return "(body-parse-fail)"; } })() : undefined;
      dumpBadgerCacheWarmupSnapshot(label, {
        produced,
        token: "tok-abc",
        httpResult: result,
        fetchCallCount: fetchSpy.mock.calls.length,
        fetchRequestUrl: firstCall ? String(firstCall[0]) : undefined,
        fetchRequestMethod: init?.method,
        fetchRequestHeaders: init?.headers,
        fetchRequestBody: parsedBody,
        expected: { ok: true, dispatched: ">0", fetchCallCount: 1, urlMatches: "/storage/head$", method: "POST", auth: "Bearer tok-abc", app: "badger" },
        actual: { ...result, fetchCallCount: fetchSpy.mock.calls.length },
        error: err,
      });
      throw err;
    }
  });

  it("returns ok:false but does not throw when fetch rejects", async () => {
    const label = "http-fetch-rejects-caught";
    console.info(`[${SUITE}:${label}] fetch rejects 'network_down'; expects ok=false reason=network_down (no rethrow)`);
    const { warmStorageCache } = await import(
      "../src/modules/badger/steps/cacheWarmup"
    );
    const fetchSpy = vi.fn(async () => {
      throw new Error("network_down");
    });
    const produced = buildProducedFixture();
    const result = await warmStorageCache({
      produced,
      token: "tok",
      userId: "u",
      jobId: "j",
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    console.info(`[${SUITE}:${label}] result=${JSON.stringify(result)}`);
    try {
      // Function did NOT throw — it caught and reported.
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("network_down");
    } catch (err) {
      dumpBadgerCacheWarmupSnapshot(label, {
        produced,
        token: "tok",
        httpResult: result,
        fetchCallCount: fetchSpy.mock.calls.length,
        expected: { ok: false, reason: "network_down" },
        actual: result,
        error: err,
      });
      throw err;
    }
  });

  it("returns ok:false on non-2xx without throwing", async () => {
    const label = "http-non-2xx-no-throw";
    console.info(`[${SUITE}:${label}] upstream HTTP 500; expects ok=false reason=http_500 (no rethrow)`);
    const { warmStorageCache } = await import(
      "../src/modules/badger/steps/cacheWarmup"
    );
    const fetchSpy = vi.fn(
      async () =>
        new Response("upstream blew up", { status: 500 })
    );
    const produced = buildProducedFixture();
    const result = await warmStorageCache({
      produced,
      token: "tok",
      userId: "u",
      jobId: "j",
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    console.info(`[${SUITE}:${label}] result=${JSON.stringify(result)}`);
    try {
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("http_500");
    } catch (err) {
      dumpBadgerCacheWarmupSnapshot(label, {
        produced,
        token: "tok",
        httpResult: result,
        fetchCallCount: fetchSpy.mock.calls.length,
        fetchResponseStatus: 500,
        expected: { ok: false, reason: "http_500" },
        actual: result,
        error: err,
      });
      throw err;
    }
  });
});
