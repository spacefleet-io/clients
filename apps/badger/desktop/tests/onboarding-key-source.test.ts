import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("OnboardingKey source", () => {
  it("@bugfix @regression-proof uses the public top nav on the key onboarding screen", () => {
    const source = readFileSync(
      join(process.cwd(), "src/renderer/src/pages/OnboardingKey.tsx"),
      "utf8"
    );

    expect(source).toContain('import PublicTopNav from "../components/PublicTopNav";');
    expect(source).not.toContain('import TopNav from "../components/TopNav";');
    expect(source).toMatch(/<DesktopStartupPage\b[^>]*\btopNav=\{<PublicTopNav \/>\}/);
  });
});
