/**
 * @test-id LIB-SHOW-REFRESH-001
 * @level integration (real LibraryDb over bun:sqlite, no server)
 * @bugfix @regression-proof
 *
 * Why this exists: `addMediaFromCatalog` on a show already in the library deleted every `media_episodes` row and
 * re-inserted the the catalog list with fresh random ids. Everything keyed by the episode id then pointed at nothing:
 * per-episode resume progress (`episode_resume_v1:<episodeId>`), skip markers, subtitle / audio rows of the
 * episode, and the same ids on the TV / phone / Kodi (the `media.upsert` op carries the desktop's ids). An
 * episode the user had a file for but the catalog did not list (a special, a renumbered episode) vanished entirely.
 *
 * The show refresh (LIB-SHOW-01) re-reads the catalog for running shows and must merge: keep the id of every episode
 * already stored (matched by season + episode number), add the new ones, update air dates and the episode
 * total. Until Chris settles LIB-SHOW-02 no merge deletes a stored episode or season: the catalog answers drop an
 * episode or a season whose name is empty in the requested language (`metadata.ts`, metadata_api), so
 * "not listed" is not proof it is gone, and a deleted row would come back later with a new id.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { LibraryDb } from "../src/libraryDb";

const TAG = "[show-episode-refresh]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

type Internals = {
  pendingOps: Array<{ type: string; payload: { details?: { id: string; episodes: Array<{ id: string; seasonNumber: number; episodeNumber: number }> } } }>;
};

let root = "";
let originalFetch: typeof globalThis.fetch | null = null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-show-episode-refresh-"));
  process.env.SF_USER_DATA_PATH = root;
  originalFetch = globalThis.fetch;
  // No server: queued ops stay in pendingOps (the flush just fails).
  globalThis.fetch = (async () => new Response("{}", { status: 503 })) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
  rmSync(root, { recursive: true, force: true });
  delete process.env.SF_USER_DATA_PATH;
});

type Ep = { s: number; e: number; name?: string; airDate?: string | null; overview?: string | null; stillPath?: string | null };

const show = (
  episodes: Ep[],
  extra: { totalEpisodes?: number; seasons?: number[]; seasonNames?: Record<number, string>; episodeCounts?: Record<number, number>; status?: string | null; nextEpisodeAirDate?: string | null } = {}
) => {
  const seasonNumbers = extra.seasons ?? [...new Set(episodes.map((ep) => ep.s))];
  return {
    id: 7001,
    type: "tv" as const,
    title: "Running Show",
    originalTitle: null,
    originalLanguage: "en",
    overview: null,
    year: "2025",
    rating: null,
    posterPath: null,
    backdropPath: null,
    genres: [],
    cast: [],
    trailers: [],
    seasons: seasonNumbers.map((seasonNumber) => ({
      seasonNumber,
      name: extra.seasonNames?.[seasonNumber] ?? `Season ${seasonNumber}`,
      overview: null,
      posterPath: null,
      episodeCount: extra.episodeCounts?.[seasonNumber] ?? episodes.filter((ep) => ep.s === seasonNumber).length,
      airDate: null,
    })),
    episodes: episodes.map((ep) => ({
      seasonNumber: ep.s,
      episodeNumber: ep.e,
      name: ep.name ?? `S${ep.s}E${ep.e}`,
      overview: ep.overview ?? null,
      stillPath: ep.stillPath ?? null,
      airDate: ep.airDate ?? null,
    })),
    totalEpisodes: extra.totalEpisodes ?? episodes.length,
    status: extra.status ?? null,
    nextEpisodeAirDate: extra.nextEpisodeAirDate ?? null,
  };
};

const episodeIds = (db: LibraryDb, mediaId: string) =>
  Object.fromEntries(db.getMediaDetails(mediaId)!.episodes.map((ep) => [`${ep.seasonNumber}:${ep.episodeNumber}`, ep.id]));

/** A show with S1E1 + S1E2, a file + resume + skip markers + a subtitle on S1E1. */
const seedWatchedShow = async (db: LibraryDb) => {
  const mediaId = await db.addMediaFromCatalog(show([{ s: 1, e: 1 }, { s: 1, e: 2 }]));
  const fileId = await db.linkFileToMedia(mediaId, "show.s01e01.mkv", 1, 1);
  await db.addSubtitleTrackWithObject({
    mediaId,
    fileId,
    season: 1,
    episode: 1,
    language: "en",
    label: "English",
    objectKey: "s1e1/sub",
    format: "vtt",
  });
  const e1 = episodeIds(db, mediaId)["1:1"]!;
  await db.setProgress(mediaId, 40, e1);
  await db.replaceSkipMarkers(mediaId, e1, [{ type: "intro", startSeconds: 5, endSeconds: 60, source: "internal" }]);
  log("seeded", { mediaId, fileId, ids: episodeIds(db, mediaId) });
  return { mediaId, e1, before: episodeIds(db, mediaId) };
};

