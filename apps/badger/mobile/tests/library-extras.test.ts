/**
 * @test-id MOBILE-LIBRARY-EXTRAS-001
 * @level unit
 * @why The actor filter and the details rows of the media library read cast, season counts and runtimes folded from
 *   three set-based queries; the folding (case-insensitive names, most-frequent actors first, invalid rows dropped)
 *   must be exact.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { EMPTY_LIBRARY_EXTRAS, SEASON_COUNT_SQL, buildLibraryExtras, fetchLibraryExtras } from "../src/lib/libraryExtras";

describe("buildLibraryExtras", () => {
  it("indexes cast by media id case-insensitively and ranks actors by number of titles, then A-Z", () => {
    const extras = buildLibraryExtras(
      [
        { media_id: "a", name: "Amy Adams" },
        { media_id: "b", name: "amy adams" },
        { media_id: "a", name: "Zoe Saldana" },
        { media_id: "b", name: "Zoe Saldana" },
        { media_id: "c", name: "Zoe Saldana" },
        { media_id: "c", name: "Carl Weathers" },
        { media_id: "b", name: "Bob Odenkirk" },
        { media_id: "a", name: "Amy Adams" },
        { media_id: "c", name: "  " },
      ],
      [],
      [],
    );
    expect(extras.castByMediaId.get("a")).toEqual(new Set(["amy adams", "zoe saldana"]));
    expect(extras.castByMediaId.get("b")).toEqual(new Set(["amy adams", "zoe saldana", "bob odenkirk"]));
    expect(extras.castByMediaId.get("c")).toEqual(new Set(["zoe saldana", "carl weathers"]));
    // Zoe (3 titles) > Amy (2) > Bob and Carl (1 each, A-Z): neither alphabetical nor reverse-alphabetical order.
    expect(extras.actorNames).toEqual(["Zoe Saldana", "Amy Adams", "Bob Odenkirk", "Carl Weathers"]);
  });

  it("keeps seasons and runtimes only when they are real positive numbers", () => {
    const extras = buildLibraryExtras(
      [],
      [
        { media_id: "tv1", seasons: 3 },
        { media_id: "tv2", seasons: 0 },
      ],
      [
        { media_id: "m1", duration_seconds: 7500 },
        { media_id: "m2", duration_seconds: 10 },
        { media_id: "m3", duration_seconds: Number.NaN },
      ],
    );
    expect(extras.seasonsByMediaId).toEqual(new Map([["tv1", 3]]));
    expect(extras.runtimeMinutesByMediaId).toEqual(new Map([["m1", 125]]));
  });

  // @bugfix @regression-proof: the list excluded specials (season 0) while the details page counts every season row.
  it("@bugfix @regression-proof counts every season row, specials included, like the details page", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE media_seasons (id TEXT PRIMARY KEY, media_id TEXT NOT NULL, season_number INTEGER NOT NULL);");
      const insert = db.prepare("INSERT INTO media_seasons (id, media_id, season_number) VALUES (?, ?, ?);");
      for (const [mediaId, seasonNumber] of [
        ["tv1", 0],
        ["tv1", 1],
        ["tv1", 2],
        ["tv2", 1],
        ["tv3", 0],
      ] as const) {
        insert.run(`${mediaId}:${seasonNumber}`, mediaId, seasonNumber);
      }
      const rows = db.prepare(SEASON_COUNT_SQL).all() as { media_id: string; seasons: number }[];
      const extras = buildLibraryExtras([], rows, []);
      expect(extras.seasonsByMediaId).toEqual(
        new Map([
          ["tv1", 3],
          ["tv2", 1],
          ["tv3", 1],
        ]),
      );
    } finally {
      db.close();
    }
  });
});

describe("fetchLibraryExtras", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("hands the loaded extras to the screen", async () => {
    const onLoaded = vi.fn();
    fetchLibraryExtras(async () => EMPTY_LIBRARY_EXTRAS, onLoaded, vi.fn());
    await settle();
    expect(onLoaded).toHaveBeenCalledWith(EMPTY_LIBRARY_EXTRAS);
  });

  // @bugfix @regression-proof: a rejected extras read was an unhandled promise rejection.
  it("@bugfix @regression-proof reports a failed read through onError instead of leaving it unhandled", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const onError = vi.fn();
      const onLoaded = vi.fn();
      const failure = new Error("metadata db closed");
      fetchLibraryExtras(() => Promise.reject(failure), onLoaded, onError);
      await settle();
      expect(onError).toHaveBeenCalledWith(failure);
      expect(onLoaded).not.toHaveBeenCalled();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("drops the result of a read that was cancelled (a newer read superseded it)", async () => {
    const onLoaded = vi.fn();
    const onError = vi.fn();
    const cancelLoaded = fetchLibraryExtras(async () => EMPTY_LIBRARY_EXTRAS, onLoaded, onError);
    const cancelFailed = fetchLibraryExtras(() => Promise.reject(new Error("late")), onLoaded, onError);
    cancelLoaded();
    cancelFailed();
    await settle();
    expect(onLoaded).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
