import { describe, expect, it } from "vitest";
import type { MediaRow } from "@space/shared/libraryTypes";
import { homeRailEntries, RAIL_LIMIT, selectHomeRails } from "../../lib/homeRails";

// The Home rails are shared by the phone and the TV Home: this pins what the TV rows show.
const row = (id: string, patch: Partial<MediaRow> = {}): MediaRow =>
  ({
    id,
    type: "movie",
    title: id,
    addedAt: "2026-01-01T00:00:00.000Z",
    progressPct: 0,
    lastWatchedAt: null,
    ...patch,
  }) as MediaRow;

const ids = (items: readonly MediaRow[]) => items.map((item) => item.id);

describe("Home rail selectors", () => {
  it("[TV-SHELL-RAILS-001] continue watching holds started, unfinished titles, latest watched first", () => {
    console.info("[TV-SHELL-RAILS-001] phase=start");
    const media = [
      row("fresh"),
      row("old", { progressPct: 40, lastWatchedAt: "2026-02-01T00:00:00.000Z" }),
      row("new", { progressPct: 10, lastWatchedAt: "2026-03-01T00:00:00.000Z" }),
      row("done", { progressPct: 95, lastWatchedAt: "2026-04-01T00:00:00.000Z" }),
    ];
    const rails = selectHomeRails(media, new Set());
    console.info("[TV-SHELL-RAILS-001] phase=result", ids(rails.continueWatching));
    expect(ids(rails.continueWatching)).toEqual(["new", "old"]);
  });

  it("[TV-SHELL-RAILS-002] recently added, movies and shows are newest first and capped", () => {
    console.info("[TV-SHELL-RAILS-002] phase=start");
    const media = Array.from({ length: RAIL_LIMIT + 5 }, (_, index) =>
      row(`m${index}`, { type: index % 2 === 0 ? "movie" : "tv", addedAt: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z` }),
    );
    const rails = selectHomeRails(media, new Set());
    console.info("[TV-SHELL-RAILS-002] phase=result", { recent: rails.recent.length, movies: rails.movies.length });
    expect(rails.recent).toHaveLength(RAIL_LIMIT);
    expect(rails.recent[0]?.id).toBe(`m${RAIL_LIMIT + 4}`);
    expect(rails.movies.every((item) => item.type === "movie")).toBe(true);
    expect(rails.shows.every((item) => item.type === "tv")).toBe(true);
    expect(rails.movies.length).toBeLessThanOrEqual(RAIL_LIMIT);
  });

  it("[TV-SHELL-RAILS-003] favorites are the titles of the favorites playlist", () => {
    console.info("[TV-SHELL-RAILS-003] phase=start");
    const rails = selectHomeRails([row("a"), row("b"), row("c")], new Set(["b", "c", "gone"]));
    expect(ids(rails.favorites)).toEqual(["b", "c"]);
  });

  it("[TV-SHELL-RAILS-004] empty rails are omitted, order is fixed and only continue watching shows progress", () => {
    console.info("[TV-SHELL-RAILS-004] phase=start");
    const media = [row("a", { progressPct: 30, lastWatchedAt: "2026-02-01T00:00:00.000Z" }), row("b", { type: "tv" })];
    const entries = homeRailEntries(selectHomeRails(media, new Set(["a"])));
    console.info("[TV-SHELL-RAILS-004] phase=entries", entries.map((entry) => `${entry.id}:${entry.items.length}`));
    expect(entries.map((entry) => entry.id)).toEqual(["continueWatching", "recent", "movies", "shows", "favorites"]);
    expect(entries.filter((entry) => entry.showProgress).map((entry) => entry.id)).toEqual(["continueWatching"]);
    expect(entries.every((entry) => entry.titleKey.startsWith("home.sections."))).toBe(true);

    const onlyMovies = homeRailEntries(selectHomeRails([row("x")], new Set()));
    expect(onlyMovies.map((entry) => entry.id)).toEqual(["recent", "movies"]);
    expect(homeRailEntries(selectHomeRails([], new Set()))).toEqual([]);
  });
});
