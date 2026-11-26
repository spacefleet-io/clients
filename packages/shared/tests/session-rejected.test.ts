/**
 * `isSessionRejected` is the one "the API refused this session" check (401/403) for every app: Badger desktop
 * (auth start-up, the device check, the forced-logout probe), both phones, the web vault and Parrot (REL-FAM-05).
 * Anything else, including a 5xx, no network or a non-API error that happens to carry a `status`, keeps the session.
 */
import { describe, expect, it } from "vitest";
import { ApiError, isSessionRejected } from "../src/api";

const cases: Array<[label: string, error: unknown, rejected: boolean]> = [
  ["ApiError 401", new ApiError(401, { error: "unauthorized" }), true],
  ["ApiError 403", new ApiError(403, { error: "forbidden" }), true],
  ["ApiError 500", new ApiError(500, { error: "server_error" }), false],
  ["ApiError 503", new ApiError(503, { error: "unavailable" }), false],
  ["ApiError 0 (no answer)", new ApiError(0, { error: "network_failed" }), false],
  ["plain Error", new Error("network_failed"), false],
  ["non-API error with status 401", Object.assign(new Error("tunnel"), { status: 401 }), false],
  ["null", null, false],
];

describe("isSessionRejected", () => {
  it.each(cases)("%s → %s", (label, error, rejected) => {
    const actual = isSessionRejected(error);
    if (actual !== rejected) console.error(`[session-rejected] ${label}: expected ${rejected}, got ${actual}`);
    expect(actual).toBe(rejected);
  });
});
