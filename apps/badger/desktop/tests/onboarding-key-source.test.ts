import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("OnboardingKey source", () => {
  // UX-SETUP-08: the key step is framed like the other setup steps, with no top bar; it never shows the signed-in
  // TopNav either (the bug this guarded against).
  it("@bugfix @regression-proof frames the key onboarding screen like the other setup steps, with no top bar", () => {
    const source = readFileSync(
      join(process.cwd(), "src/renderer/src/pages/OnboardingKey.tsx"),
      "utf8"
    );
    const pages = source.match(/<DesktopStartupPage\b[^>]*>/g) ?? [];
    console.info(`[onboarding-key-source] pages=${JSON.stringify(pages)}`);

    expect(source).not.toContain('import TopNav from "../components/TopNav";');
    expect(source).not.toContain("PublicTopNav");
    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages) expect(page).not.toContain("topNav=");
  });
});
