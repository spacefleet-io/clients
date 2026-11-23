import { describe, expect, it } from "vitest";
import { MAX_RETRY_AFTER_SECONDS, parseRetryAfterSeconds } from "../src/retryAfter";

describe("parseRetryAfterSeconds", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");

  it("reads delta seconds", () => {
    expect(parseRetryAfterSeconds("120", now)).toBe(120);
    expect(parseRetryAfterSeconds(" 0 ", now)).toBe(0);
  });

  it("reads an HTTP date as the seconds until it, a past date as 0", () => {
    expect(parseRetryAfterSeconds("Thu, 01 Jan 2026 00:01:30 GMT", now)).toBe(90);
    expect(parseRetryAfterSeconds("Wed, 31 Dec 2025 23:00:00 GMT", now)).toBe(0);
  });

  it("caps both forms at one year", () => {
    expect(parseRetryAfterSeconds("99999999999", now)).toBe(MAX_RETRY_AFTER_SECONDS);
    expect(parseRetryAfterSeconds("Fri, 01 Jan 2100 00:00:00 GMT", now)).toBe(MAX_RETRY_AFTER_SECONDS);
  });

  it("answers undefined for an absent or unreadable header", () => {
    expect(parseRetryAfterSeconds("soon", now)).toBeUndefined();
    expect(parseRetryAfterSeconds(null, now)).toBeUndefined();
    expect(parseRetryAfterSeconds(undefined, now)).toBeUndefined();
    expect(parseRetryAfterSeconds("", now)).toBeUndefined();
  });
});
