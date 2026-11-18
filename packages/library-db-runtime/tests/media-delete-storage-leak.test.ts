/**
 * @bugfix
 * @regression-proof
 *
 * Regression tests for findings F1 (delete leak) and F1-cycle (repeat-ingest
 * accumulation) of the storage-tracker-refactor.
 *
 * Behavior pinned (Layer 1 of the plan):
 *   When a media item is deleted from the library, the chunk keys it owned
 *   (mediaFormatChunks, mediaAudioChunks, mediaSubtitles.objectKey, plus any
 *   format/audio initKeys) MUST be forwarded to the API's /storage/delete
 *   endpoint so quota is reclaimed and the chunks are removed from gateway storage.
 *
 * Why this fails today (HEAD):
 *   - libraryDb.deleteMedia() calls deleteMediaInternal() which wipes the
 *     SQLite rows but never gathers the chunk keys to forward to the API.
 *     See packages/library-db-runtime/src/libraryDb.ts:5176-5221, 5933-5948.
 *   - Repeating ingest+delete N times leaks N times the byte total, which
 *     is the root cause of the 30GB-on-one-movie production symptom (F1).
 *
 * Both tests stub global fetch and assert that a POST to /storage/delete
 * carrying the chunk keys is made before / during deleteMedia returns.
 *
 * Lives in library-db-runtime and runs under `bun test` (Issue #25): it used
 * to sit in apps/runtime's vitest (Node) suite, where bun:sqlite is absent and
 * db.ts falls back to better-sqlite3 — not a dependency of this package or of
 * apps/runtime, and an Electron-ABI binary anyway — so it failed with
 * "Cannot find module 'better-sqlite3'" on every fresh install. The runtime
 * opens LibraryDb under Bun (bun:sqlite); this runner matches production.
 *
 * @test-id STORAGE-DELETE-LEAK-001
 * @test-id STORAGE-DELETE-LEAK-002
 * @level integration
 * @covers packages/library-db-runtime/src/libraryDb.ts deleteMedia
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { LibraryDb } from "../src/libraryDb";

let root = "";

type CapturedFetch = {
  url: string;
  method: string;
  body: unknown;
};

let capturedFetches: CapturedFetch[] = [];
let originalFetch: typeof globalThis.fetch | null = null;

const installFetchRecorder = () => {
  capturedFetches = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    // The SDK calls fetch(Request); the storage tunnel still calls fetch(url, init).
    const url = input instanceof Request ? input.url : input.toString();
    const method = (input instanceof Request ? input.method : (init?.method ?? "GET")).toUpperCase();
    const rawBody: BodyInit | null | undefined = input instanceof Request ? await input.clone().text() : init?.body;
    let body: unknown = null;
    if (rawBody) {
      try {
        body = JSON.parse(String(rawBody));
      } catch {
        body = rawBody;
      }
    }
    capturedFetches.push({ url, method, body });
    return new Response(JSON.stringify({ deleted: 0 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
};

const restoreFetch = () => {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = null;
  }
};

const fetchesMatchingStorageDelete = () =>
  capturedFetches.filter(
    (entry) =>
      entry.method === "POST" && /\/storage\/delete(\?|$)/.test(entry.url)
  );

const collectKeysFromStorageDeleteCalls = () => {
  const keys: string[] = [];
  for (const entry of fetchesMatchingStorageDelete()) {
    const body = entry.body as { keys?: unknown } | null;
    const arr = Array.isArray(body?.keys) ? (body!.keys as unknown[]) : [];
    for (const key of arr) {
      if (typeof key === "string" && key.length > 0) keys.push(key);
    }
  }
  return keys;
};

// ---------------------------------------------------------------------------
// Diagnostic snapshot — dumps captured fetches + DB snapshot on assertion
// failure. Wrapped in try/catch so the dump itself cannot mask the original.
// ---------------------------------------------------------------------------
const dumpMediaDeleteSnapshot = (
  label: string,
  ctx: {
    db?: LibraryDb | null;
    expectedKeys?: string[];
    observedKeys?: string[];
    missing?: string[];
    cycle?: number;
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [badger-media-delete-storage-leak:${label}] snapshot ===`);
    if (ctx.cycle !== undefined) console.error(`cycle=${ctx.cycle}`);
    console.error(
      `capturedFetches (${capturedFetches.length})=\n${JSON.stringify(
        capturedFetches.map((f) => ({
          url: f.url,
          method: f.method,
          keys:
            (f.body as { keys?: unknown[] } | null)?.keys ??
            "(no keys field)",
        })),
        null,
        2,
      )}`,
    );
    const storageDeletes = fetchesMatchingStorageDelete();
    console.error(`fetchesMatchingStorageDelete=${storageDeletes.length}`);
    if (ctx.expectedKeys) {
      console.error(
        `expectedKeys (${ctx.expectedKeys.length})=\n${JSON.stringify(ctx.expectedKeys, null, 2)}`,
      );
    }
    if (ctx.observedKeys) {
      console.error(
        `observedKeys (${ctx.observedKeys.length})=\n${JSON.stringify(ctx.observedKeys, null, 2)}`,
      );
    }
    if (ctx.missing) {
      console.error(`missing (${ctx.missing.length})=\n${JSON.stringify(ctx.missing, null, 2)}`);
    }
    if (ctx.db) {
      try {
        const snapshot = ctx.db.getSnapshot();
        console.error(
          `db.snapshot.media.length=${snapshot.media.length} ids=${JSON.stringify(snapshot.media.map((m: { id: string }) => m.id))}`,
        );
      } catch (err) {
        console.error(
          `(db.getSnapshot failed: ${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }
    if (ctx.extra) {
      console.error(`extra=\n${JSON.stringify(ctx.extra, null, 2)}`);
    }
  } catch (err) {
    console.error(
      `(snapshot failed: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-media-delete-leak-"));
  process.env.SF_USER_DATA_PATH = root;
  installFetchRecorder();
  console.info(
    `[badger-media-delete-storage-leak:setup] root=${root} fetch recorder installed`,
  );
});

afterEach(() => {
  console.info(`[badger-media-delete-storage-leak:teardown] restoring fetch + cleaning root`);
  restoreFetch();
  rmSync(root, { recursive: true, force: true });
  delete process.env.SF_USER_DATA_PATH;
});

const seedMovieWithChunks = async (
  db: LibraryDb,
  options: { catalogId: number; title: string; chunkPrefix: string }
) => {
  const mediaId = await (db as any).addMediaFromCatalog({
    id: options.catalogId,
    type: "movie",
    title: options.title,
    originalTitle: null,
    originalLanguage: "en",
    overview: null,
    year: "2026",
    rating: null,
    posterPath: null,
    backdropPath: null,
    genres: [],
    cast: [],
    trailers: [],
    seasons: [],
    episodes: [],
    totalEpisodes: 0,
  });

  const fileId = await (db as any).linkFileToMedia(
    mediaId,
    `${options.chunkPrefix}.mkv`
  );

  // Video format with 3 chunks + an init key (mimics what an ingest
  // commit step writes — see packages/ingest-core/src/mediaFinalize.ts).
  await db.addMediaFormat(
    mediaId,
    fileId,
    "1080p",
    "h264",
    1024,
    [
      { key: `${options.chunkPrefix}/v/chunk-1`, sizeBytes: 1_000_000 },
      { key: `${options.chunkPrefix}/v/chunk-2`, sizeBytes: 1_000_000 },
      { key: `${options.chunkPrefix}/v/chunk-3`, sizeBytes: 1_000_000 },
    ],
    8000,
    {
      initKey: `${options.chunkPrefix}/v/init`,
      initSize: 4000,
      durationSeconds: 90,
      totalSize: 3_004_000,
    }
  );

  // Audio track with 2 chunks + init key.
  await (db as any).addAudioTrackWithChunks({
    mediaId,
    fileId,
    season: null,
    episode: null,
    language: "en",
    label: "English",
    codec: "aac",
    initKey: `${options.chunkPrefix}/a/init`,
    initSize: 1000,
    durationSeconds: 90,
    totalSize: 200_000,
    chunks: [
      { key: `${options.chunkPrefix}/a/chunk-1`, sizeBytes: 100_000 },
      { key: `${options.chunkPrefix}/a/chunk-2`, sizeBytes: 100_000 },
    ],
  });

  // Subtitle as a single object.
  await (db as any).addSubtitleTrackWithObject({
    mediaId,
    fileId,
    season: null,
    episode: null,
    language: "en",
    label: "English",
    objectKey: `${options.chunkPrefix}/s/sub-1`,
    format: "vtt",
  });

  return {
    mediaId,
    expectedChunkKeys: [
      `${options.chunkPrefix}/v/init`,
      `${options.chunkPrefix}/v/chunk-1`,
      `${options.chunkPrefix}/v/chunk-2`,
      `${options.chunkPrefix}/v/chunk-3`,
      `${options.chunkPrefix}/a/init`,
      `${options.chunkPrefix}/a/chunk-1`,
      `${options.chunkPrefix}/a/chunk-2`,
      `${options.chunkPrefix}/s/sub-1`,
    ],
  };
};

describe("media delete forwards chunk keys to /storage/delete (F1)", () => {
  it(
    "@bugfix @regression-proof deleteMedia POSTs all chunk keys to /storage/delete before SQLite rows go away",
    async () => {
      console.info(`[badger-media-delete-storage-leak:single-delete] opening LibraryDb`);
      const db = await LibraryDb.openLocal("test-token", "key");
      // Disable sync so we don't see fetches from the ops/snapshot pipeline.
      // Any fetch we capture must come from the chunk-cleanup pipeline added
      // in Layer 1 of the storage-tracker-refactor plan.
      db.setSyncEnabled(false);

      let mediaIdForDump: string | undefined;
      let expectedChunkKeys: string[] = [];
      let observedKeys: string[] = [];
      let missing: string[] = [];
      try {
        const seeded = await seedMovieWithChunks(db, {
          catalogId: 7001,
          title: "Delete Leak Movie",
          chunkPrefix: "shards/gw/library/movies/leak1",
        });
        const mediaId = seeded.mediaId;
        mediaIdForDump = mediaId;
        expectedChunkKeys = seeded.expectedChunkKeys;
        console.info(
          `[badger-media-delete-storage-leak:single-delete] seeded mediaId=${mediaId} expected=${expectedChunkKeys.length} keys`,
        );

        // Pre-condition: the chunks are visible through getMediaDetails.
        const detailsBefore = (db as any).getMediaDetails(mediaId);
        expect(detailsBefore).toBeTruthy();
        expect(detailsBefore.formats[0].chunks.length).toBe(3);
        expect(detailsBefore.audioTracks[0].chunks.length).toBe(2);
        expect(detailsBefore.subtitleTracks.length).toBe(1);

        capturedFetches = []; // discard anything seeded during setup
        console.info(`[badger-media-delete-storage-leak:single-delete] dispatching deleteMedia`);

        await db.deleteMedia(mediaId);
        // Allow any deferred persist-side cleanup to settle.
        await new Promise((resolve) => setTimeout(resolve, 25));

        observedKeys = collectKeysFromStorageDeleteCalls();
        // Behavior assertion: every chunk-and-object key the media owned must
        // have been forwarded to /storage/delete. This is the missing leg of
        // the cleanup pipeline today (F1: deleteMedia never calls the API).
        const observed = new Set(observedKeys);
        missing = expectedChunkKeys.filter((key) => !observed.has(key));
        console.info(
          `[badger-media-delete-storage-leak:single-delete] observed=${observedKeys.length} missing=${missing.length} storage-delete-fetches=${fetchesMatchingStorageDelete().length}`,
        );
        expect(missing).toEqual([]);
        expect(fetchesMatchingStorageDelete().length).toBeGreaterThan(0);
      } catch (err) {
        dumpMediaDeleteSnapshot("single-delete", {
          db,
          expectedKeys: expectedChunkKeys,
          observedKeys,
          missing,
          extra: { mediaId: mediaIdForDump },
        });
        throw err;
      } finally {
        db.close();
      }
    }
  );
});

describe("repeat-ingest+delete cycle does not accumulate keys (F1 cycle)", () => {
  it(
    "@bugfix @regression-proof every cycle's chunks are released to /storage/delete; nothing leaks across iterations",
    async () => {
      console.info(`[badger-media-delete-storage-leak:cycle] opening LibraryDb`);
      const db = await LibraryDb.openLocal("test-token", "key");
      db.setSyncEnabled(false);

      const cycles = 3;
      let currentCycle = -1;
      let expectedChunkKeys: string[] = [];
      let observedKeys: string[] = [];
      let missing: string[] = [];
      try {
        // For each cycle: ingest a movie, capture the keys it owned, delete it,
        // and assert /storage/delete saw all of those keys forwarded. The bug
        // is that nothing is forwarded; doing this 3× is what bloats the user's
        // quota cache to 3× the source size in production (the 30GB symptom).
        for (let cycle = 0; cycle < cycles; cycle++) {
          currentCycle = cycle;
          console.info(`[badger-media-delete-storage-leak:cycle] starting cycle=${cycle}`);
          capturedFetches = [];
          const seeded = await seedMovieWithChunks(db, {
            catalogId: 8000 + cycle,
            title: `Cycle ${cycle} Movie`,
            chunkPrefix: `shards/gw/library/movies/cycle${cycle}`,
          });
          expectedChunkKeys = seeded.expectedChunkKeys;
          const mediaId = seeded.mediaId;

          await db.deleteMedia(mediaId);
          await new Promise((resolve) => setTimeout(resolve, 25));

          observedKeys = collectKeysFromStorageDeleteCalls();
          const observed = new Set(observedKeys);
          missing = expectedChunkKeys.filter((key) => !observed.has(key));
          console.info(
            `[badger-media-delete-storage-leak:cycle] cycle=${cycle} observed=${observedKeys.length} missing=${missing.length}`,
          );
          expect(
            missing,
            `cycle ${cycle}: chunk keys ${JSON.stringify(missing)} were never forwarded to /storage/delete (forwarded set: ${JSON.stringify(observedKeys)})`
          ).toEqual([]);

          // Cross-cycle invariant: at the end of each cycle the local snapshot
          // shows zero media (delete completed) AND no leftover chunk-keys are
          // pending in any subsequent cycle.
          const snapshot = db.getSnapshot();
          expect(snapshot.media).toEqual([]);
        }
      } catch (err) {
        dumpMediaDeleteSnapshot("cycle", {
          db,
          expectedKeys: expectedChunkKeys,
          observedKeys,
          missing,
          cycle: currentCycle,
        });
        throw err;
      } finally {
        db.close();
      }
    }
  );
});
