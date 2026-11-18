/**
 * @test-id MOBILE-LIBRARY-VIEW-001
 * @level unit
 * @why The media library remembers its view (posters / compact / details) and sort per Movies / TV tab on this device,
 *   across an app restart, while search and filters never outlive the screen. Sort, filters and the downloaded-only
 *   switch decide which titles the user sees, so each is checked on real rows.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaRow } from "@space/shared/libraryTypes";
import { EMPTY_LIBRARY_FILTERS, type LibraryFilters } from "@space/shared/libraryView";
import { createFakeAsyncStorage } from "./harness";

const fakeStorage = createFakeAsyncStorage();

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: (key: string) => fakeStorage.getItem(key),
    setItem: (key: string, value: string) => fakeStorage.setItem(key, value),
    removeItem: (key: string) => fakeStorage.removeItem(key),
  },
}));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const loadModules = async () => {
  const settings = await import("../src/lib/appSettings");
  settings.__resetAppSettingsForTests();
  const state = await import("../src/lib/libraryScreenState");
  return { settings, state };
};

const row = (patch: Partial<MediaRow> & { id: string }): MediaRow =>
  ({
    type: "movie",
    title: patch.id,
    year: null,
    addedAt: "2026-01-01T00:00:00.000Z",
    genres: [],
    progressPct: 0,
    ...patch,
  }) as MediaRow;

const MEDIA: MediaRow[] = [
  // Name order (m1, m2, m3), release order (m3, m1, m2) and date-added order (m2, m3, m1) are three different orders,
  // and none is the reverse of another, so a sort that ignored its key or its direction cannot pass by luck.
  row({ id: "m1", title: "Arrival", year: "1982", genres: [878, 18], addedAt: "2026-01-15T00:00:00.000Z" }),
  row({ id: "m2", title: "Blade Runner", year: "2016", genres: [878], addedAt: "2026-03-01T00:00:00.000Z" }),
  row({ id: "m3", title: "Casablanca", year: "1942", genres: [18, 10749], addedAt: "2026-02-01T00:00:00.000Z" }),
  row({ id: "t1", type: "tv", title: "Severance", year: "2022", genres: [18, 9648], addedAt: "2026-02-10T00:00:00.000Z" }),
];

beforeEach(() => {
  fakeStorage._backing.clear();
});

describe("library view prefs persistence", () => {
  it("defaults to posters sorted by name ascending on both tabs", async () => {
    const { settings } = await loadModules();
    await settings.loadAppSettings();
    for (const tab of ["movie", "tv"] as const) {
      expect(settings.getAppSettings().libraryView[tab]).toEqual({ view: "posters", sortBy: "name", sortDirection: "asc" });
    }
  });

  it("stores view and sort per tab and restores them after a restart", async () => {
    const first = await loadModules();
    await first.settings.loadAppSettings();
    first.state.updateLibraryTabPrefs("movie", { view: "details", sortBy: "release", sortDirection: "desc" });
    first.state.updateLibraryTabPrefs("tv", { view: "compact" });
    await flush();

    const second = await loadModules();
    const loaded = await second.settings.loadAppSettings();
    expect(loaded.libraryView.movie).toEqual({ view: "details", sortBy: "release", sortDirection: "desc" });
    expect(loaded.libraryView.tv).toEqual({ view: "compact", sortBy: "name", sortDirection: "asc" });
  });

  it("changing one tab leaves the other untouched", async () => {
    const { settings, state } = await loadModules();
    await settings.loadAppSettings();
    state.updateLibraryTabPrefs("tv", { sortBy: "added", sortDirection: "desc" });
    expect(settings.getAppSettings().libraryView.movie).toEqual({ view: "posters", sortBy: "name", sortDirection: "asc" });
    expect(settings.getAppSettings().libraryView.tv).toEqual({ view: "posters", sortBy: "added", sortDirection: "desc" });
  });

  it("falls back to defaults for corrupt stored view prefs without touching other settings", async () => {
    fakeStorage._backing.set(
      "sf:app-settings:v1",
      JSON.stringify({ downloadsWifiOnly: false, libraryView: { movie: { view: "mosaic", sortBy: 3 }, tv: null } }),
    );
    const { settings } = await loadModules();
    const loaded = await settings.loadAppSettings();
    expect(loaded.downloadsWifiOnly).toBe(false);
    expect(loaded.libraryView.movie).toEqual({ view: "posters", sortBy: "name", sortDirection: "asc" });
    expect(loaded.libraryView.tv).toEqual({ view: "posters", sortBy: "name", sortDirection: "asc" });
  });
});

describe("library filters reducer", () => {
  it("builds up search, genres, actors and downloaded-only, then resets to empty", async () => {
    const { state } = await loadModules();
    let filters: LibraryFilters = EMPTY_LIBRARY_FILTERS;
    filters = state.libraryFiltersReducer(filters, { type: "query", query: "arr" });
    filters = state.libraryFiltersReducer(filters, { type: "toggleGenre", key: "movie:878" });
    filters = state.libraryFiltersReducer(filters, { type: "toggleActor", name: "Amy Adams" });
    filters = state.libraryFiltersReducer(filters, { type: "downloadedOnly", value: true });
    expect(filters).toEqual({ query: "arr", genres: ["movie:878"], actors: ["amy adams"], downloadedOnly: true });

    expect(state.libraryFiltersReducer(filters, { type: "reset" })).toEqual(EMPTY_LIBRARY_FILTERS);
  });

  it("toggling a genre or actor twice removes it", async () => {
    const { state } = await loadModules();
    let filters = state.libraryFiltersReducer(EMPTY_LIBRARY_FILTERS, { type: "toggleGenre", key: "movie:18" });
    filters = state.libraryFiltersReducer(filters, { type: "toggleGenre", key: "movie:18" });
    expect(filters.genres).toEqual([]);
  });

  it("switching Movies <-> TV drops genres and actors but keeps search and downloaded-only", async () => {
    const { state } = await loadModules();
    const before: LibraryFilters = { query: "sev", genres: ["movie:18"], actors: ["amy adams"], downloadedOnly: true };
    expect(state.libraryFiltersReducer(before, { type: "switchTab", from: "movies", to: "tv" })).toEqual({
      query: "sev",
      genres: [],
      actors: [],
      downloadedOnly: true,
    });
  });

  // @bugfix @regression-proof: re-tapping the tab you are already on used to wipe the genre and actor filters.
  it("@bugfix @regression-proof re-selecting the active tab keeps every filter", async () => {
    const { state } = await loadModules();
    const before: LibraryFilters = { query: "sev", genres: ["movie:18"], actors: ["amy adams"], downloadedOnly: true };
    for (const scope of ["movies", "tv"] as const) {
      expect(state.libraryFiltersReducer(before, { type: "switchTab", from: scope, to: scope })).toBe(before);
    }
  });
});

describe("selectLibraryItems", () => {
  const base = async () => {
    const { state } = await loadModules();
    return {
      select: (patch: Partial<Parameters<typeof state.selectLibraryItems>[0]>) =>
        state
          .selectLibraryItems({
            media: MEDIA,
            tab: "movie",
            filters: EMPTY_LIBRARY_FILTERS,
            prefs: { view: "posters", sortBy: "name", sortDirection: "asc" },
            castLookup: new Map(),
            downloadedMediaIds: new Set(),
            ...patch,
          })
          .map((item) => item.id),
      state,
    };
  };

  it("keeps only the active tab and sorts by name by default", async () => {
    const { select } = await base();
    expect(select({})).toEqual(["m1", "m2", "m3"]);
    expect(select({ tab: "tv" })).toEqual(["t1"]);
  });

  it("sorts by release year descending and by date added", async () => {
    const { select } = await base();
    expect(select({ prefs: { view: "posters", sortBy: "release", sortDirection: "desc" } })).toEqual(["m2", "m1", "m3"]);
    expect(select({ prefs: { view: "posters", sortBy: "release", sortDirection: "asc" } })).toEqual(["m3", "m1", "m2"]);
    expect(select({ prefs: { view: "posters", sortBy: "added", sortDirection: "desc" } })).toEqual(["m2", "m3", "m1"]);
    expect(select({ prefs: { view: "posters", sortBy: "added", sortDirection: "asc" } })).toEqual(["m1", "m3", "m2"]);
  });

  it("filters by search text, genre and actor together", async () => {
    const { select } = await base();
    expect(select({ filters: { ...EMPTY_LIBRARY_FILTERS, query: " BLADE " } })).toEqual(["m2"]);
    expect(select({ filters: { ...EMPTY_LIBRARY_FILTERS, genres: ["movie:18"] } })).toEqual(["m1", "m3"]);
    expect(
      select({
        filters: { ...EMPTY_LIBRARY_FILTERS, genres: ["movie:18"], actors: ["amy adams"] },
        castLookup: new Map([["m1", new Set(["amy adams"])]]),
      }),
    ).toEqual(["m1"]);
  });

  it("downloaded-only keeps just the titles saved on this device", async () => {
    const { select } = await base();
    expect(select({ filters: { ...EMPTY_LIBRARY_FILTERS, downloadedOnly: true }, downloadedMediaIds: new Set(["m3"]) })).toEqual(["m3"]);
  });

  it("lists only genres present in the tab, in TMDB order", async () => {
    const { state } = await base();
    expect(state.availableGenreIds(MEDIA, "movie")).toEqual([18, 10749, 878]);
    expect(state.availableGenreIds(MEDIA, "tv")).toEqual([18, 9648]);
  });
});
