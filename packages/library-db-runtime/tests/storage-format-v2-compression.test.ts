/**
 * @test-id LIB-FMT-V2-COMPRESSION-001
 * @level integration (real LibraryDb + bun:sqlite + real AES-GCM against a fake API)
 *
 * Storage format v2 (LIB-FMT-07), reader side: a library whose saved copy and big changes are
 * compressed BEFORE encryption opens, and so does a v1 library (no compression). This pins, on the real LibraryDb:
 *   1. a v2 library (compressed snapshot, compressed op) opens on a fresh device,
 *   2. (see 1: the snapshot is far smaller than the db),
 *   3. a v1 library (plain SQLite bytes under AES-GCM, plain op JSON) opens and syncs,
 *   4. v2 frames and v1 plain ops mix freely in one op log.
 *
 * @req LIB-FMT-07[badger-desktop,runtime]
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { isCompressedFrame } from "@space/library-db-definition/payloadCompression";
import type { LibraryOp } from "@space/shared/libraryOps";
import * as realApi from "../src/api";
import type { LibraryMeta } from "../src/api";
import { decryptBytesToBytes, encryptBytesToBytes } from "../src/crypto";
import { decryptLibraryPayload, encryptSnapshotBytes } from "../src/payloadCodec";

const TAG = "[LIB-FMT-V2-COMPRESSION-001]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

type FakeOp = { version: number; opId: string; payloadCiphertext: string; createdAt: string };

const fake = {
  exists: false,
  version: 0,
  snapshotVersion: 0,
  stateHash: null as string | null,
  lastOpId: null as string | null,
  manifestKey: null as string | null,
  snapshotId: null as string | null,
  ops: [] as FakeOp[],
  objects: new Map<string, Uint8Array>(),
  reset() {
    this.exists = false;
    this.version = 0;
    this.snapshotVersion = 0;
    this.stateHash = null;
    this.lastOpId = null;
    this.manifestKey = null;
    this.snapshotId = null;
    this.ops = [];
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
      stateHash: this.stateHash,
      lastOpId: this.lastOpId,
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
      storageFormatVersion: 1,
      opStreamVersion: 1,
    };
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
  getLibraryOps: async (_token: string, since: number) => {
    const history = fake.ops.filter((op) => op.version > fake.snapshotVersion);
    const minVersion = history.length ? Math.min(...history.map((op) => op.version)) : fake.snapshotVersion;
    const tooOld = since < Math.max(fake.snapshotVersion, minVersion - 1);
    const ops = tooOld ? [] : history.filter((op) => op.version > since);
    return {
      version: fake.version,
      snapshotVersion: fake.snapshotVersion,
      tooOld,
      ops: ops.map((op) => ({ ...op, objectKey: `library/ops/${op.opId}`, size: 0 })),
      storageFormatVersion: 2,
      opStreamVersion: 1,
    };
  },
  putLibraryOp: async (
    _token: string,
    baseVersion: number,
    opId: string,
    payload: Uint8Array,
    lineage?: { prevStateHash?: string | null; nextStateHash?: string | null }
  ) => {
    if (baseVersion !== fake.version) throw new realApi.ApiError(409, { error: "version_conflict", version: fake.version });
    fake.version += 1;
    fake.stateHash = lineage?.nextStateHash ?? fake.stateHash;
    fake.lastOpId = opId;
    fake.ops.push({
      version: fake.version,
      opId,
      payloadCiphertext: Buffer.from(payload).toString("base64"),
      createdAt: new Date().toISOString(),
    });
    return { version: fake.version, snapshotVersion: fake.snapshotVersion, stateHash: fake.stateHash, lastOpId: opId };
  },
  putLibraryDb: async (
    _token: string,
    expectedVersion: number,
    manifestBase64: string,
    snapshotId: string,
    _chunkSize: number,
    _keyProbe?: string | null,
    _force?: boolean,
    stateHash?: string | null,
    lastOpId?: string | null
  ) => {
    if (expectedVersion !== fake.version) throw new realApi.ApiError(409, { error: "version_conflict", version: fake.version });
    fake.version += 1;
    fake.snapshotVersion = fake.version;
    fake.exists = true;
    fake.snapshotId = snapshotId;
    fake.manifestKey = `library/manifests/${snapshotId}`;
    fake.objects.set(fake.manifestKey, new TextEncoder().encode(manifestBase64));
    fake.stateHash = stateHash ?? fake.stateHash ?? `snap-${snapshotId}`;
    fake.lastOpId = lastOpId ?? fake.lastOpId;
    return { version: fake.version, stateHash: fake.stateHash, lastOpId: fake.lastOpId, snapshotVersion: fake.version };
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

const { LibraryDb } = await import("../src/libraryDb");
type Db = typeof LibraryDb.prototype;
const defaultProgressOpsFlushDelayMs = LibraryDb.progressOpsFlushDelayMs;

const TOKEN = "token-format-v2";
const KEY = randomBytes(32).toString("base64");
const roots: string[] = [];
const useFreshRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "sf-format-v2-"));
  roots.push(root);
  process.env.SF_USER_DATA_PATH = root;
  return root;
};

beforeEach(() => {
  fake.reset();
  useFreshRoot();
  LibraryDb.progressOpsFlushDelayMs = 0;
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.SF_USER_DATA_PATH;
  LibraryDb.progressOpsFlushDelayMs = defaultProgressOpsFlushDelayMs;
});

const MOVIE = {
  id: 66_301,
  type: "movie" as const,
  title: "Format V2 Movie",
  originalTitle: null,
  originalLanguage: "en",
  // A realistic long overview: this is what makes a media.add op worth compressing.
  overview: "A long and quite repetitive overview of the movie. ".repeat(40),
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

// Real LibraryDb flushes ops on real debounce timers; each poll waits on an explicit condition (same as remote-sync-prepare-apply.test.ts).
const waitFor = async (label: string, predicate: () => boolean, timeoutMs = 10_000) => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`waitFor timeout: ${label}`);
    await Bun.sleep(10);
  }
};

const internals = (db: Db) =>
  db as unknown as { pendingOps: unknown[]; opsFlushInFlight: boolean; remoteVersion: number };
const drained = (db: Db) => internals(db).pendingOps.length === 0 && !internals(db).opsFlushInFlight;

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** The manifest the fake server stores is the v0 base64 text of an AES-GCM envelope. */
const readStoredManifest = async () => {
  const text = new TextDecoder().decode(fake.objects.get(fake.manifestKey!)!);
  const plain = await decryptBytesToBytes(KEY, new Uint8Array(Buffer.from(text, "base64")));
  return JSON.parse(new TextDecoder().decode(plain)) as {
    dbSizeBytes: number;
    chunks: Array<{ hash: string; size: number }>;
  };
};

