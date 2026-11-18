import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  decryptBase64ToBytes,
  decryptBytesToBytes,
  encryptBytesToBase64,
  encryptBytesToBytes,
  importAesGcmKey,
} from "../src/crypto";
import {
  clearCache,
  clearPending,
  clearPendingOps,
  getCacheDbPath,
  loadCache,
  loadPending,
  loadPendingOps,
  saveCache,
  savePending,
  savePendingManifestBytes,
  savePendingSnapshotBytes,
} from "../src/libraryDbStorage";

const keyBase64 = Buffer.from("0123456789abcdef0123456789abcdef", "utf8").toString("base64");

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-runtime-store-"));
  process.env.SF_USER_DATA_PATH = root;
  console.info(`[crypto-and-storage:setup] root=${root}`);
});

afterEach(async () => {
  await clearPending();
  await clearPendingOps();
  await clearCache();
  console.info(`[crypto-and-storage:teardown] cleared pending/cache, removing root=${root}`);
  rmSync(root, { recursive: true, force: true });
  delete process.env.SF_USER_DATA_PATH;
});

// Suite-id: crypto-and-storage
// Dump key state, encrypted payload byte counts, and storage file listing
// under the active root.
const dumpCryptoSnapshot = async (
  label: string,
  ctx: {
    keyBase64Len?: number;
    plainLen?: number;
    enc64Len?: number;
    encBytesLen?: number;
    decryptError?: unknown;
    cache?: unknown;
    pending?: unknown;
    pendingOps?: unknown;
  },
) => {
  try {
    console.error(`=== [crypto-and-storage:${label}] snapshot ===`);
    if (ctx.keyBase64Len !== undefined) console.error(`key base64 length=${ctx.keyBase64Len}`);
    if (ctx.plainLen !== undefined) console.error(`plaintext length=${ctx.plainLen}`);
    if (ctx.enc64Len !== undefined) console.error(`encrypted base64 length=${ctx.enc64Len}`);
    if (ctx.encBytesLen !== undefined) console.error(`encrypted bytes length=${ctx.encBytesLen}`);
    if (ctx.decryptError !== undefined) {
      const e = ctx.decryptError;
      console.error(
        `decrypt error=${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
      );
    }
    if (ctx.cache !== undefined) console.error(`cache=${JSON.stringify(ctx.cache)}`);
    if (ctx.pending !== undefined) console.error(`pending=${JSON.stringify(ctx.pending)}`);
    if (ctx.pendingOps !== undefined) console.error(`pendingOps=${JSON.stringify(ctx.pendingOps)}`);

    // Filesystem state under the test root.
    const libraryDir = join(root, "library");
    if (existsSync(libraryDir)) {
      try {
        const Bun = (globalThis as { Bun?: { Glob?: new (pattern: string) => { scanSync: (cwd: string) => Iterable<string> } } }).Bun;
        const entries: string[] = [];
        if (Bun?.Glob) {
          const glob = new Bun.Glob("**/*");
          for (const name of glob.scanSync(libraryDir)) {
            try {
              const stat = statSync(join(libraryDir, name));
              entries.push(`${name} (${stat.size}B)`);
            } catch {
              entries.push(name);
            }
          }
        }
        console.error(`libraryDir entries (${entries.length})=${JSON.stringify(entries)}`);
      } catch (e) {
        console.error(`(libraryDir scan failed: ${e instanceof Error ? e.message : String(e)})`);
      }
    } else {
      console.error(`libraryDir does not exist: ${libraryDir}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("runtime crypto + storage", () => {
  it("encrypts/decrypts payload using AES-GCM (base64 + bytes)", async () => {
    const plain = new TextEncoder().encode("hello-spacebadger");
    console.info(
      `[crypto-and-storage:roundtrip] plain.length=${plain.length} key.base64.length=${keyBase64.length}`,
    );

    let enc64: string | null = null;
    let encBytes: Uint8Array | null = null;
    let dec64: Uint8Array | null = null;
    let decBytes: Uint8Array | null = null;
    let crossKeyError: unknown;
    try {
      enc64 = await encryptBytesToBase64(keyBase64, plain);
      console.info(`[crypto-and-storage:roundtrip] enc64.length=${enc64.length}`);
      dec64 = await decryptBase64ToBytes(keyBase64, enc64);
      expect(new TextDecoder().decode(dec64)).toBe("hello-spacebadger");

      encBytes = await encryptBytesToBytes(keyBase64, plain);
      console.info(`[crypto-and-storage:roundtrip] encBytes.length=${encBytes.length}`);
      decBytes = await decryptBytesToBytes(keyBase64, encBytes);
      expect(new TextDecoder().decode(decBytes)).toBe("hello-spacebadger");

      const otherKeyBase64 = Buffer.from("fedcba9876543210fedcba9876543210", "utf8").toString("base64");
      console.info(`[crypto-and-storage:roundtrip] verifying cross-key decrypt rejects`);
      try {
        await decryptBytesToBytes(otherKeyBase64, encBytes);
      } catch (e) {
        crossKeyError = e;
      }
      await expect(decryptBytesToBytes(otherKeyBase64, encBytes)).rejects.toThrow();
    } catch (err) {
      console.error(`[crypto-and-storage:roundtrip] assertion failed`);
      await dumpCryptoSnapshot("roundtrip-failure", {
        keyBase64Len: keyBase64.length,
        plainLen: plain.length,
        enc64Len: enc64?.length,
        encBytesLen: encBytes?.length,
        decryptError: crossKeyError,
      });
      throw err;
    }
  });

  it("rejects invalid key size", async () => {
    const badKey = Buffer.from("short", "utf8").toString("base64");
    console.info(`[crypto-and-storage:invalid-key] badKey.length=${badKey.length}`);
    try {
      await expect(importAesGcmKey(badKey)).rejects.toThrow("INVALID_KEY");
    } catch (err) {
      console.error(`[crypto-and-storage:invalid-key] expected reject not raised correctly`);
      await dumpCryptoSnapshot("invalid-key-failure", {
        keyBase64Len: badKey.length,
      });
      throw err;
    }
  });

  it("migrates legacy cache blobBase64 into canonical sqlite file", async () => {
    const libraryDir = join(root, "library");
    mkdirSync(libraryDir, { recursive: true });
    const cachePath = join(libraryDir, "cache.json");
    const dbBytes = Buffer.from("sqlite-binary");

    console.info(
      `[crypto-and-storage:legacy-migrate] writing legacy cache.json with blobBase64 (len=${dbBytes.length})`,
    );
    writeFileSync(cachePath, JSON.stringify({
      version: 7,
      dbPath: "/tmp/legacy.sqlite",
      blobBase64: dbBytes.toString("base64"),
      updatedAt: "2026-02-14T10:00:00.000Z",
    }));

    let cache: Awaited<ReturnType<typeof loadCache>> | null = null;
    try {
      cache = await loadCache();
      console.info(
        `[crypto-and-storage:legacy-migrate] loadCache returned version=${cache?.version} ` +
          `dbPath=${cache?.dbPath}`,
      );
      expect(cache?.version).toBe(7);
      expect(cache?.dbPath).toBe(getCacheDbPath());
    } catch (err) {
      console.error(`[crypto-and-storage:legacy-migrate] assertion failed`);
      await dumpCryptoSnapshot("legacy-migrate-failure", { cache });
      throw err;
    }
  });

  it("saves cache and pending snapshot/manifest files", async () => {
    const dbPath = getCacheDbPath();
    mkdirSync(join(root, "library"), { recursive: true });
    writeFileSync(dbPath, Buffer.from("sqlite"));
    console.info(`[crypto-and-storage:save-cache] dbPath=${dbPath}`);

    let cache: Awaited<ReturnType<typeof loadCache>> | null = null;
    let snapshotPath: string | null = null;
    let manifestPath: string | null = null;
    let pending: Awaited<ReturnType<typeof loadPending>> | null = null;
    try {
      await saveCache({ version: 1, dbPath, updatedAt: "2026-02-14T10:00:00.000Z" });
      cache = await loadCache();
      console.info(`[crypto-and-storage:save-cache] cache.version=${cache?.version}`);
      expect(cache?.version).toBe(1);

      snapshotPath = await savePendingSnapshotBytes(new Uint8Array([1, 2, 3]));
      manifestPath = await savePendingManifestBytes(new Uint8Array([4, 5]));
      console.info(
        `[crypto-and-storage:save-cache] snapshotPath=${snapshotPath} manifestPath=${manifestPath}`,
      );
      expect(snapshotPath.endsWith("pending.snapshot")).toBe(true);
      expect(manifestPath.endsWith("pending.manifest")).toBe(true);

      await savePending({
        baseVersion: 3,
        snapshotId: "snapshot-e2e",
        chunkSize: 4 * 1024 * 1024,
        snapshotPath,
        manifestPath,
        updatedAt: "2026-02-15T10:10:00.000Z",
        keyProbe: "probe",
        stateHash: "state-hash",
        lastOpId: "op-3",
      });
      pending = await loadPending();
      console.info(
        `[crypto-and-storage:save-cache] pending.snapshotId=${pending?.snapshotId} ` +
          `baseVersion=${pending?.baseVersion} lastOpId=${pending?.lastOpId}`,
      );
      expect(pending?.snapshotId).toBe("snapshot-e2e");
      expect(pending?.baseVersion).toBe(3);
      expect(pending?.stateHash).toBe("state-hash");
      expect(pending?.lastOpId).toBe("op-3");
    } catch (err) {
      console.error(`[crypto-and-storage:save-cache] assertion failed`);
      await dumpCryptoSnapshot("save-cache-failure", { cache, pending });
      throw err;
    }
  });

  it("persists and filters pending ops across reloads", async () => {
    console.info(`[crypto-and-storage:pending-ops] saving 1 valid + 1 invalid pending op`);
    // Written as raw JSON (not via savePendingOps) because the invalid entry
    // deliberately violates the PendingOp type.
    mkdirSync(join(root, "library"), { recursive: true });
    writeFileSync(
      join(root, "library", "pending_ops.json"),
      JSON.stringify([
        {
          id: "op-1",
          createdAt: "2026-02-15T10:00:00.000Z",
          type: "setting.set",
          payload: { key: "language", value: "fr" },
        },
        {
          // invalid entry should be filtered out by loader
          id: 42,
          createdAt: "2026-02-15T10:00:01.000Z",
          type: "setting.set",
          payload: {},
        },
      ]),
    );

    let ops: Awaited<ReturnType<typeof loadPendingOps>> = [];
    try {
      ops = await loadPendingOps();
      console.info(
        `[crypto-and-storage:pending-ops] loaded ops.length=${ops.length} ` +
          `first.id=${ops[0]?.id} first.type=${ops[0]?.type}`,
      );
      expect(ops).toHaveLength(1);
      expect(ops[0]?.id).toBe("op-1");
      expect(ops[0]?.type).toBe("setting.set");
    } catch (err) {
      console.error(`[crypto-and-storage:pending-ops] assertion failed`);
      await dumpCryptoSnapshot("pending-ops-failure", { pendingOps: ops });
      throw err;
    }
  });
});
