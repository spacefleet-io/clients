// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("AppBackdrop", () => {
  it("[@bugfix][@regression-proof] uses the shared desktop app backdrop in the authenticated shell", () => {
    const source = readFileSync(resolve(process.cwd(), "src/renderer/src/AuthenticatedApp.tsx"), "utf8");
    expect(source).toContain('import AppBackdrop from "@space/ui/app-backdrop"');
    expect(source).not.toContain('from "@/components/AppBackdrop"');
  });
});
