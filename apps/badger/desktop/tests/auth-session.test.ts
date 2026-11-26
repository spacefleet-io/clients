import { describe, expect, it } from "vitest";
import { shouldClearSessionFromAuthError } from "../src/renderer/src/authSession";

describe("shouldClearSessionFromAuthError", () => {
  it("clears session for unauthorized and forbidden", () => {
    expect(shouldClearSessionFromAuthError({ status: 401 })).toBe(true);
    expect(shouldClearSessionFromAuthError({ status: 403 })).toBe(true);
  });

  it("does not clear session for transient/server/network errors", () => {
    expect(shouldClearSessionFromAuthError({ status: 500 })).toBe(false);
    expect(shouldClearSessionFromAuthError({ status: 503 })).toBe(false);
    expect(shouldClearSessionFromAuthError(new Error("network_failed"))).toBe(false);
    expect(shouldClearSessionFromAuthError(null)).toBe(false);
  });
});
