// @req UX-HOME-06[badger-mobile,badger-tv]
import { describe, expect, it } from "vitest";
import { createHomeGenreSection, createHomeSection, parseHomeLayout } from "@space/shared/homeLayout";
import type { MediaRow } from "@space/shared/libraryTypes";
import { homeRailEntries, RAIL_LIMIT, type HomeRailInputs } from "../../lib/homeRails";
import { phoneHomeLayout, seeAllTarget } from "../../lib/phoneHome";

// The Home rails are shared by the phone and the TV Home: the computer's layout, in its order (UX-HOME-06).
const row = (id: string, patch: Partial<MediaRow> = {}): MediaRow =>
  ({
    id,
    type: "movie",
    title: id,
    genres: [],
    addedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    hasFiles: true,
    progressPct: 0,
    lastWatchedAt: null,
    ...patch,
  }) as MediaRow;

const ids = (items: readonly MediaRow[]) => items.map((item) => item.id);

const inputs = (patch: Partial<HomeRailInputs> = {}): HomeRailInputs => ({
  layout: parseHomeLayout(null, []),
  favoriteIds: new Set(),
  playlistItems: new Map(),
  playlists: [],
  language: "en",
  t: (key) => `t:${key}`,
  ...patch,
});

describe("Home rails from the computer's layout", () => {
  it("[TV-SHELL-RAILS-001] @req UX-HOME-06 the saved layout's sections show in its order, empty ones hidden", () => {
    console.info("[TV-SHELL-RAILS-001] phase=start");
    const media = [
      row("fresh", { addedAt: "2026-03-01T00:00:00.000Z" }),
      row("started", { progressPct: 40, lastWatchedAt: "2026-02-01T00:00:00.000Z", genres: [18] }),
      row("show", { type: "tv", addedAt: "2026-02-01T00:00:00.000Z" }),
    ];
    const raw = JSON.stringify({
      sections: [
        createHomeSection("favorites"),
        createHomeGenreSection("movie", 18),
        createHomeSection("recent"),
        createHomeSection("rewatch"),
        createHomeSection("continue"),
      ],
    });
    const entries = homeRailEntries(media, inputs({ layout: parseHomeLayout(raw, []), favoriteIds: new Set(["show"]) }));
    console.info("[TV-SHELL-RAILS-001] phase=result", entries.map((entry) => `${entry.section.type}:${ids(entry.items).join("+")}`));
    expect(entries.map((entry) => entry.section.type)).toEqual(["favorites", "genre", "recent", "continue"]);
    expect(ids(entries[0]!.items)).toEqual(["show"]);
    expect(ids(entries[1]!.items)).toEqual(["started"]);
    expect(entries[1]!.title).toBe("Drama");
    expect(ids(entries[3]!.items)).toEqual(["started"]);
    expect(entries.filter((entry) => entry.showProgress).map((entry) => entry.section.type)).toEqual(["continue"]);
  });

  it("[TV-SHELL-RAILS-002] @req UX-HOME-06 nothing saved gives the desktop's default sections, capped at the rail size", () => {
    console.info("[TV-SHELL-RAILS-002] phase=start");
    const media = Array.from({ length: RAIL_LIMIT + 5 }, (_, index) =>
      row(`m${index}`, { type: index % 2 === 0 ? "movie" : "tv", addedAt: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z` }),
    );
    const entries = homeRailEntries(media, inputs());
    console.info("[TV-SHELL-RAILS-002] phase=result", entries.map((entry) => `${entry.section.type}:${entry.items.length}`));
    expect(entries.map((entry) => entry.section.type)).toEqual(["recent", "unwatched"]);
    expect(entries.map((entry) => entry.title)).toEqual(["t:home.sections.recentlyAdded", "t:home.sections.unwatched"]);
    expect(entries.every((entry) => entry.items.length === RAIL_LIMIT)).toBe(true);
    expect(entries[0]!.items[0]?.id).toBe(`m${RAIL_LIMIT + 4}`);
    expect(homeRailEntries([], inputs())).toEqual([]);
  });

  it("[TV-SHELL-RAILS-003] @req UX-HOME-06 a playlist row is headed by its name and shows its titles", () => {
    console.info("[TV-SHELL-RAILS-003] phase=start");
    const playlists = [{ id: "p1", name: "Road trip", slug: null }];
    const raw = JSON.stringify({ sections: [createHomeSection("playlist", "p1"), createHomeSection("playlist", "gone")] });
    const entries = homeRailEntries(
      [row("a"), row("b"), row("c")],
      inputs({ layout: parseHomeLayout(raw, playlists), playlists, playlistItems: new Map([["p1", new Set(["b", "c"])]]) }),
    );
    console.info("[TV-SHELL-RAILS-003] phase=result", entries.map((entry) => `${entry.title}:${ids(entry.items).join("+")}`));
    expect(entries.map((entry) => entry.title)).toEqual(["Road trip"]);
    expect(ids(entries[0]!.items).sort()).toEqual(["b", "c"]);
  });

  it("[TV-SHELL-RAILS-004] @req UX-HOME-06 the hero is the Continue watching pick and leaves that row; See all follows the section", () => {
    console.info("[TV-SHELL-RAILS-004] phase=start");
    const media = [
      row("old", { progressPct: 40, lastWatchedAt: "2026-02-01T00:00:00.000Z" }),
      row("new", { progressPct: 10, lastWatchedAt: "2026-03-01T00:00:00.000Z" }),
    ];
    const raw = JSON.stringify({ sections: [createHomeSection("recent"), createHomeSection("continue")] });
    const { hero, rails } = phoneHomeLayout(media, homeRailEntries(media, inputs({ layout: parseHomeLayout(raw, []) })));
    console.info("[TV-SHELL-RAILS-004] phase=layout", hero?.id, rails.map((rail) => `${rail.section.type}:${ids(rail.items).join("+")}`));
    expect(hero?.id).toBe("new");
    expect(rails.map((rail) => rail.section.type)).toEqual(["recent", "continue"]);
    expect(ids(rails[1]!.items)).toEqual(["old"]);

    const onlyHero = phoneHomeLayout([media[1]!], homeRailEntries([media[1]!], inputs({ layout: parseHomeLayout(raw, []) })));
    expect(onlyHero.rails.map((rail) => rail.section.type)).toEqual(["recent"]);

    console.info("[TV-SHELL-RAILS-004] phase=seeAll");
    expect(seeAllTarget(createHomeSection("favorites"))).toEqual({ tab: "playlists" });
    expect(seeAllTarget(createHomeSection("playlist", "p1"))).toEqual({ tab: "playlists" });
    expect(seeAllTarget(createHomeGenreSection("tv", 18))).toEqual({ tab: "library", scope: "tv" });
    expect(seeAllTarget({ ...createHomeSection("recent"), libraries: ["tv"] })).toEqual({ tab: "library", scope: "tv" });
    expect(seeAllTarget(createHomeSection("recent"))).toEqual({ tab: "library", scope: "movies" });
  });
});
