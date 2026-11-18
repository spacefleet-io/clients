/**
 * @test-id LIB-DB-RUNTIME-DECODE-MANIFEST-001
 * @level unit
 * @bugfix manifest-encoding-mismatch-2026-05-14
 * @regression-proof
 *
 * @why Part A3 — the dual reader (`decodeStoredManifest`) is the fix for the
 *   manifest-encoding bug. The pre-fix reader fed stored bytes straight into
 *   AES-GCM decrypt. Legacy stored bytes were the UTF-8 codepoints of a base64
 *   string (not the raw ciphertext), so decrypt always produced DECRYPT_FAILED.
 *   The dual reader correctly routes:
 *     - v0 (no magic header): UTF-8-decode → base64-decode → decrypt
 *     - v1 (0x00 SBL header): strip 8 bytes → decrypt
 *   Additionally it fails-fast on a too-new storageFormatVersion BEFORE decrypt,
 *   producing a typed LibraryFormatTooNewError instead of a cryptic DECRYPT_FAILED.
 *
 *   Part B: the op-stream version gate calls assertLibraryCompatible({ opStreamVersion })
 *   in syncFromRemoteIfNewer. A response with opStreamVersion > OP_STREAM_VERSION must
 *   surface LibraryFormatTooNewError with surface==="op-stream".
 *
 *   NOTE: library-db-runtime uses Bun's test runner (`bun test`), not vitest.
 *   This is the explicit exception to the vitest convention.
 */

import { describe, expect, it } from "bun:test";
import {
  encryptBytesToBytes,
  decryptBytesToBytes,
} from "../src/crypto";
import { decodeStoredManifest } from "../src/libraryDb";
import {
  encodeStorageHeader,
  decodeStorageHeader,
  STORAGE_HEADER_SIZE,
  STORAGE_OBJECT_KIND,
  STORAGE_FORMAT_VERSION,
} from "@space/library-db-definition/storageFormat";
import {
  assertLibraryCompatible,
  LibraryFormatTooNewError,
  currentLibrarySupport,
} from "@space/library-db-definition/compatibility";
import { OP_STREAM_VERSION } from "@space/library-db-definition/ops";
import {
  desktopCoreMigrations,
  desktopIngestMigrations,
  desktopMetadataMigrations,
  desktopPlaybackMigrations,
  desktopTemplatesMigrations,
} from "../src/desktopMigrations";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

// A 32-byte key as base64 (AES-256-GCM). Same key used across all tests.
const KEY_BASE64 = Buffer.from("0123456789abcdef0123456789abcdef", "utf8").toString("base64");

const MANIFEST_PLAINTEXT = JSON.stringify({
  schemaVersion: 1,
  chunks: [],
  createdAt: "2026-05-14T00:00:00.000Z",
});
const MANIFEST_BYTES = new TextEncoder().encode(MANIFEST_PLAINTEXT);

// The local build's LibrarySupport — mirrors DESKTOP_LIBRARY_SUPPORT.
const DESKTOP_SUPPORT = currentLibrarySupport({
  core: desktopCoreMigrations,
  metadata: desktopMetadataMigrations,
  playback: desktopPlaybackMigrations,
  ingest: desktopIngestMigrations,
  templates: desktopTemplatesMigrations,
});

