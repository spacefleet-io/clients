/**
 * @test-id LIB-DB-SQLITE-IMAGE-001
 * @level unit
 * @bugfix
 * @regression-proof
 * @why LIB-FMT-10: Parrot iOS published its library snapshot as the phone's SQLite file, which is in WAL mode (header
 *   bytes 18/19 = 2), and Parrot desktop's in-memory SQLite (`sqlite3_deserialize`) refused it with "unable to open
 *   database file". Every publish through the shared writer (`publishLibrarySnapshotWith`: Parrot iOS/Android and the
 *   web players) must ship a rollback-journal file (bytes 18/19 = 1), hashed as shipped, with every row intact.
 *   The WAL image here is made the way the phone makes it: a real WAL-mode SQLite file, folded with a TRUNCATE
 *   checkpoint, then read as bytes.
 * @req LIB-FMT-10[parrot] @req LIB-FMT-10[parrot-web-player]
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { COMPRESSION_LEVEL, decodeCompressedFrame, type DeflateCodec } from "../src/payloadCompression";
import { publishLibrarySnapshotWith } from "../src/snapshotPublish";
import { asRollbackJournalImage, isWalSqliteImage } from "../src/sqliteImage";

const SUITE = "sqlite-image";
const log = (testId: string, phase: string, data?: unknown) =>
  console.info(`[${SUITE}] ${testId} ${phase}`, data === undefined ? "" : JSON.stringify(data));

const codec: DeflateCodec = {
  deflateRaw: (bytes) => new Uint8Array(deflateRawSync(bytes, { level: COMPRESSION_LEVEL })),
  inflateRaw: (bytes) => new Uint8Array(inflateRawSync(bytes)),
};
const sha256Hex = async (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A library file the way a phone holds it: WAL mode, rows written, the log folded in, then read as bytes. */
const walLibraryImage = (rows: number) => {
  const dir = mkdtempSync(join(tmpdir(), "wal-image-"));
  dirs.push(dir);
  const path = join(dir, "library.sqlite");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("CREATE TABLE playlists (id TEXT PRIMARY KEY, name TEXT NOT NULL)");
  const insert = db.prepare("INSERT INTO playlists (id, name) VALUES (?, ?)");
  for (let i = 0; i < rows; i += 1) insert.run(`p${i}`, `Playlist ${i}`);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const bytes = new Uint8Array(readFileSync(path));
  db.close();
  return bytes;
};

/** Opens the bytes as their own file (vitest runs on Node 24, whose node:sqlite has no `deserialize`; the in-memory
 * refusal is proven in parrot-ingest's wal-snapshot test under Bun) and reads the row count and journal mode. */
const readImage = (bytes: Uint8Array) => {
  const dir = mkdtempSync(join(tmpdir(), "wal-image-read-"));
  dirs.push(dir);
  const path = join(dir, "snapshot.sqlite");
  writeFileSync(path, bytes);
  const db = new DatabaseSync(path);
  const rows = Number(db.prepare("SELECT count(*) AS n FROM playlists").get()?.n);
  const journalMode = String(db.prepare("PRAGMA journal_mode").get()?.journal_mode);
  db.close();
  return { rows, journalMode };
};

describe("asRollbackJournalImage", () => {
  it("turns a WAL-mode file into a rollback-journal one with every row @req LIB-FMT-10[parrot]", () => {
    const id = "IMAGE-WAL";
    const wal = walLibraryImage(3);
    const image = asRollbackJournalImage(wal);
    log(id, "phase:converted", { walHeader: [wal[18], wal[19]], imageHeader: [image[18], image[19]] });
    expect([wal[18], wal[19]], "the phone's file says WAL").toEqual([2, 2]);
    expect(isWalSqliteImage(wal)).toBe(true);
    expect(isWalSqliteImage(image)).toBe(false);
    expect([image[18], image[19]]).toEqual([1, 1]);
    expect(image).not.toBe(wal);
    expect([wal[18], wal[19]], "the caller's bytes are left alone").toEqual([2, 2]);
    expect(readImage(image)).toEqual({ rows: 3, journalMode: "delete" });
    // Only the two header bytes differ.
    const differing = [...image.keys()].filter((index) => image[index] !== wal[index]);
    expect(differing).toEqual([18, 19]);
  });

  it("returns anything else as is, without a copy @req LIB-FMT-10[parrot]", () => {
    const id = "IMAGE-OTHER";
    const rollback = asRollbackJournalImage(walLibraryImage(1));
    const frame = new Uint8Array([0x00, 0x5a, 0x01, 2, 2, 2]);
    const json = new TextEncoder().encode(JSON.stringify({ kind: "op", pad: "x".repeat(120) }));
    const short = new TextEncoder().encode("SQLite format 3\0");
    log(id, "phase:inputs", { rollback: rollback.length, frame: frame.length, json: json.length, short: short.length });
    for (const bytes of [rollback, frame, json, short]) expect(asRollbackJournalImage(bytes)).toBe(bytes);
  });
});

describe("publishLibrarySnapshotWith", () => {
  it("publishes a WAL-mode file as a rollback-journal snapshot, hashed as shipped @req LIB-FMT-10[parrot] @req LIB-FMT-10[parrot-web-player]", async () => {
    const id = "PUBLISH-WAL";
    const wal = walLibraryImage(50);
    const sealed: Uint8Array[] = [];
    const chunks = new Map<string, Uint8Array>();
    const result = await publishLibrarySnapshotWith(wal, 4, {
      seal: async (plaintext) => {
        sealed.push(plaintext);
        return plaintext;
      },
      codec,
      sha256Hex,
      randomId: () => "snap-1",
      uploadChunk: async (key, bytes) => void chunks.set(key, bytes),
      putSnapshot: async () => ({ version: 5 }),
    });
    const shipped = decodeCompressedFrame(sealed[0]!, codec);
    log(id, "phase:published", {
      version: result.version,
      shippedHeader: [shipped[18], shipped[19]],
      dbHash: result.manifest.dbHash,
      dbSizeBytes: result.manifest.dbSizeBytes,
      chunks: chunks.size,
    });
    expect(result.version).toBe(5);
    expect([shipped[18], shipped[19]], "the snapshot is a rollback-journal file").toEqual([1, 1]);
    expect(readImage(shipped), "every row is in it").toEqual({ rows: 50, journalMode: "delete" });
    expect(result.manifest.dbHash).toBe(await sha256Hex(shipped));
    expect(result.manifest.dbSizeBytes).toBe(shipped.length);
    expect([wal[18], wal[19]], "the phone's own file bytes are not changed").toEqual([2, 2]);
  });
});
