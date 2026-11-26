/**
 * LIB-SHOW-01 background refresh (Chris 2026-10-29): a show still airing gets
 * its episode list fetched again once a day, and on the day its next episode
 * airs, one show at a time, standing down while an import runs. Ended and
 * cancelled shows are left alone. The check always runs on the desktop: the
 * own-key mode that used to skip it was removed (META-DIRECT-03).
 * LIB-SHOW-02: an episode the catalog stopped listing is offered to the user only
 * after two checks a day apart, and never again once kept.
 * LIB-SHOW-04: one the user has a file for gets a move suggested instead,
 * after the same proof; "No" is remembered like "Keep".
 *
 * Drives `runShowRefreshPass` against a fake the catalog, a fake library merge and an
 * in-memory refresh-state store.
 */
// @req LIB-SHOW-01[badger-desktop]
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { TitleDetails } from "../src/renderer/src/api";
import type { MediaRow, ShowEpisodeNotListed, ShowEpisodeRefreshResult } from "@space/shared/libraryTypes";
import { MetadataRequestError } from "@space/metadata-client";
import {
  SHOW_DELISTING_CONFIRM_MS,
  SHOW_REFRESH_FAILURE_RETRY_MS,
  SHOW_REFRESH_MAX_AGE_MS,
  SHOW_REFRESH_REQUEST_GAP_MS,
  episodeMoveChoices,
  parseShowRefreshState,
  pendingShowDelistings,
  resolveShowDelisting,
  runShowRefreshPass,
  showRefreshDueReason,
  type ShowRefreshDeps,
  type ShowRefreshState,
} from "../src/renderer/src/lib/showRefresh";

