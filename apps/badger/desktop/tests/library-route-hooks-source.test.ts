import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("library route hook source contracts", () => {
  it("keeps Dashboard on split library contexts instead of the merged hook", () => {
    const source = readFileSync(resolve(process.cwd(), "src/renderer/src/pages/Dashboard.tsx"), "utf8");

    expect(source).toContain("useLibraryActions");
    expect(source).toContain("useLibraryData");
    expect(source).toContain("useLibraryShell");
    expect(source).not.toContain("useLibrary()");
  });

  it("keeps Library on split library contexts instead of the merged hook", () => {
    const source = readFileSync(resolve(process.cwd(), "src/renderer/src/pages/Library.tsx"), "utf8");

    expect(source).toContain("useLibraryActions");
    expect(source).toContain("useLibraryData");
    expect(source).toContain("useLibraryShell");
    expect(source).not.toContain("useLibrary()");
  });
});
