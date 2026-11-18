/**
 * @bugfix existing-media-source-not-flagged
 * @regression-proof
 *
 * Regression coverage for the defensive implicit-source guard in
 * `badger.media.replan_qualities` (mediaReplan.ts).
 *
 * Pre-fix condition: legacy / pre-Phase-2 media — and any formats re-applied
 * from v1 op-stream entries — can have NO `is_source = 1` row at all. The
 * handler's only remove-guard was `if (row.isSource) refuse("source-protected")`,
 * which is inert when nothing is flagged. So a user could delete the
 * highest/only quality of an existing media item and orphan it.
 *
 * Post-fix: when no format on the file is explicitly flagged is_source, the
 * highest available resolution (lowest QUALITY_ORDER index, lowest id on a
 * tie) is treated as the de-facto source and is delete-protected. Lower
 * qualities remain freely deletable. An explicit flag, when present, still
 * wins and the implicit fallback does not engage.
 *
 * Strategy mirrors badger-media-replan.test.ts: stub EngineV2 + the libraryDb
 * `call` seam; no SQLite. The handler is pure orchestration.
 */
import { describe, expect, it, vi } from "vitest";
import type { EngineV2 } from "../src/core/jobs/engineV2";
import type { BadgerLibraryDbService } from "../src/modules/badgerLibraryDb";
import { createBadgerMediaReplanQualitiesHandler } from "../src/modules/badger/mediaReplan";
import type { BadgerMediaReplanQualitiesPayload } from "@space/runtime-contracts/badger/ingest";
import type { IngestJobRecord } from "@space/runtime-jobs";

const SUITE = "badger-media-replan-implicit-source";

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

