/**
 * @test-id LIB-ROTATION-SEAL-OWN-001
 * @level integration (real LibraryDb + bun:sqlite + real AES-GCM against a fake API)
 * @req PRIV-KEY-13[badger-desktop]
 * @why Main (2026-11-23, IRC: make Badger desktop key rotation succeed end to end): the rotation sent this library as
 *   one whole AES-GCM blob that no reader decodes (every reader opens a manifest naming chunks) and declared no formats,
 *   so the server took it for storage 1 / op stream 1 and refused it on a format-2 account. The device now seals its
 *   own library as the snapshot it publishes (chunks uploaded, a manifest under the new key) and declares the formats
 *   it is written in. This pins that a fresh device opens that snapshot with the new key and finds the library.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { OP_STREAM_VERSION } from "@space/library-db-definition/ops";
import { STORAGE_FORMAT_VERSION } from "@space/library-db-definition/storageFormat";
import * as realApi from "../src/api";
import type { LibraryMeta } from "../src/api";
import { decryptBytesToBytes } from "../src/crypto";
import { DESKTOP_CHUNK_REFS_SOURCE, type RotationOwnLibrary } from "../src/snapshotTransport";

const TAG = "[LIB-ROTATION-SEAL-OWN-001]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const fake = {
  exists: false,
  version: 0,
  snapshotVersion: 0,
  manifestKey: null as string | null,
  snapshotId: null as string | null,
  objects: new Map<string, Uint8Array>(),
  reset() {
    this.exists = false;
    this.version = 0;
    this.snapshotVersion = 0;
    this.manifestKey = null;
    this.snapshotId = null;
    this.objects = new Map();
  },
  meta(): LibraryMeta {
    return {
      exists: this.exists,
      bootstrapRequired: !this.exists,
      syncUnavailable: false,
      version: this.version,
      snapshotVersion: this.snapshotVersion,
      hash: null,
      stateHash: null,
      lastOpId: null,
      consistency: this.exists ? "ok" : "missing_snapshot",
      updatedAt: new Date().toISOString(),
      keyProbe: null,
      keyProbeUpdatedAt: null,
      blobEncoding: "binary",
      snapshotId: this.snapshotId,
      manifestKey: this.manifestKey,
      chunkSize: null,
      snapshotHistory: [],
      opsHistory: [],
      storageFormatVersion: STORAGE_FORMAT_VERSION,
      opStreamVersion: OP_STREAM_VERSION,
    };
  },
  /** What the server's snapshot write keeps: the manifest text under its key, the version moved, no op after it. */
  storeSnapshot(manifestBase64: string, snapshotId: string) {
    this.version += 1;
    this.snapshotVersion = this.version;
    this.exists = true;
    this.snapshotId = snapshotId;
    this.manifestKey = `library/manifests/${snapshotId}`;
    this.objects.set(this.manifestKey, new TextEncoder().encode(manifestBase64));
    return { version: this.version, stateHash: null, lastOpId: null, snapshotVersion: this.version };
  },
};

const originalApi = { ...realApi };
afterAll(() => {
  mock.module("../src/api", () => originalApi);
});

mock.module("../src/api", () => ({
  ...originalApi,
  getLibraryMeta: async () => fake.meta(),
  getLibraryDb: async () => ({
    exists: fake.exists,
    version: fake.version,
    snapshotVersion: fake.snapshotVersion,
    hash: null,
    manifestKey: fake.manifestKey,
    updatedAt: new Date().toISOString(),
    blobEncoding: "binary" as const,
    snapshotId: fake.snapshotId,
    chunkSize: null,
  }),
  getLibraryOps: async () => ({
    version: fake.version,
    snapshotVersion: fake.snapshotVersion,
    tooOld: false,
    ops: [],
    storageFormatVersion: STORAGE_FORMAT_VERSION,
    opStreamVersion: OP_STREAM_VERSION,
  }),
  putLibraryOp: async () => {
    throw new realApi.ApiError(409, { error: "version_conflict", version: fake.version });
  },
  putLibraryDb: async (_token: string, expectedVersion: number, manifestBase64: string, snapshotId: string) => {
    if (expectedVersion !== fake.version) throw new realApi.ApiError(409, { error: "version_conflict", version: fake.version });
    return fake.storeSnapshot(manifestBase64, snapshotId);
  },
  uploadStorageObjectViaTunnel: async (_token: string, objectKey: string, payload: Uint8Array) => {
    fake.objects.set(objectKey, Uint8Array.from(payload));
    return { ok: true };
  },
  downloadStorageObjectViaTunnel: async (_token: string, objectKey: string) => {
    const bytes = fake.objects.get(objectKey);
    if (!bytes) throw new realApi.ApiError(404, { error: "not_found" });
    return bytes;
  },
  listStorageObjects: async () => ({ keys: [...fake.objects.keys()] }),
  deleteStorageObjects: async (_token: string, keys: string[]) => {
    for (const key of keys) fake.objects.delete(key);
    return { deleted: keys.length };
  },
}));

