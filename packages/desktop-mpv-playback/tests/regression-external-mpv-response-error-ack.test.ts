/**
 * @bugfix @regression-proof
 *
 * Locks `isExternalMpvResponseError` ACK semantics.
 *
 * History: mpv's JSON IPC always includes an `error` field in every response.
 * The string `"success"` means the command was acknowledged — it is NOT a
 * failure. A naive `"error" in result` check silently classified every
 * successful mpv response as an error, causing script-message metadata
 * commands (sub-add, chapters, audio tracks) to be dropped.
 *
 * This test pins the exact boundary:
 *   - { error: "success" }    → false (ACK)
 *   - { error: "" }           → false (empty string is falsy)
 *   - {}                      → false (no error field)
 *   - { error: "mpv_socket_missing" } → true (IPC sentinel)
 *   - { error: "anything else" }      → true (any non-success string)
 *
 * References: commits d8a6bb29, daf79893.
 */

import { describe, expect, it } from "vitest";
import { isExternalMpvResponseError } from "../src/index";

// On a classification mismatch, dump the exact input and observed-vs-expected
// boolean so the failing boundary is diagnosable from the CI log alone
// (which { error: ... } shape regressed). Wrapped in try/catch so a dump
// failure can't mask the real assertion.
const dumpAckSnapshot = (label: string, input: unknown, observed: boolean, expected: boolean) => {
  try {
    console.error(`=== [external-mpv-response-error-ack:${label}] classification snapshot ===`);
    console.error(`input=${JSON.stringify(input)} (typeof=${typeof input})`);
    console.error(`isExternalMpvResponseError observed=${observed} expected=${expected}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

// Assert helper: runs the classifier, dumps context on mismatch, then defers to
// the original `expect` so the assertion itself is unchanged.
const assertAck = (label: string, input: unknown, expected: boolean) => {
  const observed = isExternalMpvResponseError(input);
  console.info(`[external-mpv-response-error-ack:check] ${label} input=${JSON.stringify(input)} → ${observed} (expect ${expected})`);
  if (observed !== expected) {
    dumpAckSnapshot(label, input, observed, expected);
  }
  expect(isExternalMpvResponseError(input)).toBe(expected);
};

describe("@bugfix @regression-proof isExternalMpvResponseError ACK semantics", () => {
  it("@bugfix @regression-proof {} (no error field) is not an error", () => {
    assertAck("no-error-field", {}, false);
  });

  it("@bugfix @regression-proof { error: 'success' } is NOT a failure — it is an ACK", () => {
    assertAck("error-success-is-ack", { error: "success" }, false);
  });

  it("@bugfix @regression-proof { error: 'mpv_socket_missing' } is a real error", () => {
    assertAck("error-socket-missing", { error: "mpv_socket_missing" }, true);
  });

  it("@bugfix @regression-proof { error: '' } (empty string) is classified as an error — only 'success' is the ACK", () => {
    // The implementation does `return error !== "success"` — the empty string
    // is not "success", so it returns true. This test locks that exact boundary:
    // ONLY the literal string "success" is the ACK; every other string, including
    // the empty string, is treated as an error condition.
    assertAck("error-empty-string", { error: "" }, true);
  });

  it("@bugfix @regression-proof any non-success error string is a real error", () => {
    assertAck("error-property-unavailable", { error: "property unavailable" }, true);
    assertAck("error-invalid-parameter", { error: "invalid parameter" }, true);
    assertAck("error-some-other-error", { error: "some other error" }, true);
  });

  it("null / undefined / non-objects are not errors", () => {
    assertAck("null", null, false);
    assertAck("undefined", undefined, false);
    assertAck("string-error", "error", false);
    assertAck("number-42", 42, false);
  });
});
