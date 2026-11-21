/**
 * @test-id MOBILE-LIB-DSM-001
 * @level unit
 *
 * @bugfix
 * @regression-proof
 *
 * @why Mobile Part A5 (commit 301c9481) adds `decodeStoredManifest` — the mobile
 *   dual reader that handles both legacy v0 manifests (stored bytes = UTF-8 of a
 *   base64 string) and new v1 manifests (8-byte SBL header ‖ AES-GCM envelope).
 *
 *   The regression anchor for the v0 case: a raw `decryptBytesToBytes(key, v0Bytes)`
 *   fails (the stored bytes are text, not a crypto envelope), while
 *   `decodeStoredManifest(key, v0Bytes, support)` succeeds by UTF-8-decoding →
 *   base64-decoding → decrypting. This is the same class of bug as the desktop
 *   manifest-encoding bug fix.
 *
 *   The too-new gate (case 3) asserts that a v1 header with storageFormatVersion=999
 *   throws LibraryFormatTooNewError BEFORE any decrypt attempt — verified by
 *   passing a bogus key (real decrypt would throw INVALID_KEY, not the gate error).
 */

import { describe, expect, it, vi } from "vitest";
import nodeCrypto from "node:crypto";

// ---------------------------------------------------------------------------
// Mock react-native-quick-crypto with Node's real AES-GCM so encrypt/decrypt
// fixtures are genuine. The mobile crypto.ts calls randomBytes/createCipheriv/
// createDecipheriv — all delegated to Node crypto here.
// ---------------------------------------------------------------------------

vi.mock("react-native-quick-crypto", () => ({
  default: {
    randomBytes: (size: number) => nodeCrypto.randomBytes(size),
    createCipheriv: (alg: string, key: Uint8Array, iv: Uint8Array) => nodeCrypto.createCipheriv(alg, key, iv),
    createDecipheriv: (alg: string, key: Uint8Array, iv: Uint8Array) => nodeCrypto.createDecipheriv(alg, key, iv),
  },
}));

// ---------------------------------------------------------------------------
// Mock native modules that snapshot.ts imports but are irrelevant for
// decodeStoredManifest (which only uses crypto + storageFormat + compatibility).
// ---------------------------------------------------------------------------

vi.mock("react-native-fs", () => ({ default: {} }));

vi.mock("../src/native/LibrarySync", () => ({
  sha256File: vi.fn(),
  encryptSnapshotFile: vi.fn(),
  decryptSnapshotFile: vi.fn(),
  onLibrarySyncProgress: vi.fn(),
}));

