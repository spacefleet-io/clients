import { describe, expect, it } from "vitest";

import { shouldCreateWindowOnExternalMpvShow } from "../src/main/externalMpvWindow";

describe("external mpv window restore", () => {
  it("@bugfix @regression-proof recreates the desktop window when mpv exits after the previous window was destroyed", () => {
    expect(shouldCreateWindowOnExternalMpvShow({ hasWindow: false, isDestroyed: false })).toBe(true);
    expect(shouldCreateWindowOnExternalMpvShow({ hasWindow: true, isDestroyed: true })).toBe(true);
  });

  it("reuses the existing window when it is still alive", () => {
    expect(shouldCreateWindowOnExternalMpvShow({ hasWindow: true, isDestroyed: false })).toBe(false);
  });
});
