/**
 * @test-id LIB-SHOW-MOVE-001
 * @level unit (pure matcher) + integration (real LibraryDb over bun:sqlite, no server)
 *
 * LIB-SHOW-04: when the catalog stops listing an episode the user has a file for, the daily check suggests where it went
 * (one likely new place: same title in any season, or same air date and order after a renumbering; merges get the
 * keep-or-pick-by-hand choice per part), and a move the user accepts keeps the episode's id so its watched state,
 * resume spot, skip markers and subtitles go along, renumbers every version's file and publishes one media.upsert.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { LibraryDb } from "../src/libraryDb";
import type { EpisodeMoveSuggestion } from "@space/shared/libraryTypes";
import { episodeTitleBase, normalizeEpisodeTitle, suggestEpisodeMoves, type EpisodeForMatch } from "../src/episodeMoves";

const TAG = "[episode-move]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const ep = (id: string, s: number, e: number, title: string, extra: Partial<EpisodeForMatch> = {}): EpisodeForMatch => ({
  id,
  seasonNumber: s,
  episodeNumber: e,
  title,
  airDate: null,
  hasFile: false,
  ...extra,
});

describe("suggestEpisodeMoves finds one likely new place (LIB-SHOW-04)", () => {
  it("@req LIB-SHOW-04[runtime] suggests the one file-less episode with the same title, in any season", () => {
    const party = ep("s2e10", 2, 10, "Christmas Party", { hasFile: true });
    const moves = suggestEpisodeMoves([party], [ep("s0e3", 0, 3, "Christmas  party!"), ep("s2e11", 2, 11, "Halloween")]);
    log("same title", Object.fromEntries(moves));
    expect(moves.get("s2e10")).toEqual({ kind: "move", target: { id: "s0e3", seasonNumber: 0, episodeNumber: 3, title: "Christmas  party!" } });
  });

  it("@req LIB-SHOW-04[runtime] suggests the episode at the same air date and order after a renumbering", () => {
    const a = ep("old-a", 1, 2, "Pilot (DVD)", { hasFile: true, airDate: "2005-03-24" });
    const b = ep("old-b", 1, 3, "Diversity Day (DVD)", { hasFile: true, airDate: "2005-03-29" });
    const moves = suggestEpisodeMoves(
      [a, b],
      [
        ep("new-1", 1, 1, "Pilot", { airDate: "2005-03-24" }),
        ep("new-2", 1, 2, "Diversity Day", { airDate: "2005-03-29" }),
      ]
    );
    log("same position", Object.fromEntries(moves));
    expect(moves.get("old-a")).toMatchObject({ kind: "move", target: { id: "new-1" } });
    expect(moves.get("old-b")).toMatchObject({ kind: "move", target: { id: "new-2" } });
  });

  it("@req LIB-SHOW-04[runtime] falls back to keep-or-pick when no place, several places, or only a place with a file fits", () => {
    const lost = ep("lost", 1, 5, "The Lost One", { hasFile: true });
    const twice = ep("twice", 1, 6, "Twin", { hasFile: true });
    const taken = ep("taken", 1, 7, "Taken", { hasFile: true });
    const moves = suggestEpisodeMoves(
      [lost, twice, taken],
      [ep("t1", 0, 1, "Twin"), ep("t2", 0, 2, "twin"), ep("t3", 0, 3, "Taken", { hasFile: true })]
    );
    log("no likely place", Object.fromEntries(moves));
    expect(moves.get("lost")).toEqual({ kind: "none" });
    expect(moves.get("twice")).toEqual({ kind: "none" });
    expect(moves.get("taken"), "an episode that has a file is never a likely place").toEqual({ kind: "none" });
  });

  it("@req LIB-SHOW-04[runtime] never suggests a move for a placeholder title, and only for episodes with a file", () => {
    const placeholder = ep("ph", 1, 4, "Episode 4", { hasFile: true });
    const fileless = ep("nofile", 1, 8, "Gone");
    const moves = suggestEpisodeMoves([placeholder, fileless], [ep("x", 0, 1, "Episode 4"), ep("y", 0, 2, "Gone")]);
    expect(normalizeEpisodeTitle("Episode 4")).toBe("");
    expect(moves.get("ph")).toEqual({ kind: "none" });
    expect(moves.has("nofile")).toBe(false);
  });

  it("@req LIB-SHOW-04[runtime] reports two parts the catalog merged into one episode as a merge, for each part", () => {
    const p1 = ep("p1", 3, 1, "The Beginning (1)", { hasFile: true });
    const p2 = ep("p2", 3, 2, "The Beginning, Part 2", { hasFile: true });
    expect(episodeTitleBase("The Beginning (1)")).toBe("the beginning");
    expect(episodeTitleBase("The Beginning, Part 2")).toBe("the beginning");
    expect(episodeTitleBase("Ocean's 11")).toBeNull();
    const moves = suggestEpisodeMoves([p1, p2], [ep("merged", 3, 1, "The Beginning")]);
    log("merge", Object.fromEntries(moves));
    const expected: EpisodeMoveSuggestion = { kind: "merged", into: { id: "merged", seasonNumber: 3, episodeNumber: 1, title: "The Beginning" }, partIds: ["p1", "p2"] };
    expect(moves.get("p1")).toEqual(expected);
    expect(moves.get("p2")).toEqual(expected);
  });

  it("@req LIB-SHOW-04[runtime] treats two episodes pointing to the same single place as a merge", () => {
    const a = ep("a", 2, 1, "Double", { hasFile: true, airDate: "2010-01-01" });
    const b = ep("b", 2, 2, "Double", { hasFile: true });
    const moves = suggestEpisodeMoves([a, b], [ep("one", 2, 1, "Double")]);
    expect(moves.get("a")).toMatchObject({ kind: "merged", into: { id: "one" }, partIds: ["a", "b"] });
    expect(moves.get("b")).toMatchObject({ kind: "merged", into: { id: "one" } });
  });
});

type Internals = {
  pendingOps: Array<{
    type: string;
    payload: {
      key?: string;
      details?: {
        id: string;
        episodes: Array<{ id: string; seasonNumber: number; episodeNumber: number }>;
        files: Array<{ id: string; season: number | null; episode: number | null }>;
      };
    };
  }>;
};

let root = "";
let originalFetch: typeof globalThis.fetch | null = null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-episode-move-"));
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

type Ep = { s: number; e: number; name: string; airDate?: string | null };

const show = (episodes: Ep[]) => ({
  id: 2316,
  type: "tv" as const,
  title: "The Office",
  originalTitle: null,
  originalLanguage: "en",
  overview: null,
  year: "2005",
  rating: null,
  posterPath: null,
  backdropPath: null,
  genres: [],
  cast: [],
  trailers: [],
  seasons: [...new Set(episodes.map((item) => item.s))].map((seasonNumber) => ({
    seasonNumber,
    name: seasonNumber === 0 ? "Specials" : `Season ${seasonNumber}`,
    overview: null,
    posterPath: null,
    episodeCount: episodes.filter((item) => item.s === seasonNumber).length,
    airDate: null,
  })),
  episodes: episodes.map((item) => ({
    seasonNumber: item.s,
    episodeNumber: item.e,
    name: item.name,
    overview: null,
    stillPath: null,
    airDate: item.airDate ?? null,
  })),
  totalEpisodes: episodes.length,
  status: "Returning Series",
  nextEpisodeAirDate: null,
});

const slots = (db: LibraryDb, mediaId: string) =>
  Object.fromEntries(db.getMediaDetails(mediaId)!.episodes.map((item) => [`${item.seasonNumber}:${item.episodeNumber}`, item.id]));

describe("moveEpisodeToSlot carries everything of the episode's (LIB-SHOW-04)", () => {
  it("@req LIB-SHOW-04[runtime] suggests Special 3 for a delisted S02E10 and moves its files, watched state, resume spot and markers there", async () => {
    const db = await LibraryDb.openLocal("token", "key");
    db.setSyncEnabled(true);
    const before = [
      { s: 2, e: 9, name: "E-Mail Surveillance" },
      { s: 2, e: 10, name: "Christmas Party" },
    ];
    const mediaId = await db.addMediaFromCatalog(show(before));
    // One file row per slot; its versions (formats) hang off the file id, so they follow the file.
    const fileA = await db.linkFileToMedia(mediaId, "office.s02e10.1080p.mkv", 2, 10);
    const partyId = slots(db, mediaId)["2:10"]!;
    await db.setProgress(mediaId, 100, partyId, { positionSeconds: 1290, durationSeconds: 1290 });
    await db.replaceSkipMarkers(mediaId, partyId, [{ type: "intro", startSeconds: 4, endSeconds: 40, source: "internal" }]);
    await db.addSubtitleTrackWithObject({ mediaId, fileId: fileA, season: 2, episode: 10, language: "en", label: "English", objectKey: "s2e10/sub", format: "vtt" });
    log("seeded", { mediaId, partyId, fileA, slots: slots(db, mediaId) });

    // the catalog moved it to Specials: season 2 now lists only E09, Specials list "Christmas Party" as episode 3.
    const refresh = await db.refreshShowEpisodes(
      mediaId,
      show([
        { s: 0, e: 1, name: "Blooper Reel" },
        { s: 0, e: 2, name: "Deleted Scenes" },
        { s: 0, e: 3, name: "Christmas Party" },
        { s: 2, e: 9, name: "E-Mail Surveillance" },
      ])
    );
    log("refresh", refresh);
    const specialId = slots(db, mediaId)["0:3"]!;
    expect(refresh.notListed).toEqual([
      {
        id: partyId,
        seasonNumber: 2,
        episodeNumber: 10,
        title: "Christmas Party",
        move: { kind: "move", target: { id: specialId, seasonNumber: 0, episodeNumber: 3, title: "Christmas Party" } },
      },
    ]);
    expect(slots(db, mediaId)["2:10"], "nothing moves before the user says yes").toBe(partyId);

    const resumeBefore = db.getSnapshot().settings?.[`episode_resume_v1:${partyId}`]?.value;
    const result = await db.moveEpisodeToSlot(mediaId, partyId, specialId);
    const details = db.getMediaDetails(mediaId)!;
    const after = slots(db, mediaId);
    log("moved", { result, after, files: details.files, markers: details.skipMarkers, subtitles: details.subtitleTracks });
    expect(result).toEqual({ moved: true, files: 1 });
    expect(after["0:3"], "the episode keeps its id at the new place").toBe(partyId);
    expect(after["2:10"]).toBeUndefined();
    expect(Object.values(after)).not.toContain(specialId);
    expect(details.files.filter((file) => file.id === fileA).map((file) => `${file.season}:${file.episode}`)).toEqual(["0:3"]);
    expect(db.getSnapshot().settings?.[`episode_resume_v1:${partyId}`]?.value, "watched state and resume spot stay on the episode").toBe(resumeBefore);
    expect(JSON.parse(resumeBefore!)).toMatchObject({ progressPct: 100, positionSeconds: 1290 });
    expect(details.skipMarkers.map((marker) => marker.episodeId)).toEqual([partyId]);
    expect(details.subtitleTracks.every((track) => track.episodeId === partyId)).toBe(true);

    const upsert = (db as unknown as Internals).pendingOps.filter((op) => op.type === "media.upsert" && op.payload.details?.id === mediaId).at(-1)!;
    const sent = upsert.payload.details!;
    log("published", { episodes: sent.episodes, files: sent.files });
    expect(sent.episodes.find((item) => item.id === partyId)).toMatchObject({ seasonNumber: 0, episodeNumber: 3 });
    expect(sent.files.map((file) => `${file.season}:${file.episode}`)).toEqual(["0:3"]);

    // The next check finds it listed again: nothing more is suggested.
    const again = await db.refreshShowEpisodes(
      mediaId,
      show([
        { s: 0, e: 1, name: "Blooper Reel" },
        { s: 0, e: 2, name: "Deleted Scenes" },
        { s: 0, e: 3, name: "Christmas Party" },
        { s: 2, e: 9, name: "E-Mail Surveillance" },
      ])
    );
    expect(again.notListed).toEqual([]);
    db.close();
  });

  it("@req LIB-SHOW-04[runtime] refuses a move onto an episode with a file, from one without a file, or within nothing", async () => {
    const db = await LibraryDb.openLocal("token", "key");
    db.setSyncEnabled(false);
    const mediaId = await db.addMediaFromCatalog(show([{ s: 1, e: 1, name: "A" }, { s: 1, e: 2, name: "B" }, { s: 1, e: 3, name: "C" }]));
    await db.linkFileToMedia(mediaId, "a.mkv", 1, 1);
    await db.linkFileToMedia(mediaId, "b.mkv", 1, 2);
    const ids = slots(db, mediaId);
    const refused = {
      targetHasFile: await db.moveEpisodeToSlot(mediaId, ids["1:1"]!, ids["1:2"]!),
      noFile: await db.moveEpisodeToSlot(mediaId, ids["1:3"]!, ids["1:2"]!),
      same: await db.moveEpisodeToSlot(mediaId, ids["1:1"]!, ids["1:1"]!),
      missing: await db.moveEpisodeToSlot(mediaId, ids["1:1"]!, "not-an-episode"),
    };
    log("refused", refused);
    expect(refused).toEqual({
      targetHasFile: { moved: false, reason: "target-has-file" },
      noFile: { moved: false, reason: "no-file" },
      same: { moved: false, reason: "same-episode" },
      missing: { moved: false, reason: "not-found" },
    });
    expect(slots(db, mediaId)).toEqual(ids);
    db.close();
  });
});
