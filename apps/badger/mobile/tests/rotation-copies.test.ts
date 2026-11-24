/**
 * @test-id BADGER-MOBILE-ROTATION-COPIES-001
 * @level unit
 * @req PRIV-KEY-12[badger-mobile,badger-tv]
 * @req PRIV-KEY-13[badger-mobile,badger-tv]
 * @req STOR-RESEAL-01[badger-mobile]
 * @why Chris (2026-11-23, chat: re-encrypt Parrot's library on rotation): a key change from the phone re-encrypts
 *   Parrot's library under the new key and never deletes it. What the phone cannot re-encrypt whole (old key does not
 *   open it, changes after its snapshot) stops the key change before anything is sent, with the error
 *   `keyChangeFailureOf` words. With media re-sealed, the published Parrot library names the copies (the switch
 *   deletes the old objects): the phone renames its references in a temporary SQLite file, then removes it.
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { keyChangeFailureOf } from "@space/shared/keyChangeFailure";
import { reencryptParrotLibrary } from "../src/lib/rotationCopies";

const dir = mkdtempSync(join(tmpdir(), "rotation-copies-"));
const DB_PATH = join(dir, "rotation.parrot.sqlite");

const mocks = vi.hoisted(() => ({
  meta: { exists: true, version: 2, snapshotVersion: 2, opStreamVersion: 3 },
  open: vi.fn(),
  reencrypt: vi.fn(),
}));

vi.mock("react-native-quick-crypto", async () => (await import("./library-db-fixture")).quickCryptoMock());
vi.mock("react-native-fs", () => ({
  default: {
    writeFile: async (path: string, data: string) => writeFileSync(path, Buffer.from(data, "base64")),
    readFile: async (path: string) => readFileSync(path).toString("base64"),
  },
}));
vi.mock("@space/shared/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@space/shared/api")>()),
  getLibraryMeta: vi.fn(async () => ({ ...mocks.meta })),
  getLibraryDb: vi.fn(),
  downloadStorageObjectViaTunnel: vi.fn(),
  uploadStorageObjectViaTunnel: vi.fn(async () => undefined),
}));
vi.mock("@space/mobile-shell/librarySnapshot", () => ({ openRemoteLibrarySnapshot: mocks.open }));
vi.mock("@space/library-db-definition/snapshotPublish", () => ({ reencryptLibrarySnapshotWith: mocks.reencrypt }));
vi.mock("../src/lib/crypto", () => ({ decryptBytesToBytes: vi.fn(), encryptBytesToBytes: vi.fn() }));
vi.mock("../src/lib/libraryStorage", () => ({ ROTATION_PARROT_DB_NAME: "rotation.parrot.sqlite", getRotationParrotDbPath: () => DB_PATH }));
// react-native-sqlite-storage over the real file: `executeSql` and `close`, the calls the rename makes.
vi.mock("../src/lib/library/dbFiles", () => ({
  removeDbFile: async (path: string) => rmSync(path, { force: true }),
  openSqliteDb: async () => {
    const db = new DatabaseSync(DB_PATH);
    return {
      executeSql: async (sql: string, params: Array<string | number | null> = []) => {
        const statement = db.prepare(sql);
        const rows = statement.columns().length > 0 ? statement.all(...params) : (statement.run(...params), []);
        return [{ rows: { length: rows.length, item: (i: number) => rows[i] } }];
      },
      close: async () => db.close(),
    };
  },
}));

const SUITE = "[BADGER-MOBILE-ROTATION-COPIES-001]";
const OLD_COVER = "media/p/00000000-0000-4000-8000-000000000001";
const NEW_COVER = "media/p/00000000-0000-4000-8000-000000000101";

/** A Parrot library file holding one album cover reference. */
const parrotBytes = () => {
  const path = join(dir, "source.sqlite");
  rmSync(path, { force: true });
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE albums (id TEXT PRIMARY KEY, cover_object_key TEXT, cover_thumb_object_key TEXT)");
  db.prepare("INSERT INTO albums (id, cover_object_key, cover_thumb_object_key) VALUES ('a1', ?, NULL)").run(OLD_COVER);
  db.close();
  return new Uint8Array(readFileSync(path));
};

const coverIn = (bytes: Uint8Array) => {
  const path = join(dir, "published.sqlite");
  writeFileSync(path, bytes);
  const db = new DatabaseSync(path);
  try {
    return db.prepare("SELECT cover_object_key FROM albums WHERE id = 'a1'").get()?.cover_object_key;
  } finally {
    db.close();
  }
};

const failureOf = (p: Promise<unknown>) => p.then(() => "reencrypted", (err: unknown) => keyChangeFailureOf(err));

beforeEach(() => {
  mocks.meta = { exists: true, version: 2, snapshotVersion: 2, opStreamVersion: 3 };
  mocks.open.mockReset().mockResolvedValue({ dbBytes: parrotBytes(), snapshotVersion: 2 });
  mocks.reencrypt.mockReset().mockImplementation(async (_bytes: Uint8Array, baseVersion: number) => ({
    baseVersion,
    manifestBase64: "bWFuaWZlc3Q=",
    snapshotId: "new-key-snapshot",
    chunkSize: 4194304,
    chunkRefs: ["chunk-1"],
  }));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe(`${SUITE} reencryptParrotLibrary`, () => {
  it("re-encrypts Parrot's library at the version it was read at, with its stored op-stream version", async () => {
    const copies = await reencryptParrotLibrary("t", "old", "new", new Map());
    expect(copies).toEqual([expect.objectContaining({ appId: "parrot", baseVersion: 2, opStreamVersion: 3, snapshotId: "new-key-snapshot" })]);
    expect(coverIn(mocks.reencrypt.mock.calls[0]![0])).toBe(OLD_COVER);
  });

  it("publishes Parrot's library naming the re-sealed copies, and leaves no temporary file", async () => {
    await reencryptParrotLibrary("t", "old", "new", new Map([[OLD_COVER, NEW_COVER]]));
    expect(coverIn(mocks.reencrypt.mock.calls[0]![0])).toBe(NEW_COVER);
    expect(existsSync(DB_PATH)).toBe(false);
  });

  it("stops before re-encrypting when Parrot has changes after its latest snapshot", async () => {
    mocks.meta = { exists: true, version: 3, snapshotVersion: 2, opStreamVersion: 3 };
    expect(await failureOf(reencryptParrotLibrary("t", "old", "new", new Map()))).toEqual({ status: "failed", reason: "notSnapshotted" });
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.reencrypt).not.toHaveBeenCalled();
  });

  it("stops before re-encrypting when the old key does not open Parrot's library", async () => {
    mocks.open.mockRejectedValue(new Error("DECRYPT_FAILED"));
    expect(await failureOf(reencryptParrotLibrary("t", "old", "new", new Map()))).toEqual({ status: "failed", reason: "unreadable" });
    expect(mocks.reencrypt).not.toHaveBeenCalled();
  });

  it("sends nothing when Parrot has no library", async () => {
    mocks.meta = { exists: false, version: 0, snapshotVersion: 0, opStreamVersion: 3 };
    expect(await reencryptParrotLibrary("t", "old", "new", new Map())).toEqual([]);
  });
});