// Suite-id: decode-stored-manifest
// Manifest decode pivots on (header presence vs absence) + (storageFormatVersion
// in header) + (body length after stripping header). Dump those three plus any
// captured error so the failure tells you which limb of the dual reader fired.
const dumpManifestSnapshot = (
  label: string,
  ctx: {
    stored?: Uint8Array;
    decodedHeader?: ReturnType<typeof decodeStorageHeader> | null;
    plaintextRecovered?: string | null;
    capturedError?: unknown;
    extraNotes?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [decode-stored-manifest:${label}] snapshot ===`);
    if (ctx.stored) {
      const first16 = Array.from(ctx.stored.slice(0, 16))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" ");
      console.error(`stored.length=${ctx.stored.length} first16hex=${first16}`);
    }
    if (ctx.decodedHeader !== undefined) {
      console.error(`decodeStorageHeader result=${JSON.stringify(ctx.decodedHeader)}`);
    }
    console.error(
      `build constants: STORAGE_FORMAT_VERSION=${STORAGE_FORMAT_VERSION} STORAGE_HEADER_SIZE=${STORAGE_HEADER_SIZE}`,
    );
    console.error(`build OP_STREAM_VERSION=${OP_STREAM_VERSION}`);
    console.error(`DESKTOP_SUPPORT=${JSON.stringify(DESKTOP_SUPPORT)}`);
    if (ctx.plaintextRecovered !== undefined) {
      console.error(`plaintextRecovered=${JSON.stringify(ctx.plaintextRecovered)}`);
    }
    if (ctx.extraNotes) {
      console.error(`extraNotes=${JSON.stringify(ctx.extraNotes, null, 2)}`);
    }
    if (ctx.capturedError !== undefined) {
      const e = ctx.capturedError;
      console.error(`captured error.ctor=${e?.constructor?.name} message=${e instanceof Error ? e.message : String(e)}`);
      if (e instanceof LibraryFormatTooNewError) {
        console.error(`  surface=${e.surface} observed=${e.observed} supported=${e.supported} group=${e.group}`);
      }
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

// ---------------------------------------------------------------------------
// Item 2: v0/v1 collision-free detection via decodeStorageHeader
// ---------------------------------------------------------------------------

describe("v0 vs v1 header detection — collision-free", () => {
  it("a v1 headered object (0x00 + 'SBL') → decodeStorageHeader returns non-null", () => {
    const header = encodeStorageHeader(STORAGE_OBJECT_KIND.manifest, STORAGE_FORMAT_VERSION);
    const fakeEnvelope = new Uint8Array(44); // placeholder 44-byte envelope
    const stored = new Uint8Array(header.length + fakeEnvelope.length);
    stored.set(header, 0);
    stored.set(fakeEnvelope, header.length);

    const decoded = decodeStorageHeader(stored);
    console.info(
      `[decode-stored-manifest:v1-header-detect] decoded=${JSON.stringify(decoded)} stored.len=${stored.length}`,
    );
    try {
      expect(decoded).not.toBeNull();
      expect(decoded!.objectKind).toBe(STORAGE_OBJECT_KIND.manifest);
      expect(decoded!.storageFormatVersion).toBe(STORAGE_FORMAT_VERSION);
    } catch (err) {
      dumpManifestSnapshot("v1-header-detect-failure", {
        stored,
        decodedHeader: decoded,
        capturedError: err,
      });
      throw err;
    }
  });

  it("a v0 base64-text object (first byte is printable base64 char) → decodeStorageHeader returns null", async () => {
    // Build the v0 fixture exactly as the pre-fix API stored it:
    // encrypt → pack to bytes → base64-encode that packed form →
    // TextEncoder().encode(that base64 string). The first byte of the result
    // is a printable ASCII char (e.g. 0x41 'A'), never 0x00.
    const envelope = await encryptBytesToBytes(KEY_BASE64, MANIFEST_BYTES);
    const base64String = Buffer.from(envelope).toString("base64");
    const v0Stored = new TextEncoder().encode(base64String);
    console.info(
      `[decode-stored-manifest:v0-no-header] v0Stored.len=${v0Stored.length} firstByte=0x${v0Stored[0].toString(16)}`,
    );

    const decoded = decodeStorageHeader(v0Stored);
    try {
      expect(decoded).toBeNull();
      expect(v0Stored[0]).toBeGreaterThanOrEqual(0x2b);
      expect(v0Stored[0]).not.toBe(0x00);
    } catch (err) {
      dumpManifestSnapshot("v0-no-header-failure", {
        stored: v0Stored,
        decodedHeader: decoded,
        capturedError: err,
      });
      throw err;
    }
  });

  it("v0 raw decrypt fails (pre-fix behaviour) — same fixture decryptBytesToBytes rejects", async () => {
    // This is the @regression-proof anchor for items 1+3 below: if this ever
    // PASSES (raw decrypt succeeds on v0 bytes), the fixture is wrong and the
    // regression proof is invalid.
    const envelope = await encryptBytesToBytes(KEY_BASE64, MANIFEST_BYTES);
    const base64String = Buffer.from(envelope).toString("base64");
    const v0Stored = new TextEncoder().encode(base64String);
    console.info(
      `[decode-stored-manifest:v0-raw-decrypt-fails] v0Stored.len=${v0Stored.length} (regression anchor)`,
    );

    try {
      await expect(decryptBytesToBytes(KEY_BASE64, v0Stored)).rejects.toThrow();
    } catch (err) {
      dumpManifestSnapshot("v0-raw-decrypt-anchor-failure", {
        stored: v0Stored,
        capturedError: err,
        extraNotes: {
          warning:
            "If raw decrypt of v0 bytes SUCCEEDED, the v0 fixture is wrong and the regression proof is invalid",
        },
      });
      throw err;
    }
  });

  it("no collision: 0x00 never appears as first byte of any base64-alphabet character", () => {
    // The base64 alphabet is [A-Za-z0-9+/=]. Lowest codepoint is '+' = 0x2B.
    // So 0x00 as a first byte can ONLY come from the SBL sentinel — not from
    // any base64-text manifest.
    const base64Chars =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
    console.info(
      `[decode-stored-manifest:no-collision] scanning ${base64Chars.length} base64 chars for 0x00`,
    );
    try {
      for (const char of base64Chars) {
        expect(char.charCodeAt(0)).toBeGreaterThan(0x00);
      }
    } catch (err) {
      dumpManifestSnapshot("no-collision-failure", {
        capturedError: err,
        extraNotes: { base64Chars },
      });
      throw err;
    }
  });
});

// ---------------------------------------------------------------------------
// Item 4: Part B op-stream gate
// ---------------------------------------------------------------------------

describe("op-stream version gate — assertLibraryCompatible (Part B)", () => {
  it("opStreamVersion at the build's current version passes through", () => {
    console.info(
      `[decode-stored-manifest:opstream-current] opStreamVersion=${OP_STREAM_VERSION} (must NOT throw)`,
    );
    try {
      expect(() =>
        assertLibraryCompatible({ opStreamVersion: OP_STREAM_VERSION }, DESKTOP_SUPPORT)
      ).not.toThrow();
    } catch (err) {
      dumpManifestSnapshot("opstream-current-failure", { capturedError: err });
      throw err;
    }
  });

  it("opStreamVersion one above OP_STREAM_VERSION throws LibraryFormatTooNewError with surface='op-stream'", () => {
    const tooNew = OP_STREAM_VERSION + 1;
    let caught: LibraryFormatTooNewError | undefined;
    try {
      assertLibraryCompatible({ opStreamVersion: tooNew }, DESKTOP_SUPPORT);
    } catch (e) {
      caught = e as LibraryFormatTooNewError;
    }
    console.info(
      `[decode-stored-manifest:opstream-too-new] observed=${tooNew} caught.surface=${caught?.surface} ` +
        `observed=${caught?.observed} supported=${caught?.supported}`,
    );
    try {
      expect(caught).toBeInstanceOf(LibraryFormatTooNewError);
      expect(caught!.surface).toBe("op-stream");
      expect(caught!.observed).toBe(tooNew);
      expect(caught!.supported).toBe(OP_STREAM_VERSION);
    } catch (err) {
      dumpManifestSnapshot("opstream-too-new-failure", {
        capturedError: err,
        extraNotes: {
          tooNew,
          caught: caught
            ? { ctor: caught.constructor?.name, surface: caught.surface }
            : null,
        },
      });
      throw err;
    }
  });

  it("opStreamVersion=99 throws LibraryFormatTooNewError (not a silent unknown-op drop)", () => {
    // Mirrors the exact check in syncFromRemoteIfNewer: a server response with
    // opStreamVersion: 99 must surface LibraryFormatTooNewError immediately
    // rather than letting buildOpStatements encounter unknown op types.
    let caught: LibraryFormatTooNewError | undefined;
    try {
      assertLibraryCompatible({ opStreamVersion: 99 }, DESKTOP_SUPPORT);
    } catch (e) {
      caught = e as LibraryFormatTooNewError;
    }
    console.info(
      `[decode-stored-manifest:opstream-99] caught.surface=${caught?.surface} observed=${caught?.observed}`,
    );
    try {
      expect(caught).toBeInstanceOf(LibraryFormatTooNewError);
      expect(caught!.surface).toBe("op-stream");
      expect(caught!.observed).toBe(99);
    } catch (err) {
      dumpManifestSnapshot("opstream-99-failure", {
        capturedError: err,
        extraNotes: {
          caught: caught
            ? { ctor: caught.constructor?.name, surface: caught.surface }
            : null,
        },
      });
      throw err;
    }
  });

  it("storage and op-stream both too-new: storage error surfaces first (gate order preserved)", () => {
    let caught: LibraryFormatTooNewError | undefined;
    try {
      assertLibraryCompatible(
        { storageFormatVersion: 999, opStreamVersion: 999 },
        DESKTOP_SUPPORT
      );
    } catch (e) {
      caught = e as LibraryFormatTooNewError;
    }
    console.info(
      `[decode-stored-manifest:both-too-new-gate-order] caught.surface=${caught?.surface} (expected storage)`,
    );
    try {
      expect(caught!.surface).toBe("storage");
    } catch (err) {
      dumpManifestSnapshot("gate-order-failure", {
        capturedError: err,
        extraNotes: {
          caught: caught
            ? {
                ctor: caught.constructor?.name,
                surface: caught.surface,
                observed: caught.observed,
              }
            : null,
        },
      });
      throw err;
    }
  });
});

// ---------------------------------------------------------------------------
// Item 1: @bugfix manifest-encoding-mismatch-2026-05-14 @regression-proof
// decodeStoredManifest dual reader — v0 and v1 both decrypt to correct plaintext
// ---------------------------------------------------------------------------

describe("decodeStoredManifest — dual reader v0/v1 @bugfix @regression-proof", () => {
  /**
   * @bugfix manifest-encoding-mismatch-2026-05-14
   * @regression-proof
   *
   * Pre-fix behavior: the stored bytes (UTF-8 codepoints of a base64 string)
   * were passed directly to decryptBytesToBytes — which always produces
   * DECRYPT_FAILED because ASCII codepoints are not a valid AES-GCM envelope.
   *
   * Post-fix behavior (the dual reader): the function detects the v0 shape
   * (no 0x00 SBL header), UTF-8-decodes the stored bytes to recover the base64
   * string, base64-decodes to recover the raw AES-GCM envelope, then decrypts.
   *
   * The companion test "v0 raw decrypt fails" (Item 2) is the pre-fix anchor:
   * it asserts that raw decryptBytesToBytes(v0Stored) still fails — i.e. the
   * bytes are genuinely v0 and the dual reader is doing real work, not a tautology.
   */
  it("Item 1a — v0 stored fixture decrypts correctly through decodeStoredManifest (pre-fix raw path fails)", async () => {
    // Build a v0 fixture the same way the pre-fix API produced it:
    // encrypt MANIFEST_BYTES → pack to raw bytes → base64-encode → UTF-8 encode the string.
    const envelope = await encryptBytesToBytes(KEY_BASE64, MANIFEST_BYTES);
    const base64String = Buffer.from(envelope).toString("base64");
    const v0Stored = new TextEncoder().encode(base64String);
    console.info(
      `[decode-stored-manifest:item1a-v0-decrypt] v0Stored.len=${v0Stored.length} ` +
        `envelope.len=${envelope.length} base64.len=${base64String.length}`,
    );

    // Pre-fix path: raw decrypt of v0Stored must still fail (regression anchor).
    try {
      await expect(decryptBytesToBytes(KEY_BASE64, v0Stored)).rejects.toThrow();
    } catch (err) {
      dumpManifestSnapshot("item1a-raw-decrypt-anchor-failure", {
        stored: v0Stored,
        capturedError: err,
      });
      throw err;
    }

    // Post-fix path: the dual reader must succeed and return the original plaintext.
    let recovered: Uint8Array;
    try {
      recovered = await decodeStoredManifest(KEY_BASE64, v0Stored);
    } catch (err) {
      dumpManifestSnapshot("item1a-dualreader-failure", {
        stored: v0Stored,
        decodedHeader: decodeStorageHeader(v0Stored),
        capturedError: err,
      });
      throw err;
    }
    const recoveredText = Buffer.from(recovered).toString("utf8");
    console.info(`[decode-stored-manifest:item1a-v0-decrypt] recovered.len=${recovered.length}`);
    try {
      expect(recoveredText).toBe(MANIFEST_PLAINTEXT);
    } catch (err) {
      dumpManifestSnapshot("item1a-plaintext-mismatch", {
        stored: v0Stored,
        plaintextRecovered: recoveredText,
        capturedError: err,
        extraNotes: { expectedManifest: MANIFEST_PLAINTEXT },
      });
      throw err;
    }
  });

  it("Item 1b — v0 and v1 fixtures with the same key + manifest decrypt to the same plaintext", async () => {
    // v0 fixture (pre-fix encoding).
    const envelope = await encryptBytesToBytes(KEY_BASE64, MANIFEST_BYTES);
    const base64String = Buffer.from(envelope).toString("base64");
    const v0Stored = new TextEncoder().encode(base64String);

    // v1 fixture: 8-byte header + raw AES-GCM envelope.
    const v1Envelope = await encryptBytesToBytes(KEY_BASE64, MANIFEST_BYTES);
    const header = encodeStorageHeader(STORAGE_OBJECT_KIND.manifest, STORAGE_FORMAT_VERSION);
    const v1Stored = new Uint8Array(header.length + v1Envelope.length);
    v1Stored.set(header, 0);
    v1Stored.set(v1Envelope, header.length);
    console.info(
      `[decode-stored-manifest:item1b-both-fixtures] v0Stored.len=${v0Stored.length} v1Stored.len=${v1Stored.length}`,
    );

    let fromV0: Uint8Array;
    let fromV1: Uint8Array;
    try {
      fromV0 = await decodeStoredManifest(KEY_BASE64, v0Stored);
      fromV1 = await decodeStoredManifest(KEY_BASE64, v1Stored);
    } catch (err) {
      dumpManifestSnapshot("item1b-decode-failure", {
        stored: v0Stored,
        decodedHeader: decodeStorageHeader(v0Stored),
        capturedError: err,
        extraNotes: {
          v1Stored: { len: v1Stored.length },
          v1Header: decodeStorageHeader(v1Stored),
        },
      });
      throw err;
    }

    // Both must decode to the same original manifest plaintext.
    const v0Text = Buffer.from(fromV0).toString("utf8");
    const v1Text = Buffer.from(fromV1).toString("utf8");
    try {
      expect(v0Text).toBe(MANIFEST_PLAINTEXT);
      expect(v1Text).toBe(MANIFEST_PLAINTEXT);
    } catch (err) {
      dumpManifestSnapshot("item1b-plaintext-mismatch", {
        plaintextRecovered: `v0=${v0Text} | v1=${v1Text}`,
        capturedError: err,
        extraNotes: { expectedManifest: MANIFEST_PLAINTEXT },
      });
      throw err;
    }
  });
});

// ---------------------------------------------------------------------------
// Item 3: too-new storageFormatVersion → LibraryFormatTooNewError BEFORE decrypt
// ---------------------------------------------------------------------------

describe("decodeStoredManifest — too-new storageFormatVersion gate fires before decrypt", () => {
  it("Item 3 — storageFormatVersion=999 in header throws LibraryFormatTooNewError, not DECRYPT_FAILED", async () => {
    // Build a v1 object stamped with a future storageFormatVersion (999).
    // The key is deliberately bogus (wrong length) to prove that the
    // compatibility check fires BEFORE any decrypt attempt — if it didn't, we'd
    // get INVALID_KEY or DECRYPT_FAILED instead of LibraryFormatTooNewError.
    const BOGUS_KEY = "dGhpc2lzYm9ndXM="; // 12 ASCII bytes base64 — not 32 bytes, so importAesGcmKey throws INVALID_KEY
    const FUTURE_FORMAT_VERSION = 999;

    // Manually stamp the 8-byte header with storageFormatVersion=999.
    const header = new Uint8Array(STORAGE_HEADER_SIZE);
    header[0] = 0x00; // sentinel
    header[1] = 0x53; // 'S'
    header[2] = 0x42; // 'B'
    header[3] = 0x4c; // 'L'
    header[4] = 0x01; // objectKind = manifest
    header[5] = (FUTURE_FORMAT_VERSION >>> 8) & 0xff; // high byte
    header[6] = FUTURE_FORMAT_VERSION & 0xff;          // low byte
    header[7] = 0x00; // flags

    // Append a plausible 44-byte envelope placeholder.
    const fakeEnvelope = new Uint8Array(44);
    const v1Future = new Uint8Array(STORAGE_HEADER_SIZE + fakeEnvelope.length);
    v1Future.set(header, 0);
    v1Future.set(fakeEnvelope, STORAGE_HEADER_SIZE);
    console.info(
      `[decode-stored-manifest:item3-future-version] stamped header with storageFormatVersion=${FUTURE_FORMAT_VERSION} ` +
        `(bogus key — should NOT reach decrypt)`,
    );

    let caught: unknown;
    try {
      await decodeStoredManifest(BOGUS_KEY, v1Future);
    } catch (e) {
      caught = e;
    }
    console.info(
      `[decode-stored-manifest:item3-future-version] caught.ctor=${(caught as Error | undefined)?.constructor?.name} ` +
        `surface=${(caught as LibraryFormatTooNewError | undefined)?.surface}`,
    );

    try {
      // Must be the typed format error, not DECRYPT_FAILED or INVALID_KEY.
      expect(caught).toBeInstanceOf(LibraryFormatTooNewError);
      const err = caught as LibraryFormatTooNewError;
      expect(err.surface).toBe("storage");
      expect(err.observed).toBe(FUTURE_FORMAT_VERSION);
      expect(err.supported).toBe(STORAGE_FORMAT_VERSION);
      // No group field — this is the storage surface, not schema.
      expect(err.group).toBeUndefined();
    } catch (err) {
      dumpManifestSnapshot("item3-future-version-failure", {
        stored: v1Future,
        decodedHeader: decodeStorageHeader(v1Future),
        capturedError: caught ?? err,
        extraNotes: {
          futureFormatVersion: FUTURE_FORMAT_VERSION,
          bogusKey: BOGUS_KEY,
        },
      });
      throw err;
    }
  });
});
