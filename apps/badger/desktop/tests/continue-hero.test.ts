import { describe, expect, it } from "vitest";
import { formatClock } from "@space/shared/format";
import { buildBadgerContinueHeroText as buildContinueHeroText } from "@space/ui/badger/continue-hero";

// Which title the hero shows is checked on the real Home page in dashboard-continue-hero.test.tsx.
describe("Home continue-watching hero", () => {
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
