import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readSource = (relativePath: string) => readFileSync(resolve(process.cwd(), relativePath), "utf8");

/**
 * @test-id DESKTOP-PLAYBACK-DIALOG-001
 * @level source-contract
 * @bugfix
 * @regression-proof Fails if the resume Dialog loses its onOpenChange handler, which
 *   prevents closing via X button, Escape, or clicking outside.
 */
describe("media playback resume dialog source contracts", () => {
  it("@bugfix @regression-proof resume Dialog has onOpenChange wired to dismiss on close", () => {
    const source = readSource("src/renderer/src/components/MediaPlaybackController.tsx");

    // The Dialog must have onOpenChange so it can be dismissed
    expect(source).toContain("Dialog open={resumePromptOpen} onOpenChange=");

    // The onOpenChange handler must reset all relevant state
    expect(source).toContain("setResumePromptOpen(false)");
    expect(source).toContain("setDeferForPrompt(false)");
    expect(source).toContain("setPlaybackOpen(false)");
  });
});
