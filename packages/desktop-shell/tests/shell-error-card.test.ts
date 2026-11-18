import { describe, expect, it } from "vitest";
import { shellErrorCardClassName } from "../src/components";

describe("shell error card", () => {
  console.info("[shell-error-card:suite] starting shell error card class contract tests");

  it("keeps stable base class contract", () => {
    console.info("[shell-error-card:test] asserting shellErrorCardClassName() base contract");
    expect(shellErrorCardClassName()).toBe("space-panel text-white backdrop-blur-xl");
  });
});
