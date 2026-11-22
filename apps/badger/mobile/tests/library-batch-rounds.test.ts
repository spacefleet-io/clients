/**
 * @test-id MOBILE-LIB-BATCH-ROUNDS-001
 * @level unit
 * @req LIB-SYNC-14
 * @bugfix @regression-proof
 *
 * @why A TV episode's media.upsert carries one playback row per segment. Once op6 could open a 57 MB op (~500k segment
 *   statements), the secondary apply sent them all in ONE `sqlBatch` bridge call: the plugin held every statement and
 *   every result on the Java side, the native heap passed 1 GB and the 256 MB Java heap ran out ("Throwing
 *   OutOfMemoryError" on every thread) four minutes into the sync. A large batch now reaches the native side a bounded
 *   number of statements at a time, still inside ONE transaction: every row lands, or none does.
 *
 * Drives the real LibraryDb over real in-memory SQLite dbs (node:sqlite); the handle's `transaction` follows the
 * plugin (statements queued from a success callback run in the same transaction, a failing one rolls it all back).
 */
import { Buffer } from "node:buffer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as SharedApi from "@space/shared/api";
import type { LibraryOp } from "@space/shared/libraryOps";
import type * as NativeLibrarySync from "../src/native/LibrarySync";
import { LibraryDb, SQL_BATCH_ROUND } from "../src/lib/libraryDb";
import { fx, mediaUpsertOp, resetFixture, seedSplitCache, setServer, settle, sqliteRows } from "./library-db-fixture";

const TAG = "[MOBILE-LIB-BATCH-ROUNDS-001]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

vi.mock("react-native", async () => ({ ...(await import("./setup/reactNativeMock")).reactNativeBase(), Platform: { OS: "ios" } }));
vi.mock("react-native-fs", async () => ({ default: (await import("./library-db-fixture")).fakeRnfs }));
vi.mock("react-native-sqlite-storage", () => ({ default: { enablePromise: () => undefined } }));
vi.mock("react-native-quick-crypto", async () => (await import("./library-db-fixture")).quickCryptoMock());
vi.mock("../src/lib/library/opsPage", async (importOriginal) => (await import("./library-db-fixture")).opsPageMock(await importOriginal()));
vi.mock("@space/shared/api", async (importOriginal) =>
  (await import("./library-db-fixture")).sharedApiMock(await importOriginal<typeof SharedApi>())
);
vi.mock("../src/lib/library/transport", async () => (await import("./library-db-fixture")).transportMock());
vi.mock("../src/lib/library/dbFiles", async () => (await import("./library-db-fixture")).sqliteDbFilesMock());
vi.mock("../src/lib/library/snapshot", async () => (await import("./library-db-fixture")).snapshotMock());
vi.mock("../src/lib/crypto", async () => (await import("./library-db-fixture")).cryptoMock());
vi.mock("../src/lib/librarySchema", () => ({}));
// The episode's op is large enough for the native open; the fixture ships ops with identity "encryption".
vi.mock("../src/native/LibrarySync", async (importOriginal) => ({
  ...(await importOriginal<typeof NativeLibrarySync>()),
  openOpPayload: async (payloadBase64: string) => Buffer.from(payloadBase64, "base64").toString("utf8"),
}));

const MEDIA = "episode-long";
const PLAYBACK = "library.playback.sqlite";
/** More than two rounds' worth of segment rows, so the batch needs at least three native calls. */
const SEGMENTS = SQL_BATCH_ROUND * 2 + 500;

/** One title whose single format has `SEGMENTS` segments; `brokenAt` gives that segment no key (NOT NULL fails). */
const longUpsert = (brokenAt?: number): LibraryOp => {
  const op = mediaUpsertOp("op-4", MEDIA) as unknown as { payload: { details: Record<string, unknown> } };
  op.payload.details.files = [
    { id: "file-1", mediaId: MEDIA, filename: "s05e01.mkv", season: 5, episode: 1, addedAt: "2026-11-21T00:00:00.000Z", status: "ready", desiredFormats: [] },
  ];
  op.payload.details.formats = [
    {
      id: "fmt-1080",
      mediaId: MEDIA,
      fileId: "file-1",
      quality: "1080p",
      codec: "h264",
      sizeMb: 900,
      durationSeconds: 2700,
      chunks: Array.from({ length: SEGMENTS }, (_, index) => ({
        key: index === brokenAt ? null : `seg-${index}`,
        sizeBytes: 180_000,
        startSeconds: index * 0.5,
      })),
    },
  ];
  return op as unknown as LibraryOp;
};

type LibraryDbSeam = Pick<LibraryDb, keyof LibraryDb> & { secondaryOpsInFlight: Promise<void> | null };

const syncOp = async (op: LibraryOp) => {
  seedSplitCache({ version: 3 });
  setServer({ version: 4, snapshotVersion: 3, ops: [{ opId: op.id, version: 4, op }] });
  const db = (await LibraryDb.open("token", "key")) as unknown as LibraryDbSeam;
  await db.syncFromRemoteIfNewer(fx.meta ?? undefined);
  await settle(db);
  return db;
};

beforeEach(() => {
  resetFixture();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("a media.upsert with many segment rows reaches SQLite in bounded native calls (LIB-SYNC-14)", () => {
  it("lands every segment row, in order, and no native call carries more than one round", async () => {
    const db = await syncOp(longUpsert());
    try {
      const playbackCalls = fx.sqliteCalls.filter((call) => call.handle === PLAYBACK).map((call) => call.statements);
      const rows = sqliteRows(PLAYBACK, "SELECT chunk_key, order_index FROM media_format_chunks WHERE format_id = ? ORDER BY order_index;", "fmt-1080");
      log("state:applied", { playbackCalls, rows: rows.length });

      expect(rows, "every segment of the episode is stored").toHaveLength(SEGMENTS);
      expect(rows.map((row) => row.chunk_key)).toEqual(Array.from({ length: SEGMENTS }, (_, index) => `seg-${index}`));
      expect(Math.max(...playbackCalls), "no native call holds the whole episode").toBeLessThanOrEqual(SQL_BATCH_ROUND);
      expect(playbackCalls.length, "the episode went in several rounds").toBeGreaterThanOrEqual(3);
    } finally {
      await db.close();
    }
  });

  it("a statement failing in a later round rolls back the rounds before it", async () => {
    const db = await syncOp(longUpsert(SQL_BATCH_ROUND + 100));
    try {
      const playbackCalls = fx.sqliteCalls.filter((call) => call.handle === PLAYBACK).map((call) => call.statements);
      const chunks = sqliteRows(PLAYBACK, "SELECT COUNT(*) AS n FROM media_format_chunks WHERE format_id = ?;", "fmt-1080");
      const formats = sqliteRows(PLAYBACK, "SELECT id FROM media_formats WHERE media_id = ?;", MEDIA);
      log("state:rolled-back", { playbackCalls, chunks, formats });

      expect(playbackCalls.length, "the failure came after the first round had run").toBeGreaterThanOrEqual(2);
      expect(chunks[0]?.n, "no segment of the failed batch is left behind").toBe(0);
      expect(formats, "nor its format row from the first round").toEqual([]);
    } finally {
      await db.close();
    }
  });
});
