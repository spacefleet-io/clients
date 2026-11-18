import { describe, expect, it } from "vitest";
import { resolveAuthGuardStatus } from "../src/guards";

describe("auth guard status resolver", () => {
  it("returns loading when auth is loading", () => {
    expect(resolveAuthGuardStatus({ loading: true, isAuthenticated: false })).toBe("loading");
  });

  it("returns unauthenticated when no user", () => {
    expect(resolveAuthGuardStatus({ loading: false, isAuthenticated: false })).toBe("unauthenticated");
  });

  it("returns blocked when user is marked blocked", () => {
    expect(resolveAuthGuardStatus({ loading: false, isAuthenticated: true, isBlocked: true })).toBe("blocked");
  });

  it("returns ready for normal authenticated users", () => {
    expect(resolveAuthGuardStatus({ loading: false, isAuthenticated: true, isBlocked: false })).toBe("ready");
  });
});