const dumpSnapshot = (label: string, ctx: Record<string, unknown>) => {
  try {
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    for (const [key, value] of Object.entries(ctx)) {
      console.error(`${key}:\n${JSON.stringify(value, null, 2)}`);
    }
    console.error(`=== [${SUITE}:${label}] end ===`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
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
  const libraryDb = {
    call: vi.fn(async (method: string, args: unknown[] = []) => {
      if (method === "listMediaFormats") return rows;
      if (method === "removeMediaFormat") {
        removed.push(args[0] as string);
        return null;
      }
      throw new Error(`unexpected libraryDb.call: ${method}`);
    }),
  } as unknown as BadgerLibraryDbService;
  return { libraryDb, removed };
};

const row = (overrides: Partial<MediaFormatRow> = {}): MediaFormatRow => ({
  id: "fmt-x",
  mediaId: "m-1",
  fileId: "f-1",
  quality: "360p",
  codec: "h264",
  isSource: false,
  initKey: "fmt-x-init.key",
  chunks: [{ key: "fmt-x-chunk-1", sizeBytes: 50 }],
  ...overrides,
});

const req = (removeFormatIds: string[]): BadgerMediaReplanQualitiesPayload => ({
  mediaId: "m-1",
  fileId: "f-1",
  addQualities: [],
  removeFormatIds,
});

describe("@bugfix @regression-proof badger.media.replan_qualities — implicit-source protection", () => {
  it("refuses to delete the highest quality when NO format is flagged is_source (legacy media)", async () => {
    const label = "implicit-highest-protected";
    // Pre-Phase-2 fixture: 360p + 1080p, BOTH is_source=0 (the bug shape).
    const rows = [
      row({ id: "fmt-360", quality: "360p", isSource: false }),
      row({ id: "fmt-1080", quality: "1080p", isSource: false }),
    ];
    console.info(`[${SUITE}:${label}] removing highest (fmt-1080) with zero flagged sources; expect source-protected`);
    const { engine, submitted } = buildEngine();
    const { libraryDb, removed } = buildLibraryDb(rows);
    const handler = createBadgerMediaReplanQualitiesHandler({ engine, libraryDb });

    const result = await handler(req(["fmt-1080"]));
    console.info(`[${SUITE}:${label}] result=${JSON.stringify(result)} removed=${JSON.stringify(removed)}`);

    try {
      expect(result.errorCode).toBe("source-protected");
      expect(result.removedFormatIds).toEqual([]);
      expect(removed).toEqual([]); // pre-fix: ["fmt-1080"] — the orphaning delete
      expect(submitted).toEqual([]);
    } catch (err) {
      dumpSnapshot(label, { rows, result, removed, expected: "source-protected, nothing removed" });
      throw err;
    }
  });

  it("ALLOWS deleting a lower quality when no source is flagged (only the highest is implicitly protected)", async () => {
    const label = "implicit-lower-deletable";
    const rows = [
      row({ id: "fmt-360", quality: "360p", isSource: false }),
      row({ id: "fmt-1080", quality: "1080p", isSource: false }),
    ];
    console.info(`[${SUITE}:${label}] removing lower (fmt-360); expect success, fmt-360 removed`);
    const { engine } = buildEngine();
    const { libraryDb, removed } = buildLibraryDb(rows);
    const handler = createBadgerMediaReplanQualitiesHandler({ engine, libraryDb });

    const result = await handler(req(["fmt-360"]));
    console.info(`[${SUITE}:${label}] result=${JSON.stringify(result)} removed=${JSON.stringify(removed)}`);

    try {
      expect(result.errorCode).toBeUndefined();
      expect(result.removedFormatIds).toEqual(["fmt-360"]);
      expect(removed).toEqual(["fmt-360"]);
    } catch (err) {
      dumpSnapshot(label, { rows, result, removed, expected: "no errorCode, fmt-360 removed" });
      throw err;
    }
  });

  it("does NOT engage the implicit fallback when an explicit source is flagged (existing behavior preserved)", async () => {
    const label = "explicit-source-wins";
    // Explicit source on 1080p; removing the lower 360p must succeed.
    const rows = [
      row({ id: "fmt-360", quality: "360p", isSource: false }),
      row({ id: "fmt-1080", quality: "1080p", isSource: true }),
    ];
    console.info(`[${SUITE}:${label}] explicit source on fmt-1080; removing fmt-360 should succeed`);
    const { engine } = buildEngine();
    const { libraryDb, removed } = buildLibraryDb(rows);
    const handler = createBadgerMediaReplanQualitiesHandler({ engine, libraryDb });

    const result = await handler(req(["fmt-360"]));
    console.info(`[${SUITE}:${label}] result=${JSON.stringify(result)} removed=${JSON.stringify(removed)}`);

    try {
      expect(result.errorCode).toBeUndefined();
      expect(removed).toEqual(["fmt-360"]);
    } catch (err) {
      dumpSnapshot(label, { rows, result, removed });
      throw err;
    }
  });

  it("still refuses the EXPLICIT source row when one is flagged (no behavior change)", async () => {
    const label = "explicit-source-still-protected";
    const rows = [
      row({ id: "fmt-360", quality: "360p", isSource: false }),
      row({ id: "fmt-1080", quality: "1080p", isSource: true }),
    ];
    console.info(`[${SUITE}:${label}] removing flagged source fmt-1080; expect source-protected`);
    const { engine } = buildEngine();
    const { libraryDb, removed } = buildLibraryDb(rows);
    const handler = createBadgerMediaReplanQualitiesHandler({ engine, libraryDb });

    const result = await handler(req(["fmt-1080"]));
    console.info(`[${SUITE}:${label}] result=${JSON.stringify(result)} removed=${JSON.stringify(removed)}`);

    try {
      expect(result.errorCode).toBe("source-protected");
      expect(removed).toEqual([]);
    } catch (err) {
      dumpSnapshot(label, { rows, result, removed });
      throw err;
    }
  });

  it("on a same-resolution tie with no flag, protects the lowest-id row and lets the duplicate be deleted", async () => {
    const label = "tie-lowest-id-protected";
    // Two 1080p rows, neither flagged. implicitSourceId = lowest id = fmt-a.
    const rows = [
      row({ id: "fmt-a", quality: "1080p", isSource: false }),
      row({ id: "fmt-b", quality: "1080p", isSource: false }),
    ];
    console.info(`[${SUITE}:${label}] tie 1080p (fmt-a,fmt-b); fmt-a protected, fmt-b deletable`);
    const { engine } = buildEngine();

    // Removing fmt-a (lowest id) → refused.
    const a = buildLibraryDb(rows);
    const handlerA = createBadgerMediaReplanQualitiesHandler({ engine, libraryDb: a.libraryDb });
    const resultA = await handlerA(req(["fmt-a"]));
    console.info(`[${SUITE}:${label}] remove fmt-a result=${JSON.stringify(resultA)} removed=${JSON.stringify(a.removed)}`);

    // Removing fmt-b (the duplicate) → allowed.
    const b = buildLibraryDb(rows);
    const handlerB = createBadgerMediaReplanQualitiesHandler({ engine, libraryDb: b.libraryDb });
    const resultB = await handlerB(req(["fmt-b"]));
    console.info(`[${SUITE}:${label}] remove fmt-b result=${JSON.stringify(resultB)} removed=${JSON.stringify(b.removed)}`);

    try {
      expect(resultA.errorCode).toBe("source-protected");
      expect(a.removed).toEqual([]);
      expect(resultB.errorCode).toBeUndefined();
      expect(b.removed).toEqual(["fmt-b"]);
    } catch (err) {
      dumpSnapshot(label, { rows, resultA, removedA: a.removed, resultB, removedB: b.removed });
      throw err;
    }
  });
});
