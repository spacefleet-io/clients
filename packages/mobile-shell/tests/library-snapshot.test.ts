/**
 * @test-id MOBILE-SHELL-LIBRARY-SNAPSHOT-001
 * @level unit
 * @why Parrot's phone app opens its library snapshot in memory through the shared reader, and Badger reuses its
 *   manifest decoders. These tests build a snapshot the way the writers do (v1 `0x00 SBL` manifest header, chunked
 *   AES-256-GCM envelope, v2 compressed frame) and pin that the reader returns the exact SQLite bytes, still reads a
 *   legacy base64-text manifest, refuses a too-new storage version before decrypting, and reports a wrong key.
 */
import nodeCrypto from "node:crypto";
import zlib from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { LibraryFormatTooNewError } from "@space/library-db-definition/compatibility";
import { encodeCompressedFrame, type DeflateCodec } from "@space/library-db-definition/payloadCompression";
import { encodeStorageHeader, STORAGE_OBJECT_KIND } from "@space/library-db-definition/storageFormat";
import { base64ToBytes, decodeManifestBytes, decodeStoredManifest, openRemoteLibrarySnapshot } from "../src/librarySnapshot";

const codec: DeflateCodec = {
  deflateRaw: (bytes) => new Uint8Array(zlib.deflateRawSync(bytes)),
  inflateRaw: (bytes) => new Uint8Array(zlib.inflateRawSync(bytes)),
};

const seal = (keyBase64: string, plain: Uint8Array) => {
  const iv = nodeCrypto.randomBytes(12);
  const cipher = nodeCrypto.createCipheriv("aes-256-gcm", Buffer.from(keyBase64, "base64"), iv);
  return new Uint8Array(Buffer.concat([iv, cipher.update(plain), cipher.final(), cipher.getAuthTag()]));
};

const open = async (keyBase64: string, envelope: Uint8Array) => {
  const decipher = nodeCrypto.createDecipheriv(
    "aes-256-gcm",
    Buffer.from(keyBase64, "base64"),
    envelope.subarray(0, 12)
  );
  decipher.setAuthTag(envelope.subarray(envelope.length - 16));
  return new Uint8Array(Buffer.concat([decipher.update(envelope.subarray(12, envelope.length - 16)), decipher.final()]));
};

const concat = (...parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts));

const key = nodeCrypto.randomBytes(32).toString("base64");

/** A stored snapshot: SQLite-ish bytes, framed, sealed, cut into `chunkSize` chunks under content hashes. */
const buildSnapshot = (dbBytes: Uint8Array, chunkSize: number) => {
  const envelope = seal(key, encodeCompressedFrame(dbBytes, codec));
  const objects = new Map<string, Uint8Array>();
  const chunks: Array<{ index: number; hash: string; size: number }> = [];
  for (let offset = 0, index = 0; offset < envelope.length; offset += chunkSize, index += 1) {
    const part = envelope.subarray(offset, offset + chunkSize);
    const hash = nodeCrypto.createHash("sha256").update(part).digest("hex");
    objects.set(`library/chunks/${hash}`, part);
    chunks.push({ index, hash, size: part.length });
  }
  const manifest = {
    schemaVersion: 1,
    snapshotId: "s1",
    createdAt: "2026-11-06T00:00:00.000Z",
    dbSizeBytes: dbBytes.length,
    chunkSizeBytes: chunkSize,
    chunkCount: chunks.length,
    // Listed out of order: the reader must sort by index.
    chunks: [...chunks].reverse(),
    encryption: { algorithm: "AES-256-GCM", ivSize: 12, tagSize: 16 },
    dbHash: "",
  };
  const manifestKey = "library/parrot/manifests/m1";
  objects.set(
    manifestKey,
    concat(encodeStorageHeader(STORAGE_OBJECT_KIND.manifest, 2), seal(key, new TextEncoder().encode(JSON.stringify(manifest))))
  );
  return { objects, manifestKey };
};

describe("openRemoteLibrarySnapshot", () => {
  it("returns the SQLite bytes from a chunked, framed, encrypted snapshot", async () => {
    const dbBytes = concat(new TextEncoder().encode("SQLite format 3\0"), nodeCrypto.randomBytes(5000));
    const { objects, manifestKey } = buildSnapshot(dbBytes, 1024);
    const download = vi.fn(async (objectKey: string) => objects.get(objectKey)!);

    const result = await openRemoteLibrarySnapshot(key, {
      getLibraryDb: async () => ({ exists: true, manifestKey, snapshotVersion: 7, version: 9 }),
      download,
      decrypt: open,
      inflate: codec,
      supportedStorageFormatVersion: 2,
    });

    expect(Buffer.from(result.dbBytes).equals(Buffer.from(dbBytes))).toBe(true);
    expect(result.snapshotVersion).toBe(7);
    expect(download).toHaveBeenCalledTimes(1 + result.manifest.chunkCount);
  });

  it("LIBRARY_MISSING when the app has no snapshot yet", async () => {
    await expect(
      openRemoteLibrarySnapshot(key, {
        getLibraryDb: async () => ({ exists: false, manifestKey: null, version: 0 }),
        download: async () => new Uint8Array(),
        decrypt: open,
        inflate: codec,
        supportedStorageFormatVersion: 2,
      })
    ).rejects.toThrow("LIBRARY_MISSING");
  });

  it("DECRYPT_FAILED with another account's key", async () => {
    const { objects, manifestKey } = buildSnapshot(nodeCrypto.randomBytes(100), 64);
    await expect(
      openRemoteLibrarySnapshot(nodeCrypto.randomBytes(32).toString("base64"), {
        getLibraryDb: async () => ({ exists: true, manifestKey, version: 1 }),
        download: async (objectKey) => objects.get(objectKey)!,
        decrypt: open,
        inflate: codec,
        supportedStorageFormatVersion: 2,
      })
    ).rejects.toThrow("DECRYPT_FAILED");
  });
});

describe("decodeStoredManifest", () => {
  const plain = new TextEncoder().encode('{"schemaVersion":1}');

  it("reads a legacy manifest stored as base64 text", async () => {
    const stored = new TextEncoder().encode(Buffer.from(seal(key, plain)).toString("base64"));
    expect(new TextDecoder().decode(await decodeStoredManifest(key, stored, 2, open))).toBe('{"schemaVersion":1}');
  });

  it("refuses a too-new storage version before decrypting", async () => {
    const decrypt = vi.fn(open);
    const stored = concat(encodeStorageHeader(STORAGE_OBJECT_KIND.manifest, 999), seal(key, plain));
    await expect(decodeStoredManifest(key, stored, 2, decrypt)).rejects.toBeInstanceOf(LibraryFormatTooNewError);
    expect(decrypt).not.toHaveBeenCalled();
  });
});

describe("base64 helpers", () => {
  it("base64ToBytes matches Buffer for every padding length", () => {
    for (const size of [0, 1, 2, 3, 31, 32, 33]) {
      const bytes = nodeCrypto.randomBytes(size);
      expect(Buffer.from(base64ToBytes(bytes.toString("base64"))).equals(bytes)).toBe(true);
    }
  });

  it("decodeManifestBytes leaves binary bytes alone", () => {
    const binary = new Uint8Array([0, 1, 2, 255, ...nodeCrypto.randomBytes(60)]);
    expect(decodeManifestBytes(binary)).toBe(binary);
  });
});
