// @req UX-HOME-06
import { describe, expect, it } from "vitest";
import {
  buildDefaultHomeLayout,
  createHomeGenreSection,
  createHomeSection,
  HOME_LAYOUT_KEY,
  homeLayoutPlaylistIds,
  homeMediaVersion,
  homeSectionLabel,
  homeSectionRows,
  mergeHomeSectionItems,
  parseHomeLayout,
  seededShuffle,
  type HomeLayoutItem,
  type HomeSectionConfig,
} from "../src/homeLayout";

const item = (id: string, patch: Partial<HomeLayoutItem> = {}): HomeLayoutItem => ({
  id,
  type: "movie",
  progressPct: 0,
  lastWatchedAt: null,
  addedAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  genres: [],
  ...patch,
});

const playlists = [
  { id: "pl-fav", slug: "favorites", name: "Favorites" },
  { id: "pl-watch", slug: "watchlist", name: "Watchlist" },
  { id: "pl-mine", slug: null, name: "Friday films" },
];

const sources = (patch: Partial<Parameters<typeof homeSectionRows>[2]> = {}) => ({
  favorites: new Set<string>(),
  playlistItems: new Map<string, ReadonlySet<string>>(),
  limit: 10,
  ...patch,
});

const ids = (rows: { section: HomeSectionConfig; items: HomeLayoutItem[] }[]) =>
  rows.map((row) => `${row.section.type}:${row.items.map((entry) => entry.id).join(",")}`);

