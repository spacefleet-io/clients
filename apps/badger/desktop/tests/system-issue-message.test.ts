import { describe, expect, it } from "vitest";
import { getSystemIssueMessage } from "../src/renderer/src/lib/systemIssueMessage";

describe("system issue message", () => {
  it("[@bugfix][@regression-proof] maps known contract issues to user-facing banner text", () => {
    expect(getSystemIssueMessage("maintenance_window")).toBe(
      "Library is temporarily read-only during maintenance."
    );
    expect(getSystemIssueMessage("schema_upgrade_required")).toBe(
      "Library is read-only until the migration completes."
    );
  });

  it("[@bugfix][@regression-proof] falls back to a safe generic message for unknown issues", () => {
    expect(getSystemIssueMessage("unknown_reason")).toBe(
      "Library writes are temporarily blocked due to backend compatibility."
    );
  });
});

