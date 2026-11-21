/**
 * @test-id MOBILE-LIBRARY-SNAPSHOT-REBASE-001
 * @level unit
 * @bugfix
 * @regression-proof
 *
 * Why this exists (LIB-SYNC-14, 0.1.17 on op9 with a 17 MB library): the compaction snapshot was PUT on the server
 * version read BEFORE a 52 s build. The phone's own ops moved the server meanwhile, so the PUT got 409
 * version_conflict, and a second flush's compaction queued behind the first and rebuilt the whole snapshot again
 * (second OOM, second 52 s freeze). A snapshot that already holds every change up to the server's current version is
 * valid on that version: it must go out there as it is, and concurrent compactions must build once.
 * These tests drive the real LibraryDb over an in-memory filesystem and a fake server.
 */
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as SharedApi from "@space/shared/api";
// vi.mock calls below are hoisted above these imports.
import { LibraryDb } from "../src/lib/libraryDb";
import * as storage from "../src/lib/libraryStorage";

const TAG = "[library-snapshot-rebase]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const h = vi.hoisted(() => ({
  files: new Map<string, string>(),
  encryptCount: 0,
  snapshotCount: 0,
  serverVersion: 6,
  putCalls: [] as Array<{ expectedVersion: number; snapshotId: string }>,
  putAnswers: [] as Array<{ conflictAt: number } | "ok">,
}));

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

vi.mock("react-native", async () => ({ ...(await import("./setup/reactNativeMock")).reactNativeBase(), Platform: { OS: "android" } }));
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
    getLibraryMeta: async () => ({
      exists: true,
      version: h.serverVersion,
      snapshotVersion: 6,
      snapshotHistory: [],
      keyProbe: null,
    }),
    putLibraryDb: async (...args: unknown[]) => {
      const call = { expectedVersion: Number(args[1]), snapshotId: String(args[3]) };
      h.putCalls.push(call);
      const answer = h.putAnswers.shift() ?? "ok";
      if (answer !== "ok") {
        h.serverVersion = answer.conflictAt;
        throw new actual.ApiError(409, { error: "version_conflict", version: answer.conflictAt });
      }
      if (call.expectedVersion !== h.serverVersion) {
        throw new actual.ApiError(409, { error: "version_conflict", version: h.serverVersion });
      }
      h.serverVersion += 1;
      return { version: h.serverVersion, stateHash: null, lastOpId: null, snapshotVersion: h.serverVersion };
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
  encryptDbToBinaryFile: async (_db: string, _key: string, target: string) => {
    h.encryptCount += 1;
    h.files.set(target, `ciphertext-${h.encryptCount}`);
  },
  buildChunkIndexFromFile: async (path: string) => {
    const value = h.files.get(path) ?? "";
    return { chunks: [{ hash: sha(value), size: value.length, offset: 0 }], totalSize: value.length };
  },
  hashDbFile: async () => ({ sizeBytes: 3, hash: "db-hash" }),
  getLatestSnapshotMs: () => null,
  selectSnapshotsForRetention: () => [],
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
  maybeCompactAfterOps(): Promise<void>;
  pendingSync: { snapshotId: string } | null;
  opsFlushInFlight: boolean;
  durableVersion: number;
  remoteVersion: number;
  snapshotOps: { snapshotVersion: number; count: number; bytes: number; bytesThreshold: number } | null;
};

const openDb = (version: number): LibraryDbSeam => {
  const fakeDb = {
    executeSql: async () => [{ rows: { length: 0, item: () => ({}) } }],
    sqlBatch: async () => undefined,
    close: async () => undefined,
  };
  // The constructor is private (LibraryDb.open runs the network bootstrap).
  const Ctor = LibraryDb as unknown as new (...args: unknown[]) => LibraryDbSeam;
  const db = new Ctor("token", "key", fakeDb, fakeDb, fakeDb, fakeDb, version, version, null, []);
  db.opsFlushInFlight = true;
  return db;
};

const dump = (label: string, db: LibraryDbSeam) =>
  console.error(
    `${TAG} FAIL ${label} ${JSON.stringify({
      putCalls: h.putCalls,
      encryptCount: h.encryptCount,
      serverVersion: h.serverVersion,
      pending: db.pendingSync,
    })}`
  );

beforeEach(() => {
  h.files.clear();
  h.encryptCount = 0;
  h.snapshotCount = 0;
  h.serverVersion = 6;
  h.putCalls = [];
  h.putAnswers = [];
});

describe("a compaction snapshot is published on the server's current version, never rebuilt (LIB-SYNC-14)", () => {
  it("publishes on the version read right before the PUT when the snapshot covers it", async () => {
    // The phone's own ops v7..v9 landed before the build started; meta was read at v6 (the 0.1.17 timeline).
    const db = openDb(9);
    h.serverVersion = 9;
    log("phase:uploadSnapshot on stale expectedVersion 6", { durableVersion: db.durableVersion });
    await db.uploadSnapshot(6);
    log("phase:done", { putCalls: h.putCalls, encryptCount: h.encryptCount });
    try {
      expect(h.putCalls.map((call) => call.expectedVersion)).toEqual([9]);
      expect(h.encryptCount).toBe(1);
      expect(db.remoteVersion).toBe(10);
      expect(db.pendingSync).toBeNull();
      expect(await storage.loadPending()).toBeNull();
    } catch (error) {
      dump("rebased", db);
      throw error;
    }
  });

  it("a 409 naming a version the snapshot still covers is retried once on that version, no rebuild", async () => {
    const db = openDb(8);
    h.serverVersion = 6;
    h.putAnswers.push({ conflictAt: 8 });
    await db.uploadSnapshot(6);
    log("phase:done", { putCalls: h.putCalls, encryptCount: h.encryptCount });
    try {
      expect(h.putCalls.map((call) => call.expectedVersion)).toEqual([6, 8]);
      expect(h.putCalls[1]?.snapshotId).toBe(h.putCalls[0]?.snapshotId);
      expect(h.encryptCount).toBe(1);
      expect(db.pendingSync).toBeNull();
    } catch (error) {
      dump("retried", db);
      throw error;
    }
  });

  it("a snapshot the server has moved past is dropped, never published on a version it does not hold", async () => {
    const db = openDb(6);
    h.serverVersion = 6;
    h.putAnswers.push({ conflictAt: 11 });
    await db.uploadSnapshot(6);
    log("phase:done", { putCalls: h.putCalls, encryptCount: h.encryptCount });
    try {
      expect(h.putCalls.map((call) => call.expectedVersion)).toEqual([6]);
      expect(db.pendingSync).toBeNull();
      expect(await storage.loadPending()).toBeNull();
    } catch (error) {
      dump("stale", db);
      throw error;
    }
  });

  it("two flushes finishing together build one snapshot", async () => {
    const db = openDb(6);
    db.snapshotOps = { snapshotVersion: 6, count: 10_000, bytes: 0, bytesThreshold: Number.MAX_SAFE_INTEGER };
    await Promise.all([db.maybeCompactAfterOps(), db.maybeCompactAfterOps()]);
    log("phase:done", { putCalls: h.putCalls, encryptCount: h.encryptCount });
    try {
      expect(h.encryptCount).toBe(1);
      expect(h.putCalls).toHaveLength(1);
    } catch (error) {
      dump("single-flight", db);
      throw error;
    }
  });
});
