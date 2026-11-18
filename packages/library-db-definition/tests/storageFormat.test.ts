/**
 * @test-id LIB-DB-STORAGE-FORMAT-001
 * @level unit
 * @why `storageFormat.ts` is the collision-free v0/v1 discriminator for stored
 *   library manifest objects. Its correctness is load-bearing for the manifest
 *   bug fix (Part A): `decodeStorageHeader` returning `null` IS the "legacy v0
 *   object" signal that routes to the v0 decode path. A wrong byte layout,
 *   incorrect big-endian ordering, or false positive on a base64-text buffer
 *   would either silently corrupt every future manifest or break every existing
 *   one. These tests pin the exact wire layout, round-trips, null-path
 *   conditions, and input validation so any codec regression is caught before
 *   it reaches storage.
 */
import { describe, expect, it } from "vitest";
import {
  STORAGE_FORMAT_VERSION,
  STORAGE_HEADER_MAGIC,
  STORAGE_HEADER_SENTINEL,
  STORAGE_HEADER_SIZE,
  STORAGE_OBJECT_KIND,
  MIN_SUPPORTED_STORAGE_FORMAT_VERSION,
  encodeStorageHeader,
  decodeStorageHeader,
} from "../src/storageFormat";

const SUITE = "storageFormat";

const hexBytes = (buf: Uint8Array | ReadonlyArray<number> | undefined | null): string => {
  if (!buf) return "(none)";
  return Array.from(buf)
    .map((b) => `0x${b.toString(16).padStart(2, "0")}`)
    .join(" ");
};