// Loaded after mock.module so LibraryDb binds the fake API (a static import would bind the real one first).
const { LibraryDb } = await import("../src/libraryDb");

const TOKEN = "token-rotation-seal";
const OLD_KEY = randomBytes(32).toString("base64");
const NEW_KEY = randomBytes(32).toString("base64");
const roots: string[] = [];
const useFreshRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "sf-rotation-seal-"));
  roots.push(root);
  process.env.SF_USER_DATA_PATH = root;
};

beforeEach(() => {
  fake.reset();
  useFreshRoot();
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.SF_USER_DATA_PATH;
});

const MOVIE = {
  id: 66_313,
  type: "movie" as const,
  title: "Rotation Seal Movie",
  originalTitle: null,
  originalLanguage: "en",
  overview: "A movie kept across a key rotation.",
  year: "2026",
  rating: null,
  posterPath: null,
  backdropPath: null,
  genres: [],
  cast: [],
  trailers: [],
  totalEpisodes: null,
  seasons: [],
  episodes: [],
};

/** A library holding one movie (its change still local: the seal reads the device's files, not the server). */
const seededLibrary = async () => {
  const db = await LibraryDb.open(TOKEN, OLD_KEY);
  const mediaId = await db.addMediaFromCatalog(MOVIE);
  return { db, mediaId };
};

/** The rotation's write of the own library, then a fresh device opening it with the new key. */
const openAfterRotation = async (sealed: RotationOwnLibrary, mediaId: string) => {
  const manifestText = new TextDecoder().decode(new Uint8Array(Buffer.from(sealed.manifestBase64, "base64")));
  expect(() => JSON.parse(manifestText)).toThrow();
  const manifest = JSON.parse(
    new TextDecoder().decode(await decryptBytesToBytes(NEW_KEY, new Uint8Array(Buffer.from(sealed.manifestBase64, "base64"))))
  ) as { snapshotId: string; chunks: Array<{ hash: string }> };
  log("state:sealed", {
    snapshotId: sealed.snapshotId,
    chunkRefs: sealed.chunkRefs.length,
    storageFormatVersion: sealed.storageFormatVersion,
    opStreamVersion: sealed.opStreamVersion,
  });
  expect(manifest.snapshotId).toBe(sealed.snapshotId);
  expect(manifest.chunks.map((chunk) => chunk.hash)).toEqual(sealed.chunkRefs);
  for (const ref of sealed.chunkRefs) expect(fake.objects.has(`library/chunks/${ref}`)).toBe(true);
  await expect(decryptBytesToBytes(OLD_KEY, new Uint8Array(Buffer.from(sealed.manifestBase64, "base64")))).rejects.toThrow();

  fake.storeSnapshot(sealed.manifestBase64, sealed.snapshotId);
  useFreshRoot();
  const fresh = await LibraryDb.open(TOKEN, NEW_KEY);
  try {
    const title = fresh.getMediaDetails(mediaId)?.title ?? null;
    log("state:fresh-device", { title });
    expect(title).toBe(MOVIE.title);
  } finally {
    fresh.close();
  }
};

describe("a rotation seals this device's own library as a readable snapshot (PRIV-KEY-13)", () => {
  it("sealForRotation: a manifest under the new key naming uploaded chunks, declaring the formats it is written in", async () => {
    const { db, mediaId } = await seededLibrary();
    const sealed = await db.sealForRotation(NEW_KEY);
    db.close();
    expect(sealed.chunkSize).toBeGreaterThan(0);
    expect(sealed.chunkRefsSource).toEqual(DESKTOP_CHUNK_REFS_SOURCE);
    expect(sealed.storageFormatVersion).toBe(STORAGE_FORMAT_VERSION);
    // The account is not switched to op stream 4: this library writes version 3, and says so.
    expect(sealed.opStreamVersion).toBe(OP_STREAM_VERSION);
    await openAfterRotation(sealed, mediaId);
  }, 30_000);

  it("sealLocalCacheForRotation: the local files, with no library open, sealed the same way", async () => {
    const { db, mediaId } = await seededLibrary();
    db.close();
    const sealed = await LibraryDb.sealLocalCacheForRotation(TOKEN, NEW_KEY);
    expect(sealed).not.toBeNull();
    expect(sealed!.storageFormatVersion).toBe(STORAGE_FORMAT_VERSION);
    expect(sealed!.opStreamVersion).toBe(OP_STREAM_VERSION);
    await openAfterRotation(sealed!, mediaId);
  }, 30_000);

  it("sealLocalCacheForRotation: no local library, nothing to seal (null)", async () => {
    expect(await LibraryDb.sealLocalCacheForRotation(TOKEN, NEW_KEY)).toBeNull();
  });
});
