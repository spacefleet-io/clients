/**
 * @test-id BADGER-MOBILE-ROTATION-SEAL-001
 * @level unit
 * @bugfix
 * @regression-proof
 * @req PRIV-KEY-13[badger-mobile,badger-tv]
 *
 * Why this exists: a key rotation must carry the caller's own library sealed under the NEW key in the
 * same shape `uploadSnapshot` publishes it (chunks uploaded first, an encrypted manifest, the chunk
 * refs, and this build's writer formats), or the API refuses the rotation with 400 and a v2 library
 * reads it as a downgrade. The phone had no way to build that body. `sealForRotation` must seal and
 * upload under the new key without publishing a snapshot, then leave no rotation file behind.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as SharedApi from "@space/shared/api";
import { TRUSTED_CHUNK_REFS_VERSION } from "@space/shared/contracts/library";
import { OP_STREAM_VERSION } from "@space/library-db-definition/ops";
import { STORAGE_FORMAT_VERSION } from "@space/library-db-definition/storageFormat";
import { LibraryDb } from "../src/lib/libraryDb";
import { fx, resetFixture, seedSplitCache, setServer } from "./library-db-fixture";

const TAG = "[rotation-seal-own-library]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const rec = vi.hoisted(() => ({
  encryptKeys: [] as string[],
  manifestKeys: [] as string[],
  uploads: [] as Array<{ token: string; path: string; hashes: string[] }>,
}));

const CHUNKS = [
  { index: 0, hash: "c1", size: 4, offset: 0 },
  { index: 1, hash: "c2", size: 2, offset: 4 },
];

vi.mock("react-native", async () => ({ ...(await import("./setup/reactNativeMock")).reactNativeBase(), Platform: { OS: "ios" } }));
vi.mock("react-native-fs", async () => ({ default: (await import("./library-db-fixture")).fakeRnfs }));
vi.mock("react-native-sqlite-storage", () => ({ default: { enablePromise: () => undefined } }));
vi.mock("react-native-quick-crypto", async () => (await import("./library-db-fixture")).quickCryptoMock());
vi.mock("../src/lib/library/opsPage", async (importOriginal) => (await import("./library-db-fixture")).opsPageMock(await importOriginal()));
vi.mock("@space/shared/api", async (importOriginal) =>
  (await import("./library-db-fixture")).sharedApiMock(await importOriginal<typeof SharedApi>())
);
vi.mock("../src/lib/library/transport", async () => ({
  ...(await import("./library-db-fixture")).transportMock(),
  uploadChunksFromFile: async (token: string, path: string, chunks: Array<{ hash: string }>) => {
    rec.uploads.push({ token, path, hashes: chunks.map((chunk) => chunk.hash) });
  },
}));
vi.mock("../src/lib/library/dbFiles", async () => (await import("./library-db-fixture")).dbFilesMock());
vi.mock("../src/lib/library/snapshot", async () => {
  const base = (await import("./library-db-fixture")).snapshotMock();
  return {
    ...base,
    encryptDbToBinaryFile: async (db: string, key: string, target: string) => {
      rec.encryptKeys.push(key);
      await base.encryptDbToBinaryFile(db, key, target);
    },
    buildChunkIndexFromFile: async () => ({ totalSize: 6, chunks: CHUNKS }),
    buildManifest: (snapshotId: string, dbHash: { hash: string }, chunks: Array<{ hash: string }>) => ({
      snapshotId,
      dbHash: dbHash.hash,
      chunks: chunks.map((chunk) => chunk.hash),
    }),
  };
});
vi.mock("../src/lib/crypto", async () => {
  const base = (await import("./library-db-fixture")).cryptoMock();
  return {
    ...base,
    encryptBytesToBytes: async (key: string, bytes: Uint8Array) => {
      rec.manifestKeys.push(key);
      return bytes;
    },
  };
});
vi.mock("../src/lib/librarySchema", () => ({}));

const ROTATION_SNAPSHOT = "/docs/library/rotation.snapshot";

beforeEach(() => {
  resetFixture();
  rec.encryptKeys = [];
  rec.manifestKeys = [];
  rec.uploads = [];
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("the phone seals its own library for a key rotation", () => {
  it("@bugfix @regression-proof seals under the new key, uploads the chunks, and publishes nothing", async () => {
    log("phase:open");
    setServer({ version: 10, snapshotVersion: 10 });
    seedSplitCache({ version: 10 });
    const db = await LibraryDb.open("token", "old-key");
    try {
      const sealed = await db.sealForRotation("new-key", new Map());
      const manifest = JSON.parse(Buffer.from(sealed.manifestBase64, "base64").toString("utf8"));
      log("state", { sealed, manifest, rec, encryptTargets: fx.encryptTargets, putDbCalls: fx.putDbCalls });
      expect(sealed).toEqual({
        manifestBase64: sealed.manifestBase64,
        snapshotId: "snapshot-id",
        chunkSize: 4 * 1024 * 1024,
        chunkRefs: ["c1", "c2"],
        chunkRefsSource: { client: "badger-mobile", refsVersion: TRUSTED_CHUNK_REFS_VERSION },
        storageFormatVersion: STORAGE_FORMAT_VERSION,
        opStreamVersion: OP_STREAM_VERSION,
      });
      expect(manifest).toEqual({ snapshotId: "snapshot-id", dbHash: "hash", chunks: ["c1", "c2"] });
      expect(rec.encryptKeys, "the library body is sealed under the new key").toEqual(["new-key"]);
      expect(rec.manifestKeys, "the manifest is sealed under the new key").toEqual(["new-key"]);
      expect(fx.encryptTargets.at(-1), "sealed into the rotation file, not the cache blob").toBe(ROTATION_SNAPSHOT);
      expect(rec.uploads).toEqual([{ token: "token", path: ROTATION_SNAPSHOT, hashes: ["c1", "c2"] }]);
      expect(fx.putDbCalls, "the rotation publishes the snapshot, not this call").toBe(0);
      expect(fx.files.has(ROTATION_SNAPSHOT), "the rotation file is removed afterwards").toBe(false);
    } finally {
      await db.close();
    }
  });
});
