import { describe, expect, it } from "vitest";

import { shouldPreloadPrimaryRoutes } from "@/lib/routePreload";

describe("route preload policy", () => {
  it("does not preload authenticated-only chunks for logged-out users", () => {
    expect(shouldPreloadPrimaryRoutes(false)).toBe(false);
  });

  it("preloads the primary authenticated chunks after sign-in", () => {
    expect(shouldPreloadPrimaryRoutes(true)).toBe(true);
  });
});
