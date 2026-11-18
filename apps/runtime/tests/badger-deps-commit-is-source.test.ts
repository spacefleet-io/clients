/**
 * @test-id RUNTIME-BADGER-COMMIT-IS-SOURCE-001
 * @level unit
 *
 * Phase 2 of the post-ingest quality management plan
 * (`virtual-puzzling-sketch.md`): the source-job commit step must flip
 * `is_source = 1` on the format row that came from the source extraction
 * (its `quality` matches the probe-derived `sourceQuality` threaded through
 * the job payload). All other rows — fallback transcodes, format-job
 * commits — stay at `is_source = 0` (the schema DEFAULT).
 *
 * The flip happens at the deps-adapter seam — the runtime calls
 * `libraryDb.call("addMediaFormat", [..., { isSource: true }])` and the
 * library-db-runtime layer translates that to `is_source = 1` in the
 * SQLite row (already covered by Commit A). This test pins the
 * adapter-side wiring with a mocked libraryDb: it asserts WHICH format
 * gets the flag, and verifies format-job commits never pass `isSource`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetBadgerStepDepsAdapter,
  buildBadgerStepDeps,
  type ProcessMediaJobFn,
} from "../src/modules/badger/steps/deps-adapter";
import type { ProducedMedia } from "@space/ingest-core/mediaProcessor";

const SUITE = "badger-deps-commit-is-source";

const jsonReplacer = (_key: string, value: unknown) => {
  if (value instanceof Uint8Array) {
    return `<Uint8Array bytes=${value.byteLength}>`;
  }
  if (value instanceof Buffer) {
    return `<Buffer bytes=${value.byteLength}>`;
  }
  return value;
};

const dumpBadgerCommitIsSourceSnapshot = (
  label: string,
  ctx: {
    userId?: string;
    jobId?: string;
    mediaId?: string;
    scope?: string;
    variant?: string;
    sourceFileId?: string;
    sourceQuality?: string | null;
    produced?: unknown;
    producedFormats?: unknown;
    commitResult?: unknown;
    fileId?: string | null;
    formatIds?: unknown;
    recordedCalls?: unknown;
    recordedCallMethods?: string[];
    addCalls?: unknown;
    addCallCount?: number;
    expected?: unknown;
    actual?: unknown;
    extra?: Record<string, unknown>;
    error?: unknown;
  } = {}
) => {
  try {
    console.error(`=== [${SUITE}:${label}] badger-deps-commit-is-source snapshot ===`);
    if (ctx.userId !== undefined) console.error(`userId: ${ctx.userId}`);
    if (ctx.jobId !== undefined) console.error(`jobId: ${ctx.jobId}`);
    if (ctx.mediaId !== undefined) console.error(`mediaId: ${ctx.mediaId}`);
    if (ctx.scope !== undefined) console.error(`scope: ${ctx.scope}`);
    if (ctx.variant !== undefined) console.error(`variant: ${ctx.variant}`);
    if (ctx.sourceFileId !== undefined) console.error(`sourceFileId: ${ctx.sourceFileId}`);
    if (ctx.sourceQuality !== undefined) {
      console.error(`sourceQuality: ${ctx.sourceQuality === null ? "(null)" : ctx.sourceQuality}`);
    }
    if (ctx.produced !== undefined) {
      console.error(`produced:\n${JSON.stringify(ctx.produced, jsonReplacer, 2)}`);
    }
    if (ctx.producedFormats !== undefined) {
      console.error(`producedFormats:\n${JSON.stringify(ctx.producedFormats, jsonReplacer, 2)}`);
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
    if (ctx.recordedCalls !== undefined) {
      console.error(`recordedCalls:\n${JSON.stringify(ctx.recordedCalls, jsonReplacer, 2)}`);
    }
    if (ctx.recordedCallMethods !== undefined) {
      console.error(`recordedCallMethods:\n${JSON.stringify(ctx.recordedCallMethods, jsonReplacer, 2)}`);
    }
    if (ctx.addCalls !== undefined) {
      console.error(`addCalls:\n${JSON.stringify(ctx.addCalls, jsonReplacer, 2)}`);
    }
    if (ctx.addCallCount !== undefined) console.error(`addCallCount: ${ctx.addCallCount}`);
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

const buildProducedSourceJobFixture = (): ProducedMedia => ({
  // Real source-job shape: the source-extracted variant comes FIRST (matching
  // `state.outputs` append order in mediaProcessor — `video-source` is
  // ensured before the fallback variants). 360p is the post-Phase-3
  // default fallback.
  videoFormats: [
    {
      quality: "1080p",
      codec: "h264",
      codecString: "avc1.640028",
      initKey: "shards/dev/init-source",
      initSize: 2048,
      durationSeconds: 60,
      totalSize: 10_000_000,
      chunks: [{ key: "shards/dev/seg-source-1", sizeBytes: 9_000_000, startSeconds: 0 }],
    },
    {
      quality: "360p",
      codec: "h264",
      codecString: "avc1.42c01e",
      initKey: "shards/dev/init-360",
      initSize: 1024,
      durationSeconds: 60,
      totalSize: 1_500_000,
      chunks: [{ key: "shards/dev/seg-360-1", sizeBytes: 1_400_000, startSeconds: 0 }],
    },
  ],
  audioTracks: [],
  subtitleTracks: [],
});

const buildProducedFormatJobFixture = (variantQuality: string): ProducedMedia => ({
  // Format-job's produced shape carries only the variant the job is for.
  videoFormats: [
    {
      quality: variantQuality,
      codec: "h264",
      codecString: "avc1.42c01e",
      initKey: `shards/dev/init-${variantQuality}`,
      initSize: 1024,
      durationSeconds: 60,
      totalSize: 1_500_000,
      chunks: [
        { key: `shards/dev/seg-${variantQuality}-1`, sizeBytes: 1_400_000, startSeconds: 0 },
      ],
    },
  ],
  audioTracks: [],
  subtitleTracks: [],
});

const buildProcessMediaJobMock = (): ProcessMediaJobFn =>
  vi.fn(async () => {
    throw new Error("processMediaJob should NOT be called from commit-only test");
  }) as unknown as ProcessMediaJobFn;

type AddMediaFormatArgs = [
  string, // mediaId
  string, // fileId
  string, // quality
  string, // codec
  number, // sizeMb
  ReadonlyArray<{ key: string; sizeBytes?: number | null; startSeconds?: number | null }>,
  number | null, // bitrateKbps
  {
    codecString?: string | null;
    initKey?: string | null;
    initSize?: number | null;
    durationSeconds?: number | null;
    totalSize?: number | null;
    isSource?: boolean;
  },
];

const collectAddMediaFormatCalls = (
  recorded: Array<{ method: string; args: unknown[] }>
): Array<{ quality: string; isSource: boolean | undefined }> =>
  recorded
    .filter((c) => c.method === "addMediaFormat")
    .map((c) => {
      const args = c.args as AddMediaFormatArgs;
      return {
        quality: String(args[2]),
        isSource: (args[7] ?? {}).isSource,
      };
    });

beforeEach(() => {
  __resetBadgerStepDepsAdapter();
});

afterEach(() => {
  __resetBadgerStepDepsAdapter();
});

describe("Phase 2 — source-job commit flags is_source = true on the source-extracted row", () => {
  it("source-job commit with sourceQuality = '1080p' flips isSource on the 1080p row only", async () => {
    const label = "source-1080p-flips-1080p-row";
    console.info(`[${SUITE}:${label}] sourceQuality=1080p over [1080p,360p]; expects 1080p row flagged, 360p false`);
    const recorded: Array<{ method: string; args: unknown[] }> = [];
    let nextFormatId = 1;
    const libraryDb = {
      call: vi.fn(async (method: string, args: unknown[] = []) => {
        recorded.push({ method, args });
        if (method === "getMediaDetails") {
          return { id: "media-orchard", title: "Orchard", type: "movie" };
        }
        if (method === "linkFileToMedia") return "file-orchard-src";
        if (method === "addMediaFormat") return `fmt-${nextFormatId++}`;
        return null;
      }),
    } as unknown as Parameters<typeof buildBadgerStepDeps>[0]["libraryDb"];

    const deps = buildBadgerStepDeps({
      libraryDb,
      processMediaJob: buildProcessMediaJobMock(),
      resolveToken: () => "tok",
      resolveLibraryKey: () => "lk",
    });

    const ctrl = new AbortController();
    const produced = buildProducedSourceJobFixture();
    const result = await deps.commit({
      userId: "u1",
      jobId: "j1",
      mediaId: "media-orchard",
      filename: "/tmp/Orchard.mkv",
      scope: "source",
      sourceQuality: "1080p",
      produced,
      signal: ctrl.signal,
    });
    const addCalls = collectAddMediaFormatCalls(recorded);
    console.info(`[${SUITE}:${label}] commit fileId=${result.fileId} formatIds=${JSON.stringify(result.formatIds)} addCalls=${JSON.stringify(addCalls)}`);

    try {
      expect(result.fileId).toBe("file-orchard-src");
      expect(result.formatIds).toEqual(["fmt-1", "fmt-2"]);

      expect(addCalls).toHaveLength(2);

      // The 1080p row (the source-extracted variant) gets isSource=true; the
      // 360p fallback stays false. Order in the array mirrors the order of
      // calls (which mirrors produced.videoFormats order).
      expect(addCalls[0]).toEqual({ quality: "1080p", isSource: true });
      expect(addCalls[1]).toEqual({ quality: "360p", isSource: false });
    } catch (err) {
      dumpBadgerCommitIsSourceSnapshot(label, {
        userId: "u1",
        jobId: "j1",
        mediaId: "media-orchard",
        scope: "source",
        sourceQuality: "1080p",
        produced,
        producedFormats: produced.videoFormats.map((f) => f.quality),
        commitResult: result,
        fileId: result.fileId,
        formatIds: result.formatIds,
        recordedCalls: recorded,
        recordedCallMethods: recorded.map((r) => r.method),
        addCalls,
        addCallCount: addCalls.length,
        expected: {
          fileId: "file-orchard-src",
          formatIds: ["fmt-1", "fmt-2"],
          addCalls: [{ quality: "1080p", isSource: true }, { quality: "360p", isSource: false }],
        },
        actual: { fileId: result.fileId, formatIds: result.formatIds, addCalls },
        error: err,
      });
      throw err;
    }
  });

  it("source-job commit with sourceQuality = '720p' flips only the 720p row even when 720p is not first", async () => {
    const label = "source-720p-flips-by-quality-not-index";
    console.info(`[${SUITE}:${label}] reordered produced [360p,720p] + sourceQuality=720p; flag must match by quality`);
    // Defensive: if a hypothetical future produced.videoFormats order ever
    // diverges from the "source-first" convention, the match still keys on
    // (quality === sourceQuality) and not array index.
    const reorderedProduced: ProducedMedia = {
      videoFormats: [
        // 360p fallback listed FIRST to invert the usual order.
        {
          quality: "360p",
          codec: "h264",
          codecString: "avc1.42c01e",
          initKey: "shards/dev/init-360",
          initSize: 1024,
          durationSeconds: 60,
          totalSize: 1_500_000,
          chunks: [{ key: "shards/dev/seg-360-1", sizeBytes: 1_400_000, startSeconds: 0 }],
        },
        {
          quality: "720p",
          codec: "h264",
          codecString: "avc1.640028",
          initKey: "shards/dev/init-720",
          initSize: 2048,
          durationSeconds: 60,
          totalSize: 5_000_000,
          chunks: [{ key: "shards/dev/seg-720-1", sizeBytes: 4_900_000, startSeconds: 0 }],
        },
      ],
      audioTracks: [],
      subtitleTracks: [],
    };

    const recorded: Array<{ method: string; args: unknown[] }> = [];
    let nextFormatId = 1;
    const libraryDb = {
      call: vi.fn(async (method: string, args: unknown[] = []) => {
        recorded.push({ method, args });
        if (method === "getMediaDetails") {
          return { id: "media-orchard", title: "Orchard", type: "movie" };
        }
        if (method === "linkFileToMedia") return "file-orchard-src";
        if (method === "addMediaFormat") return `fmt-${nextFormatId++}`;
        return null;
      }),
    } as unknown as Parameters<typeof buildBadgerStepDeps>[0]["libraryDb"];

    const deps = buildBadgerStepDeps({
      libraryDb,
      processMediaJob: buildProcessMediaJobMock(),
      resolveToken: () => "tok",
      resolveLibraryKey: () => "lk",
    });

    const ctrl = new AbortController();
    await deps.commit({
      userId: "u1",
      jobId: "j2",
      mediaId: "media-orchard",
      filename: "/tmp/Orchard.mkv",
      scope: "source",
      sourceQuality: "720p",
      produced: reorderedProduced,
      signal: ctrl.signal,
    });
    const addCalls = collectAddMediaFormatCalls(recorded);
    console.info(`[${SUITE}:${label}] addCalls=${JSON.stringify(addCalls)}`);

    try {
      expect(addCalls).toEqual([
        { quality: "360p", isSource: false },
        { quality: "720p", isSource: true },
      ]);
    } catch (err) {
      dumpBadgerCommitIsSourceSnapshot(label, {
        userId: "u1",
        jobId: "j2",
        mediaId: "media-orchard",
        scope: "source",
        sourceQuality: "720p",
        produced: reorderedProduced,
        producedFormats: reorderedProduced.videoFormats.map((f) => f.quality),
        recordedCalls: recorded,
        recordedCallMethods: recorded.map((r) => r.method),
        addCalls,
        addCallCount: addCalls.length,
        expected: [{ quality: "360p", isSource: false }, { quality: "720p", isSource: true }],
        actual: addCalls,
        error: err,
      });
      throw err;
    }
  });

  it("source-job commit with sourceQuality = null (legacy ingest payload) flags no row", async () => {
    const label = "source-null-quality-flags-none";
    console.info(`[${SUITE}:${label}] sourceQuality=null (legacy); expects no isSource flips`);
    // Pre-Phase-2 ingest paths don't carry sourceQuality on the payload. We
    // must NOT guess — leaving everything at the column DEFAULT 0 lets the
    // Phase 1 schema backfill (in library-db-definition/src/migrations.ts)
    // own the legacy-library state, and the next user-driven re-ingest can
    // re-derive the flag.
    const recorded: Array<{ method: string; args: unknown[] }> = [];
    let nextFormatId = 1;
    const libraryDb = {
      call: vi.fn(async (method: string, args: unknown[] = []) => {
        recorded.push({ method, args });
        if (method === "getMediaDetails") {
          return { id: "media-orchard", title: "Orchard", type: "movie" };
        }
        if (method === "linkFileToMedia") return "file-orchard-src";
        if (method === "addMediaFormat") return `fmt-${nextFormatId++}`;
        return null;
      }),
    } as unknown as Parameters<typeof buildBadgerStepDeps>[0]["libraryDb"];

    const deps = buildBadgerStepDeps({
      libraryDb,
      processMediaJob: buildProcessMediaJobMock(),
      resolveToken: () => "tok",
      resolveLibraryKey: () => "lk",
    });

    const ctrl = new AbortController();
    const produced = buildProducedSourceJobFixture();
    await deps.commit({
      userId: "u1",
      jobId: "j-legacy",
      mediaId: "media-orchard",
      filename: "/tmp/Orchard.mkv",
      scope: "source",
      sourceQuality: null,
      produced,
      signal: ctrl.signal,
    });
    const addCalls = collectAddMediaFormatCalls(recorded);
    console.info(`[${SUITE}:${label}] addCalls=${JSON.stringify(addCalls)}`);

    try {
      expect(addCalls).toHaveLength(2);
      for (const call of addCalls) {
        expect(call.isSource).toBe(false);
      }
    } catch (err) {
      dumpBadgerCommitIsSourceSnapshot(label, {
        userId: "u1",
        jobId: "j-legacy",
        mediaId: "media-orchard",
        scope: "source",
        sourceQuality: null,
        produced,
        producedFormats: produced.videoFormats.map((f) => f.quality),
        recordedCalls: recorded,
        recordedCallMethods: recorded.map((r) => r.method),
        addCalls,
        addCallCount: addCalls.length,
        expected: { length: 2, allIsSourceFalse: true },
        actual: { length: addCalls.length, isSourceValues: addCalls.map((c) => c.isSource) },
        error: err,
      });
      throw err;
    }
  });

  it("source-job commit with no sourceQuality field at all (undefined) flags no row", async () => {
    const label = "source-undefined-quality-flags-none";
    console.info(`[${SUITE}:${label}] sourceQuality omitted; expects no isSource flips`);
    // Even older payloads omit the key entirely. Same contract as
    // sourceQuality: null — no flip, schema DEFAULT 0 wins.
    const recorded: Array<{ method: string; args: unknown[] }> = [];
    let nextFormatId = 1;
    const libraryDb = {
      call: vi.fn(async (method: string, args: unknown[] = []) => {
        recorded.push({ method, args });
        if (method === "getMediaDetails") {
          return { id: "media-orchard", title: "Orchard", type: "movie" };
        }
        if (method === "linkFileToMedia") return "file-orchard-src";
        if (method === "addMediaFormat") return `fmt-${nextFormatId++}`;
        return null;
      }),
    } as unknown as Parameters<typeof buildBadgerStepDeps>[0]["libraryDb"];

    const deps = buildBadgerStepDeps({
      libraryDb,
      processMediaJob: buildProcessMediaJobMock(),
      resolveToken: () => "tok",
      resolveLibraryKey: () => "lk",
    });

    const ctrl = new AbortController();
    const produced = buildProducedSourceJobFixture();
    await deps.commit({
      userId: "u1",
      jobId: "j-undef",
      mediaId: "media-orchard",
      filename: "/tmp/Orchard.mkv",
      scope: "source",
      // sourceQuality intentionally omitted
      produced,
      signal: ctrl.signal,
    });
    const addCalls = collectAddMediaFormatCalls(recorded);
    console.info(`[${SUITE}:${label}] addCalls=${JSON.stringify(addCalls)}`);

    try {
      expect(addCalls.every((c) => c.isSource === false)).toBe(true);
    } catch (err) {
      dumpBadgerCommitIsSourceSnapshot(label, {
        userId: "u1",
        jobId: "j-undef",
        mediaId: "media-orchard",
        scope: "source",
        sourceQuality: undefined as unknown as null,
        produced,
        recordedCalls: recorded,
        recordedCallMethods: recorded.map((r) => r.method),
        addCalls,
        addCallCount: addCalls.length,
        expected: { allIsSourceFalse: true },
        actual: { isSourceValues: addCalls.map((c) => c.isSource) },
        error: err,
      });
      throw err;
    }
  });

  it("source-job commit with sourceQuality that does NOT match any produced format flags no row", async () => {
    const label = "source-mismatch-quality-flags-none";
    console.info(`[${SUITE}:${label}] sourceQuality=2160p but produced has only 1080p+360p; expects no flips`);
    // Edge: the runtime mis-typed or the probe disagreed with the encoder.
    // We should NEVER flag a row whose quality doesn't actually match — the
    // post-ingest delete guard relies on the flag being trustworthy.
    const recorded: Array<{ method: string; args: unknown[] }> = [];
    let nextFormatId = 1;
    const libraryDb = {
      call: vi.fn(async (method: string, args: unknown[] = []) => {
        recorded.push({ method, args });
        if (method === "getMediaDetails") {
          return { id: "media-orchard", title: "Orchard", type: "movie" };
        }
        if (method === "linkFileToMedia") return "file-orchard-src";
        if (method === "addMediaFormat") return `fmt-${nextFormatId++}`;
        return null;
      }),
    } as unknown as Parameters<typeof buildBadgerStepDeps>[0]["libraryDb"];

    const deps = buildBadgerStepDeps({
      libraryDb,
      processMediaJob: buildProcessMediaJobMock(),
      resolveToken: () => "tok",
      resolveLibraryKey: () => "lk",
    });

    const ctrl = new AbortController();
    const produced = buildProducedSourceJobFixture();
    await deps.commit({
      userId: "u1",
      jobId: "j-mismatch",
      mediaId: "media-orchard",
      filename: "/tmp/Orchard.mkv",
      scope: "source",
      sourceQuality: "2160p", // not in produced.videoFormats (1080p + 360p only)
      produced,
      signal: ctrl.signal,
    });
    const addCalls = collectAddMediaFormatCalls(recorded);
    console.info(`[${SUITE}:${label}] addCalls=${JSON.stringify(addCalls)}`);

    try {
      expect(addCalls.every((c) => c.isSource === false)).toBe(true);
    } catch (err) {
      dumpBadgerCommitIsSourceSnapshot(label, {
        userId: "u1",
        jobId: "j-mismatch",
        mediaId: "media-orchard",
        scope: "source",
        sourceQuality: "2160p",
        produced,
        producedFormats: produced.videoFormats.map((f) => f.quality),
        recordedCalls: recorded,
        recordedCallMethods: recorded.map((r) => r.method),
        addCalls,
        addCallCount: addCalls.length,
        expected: { allIsSourceFalse: true },
        actual: { isSourceValues: addCalls.map((c) => c.isSource) },
        error: err,
      });
      throw err;
    }
  });
});

describe("Phase 2 — format-job commit never flags is_source", () => {
  it("format-job commit (scope=format) does NOT pass isSource even when variant matches sourceQuality", async () => {
    const label = "format-job-never-passes-is-source";
    console.info(`[${SUITE}:${label}] scope=format variant=720p sourceQuality=720p; isSource MUST stay undefined`);
    // Format-jobs are added-after-the-fact transcodes. By construction they
    // are never the source-of-record. We pin that the adapter omits the
    // flag (so it defaults to false on the library-db-runtime side) — even
    // in the pathological case where a caller somehow set sourceQuality on
    // a format-job commit input.
    const recorded: Array<{ method: string; args: unknown[] }> = [];
    let nextFormatId = 1;
    const libraryDb = {
      call: vi.fn(async (method: string, args: unknown[] = []) => {
        recorded.push({ method, args });
        if (method === "addMediaFormat") return `fmt-${nextFormatId++}`;
        return null;
      }),
    } as unknown as Parameters<typeof buildBadgerStepDeps>[0]["libraryDb"];

    const deps = buildBadgerStepDeps({
      libraryDb,
      processMediaJob: buildProcessMediaJobMock(),
      resolveToken: () => "tok",
      resolveLibraryKey: () => "lk",
    });

    const ctrl = new AbortController();
    const produced = buildProducedFormatJobFixture("720p");
    await deps.commit({
      userId: "u1",
      jobId: "j-format",
      mediaId: "media-orchard",
      filename: "/tmp/Orchard.mkv",
      scope: "format",
      variant: "720p",
      sourceFileId: "file-orchard-src",
      // Even with this set (which should never happen for a format job),
      // the adapter's format-job branch never reaches the source-marking
      // code.
      sourceQuality: "720p",
      produced,
      signal: ctrl.signal,
    });
    const addCalls = collectAddMediaFormatCalls(recorded);
    console.info(`[${SUITE}:${label}] addCalls=${JSON.stringify(addCalls)}`);

    try {
      expect(addCalls).toHaveLength(1);
      expect(addCalls[0]!.quality).toBe("720p");
      // Adapter must NOT pass isSource on the format-job branch.
      expect(addCalls[0]!.isSource).toBeUndefined();
    } catch (err) {
      dumpBadgerCommitIsSourceSnapshot(label, {
        userId: "u1",
        jobId: "j-format",
        mediaId: "media-orchard",
        scope: "format",
        variant: "720p",
        sourceFileId: "file-orchard-src",
        sourceQuality: "720p",
        produced,
        recordedCalls: recorded,
        recordedCallMethods: recorded.map((r) => r.method),
        addCalls,
        addCallCount: addCalls.length,
        expected: { length: 1, quality: "720p", isSource: undefined },
        actual: { length: addCalls.length, quality: addCalls[0]?.quality, isSource: addCalls[0]?.isSource },
        error: err,
      });
      throw err;
    }
  });
});

describe("Phase 2 — invariant: at most one row per source-job is flagged", () => {
  it("if produced.videoFormats contains two rows at sourceQuality (collision edge), only the FIRST is flagged", async () => {
    const label = "collision-only-first-flagged";
    console.info(`[${SUITE}:${label}] two 1080p rows + sourceQuality=1080p; expects first=true, second=false (singleton invariant)`);
    // Defensive against a future encoder/config bug where targetVariants
    // collides with sourceQuality. The flag must remain a per-file
    // singleton — the post-ingest delete guard treats is_source as
    // "there's exactly one of these, and you can't delete it".
    const collidingProduced: ProducedMedia = {
      videoFormats: [
        {
          quality: "1080p",
          codec: "h264",
          codecString: "avc1.640028",
          initKey: "shards/dev/init-source",
          initSize: 2048,
          durationSeconds: 60,
          totalSize: 10_000_000,
          chunks: [{ key: "shards/dev/seg-src-1", sizeBytes: 9_500_000, startSeconds: 0 }],
        },
        {
          // Pathological duplicate — should never happen in real ingest.
          quality: "1080p",
          codec: "h264",
          codecString: "avc1.640028",
          initKey: "shards/dev/init-duplicate",
          initSize: 2048,
          durationSeconds: 60,
          totalSize: 9_000_000,
          chunks: [{ key: "shards/dev/seg-dup-1", sizeBytes: 8_500_000, startSeconds: 0 }],
        },
      ],
      audioTracks: [],
      subtitleTracks: [],
    };

    const recorded: Array<{ method: string; args: unknown[] }> = [];
    let nextFormatId = 1;
    const libraryDb = {
      call: vi.fn(async (method: string, args: unknown[] = []) => {
        recorded.push({ method, args });
        if (method === "getMediaDetails") {
          return { id: "media-orchard", title: "Orchard", type: "movie" };
        }
        if (method === "linkFileToMedia") return "file-orchard-src";
        if (method === "addMediaFormat") return `fmt-${nextFormatId++}`;
        return null;
      }),
    } as unknown as Parameters<typeof buildBadgerStepDeps>[0]["libraryDb"];

    const deps = buildBadgerStepDeps({
      libraryDb,
      processMediaJob: buildProcessMediaJobMock(),
      resolveToken: () => "tok",
      resolveLibraryKey: () => "lk",
    });

    const ctrl = new AbortController();
    await deps.commit({
      userId: "u1",
      jobId: "j-collide",
      mediaId: "media-orchard",
      filename: "/tmp/Orchard.mkv",
      scope: "source",
      sourceQuality: "1080p",
      produced: collidingProduced,
      signal: ctrl.signal,
    });
    const addCalls = collectAddMediaFormatCalls(recorded);
    console.info(`[${SUITE}:${label}] addCalls=${JSON.stringify(addCalls)}`);

    try {
      expect(addCalls).toHaveLength(2);
      expect(addCalls[0]!.isSource).toBe(true);
      // The second 1080p row stays at false — the adapter latches on first
      // match.
      expect(addCalls[1]!.isSource).toBe(false);
    } catch (err) {
      dumpBadgerCommitIsSourceSnapshot(label, {
        userId: "u1",
        jobId: "j-collide",
        mediaId: "media-orchard",
        scope: "source",
        sourceQuality: "1080p",
        produced: collidingProduced,
        producedFormats: collidingProduced.videoFormats.map((f) => f.quality),
        recordedCalls: recorded,
        recordedCallMethods: recorded.map((r) => r.method),
        addCalls,
        addCallCount: addCalls.length,
        expected: { length: 2, firstIsSource: true, secondIsSource: false },
        actual: { length: addCalls.length, firstIsSource: addCalls[0]?.isSource, secondIsSource: addCalls[1]?.isSource },
        error: err,
      });
      throw err;
    }
  });
});
