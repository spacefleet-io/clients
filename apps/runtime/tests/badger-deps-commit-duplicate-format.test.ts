/**
 * @test-id RUNTIME-BADGER-COMMIT-DUPLICATE-FORMAT-001
 * @level unit
 * @bugfix @regression-proof
 * @why #2438: "Delete from library" left two uploaded objects on the server. They were never the media's: a
 *      360p source got a 360p fallback format job too. Its encode was uploaded, then its commit found the file
 *      already had a 360p row and reused that row, leaving the duplicate's init and chunks to the 7-day storage
 *      GC (STOR-PLACE-06). No library row named them, so deleting the media could not free them, and they
 *      counted against the user's space until the GC ran.
 *        1. A format commit that reuses an existing row releases the duplicate's uploaded keys at once.
 *        2. A retried commit whose keys ARE the committed row's releases nothing (data safety).
 *        3. A commit that adds a new row releases nothing.
 * @covers apps/runtime/src/modules/badger/steps/deps-adapter.ts: commit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProducedMedia } from "@space/ingest-core/mediaProcessor";
import type { BadgerLibraryDbService } from "../src/modules/badgerLibraryDb";
import { __resetBadgerStepDepsAdapter, buildBadgerStepDeps } from "../src/modules/badger/steps/deps-adapter";

const SUITE = "badger-deps-commit-duplicate-format";
const TEST_ID = "RUNTIME-BADGER-COMMIT-DUPLICATE-FORMAT-001";
const PLACEMENT = "0123456789abcdef0123456789abcdef";

const format = (quality: string, tag: string): ProducedMedia["videoFormats"][number] => ({
  quality,
  codec: "h264",
  codecString: "avc1.64001e",
  initKey: `media/${PLACEMENT}/init-${tag}`,
  initSize: 900,
  durationSeconds: 6,
  totalSize: 10_000,
  chunks: [{ key: `media/${PLACEMENT}/seg-${tag}`, sizeBytes: 9_100, startSeconds: 0 }],
});

/** The committed 360p source row of file-1 (the one the library serves). */
const committed = format("360p", "source");

const setup = () => {
  const released: string[][] = [];
  const addedFormats: unknown[][] = [];
  const libraryDb = {
    call: vi.fn(async (method: string, args: unknown[] = []) => {
      if (method === "listMediaFormats") return [{ id: "fmt-source", fileId: "file-1", quality: "360p" }];
      if (method === "getMediaObjectKeys") return [committed.initKey, ...committed.chunks.map((c) => c.key)];
      if (method === "addMediaFormat") {
        addedFormats.push(args);
        return "fmt-new";
      }
      return null;
    }),
  } as unknown as BadgerLibraryDbService;
  const deps = buildBadgerStepDeps({
    libraryDb,
    processMediaJob: async () => {
      throw new Error("processMediaJob must not run in this suite");
    },
    resolveToken: () => "tok",
    resolveLibraryKey: () => "lk",
    resolveActiveUserId: () => "u1",
    deleteStorageKeys: async (_token, keys) => {
      released.push([...keys]);
      return { deleted: keys.length, reclaimedBytes: 0 };
    },
  });
  const commitFormat = (videoFormats: ProducedMedia["videoFormats"]) =>
    deps.commit({
      userId: "u1",
      jobId: "fmt-job-1",
      mediaId: "m1",
      filename: "/media/Movie.mp4",
      scope: "format",
      variant: "360p",
      sourceFileId: "file-1",
      produced: { videoFormats, audioTracks: [], subtitleTracks: [] },
      signal: new AbortController().signal,
    } as Parameters<typeof deps.commit>[0]);
  return { released, addedFormats, commitFormat };
};

beforeEach(() => __resetBadgerStepDepsAdapter());
afterEach(() => {
  __resetBadgerStepDepsAdapter();
  vi.restoreAllMocks();
});

describe(`${SUITE} @bugfix @regression-proof`, () => {
  it("@req STOR-PLACE-06 a format commit that reuses the existing row releases the duplicate's uploads", async () => {
    console.info(`[${TEST_ID}] phase=commit-duplicate`);
    const { released, addedFormats, commitFormat } = setup();
    const duplicate = format("360p", "fallback");
    const result = await commitFormat([duplicate]);
    expect(result.formatIds).toEqual(["fmt-source"]);
    expect(addedFormats).toEqual([]);
    expect(released.flat().sort()).toEqual([duplicate.initKey, ...duplicate.chunks.map((c) => c.key)].sort());
  });

  it("@req STOR-PLACE-06 a retried commit whose keys are the committed row's releases nothing", async () => {
    console.info(`[${TEST_ID}] phase=commit-retry`);
    const { released, commitFormat } = setup();
    const result = await commitFormat([committed]);
    expect(result.formatIds).toEqual(["fmt-source"]);
    expect(released.flat()).toEqual([]);
  });

  it("@req STOR-PLACE-06 a format commit that adds a new row releases nothing", async () => {
    console.info(`[${TEST_ID}] phase=commit-new`);
    const { released, addedFormats, commitFormat } = setup();
    const result = await commitFormat([format("240p", "fallback")]);
    expect(result.formatIds).toEqual(["fmt-new"]);
    expect(addedFormats).toHaveLength(1);
    expect(released.flat()).toEqual([]);
  });
});
