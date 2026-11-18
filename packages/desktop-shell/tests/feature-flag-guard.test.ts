import { describe, expect, it } from "vitest";
import { resolveFeatureFlagRedirect } from "../src/guards";

describe("feature-flag guard redirect resolver", () => {
  console.info("[feature-flag-guard:suite] starting feature-flag redirect resolver tests");

  it("redirects when feature is disabled", () => {
    console.info("[feature-flag-guard:test] enabled=false fallback=/home → expects redirect");
    expect(resolveFeatureFlagRedirect(false, "/home")).toBe("/home");
  });

  it("allows route when feature is enabled", () => {
    console.info("[feature-flag-guard:test] enabled=true fallback=/home → expects null");
    expect(resolveFeatureFlagRedirect(true, "/home")).toBeNull();
  });
});
