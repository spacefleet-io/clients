import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(
  path.resolve(process.cwd(), "src/renderer/src/lib/useMpvPlaybackEngine.ts"),
  "utf8"
);

describe("[@bugfix][@regression-proof] last-sent-pause tracking", () => {
  it("declares lastSentPauseRef alongside the other refs", () => {
    expect(SOURCE).toContain("lastSentPauseRef");
    expect(SOURCE).toMatch(/lastSentPauseRef\s*=\s*useRef</);
  });

  it("passes lastSentPause: lastSentPauseRef.current to shouldForceResumeExternalPlayback", () => {
    expect(SOURCE).toMatch(
      /shouldForceResumeExternalPlayback\(\{[\s\S]*?lastSentPause:\s*lastSentPauseRef\.current/
    );
  });

  it("updates the tracker before sending pause commands (at least one assignment site)", () => {
    const trackerAssignments = (SOURCE.match(/lastSentPauseRef\.current\s*=\s*\{/g) ?? []).length;
    expect(trackerAssignments).toBeGreaterThanOrEqual(1);
  });
});
