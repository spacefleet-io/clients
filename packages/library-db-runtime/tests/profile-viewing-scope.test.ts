/**
 * @test-id LIB-PROFILE-VIEWING-SCOPE-001
 * @level integration (real-engine, bun:sqlite, full LibraryDb)
 *
 * @req ACCT-SQUAD-02[badger-desktop]
 * @req ACCT-PROF-02[badger-desktop]
 * @req PLAY-TRACK-04[badger-desktop]
 *
 * The runtime LibraryDb behind desktop keeps each profile's viewing state apart exactly like phone/TV: the main
 * profile keeps the library's own storage, every other profile keeps it under `p:<profileId>:` app_settings keys
 * (`packages/shared/src/profileViewing.ts`). Covered:
 *  - progress (movie + TV episode), watched %, track choice, favorites and playlists read and write in the active
 *    profile only, and the renderer snapshot shows the active profile's resume/track keys at their plain names;
 *  - mobile ↔ runtime round trip: state written in the mobile format (the shared helpers mobile writes with) reads
 *    back on desktop, and what desktop writes parses with the shared readers mobile uses, at the keys mobile reads;
 *  - deleting a profile: a non-main profile's keys are blanked, a deleted main profile is replaced by the oldest
 *    remaining one (its state moves into the library's own storage);
 *  - deleting a title clears it from every non-main profile (LIB-OPS-02 per-profile part).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  buildMediaProgressValue,
  FAVORITES_PLAYLIST_ID,
  MAIN_PROFILE_SETTING_KEY,
  parseMediaProgressValue,
  parseProfilePlaylist,
  scopedEpisodeResumeKey,
  scopedMediaProgressKey,
  scopedPlaylistKey,
  scopedTrackPrefsKey,
  serializeProfilePlaylist,
  type ViewingScope,
} from "@space/shared/profileViewing";
import { parseTrackPrefs, serializeTrackPrefs } from "@space/shared/trackPrefs";
import { LibraryDb } from "../src/libraryDb";

const SUITE = "profile-viewing-scope";
const log = (phase: string, data?: unknown) =>
  console.info(`[${SUITE}] ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

type QueuedOp = { id: string; type: string; createdAt: string; payload: Record<string, unknown> };
type Internals = { pendingOps: QueuedOp[]; applyLibraryOps(ops: unknown[]): Promise<void> };
const internalsOf = (db: LibraryDb) => db as unknown as Internals; // test-only peek at private sync state

const MAIN = { id: "main-uuid", isMain: true };
const KID = { id: "kid-uuid", isMain: false };
const KID_SCOPE: ViewingScope = { profileId: KID.id, prefix: `p:${KID.id}:` };

let roots: string[] = [];
let originalFetch: typeof globalThis.fetch | null = null;

const openDevice = async (label: string) => {
  const root = mkdtempSync(join(tmpdir(), `sf-profile-scope-${label}-`));
  roots.push(root);
  process.env.SF_USER_DATA_PATH = root;
  const db = await LibraryDb.openLocal(`token-${label}`, "key");
  db.setSyncEnabled(true);
  log("open", { label, root });
  return db;
};

beforeEach(() => {
  originalFetch = globalThis.fetch;
  // No server: queued ops stay in pendingOps (the flush just fails).
  globalThis.fetch = (async () => new Response("{}", { status: 503 })) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
  delete process.env.SF_USER_DATA_PATH;
});

type TitleItem = Parameters<LibraryDb["addMediaFromCatalog"]>[0];

const seedMovie = (db: LibraryDb, catalogId: number) =>
  db.addMediaFromCatalog({
    id: catalogId,
    type: "movie",
    title: `Movie ${catalogId}`,
    originalTitle: null,
    originalLanguage: "en",
    overview: null,
    year: "2026",
    rating: null,
    posterPath: null,
    backdropPath: null,
    genres: [],
    cast: [],
    trailers: [],
    seasons: [],
    episodes: [],
    totalEpisodes: 0,
  } as unknown as TitleItem);

const seedShow = (db: LibraryDb, catalogId: number) =>
  db.addMediaFromCatalog({
    id: catalogId,
    type: "tv",
    title: `Show ${catalogId}`,
    originalTitle: null,
    originalLanguage: "en",
    overview: null,
    year: "2020",
    rating: null,
    posterPath: null,
    backdropPath: null,
    genres: [],
    cast: [],
    trailers: [],
    seasons: [],
    episodes: Array.from({ length: 4 }, (_, i) => ({
      seasonNumber: 1,
      episodeNumber: i + 1,
      airDate: `2020-01-0${i + 1}`,
      name: `E${i + 1}`,
      overview: null,
      stillPath: null,
    })),
    totalEpisodes: 4,
  } as unknown as TitleItem);

const episodeIds = (db: LibraryDb, mediaId: string) =>
  (db.getMediaDetails(mediaId)?.episodes ?? []).sort((a, b) => a.episodeNumber - b.episodeNumber).map((e) => String(e.id));

const progressOf = (db: LibraryDb, mediaId: string) => ({
  list: db.listMedia().find((row) => String(row.id) === mediaId)?.progressPct ?? null,
  details: db.getMediaDetails(mediaId)?.progressPct ?? null,
});

const opsFor = (db: LibraryDb, key: string) =>
  internalsOf(db).pendingOps.filter((op) => op.type === "setting.set" && op.payload.key === key);

describe("runtime LibraryDb viewing scope (ACCT-SQUAD-02 desktop)", () => {
  it("@req ACCT-SQUAD-02[badger-desktop] a movie's progress is the active profile's own", async () => {
    const db = await openDevice("movie");
    const movie = await seedMovie(db, 41_001);
    db.setActiveProfile(MAIN);
    await db.setProgress(movie, 50);
    log("main watched 50", progressOf(db, movie));

    db.setActiveProfile(KID);
    expect(db.getActiveProfile()).toEqual(KID);
    log("kid before watching", progressOf(db, movie));
    expect(progressOf(db, movie)).toEqual({ list: 0, details: 0 });

    await db.setProgress(movie, 30);
    log("kid watched 30", progressOf(db, movie));
    expect(progressOf(db, movie)).toEqual({ list: 30, details: 30 });
    const kidOps = opsFor(db, scopedMediaProgressKey(KID_SCOPE, movie));
    log("kid progress ops", kidOps);
    expect(kidOps).toHaveLength(1);
    expect(parseMediaProgressValue(String(kidOps[0]!.payload.value))?.progressPct).toBe(30);

    db.setActiveProfile(MAIN);
    log("back on main", progressOf(db, movie));
    expect(progressOf(db, movie)).toEqual({ list: 50, details: 50 });
    db.close();
  });

  it("@req ACCT-SQUAD-02[badger-desktop] an episode in one profile never moves another profile's resume point or watched %", async () => {
    const db = await openDevice("tv");
    const show = await seedShow(db, 41_002);
    const [e1, e2] = episodeIds(db, show);
    db.setActiveProfile(MAIN);
    await db.setProgress(show, 100, e1, { positionSeconds: 1500, durationSeconds: 1500 });
    const mainPct = progressOf(db, show);
    log("main watched e1", mainPct);
    expect(mainPct.details).toBeCloseTo(25, 6);

    db.setActiveProfile(KID);
    expect(progressOf(db, show)).toEqual({ list: 0, details: 0 });
    await db.setProgress(show, 50, e2, { positionSeconds: 600, durationSeconds: 1200 });
    const kidPct = progressOf(db, show);
    log("kid half of e2", kidPct);
    expect(kidPct.details).toBeCloseTo(12.5, 6);
    expect(kidPct.list).toBeCloseTo(12.5, 6);

    const kidResume = opsFor(db, scopedEpisodeResumeKey(KID_SCOPE, e2));
    log("kid resume ops", kidResume);
    expect(kidResume).toHaveLength(1);
    expect(JSON.parse(String(kidResume[0]!.payload.value))).toMatchObject({ progressPct: 50, positionSeconds: 600 });
    expect(opsFor(db, `episode_resume_v1:${e2}`)).toHaveLength(0);
    // Mobile reads a show's progress in a non-main profile from media_progress_v1, so desktop keeps it written.
    const kidShowProgress = opsFor(db, scopedMediaProgressKey(KID_SCOPE, show));
    expect(parseMediaProgressValue(String(kidShowProgress.at(-1)?.payload.value))?.progressPct).toBeCloseTo(12.5, 6);

    // The renderer reads resume points at their plain key: the snapshot shows the active profile's own.
    const kidSettings = db.getSnapshot().settings ?? {};
    log("kid snapshot resume keys", Object.keys(kidSettings).filter((key) => key.includes("episode_resume_v1")));
    expect(JSON.parse(kidSettings[`episode_resume_v1:${e2}`]!.value)).toMatchObject({ progressPct: 50 });
    expect(kidSettings[`episode_resume_v1:${e1}`]).toBeUndefined();

    db.setActiveProfile(MAIN);
    expect(progressOf(db, show).details).toBeCloseTo(25, 6);
    const mainSettings = db.getSnapshot().settings ?? {};
    expect(JSON.parse(mainSettings[`episode_resume_v1:${e1}`]!.value)).toMatchObject({ progressPct: 100 });
    expect(mainSettings[`episode_resume_v1:${e2}`]).toBeUndefined();
    db.close();
  });

  it("@req PLAY-TRACK-04[badger-desktop] @req ACCT-SQUAD-02[badger-desktop] the remembered track choice is per profile", async () => {
    const db = await openDevice("tracks");
    const movie = await seedMovie(db, 41_003);
    db.setActiveProfile(MAIN);
    await db.setTrackPrefs(movie, { audioLanguage: "fr" });
    db.setActiveProfile(KID);
    expect(db.getTrackPrefs(movie)).toBeNull();
    await db.setTrackPrefs(movie, { audioLanguage: "ja", subtitle: "off" });
    log("kid prefs", db.getTrackPrefs(movie));
    expect(db.getTrackPrefs(movie)).toMatchObject({ audioLanguage: "ja", subtitle: "off" });
    expect(opsFor(db, scopedTrackPrefsKey(KID_SCOPE, movie))).toHaveLength(1);
    expect(JSON.parse(db.getSnapshot().settings?.[`track_prefs_v1:${movie}`]?.value ?? "null")).toMatchObject({ audioLanguage: "ja" });
    db.setActiveProfile(MAIN);
    expect(db.getTrackPrefs(movie)?.audioLanguage).toBe("fr");
    db.close();
  });

  it("@req ACCT-SQUAD-02[badger-desktop] favorites and playlists are the active profile's own", async () => {
    const db = await openDevice("lists");
    const movie = await seedMovie(db, 41_004);
    db.setActiveProfile(MAIN);
    const mainFavorites = db.getSystemPlaylistId("favorites");
    expect(mainFavorites).not.toBeNull();
    await db.addToPlaylist(mainFavorites!, movie);

    db.setActiveProfile(KID);
    expect(db.getSystemPlaylistId("favorites")).toBe(FAVORITES_PLAYLIST_ID);
    const kidLists = db.getSnapshot();
    log("kid playlists before", { playlists: kidLists.playlists, items: kidLists.playlistItems });
    expect(kidLists.playlists.map((p) => p.slug).sort()).toEqual(["favorites", "watchlist"]);
    expect(db.listPlaylistItems(FAVORITES_PLAYLIST_ID)).toEqual([]);
    expect(db.getMediaDetails(movie)?.playlistIds).toEqual([]);

    await db.addToPlaylist(FAVORITES_PLAYLIST_ID, movie);
    await db.createPlaylist("Cartoons");
    const cartoons = db.listPlaylists().find((p) => p.name === "Cartoons");
    expect(cartoons).toBeDefined();
    await db.addToPlaylist(cartoons!.id, movie);
    log("kid after adds", { playlists: db.listPlaylists(), details: db.getMediaDetails(movie)?.playlistIds });
    expect(db.getMediaDetails(movie)?.playlistIds.sort()).toEqual([cartoons!.id, FAVORITES_PLAYLIST_ID].sort());
    expect(db.getSnapshot().playlistItems?.[FAVORITES_PLAYLIST_ID]).toEqual([movie]);
    const stored = parseProfilePlaylist(String(opsFor(db, scopedPlaylistKey(KID_SCOPE, FAVORITES_PLAYLIST_ID)).at(-1)?.payload.value));
    expect(stored?.items.map((item) => item.mediaId)).toEqual([movie]);

    await db.removeFromPlaylist(FAVORITES_PLAYLIST_ID, movie);
    await db.deletePlaylist(cartoons!.id);
    expect(db.getMediaDetails(movie)?.playlistIds).toEqual([]);
    expect(db.listPlaylists().some((p) => p.id === cartoons!.id)).toBe(false);

    db.setActiveProfile(MAIN);
    expect(db.listPlaylistItems(mainFavorites!)).toEqual([movie]);
    expect(db.listPlaylists().some((p) => p.name === "Cartoons")).toBe(false);
    db.close();
  });

  it("@req ACCT-SQUAD-02[badger-desktop] mobile ↔ runtime round trip at the same p:<pid>: keys", async () => {
    const desktop = await openDevice("roundtrip");
    const movie = await seedMovie(desktop, 41_005);
    const show = await seedShow(desktop, 41_006);
    const [e1, e2] = episodeIds(desktop, show);
    const at = "2026-10-29T10:00:00.000Z";

    // Mobile → desktop: the values the phone writes (shared helpers + its resume / track JSON), as synced ops.
    const mobileOps = [
      { key: scopedMediaProgressKey(KID_SCOPE, movie), value: buildMediaProgressValue({ progressPct: 64, lastWatchedAt: at, updatedAt: at }) },
      { key: scopedEpisodeResumeKey(KID_SCOPE, e1), value: JSON.stringify({ progressPct: 100, updatedAt: at, positionSeconds: 1500, durationSeconds: 1500 }) },
      {
        key: scopedTrackPrefsKey(KID_SCOPE, movie),
        value: serializeTrackPrefs({ audioLanguage: "de", subtitle: "off", updatedAt: at }),
      },
      {
        key: scopedPlaylistKey(KID_SCOPE, FAVORITES_PLAYLIST_ID),
        value: serializeProfilePlaylist({
          name: "Favorites",
          slug: "favorites",
          isSystem: true,
          items: [{ mediaId: show, addedAt: at }],
          createdAt: "",
          updatedAt: at,
        }),
      },
    ].map(({ key, value }, index) => ({
      id: `mobile-op-${index}`,
      type: "setting.set",
      createdAt: at,
      payload: { key, value, updatedAt: at },
    }));
    await internalsOf(desktop).applyLibraryOps(structuredClone(mobileOps));
    desktop.setActiveProfile(KID);
    const read = {
      movie: progressOf(desktop, movie),
      show: progressOf(desktop, show),
      tracks: desktop.getTrackPrefs(movie),
      favorites: desktop.listPlaylistItems(FAVORITES_PLAYLIST_ID),
      resume: desktop.getSnapshot().settings?.[`episode_resume_v1:${e1}`]?.value,
    };
    log("desktop reads mobile state", read);
    expect(read.movie).toEqual({ list: 64, details: 64 });
    expect(read.show.details).toBeCloseTo(25, 6);
    expect(read.tracks).toMatchObject({ audioLanguage: "de", subtitle: "off" });
    expect(read.favorites).toEqual([show]);
    expect(JSON.parse(String(read.resume))).toMatchObject({ positionSeconds: 1500 });

    // Desktop → mobile: what desktop queues lands at the keys mobile reads and parses with mobile's readers.
    internalsOf(desktop).pendingOps.length = 0;
    await desktop.setProgress(show, 40, e2, { positionSeconds: 480, durationSeconds: 1200 });
    await desktop.setProgress(movie, 90);
    await desktop.setTrackPrefs(show, { audioLanguage: "en" });
    await desktop.addToPlaylist(FAVORITES_PLAYLIST_ID, movie);
    const queued = internalsOf(desktop).pendingOps.map((op) => ({ type: op.type, key: op.payload.key }));
    log("desktop queued for mobile", queued);
    expect(queued.every((op) => op.type === "setting.set" && String(op.key).startsWith(KID_SCOPE.prefix))).toBe(true);
    const valueAt = (key: string) => String(opsFor(desktop, key).at(-1)?.payload.value);
    expect(JSON.parse(valueAt(scopedEpisodeResumeKey(KID_SCOPE, e2)))).toMatchObject({ progressPct: 40, positionSeconds: 480 });
    expect(parseMediaProgressValue(valueAt(scopedMediaProgressKey(KID_SCOPE, movie)))?.progressPct).toBe(90);
    expect(parseMediaProgressValue(valueAt(scopedMediaProgressKey(KID_SCOPE, show)))?.progressPct).toBeCloseTo(35, 6);
    expect(parseTrackPrefs(valueAt(scopedTrackPrefsKey(KID_SCOPE, show)))?.audioLanguage).toBe("en");
    expect(parseProfilePlaylist(valueAt(scopedPlaylistKey(KID_SCOPE, FAVORITES_PLAYLIST_ID)))?.items.map((i) => i.mediaId)).toEqual([
      show,
      movie,
    ]);
    desktop.close();
  });

  it("@req ACCT-PROF-02[badger-desktop] deleting a non-main profile blanks every one of its keys", async () => {
    const db = await openDevice("wipe");
    const movie = await seedMovie(db, 41_007);
    db.setActiveProfile(KID);
    await db.setProgress(movie, 20);
    await db.addToPlaylist(FAVORITES_PLAYLIST_ID, movie);
    db.setActiveProfile(MAIN);
    // The heal on library open finds a profile deleted on the website by the ids still holding data.
    expect(db.listViewingProfileIds()).toEqual([KID.id]);
    const wiped = await db.wipeProfileViewing(KID.id);
    log("wiped", { wiped, left: db.listViewingProfileIds() });
    expect(db.listViewingProfileIds()).toEqual([]);
    expect(wiped).toBe(2);
    expect(db.getSetting(scopedMediaProgressKey(KID_SCOPE, movie))?.value).toBe("");
    expect(db.getSetting(scopedPlaylistKey(KID_SCOPE, FAVORITES_PLAYLIST_ID))?.value).toBe("");
    expect(await db.wipeProfileViewing(KID.id)).toBe(0);
    db.close();
  });

  it("@req ACCT-PROF-02[badger-desktop] deleting the main profile moves the oldest remaining profile into the library's own storage", async () => {
    const db = await openDevice("promote");
    const movie = await seedMovie(db, 41_008);
    const show = await seedShow(db, 41_009);
    const [e1] = episodeIds(db, show);
    db.setActiveProfile(MAIN);
    await db.setProgress(movie, 80);
    await db.addToPlaylist(db.getSystemPlaylistId("favorites")!, movie);
    db.setActiveProfile(KID);
    await db.setProgress(show, 100, e1);
    await db.addToPlaylist(FAVORITES_PLAYLIST_ID, show);
    await db.setTrackPrefs(show, { audioLanguage: "it" });

    const plan = await db.promoteProfileToMain(KID.id);
    log("promotion plan", plan);
    db.setActiveProfile({ id: KID.id, isMain: true });
    const favorites = db.getSystemPlaylistId("favorites")!;
    const after = {
      movie: progressOf(db, movie),
      show: progressOf(db, show),
      favorites: db.listPlaylistItems(favorites),
      tracks: db.getTrackPrefs(show),
      marker: db.getSetting(MAIN_PROFILE_SETTING_KEY)?.value,
      kidKeysLeft: Object.entries(db.getSnapshot().settings ?? {}).filter(([key, entry]) => key.startsWith(KID_SCOPE.prefix) && entry.value !== ""),
    };
    log("after promotion", after);
    expect(after.movie).toEqual({ list: 0, details: 0 });
    expect(after.show.details).toBeCloseTo(25, 6);
    expect(after.favorites).toEqual([show]);
    expect(after.tracks?.audioLanguage).toBe("it");
    expect(after.marker).toBe(KID.id);
    expect(after.kidKeysLeft).toEqual([]);
    expect(await db.healMainPromotion(KID.id)).toBe(false);
    db.close();
  });

  /** Kids' viewing state (movie + episode progress, resume point, track choice, favorites, a custom playlist) before Chris is deleted. */
  const seedKidBeforeMainDelete = async (label: string) => {
    const db = await openDevice(label);
    const movie = await seedMovie(db, 41_020);
    const show = await seedShow(db, 41_021);
    const [, e2] = episodeIds(db, show);
    db.setActiveProfile(MAIN);
    await db.setProgress(movie, 80);
    db.setActiveProfile(KID);
    await db.setProgress(movie, 30);
    await db.setProgress(show, 50, e2, { positionSeconds: 600, durationSeconds: 1200 });
    await db.setTrackPrefs(show, { audioLanguage: "it" });
    await db.addToPlaylist(FAVORITES_PLAYLIST_ID, show);
    await db.createPlaylist("Cartoons");
    await db.addToPlaylist(db.listPlaylists().find((p) => p.name === "Cartoons")!.id, movie);
    db.setActiveProfile(MAIN);
    return { db, movie, show, e2: e2! };
  };

  type KidView = {
    movie: number | null;
    show: number | null;
    resume: number | null;
    tracks: string | null;
    playlists: { name: string; items: string[] }[];
  };

  /** What Kids sees once it is the main slot: the library's own storage, read without any prefix. */
  const kidViewAsMain = (db: LibraryDb, ids: { movie: string; show: string; e2: string }): KidView => {
    db.setActiveProfile({ id: KID.id, isMain: true });
    const snapshot = db.getSnapshot();
    const resume = snapshot.settings?.[`episode_resume_v1:${ids.e2}`]?.value;
    const view: KidView = {
      movie: progressOf(db, ids.movie).details,
      show: progressOf(db, ids.show).details,
      resume: resume ? JSON.parse(resume).positionSeconds : null,
      tracks: db.getTrackPrefs(ids.show)?.audioLanguage ?? null,
      playlists: snapshot.playlists
        .map((p) => ({ name: p.slug ?? p.name, items: [...(snapshot.playlistItems?.[p.id] ?? [])].sort() }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
    db.setActiveProfile(MAIN);
    return view;
  };

  const expectKidIntact = (view: KidView, ids: { movie: string; show: string }) => {
    expect(view.movie).toBe(30);
    expect(view.show).toBeCloseTo(12.5, 6);
    expect(view.resume).toBe(600);
    expect(view.tracks).toBe("it");
    expect(view.playlists).toEqual([
      { name: "Cartoons", items: [ids.movie] },
      { name: "favorites", items: [ids.show] },
      { name: "watchlist", items: [] },
    ]);
  };

  it("@req ACCT-PROF-02[badger-desktop] promoting the same profile twice keeps its progress, resume points, tracks and playlists", async () => {
    const { db, ...ids } = await seedKidBeforeMainDelete("promote-twice");
    const first = await db.promoteProfileToMain(KID.id);
    const afterFirst = kidViewAsMain(db, ids);
    log("after first promote", { plan: first, view: afterFirst });
    const second = await db.promoteProfileToMain(KID.id);
    const afterSecond = kidViewAsMain(db, ids);
    log("after second promote", { plan: second, view: afterSecond });
    expectKidIntact(afterFirst, ids);
    expectKidIntact(afterSecond, ids);
    expect(second.settings.length + second.progress.length + second.playlistDeletes.length + second.playlistCreates.length).toBe(0);
    db.close();
  });

  it("@req ACCT-PROF-02[badger-desktop] a heal that runs before the delete's own promote leaves the surviving profile whole", async () => {
    const { db, ...ids } = await seedKidBeforeMainDelete("heal-then-promote");
    // A window focus refreshes the list mid-delete: Kids is already main per the API, so heal moves it first.
    expect(await db.healMainPromotion(KID.id)).toBe(true);
    log("after heal", kidViewAsMain(db, ids));
    const late = await db.promoteProfileToMain(KID.id);
    const view = kidViewAsMain(db, ids);
    log("after the delete's promote", { plan: late, view });
    expectKidIntact(view, ids);
    db.close();
  });

  it("@req ACCT-SQUAD-02[badger-desktop] a non-main snapshot reads the profile's progress and playlists once, not once per title", async () => {
    const db = await openDevice("snapshot-reads");
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(await seedMovie(db, 41_030 + i));
    db.setActiveProfile(KID);
    await db.setProgress(ids[0]!, 40);
    await db.addToPlaylist(FAVORITES_PLAYLIST_ID, ids[1]!);
    const peek = db as unknown as Record<"readScopedMediaProgress" | "readScopedPlaylists", (...args: unknown[]) => unknown>;
    const calls = { progress: 0, playlists: 0 };
    for (const [name, counter] of [["readScopedMediaProgress", "progress"], ["readScopedPlaylists", "playlists"]] as const) {
      const original = peek[name]!.bind(db);
      peek[name] = (...args: unknown[]) => {
        calls[counter] += 1;
        return original(...args);
      };
    }
    const snapshot = db.getSnapshot();
    const details = Object.fromEntries(snapshot.mediaDetails!.map((d) => [d.id, { progress: d.progressPct, playlists: d.playlistIds }]));
    log("snapshot scoped reads", { titles: ids.length, calls, details });
    expect(details[ids[0]!]?.progress).toBe(40);
    expect(details[ids[1]!]?.playlists).toEqual([FAVORITES_PLAYLIST_ID]);
    // listMedia, listPlaylists and listPlaylistItemsMap read once each; the six details share one more read.
    expect(calls.progress).toBeLessThanOrEqual(2);
    expect(calls.playlists).toBeLessThanOrEqual(3);
    db.close();
  });

  it("@req ACCT-SQUAD-02[badger-desktop] deleting a title clears it from every non-main profile", async () => {
    const db = await openDevice("media-delete");
    const movie = await seedMovie(db, 41_010);
    const keep = await seedMovie(db, 41_011);
    db.setActiveProfile(KID);
    await db.setProgress(movie, 10);
    await db.setTrackPrefs(movie, { audioLanguage: "es" });
    await db.addToPlaylist(FAVORITES_PLAYLIST_ID, movie);
    await db.addToPlaylist(FAVORITES_PLAYLIST_ID, keep);
    db.setActiveProfile(MAIN);
    await db.deleteMedia(movie);
    const after = {
      progress: db.getSetting(scopedMediaProgressKey(KID_SCOPE, movie))?.value,
      tracks: db.getSetting(scopedTrackPrefsKey(KID_SCOPE, movie))?.value,
      favorites: parseProfilePlaylist(db.getSetting(scopedPlaylistKey(KID_SCOPE, FAVORITES_PLAYLIST_ID))?.value)?.items.map((i) => i.mediaId),
    };
    log("after media delete", after);
    expect(after).toEqual({ progress: "", tracks: "", favorites: [keep] });
    db.close();
  });
});
