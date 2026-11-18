/**
 * Tests for Part D3 client-side: parseLibraryFormatTooNew + isDecryptFailureMessage
 * (regression for the wrapped-error includes() fix).
 */

import { describe, expect, it } from "vitest";
import {
  parseLibraryFormatTooNew,
  isDecryptFailureMessage,
  isLibraryFormatTooNewMessage,
  getLibraryLoadErrorMessage,
} from "../src/renderer/src/lib/libraryContext";

// On assertion failure, dump the raw input and the value the parser/predicate
// actually returned so the regression is diagnosable at a glance — these are
// string-shape parsers where the exact observed value is the whole story.
// Wrapped so a dump failure can't mask the real assertion failure.
const dumpFormatSnapshot = (label: string, input: unknown, observed: unknown) => {
  try {
    const inputDesc =
      input instanceof Error
        ? `Error(message=${JSON.stringify(input.message)}, details=${JSON.stringify((input as { details?: unknown }).details)})`
        : JSON.stringify(input);
    console.error(`=== [library-format-too-new:${label}] snapshot ===`);
    console.error(`input: ${inputDesc}`);
    console.error(`observed: ${JSON.stringify(observed)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

// ---------------------------------------------------------------------------
// parseLibraryFormatTooNew — pure function
// ---------------------------------------------------------------------------

describe("parseLibraryFormatTooNew", () => {
  it("returns null when the error is unrelated", () => {
    expect(parseLibraryFormatTooNew(new Error("DECRYPT_FAILED"))).toBeNull();
    expect(parseLibraryFormatTooNew("something went wrong")).toBeNull();
    expect(parseLibraryFormatTooNew(null)).toBeNull();
    expect(parseLibraryFormatTooNew(undefined)).toBeNull();
    expect(parseLibraryFormatTooNew(42)).toBeNull();
  });

  it("parses a storage surface message", () => {
    const err = new Error("LIBRARY_FORMAT_TOO_NEW: storage observed=2 supported=1");
    const detail = parseLibraryFormatTooNew(err);
    console.info(`[library-format-too-new:parse-storage] detail=${JSON.stringify(detail)}`);
    if (detail?.surface !== "storage" || detail?.observed !== 2 || detail?.supported !== 1 || detail?.group !== undefined) {
      dumpFormatSnapshot("parse-storage", err, detail);
    }
    expect(detail).not.toBeNull();
    expect(detail?.surface).toBe("storage");
    expect(detail?.observed).toBe(2);
    expect(detail?.supported).toBe(1);
    expect(detail?.group).toBeUndefined();
  });

  it("parses an op-stream surface message", () => {
    const err = new Error("LIBRARY_FORMAT_TOO_NEW: op-stream observed=3 supported=1");
    const detail = parseLibraryFormatTooNew(err);
    console.info(`[library-format-too-new:parse-op-stream] detail=${JSON.stringify(detail)}`);
    if (detail?.surface !== "op-stream" || detail?.observed !== 3 || detail?.supported !== 1 || detail?.group !== undefined) {
      dumpFormatSnapshot("parse-op-stream", err, detail);
    }
    expect(detail?.surface).toBe("op-stream");
    expect(detail?.observed).toBe(3);
    expect(detail?.supported).toBe(1);
    expect(detail?.group).toBeUndefined();
  });

  it("parses a schema surface message with group", () => {
    const err = new Error("LIBRARY_FORMAT_TOO_NEW: schema:core observed=5 supported=3");
    const detail = parseLibraryFormatTooNew(err);
    console.info(`[library-format-too-new:parse-schema] detail=${JSON.stringify(detail)}`);
    if (detail?.surface !== "schema" || detail?.observed !== 5 || detail?.supported !== 3 || detail?.group !== "core") {
      dumpFormatSnapshot("parse-schema", err, detail);
    }
    expect(detail?.surface).toBe("schema");
    expect(detail?.observed).toBe(5);
    expect(detail?.supported).toBe(3);
    expect(detail?.group).toBe("core");
  });

  it("parses message embedded inside a longer RuntimeCommandFailedError string", () => {
    // This is the production shape: the runtime proxy wraps the original
    // LibraryFormatTooNewError message inside RuntimeCommandFailedError.message.
    const wrapped = new Error(
      "RuntimeCommandFailedError: LIBRARY_FORMAT_TOO_NEW: schema:metadata observed=7 supported=2"
    );
    const detail = parseLibraryFormatTooNew(wrapped);
    console.info(`[library-format-too-new:parse-wrapped] detail=${JSON.stringify(detail)}`);
    if (detail?.surface !== "schema" || detail?.observed !== 7 || detail?.supported !== 2 || detail?.group !== "metadata") {
      dumpFormatSnapshot("parse-wrapped", wrapped, detail);
    }
    expect(detail?.surface).toBe("schema");
    expect(detail?.observed).toBe(7);
    expect(detail?.supported).toBe(2);
    expect(detail?.group).toBe("metadata");
  });

  it("prefers structured details over message parsing when proxy preserved them", () => {
    // The runtime proxy copies details into RuntimeCommandFailedError.details.
    const errWithDetails = Object.assign(new Error("LIBRARY_FORMAT_TOO_NEW: storage observed=0 supported=0"), {
      details: {
        kind: "library_format_too_new",
        surface: "op-stream",
        observed: 4,
        supported: 1,
        group: undefined,
      },
    });
    const detail = parseLibraryFormatTooNew(errWithDetails);
    console.info(`[library-format-too-new:prefer-details] detail=${JSON.stringify(detail)}`);
    // Structured path wins — returns the details fields, not the parsed message.
    if (detail?.surface !== "op-stream" || detail?.observed !== 4 || detail?.supported !== 1) {
      dumpFormatSnapshot("prefer-details", errWithDetails, detail);
    }
    expect(detail?.surface).toBe("op-stream");
    expect(detail?.observed).toBe(4);
    expect(detail?.supported).toBe(1);
  });

  it("structured details with a group survive the details path", () => {
    const errWithDetails = Object.assign(new Error(""), {
      details: {
        kind: "library_format_too_new",
        surface: "schema",
        observed: 9,
        supported: 2,
        group: "playback",
      },
    });
    const detail = parseLibraryFormatTooNew(errWithDetails);
    expect(detail?.surface).toBe("schema");
    expect(detail?.group).toBe("playback");
  });

  it("ignores a details object that lacks the library_format_too_new kind", () => {
    // A details object from some *other* error must not be mistaken for a
    // format-too-new failure — `kind` is the discriminator. With no
    // LIBRARY_FORMAT_TOO_NEW token in the message either, this is not a match.
    const unrelated = Object.assign(new Error("some other failure"), {
      details: { surface: "schema", observed: 9, supported: 2 },
    });
    expect(parseLibraryFormatTooNew(unrelated)).toBeNull();
  });

  it("falls back to degraded detail when token present but message unparseable", () => {
    // A future message-format change could add extra fields. The token
    // guarantees the modal fires; surface degrades to 'storage'.
    const err = new Error("LIBRARY_FORMAT_TOO_NEW: unknown-new-format");
    const detail = parseLibraryFormatTooNew(err);
    expect(detail).not.toBeNull();
    expect(detail?.surface).toBe("storage");
    expect(detail?.observed).toBe(0);
    expect(detail?.supported).toBe(0);
  });

  it("treats a plain string carrying the token the same as an Error", () => {
    const detail = parseLibraryFormatTooNew(
      "LIBRARY_FORMAT_TOO_NEW: storage observed=2 supported=1"
    );
    expect(detail?.surface).toBe("storage");
    expect(detail?.observed).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// isLibraryFormatTooNewMessage — thin wrapper over parseLibraryFormatTooNew
// ---------------------------------------------------------------------------

describe("isLibraryFormatTooNewMessage", () => {
  it("returns true for a too-new error and false for unrelated ones", () => {
    expect(
      isLibraryFormatTooNewMessage(new Error("LIBRARY_FORMAT_TOO_NEW: storage observed=2 supported=1"))
    ).toBe(true);
    expect(isLibraryFormatTooNewMessage(new Error("DECRYPT_FAILED"))).toBe(false);
    expect(isLibraryFormatTooNewMessage(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isDecryptFailureMessage — @bugfix @regression-proof
// The pre-fix version used `===` and missed any wrapped RuntimeCommandFailedError
// message where the code appears embedded in a longer string. The fix was to
// switch to `includes()`. These cases guard both forms.
// ---------------------------------------------------------------------------

describe("isDecryptFailureMessage @bugfix @regression-proof", () => {
  it("exact DECRYPT_FAILED bare Error (direct-SQLite path)", () => {
    // Before the fix AND after: this already worked with ===.
    expect(isDecryptFailureMessage(new Error("DECRYPT_FAILED"))).toBe(true);
  });

  it("DECRYPT_FAILED embedded in a RuntimeCommandFailedError message (proxy path)", () => {
    // Pre-fix (===): this returned false and the error fell to the generic copy.
    // Post-fix (includes()): this returns true and the decryption UI fires.
    const wrapped = new Error(
      "RuntimeCommandFailedError: command=badger.db.open DECRYPT_FAILED at decrypt()"
    );
    const matched = isDecryptFailureMessage(wrapped);
    console.info(`[library-format-too-new:decrypt-wrapped] isDecryptFailureMessage=${matched}`);
    if (matched !== true) {
      dumpFormatSnapshot("decrypt-wrapped", wrapped, matched);
    }
    expect(matched).toBe(true);
  });

  it("MANIFEST_DECRYPT_FAILED bare string", () => {
    expect(isDecryptFailureMessage("MANIFEST_DECRYPT_FAILED")).toBe(true);
  });

  it("MANIFEST_DECRYPT_FAILED embedded in a longer string", () => {
    const wrapped = new Error("LIBRARY_OPEN_FAILED: MANIFEST_DECRYPT_FAILED for chunk-3");
    const matched = isDecryptFailureMessage(wrapped);
    console.info(`[library-format-too-new:decrypt-manifest-embedded] isDecryptFailureMessage=${matched}`);
    if (matched !== true) {
      dumpFormatSnapshot("decrypt-manifest-embedded", wrapped, matched);
    }
    expect(matched).toBe(true);
  });

  it("case-insensitive — lowercase form also matches", () => {
    expect(isDecryptFailureMessage(new Error("decrypt_failed"))).toBe(true);
    expect(isDecryptFailureMessage("manifest_decrypt_failed")).toBe(true);
  });

  it("does NOT match unrelated errors", () => {
    expect(isDecryptFailureMessage(new Error("SYNC_UNAVAILABLE"))).toBe(false);
    expect(isDecryptFailureMessage("LIBRARY_FORMAT_TOO_NEW: storage observed=2 supported=1")).toBe(false);
    expect(isDecryptFailureMessage(null)).toBe(false);
  });

  it("handles non-Error/non-string values gracefully", () => {
    // getLibraryLoadErrorMessage calls String(error ?? 'unknown').
    expect(isDecryptFailureMessage(undefined)).toBe(false);
    expect(isDecryptFailureMessage(42)).toBe(false);
    expect(isDecryptFailureMessage({ message: "DECRYPT_FAILED" })).toBe(false); // not an Error
  });
});

// ---------------------------------------------------------------------------
// getLibraryLoadErrorMessage — base normalizer (sanity)
// ---------------------------------------------------------------------------

describe("getLibraryLoadErrorMessage", () => {
  it("extracts message from Error, falls back to String() for non-Errors", () => {
    expect(getLibraryLoadErrorMessage(new Error("OOPS"))).toBe("OOPS");
    expect(getLibraryLoadErrorMessage("raw string")).toBe("raw string");
    expect(getLibraryLoadErrorMessage(null)).toBe("unknown");
    expect(getLibraryLoadErrorMessage(undefined)).toBe("unknown");
  });
});
