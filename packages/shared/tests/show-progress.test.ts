import { describe, expect, it } from "vitest";
import { airDateToday, airedEpisodeCount, showEpisodeTotal, showProgressAggregate, showWatchedPct } from "../src/showProgress";

const TODAY = "2026-10-29";
const ep = (seasonNumber: number, airDate: string | null) => ({ seasonNumber, airDate });
const log = (phase: string, data: unknown) => console.info(`[show-progress] ${phase} ${JSON.stringify(data)}`);

// @req LIB-PROG-01
describe("show watched percentage (LIB-PROG-01)", () => {
  it("counts out of every aired episode, not the episodes in the vault: 10 aired, 2 in the vault, both watched → 20%", () => {
    const episodes = Array.from({ length: 10 }, (_, i) => ep(1, `2020-01-${String(i + 1).padStart(2, "0")}`));
    const total = showEpisodeTotal({ episodes, totalEpisodes: null, today: TODAY });
    const pct = showWatchedPct(
      [
        { seasonNumber: 1, progressPct: 100 },
        { seasonNumber: 1, progressPct: 100 },
      ],
      total?.total ?? 0,
    );
    log("ten-aired-two-watched", { total, pct });
    expect(total).toEqual({ total: 10, source: "aired" });
    expect(pct).toBe(20);
  });

  it("leaves out specials and episodes that have not aired yet, even when the metadata count includes them", () => {
    const episodes = [ep(0, "2019-01-01"), ep(1, "2020-01-01"), ep(1, "2020-01-08"), ep(2, TODAY), ep(2, "2026-11-05"), ep(2, null)];
    expect(airedEpisodeCount(episodes, TODAY)).toBe(3);
    const total = showEpisodeTotal({ episodes, totalEpisodes: 5, today: TODAY });
    log("specials-unaired", { total });
    expect(total).toEqual({ total: 3, source: "aired" });
  });

  it("does not let a watched special move the show's percentage", () => {
    expect(
      showWatchedPct(
        [
          { seasonNumber: 0, progressPct: 100 },
          { seasonNumber: 1, progressPct: 50 },
        ],
        4,
      ),
    ).toBe(12.5);
  });

  it("falls back to the metadata's episode count when the episode list has no air dates", () => {
    expect(showEpisodeTotal({ episodes: [ep(1, null)], totalEpisodes: 236, today: TODAY })).toEqual({ total: 236, source: "metadata" });
  });

  it("falls back to the listed regular episodes only when the metadata has no count or dates (a show added without metadata)", () => {
    expect(showEpisodeTotal({ episodes: [ep(0, null), ep(1, null), ep(1, null)], totalEpisodes: null, today: TODAY })).toEqual({
      total: 2,
      source: "episodes",
    });
    expect(showEpisodeTotal({ episodes: [], totalEpisodes: 0, today: TODAY })).toBeNull();
  });

  it("clamps to 0-100", () => {
    expect(showWatchedPct([{ seasonNumber: 1, progressPct: 100 }, { seasonNumber: 1, progressPct: 100 }], 1)).toBe(100);
    expect(showWatchedPct([{ seasonNumber: 1, progressPct: 100 }], 0)).toBe(0);
  });

  it("dates today in UTC as YYYY-MM-DD", () => {
    expect(airDateToday(new Date("2026-10-29T23:30:00.000Z"))).toBe("2026-10-29");
  });
});

// @req LIB-PROG-01
describe("show progress aggregate (LIB-PROG-01)", () => {
  const rows = [
    { id: "e1", season_number: 1, air_date: "2020-01-01" },
    { id: "e2", season_number: 1, air_date: "2020-01-08" },
    { id: "e3", season_number: 1, air_date: "2020-01-15" },
    { id: "e4", season_number: 1, air_date: "2099-01-01" },
    { id: "s1", season_number: 0, air_date: "2019-12-01" },
  ];

  it("sums the regular episodes' resumes over the aired total and keeps the latest resume time", () => {
    const aggregate = showProgressAggregate({
      episodeRows: rows,
      totalEpisodes: 24,
      resume: {
        e1: { progressPct: 100, updatedAt: "2026-10-01T10:00:00.000Z" },
        e2: { progressPct: 50, updatedAt: "2026-10-02T10:00:00.000Z" },
        s1: { progressPct: 100, updatedAt: "2026-10-03T10:00:00.000Z" },
        gone: { progressPct: 100, updatedAt: null },
      },
      today: TODAY,
      now: "2026-10-29T12:00:00.000Z",
    });
    log("aggregate", aggregate);
    expect(aggregate).toEqual({
      progressPct: 50,
      lastWatchedAt: "2026-10-03T10:00:00.000Z",
      total: 3,
      source: "aired",
      listed: 5,
      withProgress: 4,
    });
  });

  it("falls back to now without resumes, and is null without episodes or a total", () => {
    const now = "2026-10-29T12:00:00.000Z";
    const empty = showProgressAggregate({ episodeRows: rows, totalEpisodes: null, resume: {}, today: TODAY, now });
    const none = showProgressAggregate({ episodeRows: [], totalEpisodes: 10, resume: {}, today: TODAY, now });
    const specialsOnly = showProgressAggregate({
      episodeRows: [{ id: "s1", season_number: 0, air_date: null }],
      totalEpisodes: null,
      resume: {},
      today: TODAY,
      now,
    });
    log("fallbacks", { empty, none, specialsOnly });
    expect(empty).toMatchObject({ progressPct: 0, lastWatchedAt: now, total: 3 });
    expect(none).toBeNull();
    expect(specialsOnly).toBeNull();
  });
});
