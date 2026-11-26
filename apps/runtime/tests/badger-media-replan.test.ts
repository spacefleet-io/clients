/**
 * Tests for `badger.media.replan_qualities` runtime handler.
 *
 * Coverage:
 *   - source-protected         — refuse to remove a format with isSource=1
 *   - media-not-found          — refuse if any referenced id is missing
 *   - quality-exists           — refuse to add a quality already present
 *   - cannot-transcode-up      — refuse to add a higher resolution than available
 *   - happy-path add           — submits one format job per add, sourceVariant
 *                                picked correctly via `pickReTranscodeSource`
 *   - happy-path remove        — calls libraryDb.removeMediaFormat for each
 *   - mixed add + remove       — both lists processed in the same call
 *   - atomic refusal           — a single bad input leaves no state mutated
 *   - idempotency on repeat    — calling twice with overlapping removes returns
 *                                a clean "media-not-found" on the second call
 *
 * Strategy: stub `EngineV2` to a minimal mock that records `submit()` calls,
 * and stub `BadgerLibraryDbService.call` to return canned format rows and to
 * record `removeMediaFormat` invocations. No SQLite, no engineV2 store — the
 * handler is pure orchestration over those two seams.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineV2 } from "@space/runtime-jobs-engine/engineV2";
import type { BadgerLibraryDbService } from "../src/modules/badgerLibraryDb";
import { createBadgerMediaReplanQualitiesHandler } from "../src/modules/badger/mediaReplan";
import type { BadgerMediaReplanQualitiesPayload } from "@space/runtime-contracts/badger/ingest";
import type { IngestJobRecord } from "@space/runtime-jobs";

type ReplanRequest = BadgerMediaReplanQualitiesPayload;

const SUITE = "badger-media-replan";

const jsonReplacer = (_key: string, value: unknown) => {
  if (value instanceof Uint8Array) {
    return `<Uint8Array bytes=${value.byteLength}>`;
  }
  if (value instanceof Buffer) {
    return `<Buffer bytes=${value.byteLength}>`;
  }
  return value;
};

const dumpBadgerMediaReplanSnapshot = (
  label: string,
  ctx: {
    mediaId?: string;
    fileId?: string;
    addQualities?: unknown;
    removeFormatIds?: unknown;
    request?: Record<string, unknown>;
    result?: unknown;
    errorCode?: string | undefined;
    rows?: unknown;
    libraryDbCalls?: unknown;
    libraryDbCallOrder?: string[];
    removed?: unknown;
    submitted?: unknown;
    submittedCount?: number;
    deleteCalls?: unknown;
    addedJobIds?: unknown;
    removedFormatIds?: unknown;
    expected?: unknown;
    actual?: unknown;
    extra?: Record<string, unknown>;
    error?: unknown;
  } = {}
) => {
  try {
    console.error(`=== [${SUITE}:${label}] badger-media-replan snapshot ===`);
    if (ctx.mediaId !== undefined) console.error(`mediaId: ${ctx.mediaId}`);
    if (ctx.fileId !== undefined) console.error(`fileId: ${ctx.fileId}`);
    if (ctx.addQualities !== undefined) {
      console.error(`addQualities:\n${JSON.stringify(ctx.addQualities, jsonReplacer, 2)}`);
    }
    if (ctx.removeFormatIds !== undefined) {
      console.error(`removeFormatIds:\n${JSON.stringify(ctx.removeFormatIds, jsonReplacer, 2)}`);
    }
    if (ctx.request !== undefined) {
      console.error(`request:\n${JSON.stringify(ctx.request, jsonReplacer, 2)}`);
    }
    if (ctx.result !== undefined) {
      console.error(`result:\n${JSON.stringify(ctx.result, jsonReplacer, 2)}`);
    }
    if (ctx.errorCode !== undefined) {
      console.error(`errorCode: ${ctx.errorCode ?? "(undefined)"}`);
    }
    if (ctx.rows !== undefined) {
      console.error(`rows:\n${JSON.stringify(ctx.rows, jsonReplacer, 2)}`);
    }
    if (ctx.libraryDbCalls !== undefined) {
      console.error(`libraryDbCalls:\n${JSON.stringify(ctx.libraryDbCalls, jsonReplacer, 2)}`);
    }
    if (ctx.libraryDbCallOrder !== undefined) {
      console.error(`libraryDbCallOrder:\n${JSON.stringify(ctx.libraryDbCallOrder, jsonReplacer, 2)}`);
    }
    if (ctx.removed !== undefined) {
      console.error(`removed:\n${JSON.stringify(ctx.removed, jsonReplacer, 2)}`);
    }
    if (ctx.submitted !== undefined) {
      console.error(`submitted:\n${JSON.stringify(ctx.submitted, jsonReplacer, 2)}`);
    }
    if (ctx.submittedCount !== undefined) {
      console.error(`submittedCount: ${ctx.submittedCount}`);
    }
    if (ctx.deleteCalls !== undefined) {
      console.error(`deleteCalls:\n${JSON.stringify(ctx.deleteCalls, jsonReplacer, 2)}`);
    }
    if (ctx.addedJobIds !== undefined) {
      console.error(`addedJobIds:\n${JSON.stringify(ctx.addedJobIds, jsonReplacer, 2)}`);
    }
    if (ctx.removedFormatIds !== undefined) {
      console.error(`removedFormatIds:\n${JSON.stringify(ctx.removedFormatIds, jsonReplacer, 2)}`);
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

type MediaFormatRow = {
  id: string;
  mediaId: string;
  fileId: string;
  quality: string;
  codec: string;
  isSource: boolean;
  initKey: string | null;
  chunks: Array<{ key: string; sizeBytes: number | null }>;
};

const buildEngine = () => {
  const submitted: IngestJobRecord[] = [];
  const engine = {
    submit: vi.fn(async (record: IngestJobRecord) => {
      submitted.push(record);
      return { jobId: record.jobId };
    }),
  } as unknown as EngineV2;
  return { engine, submitted };
};

const buildLibraryDb = (rows: MediaFormatRow[]) => {
  const removed: string[] = [];
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const libraryDb = {
    call: vi.fn(async (method: string, args: unknown[] = []) => {
      calls.push({ method, args });
      if (method === "listMediaFormats") {
        return rows;
      }
      if (method === "removeMediaFormat") {
        const formatId = args[0] as string;
        removed.push(formatId);
        return null;
      }
      throw new Error(`unexpected libraryDb.call: ${method}`);
    }),
  } as unknown as BadgerLibraryDbService;
  return { libraryDb, removed, calls };
};

const sourceRow = (overrides: Partial<MediaFormatRow> = {}): MediaFormatRow => ({
  id: "fmt-source",
  mediaId: "m-1",
  fileId: "f-1",
  quality: "1080p",
  codec: "h264",
  isSource: true,
  initKey: "source-init.key",
  chunks: [{ key: "source-chunk-1", sizeBytes: 100 }, { key: "source-chunk-2", sizeBytes: 100 }],
  ...overrides,
});

const formatRow = (overrides: Partial<MediaFormatRow> = {}): MediaFormatRow => ({
  id: "fmt-360",
  mediaId: "m-1",
  fileId: "f-1",
  quality: "360p",
  codec: "h264",
  isSource: false,
  initKey: "fmt-360-init.key",
  chunks: [{ key: "fmt-360-chunk-1", sizeBytes: 50 }, { key: "fmt-360-chunk-2", sizeBytes: 50 }],
  ...overrides,
});

describe("badger.media.replan_qualities — validation refusal codes", () => {
  it("returns source-protected when removeFormatIds targets an isSource=1 row", async () => {
    const label = "refuse-source-protected";
    console.info(`[${SUITE}:${label}] removing the source row [fmt-source]; expects source-protected refusal`);
    const { engine, submitted } = buildEngine();
    const { libraryDb, removed } = buildLibraryDb([sourceRow(), formatRow()]);
    const handler = createBadgerMediaReplanQualitiesHandler({ engine, libraryDb });

    const request: ReplanRequest = {
      mediaId: "m-1",
      fileId: "f-1",
      addQualities: [],
      removeFormatIds: ["fmt-source"],
    };
    const result = await handler(request);
    console.info(`[${SUITE}:${label}] result: ${JSON.stringify(result)} removed=${JSON.stringify(removed)} submittedCount=${submitted.length}`);

    try {
      expect(result).toEqual({
        addedJobIds: [],
        removedFormatIds: [],
        errorCode: "source-protected",
      });
      expect(removed).toEqual([]);
      expect(submitted).toEqual([]);
    } catch (err) {
      dumpBadgerMediaReplanSnapshot(label, {
        request,
        result,
        errorCode: result.errorCode,
        rows: [sourceRow(), formatRow()],
        removed,
        submitted,
        submittedCount: submitted.length,
        expected: { addedJobIds: [], removedFormatIds: [], errorCode: "source-protected", removed: [], submitted: [] },
        actual: { result, removed, submitted },
        error: err,
      });
      throw err;
    }
  });

  it("returns media-not-found when a removeFormatId is not in the file's set", async () => {
    const label = "refuse-media-not-found-ghost-id";
    console.info(`[${SUITE}:${label}] removing fmt-ghost which is not in the file's format set`);
    const { engine, submitted } = buildEngine();
    const { libraryDb, removed } = buildLibraryDb([sourceRow(), formatRow()]);
    const handler = createBadgerMediaReplanQualitiesHandler({ engine, libraryDb });

    const request: ReplanRequest = {
      mediaId: "m-1",
      fileId: "f-1",
      addQualities: [],
      removeFormatIds: ["fmt-ghost"],
    };
    const result = await handler(request);
    console.info(`[${SUITE}:${label}] result.errorCode=${result.errorCode}`);

    try {
      expect(result.errorCode).toBe("media-not-found");
      expect(removed).toEqual([]);
      expect(submitted).toEqual([]);
    } catch (err) {
      dumpBadgerMediaReplanSnapshot(label, {
        request,
        result,
        errorCode: result.errorCode,
        rows: [sourceRow(), formatRow()],
        removed,
        submitted,
        expected: { errorCode: "media-not-found", removed: [], submitted: [] },
        actual: { errorCode: result.errorCode, removed, submitted },
        error: err,
      });
      throw err;
    }
  });

  it("returns media-not-found when the file has no formats at all", async () => {
    const label = "refuse-media-not-found-empty-rows";
    console.info(`[${SUITE}:${label}] adding 720p against empty format set; expects media-not-found`);
    const { engine, submitted } = buildEngine();
    const { libraryDb, removed } = buildLibraryDb([]);
    const handler = createBadgerMediaReplanQualitiesHandler({ engine, libraryDb });

    const request: ReplanRequest = {
      mediaId: "m-1",
      fileId: "f-1",
      addQualities: ["720p"],
      removeFormatIds: [],
    };
    const result = await handler(request);

    try {
      expect(result.errorCode).toBe("media-not-found");
      expect(removed).toEqual([]);
      expect(submitted).toEqual([]);
    } catch (err) {
      dumpBadgerMediaReplanSnapshot(label, {
        request,
        result,
        errorCode: result.errorCode,
        rows: [],
        removed,
        submitted,
        expected: { errorCode: "media-not-found", removed: [], submitted: [] },
        actual: { errorCode: result.errorCode, removed, submitted },
        error: err,
      });
      throw err;
    }
  });

  it("returns quality-exists when addQualities contains an already-present quality", async () => {
    const label = "refuse-quality-exists";
    console.info(`[${SUITE}:${label}] adding 360p when 360p row already present`);
    const { engine, submitted } = buildEngine();
    const rows = [sourceRow({ quality: "1080p" }), formatRow({ quality: "360p" })];
    const { libraryDb, removed } = buildLibraryDb(rows);
    const handler = createBadgerMediaReplanQualitiesHandler({ engine, libraryDb });

    const request: ReplanRequest = {
      mediaId: "m-1",
      fileId: "f-1",
      addQualities: ["360p"],
      removeFormatIds: [],
    };
    const result = await handler(request);

    try {
      expect(result.errorCode).toBe("quality-exists");
      expect(removed).toEqual([]);
      expect(submitted).toEqual([]);
    } catch (err) {
      dumpBadgerMediaReplanSnapshot(label, {
        request,
        result,
        errorCode: result.errorCode,
        rows,
        removed,
        submitted,
        expected: { errorCode: "quality-exists", removed: [], submitted: [] },
        actual: { errorCode: result.errorCode, removed, submitted },
        error: err,
      });
      throw err;
    }
  });

  it("returns cannot-transcode-up when addQualities is higher resolution than available", async () => {
    const label = "refuse-cannot-transcode-up";
    console.info(`[${SUITE}:${label}] only 360p available; adding 720p; expects cannot-transcode-up`);
    // File has only 360p — user asks for 720p (we can't upscale).
    const { engine, submitted } = buildEngine();
    const rows = [formatRow({ quality: "360p", isSource: true })];
    const { libraryDb, removed } = buildLibraryDb(rows);
    const handler = createBadgerMediaReplanQualitiesHandler({ engine, libraryDb });

    const request: ReplanRequest = {
      mediaId: "m-1",
      fileId: "f-1",
      addQualities: ["720p"],
      removeFormatIds: [],
    };
    const result = await handler(request);

    try {
      expect(result.errorCode).toBe("cannot-transcode-up");
      expect(removed).toEqual([]);
      expect(submitted).toEqual([]);
    } catch (err) {
      dumpBadgerMediaReplanSnapshot(label, {
        request,
        result,
        errorCode: result.errorCode,
        rows,
        removed,
        submitted,
        expected: { errorCode: "cannot-transcode-up", removed: [], submitted: [] },
        actual: { errorCode: result.errorCode, removed, submitted },
        error: err,
      });
      throw err;
    }
  });
});

describe("badger.media.replan_qualities — happy paths", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T00:00:00.000Z"));
  });

  it("submits a format job per addQuality with sourceVariant picked from available formats", async () => {
    const label = "add-picks-source-variant";
    console.info(`[${SUITE}:${label}] adding 240p with [1080p src, 360p fmt]; expects sourceVariant=360p (smallest > target)`);
    const { engine, submitted } = buildEngine();
    const rows = [sourceRow({ quality: "1080p" }), formatRow({ quality: "360p", id: "fmt-360" })];
    const { libraryDb, removed } = buildLibraryDb(rows);
    const handler = createBadgerMediaReplanQualitiesHandler({
      engine,
      libraryDb,
      resolveActiveUserId: () => "user-42",
    });

    const request: ReplanRequest = {
      mediaId: "m-1",
      fileId: "f-1",
      addQualities: ["240p"],
      removeFormatIds: [],
    };
    const result = await handler(request);
    console.info(`[${SUITE}:${label}] result.errorCode=${result.errorCode} addedJobIds.length=${result.addedJobIds.length} submittedCount=${submitted.length}`);

    try {
      expect(result.errorCode).toBeUndefined();
      expect(result.addedJobIds).toHaveLength(1);
      expect(result.addedJobIds[0].variant).toBe("240p");
      expect(result.addedJobIds[0].jobId).toMatch(/^[0-9a-f-]{36}$/i);

      expect(submitted).toHaveLength(1);
      const submittedJob = submitted[0];
      expect(submittedJob.kind).toBe("format");
      expect(submittedJob.lane).toBe("format");
      expect(submittedJob.variant).toBe("240p");
      expect(submittedJob.mediaId).toBe("m-1");
      expect(submittedJob.parentJobIds).toEqual([]);
      expect(submittedJob.payload).toMatchObject({
        userId: "user-42",
        fileId: "f-1",
        targetVariant: "240p",
        // pickReTranscodeSource picks the SMALLEST quality strictly higher
        // than the target. From [1080p, 360p] for target 240p, that's 360p
        // (rank 5 vs target rank 6).
        sourceFormatId: "fmt-360",
        sourceVariant: "360p",
        retranscode: true,
      });
      expect(removed).toEqual([]);
    } catch (err) {
      dumpBadgerMediaReplanSnapshot(label, {
        request,
        result,
        errorCode: result.errorCode,
        rows,
        submitted,
        submittedCount: submitted.length,
        addedJobIds: result.addedJobIds,
        removed,
        expected: {
          errorCode: undefined,
          addedJobIdsCount: 1,
          variant: "240p",
          submittedKind: "format",
          submittedLane: "format",
          submittedMediaId: "m-1",
          sourceFormatId: "fmt-360",
          sourceVariant: "360p",
        },
        actual: { result, submitted },
        error: err,
      });
      throw err;
    }
  });

  it("picks 1080p as source when only 1080p is available and target is 720p", async () => {
    const label = "add-picks-1080-when-only-1080";
    console.info(`[${SUITE}:${label}] adding 720p with [1080p src only]; expects sourceVariant=1080p`);
    const { engine, submitted } = buildEngine();
    const rows = [sourceRow({ quality: "1080p", id: "fmt-1080" })];
    const { libraryDb, removed } = buildLibraryDb(rows);
    const handler = createBadgerMediaReplanQualitiesHandler({ engine, libraryDb });

    const request: ReplanRequest = {
      mediaId: "m-1",
      fileId: "f-1",
      addQualities: ["720p"],
      removeFormatIds: [],
    };
    const result = await handler(request);

    try {
      expect(result.errorCode).toBeUndefined();
      expect(submitted).toHaveLength(1);
      expect(submitted[0].payload).toMatchObject({
        targetVariant: "720p",
        sourceFormatId: "fmt-1080",
        sourceVariant: "1080p",
      });
      expect(removed).toEqual([]);
    } catch (err) {
      dumpBadgerMediaReplanSnapshot(label, {
        request,
        result,
        errorCode: result.errorCode,
        rows,
        submitted,
        submittedCount: submitted.length,
        removed,
        expected: { targetVariant: "720p", sourceFormatId: "fmt-1080", sourceVariant: "1080p" },
        actual: submitted[0]?.payload,
        error: err,
      });
      throw err;
    }
  });

  it("removes each non-source format and returns its id", async () => {
    const label = "remove-multiple-formats";
    console.info(`[${SUITE}:${label}] removing [fmt-360, fmt-720]; expects both removed`);
    const { engine, submitted } = buildEngine();
    const rows = [
      sourceRow({ quality: "1080p" }),
      formatRow({ quality: "360p", id: "fmt-360" }),
      formatRow({ quality: "720p", id: "fmt-720" }),
    ];
    const { libraryDb, removed } = buildLibraryDb(rows);
    const handler = createBadgerMediaReplanQualitiesHandler({ engine, libraryDb });

    const request: ReplanRequest = {
      mediaId: "m-1",
      fileId: "f-1",
      addQualities: [],
      removeFormatIds: ["fmt-360", "fmt-720"],
    };
    const result = await handler(request);

    try {
      expect(result.errorCode).toBeUndefined();
      expect(result.removedFormatIds.sort()).toEqual(["fmt-360", "fmt-720"]);
      expect(removed.sort()).toEqual(["fmt-360", "fmt-720"]);
      expect(submitted).toEqual([]);
    } catch (err) {
      dumpBadgerMediaReplanSnapshot(label, {
        request,
        result,
        errorCode: result.errorCode,
        rows,
        removed,
        removedFormatIds: result.removedFormatIds,
        submitted,
        expected: { errorCode: undefined, removedFormatIds: ["fmt-360", "fmt-720"], removed: ["fmt-360", "fmt-720"], submitted: [] },
        actual: { removedFormatIds: result.removedFormatIds, removed, submitted },
        error: err,
      });
      throw err;
    }
  });

  it("processes mixed add + remove in the same call", async () => {
    const label = "mixed-add-and-remove";
    console.info(`[${SUITE}:${label}] adding 480p and removing fmt-720 in one call`);
    const { engine, submitted } = buildEngine();
    const rows = [
      sourceRow({ quality: "1080p", id: "fmt-1080" }),
      formatRow({ quality: "720p", id: "fmt-720" }),
    ];
    const { libraryDb, removed } = buildLibraryDb(rows);
    const handler = createBadgerMediaReplanQualitiesHandler({ engine, libraryDb });

    const request: ReplanRequest = {
      mediaId: "m-1",
      fileId: "f-1",
      addQualities: ["480p"],
      removeFormatIds: ["fmt-720"],
    };
    const result = await handler(request);

    try {
      expect(result.errorCode).toBeUndefined();
      expect(result.addedJobIds).toHaveLength(1);
      expect(result.addedJobIds[0].variant).toBe("480p");
      expect(result.removedFormatIds).toEqual(["fmt-720"]);
      expect(removed).toEqual(["fmt-720"]);
      expect(submitted).toHaveLength(1);
      // Removing 720p doesn't change the source-pick for the add — the snapshot
      // is read once at the start of the call.
      expect(submitted[0].payload).toMatchObject({
        targetVariant: "480p",
        sourceVariant: "720p",
      });
    } catch (err) {
      dumpBadgerMediaReplanSnapshot(label, {
        request,
        result,
        errorCode: result.errorCode,
        rows,
        addedJobIds: result.addedJobIds,
        removedFormatIds: result.removedFormatIds,
        removed,
        submitted,
        submittedCount: submitted.length,
        expected: {
          addedJobIdsCount: 1,
          addedVariant: "480p",
          removedFormatIds: ["fmt-720"],
          removed: ["fmt-720"],
          payload: { targetVariant: "480p", sourceVariant: "720p" },
        },
        actual: { addedJobIds: result.addedJobIds, removedFormatIds: result.removedFormatIds, removed, payload: submitted[0]?.payload },
        error: err,
      });
      throw err;
    }
  });

  it("stamps the active userId from resolveActiveUserId() onto every submitted job", async () => {
    const label = "stamp-active-user-id";
    console.info(`[${SUITE}:${label}] resolveActiveUserId returns user-xyz; expects both submitted payloads to carry it`);
    const { engine, submitted } = buildEngine();
    const rows = [sourceRow({ quality: "1080p", id: "fmt-1080" })];
    const { libraryDb } = buildLibraryDb(rows);
    const handler = createBadgerMediaReplanQualitiesHandler({
      engine,
      libraryDb,
      resolveActiveUserId: () => "user-xyz",
    });

    const request: ReplanRequest = {
      mediaId: "m-1",
      fileId: "f-1",
      addQualities: ["720p", "480p"],
      removeFormatIds: [],
    };
    await handler(request);

    try {
      expect(submitted).toHaveLength(2);
      expect(submitted[0].payload.userId).toBe("user-xyz");
      expect(submitted[1].payload.userId).toBe("user-xyz");
    } catch (err) {
      dumpBadgerMediaReplanSnapshot(label, {
        request,
        rows,
        submitted,
        submittedCount: submitted.length,
        expected: { submittedCount: 2, userIds: ["user-xyz", "user-xyz"] },
        actual: { submittedCount: submitted.length, userIds: submitted.map((s) => s.payload.userId) },
        error: err,
      });
      throw err;
    }
  });
});

describe("badger.media.replan_qualities — atomic refusal", () => {
  it("does NOT mutate when validation fails late in the input list", async () => {
    const label = "atomic-refusal-late-invalid-remove";
    console.info(`[${SUITE}:${label}] removeFormatIds=[fmt-360 (valid), fmt-source (invalid)]; expects no mutation`);
    // Removes [fmt-360 (valid), fmt-source (source-protected)] should both
    // be refused atomically — the valid removal must NOT happen because
    // the second one is invalid.
    const { engine, submitted } = buildEngine();
    const rows = [sourceRow({ quality: "1080p" }), formatRow({ quality: "360p", id: "fmt-360" })];
    const { libraryDb, removed } = buildLibraryDb(rows);
    const handler = createBadgerMediaReplanQualitiesHandler({ engine, libraryDb });

    const request: ReplanRequest = {
      mediaId: "m-1",
      fileId: "f-1",
      addQualities: [],
      removeFormatIds: ["fmt-360", "fmt-source"],
    };
    const result = await handler(request);

    try {
      expect(result.errorCode).toBe("source-protected");
      expect(removed).toEqual([]);
      expect(submitted).toEqual([]);
    } catch (err) {
      dumpBadgerMediaReplanSnapshot(label, {
        request,
        result,
        errorCode: result.errorCode,
        rows,
        removed,
        submitted,
        expected: { errorCode: "source-protected", removed: [], submitted: [] },
        actual: { errorCode: result.errorCode, removed, submitted },
        error: err,
      });
      throw err;
    }
  });

  it("does NOT submit any job when one of N adds is invalid", async () => {
    const label = "atomic-refusal-mixed-adds";
    console.info(`[${SUITE}:${label}] addQualities=[240p (valid), 360p (already present)]; expects no submission`);
    // Adds [240p (valid), 360p (already present)] — refuse atomically.
    const { engine, submitted } = buildEngine();
    const rows = [sourceRow({ quality: "1080p" }), formatRow({ quality: "360p" })];
    const { libraryDb } = buildLibraryDb(rows);
    const handler = createBadgerMediaReplanQualitiesHandler({ engine, libraryDb });

    const request: ReplanRequest = {
      mediaId: "m-1",
      fileId: "f-1",
      addQualities: ["240p", "360p"],
      removeFormatIds: [],
    };
    const result = await handler(request);

    try {
      expect(result.errorCode).toBe("quality-exists");
      expect(submitted).toEqual([]);
    } catch (err) {
      dumpBadgerMediaReplanSnapshot(label, {
        request,
        result,
        errorCode: result.errorCode,
        rows,
        submitted,
        expected: { errorCode: "quality-exists", submitted: [] },
        actual: { errorCode: result.errorCode, submitted },
        error: err,
      });
      throw err;
    }
  });
});

describe("badger.media.replan_qualities — Phase 5 storage delete", () => {
  it("forwards every initKey + chunk key to storage delete before dropping the library row", async () => {
    const label = "storage-delete-forwards-all-keys";
    console.info(`[${SUITE}:${label}] removing fmt-360 with init+3 chunks; expects all keys forwarded to deleteStorageKeys then library row removed`);
    const { engine, submitted } = buildEngine();
    const rows = [
      sourceRow({ id: "fmt-1080" }),
      formatRow({
        id: "fmt-360",
        initKey: "INIT-360",
        chunks: [
          { key: "CHUNK-360-1", sizeBytes: 100 },
          { key: "CHUNK-360-2", sizeBytes: 100 },
          { key: "CHUNK-360-3", sizeBytes: 100 },
        ],
      }),
    ];
    const { libraryDb, removed, calls } = buildLibraryDb(rows);

    const deleteCalls: string[][] = [];
    const handler = createBadgerMediaReplanQualitiesHandler({
      engine,
      libraryDb,
      deleteStorageKeys: async (keys) => {
        deleteCalls.push([...keys]);
        return { deleted: keys.length, reclaimedBytes: keys.length * 100 };
      },
    });

    const request: ReplanRequest = {
      mediaId: "m-1",
      fileId: "f-1",
      addQualities: [],
      removeFormatIds: ["fmt-360"],
    };
    const result = await handler(request);
    const callOrder = calls.map((c) => c.method);
    console.info(`[${SUITE}:${label}] result.errorCode=${result.errorCode} deleteCalls.length=${deleteCalls.length} callOrder=${JSON.stringify(callOrder)}`);

    try {
      expect(result.errorCode).toBeUndefined();
      expect(result.removedFormatIds).toEqual(["fmt-360"]);

      // Storage delete was called exactly once with all keys for fmt-360.
      expect(deleteCalls).toHaveLength(1);
      expect(deleteCalls[0].sort()).toEqual(
        ["CHUNK-360-1", "CHUNK-360-2", "CHUNK-360-3", "INIT-360"].sort()
      );

      // Library row removal ran AFTER storage delete.
      expect(removed).toEqual(["fmt-360"]);
      // listMediaFormats reads first, then removeMediaFormat writes.
      expect(callOrder).toEqual(["listMediaFormats", "removeMediaFormat"]);

      expect(submitted).toEqual([]);
    } catch (err) {
      dumpBadgerMediaReplanSnapshot(label, {
        request,
        result,
        errorCode: result.errorCode,
        rows,
        removed,
        removedFormatIds: result.removedFormatIds,
        deleteCalls,
        libraryDbCalls: calls,
        libraryDbCallOrder: callOrder,
        submitted,
        expected: {
          errorCode: undefined,
          removedFormatIds: ["fmt-360"],
          deleteCallsLength: 1,
          deleteCallKeysSorted: ["CHUNK-360-1", "CHUNK-360-2", "CHUNK-360-3", "INIT-360"],
          removed: ["fmt-360"],
          callOrder: ["listMediaFormats", "removeMediaFormat"],
          submitted: [],
        },
        actual: {
          errorCode: result.errorCode,
          removedFormatIds: result.removedFormatIds,
          deleteCallsLength: deleteCalls.length,
          deleteCallKeysSorted: deleteCalls[0]?.slice().sort(),
          removed,
          callOrder,
          submitted,
        },
        error: err,
      });
      throw err;
    }
  });

  it("leaves the library row in place when storage delete throws (fail-loud)", async () => {
    const label = "storage-delete-throws-no-mutation";
    console.info(`[${SUITE}:${label}] deleteStorageKeys throws "storage unreachable"; expects no library mutation`);
    const { engine, submitted } = buildEngine();
    const rows = [sourceRow({ id: "fmt-1080" }), formatRow({ id: "fmt-360" })];
    const { libraryDb, removed } = buildLibraryDb(rows);

    const storageError = new Error("storage unreachable");
    const handler = createBadgerMediaReplanQualitiesHandler({
      engine,
      libraryDb,
      deleteStorageKeys: async () => {
        throw storageError;
      },
    });

    const request: ReplanRequest = {
      mediaId: "m-1",
      fileId: "f-1",
      addQualities: [],
      removeFormatIds: ["fmt-360"],
    };
    try {
      await expect(handler(request)).rejects.toThrow("storage unreachable");

      // Critical invariant: no library mutation. The user retries and the
      // format row is still there to remove.
      expect(removed).toEqual([]);
      expect(submitted).toEqual([]);
    } catch (err) {
      dumpBadgerMediaReplanSnapshot(label, {
        request,
        rows,
        removed,
        submitted,
        expected: { throwsWith: "storage unreachable", removed: [], submitted: [] },
        actual: { removed, submitted },
        error: err,
      });
      throw err;
    }
  });

  it("skips storage delete when no keys are present on the format", async () => {
    const label = "storage-delete-skipped-when-no-keys";
    console.info(`[${SUITE}:${label}] format has initKey=null and no chunks; deleteStorageKeys must NOT be called`);
    const { engine } = buildEngine();
    const rows = [
      sourceRow({ id: "fmt-1080" }),
      formatRow({ id: "fmt-empty", initKey: null, chunks: [] }),
    ];
    const { libraryDb, removed } = buildLibraryDb(rows);

    const deleteCalls: string[][] = [];
    const handler = createBadgerMediaReplanQualitiesHandler({
      engine,
      libraryDb,
      deleteStorageKeys: async (keys) => {
        deleteCalls.push([...keys]);
        return { deleted: 0, reclaimedBytes: 0 };
      },
    });

    const request: ReplanRequest = {
      mediaId: "m-1",
      fileId: "f-1",
      addQualities: [],
      removeFormatIds: ["fmt-empty"],
    };
    const result = await handler(request);

    try {
      expect(result.errorCode).toBeUndefined();
      expect(deleteCalls).toEqual([]);
      expect(removed).toEqual(["fmt-empty"]);
    } catch (err) {
      dumpBadgerMediaReplanSnapshot(label, {
        request,
        result,
        errorCode: result.errorCode,
        rows,
        removed,
        deleteCalls,
        expected: { errorCode: undefined, deleteCalls: [], removed: ["fmt-empty"] },
        actual: { errorCode: result.errorCode, deleteCalls, removed },
        error: err,
      });
      throw err;
    }
  });

  it("proceeds without storage delete when no deleteStorageKeys is wired (GC fallback)", async () => {
    const label = "storage-delete-omitted-gc-fallback";
    console.info(`[${SUITE}:${label}] deleteStorageKeys deliberately omitted; expects library-only delete (GC fallback)`);
    const { engine } = buildEngine();
    const rows = [sourceRow({ id: "fmt-1080" }), formatRow({ id: "fmt-360" })];
    const { libraryDb, removed } = buildLibraryDb(rows);

    const handler = createBadgerMediaReplanQualitiesHandler({
      engine,
      libraryDb,
      // deleteStorageKeys deliberately omitted — handler falls back to
      // library-only delete (chunks reclaimed by storage GC).
    });

    const request: ReplanRequest = {
      mediaId: "m-1",
      fileId: "f-1",
      addQualities: [],
      removeFormatIds: ["fmt-360"],
    };
    const result = await handler(request);

    try {
      expect(result.errorCode).toBeUndefined();
      expect(removed).toEqual(["fmt-360"]);
    } catch (err) {
      dumpBadgerMediaReplanSnapshot(label, {
        request,
        result,
        errorCode: result.errorCode,
        rows,
        removed,
        expected: { errorCode: undefined, removed: ["fmt-360"] },
        actual: { errorCode: result.errorCode, removed },
        error: err,
      });
      throw err;
    }
  });
});

describe("badger.media.replan_qualities — idempotency", () => {
  it("second call with a removed id returns media-not-found cleanly", async () => {
    const label = "idempotency-repeat-remove";
    console.info(`[${SUITE}:${label}] round 1: remove fmt-360 from [1080p src, 360p fmt]`);
    // Round 1: remove fmt-360 succeeds.
    const { engine: e1 } = buildEngine();
    const round1Rows = [sourceRow({ quality: "1080p" }), formatRow({ quality: "360p", id: "fmt-360" })];
    const { libraryDb: db1 } = buildLibraryDb(round1Rows);
    const handler1 = createBadgerMediaReplanQualitiesHandler({
      engine: e1,
      libraryDb: db1,
    });
    const request1: ReplanRequest = {
      mediaId: "m-1",
      fileId: "f-1",
      addQualities: [],
      removeFormatIds: ["fmt-360"],
    };
    const r1 = await handler1(request1);
    try {
      expect(r1.removedFormatIds).toEqual(["fmt-360"]);
    } catch (err) {
      dumpBadgerMediaReplanSnapshot(`${label}-round1`, {
        request: request1,
        result: r1,
        rows: round1Rows,
        expected: { removedFormatIds: ["fmt-360"] },
        actual: { removedFormatIds: r1.removedFormatIds },
        error: err,
      });
      throw err;
    }

    console.info(`[${SUITE}:${label}] round 2: same call against post-mutation state (only source row remains); expects media-not-found`);
    // Round 2: same call against the post-mutation state — only the source
    // row remains. The repeat returns media-not-found, no submit / no remove.
    const { engine: e2, submitted: submitted2 } = buildEngine();
    const round2Rows = [sourceRow({ quality: "1080p" })];
    const { libraryDb: db2, removed: removed2 } = buildLibraryDb(round2Rows);
    const handler2 = createBadgerMediaReplanQualitiesHandler({
      engine: e2,
      libraryDb: db2,
    });
    const request2: ReplanRequest = {
      mediaId: "m-1",
      fileId: "f-1",
      addQualities: [],
      removeFormatIds: ["fmt-360"],
    };
    const r2 = await handler2(request2);
    try {
      expect(r2.errorCode).toBe("media-not-found");
      expect(removed2).toEqual([]);
      expect(submitted2).toEqual([]);
    } catch (err) {
      dumpBadgerMediaReplanSnapshot(`${label}-round2`, {
        request: request2,
        result: r2,
        errorCode: r2.errorCode,
        rows: round2Rows,
        removed: removed2,
        submitted: submitted2,
        expected: { errorCode: "media-not-found", removed: [], submitted: [] },
        actual: { errorCode: r2.errorCode, removed: removed2, submitted: submitted2 },
        error: err,
      });
      throw err;
    }
  });
});

// #145: a retranscoded quality joins the silo the file's objects live on.
describe("badger.media.replan_qualities — per-media placement (#145)", () => {
  const replanAdd720 = async (rows: MediaFormatRow[]) => {
    const { engine, submitted } = buildEngine();
    const { libraryDb } = buildLibraryDb(rows);
    const handler = createBadgerMediaReplanQualitiesHandler({ engine, libraryDb });
    const result = await handler({ mediaId: "m-1", fileId: "f-1", addQualities: ["720p"], removeFormatIds: [] });
    return { result, submitted };
  };

  it("stamps the placementId parsed from the file's existing keys on the retranscode job", async () => {
    const { result, submitted } = await replanAdd720([
      sourceRow({ initKey: null, chunks: [{ key: "media/placement-file-1/src-1", sizeBytes: 100 }] }),
      // A sibling file of the same media on another silo must not be picked.
      formatRow({ fileId: "f-2", initKey: "media/placement-sibling/init", chunks: [] }),
    ]);
    console.info(
      `[${SUITE}:placement-reuse] errorCode=${result.errorCode} payloads=${JSON.stringify(submitted.map((j) => j.payload.placementId))}`
    );
    expect(result.errorCode).toBeUndefined();
    expect(submitted).toHaveLength(1);
    expect(submitted[0].payload.placementId).toBe("placement-file-1");
  });

  it("legacy (non-media) keys → a fresh valid placementId", async () => {
    const { submitted } = await replanAdd720([sourceRow()]);
    const placementId = submitted[0]?.payload.placementId;
    console.info(`[${SUITE}:placement-fresh] placementId=${String(placementId)}`);
    expect(typeof placementId).toBe("string");
    expect(placementId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });
});
