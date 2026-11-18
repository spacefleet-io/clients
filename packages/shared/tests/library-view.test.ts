import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIBRARY_TAB_PREFS,
  DEFAULT_LIBRARY_VIEW_PREFS,
  EMPTY_LIBRARY_FILTERS,
  countActiveLibraryFilters,
  filterLibraryItems,
  hasActiveLibraryFilters,
  patchLibraryTabPrefs,
  sanitizeLibraryViewPrefs,
  sortLibraryItems,
  toggleLibraryFilterValue,
  type LibraryListItem,
} from "../src/libraryView";

const item = (patch: Partial<LibraryListItem> & { id: string }): LibraryListItem => ({
  type: "movie",
  title: patch.id,
  year: null,
  addedAt: "2026-01-01T00:00:00.000Z",
  genres: [],
  ...patch,
});

describe("filterLibraryItems", () => {
  const items = [
    item({ id: "movie-1", title: "Signal Bay", genres: [1] }),
    item({ id: "tv-1", type: "tv", title: "Counsel Street", genres: [2] }),
  ];
  const castLookup = new Map([
    ["movie-1", new Set(["nora vale"])],
    ["tv-1", new Set(["ines marlow"])],
  ]);

  it("filters by query, genres, and selected actors", () => {
    const filtered = filterLibraryItems({
      items,
      query: "counsel",
      selectedGenres: ["tv:2"],
      selectedActors: ["Ines Marlow"],
      castLookup,
    });
    expect(filtered.map((entry) => entry.id)).toEqual(["tv-1"]);
  });

  it("keeps everything when no filter is set", () => {
    const filtered = filterLibraryItems({ items, query: "", selectedGenres: [], selectedActors: [], castLookup });
    expect(filtered).toHaveLength(2);
  });

  it("matches a genre key only for its own media type", () => {
    const filtered = filterLibraryItems({ items, query: "", selectedGenres: ["movie:2"], selectedActors: [], castLookup });
    expect(filtered).toEqual([]);
  });

  it("drops titles whose cast is unknown when an actor is selected", () => {
    const filtered = filterLibraryItems({
      items,
      query: "",
      selectedGenres: [],
      selectedActors: ["nora vale"],
      castLookup: new Map(),
    });
    expect(filtered).toEqual([]);
  });
});

describe("sortLibraryItems", () => {
  const items = [
    item({ id: "a", title: "Old", year: "2010", addedAt: "2026-03-25T10:00:00.000Z" }),
    item({ id: "b", title: "New", year: "2020", addedAt: "2026-03-25T09:00:00.000Z" }),
    item({ id: "c", title: "Zed", year: null, addedAt: "2026-03-25T11:00:00.000Z" }),
  ];

  it("sorts by release year descending, unknown years last", () => {
    expect(sortLibraryItems(items, "release", "desc").map((entry) => entry.id)).toEqual(["b", "a", "c"]);
  });

  // @bugfix @regression-proof: an unknown year counted as 0, so ascending order listed those titles first.
  it("@bugfix @regression-proof sorts by release year ascending, unknown years still last", () => {
    expect(sortLibraryItems(items, "release", "asc").map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    const withBlanks = [
      item({ id: "blank", title: "Blank", year: "" }),
      ...items,
      item({ id: "junk", title: "Junk", year: "n/a" }),
    ];
    for (const direction of ["asc", "desc"] as const) {
      const ids = sortLibraryItems(withBlanks, "release", direction).map((entry) => entry.id);
      expect(ids.slice(0, 2)).toEqual(direction === "asc" ? ["a", "b"] : ["b", "a"]);
      expect(ids.slice(2).sort()).toEqual(["blank", "c", "junk"]);
    }
  });

  it("sorts by name in both directions", () => {
    expect(sortLibraryItems(items, "name", "asc").map((entry) => entry.id)).toEqual(["b", "a", "c"]);
    expect(sortLibraryItems(items, "name", "desc").map((entry) => entry.id)).toEqual(["c", "a", "b"]);
  });

  it("sorts by date added, newest first when descending", () => {
    expect(sortLibraryItems(items, "added", "desc").map((entry) => entry.id)).toEqual(["c", "a", "b"]);
  });

  it("never mutates its input", () => {
    const before = items.map((entry) => entry.id);
    sortLibraryItems(items, "name", "desc");
    expect(items.map((entry) => entry.id)).toEqual(before);
  });
});

describe("library view prefs", () => {
  it("defaults to posters sorted by name ascending on both tabs", () => {
    expect(sanitizeLibraryViewPrefs(undefined)).toEqual(DEFAULT_LIBRARY_VIEW_PREFS);
    expect(DEFAULT_LIBRARY_TAB_PREFS).toEqual({ view: "posters", sortBy: "name", sortDirection: "asc" });
  });

  it("drops invalid values field by field and keeps the valid ones", () => {
    const prefs = sanitizeLibraryViewPrefs({
      movie: { view: "details", sortBy: "bogus", sortDirection: "desc" },
      tv: "garbage",
    });
    expect(prefs.movie).toEqual({ view: "details", sortBy: "name", sortDirection: "desc" });
    expect(prefs.tv).toEqual(DEFAULT_LIBRARY_TAB_PREFS);
  });

  it("patches one tab without touching the other", () => {
    const next = patchLibraryTabPrefs(DEFAULT_LIBRARY_VIEW_PREFS, "tv", { view: "compact", sortBy: "release" });
    expect(next.tv).toEqual({ view: "compact", sortBy: "release", sortDirection: "asc" });
    expect(next.movie).toEqual(DEFAULT_LIBRARY_TAB_PREFS);
    expect(DEFAULT_LIBRARY_VIEW_PREFS.tv).toEqual(DEFAULT_LIBRARY_TAB_PREFS);
  });

  it("ignores an invalid patch value", () => {
    const next = patchLibraryTabPrefs(DEFAULT_LIBRARY_VIEW_PREFS, "movie", { view: "wall" as never });
    expect(next.movie.view).toBe("posters");
  });
});

describe("library filters", () => {
  it("starts empty", () => {
    expect(EMPTY_LIBRARY_FILTERS).toEqual({ query: "", genres: [], actors: [], downloadedOnly: false });
    expect(countActiveLibraryFilters(EMPTY_LIBRARY_FILTERS)).toBe(0);
    expect(hasActiveLibraryFilters(EMPTY_LIBRARY_FILTERS)).toBe(false);
  });

  it("counts genres, actors and downloaded-only, not the search text", () => {
    const filters = { query: "sig", genres: ["movie:28", "movie:12"], actors: ["nora vale"], downloadedOnly: true };
    expect(countActiveLibraryFilters(filters)).toBe(4);
    expect(countActiveLibraryFilters({ ...EMPTY_LIBRARY_FILTERS, query: "sig" })).toBe(0);
    expect(hasActiveLibraryFilters({ ...EMPTY_LIBRARY_FILTERS, query: " sig " })).toBe(true);
  });

  it("toggles a value in and out of a list", () => {
    expect(toggleLibraryFilterValue(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleLibraryFilterValue(["a", "b"], "a")).toEqual(["b"]);
  });
});