/** Every row keyed by an episode id still points at an episode of the show. */
const expectEpisodeLinksIntact = (db: LibraryDb, mediaId: string, e1: string) => {
  const details = db.getMediaDetails(mediaId)!;
  const ids = new Set(details.episodes.map((ep) => ep.id));
  const resumeKeys = [`episode_resume_v1:${e1}`];
  const state = {
    ids: [...ids],
    subtitleEpisodeIds: details.subtitleTracks.map((track) => track.episodeId),
    skipMarkerEpisodeIds: details.skipMarkers.map((marker) => marker.episodeId),
    resume: db.getSetting(resumeKeys[0]!)?.value ?? null,
    progressPct: details.progressPct,
  };
  log("links after re-ingest", state);
  expect(ids.has(e1), "S1E1 keeps its id, so its resume key still matches").toBe(true);
  expect(state.subtitleEpisodeIds.every((id) => id !== null && ids.has(id)), "subtitle rows still point at an episode").toBe(true);
  expect(state.skipMarkerEpisodeIds.length).toBeGreaterThan(0);
  expect(state.skipMarkerEpisodeIds.every((id) => id !== null && ids.has(id)), "skip markers still point at an episode").toBe(true);
  expect(state.resume).not.toBeNull();
};

describe("re-ingesting a show keeps its episode ids (LIB-SHOW-01)", () => {
  it("@req LIB-SHOW-01[badger-desktop,runtime] @bugfix @regression-proof addMediaFromCatalog again keeps every stored episode's id and its progress, markers and subtitles", async () => {
    const db = await LibraryDb.openLocal("token", "key");
    db.setSyncEnabled(false);
    const { mediaId, e1, before } = await seedWatchedShow(db);

    const again = await db.addMediaFromCatalog(show([{ s: 1, e: 1 }, { s: 1, e: 2 }, { s: 1, e: 3 }]));
    expect(again).toBe(mediaId);
    const after = episodeIds(db, mediaId);
    log("ids", { before, after });
    expect(after["1:1"]).toBe(before["1:1"]);
    expect(after["1:2"]).toBe(before["1:2"]);
    expect(after["1:3"], "the new episode is added").toBeDefined();
    expectEpisodeLinksIntact(db, mediaId, e1);
    db.close();
  });

  it("@req LIB-SHOW-01[badger-desktop,runtime] @bugfix @regression-proof keeps every stored episode, with or without a file, when the catalog stops listing it", async () => {
    const db = await LibraryDb.openLocal("token", "key");
    db.setSyncEnabled(false);
    const { mediaId, before } = await seedWatchedShow(db);
    // the catalog renumbered: S1E1 (has a file) and S1E2 (no file) are gone from its list.
    await db.addMediaFromCatalog(show([{ s: 1, e: 3 }]));
    const after = episodeIds(db, mediaId);
    log("ids after the catalog dropped S1E1/S1E2", after);
    expect(Object.keys(after).sort()).toEqual(["1:1", "1:2", "1:3"]);
    expect(after["1:2"]).toBe(before["1:2"]);
    db.close();
  });
});

