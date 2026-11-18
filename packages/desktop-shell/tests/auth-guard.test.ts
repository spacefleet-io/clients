import { describe, expect, it } from "vitest";
import { resolveAuthGuardStatus } from "../src/guards";

describe("auth guard status resolver", () => {
  console.info("[auth-guard:suite] starting auth-guard status resolver tests");

  it("returns loading when auth is loading", () => {
    const input = { loading: true, isAuthenticated: false };
    console.info(`[auth-guard:test] input=${JSON.stringify(input)} → expects "loading"`);
    expect(resolveAuthGuardStatus(input)).toBe("loading");
  });

  it("returns unauthenticated when no user", () => {
    const input = { loading: false, isAuthenticated: false };
    console.info(`[auth-guard:test] input=${JSON.stringify(input)} → expects "unauthenticated"`);
    expect(resolveAuthGuardStatus(input)).toBe("unauthenticated");
  });

  it("returns ready for normal authenticated users", () => {
    const input = { loading: false, isAuthenticated: true };
    console.info(`[auth-guard:test] input=${JSON.stringify(input)} → expects "ready"`);
    expect(resolveAuthGuardStatus(input)).toBe("ready");
  });
});
