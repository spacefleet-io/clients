/**
 * @test-id MOBILE-LIBRARY-PENDING-CHUNKREFS-001
 * @level unit
 * @bugfix
 * @regression-proof
 *
 * Why this exists (PR #143 re-review P1): the storage orphan sweep deletes a
 * user's chunks that no snapshot_history entry names. Mobile uploadSnapshot
 * encrypted the pending snapshot into the shared cache blob; when the publish
 * failed, the next local edit ran persist(), which re-encrypted that same file
 * with a fresh IV, and flushPending then re-indexed it and published the OLD
 * manifest with the NEW hashes as chunkRefs. The server then protected chunks
 * the manifest never reads and none it does, so the sweep could delete a live
 * snapshot's chunks. These tests drive the real LibraryDb class over an
 * in-memory filesystem and fake transport.
 */
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as SharedApi from "@space/shared/api";
// vi.mock calls below are hoisted above these imports.
import { LibraryDb } from "../src/lib/libraryDb";
import * as storage from "../src/lib/libraryStorage";

const TAG = "[library-pending-snapshot-chunkrefs]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const h = vi.hoisted(() => ({
  files: new Map<string, string>(),
  encryptCount: 0,
  snapshotCount: 0,
  putCalls: [] as Array<{ snapshotId: string; chunkRefs: string[]; chunkRefsSource: unknown }>,
  putOutcomes: [] as Array<"fail" | "ok">,
}));

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

vi.mock("react-native", async () => ({ ...(await import("./setup/reactNativeMock")).reactNativeBase(), Platform: { OS: "ios" } }));
vi.mock("react-native-fs", () => ({
  default: {
    DocumentDirectoryPath: "/docs",
    exists: async (path: string) => h.files.has(path) || path === "/docs/library",
    mkdir: async () => undefined,
    readFile: async (path: string) => {
      const value = h.files.get(path);
      if (value === undefined) throw new Error(`ENOENT ${path}`);
      return value;
    },
    writeFile: async (path: string, data: string) => {
      h.files.set(path, data);
    },
    unlink: async (path: string) => {
      h.files.delete(path);
    },
    moveFile: async (from: string, to: string) => {
      const value = h.files.get(from);
      if (value === undefined) throw new Error(`ENOENT ${from}`);
      h.files.set(to, value);
      h.files.delete(from);
    },
  },
}));
vi.mock("react-native-sqlite-storage", () => ({ default: { enablePromise: () => undefined, openDatabase: () => undefined } }));
vi.mock("react-native-quick-crypto", () => ({ default: { randomUUID: () => "uuid" } }));
vi.mock("@space/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof SharedApi>();
  return {
    ...actual,
    getLibraryMeta: async () => {
      throw new Error("offline in test");
    },
    putLibraryDb: async (...args: unknown[]) => {
      const call = {
        snapshotId: String(args[3]),
        chunkRefs: (args[10] as string[] | undefined) ?? [],
        chunkRefsSource: args[11],
      };
      h.putCalls.push(call);
      if ((h.putOutcomes.shift() ?? "ok") === "fail") throw new actual.ApiError(503, { error: "service_unavailable" });
      return { version: 7, stateHash: null, lastOpId: null, snapshotVersion: 7 };
    },
  };
});
vi.mock("../src/lib/library/transport", () => ({
  CHUNK_SIZE_BYTES: 4 * 1024 * 1024,
  uploadChunksFromFile: async () => undefined,
}));
vi.mock("../src/lib/library/dbFiles", () => {
  const fakeDb = {
    executeSql: async () => [{ rows: { length: 0, item: () => ({}) } }],
    sqlBatch: async () => undefined,
    close: async () => undefined,
  };
  return {
    IntegrityCheckFailedError: class extends Error {},
    ensureLibraryDir: async () => undefined,
    removeSnapshotDbFile: async () => undefined,
    openSnapshotDb: async () => fakeDb,
  };
});
vi.mock("../src/lib/library/snapshot", () => ({
  // Every encryption uses a fresh IV: same plaintext, different bytes.
  encryptDbToBinaryFile: async (_db: string, _key: string, target: string) => {
    h.encryptCount += 1;
    h.files.set(target, `ciphertext-${h.encryptCount}`);
  },
  buildChunkIndexFromFile: async (path: string) => {
    const value = h.files.get(path) ?? "";
    return { chunks: [{ hash: sha(value), size: value.length, offset: 0 }] };
  },
  hashDbFile: async () => ({ sizeBytes: 3, hash: "db-hash" }),
  buildManifest: (snapshotId: string, _db: { sizeBytes: number; hash: string }, chunks: Array<{ hash: string }>) => ({
    snapshotId,
    chunks: chunks.map((chunk) => chunk.hash),
  }),
  createKeyProbe: async () => "probe",
  createSnapshotId: () => {
    h.snapshotCount += 1;
    return `snap-${h.snapshotCount}`;
  },
  encodeUtf8: (value: string) => new TextEncoder().encode(value),
}));
vi.mock("../src/lib/crypto", () => ({
  encryptBytesToBytes: async (_key: string, bytes: Uint8Array) => bytes,
  decryptBase64ToBytes: async () => new Uint8Array(),
}));
vi.mock("../src/lib/librarySchema", () => ({}));

