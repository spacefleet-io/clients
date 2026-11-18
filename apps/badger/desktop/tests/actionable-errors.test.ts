import { describe, expect, it } from "vitest";

import { BETTER_SQLITE_NATIVE_LOAD_GUIDANCE } from "../src/main/nativeDeps";
import { getActionableDesktopErrorMessage } from "../src/renderer/src/lib/actionableErrors";

describe("actionable desktop error messages", () => {
  it("@bugfix @regression-proof preserves native sqlite load guidance instead of collapsing it into a generic onboarding error", () => {
    const message = BETTER_SQLITE_NATIVE_LOAD_GUIDANCE;
    expect(getActionableDesktopErrorMessage(new Error(message))).toBe(message);
    expect(getActionableDesktopErrorMessage(message)).toBe(message);
  });

  it("ignores non-actionable errors", () => {
    expect(getActionableDesktopErrorMessage(new Error("DECRYPT_FAILED"))).toBeNull();
    expect(getActionableDesktopErrorMessage("")).toBeNull();
  });
});