describe("refreshShowEpisodes merges a running show's new the catalog list (LIB-SHOW-01)", () => {
  it("@req LIB-SHOW-01[badger-desktop,runtime] adds a new season and episode, updates air dates and the total, and keeps ids and file-linked episodes", async () => {
    const db = await LibraryDb.openLocal("token", "key");
    db.setSyncEnabled(false);
    const { mediaId, e1, before } = await seedWatchedShow(db);

    const result = await db.refreshShowEpisodes(
      mediaId,
      show(
        [
          { s: 1, e: 2, airDate: "2025-02-01" },
          { s: 2, e: 1, name: "New season premiere", airDate: "2026-11-05" },
        ],
        { totalEpisodes: 3, status: "Returning Series", nextEpisodeAirDate: "2026-11-05" }
      )
    );
    log("refresh result", result);
    expect(result).toMatchObject({ addedEpisodes: 1, addedSeasons: 1, changed: true });

    const details = db.getMediaDetails(mediaId)!;
    const after = episodeIds(db, mediaId);
    log("after refresh", { after, seasons: details.seasons.map((s) => s.seasonNumber), total: details.totalEpisodes });
    expect(after["1:1"], "S1E1 has a file: kept although the catalog no longer lists it").toBe(before["1:1"]);
    expect(after["1:2"]).toBe(before["1:2"]);
    expect(after["2:1"]).toBeDefined();
    expect(details.seasons.map((s) => s.seasonNumber).sort()).toEqual([1, 2]);
    expect(details.totalEpisodes).toBe(3);
    expect(details.episodes.find((ep) => ep.id === before["1:2"])?.airDate).toBe("2025-02-01");
    expect(details.title, "the refresh does not touch the show's own fields").toBe("Running Show");
    expectEpisodeLinksIntact(db, mediaId, e1);

    const unchanged = await db.refreshShowEpisodes(
      mediaId,
      show(
        [
          { s: 1, e: 2, airDate: "2025-02-01" },
          { s: 2, e: 1, name: "New season premiere", airDate: "2026-11-05" },
        ],
        { totalEpisodes: 3 }
      )
    );
    expect(unchanged).toMatchObject({ addedEpisodes: 0, updatedEpisodes: 0, changed: false });
    db.close();
  });

  it("@req LIB-SHOW-01[badger-desktop,runtime] @bugfix @regression-proof keeps an episode the catalog answered without a name, with its id", async () => {
    const db = await LibraryDb.openLocal("token", "key");
    db.setSyncEnabled(false);
    const s3 = Array.from({ length: 8 }, (_, i) => ({ s: 3, e: i + 1, airDate: "2025-03-01" }));
    const mediaId = await db.addMediaFromCatalog(show(s3));
    const before = episodeIds(db, mediaId);
    // S3E8 has no translation in the requested language: the fetchers drop it (empty name), the rest of S3 is there.
    const dropped = await db.refreshShowEpisodes(mediaId, show(s3.slice(0, 7)));
    const nameless = await db.refreshShowEpisodes(mediaId, show([...s3.slice(0, 7), { s: 3, e: 8, name: "", airDate: "2025-03-01" }]));
    const after = episodeIds(db, mediaId);
    const e8 = db.getMediaDetails(mediaId)!.episodes.find((ep) => ep.id === before["3:8"]);
    log("S3E8 without a name", { dropped, nameless, before: before["3:8"], after: after["3:8"], e8 });
    expect(after["3:8"], "S3E8 keeps its row and id").toBe(before["3:8"]);
    expect(e8?.name, "an empty the catalog name does not blank the stored title").toBe("S3E8");
    expect(dropped, "no episode row is touched").toMatchObject({ addedEpisodes: 0, updatedEpisodes: 0 });
    db.close();
  });

  it("@req LIB-SHOW-01[badger-desktop,runtime] @bugfix @regression-proof keeps a season the catalog answered without a name, its row and its episodes", async () => {
    const db = await LibraryDb.openLocal("token", "key");
    db.setSyncEnabled(false);
    const mediaId = await db.addMediaFromCatalog(show([{ s: 1, e: 1 }, { s: 2, e: 1 }, { s: 3, e: 1 }, { s: 3, e: 2 }]));
    const before = db.getMediaDetails(mediaId)!;
    // Season 3 has an empty name: the fetchers drop the season and never fetch its episodes.
    await db.refreshShowEpisodes(mediaId, show([{ s: 1, e: 1 }, { s: 2, e: 1 }]));
    // Or the season comes through with "" as its name.
    await db.refreshShowEpisodes(mediaId, show([{ s: 1, e: 1 }, { s: 2, e: 1 }, { s: 3, e: 1 }, { s: 3, e: 2 }], { seasonNames: { 3: "" } }));
    const after = db.getMediaDetails(mediaId)!;
    const seasonRow = (d: typeof before) => d.seasons.find((season) => season.seasonNumber === 3);
    log("season 3 without a name", { before: seasonRow(before), after: seasonRow(after), ids: episodeIds(db, mediaId) });
    expect(seasonRow(after)?.id).toBe(seasonRow(before)!.id);
    expect(seasonRow(after)?.name).toBe("Season 3");
    expect(after.episodes.filter((ep) => ep.seasonNumber === 3).map((ep) => ep.id)).toEqual(
      before.episodes.filter((ep) => ep.seasonNumber === 3).map((ep) => ep.id)
    );
    db.close();
  });

  it("@req LIB-SHOW-01[badger-desktop,runtime] @bugfix @regression-proof does not rewrite a special with no air date and a real title", async () => {
    const db = await LibraryDb.openLocal("token", "key");
    db.setSyncEnabled(false);
    const mediaId = await db.addMediaFromCatalog(
      show([{ s: 0, e: 1, name: "Christmas Special", overview: "Stored text", airDate: null }, { s: 1, e: 1, airDate: "2025-01-01" }])
    );
    const result = await db.refreshShowEpisodes(
      mediaId,
      show([{ s: 0, e: 1, name: "Spécial de Noël", overview: "Autre texte", airDate: null }, { s: 1, e: 1, airDate: "2025-01-01" }])
    );
    const special = db.getMediaDetails(mediaId)!.episodes.find((ep) => ep.seasonNumber === 0);
    log("special after refresh", { result, special });
    expect(special).toMatchObject({ name: "Christmas Special", overview: "Stored text" });
    expect(result.updatedEpisodes).toBe(0);
    db.close();
  });

  it("@req LIB-SHOW-01[badger-desktop,runtime] @bugfix @regression-proof fills in the overview and still an aired episode was stored without", async () => {
    const db = await LibraryDb.openLocal("token", "key");
    db.setSyncEnabled(false);
    const mediaId = await db.addMediaFromCatalog(show([{ s: 2, e: 3, name: "The Heist", airDate: "2025-11-05" }]));
    const result = await db.refreshShowEpisodes(
      mediaId,
      show([{ s: 2, e: 3, name: "The Heist (new title)", airDate: "2025-11-05", overview: "They rob a bank.", stillPath: "/still.jpg" }])
    );
    const episode = db.getMediaDetails(mediaId)!.episodes[0];
    log("aired episode after refresh", { result, episode });
    expect(episode).toMatchObject({ name: "The Heist", overview: "They rob a bank.", stillPath: "/still.jpg" });
    expect(result).toMatchObject({ updatedEpisodes: 1, changed: true });

    const again = await db.refreshShowEpisodes(
      mediaId,
      show([{ s: 2, e: 3, name: "The Heist", airDate: "2025-11-05", overview: "Different text", stillPath: "/other.jpg" }])
    );
    expect(db.getMediaDetails(mediaId)!.episodes[0], "a stored value is never overwritten").toMatchObject({
      overview: "They rob a bank.",
      stillPath: "/still.jpg",
    });
    expect(again.changed).toBe(false);
    db.close();
  });

  it("@req LIB-SHOW-01[badger-desktop,runtime] publishes the merged list with stable ids in one media.upsert op", async () => {
    const db = await LibraryDb.openLocal("token", "key");
    db.setSyncEnabled(true);
    const { mediaId, before } = await seedWatchedShow(db);
    await db.refreshShowEpisodes(mediaId, show([{ s: 1, e: 1 }, { s: 1, e: 2 }, { s: 1, e: 3 }]));
    const upserts = (db as unknown as Internals).pendingOps.filter(
      (op) => op.type === "media.upsert" && op.payload.details?.id === mediaId
    );
    const last = upserts.at(-1)!.payload.details!;
    const sent = Object.fromEntries(last.episodes.map((ep) => [`${ep.seasonNumber}:${ep.episodeNumber}`, ep.id]));
    log("upsert episodes", sent);
    expect(sent["1:1"]).toBe(before["1:1"]);
    expect(sent["1:2"]).toBe(before["1:2"]);
    expect(sent["1:3"]).toBeDefined();
    db.close();
  });
});