vi.mock("../src/lib/library/transport", () => ({
  CHUNK_SIZE_BYTES: 4194304,
  FILE_SLICE_BYTES: 65536,
  readFileChunk: vi.fn(),
  downloadObjectViaTunnel: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports — dynamic so all vi.mock() calls are hoisted and in place first.
// ---------------------------------------------------------------------------

const { encryptBytesToBytes, decryptBytesToBytes } = await import("../src/lib/crypto");
const { decodeStoredManifest, encodeUtf8 } = await import("../src/lib/library/snapshot");
const { encodeStorageHeader, STORAGE_OBJECT_KIND } = await import(
  "@space/library-db-definition/storageFormat"
);
const { assertLibraryCompatible, currentLibrarySupport, LibraryFormatTooNewError } = await import(
  "@space/library-db-definition/compatibility"
);
// The read gate admits every op stream this build reads (LIB-FMT-13): READ_OP_STREAM_VERSION, not the written one.
const { READ_OP_STREAM_VERSION } = await import("@space/library-db-definition/ops");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** 32-byte base64 key for AES-256-GCM. */
const TEST_KEY_BASE64 = Buffer.alloc(32, 0x42).toString("base64");

/** LibrarySupport with current version constants and empty schema registries. */
const support = currentLibrarySupport({});

const MANIFEST_JSON = JSON.stringify({
  schemaVersion: 1,
  snapshotId: "snap-test-001",
  createdAt: "2026-01-01T00:00:00.000Z",
  dbSizeBytes: 4096,
  chunkSizeBytes: 4194304,
  chunkCount: 1,
  chunks: [{ index: 0, hash: "sha256-abc", size: 4096 }],
  encryption: { algorithm: "AES-256-GCM", ivSize: 12, tagSize: 16 },
  dbHash: "sha256-dbhash",
});

/**
 * Build v0 fixture: encrypt plaintext → packed AES-GCM envelope → base64
 * text → UTF-8 bytes. This is the legacy format: the stored bytes are the
 * UTF-8 encoding of a base64 string, not raw ciphertext.
 */
const buildV0Bytes = async () => {
  const plaintext = encodeUtf8(MANIFEST_JSON);
  const envelope = await encryptBytesToBytes(TEST_KEY_BASE64, plaintext);
  const base64Text = Buffer.from(envelope).toString("base64");
  return encodeUtf8(base64Text);
};

/**
 * Build v1 fixture: 8-byte SBL header ‖ AES-GCM envelope — the new format
 * written by the API after the manifest-encoding bug fix.
 */
const buildV1Bytes = async () => {
  const plaintext = encodeUtf8(MANIFEST_JSON);
  const envelope = await encryptBytesToBytes(TEST_KEY_BASE64, plaintext);
  const header = encodeStorageHeader(STORAGE_OBJECT_KIND.manifest, 1);
  const combined = new Uint8Array(header.length + envelope.length);
  combined.set(header, 0);
  combined.set(envelope, header.length);
  return combined;
};

// On assertion failure, dump enough state to diagnose the decode path offline:
// fixture byte shapes, header bytes (if any), and the support contract. Wrapped
// in try/catch so a dump failure can never mask the original assertion error.
const dumpDecodeManifestSnapshot = (
  label: string,
  ctx: {
    bytes?: Uint8Array;
    plaintext?: Uint8Array;
    parsed?: unknown;
    error?: unknown;
  },
) => {
  try {
    console.error(`=== [library-decode-stored-manifest:${label}] snapshot ===`);
    console.error(
      `support: opStreamVersion=${String(support.opStreamVersion)} storageFormatVersion=${String(support.storageFormatVersion)}`,
    );
    if (ctx.bytes) {
      const head = Array.from(ctx.bytes.slice(0, 12));
      console.error(
        `bytes: length=${ctx.bytes.length} head[0..12]=${JSON.stringify(head)}`,
      );
    }
    if (ctx.plaintext) {
      const text = Buffer.from(ctx.plaintext).toString("utf8").slice(0, 200);
      console.error(`plaintext: length=${ctx.plaintext.length} utf8[0..200]=${JSON.stringify(text)}`);
    }
    if (ctx.parsed !== undefined) {
      console.error(`parsed:\n${JSON.stringify(ctx.parsed, null, 2)}`);
    }
    if (ctx.error !== undefined) {
      const e = ctx.error;
      console.error(
        `error: name=${e instanceof Error ? e.name : typeof e} message=${e instanceof Error ? e.message : String(e)} surface=${String((e as { surface?: unknown })?.surface)} observed=${String((e as { observed?: unknown })?.observed)}`,
      );
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("decodeStoredManifest — v0 legacy manifest (Part A5)", () => {
  it(
    "@bugfix @regression-proof — v0 bytes fail raw decrypt but succeed through decodeStoredManifest",
    async () => {
      console.info("[library-decode-stored-manifest:v0-setup] building v0 fixture bytes");
      const v0Bytes = await buildV0Bytes();
      console.info(`[library-decode-stored-manifest:v0-setup] v0Bytes.length=${v0Bytes.length}`);

      // Regression anchor: raw decrypt of the v0 bytes must FAIL.
      // The stored bytes are the UTF-8 encoding of a base64 string — feeding
      // them straight to AES-GCM as if they were a raw IV‖ciphertext‖tag
      // envelope corrupts the IV and the MAC fails.
      console.info("[library-decode-stored-manifest:v0-raw-decrypt] expecting raw decrypt to reject");
      try {
        await expect(decryptBytesToBytes(TEST_KEY_BASE64, v0Bytes)).rejects.toThrow();
      } catch (err) {
        dumpDecodeManifestSnapshot("v0-raw-decrypt-unexpectedly-succeeded", { bytes: v0Bytes, error: err });
        throw err;
      }

      // The dual reader must succeed: it detects no header, UTF-8-decodes the
      // bytes to the base64 text, base64-decodes to the envelope, then decrypts.
      console.info("[library-decode-stored-manifest:v0-decode] decoding via decodeStoredManifest");
      const plaintext = await decodeStoredManifest(TEST_KEY_BASE64, v0Bytes, support);
      const parsed = JSON.parse(Buffer.from(plaintext).toString("utf8"));
      console.info(`[library-decode-stored-manifest:v0-decode] decoded snapshotId=${String((parsed as { snapshotId?: unknown }).snapshotId)}`);
      try {
        expect(parsed).toMatchObject({ snapshotId: "snap-test-001", schemaVersion: 1 });
      } catch (err) {
        dumpDecodeManifestSnapshot("v0-decode-mismatch", { bytes: v0Bytes, plaintext, parsed });
        throw err;
      }
    }
  );
});

describe("decodeStoredManifest — v1 headered manifest (Part A5)", () => {
  it("v1 bytes succeed: header stripped, envelope decrypted, same plaintext as v0", async () => {
    console.info("[library-decode-stored-manifest:v1-setup] building v0 + v1 fixtures");
    const v0Bytes = await buildV0Bytes();
    const v1Bytes = await buildV1Bytes();
    console.info(`[library-decode-stored-manifest:v1-setup] v0Bytes.length=${v0Bytes.length} v1Bytes.length=${v1Bytes.length}`);

    console.info("[library-decode-stored-manifest:v1-decode] decoding both formats");
    const v0Plain = await decodeStoredManifest(TEST_KEY_BASE64, v0Bytes, support);
    const v1Plain = await decodeStoredManifest(TEST_KEY_BASE64, v1Bytes, support);

    // Same key + same manifest JSON → same decrypted plaintext regardless of
    // the storage format version.
    try {
      expect(Buffer.from(v0Plain).toString("utf8")).toBe(Buffer.from(v1Plain).toString("utf8"));
      expect(JSON.parse(Buffer.from(v1Plain).toString("utf8"))).toMatchObject({
        snapshotId: "snap-test-001",
      });
    } catch (err) {
      dumpDecodeManifestSnapshot("v1-plaintext-mismatch", { bytes: v1Bytes, plaintext: v1Plain });
      console.error(`=== [library-decode-stored-manifest:v1-plaintext-mismatch] v0-plain ===`);
      console.error(`v0 utf8[0..200]=${JSON.stringify(Buffer.from(v0Plain).toString("utf8").slice(0, 200))}`);
      throw err;
    }
  });
});

describe("decodeStoredManifest — too-new storage version (Part A5)", () => {
  it(
    "storageFormatVersion=999 throws LibraryFormatTooNewError BEFORE decrypt " +
      "(bogus key proves the gate fires first, not an INVALID_KEY decrypt error)",
    async () => {
      console.info("[library-decode-stored-manifest:too-new-setup] building v1 header with storageFormatVersion=999");
      const envelope = await encryptBytesToBytes(TEST_KEY_BASE64, encodeUtf8("x"));
      const header = encodeStorageHeader(STORAGE_OBJECT_KIND.manifest, 999);
      const tooNewBytes = new Uint8Array(header.length + envelope.length);
      tooNewBytes.set(header, 0);
      tooNewBytes.set(envelope, header.length);
      console.info(`[library-decode-stored-manifest:too-new-setup] tooNewBytes.length=${tooNewBytes.length} headerBytes=${JSON.stringify(Array.from(header))}`);

      // A wrong-length key would throw INVALID_KEY inside decryptBytesToBytes.
      // If LibraryFormatTooNewError is thrown instead, the version gate fired first.
      const BOGUS_KEY = "not-a-valid-key";
      console.info("[library-decode-stored-manifest:too-new-gate] decoding with bogus key — expect gate to fire before decrypt");
      try {
        await expect(
          decodeStoredManifest(BOGUS_KEY, tooNewBytes, support)
        ).rejects.toBeInstanceOf(LibraryFormatTooNewError);
      } catch (err) {
        const actual = await decodeStoredManifest(BOGUS_KEY, tooNewBytes, support).catch((e) => e);
        dumpDecodeManifestSnapshot("too-new-gate-wrong-error", { bytes: tooNewBytes, error: actual });
        throw err;
      }

      const err = await decodeStoredManifest(BOGUS_KEY, tooNewBytes, support).catch((e) => e);
      console.info(`[library-decode-stored-manifest:too-new-gate] caught surface=${String(err.surface)} observed=${String(err.observed)}`);
      try {
        expect(err.surface).toBe("storage");
        expect(err.observed).toBe(999);
      } catch (assertErr) {
        dumpDecodeManifestSnapshot("too-new-gate-fields-mismatch", { bytes: tooNewBytes, error: err });
        throw assertErr;
      }
    }
  );
});

describe("assertLibraryCompatible — op-stream gate (Part A5)", () => {
  it("opStreamVersion > READ_OP_STREAM_VERSION throws LibraryFormatTooNewError surface='op-stream'", () => {
    console.info(`[library-decode-stored-manifest:op-stream-gate] asserting opStreamVersion=${READ_OP_STREAM_VERSION + 1} > supported=${READ_OP_STREAM_VERSION}`);
    let caught: unknown;
    try {
      assertLibraryCompatible({ opStreamVersion: READ_OP_STREAM_VERSION + 1 }, support);
    } catch (e) {
      caught = e;
    }
    try {
      expect(caught).toBeInstanceOf(LibraryFormatTooNewError);
      const err = caught as InstanceType<typeof LibraryFormatTooNewError>;
      expect(err.surface).toBe("op-stream");
      expect(err.observed).toBe(READ_OP_STREAM_VERSION + 1);
      expect(err.supported).toBe(READ_OP_STREAM_VERSION);
    } catch (assertErr) {
      dumpDecodeManifestSnapshot("op-stream-gate-mismatch", { error: caught });
      throw assertErr;
    }
  });

  it("opStreamVersion === READ_OP_STREAM_VERSION does not throw", () => {
    expect(() =>
      assertLibraryCompatible({ opStreamVersion: READ_OP_STREAM_VERSION }, support)
    ).not.toThrow();
  });

  it("opStreamVersion < READ_OP_STREAM_VERSION does not throw (older op-stream is readable)", () => {
    expect(() =>
      assertLibraryCompatible({ opStreamVersion: READ_OP_STREAM_VERSION - 1 }, support)
    ).not.toThrow();
  });
});