/** Private members the tests drive; LibraryDb exposes no public seam for them. */
type LibraryDbSeam = {
  uploadSnapshot(expectedVersion: number): Promise<void>;
  persist(): Promise<void>;
  flushPending(): Promise<void>;
  pendingSync: { snapshotId: string; snapshotPath: string; chunkRefs?: string[] } | null;
  opsFlushInFlight: boolean;
};

const openDb = (): LibraryDbSeam => {
  const fakeDb = {
    executeSql: async () => [{ rows: { length: 0, item: () => ({}) } }],
    sqlBatch: async () => undefined,
    close: async () => undefined,
  };
  // The constructor is private (LibraryDb.open runs the network bootstrap).
  const Ctor = LibraryDb as unknown as new (...args: unknown[]) => LibraryDbSeam;
  const db = new Ctor("token", "key", fakeDb, fakeDb, fakeDb, fakeDb, 6, 6, null, []);
  // Keep persist() from scheduling an ops-flush timer; ops are not under test.
  db.opsFlushInFlight = true;
  return db;
};

const dump = (label: string, db: LibraryDbSeam) =>
  console.error(
    `${TAG} FAIL ${label} ${JSON.stringify({ putCalls: h.putCalls, pending: db.pendingSync, files: [...h.files.keys()] })}`
  );

beforeEach(() => {
  h.files.clear();
  h.encryptCount = 0;
  h.snapshotCount = 0;
  h.putCalls = [];
  h.putOutcomes = [];
});

describe("mobile pending snapshot keeps the chunkRefs of its manifest", () => {
  it("a retry after a local edit publishes the original hashes, vouched", async () => {
    const db = openDb();
    h.putOutcomes.push("fail");
    log("phase:uploadSnapshot (publish fails with 503)");
    await expect(db.uploadSnapshot(6)).rejects.toThrow();
    const firstAttempt = h.putCalls[0];
    const persisted = await storage.loadPending();
    // A local edit no longer re-encrypts anything (LIB-STORE-05): the pending file stays as published.
    log("phase:local edit -> nothing re-encrypts", { firstAttempt, persisted, encryptCount: h.encryptCount });
    log("phase:flushPending retry");
    await db.flushPending();
    const retry = h.putCalls[1];
    log("phase:done", { retry, pending: db.pendingSync });
    try {
      expect(persisted?.chunkRefs, "the pending record must survive a restart with its hashes").toEqual(
        firstAttempt?.chunkRefs
      );
      expect(retry?.snapshotId).toBe(firstAttempt?.snapshotId);
      expect(retry?.chunkRefs, "the retry must publish the manifest's own chunk hashes").toEqual(firstAttempt?.chunkRefs);
      expect(retry?.chunkRefsSource).toEqual({ client: "badger-mobile", refsVersion: 2 });
      expect(db.pendingSync).toBeNull();
    } catch (error) {
      dump("retry", db);
      throw error;
    }
  });

  it("a pending file that no longer hashes to its recorded refs is dropped, never published", async () => {
    const db = openDb();
    h.putOutcomes.push("fail");
    await expect(db.uploadSnapshot(6)).rejects.toThrow();
    const pendingPath = db.pendingSync?.snapshotPath ?? "";
    log("phase:pending file rewritten under its record", { pendingPath });
    h.files.set(pendingPath, "ciphertext-rewritten");
    await db.flushPending();
    try {
      expect(h.putCalls.length, "a mismatched pending snapshot must not be published").toBe(1);
      expect(db.pendingSync).toBeNull();
    } catch (error) {
      dump("mismatch", db);
      throw error;
    }
  });
});
