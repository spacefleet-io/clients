import { describe, expect, it } from "vitest";
import type { MediaRow } from "../src/renderer/src/lib/libraryDb";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { continueWatchingTitles } from "@space/shared/continueWatching";
import { formatClock } from "@space/shared/format";
import { buildBadgerContinueHeroText as buildContinueHeroText } from "@space/ui/badger/continue-hero";

// Dashboard.tsx hands the shared pick its playable titles only.
const pickContinueHeroItem = (items: MediaRow[]) => continueWatchingTitles(items.filter((item) => item.hasFiles))[0] ?? null;

const row = (id: string, progressPct: number, lastWatchedAt: string | null, hasFiles = true) =>
  ({ id, progressPct, lastWatchedAt, hasFiles, updatedAt: "2026-01-01T00:00:00.000Z", year: "1926" }) as MediaRow;

describe("Home continue-watching hero", () => {
  // @req UX-HOME-01[badger-desktop]
  it("resumes the in-progress playable title watched most recently", () => {
    const picked = pickContinueHeroItem([
      row("old", 40, "2026-11-01T10:00:00.000Z"),
      row("new", 30, "2026-11-08T10:00:00.000Z"),
      row("unplayable", 50, "2026-11-09T10:00:00.000Z", false),
      row("finished", 99, "2026-11-09T11:00:00.000Z"),
      row("unstarted", 0, null),
    ]);
    expect(picked?.id).toBe("new");
    expect(pickContinueHeroItem([row("unstarted", 0, null)])).toBeNull();
    const dashboard = readFileSync(join(__dirname, "../src/renderer/src/pages/Dashboard.tsx"), "utf8");
    expect(dashboard).toContain("continueWatchingTitles(playableMedia)[0]");
  });

  // @req UX-HOME-01[badger-desktop]
  it("shows the runtime, genres and minutes left, and the resume point", () => {
    const text = buildContinueHeroText({ year: "1926", progressPct: 50 }, 4680, ["Comedy", "Action", "War"], (n) => `${n} min left`);
    expect(text).toEqual({ meta: "1926 · 1h 18m · Comedy · Action · 39 min left", resumeAtSeconds: 2340 });
    expect(formatClock(2340)).toBe("39:00");
    expect(formatClock(3903)).toBe("1:05:03");
  });

  it("leaves the time out when the runtime is unknown (a show)", () => {
    const text = buildContinueHeroText({ year: null, progressPct: 50 }, null, ["Drama"], (n) => `${n} min left`);
    expect(text).toEqual({ meta: "Drama", resumeAtSeconds: null });
  });
});