describe("episodes the catalog no longer lists are reported, never removed silently (LIB-SHOW-02)", () => {
  it("@req LIB-SHOW-02[runtime] reports a file-less episode missing from a complete season, keeps it, and never offers one with a file for removal", async () => {
    const db = await LibraryDb.openLocal("token", "key");
    db.setSyncEnabled(false);
    const { mediaId, before } = await seedWatchedShow(db);
    // the catalog now lists only S1E1 and says season 1 has one episode: S1E2 (no file) was deleted upstream.
    const result = await db.refreshShowEpisodes(mediaId, show([{ s: 1, e: 1 }, { s: 2, e: 1 }]));
    log("refresh after S1E2 was delisted", result);
    expect(result.notListed).toEqual([{ id: before["1:2"], seasonNumber: 1, episodeNumber: 2, title: "S1E2" }]);
    expect(episodeIds(db, mediaId)["1:2"], "nothing is removed by the refresh").toBe(before["1:2"]);

    // S1E1 has a file: even when the catalog drops it from a complete season it is never offered for removal; it carries
    // the change suggested for it instead (LIB-SHOW-04).
    const withFileGone = await db.refreshShowEpisodes(mediaId, show([{ s: 1, e: 3 }, { s: 2, e: 1 }]));
    log("refresh after S1E1 (file) and S1E2 were delisted", withFileGone);
    expect(withFileGone.notListed.filter((ep) => !ep.move).map((ep) => `${ep.seasonNumber}:${ep.episodeNumber}`)).toEqual(["1:2"]);
    expect(withFileGone.notListed.find((ep) => ep.id === before["1:1"])?.move).toEqual({ kind: "none" });
    db.close();
  });

  it("@req LIB-SHOW-02[runtime] does not report an episode when its season's answer is incomplete, empty or missing", async () => {
    const db = await LibraryDb.openLocal("token", "key");
    db.setSyncEnabled(false);
    const mediaId = await db.addMediaFromCatalog(show([{ s: 1, e: 1 }, { s: 1, e: 2 }, { s: 2, e: 1 }, { s: 3, e: 1 }]));
    // S1E2 dropped for an empty name (season 1 still counts 2), season 2 came back empty (failed fetch),
    // season 3 is not in the list at all (empty season name).
    const result = await db.refreshShowEpisodes(
      mediaId,
      show([{ s: 1, e: 1 }], { seasons: [1, 2], episodeCounts: { 1: 2, 2: 1 } })
    );
    log("incomplete answers", result);
    expect(result.notListed).toEqual([]);
    db.close();
  });

  it("@req LIB-SHOW-02[runtime] removes the episodes the user accepted, skips one that has a file, and publishes the change", async () => {
    const db = await LibraryDb.openLocal("token", "key");
    db.setSyncEnabled(true);
    const { mediaId, before } = await seedWatchedShow(db);
    await db.replaceSkipMarkers(mediaId, before["1:2"]!, [{ type: "intro", startSeconds: 1, endSeconds: 30, source: "internal" }]);
    const removal = await db.removeEpisodesNotInCatalog(mediaId, [before["1:2"]!, before["1:1"]!, "not-an-episode"]);
    const after = episodeIds(db, mediaId);
    const upserts = (db as unknown as Internals).pendingOps.filter(
      (op) => op.type === "media.upsert" && op.payload.details?.id === mediaId
    );
    const sent = upserts.at(-1)!.payload.details!.episodes.map((ep) => ep.id);
    const markers = db.getMediaDetails(mediaId)!.skipMarkers ?? [];
    log("after removal", { removal, after, sent, markers });
    expect(removal).toEqual({ removed: 1, keptWithFile: 1 });
    expect(after).toEqual({ "1:1": before["1:1"] });
    expect(sent).toEqual([before["1:1"]]);
    expect(markers.every((marker) => marker.episodeId !== before["1:2"])).toBe(true);
    db.close();
  });
});