describe("UX-HOME-06 Home layout shared by every Badger app", () => {
  it("[UX-HOME-06] the setting key is the desktop's saved layout", () => {
    expect(HOME_LAYOUT_KEY).toBe("dashboard_layout_v1");
  });

  it("[UX-HOME-06] the default layout ends on the watchlist only when the library has one", () => {
    const withWatchlist = buildDefaultHomeLayout(playlists).map((section) => section.id);
    const without = buildDefaultHomeLayout([playlists[0]]).map((section) => section.id);
    console.info("[UX-HOME-06] default", { withWatchlist, without });
    expect(withWatchlist).toEqual(["section-continue", "section-recent", "section-unwatched", "section-favorites", "section-playlist-pl-watch"]);
    expect(without).toEqual(["section-continue", "section-recent", "section-unwatched", "section-favorites"]);
  });

  it("[UX-HOME-06] a saved layout keeps its order and drops what no app can draw", () => {
    const raw = JSON.stringify({
      updatedAt: "2026-11-26T10:00:00Z",
      sections: [
        { id: "a", type: "rewatch", libraries: ["tv"], styleId: 3 },
        { type: "watchlist", libraries: [] },
        { id: "gone", type: "playlist", playlistId: "deleted" },
        { id: "g", type: "genre", genreId: 18, genreType: "tv", libraries: ["movies"] },
        { id: "bad-genre", type: "genre" },
        { id: "mystery", type: "movies" },
        null,
        { id: "c", type: "continue" },
      ],
    });
    let next = 0;
    const layout = parseHomeLayout(raw, playlists, () => `new-${++next}`);
    console.info("[UX-HOME-06] parsed", layout);
    expect(layout).toEqual([
      { id: "a", type: "rewatch", playlistId: null, genreId: null, genreType: null, libraries: ["tv"], styleId: 3 },
      { id: "new-1", type: "playlist", playlistId: "pl-watch", genreId: null, genreType: null, libraries: ["movies", "tv"], styleId: 0 },
      { id: "g", type: "genre", playlistId: null, genreId: 18, genreType: "tv", libraries: ["tv"], styleId: 0 },
      { id: "c", type: "continue", playlistId: null, genreId: null, genreType: null, libraries: ["movies", "tv"], styleId: 0 },
    ]);
  });

  it("[UX-HOME-06] nothing saved, broken JSON or nothing usable gives the default layout", () => {
    const fallback = buildDefaultHomeLayout(playlists);
    expect(parseHomeLayout(null, playlists)).toEqual(fallback);
    expect(parseHomeLayout("{not json", playlists)).toEqual(fallback);
    expect(parseHomeLayout(JSON.stringify({ sections: "x" }), playlists)).toEqual(fallback);
    expect(parseHomeLayout(JSON.stringify({ sections: [{ id: "x", type: "nope" }] }), playlists)).toEqual(fallback);
  });

  it("[UX-HOME-06] each section picks its titles the desktop way, in the layout's order", () => {
    const media = [
      item("started-old", { progressPct: 40, lastWatchedAt: "2026-02-01T00:00:00Z" }),
      item("started-new", { type: "tv", progressPct: 50, lastWatchedAt: "2026-03-01T00:00:00Z" }),
      item("barely", { progressPct: 1, lastWatchedAt: "2026-04-01T00:00:00Z" }),
      item("done", { progressPct: 99, updatedAt: "2026-05-01T00:00:00Z" }),
      item("new-show", { type: "tv", addedAt: "2026-06-01T00:00:00Z", updatedAt: "2026-06-02T00:00:00Z" }),
      item("no-file", { addedAt: "2026-07-01T00:00:00Z", hasFiles: false }),
      item("drama", { genres: [18], updatedAt: "2026-01-02T00:00:00Z" }),
    ];
    const layout = [
      createHomeSection("recent"),
      createHomeSection("continue"),
      createHomeSection("rewatch"),
      createHomeSection("favorites"),
      createHomeSection("playlist", "pl-mine"),
      createHomeGenreSection("movie", 18),
      createHomeGenreSection("tv", 18),
    ];
    const rows = homeSectionRows(layout, media, sources({
      favorites: new Set(["drama", "new-show"]),
      playlistItems: new Map([["pl-mine", new Set(["done", "started-old"])]]),
    }));
    console.info("[UX-HOME-06] rows", ids(rows));
    expect(ids(rows)).toEqual([
      // Newest first (same day: films before shows); a title without a stored file shows nowhere.
      "recent:new-show,started-old,barely,done,drama,started-new",
      // Started (2 % and up) and not finished, watched last first.
      "continue:started-new,started-old",
      "rewatch:done",
      // Updated last first.
      "favorites:new-show,drama",
      "playlist:done,started-old",
      "genre:drama",
      // The TV drama section has no title: it is not drawn.
    ]);
  });

  it("[UX-HOME-06] a section limited to films leaves the shows out, and the row length is the app's", () => {
    const media = Array.from({ length: 6 }, (_, index) =>
      item(`t${index}`, { type: index % 2 ? "tv" : "movie", addedAt: `2026-0${index + 1}-01T00:00:00Z` }),
    );
    const recentMovies = { ...createHomeSection("recent"), libraries: ["movies" as const] };
    const rows = homeSectionRows([recentMovies], media, sources({ limit: 2 }));
    console.info("[UX-HOME-06] films only", ids(rows));
    expect(ids(rows)).toEqual(["recent:t4,t2"]);
  });

  it("[UX-HOME-06] Unwatched picks is the same shuffle for the same library on every app", () => {
    const media = Array.from({ length: 30 }, (_, index) => item(`u${index}`, { type: index % 3 ? "movie" : "tv" }));
    const layout = [createHomeSection("unwatched")];
    const first = ids(homeSectionRows(layout, media, sources()));
    const second = ids(homeSectionRows(layout, [...media].reverse().reverse(), sources()));
    const otherVersion = ids(homeSectionRows(layout, media, sources({ mediaVersion: "other" })));
    console.info("[UX-HOME-06] picks", { first, otherVersion });
    expect(second).toEqual(first);
    expect(first[0].split(",")).toHaveLength(10);
    expect(otherVersion).not.toEqual(first);
    expect(seededShuffle([1, 2, 3, 4, 5], "seed")).toEqual(seededShuffle([1, 2, 3, 4, 5], "seed"));
  });

  it("[UX-HOME-06] the merge step keeps a genre row's own order and sorts the rest", () => {
    const genre = createHomeGenreSection("tv", 18);
    const a = item("a", { type: "tv" });
    const b = item("b", { type: "tv" });
    expect(mergeHomeSectionItems(genre, [item("m")], [b, a], "v").map((entry) => entry.id)).toEqual(["b", "a"]);
    const favorites = createHomeSection("favorites");
    const older = item("older", { updatedAt: "2026-01-01T00:00:00Z" });
    const newer = item("newer", { type: "tv", updatedAt: "2026-02-01T00:00:00Z" });
    expect(mergeHomeSectionItems(favorites, [older], [newer], "v").map((entry) => entry.id)).toEqual(["newer", "older"]);
  });

  it("[UX-HOME-06] an empty library draws no section", () => {
    expect(homeSectionRows(buildDefaultHomeLayout(playlists), [], sources())).toEqual([]);
  });

  it("[UX-HOME-06] media version, playlist ids and headings", () => {
    expect(homeMediaVersion([item("a", { updatedAt: "2026-02-01" }), item("b", { updatedAt: "2026-03-01" })])).toBe("2:2026-03-01");
    const layout = [createHomeSection("playlist", "pl-mine"), createHomeSection("playlist", "pl-mine"), createHomeSection("recent")];
    expect(homeLayoutPlaylistIds(layout)).toEqual(["pl-mine"]);
    const label = (type: string) => `t:${type}`;
    expect(homeSectionLabel(createHomeSection("playlist", "pl-mine"), playlists, "en", label)).toBe("Friday films");
    expect(homeSectionLabel(createHomeSection("playlist", "missing"), playlists, "en", label)).toBe("t:playlist");
    expect(homeSectionLabel(createHomeGenreSection("movie", 18), playlists, "fr", label)).toBe("Drame");
    expect(homeSectionLabel(createHomeSection("unwatched"), playlists, "en", label)).toBe("t:unwatched");
  });
});