const DESKTOP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const P = "[show-refresh.test]";
const NOW = Date.parse("2026-10-29T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

const row = (id: string, catalogId: number | null, type: MediaRow["type"] = "tv"): MediaRow => ({
  id,
  type,
  catalogId,
  title: id,
  originalTitle: id,
  originalLanguage: "en",
  overview: null,
  year: "2024",
  rating: null,
  posterPath: null,
  backdropPath: null,
  genres: [],
  addedAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  hasFiles: true,
  progressPct: 0,
  lastWatchedAt: null,
  totalEpisodes: 10,
  episodeCount: 10,
});

const details = (catalogId: number, status: string | null, nextEpisodeAirDate: string | null): TitleDetails => ({
  type: "tv",
  id: catalogId,
  title: `show ${catalogId}`,
  originalTitle: null,
  originalLanguage: "en",
  overview: null,
  year: "2024",
  posterPath: null,
  backdropPath: null,
  cast: [],
  trailers: [],
  totalEpisodes: 11,
  seasons: [],
  episodes: [],
  genres: [],
  status,
  nextEpisodeAirDate,
});

const changed = (addedEpisodes: number): ShowEpisodeRefreshResult => ({
  changed: addedEpisodes > 0,
  addedSeasons: 0,
  updatedSeasons: 0,
  addedEpisodes,
  updatedEpisodes: 0,
  notListed: [],
});

type Harness = {
  deps: ShowRefreshDeps;
  fetched: number[];
  merged: string[];
  sleeps: number[];
  state: { current: ShowRefreshState };
  events: string[];
};

const harness = (opts: {
  state?: ShowRefreshState;
  catalog?: Record<number, TitleDetails | Error>;
  busyAfter?: number;
  added?: number;
  notListed?: Record<string, ShowEpisodeNotListed[]>;
  onFetch?: (catalogId: number, h: Harness) => void;
}): Harness => {
  const h: Harness = {
    deps: undefined as unknown as ShowRefreshDeps,
    fetched: [],
    merged: [],
    sleeps: [],
    state: { current: structuredClone(opts.state ?? {}) },
    events: [],
  };
  let inFlight = 0;
  let busyChecks = 0;
  h.deps = {
    fetchDetails: async (catalogId) => {
      inFlight += 1;
      h.events.push(`fetch:${catalogId}:inFlight=${inFlight}`);
      h.fetched.push(catalogId);
      await Promise.resolve();
      inFlight -= 1;
      // Stands in for the dialog saving an answer to the same store while this show is being fetched.
      opts.onFetch?.(catalogId, h);
      const answer = opts.catalog?.[catalogId] ?? details(catalogId, "Returning Series", null);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    refreshShowEpisodes: async (mediaId) => {
      h.merged.push(mediaId);
      return { ...changed(opts.added ?? 1), notListed: opts.notListed?.[mediaId] ?? [] };
    },
    isLibraryBusy: async () => {
      busyChecks += 1;
      return opts.busyAfter !== undefined && busyChecks > opts.busyAfter;
    },
    loadState: () => structuredClone(h.state.current),
    saveState: (next) => {
      h.state.current = structuredClone(next);
    },
    sleep: async (ms) => {
      h.sleeps.push(ms);
    },
    log: (message, detailsObj) => {
      console.info(P, message, JSON.stringify(detailsObj));
      h.events.push(message);
    },
    now: () => NOW,
  };
  return h;
};

const iso = (ms: number) => new Date(ms).toISOString();

describe("LIB-SHOW-01 background show refresh", () => {
  it("refreshes every never-seen show with a catalog id, one at a time, and records status + next air date", async () => {
    const h = harness({
      catalog: { 11: details(11, "Returning Series", "2026-11-05"), 12: details(12, "Ended", null) },
    });
    const media = [row("a", 11), row("b", 12), row("movie", 13, "movie"), row("untagged", null)];
    const summary = await runShowRefreshPass(media, h.deps);
    console.info(P, "summary", JSON.stringify(summary), "state", JSON.stringify(h.state.current));

    expect(h.fetched).toEqual([11, 12]);
    expect(h.merged).toEqual(["a", "b"]);
    expect(h.events.filter((e) => e.startsWith("fetch:")).every((e) => e.endsWith("inFlight=1"))).toBe(true);
    expect(h.sleeps).toEqual([SHOW_REFRESH_REQUEST_GAP_MS]);
    expect(summary).toMatchObject({ candidates: 2, due: 2, refreshed: 2, changed: 2, addedEpisodes: 2, stoppedBecause: "done" });
    expect(h.state.current.a).toEqual({ refreshedAt: iso(NOW), status: "Returning Series", nextEpisodeAirDate: "2026-11-05" });
    expect(h.state.current.b).toEqual({ refreshedAt: iso(NOW), status: "Ended", nextEpisodeAirDate: null });
  });

  it("leaves ended and cancelled shows alone, even a year later", async () => {
    const yearAgo = iso(NOW - 365 * DAY);
    const h = harness({
      state: {
        ended: { refreshedAt: yearAgo, status: "Ended", nextEpisodeAirDate: null },
        canceled: { refreshedAt: yearAgo, status: "Canceled", nextEpisodeAirDate: null },
      },
    });
    const summary = await runShowRefreshPass([row("ended", 21), row("canceled", 22)], h.deps);
    console.info(P, "summary", JSON.stringify(summary));
    expect(h.fetched).toEqual([]);
    expect(summary).toMatchObject({ candidates: 2, due: 0, refreshed: 0 });
  });

  it("@bugfix @regression-proof checks a running show once a day, and on the day its next episode airs", async () => {
    expect(SHOW_REFRESH_MAX_AGE_MS).toBe(DAY);
    const h = harness({
      state: {
        fresh: { refreshedAt: iso(NOW - 2 * 60 * 60 * 1000), status: "Returning Series", nextEpisodeAirDate: "2026-11-05" },
        airDay: { refreshedAt: "2026-10-28T20:00:00.000Z", status: "Returning Series", nextEpisodeAirDate: "2026-10-29" },
        checkedOnAirDay: { refreshedAt: "2026-10-29T01:00:00.000Z", status: "Returning Series", nextEpisodeAirDate: "2026-10-29" },
        almostADay: { refreshedAt: iso(NOW - DAY + 60 * 60 * 1000), status: "Returning Series", nextEpisodeAirDate: null },
        aDay: { refreshedAt: iso(NOW - DAY), status: "Returning Series", nextEpisodeAirDate: null },
      },
    });
    await runShowRefreshPass(
      [row("fresh", 31), row("airDay", 32), row("checkedOnAirDay", 33), row("almostADay", 34), row("aDay", 35)],
      h.deps
    );
    console.info(P, "daily cadence fetched", JSON.stringify(h.fetched));
    expect(h.fetched).toEqual([32, 35]);
    expect(showRefreshDueReason(h.state.current.airDay, NOW), "checked on its air day: done for the day").toBeNull();
    expect(showRefreshDueReason({ refreshedAt: "2026-10-27T12:00:00.000Z", status: null, nextEpisodeAirDate: "2026-10-28" }, NOW)).toBe(
      "stale"
    );
    expect(showRefreshDueReason({ refreshedAt: "2026-10-28T23:00:00.000Z", status: null, nextEpisodeAirDate: "2026-10-29" }, NOW)).toBe(
      "air-day"
    );
    expect(showRefreshDueReason({ refreshedAt: "garbage", status: null, nextEpisodeAirDate: null }, NOW)).toBe("stale");
  });

  it("stands down while an import runs and picks the rest up on the next pass", async () => {
    const h = harness({ busyAfter: 1 });
    const first = await runShowRefreshPass([row("a", 41), row("b", 42), row("c", 43)], h.deps);
    console.info(P, "first", JSON.stringify(first));
    expect(first.stoppedBecause).toBe("busy");
    expect(h.fetched).toEqual([41]);

    const next = harness({ state: h.state.current });
    await runShowRefreshPass([row("a", 41), row("b", 42), row("c", 43)], next.deps);
    expect(next.fetched).toEqual([42, 43]);
  });

  it("@bugfix @regression-proof isolates a failing show, stops after three network failures in a row, and forgets removed shows", async () => {
    const boom = new Error("CATALOG_503");
    const h = harness({
      state: { gone: { refreshedAt: iso(NOW - 30 * DAY), status: "Returning Series", nextEpisodeAirDate: null } },
      catalog: { 51: boom, 53: boom, 54: boom, 55: boom },
    });
    const summary = await runShowRefreshPass([row("a", 51), row("b", 52), row("c", 53), row("d", 54), row("e", 55), row("f", 56)], h.deps);
    console.info(P, "summary", JSON.stringify(summary), "state", JSON.stringify(h.state.current));
    expect(h.fetched).toEqual([51, 52, 53, 54, 55]);
    expect(h.merged).toEqual(["b"]);
    expect(summary).toMatchObject({ refreshed: 1, failed: 4, stoppedBecause: "failures" });
    expect(Object.keys(h.state.current).sort()).toEqual(["a", "b", "c", "d", "e"]);
    expect(h.state.current.a).toEqual({ refreshedAt: "", status: null, nextEpisodeAirDate: null, lastFailedAt: iso(NOW) });
  });

  it("@bugfix @regression-proof does not let shows the catalog has no page for stop the pass", async () => {
    const h = harness({
      catalog: {
        61: new Error("CATALOG_404"),
        62: new MetadataRequestError(404),
        63: new MetadataRequestError(404),
      },
    });
    const summary = await runShowRefreshPass([row("a", 61), row("b", 62), row("c", 63), row("d", 64)], h.deps);
    console.info(P, "summary", JSON.stringify(summary), "state", JSON.stringify(h.state.current));
    expect(h.merged, "the 4th show still refreshes").toEqual(["d"]);
    expect(summary).toMatchObject({ refreshed: 1, failed: 3, stoppedBecause: "done" });
  });

  it("@bugfix @regression-proof waits a day before retrying a failed show, and tries it after the others", async () => {
    const h = harness({ catalog: { 71: new Error("Failed to fetch") } });
    await runShowRefreshPass([row("a", 71)], h.deps);
    const failedState = h.state.current;
    console.info(P, "state after failure", JSON.stringify(failedState));
    expect(failedState.a?.lastFailedAt).toBe(iso(NOW));
    expect(showRefreshDueReason(failedState.a, NOW + DAY - 1), "within a day").toBeNull();
    expect(showRefreshDueReason(failedState.a, NOW + SHOW_REFRESH_FAILURE_RETRY_MS)).toBe("never");

    const sameDay = harness({ state: failedState });
    await runShowRefreshPass([row("a", 71), row("b", 72)], sameDay.deps);
    expect(sameDay.fetched).toEqual([72]);

    const nextDay = harness({ state: sameDay.state.current });
    nextDay.deps.now = () => NOW + DAY;
    const summary = await runShowRefreshPass([row("a", 71), row("b", 72), row("c", 73)], nextDay.deps);
    console.info(P, "next day", JSON.stringify(summary), JSON.stringify(nextDay.state.current));
    // b was checked a day ago, so it is due again too (daily cadence); the failed show still comes last.
    expect(nextDay.fetched, "never-seen and due first, the failed show last").toEqual([72, 73, 71]);
    expect(nextDay.state.current.a).toEqual({
      refreshedAt: iso(NOW + DAY),
      status: "Returning Series",
      nextEpisodeAirDate: null,
    });
  });

  it("keeps a failed show's last good refresh when it fails again", async () => {
    const stored = { refreshedAt: iso(NOW - 8 * DAY), status: "Returning Series", nextEpisodeAirDate: "2026-10-20" };
    const h = harness({ state: { a: stored }, catalog: { 81: new Error("CATALOG_500") } });
    await runShowRefreshPass([row("a", 81)], h.deps);
    expect(h.state.current.a).toEqual({ ...stored, lastFailedAt: iso(NOW) });
    expect(parseShowRefreshState(JSON.stringify(h.state.current)).a).toEqual({ ...stored, lastFailedAt: iso(NOW) });
  });

  it("@req LIB-SHOW-01[badger-desktop] always runs the daily check on the desktop: no own-key mode skips it", async () => {
    // A user who had the removed own-key mode on gets the same check as everyone else (META-DIRECT-03).
    const h = harness({});
    const summary = await runShowRefreshPass([row("a", 91), row("b", 92)], h.deps);
    console.info(P, "always-runs summary", JSON.stringify(summary), "fetched", JSON.stringify(h.fetched));
    expect(h.fetched).toEqual([91, 92]);
    expect(summary).toMatchObject({ candidates: 2, due: 2, refreshed: 2, stoppedBecause: "done" });

    // The wiring has no skip either: neither the pass nor the component reads a catalog-access mode.
    const sources = ["src/renderer/src/lib/showRefresh.ts", "src/renderer/src/components/ShowRefresh.tsx"].map((file) => ({
      file,
      text: readFileSync(join(DESKTOP_ROOT, file), "utf8"),
    }));
    const offenders = sources.filter(({ text }) => /usesOwn\w*Key|metadataAccess|own-key/.test(text)).map(({ file }) => file);
    console.info(P, "skip-path scan", JSON.stringify({ scanned: sources.map(({ file }) => file), offenders }));
    expect(offenders).toEqual([]);
  });

  it("reads a damaged stored state as empty", () => {
    expect(parseShowRefreshState(null)).toEqual({});
    expect(parseShowRefreshState("{not json")).toEqual({});
    expect(parseShowRefreshState("[]")).toEqual({});
    expect(parseShowRefreshState(JSON.stringify({ a: { refreshedAt: "x", status: 3 }, b: "nope" }))).toEqual({
      a: { refreshedAt: "x", status: null, nextEpisodeAirDate: null },
    });
  });
});

describe("LIB-SHOW-02 episodes the catalog no longer lists are offered to the user, never removed silently", () => {
  const e8: ShowEpisodeNotListed = { id: "ep-3-8", seasonNumber: 3, episodeNumber: 8, title: "The Lost One" };
  const passAt = async (state: ShowRefreshState, atMs: number, notListed: ShowEpisodeNotListed[]) => {
    const h = harness({ state, notListed: { a: notListed } });
    h.deps.now = () => atMs;
    await runShowRefreshPass([row("a", 101)], h.deps);
    console.info(P, "delisting state", iso(atMs), JSON.stringify(h.state.current.a));
    return h.state.current;
  };

  it("@req LIB-SHOW-02[badger-desktop] offers an episode only after a second check at least a day later still misses it", async () => {
    const first = await passAt({}, NOW, [e8]);
    expect(first.a?.notListed?.[e8.id]).toMatchObject({ firstSeenAt: iso(NOW), lastSeenAt: iso(NOW) });
    expect(pendingShowDelistings(first), "one sighting is not enough").toEqual([]);

    const second = await passAt(first, NOW + SHOW_DELISTING_CONFIRM_MS, [e8]);
    expect(pendingShowDelistings(second)).toEqual([{ mediaId: "a", episodes: [e8], moves: [] }]);
    expect(SHOW_DELISTING_CONFIRM_MS).toBe(DAY);
  });

  it("@req LIB-SHOW-02[badger-desktop] drops the offer once the catalog lists the episode again", async () => {
    const first = await passAt({}, NOW, [e8]);
    const back = await passAt(first, NOW + DAY, []);
    expect(back.a?.notListed).toBeUndefined();
    const again = await passAt(back, NOW + 2 * DAY, [e8]);
    expect(again.a?.notListed?.[e8.id]?.firstSeenAt, "a new sighting starts over").toBe(iso(NOW + 2 * DAY));
    expect(pendingShowDelistings(again)).toEqual([]);
  });

  it("@req LIB-SHOW-02[badger-desktop] never offers an episode the user chose to keep, and forgets one they removed", async () => {
    const confirmed = await passAt(await passAt({}, NOW, [e8]), NOW + DAY, [e8]);
    const kept = resolveShowDelisting(confirmed, "a", [e8.id], "kept");
    expect(pendingShowDelistings(kept)).toEqual([]);
    const later = await passAt(kept, NOW + 2 * DAY, [e8]);
    expect(pendingShowDelistings(later), "kept stays kept").toEqual([]);
    expect(parseShowRefreshState(JSON.stringify(later)).a?.declined).toEqual([e8.id]);

    const removed = resolveShowDelisting(confirmed, "a", [e8.id], "removed");
    expect(removed.a?.notListed).toBeUndefined();
    expect(pendingShowDelistings(removed)).toEqual([]);
  });

  it("@req LIB-SHOW-02[badger-desktop] keeps the sightings when a check fails", async () => {
    const first = await passAt({}, NOW, [e8]);
    const h = harness({ state: first, catalog: { 101: new Error("CATALOG_503") } });
    h.deps.now = () => NOW + DAY;
    await runShowRefreshPass([row("a", 101)], h.deps);
    expect(h.state.current.a?.notListed).toEqual(first.a?.notListed);
    expect(pendingShowDelistings(h.state.current), "a failed check is not a second sighting").toEqual([]);
  });
});

describe("LIB-SHOW-02 a dialog answer saved during a pass survives it", () => {
  const e8: ShowEpisodeNotListed = { id: "ep-a-8", seasonNumber: 1, episodeNumber: 8, title: "Gone" };
  const e9: ShowEpisodeNotListed = { id: "ep-c-9", seasonNumber: 2, episodeNumber: 9, title: "Also gone" };
  const sighted = (episode: ShowEpisodeNotListed) => ({
    [episode.id]: {
      seasonNumber: episode.seasonNumber,
      episodeNumber: episode.episodeNumber,
      title: episode.title,
      firstSeenAt: iso(NOW - 3 * DAY),
      lastSeenAt: iso(NOW - 2 * DAY),
    },
  });

  it("@req LIB-SHOW-02[badger-desktop] @bugfix @regression-proof keeps a Keep or Remove answered mid-pass, and the dialog does not reopen", async () => {
    const stale = { refreshedAt: iso(NOW - 2 * DAY), status: "Returning Series", nextEpisodeAirDate: null };
    const start: ShowRefreshState = {
      a: { ...stale, notListed: sighted(e8) },
      b: { ...stale },
      c: { ...stale, notListed: sighted(e9) },
    };
    expect(pendingShowDelistings(start).map((d) => d.mediaId), "both offers are open before the pass").toEqual(["a", "c"]);
    const h = harness({
      state: start,
      catalog: { 103: new Error("CATALOG_503") },
      notListed: { a: [e8] },
      onFetch: (catalogId, current) => {
        // The user answers the open dialogs while the pass is busy with these shows.
        if (catalogId === 101) current.state.current = resolveShowDelisting(current.state.current, "a", [e8.id], "kept");
        if (catalogId === 102) current.state.current = resolveShowDelisting(current.state.current, "c", [e9.id], "removed");
        console.info(P, "answer saved mid-pass", catalogId, JSON.stringify(current.state.current));
      },
    });
    await runShowRefreshPass([row("a", 101), row("b", 102), row("c", 103)], h.deps);
    console.info(P, "state after pass", JSON.stringify(h.state.current));
    expect(h.state.current.a?.declined, "Keep answered while show a was fetched").toEqual([e8.id]);
    expect(h.state.current.a?.refreshedAt).toBe(iso(NOW));
    expect(h.state.current.c?.notListed, "Remove answered before show c failed").toBeUndefined();
    expect(h.state.current.c?.lastFailedAt).toBe(iso(NOW));
    // ShowRefresh re-reads the offers from the store when the pass ends: nothing to reopen.
    expect(pendingShowDelistings(h.deps.loadState())).toEqual([]);
  });
});

describe("LIB-SHOW-04 a delisted episode with a file gets a move suggested, never a removal", () => {
  const target = { id: "ep-0-3", seasonNumber: 0, episodeNumber: 3, title: "Christmas Party" };
  const party: ShowEpisodeNotListed = {
    id: "ep-2-10",
    seasonNumber: 2,
    episodeNumber: 10,
    title: "Christmas Party",
    move: { kind: "move", target },
  };
  const fileless: ShowEpisodeNotListed = { id: "ep-2-11", seasonNumber: 2, episodeNumber: 11, title: "Gone" };
  const passAt = async (state: ShowRefreshState, atMs: number, notListed: ShowEpisodeNotListed[]) => {
    const h = harness({ state, notListed: { a: notListed } });
    h.deps.now = () => atMs;
    await runShowRefreshPass([row("a", 101)], h.deps);
    console.info(P, "[LIB-SHOW-04] state", iso(atMs), JSON.stringify(h.state.current.a));
    return h.state.current;
  };

  it("@req LIB-SHOW-04[badger-desktop] suggests the move after the same two-check proof, apart from the removal offer", async () => {
    const first = await passAt({}, NOW, [party, fileless]);
    expect(pendingShowDelistings(first), "one sighting is not enough").toEqual([]);
    const second = await passAt(first, NOW + DAY, [party, fileless]);
    const offers = pendingShowDelistings(second);
    console.info(P, "[LIB-SHOW-04] offers", JSON.stringify(offers));
    expect(offers).toEqual([{ mediaId: "a", episodes: [fileless], moves: [party] }]);
    expect(offers[0]!.episodes.map((episode) => episode.id), "an episode with a file is never offered for removal").not.toContain(party.id);
    // The stored suggestion survives a reload of the store.
    expect(parseShowRefreshState(JSON.stringify(second)).a?.notListed?.[party.id]?.move).toEqual(party.move);
  });

  it("@req LIB-SHOW-04[badger-desktop] remembers No like Keep, and forgets an episode once it moved", async () => {
    const confirmed = await passAt(await passAt({}, NOW, [party]), NOW + DAY, [party]);
    const declined = resolveShowDelisting(confirmed, "a", [party.id], "kept");
    const later = await passAt(declined, NOW + 2 * DAY, [party]);
    console.info(P, "[LIB-SHOW-04] after No", JSON.stringify(later.a));
    expect(pendingShowDelistings(later), "No stays No while it stays missing").toEqual([]);

    const moved = resolveShowDelisting(confirmed, "a", [party.id], "moved");
    expect(moved.a?.notListed).toBeUndefined();
    expect(pendingShowDelistings(moved)).toEqual([]);
  });

  it("@req LIB-SHOW-04[badger-desktop] reads a damaged stored suggestion as keep-or-pick-by-hand, never as a move", () => {
    const sighting = { seasonNumber: 2, episodeNumber: 10, title: "X", firstSeenAt: iso(NOW - DAY), lastSeenAt: iso(NOW) };
    const state = parseShowRefreshState(
      JSON.stringify({
        a: {
          refreshedAt: iso(NOW),
          status: null,
          nextEpisodeAirDate: null,
          notListed: {
            e1: { ...sighting, move: { kind: "move", target: { id: 5 } } },
            e2: { ...sighting, episodeNumber: 11, move: { kind: "merged", into: target, partIds: ["e2"] } },
            e3: { ...sighting, episodeNumber: 12 },
          },
        },
      })
    );
    console.info(P, "[LIB-SHOW-04] parsed", JSON.stringify(state.a?.notListed));
    expect(state.a?.notListed?.e1?.move).toEqual({ kind: "none" });
    expect(state.a?.notListed?.e2?.move).toEqual({ kind: "none" });
    expect(state.a?.notListed?.e3?.move, "a file-less sighting stays a removal offer").toBeUndefined();
  });

  it("@req LIB-SHOW-04[badger-desktop] lets the user pick by hand only episodes the catalog lists that have no file", () => {
    const details = {
      episodes: [
        { id: "s2e10", seasonNumber: 2, episodeNumber: 10, name: "Christmas Party", overview: null, stillPath: null, airDate: null },
        { id: "s2e9", seasonNumber: 2, episodeNumber: 9, name: "E-Mail Surveillance", overview: null, stillPath: null, airDate: null },
        { id: "s0e3", seasonNumber: 0, episodeNumber: 3, name: "Christmas Party", overview: null, stillPath: null, airDate: null },
        { id: "s2e11", seasonNumber: 2, episodeNumber: 11, name: "Gone", overview: null, stillPath: null, airDate: null },
      ],
      files: [
        { id: "f1", filename: "office.s02e10.mkv", season: 2, episode: 10, desiredFormats: [] },
        { id: "f2", filename: "office.s02e09.mkv", season: 2, episode: 9, desiredFormats: [] },
      ],
    };
    const choices = episodeMoveChoices(details, new Set(["s2e10", "s2e11"]));
    console.info(P, "[LIB-SHOW-04] choices", JSON.stringify(choices));
    expect(choices).toEqual([{ id: "s0e3", seasonNumber: 0, episodeNumber: 3, title: "Christmas Party" }]);
  });
});
