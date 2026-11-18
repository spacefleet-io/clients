import { describe, expect, it } from "vitest";
import { ApiError, isSessionRejected } from "@space/shared/api";

describe("@bugfix @regression-proof offline cold start must keep the stored session", () => {
  it("keeps the session when the server is unreachable (airplane mode: fetch rejects with TypeError)", () => {
    const err = new TypeError("Network request failed");
    console.info("network failure rejected?", isSessionRejected(err));
    expect(isSessionRejected(err)).toBe(false);
  });

  it("keeps the session on server errors and timeouts", () => {
    expect(isSessionRejected(new ApiError(500, { error: "boom" }))).toBe(false);
    expect(isSessionRejected(new ApiError(503, { error: "unavailable" }))).toBe(false);
    expect(isSessionRejected(new Error("timeout"))).toBe(false);
  });

  it("drops the session only when the server rejects the token", () => {
    expect(isSessionRejected(new ApiError(401, { error: "unauthorized" }))).toBe(true);
    expect(isSessionRejected(new ApiError(403, { error: "forbidden" }))).toBe(true);
  });
});
