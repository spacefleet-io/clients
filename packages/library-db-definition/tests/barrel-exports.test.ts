/**
 * @test-id LIB-DB-BARREL-001
 * @level unit
 * @why `index.ts` re-exports every public surface of the package. If a new
 *   module is added but not wired into the barrel, downstream consumers see
 *   a missing-export error at build time — but only after they import from
 *   the package root. This smoke test exercises the critical new exports
 *   introduced in deliverable 6 so a missing re-export is caught at CI
 *   rather than at the first downstream consumer.
 */
import { describe, expect, it } from "vitest";
import * as libraryDbBarrel from "../src/index";
import {
  // storageFormat.ts (deliverable 1)
  encodeStorageHeader,
  decodeStorageHeader,
  STORAGE_FORMAT_VERSION,
  STORAGE_HEADER_SIZE,
  STORAGE_HEADER_SENTINEL,
  STORAGE_HEADER_MAGIC,
  STORAGE_OBJECT_KIND,
  MIN_SUPPORTED_STORAGE_FORMAT_VERSION,
  // compatibility.ts (deliverable 2)
  assertLibraryCompatible,
  LibraryFormatTooNewError,
  // ops.ts (deliverable 3)
  OP_STREAM_VERSION,
  MIN_SUPPORTED_OP_STREAM_VERSION,
  UnknownOpTypeError,
} from "../src/index";

const SUITE = "barrel-exports";

const EXPECTED_SYMBOLS = [
  "encodeStorageHeader",
  "decodeStorageHeader",
  "STORAGE_FORMAT_VERSION",
  "STORAGE_HEADER_SIZE",
  "STORAGE_HEADER_SENTINEL",
  "STORAGE_HEADER_MAGIC",
  "STORAGE_OBJECT_KIND",
  "MIN_SUPPORTED_STORAGE_FORMAT_VERSION",
  "assertLibraryCompatible",
  "LibraryFormatTooNewError",
  "OP_STREAM_VERSION",
  "MIN_SUPPORTED_OP_STREAM_VERSION",
  "UnknownOpTypeError",
] as const;

const dumpBarrelSnapshot = (
  label: string,
  ctx: {
    symbol?: string;
    expectedType?: string;
    actualType?: string;
    actualValue?: unknown;
  } = {},
) => {
  try {
    const actualExports = Object.keys(libraryDbBarrel).sort();
    const symbolStatus = EXPECTED_SYMBOLS.map((name) => ({
      name,
      present: name in libraryDbBarrel,
      type: typeof (libraryDbBarrel as Record<string, unknown>)[name],
    }));
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    if (ctx.symbol) {
      console.error(
        `symbol=${ctx.symbol} expectedType=${ctx.expectedType} actualType=${ctx.actualType} actualValue=${JSON.stringify(ctx.actualValue)}`,
      );
    }
    console.error(`expected critical symbols:\n${JSON.stringify(symbolStatus, null, 2)}`);
    console.error(`barrel exports (sorted, ${actualExports.length} total):\n${JSON.stringify(actualExports, null, 2)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("@space/library-db-definition barrel re-exports", () => {
  console.info(
    `[${SUITE}:setup] barrel exports=${Object.keys(libraryDbBarrel).length} expected-critical=${EXPECTED_SYMBOLS.length}`,
  );

  it("encodeStorageHeader is a function", () => {
    const t = typeof encodeStorageHeader;
    try {
      expect(t).toBe("function");
    } catch (err) {
      dumpBarrelSnapshot("encodeStorageHeader-type-mismatch", {
        symbol: "encodeStorageHeader",
        expectedType: "function",
        actualType: t,
      });
      throw err;
    }
  });

  it("decodeStorageHeader is a function", () => {
    expect(typeof decodeStorageHeader).toBe("function");
  });

  it("STORAGE_FORMAT_VERSION is a number", () => {
    expect(typeof STORAGE_FORMAT_VERSION).toBe("number");
  });

  it("STORAGE_HEADER_SIZE is a number", () => {
    expect(typeof STORAGE_HEADER_SIZE).toBe("number");
  });

  it("STORAGE_HEADER_SENTINEL is a number", () => {
    expect(typeof STORAGE_HEADER_SENTINEL).toBe("number");
  });

  it("STORAGE_HEADER_MAGIC is an array", () => {
    expect(Array.isArray(STORAGE_HEADER_MAGIC)).toBe(true);
  });

  it("STORAGE_OBJECT_KIND has a manifest property", () => {
    expect(typeof STORAGE_OBJECT_KIND.manifest).toBe("number");
  });

  it("MIN_SUPPORTED_STORAGE_FORMAT_VERSION is a number", () => {
    expect(typeof MIN_SUPPORTED_STORAGE_FORMAT_VERSION).toBe("number");
  });

  it("assertLibraryCompatible is a function", () => {
    expect(typeof assertLibraryCompatible).toBe("function");
  });

  it("LibraryFormatTooNewError is a class (constructible)", () => {
    const err = new LibraryFormatTooNewError({
      surface: "storage",
      observed: 2,
      supported: 1,
    });
    try {
      expect(err).toBeInstanceOf(LibraryFormatTooNewError);
      expect(err).toBeInstanceOf(Error);
    } catch (assertionErr) {
      dumpBarrelSnapshot("LibraryFormatTooNewError-not-error-subclass", {
        symbol: "LibraryFormatTooNewError",
        expectedType: "Error subclass",
        actualType: typeof err,
        actualValue: { name: (err as Error).name, message: (err as Error).message },
      });
      throw assertionErr;
    }
  });

  it("OP_STREAM_VERSION is a number", () => {
    expect(typeof OP_STREAM_VERSION).toBe("number");
  });

  it("MIN_SUPPORTED_OP_STREAM_VERSION is a number", () => {
    expect(typeof MIN_SUPPORTED_OP_STREAM_VERSION).toBe("number");
  });

  it("UnknownOpTypeError is a class (constructible)", () => {
    const err = new UnknownOpTypeError("test.op");
    expect(err).toBeInstanceOf(UnknownOpTypeError);
    expect(err).toBeInstanceOf(Error);
  });

  it("barrel imports are live (encodeStorageHeader + decodeStorageHeader interoperate)", () => {
    // End-to-end use of the two functions through the barrel — confirms no
    // import aliasing or tree-shaking issue broke the function references.
    console.info(
      `[${SUITE}:interop] encoding header kind=manifest version=${STORAGE_FORMAT_VERSION}`,
    );
    const header = encodeStorageHeader(STORAGE_OBJECT_KIND.manifest, STORAGE_FORMAT_VERSION);
    console.info(
      `[${SUITE}:interop] encoded header byteLength=${(header as Uint8Array).byteLength ?? "n/a"}`,
    );
    const decoded = decodeStorageHeader(header);
    console.info(
      `[${SUITE}:interop] decoded=${JSON.stringify(decoded === null ? null : { storageFormatVersion: decoded?.storageFormatVersion })}`,
    );
    try {
      expect(decoded).not.toBeNull();
      expect(decoded!.storageFormatVersion).toBe(STORAGE_FORMAT_VERSION);
    } catch (err) {
      dumpBarrelSnapshot("interop-encode-decode-mismatch", {
        symbol: "encodeStorageHeader+decodeStorageHeader",
        expectedType: `decoded.storageFormatVersion === ${STORAGE_FORMAT_VERSION}`,
        actualValue: decoded,
      });
      throw err;
    }
  });
});