const readStoredSnapshotCiphertext = async () => {
  const manifest = await readStoredManifest();
  const parts = manifest.chunks.map((chunk) => fake.objects.get(`library/chunks/${chunk.hash}`)!);
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return { manifest, ciphertext: out };
};

const publishedBootstrap = async () => {
  const db = await LibraryDb.open(TOKEN, KEY);
  db.setSyncEnabled(true);
  const mediaId = await db.addMediaFromCatalog(MOVIE);
  await waitFor("seed ops flushed", () => drained(db));
  await db.flushPending();
  return { db, mediaId };
};

describe("storage format v2 compression (LIB-FMT-07) and v1 compatibility (LIB-FMT-02)", () => {
  it("writes the saved copy and every change compressed, and a second device opens them", async () => {
    log("phase:bootstrap on an empty fake API");
    const { db, mediaId } = await publishedBootstrap();
    log("state:server", { version: fake.version, snapshotVersion: fake.snapshotVersion, ops: fake.ops.length, objects: fake.objects.size });
    expect(fake.exists).toBe(true);

    const { manifest, ciphertext } = await readStoredSnapshotCiphertext();
    const plain = await decryptBytesToBytes(KEY, ciphertext);
    log("state:snapshot", { dbSizeBytes: manifest.dbSizeBytes, encryptedBytes: ciphertext.length, framed: isCompressedFrame(plain) });
    expect(isCompressedFrame(plain)).toBe(true);
    expect(ciphertext.length).toBeLessThan(manifest.dbSizeBytes / 2);
    expect((await decryptLibraryPayload(KEY, ciphertext)).length).toBe(manifest.dbSizeBytes);

    const opPlains = await Promise.all(
      fake.ops.map((op) => decryptBytesToBytes(KEY, new Uint8Array(Buffer.from(op.payloadCiphertext, "base64"))))
    );
    log("state:ops", { sizes: opPlains.map((p) => p.length), framed: opPlains.map(isCompressedFrame) });
    expect(opPlains.length).toBeGreaterThan(0);
    // every change is framed (LIB-FMT-07) and inflates to a LibraryOp
    expect(opPlains.every(isCompressedFrame)).toBe(true);
    for (const op of fake.ops) {
      const decoded = await decryptLibraryPayload(KEY, new Uint8Array(Buffer.from(op.payloadCiphertext, "base64")));
      expect((JSON.parse(new TextDecoder().decode(decoded)) as LibraryOp).type).toBeTruthy();
    }
    db.close();

    log("phase:second device opens the v2 library");
    useFreshRoot();
    const second = await LibraryDb.open(TOKEN, KEY);
    log("state:second", { title: second.getMediaDetails(mediaId)?.title ?? null });
    expect(second.getMediaDetails(mediaId)?.title).toBe(MOVIE.title);
    second.close();
  }, 30_000);

  it("opens a v1 library: plain SQLite snapshot and plain op JSON under AES-GCM", async () => {
    const { db, mediaId } = await publishedBootstrap();
    const { ciphertext } = await readStoredSnapshotCiphertext();
    const dbBytes = await decryptLibraryPayload(KEY, ciphertext);
    expect(isCompressedFrame(dbBytes)).toBe(false);
    db.close();

    // Rebuild what a v1 app stored: the SQLite bytes themselves under AES-GCM, chunked.
    const v1Cipher = await encryptBytesToBytes(KEY, dbBytes);
    const chunkSize = 64 * 1024;
    const chunks: Array<{ index: number; hash: string; size: number }> = [];
    for (let offset = 0, index = 0; offset < v1Cipher.length; offset += chunkSize, index += 1) {
      const slice = v1Cipher.slice(offset, offset + chunkSize);
      const hash = sha(slice);
      fake.objects.set(`library/chunks/${hash}`, slice);
      chunks.push({ index, hash, size: slice.length });
    }
    const manifest = {
      schemaVersion: 1,
      snapshotId: fake.snapshotId,
      createdAt: new Date().toISOString(),
      dbSizeBytes: dbBytes.length,
      chunkSizeBytes: chunkSize,
      chunkCount: chunks.length,
      chunks,
      encryption: { algorithm: "AES-256-GCM", ivSize: 12, tagSize: 16 },
      dbHash: sha(dbBytes),
    };
    const manifestEnvelope = await encryptBytesToBytes(KEY, new TextEncoder().encode(JSON.stringify(manifest)));
    fake.objects.set(fake.manifestKey!, new TextEncoder().encode(Buffer.from(manifestEnvelope).toString("base64")));
    log("state:v1-library", { dbBytes: dbBytes.length, v1CipherBytes: v1Cipher.length, chunks: chunks.length });

    // a v1 device then saves a progress change: plain op JSON
    const op = {
      id: randomBytes(16).toString("hex"),
      type: "media.progress",
      createdAt: new Date().toISOString(),
      payload: { mediaId, progressPct: 41, updatedAt: new Date().toISOString() },
    };
    const plainOp = await encryptBytesToBytes(KEY, new TextEncoder().encode(JSON.stringify(op)));
    fake.version += 1;
    fake.ops.push({ version: fake.version, opId: op.id, payloadCiphertext: Buffer.from(plainOp).toString("base64"), createdAt: op.createdAt });
    fake.stateHash = "v1-device";
    fake.lastOpId = op.id;

    useFreshRoot();
    const opened = await LibraryDb.open(TOKEN, KEY);
    log("state:opened-v1", { title: opened.getMediaDetails(mediaId)?.title ?? null, progressPct: opened.getMediaDetails(mediaId)?.progressPct ?? null });
    expect(opened.getMediaDetails(mediaId)?.title).toBe(MOVIE.title);
    expect(opened.getMediaDetails(mediaId)?.progressPct).toBe(41);
    opened.close();
  }, 30_000);

  it("a v2 frame and a v1 plain op mix in one op log and both apply", async () => {
    const { db, mediaId } = await publishedBootstrap();
    const baseline = fake.version;
    const pushOp = async (progressPct: number, framed: boolean) => {
      const op = {
        id: randomBytes(16).toString("hex"),
        type: "media.progress",
        createdAt: new Date().toISOString(),
        payload: { mediaId, progressPct, updatedAt: new Date().toISOString() },
      };
      const bytes = new TextEncoder().encode(JSON.stringify(op));
      const payload = framed ? await encryptSnapshotBytes(KEY, bytes) : await encryptBytesToBytes(KEY, bytes);
      fake.version += 1;
      fake.ops.push({ version: fake.version, opId: op.id, payloadCiphertext: Buffer.from(payload).toString("base64"), createdAt: op.createdAt });
      fake.stateHash = `remote-${fake.version}`;
      fake.lastOpId = op.id;
    };
    await pushOp(20, false);
    await pushOp(55, true);
    log("state:before-sync", { baseline, serverVersion: fake.version });
    const prepared = await db.prepareRemoteSync(null);
    const outcome = await db.applyPreparedRemoteSync(prepared);
    log("state:after-sync", { kind: prepared.kind, outcome, progressPct: db.getMediaDetails(mediaId)?.progressPct ?? null });
    expect(prepared.kind).toBe("ops");
    expect(db.getMediaDetails(mediaId)?.progressPct).toBe(55);
    db.close();
  }, 30_000);
});
