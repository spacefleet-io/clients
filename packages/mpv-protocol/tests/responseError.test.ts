import { describe, expect, it } from "vitest";

import {
  isExternalMpvResponseError,
  isExternalMpvResponseReady,
} from "../src/responseError";

// Per-suite dump helper. Body wrapped in try/catch so a dump failure can never
// mask the real predicate assertion. Records each table input alongside the
// predicate's actual vs expected boolean.
const dumpPredicateSnapshot = (
  label: string,
  rows: Array<{ input: unknown; actual: unknown; expected: unknown }>,
) => {
  try {
    const mismatches = rows.filter((r) => r.actual !== r.expected);
    console.error(`=== [mpv-protocol-responseError:${label}] snapshot ===`);
    console.error(`rows=${rows.length} mismatches=${mismatches.length}`);
    for (const r of rows) {
      console.error(
        `input=${JSON.stringify(r.input)} actual=${JSON.stringify(r.actual)} expected=${JSON.stringify(r.expected)}${r.actual !== r.expected ? " <-- MISMATCH" : ""}`,
      );
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

// Run a predicate over a labeled truth table, dump the full table on any
// mismatch, then assert every row so the failing expect carries through.
const assertPredicateTable = (
  label: string,
  predicate: (input: unknown) => boolean,
  cases: Array<{ input: unknown; expected: boolean }>,
) => {
  const rows = cases.map(({ input, expected }) => ({
    input,
    actual: predicate(input),
    expected,
  }));
  console.info(
    `[mpv-protocol-responseError:${label}] evaluated ${rows.length} cases, mismatches=${rows.filter((r) => r.actual !== r.expected).length}`,
  );
  if (rows.some((r) => r.actual !== r.expected)) {
    dumpPredicateSnapshot(label, rows);
  }
  for (const row of rows) {
    expect(row.actual, `input=${JSON.stringify(row.input)}`).toBe(row.expected);
  }
};

describe("isExternalMpvResponseError", () => {
  it('treats error="success" as ACK, not failure', () => {
    assertPredicateTable("ack-success", isExternalMpvResponseError, [
      { input: { error: "success" }, expected: false },
      { input: { error: "success", data: null }, expected: false },
    ]);
  });

  it("treats non-success error string as real failure", () => {
    assertPredicateTable("error-string", isExternalMpvResponseError, [
      { input: { error: "property unavailable" }, expected: true },
      { input: { error: "mpv_socket_missing" }, expected: true },
      { input: { error: "" }, expected: true },
    ]);
  });

  it("ignores responses with no error field", () => {
    assertPredicateTable("no-error-field", isExternalMpvResponseError, [
      { input: {}, expected: false },
      { input: { data: 0 }, expected: false },
    ]);
  });

  it("returns false for non-object inputs", () => {
    assertPredicateTable("non-object", isExternalMpvResponseError, [
      { input: null, expected: false },
      { input: undefined, expected: false },
      { input: "error", expected: false },
      { input: 42, expected: false },
    ]);
  });

  it("treats truthy non-string error values as failures", () => {
    assertPredicateTable("truthy-nonstring", isExternalMpvResponseError, [
      { input: { error: 42 }, expected: true },
      { input: { error: true }, expected: true },
    ]);
  });

  it("treats falsy non-string error values as not-failures", () => {
    assertPredicateTable("falsy-nonstring", isExternalMpvResponseError, [
      { input: { error: 0 }, expected: false },
      { input: { error: false }, expected: false },
      { input: { error: null }, expected: false },
    ]);
  });
});

describe("isExternalMpvResponseReady", () => {
  it("returns true when data or error field is present", () => {
    assertPredicateTable("ready-present", isExternalMpvResponseReady, [
      { input: { data: 0 }, expected: true },
      { input: { error: "success" }, expected: true },
      { input: { error: "anything" }, expected: true },
    ]);
  });

  it("returns false for empty or non-object inputs", () => {
    assertPredicateTable("ready-empty", isExternalMpvResponseReady, [
      { input: {}, expected: false },
      { input: null, expected: false },
      { input: undefined, expected: false },
      { input: "error", expected: false },
    ]);
  });
});