const dumpStorageFormatSnapshot = (
  label: string,
  ctx: {
    bytes?: Uint8Array | ReadonlyArray<number> | null;
    bytesLabel?: string;
    expectedLayout?: Record<string, number | string>;
    decoded?: { objectKind?: number; storageFormatVersion?: number } | null;
    decodeWasNull?: boolean;
    expectedThrow?: string;
    inputArgs?: ReadonlyArray<unknown>;
    constants?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    if (ctx.bytes !== undefined) {
      console.error(`${ctx.bytesLabel ?? "header bytes"} (len=${ctx.bytes?.length ?? 0}): ${hexBytes(ctx.bytes)}`);
    }
    if (ctx.expectedLayout) {
      console.error(`expected wire layout:\n${JSON.stringify(ctx.expectedLayout, null, 2)}`);
    }
    if (ctx.decoded !== undefined) {
      console.error(`decoded fields:\n${JSON.stringify(ctx.decoded, null, 2)}`);
    }
    if (ctx.decodeWasNull !== undefined) {
      console.error(`decoder returned null: ${ctx.decodeWasNull}`);
    }
    if (ctx.expectedThrow) {
      console.error(`expected throw substring: ${ctx.expectedThrow}`);
    }
    if (ctx.inputArgs) {
      console.error(`encoder input args: ${JSON.stringify(ctx.inputArgs)}`);
    }
    if (ctx.constants) {
      console.error(`relevant constants:\n${JSON.stringify(ctx.constants, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("exported constants", () => {
  console.info(`[${SUITE}:constants] STORAGE_HEADER_SIZE=${STORAGE_HEADER_SIZE} SENTINEL=${STORAGE_HEADER_SENTINEL} MAGIC=${hexBytes(STORAGE_HEADER_MAGIC)} FORMAT_VERSION=${STORAGE_FORMAT_VERSION} MIN_VERSION=${MIN_SUPPORTED_STORAGE_FORMAT_VERSION} KIND=${JSON.stringify(STORAGE_OBJECT_KIND)}`);

  it("STORAGE_HEADER_SIZE is 8", () => {
    try {
      expect(STORAGE_HEADER_SIZE).toBe(8);
    } catch (err) {
      dumpStorageFormatSnapshot("header-size-mismatch", {
        constants: { STORAGE_HEADER_SIZE, expected: 8 },
      });
      throw err;
    }
  });

  it("STORAGE_HEADER_SENTINEL is 0x00", () => {
    expect(STORAGE_HEADER_SENTINEL).toBe(0x00);
  });

  it("STORAGE_HEADER_MAGIC is [0x53, 0x42, 0x4c] (ASCII 'SBL')", () => {
    try {
      expect(Array.from(STORAGE_HEADER_MAGIC)).toEqual([0x53, 0x42, 0x4c]);
    } catch (err) {
      dumpStorageFormatSnapshot("magic-mismatch", {
        bytes: STORAGE_HEADER_MAGIC,
        bytesLabel: "STORAGE_HEADER_MAGIC",
        expectedLayout: { byte0: "0x53 (S)", byte1: "0x42 (B)", byte2: "0x4c (L)" },
      });
      throw err;
    }
  });

  it("STORAGE_OBJECT_KIND has manifest=1, chunk=2, opPayload=3", () => {
    try {
      expect(STORAGE_OBJECT_KIND.manifest).toBe(1);
      expect(STORAGE_OBJECT_KIND.chunk).toBe(2);
      expect(STORAGE_OBJECT_KIND.opPayload).toBe(3);
    } catch (err) {
      dumpStorageFormatSnapshot("object-kind-mismatch", {
        constants: { STORAGE_OBJECT_KIND, expected: { manifest: 1, chunk: 2, opPayload: 3 } },
      });
      throw err;
    }
  });

  it("STORAGE_FORMAT_VERSION is 2 (compressed payloads, LIB-FMT-07)", () => {
    expect(STORAGE_FORMAT_VERSION).toBe(2);
  });

  it("MIN_SUPPORTED_STORAGE_FORMAT_VERSION is 1", () => {
    expect(MIN_SUPPORTED_STORAGE_FORMAT_VERSION).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Round-trips
// ---------------------------------------------------------------------------

describe("round-trip: encodeStorageHeader → decodeStorageHeader", () => {
  it("manifest kind + version 1 survives a round-trip", () => {
    console.info(`[${SUITE}:setup] encode(manifest=${STORAGE_OBJECT_KIND.manifest}, version=1)`);
    const encoded = encodeStorageHeader(STORAGE_OBJECT_KIND.manifest, 1);
    console.info(`[${SUITE}:exec] encoded bytes: ${hexBytes(encoded)}`);
    const decoded = decodeStorageHeader(encoded);
    console.info(`[${SUITE}:exec] decoded=${JSON.stringify(decoded)}`);

    try {
      expect(decoded).not.toBeNull();
      expect(decoded!.objectKind).toBe(STORAGE_OBJECT_KIND.manifest);
      expect(decoded!.storageFormatVersion).toBe(1);
    } catch (err) {
      dumpStorageFormatSnapshot("manifest-roundtrip-mismatch", {
        bytes: encoded,
        decoded,
        expectedLayout: { objectKind: STORAGE_OBJECT_KIND.manifest, storageFormatVersion: 1 },
      });
      throw err;
    }
  });

  it("chunk kind round-trips correctly", () => {
    const encoded = encodeStorageHeader(STORAGE_OBJECT_KIND.chunk, 1);
    const decoded = decodeStorageHeader(encoded);
    try {
      expect(decoded!.objectKind).toBe(STORAGE_OBJECT_KIND.chunk);
      expect(decoded!.storageFormatVersion).toBe(1);
    } catch (err) {
      dumpStorageFormatSnapshot("chunk-roundtrip-mismatch", {
        bytes: encoded,
        decoded,
        expectedLayout: { objectKind: STORAGE_OBJECT_KIND.chunk, storageFormatVersion: 1 },
      });
      throw err;
    }
  });

  it("opPayload kind round-trips correctly", () => {
    const encoded = encodeStorageHeader(STORAGE_OBJECT_KIND.opPayload, 1);
    const decoded = decodeStorageHeader(encoded);
    try {
      expect(decoded!.objectKind).toBe(STORAGE_OBJECT_KIND.opPayload);
      expect(decoded!.storageFormatVersion).toBe(1);
    } catch (err) {
      dumpStorageFormatSnapshot("oppayload-roundtrip-mismatch", {
        bytes: encoded,
        decoded,
        expectedLayout: { objectKind: STORAGE_OBJECT_KIND.opPayload, storageFormatVersion: 1 },
      });
      throw err;
    }
  });

  it("uint16 max version (0xFFFF) round-trips — verifies big-endian byte order", () => {
    // 0xFFFF = 65535: high byte = 0xFF at offset 5, low byte = 0xFF at offset 6.
    // If the encoder had used little-endian or bit-shifted incorrectly, the
    // decoded value would differ.
    console.info(`[${SUITE}:setup] encode(manifest, 0xFFFF) — testing big-endian byte ordering`);
    const encoded = encodeStorageHeader(STORAGE_OBJECT_KIND.manifest, 0xffff);
    console.info(`[${SUITE}:exec] encoded bytes: ${hexBytes(encoded)} expecting bytes[5]=0xFF bytes[6]=0xFF`);
    const decoded = decodeStorageHeader(encoded);

    try {
      expect(decoded).not.toBeNull();
      expect(decoded!.storageFormatVersion).toBe(0xffff);
    } catch (err) {
      dumpStorageFormatSnapshot("uint16-max-roundtrip-failed", {
        bytes: encoded,
        decoded,
        expectedLayout: { byte5: 0xff, byte6: 0xff, decodedVersion: 0xffff },
      });
      throw err;
    }
  });

  it("a multi-byte version where the two bytes differ round-trips (0x0102 = 258)", () => {
    // High byte 0x01, low byte 0x02 — swapped would decode as 0x0201 = 513.
    console.info(`[${SUITE}:setup] encode(manifest, 0x0102=258) — swap detection`);
    const encoded = encodeStorageHeader(STORAGE_OBJECT_KIND.manifest, 0x0102);
    console.info(`[${SUITE}:exec] encoded bytes: ${hexBytes(encoded)} expecting bytes[5]=0x01 bytes[6]=0x02`);
    const decoded = decodeStorageHeader(encoded);

    try {
      expect(decoded!.storageFormatVersion).toBe(0x0102);
    } catch (err) {
      dumpStorageFormatSnapshot("byte-swap-detected", {
        bytes: encoded,
        decoded,
        expectedLayout: { byte5: 0x01, byte6: 0x02, decodedVersion: 0x0102, swappedWouldBe: 0x0201 },
      });
      throw err;
    }
  });
});

// ---------------------------------------------------------------------------
// Wire layout
// ---------------------------------------------------------------------------

describe("wire layout: encodeStorageHeader byte positions", () => {
  it("returns exactly 8 bytes", () => {
    const header = encodeStorageHeader(STORAGE_OBJECT_KIND.manifest, 1);
    try {
      expect(header).toBeInstanceOf(Uint8Array);
      expect(header.length).toBe(STORAGE_HEADER_SIZE);
    } catch (err) {
      dumpStorageFormatSnapshot("wire-layout-wrong-length", {
        bytes: header,
        expectedLayout: { length: STORAGE_HEADER_SIZE },
      });
      throw err;
    }
  });

  it("byte 0 is the sentinel 0x00", () => {
    const header = encodeStorageHeader(STORAGE_OBJECT_KIND.manifest, 1);
    try {
      expect(header[0]).toBe(0x00);
    } catch (err) {
      dumpStorageFormatSnapshot("byte0-sentinel-wrong", {
        bytes: header,
        expectedLayout: { byte0: 0x00, actualByte0: header[0] ?? null },
      });
      throw err;
    }
  });

  it("bytes 1-3 are the SBL magic (0x53 0x42 0x4c)", () => {
    const header = encodeStorageHeader(STORAGE_OBJECT_KIND.manifest, 1);
    try {
      expect(header[1]).toBe(0x53);
      expect(header[2]).toBe(0x42);
      expect(header[3]).toBe(0x4c);
    } catch (err) {
      dumpStorageFormatSnapshot("magic-bytes-wrong", {
        bytes: header,
        expectedLayout: { byte1: 0x53, byte2: 0x42, byte3: 0x4c },
      });
      throw err;
    }
  });

  it("byte 4 is the objectKind", () => {
    const header = encodeStorageHeader(STORAGE_OBJECT_KIND.opPayload, 1);
    try {
      expect(header[4]).toBe(STORAGE_OBJECT_KIND.opPayload);
    } catch (err) {
      dumpStorageFormatSnapshot("byte4-objectKind-wrong", {
        bytes: header,
        expectedLayout: { byte4: STORAGE_OBJECT_KIND.opPayload },
      });
      throw err;
    }
  });

  it("bytes 5-6 are storageFormatVersion in big-endian (high byte at 5, low at 6)", () => {
    // Version 0x0201 (513): high = 0x02 at byte5, low = 0x01 at byte6.
    const header = encodeStorageHeader(STORAGE_OBJECT_KIND.manifest, 0x0201);
    try {
      expect(header[5]).toBe(0x02); // high byte
      expect(header[6]).toBe(0x01); // low byte
    } catch (err) {
      dumpStorageFormatSnapshot("big-endian-violated", {
        bytes: header,
        expectedLayout: { byte5_high: 0x02, byte6_low: 0x01, version: 0x0201 },
      });
      throw err;
    }
  });

  it("byte 7 is the reserved flags byte, always 0", () => {
    const header = encodeStorageHeader(STORAGE_OBJECT_KIND.manifest, 1);
    try {
      expect(header[7]).toBe(0);
    } catch (err) {
      dumpStorageFormatSnapshot("byte7-flags-not-zero", {
        bytes: header,
        expectedLayout: { byte7: 0 },
      });
      throw err;
    }
  });

  it("each encode call returns a fresh Uint8Array (no aliasing)", () => {
    const a = encodeStorageHeader(STORAGE_OBJECT_KIND.manifest, 1);
    const b = encodeStorageHeader(STORAGE_OBJECT_KIND.manifest, 1);
    try {
      expect(a).not.toBe(b);
    } catch (err) {
      console.error(`[${SUITE}:aliasing-detected] encode returned same reference twice`);
      throw err;
    }
  });
});

// ---------------------------------------------------------------------------
// Collision-free v0 detection — the load-bearing null cases
// ---------------------------------------------------------------------------

describe("decodeStorageHeader — null means 'legacy v0 object'", () => {
  it("returns null for an empty Uint8Array", () => {
    const buf = new Uint8Array(0);
    const decoded = decodeStorageHeader(buf);
    try {
      expect(decoded).toBeNull();
    } catch (err) {
      dumpStorageFormatSnapshot("empty-buf-not-null", { bytes: buf, decoded, decodeWasNull: decoded === null });
      throw err;
    }
  });

  it("returns null for a buffer shorter than 8 bytes", () => {
    for (const len of [7, 4, 1]) {
      const buf = new Uint8Array(len);
      const decoded = decodeStorageHeader(buf);
      console.info(`[${SUITE}:short-buf] len=${len} decoded=${JSON.stringify(decoded)}`);
      try {
        expect(decoded).toBeNull();
      } catch (err) {
        dumpStorageFormatSnapshot(`short-buf-len-${len}-not-null`, {
          bytes: buf,
          decoded,
          decodeWasNull: decoded === null,
        });
        throw err;
      }
    }
  });

  it("returns null when first byte is a printable base64 char 'e' (0x65)", () => {
    // Base64 alphabet starts at '+' = 0x2B. 0x65 ('e') is a common first
    // byte in base64-encoded JSON blobs. This is the core collision-free
    // guarantee: any base64-text manifest → null.
    const buf = new Uint8Array(8);
    buf[0] = 0x65; // 'e'
    buf[1] = 0x53; // 'S' — magic still present, but sentinel is wrong
    buf[2] = 0x42;
    buf[3] = 0x4c;
    const decoded = decodeStorageHeader(buf);
    try {
      expect(decoded).toBeNull();
    } catch (err) {
      dumpStorageFormatSnapshot("base64-leading-e-collided", {
        bytes: buf,
        bytesLabel: "base64-text-leading byte 'e'=0x65",
        decoded,
        expectedLayout: { decodeShouldReturn: "null" },
      });
      throw err;
    }
  });

  it("returns null for the leading bytes of a real base64 string ('eyJ2IjoxfQ==')", () => {
    // 'eyJ2IjoxfQ==' base64-decodes to {"v":1}, a JSON-like manifest fragment.
    // Its first bytes as UTF-8 are: 0x65 0x79 0x4a 0x32 0x49 0x6a 0x6f 0x78
    const base64Bytes = new TextEncoder().encode("eyJ2IjoxfQ==").slice(0, 8);
    const decoded = decodeStorageHeader(base64Bytes);
    try {
      expect(decoded).toBeNull();
    } catch (err) {
      dumpStorageFormatSnapshot("real-base64-collided", {
        bytes: base64Bytes,
        bytesLabel: "first 8 bytes of 'eyJ2IjoxfQ=='",
        decoded,
        expectedLayout: { decodeShouldReturn: "null" },
      });
      throw err;
    }
  });

  it("returns null when sentinel is correct (0x00) but magic bytes are wrong", () => {
    const buf = new Uint8Array(8);
    buf[0] = 0x00; // correct sentinel
    buf[1] = 0x41; // 'A' — not 'S'
    buf[2] = 0x42;
    buf[3] = 0x4c;
    const decoded = decodeStorageHeader(buf);
    try {
      expect(decoded).toBeNull();
    } catch (err) {
      dumpStorageFormatSnapshot("right-sentinel-wrong-magic-decoded", { bytes: buf, decoded });
      throw err;
    }
  });

  it("returns null when sentinel is correct and first magic byte is right but others are wrong", () => {
    const buf = new Uint8Array(8);
    buf[0] = 0x00;
    buf[1] = 0x53; // 'S' — correct
    buf[2] = 0x00; // wrong
    buf[3] = 0x4c;
    const decoded = decodeStorageHeader(buf);
    try {
      expect(decoded).toBeNull();
    } catch (err) {
      dumpStorageFormatSnapshot("partial-magic-decoded", { bytes: buf, decoded });
      throw err;
    }
  });

  it("returns null when all magic bytes differ from 'SBL'", () => {
    const buf = new Uint8Array(8);
    buf[0] = 0x00;
    buf[1] = 0x41; // 'A'
    buf[2] = 0x41;
    buf[3] = 0x41;
    const decoded = decodeStorageHeader(buf);
    try {
      expect(decoded).toBeNull();
    } catch (err) {
      dumpStorageFormatSnapshot("all-magic-wrong-decoded", { bytes: buf, decoded });
      throw err;
    }
  });

  it("returns null for a zeroed 8-byte buffer (sentinel present but no magic)", () => {
    // All zeros: sentinel matches but SBL bytes are 0x00 0x00 0x00 — not SBL.
    const buf = new Uint8Array(8);
    const decoded = decodeStorageHeader(buf);
    try {
      expect(decoded).toBeNull();
    } catch (err) {
      dumpStorageFormatSnapshot("zeroed-buf-decoded", { bytes: buf, decoded });
      throw err;
    }
  });

  it("returns null for a 8-byte buffer of 0xFF (wrong first byte)", () => {
    const buf = new Uint8Array(8).fill(0xff);
    const decoded = decodeStorageHeader(buf);
    try {
      expect(decoded).toBeNull();
    } catch (err) {
      dumpStorageFormatSnapshot("all-ff-buf-decoded", { bytes: buf, decoded });
      throw err;
    }
  });
});

// ---------------------------------------------------------------------------
// Prefix-only buffers (header embedded in larger objects)
// ---------------------------------------------------------------------------

describe("decodeStorageHeader — accepts prefix-only buffers", () => {
  it("decodes correctly when the Uint8Array is the header followed by arbitrary ciphertext", () => {
    console.info(`[${SUITE}:setup] header(8) + fake-ciphertext(100) prefix test`);
    // Simulate a full stored object: 8-byte header + 100-byte fake ciphertext.
    const header = encodeStorageHeader(STORAGE_OBJECT_KIND.manifest, 1);
    const ciphertext = new Uint8Array(100).fill(0xab);
    const full = new Uint8Array(108);
    full.set(header, 0);
    full.set(ciphertext, 8);

    const decoded = decodeStorageHeader(full);
    console.info(`[${SUITE}:exec] decoded from 108-byte buf=${JSON.stringify(decoded)}`);

    try {
      expect(decoded).not.toBeNull();
      expect(decoded!.objectKind).toBe(STORAGE_OBJECT_KIND.manifest);
      expect(decoded!.storageFormatVersion).toBe(1);
    } catch (err) {
      dumpStorageFormatSnapshot("prefix-decode-failed", {
        bytes: full.slice(0, 16),
        bytesLabel: "first 16 bytes of 108-byte buf",
        decoded,
        expectedLayout: { objectKind: STORAGE_OBJECT_KIND.manifest, storageFormatVersion: 1 },
      });
      throw err;
    }
  });

  it("only the first 8 bytes are examined — trailing garbage does not affect result", () => {
    console.info(`[${SUITE}:setup] header at offset 0 + 0xff garbage from byte 8 onwards`);
    const header = encodeStorageHeader(STORAGE_OBJECT_KIND.manifest, 42);
    const withTrash = new Uint8Array(100);
    withTrash.set(header, 0);
    withTrash.fill(0xff, 8); // corrupt everything after header

    const decoded = decodeStorageHeader(withTrash);
    console.info(`[${SUITE}:exec] decoded version=${decoded?.storageFormatVersion} expected=42`);

    try {
      expect(decoded!.storageFormatVersion).toBe(42);
    } catch (err) {
      dumpStorageFormatSnapshot("trailing-garbage-bled-into-decode", {
        bytes: withTrash.slice(0, 16),
        bytesLabel: "first 16 of 100-byte buf",
        decoded,
        expectedLayout: { storageFormatVersion: 42 },
      });
      throw err;
    }
  });
});

// ---------------------------------------------------------------------------
// Input validation: encodeStorageHeader
// ---------------------------------------------------------------------------

describe("encodeStorageHeader — input validation", () => {
  const checkThrows = (label: string, args: [number, number], expectedMsg: string | null) => {
    try {
      if (expectedMsg) {
        expect(() => encodeStorageHeader(...args)).toThrow(expectedMsg);
      } else {
        expect(() => encodeStorageHeader(...args)).toThrow();
      }
    } catch (err) {
      dumpStorageFormatSnapshot(label, {
        inputArgs: args,
        expectedThrow: expectedMsg ?? "(any error)",
      });
      throw err;
    }
  };

  it("throws on objectKind < 1", () => {
    checkThrows("input-validation-kind-0", [0, 1], "invalid_storage_object_kind:0");
  });

  it("throws on objectKind > 0xff (256)", () => {
    checkThrows("input-validation-kind-256", [256, 1], "invalid_storage_object_kind:256");
  });

  it("throws on objectKind that is a float", () => {
    checkThrows("input-validation-kind-1.5", [1.5, 1], "invalid_storage_object_kind:1.5");
  });

  it("throws on objectKind NaN", () => {
    checkThrows("input-validation-kind-NaN", [NaN, 1], null);
  });

  it("throws on version < 1 (0)", () => {
    checkThrows("input-validation-version-0", [1, 0], "invalid_storage_format_version:0");
  });

  it("throws on version < 1 (negative)", () => {
    checkThrows("input-validation-version-neg1", [1, -1], "invalid_storage_format_version:-1");
  });

  it("throws on version > 0xffff (65536)", () => {
    checkThrows("input-validation-version-65536", [1, 0x10000], "invalid_storage_format_version:65536");
  });

  it("throws on version that is a float", () => {
    checkThrows("input-validation-version-1.9", [1, 1.9], "invalid_storage_format_version:1.9");
  });

  it("throws on version NaN", () => {
    checkThrows("input-validation-version-NaN", [1, NaN], null);
  });

  it("accepts objectKind at the maximum valid value (0xff = 255)", () => {
    console.info(`[${SUITE}:setup] encode + decode with max-valid kind=0xff`);
    try {
      expect(() => encodeStorageHeader(0xff, 1)).not.toThrow();
      const decoded = decodeStorageHeader(encodeStorageHeader(0xff, 1));
      expect(decoded!.objectKind).toBe(0xff);
    } catch (err) {
      dumpStorageFormatSnapshot("max-kind-rejected", { inputArgs: [0xff, 1] });
      throw err;
    }
  });

  it("accepts objectKind at the minimum valid value (1)", () => {
    expect(() => encodeStorageHeader(1, 1)).not.toThrow();
  });

  it("accepts version at the maximum valid value (0xffff)", () => {
    expect(() => encodeStorageHeader(1, 0xffff)).not.toThrow();
  });

  it("accepts version at the minimum valid value (1)", () => {
    expect(() => encodeStorageHeader(1, 1)).not.toThrow();
  });
});
