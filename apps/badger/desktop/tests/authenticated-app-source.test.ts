import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("AuthenticatedApp source", () => {
  it("@bugfix @regression-proof suspends automatic library loading on the onboarding key route", () => {
    const source = readFileSync(
      join(process.cwd(), "src/renderer/src/AuthenticatedApp.tsx"),
      "utf8"
    );

    expect(source).toContain('const suspendLibraryLoad = location.pathname === "/onboarding/key";');
    expect(source).toContain("<LibraryProvider suspendLoad={suspendLibraryLoad}>");
    expect(source).toContain("<LabJobsProvider defer>");
  });
});
