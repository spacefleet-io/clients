import { describe, expect, it } from "vitest";
import { ensureWriteAllowed } from "../src/renderer/src/lib/writeGuard";

describe("library write guard", () => {
  it("[@bugfix][@regression-proof] allows writes when no system issue is present", () => {
    expect(() => ensureWriteAllowed(null)).not.toThrow();
  });

  it("[@bugfix][@regression-proof] blocks writes when system contract reports issue", () => {
    expect(() => ensureWriteAllowed("schema_upgrade_required")).toThrow(
      "LIBRARY_WRITE_BLOCKED:schema_upgrade_required"
    );
  });
});

