/**
 * @test-id MOBILE-PROFILE-VIEWING-001
 * @level unit
 *
 * The pure half of per-profile viewing state (ACCT-SQUAD-02, ACCT-PROF-02): the main profile keeps the library's own
 * storage, every other profile keeps the same state under `p:<profileId>:` keys; a profile that never touched a title
 * sees it unstarted; a deleted profile's keys are blanked; deleting the main profile moves the oldest remaining
 * profile's state into the library's own storage and clears the deleted one's.
 *
 * @req ACCT-SQUAD-02[badger-mobile]
 * @req ACCT-PROF-02[badger-mobile]
 * @req LIB-OPS-02[badger-mobile]
 */
import { describe, expect, it } from "vitest";
import {
  FAVORITES_PLAYLIST_ID,
  MAIN_VIEWING_SCOPE,
  WATCHLIST_PLAYLIST_ID,
  addProfilePlaylistItem,
  buildMediaProgressValue,
  collectMediaProgress,
  listProfilePlaylists,
  overlayProfileProgress,
  parseMediaProgressValue,
  parseProfilePlaylist,
  planMainPromotion,
  planMediaDeleteProfileCleanup,
  planProfileWipe,
  removeProfilePlaylistItem,
  scopedEpisodeResumeKey,
  scopedMediaProgressKey,
  scopedPlaylistKey,
  scopedTrackPrefsKey,
  serializeProfilePlaylist,
  viewingScopeFor,
  MAIN_PROFILE_SETTING_KEY,
  needsMainPromotion,
} from "@space/shared/profileViewing";

const TAG = "[profile-viewing]";
const log = (phase: string, data?: unknown) => console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const KIDS = viewingScopeFor({ id: "kids", isMain: false });
const T1 = "2026-10-22T10:00:00.000Z";
const T2 = "2026-10-22T11:00:00.000Z";

describe("keys (ACCT-SQUAD-02)", () => {
  it("@req ACCT-SQUAD-02 the main profile keeps today's keys, so existing viewing state is the first profile's with no migration", () => {
    const main = viewingScopeFor({ id: "chris", isMain: true });
    log("scopes", { main, kids: KIDS, none: MAIN_VIEWING_SCOPE });
    expect(main.prefix).toBe("");
    expect(viewingScopeFor(null)).toEqual(MAIN_VIEWING_SCOPE);
    expect(scopedEpisodeResumeKey(main, "e1")).toBe("episode_resume_v1:e1");
    expect(scopedTrackPrefsKey(main, "m1")).toBe("track_prefs_v1:m1");
  });

  it("@req ACCT-SQUAD-02 another profile keeps the same state under p:<id>: keys", () => {
    expect(scopedEpisodeResumeKey(KIDS, "e1")).toBe("p:kids:episode_resume_v1:e1");
    expect(scopedTrackPrefsKey(KIDS, "m1")).toBe("p:kids:track_prefs_v1:m1");
    expect(scopedMediaProgressKey(KIDS, "m1")).toBe("p:kids:media_progress_v1:m1");
    expect(scopedPlaylistKey(KIDS, FAVORITES_PLAYLIST_ID)).toBe("p:kids:playlist_v1:favorites");
  });
});

describe("progress (ACCT-SQUAD-02)", () => {
  it("@req ACCT-SQUAD-02 progress values round-trip and junk reads as absent", () => {
    const value = buildMediaProgressValue({ progressPct: 42.123456, lastWatchedAt: T1, updatedAt: T1 });
    log("value", value);
    expect(parseMediaProgressValue(value)).toEqual({ progressPct: 42.1235, lastWatchedAt: T1, updatedAt: T1 });
    for (const junk of ["", null, undefined, "{", "[]", "42", JSON.stringify({ progressPct: "x" })]) {
      expect(parseMediaProgressValue(junk as string | null | undefined)).toBeNull();
    }
  });

  it("@req ACCT-SQUAD-02 a profile sees only its own progress: titles it never started read 0 and never watched", () => {
    const rows = [
      { id: "m1", progressPct: 80, lastWatchedAt: T1, title: "Main watched this" },
      { id: "m2", progressPct: 0, lastWatchedAt: null, title: "Kids watched this" },
    ];
    const settings = [
      { key: "p:kids:media_progress_v1:m2", value: buildMediaProgressValue({ progressPct: 30, lastWatchedAt: T2, updatedAt: T2 }) },
      { key: "p:other:media_progress_v1:m1", value: buildMediaProgressValue({ progressPct: 99, lastWatchedAt: T2, updatedAt: T2 }) },
      { key: "p:kids:media_progress_v1:m3", value: "" },
    ];
    const overlaid = overlayProfileProgress(rows, collectMediaProgress(KIDS, settings));
    log("overlaid", overlaid);
    expect(overlaid).toEqual([
      { id: "m1", progressPct: 0, lastWatchedAt: null, title: "Main watched this" },
      { id: "m2", progressPct: 30, lastWatchedAt: T2, title: "Kids watched this" },
    ]);
    // The library rows themselves are untouched (the main profile's view).
    expect(rows[0]?.progressPct).toBe(80);
  });
});

describe("playlists of a non-main profile (ACCT-SQUAD-02)", () => {
  it("@req ACCT-SQUAD-02 favorites and watchlist exist before the profile ever wrote one", () => {
    const list = listProfilePlaylists(KIDS, []);
    log("defaults", list);
    expect(list.map((p) => [p.id, p.slug, p.isSystem])).toEqual([
      [FAVORITES_PLAYLIST_ID, "favorites", true],
      [WATCHLIST_PLAYLIST_ID, "watchlist", false],
    ]);
  });

  it("@req ACCT-SQUAD-02 add, remove and delete playlists; a blanked playlist is gone", () => {
    const fav = parseProfilePlaylist(
      serializeProfilePlaylist({ name: "Favorites", slug: "favorites", isSystem: true, items: [], createdAt: "", updatedAt: T1 }),
    )!;
    const added = addProfilePlaylistItem(addProfilePlaylistItem(fav, "m1", T1), "m1", T2);
    expect(added.items).toEqual([{ mediaId: "m1", addedAt: T1 }]);
    const removed = removeProfilePlaylistItem(added, "m1", T2);
    expect(removed.items).toEqual([]);
    const rows = [
      { key: "p:kids:playlist_v1:favorites", value: serializeProfilePlaylist(added) },
      { key: "p:kids:playlist_v1:watchlist", value: "" },
      { key: "p:kids:playlist_v1:road", value: serializeProfilePlaylist({ ...fav, name: "Road trip", slug: null, isSystem: false, createdAt: T2 }) },
      { key: "p:other:playlist_v1:x", value: serializeProfilePlaylist(fav) },
    ];
    const list = listProfilePlaylists(KIDS, rows);
    log("list", list);
    expect(list.map((p) => p.id)).toEqual(["favorites", "road"]);
    expect(list[0]?.items.map((i) => i.mediaId)).toEqual(["m1"]);
  });
});

describe("deleting a profile (ACCT-PROF-02)", () => {
  it("@req ACCT-PROF-02 a deleted profile's keys are all blanked, nobody else's", () => {
    const rows = [
      { key: "p:kids:episode_resume_v1:e1", value: "{}" },
      { key: "p:kids:media_progress_v1:m1", value: "{}" },
      { key: "p:kids:playlist_v1:favorites", value: "{}" },
      { key: "p:kids:track_prefs_v1:m1", value: "" },
      { key: "p:kidsx:episode_resume_v1:e1", value: "{}" },
      { key: "episode_resume_v1:e1", value: "{}" },
    ];
    const keys = planProfileWipe("kids", rows);
    log("wipe", keys);
    expect(keys).toEqual(["p:kids:episode_resume_v1:e1", "p:kids:media_progress_v1:m1", "p:kids:playlist_v1:favorites"]);
  });

  it("@req ACCT-PROF-02 deleting the main profile moves the oldest remaining profile's state into the library's own storage", () => {
    const kidsResume = JSON.stringify({ progressPct: 40, updatedAt: T2, positionSeconds: 600 });
    const kidsPrefs = JSON.stringify({ audioLanguage: "fr", subtitle: null, updatedAt: T2 });
    const plan = planMainPromotion({
      newMainId: "kids",
      settingRows: [
        // The deleted main profile's own state.
        { key: "episode_resume_v1:e1", value: JSON.stringify({ progressPct: 90, updatedAt: T1 }) },
        { key: "episode_resume_v1:e9", value: JSON.stringify({ progressPct: 10, updatedAt: T1 }) },
        { key: "track_prefs_v1:m1", value: JSON.stringify({ audioLanguage: "en", subtitle: null, updatedAt: T1 }) },
        { key: "client_config_v1", value: "{}" },
        // The new main profile's state.
        { key: "p:kids:episode_resume_v1:e1", value: kidsResume },
        { key: "p:kids:track_prefs_v1:m1", value: kidsPrefs },
        { key: "p:kids:media_progress_v1:show1", value: buildMediaProgressValue({ progressPct: 20, lastWatchedAt: T2, updatedAt: T2 }) },
        {
          key: "p:kids:playlist_v1:favorites",
          value: serializeProfilePlaylist({ name: "Favorites", slug: "favorites", isSystem: true, items: [{ mediaId: "m7", addedAt: T2 }], createdAt: "", updatedAt: T2 }),
        },
        {
          key: "p:kids:playlist_v1:cartoons",
          value: serializeProfilePlaylist({ name: "Cartoons", slug: null, isSystem: false, items: [{ mediaId: "m8", addedAt: T2 }], createdAt: T2, updatedAt: T2 }),
        },
        // A third profile stays as it is.
        { key: "p:guest:episode_resume_v1:e1", value: kidsResume },
      ],
      mainProgress: [
        { mediaId: "movie1", progressPct: 100, lastWatchedAt: T1 },
        { mediaId: "show1", progressPct: 50, lastWatchedAt: T1 },
      ],
      mainPlaylists: [
        { id: "fav-row", slug: "favorites", isSystem: true, mediaIds: ["m1", "m2"] },
        { id: "watch-row", slug: "watchlist", isSystem: false, mediaIds: [] },
        { id: "mine", slug: null, isSystem: false, mediaIds: ["m3"] },
      ],
    });
    log("plan", plan);
    const settings = Object.fromEntries(plan.settings.map(({ key, value }) => [key, value]));
    expect(settings).toEqual({
      "episode_resume_v1:e1": kidsResume,
      "episode_resume_v1:e9": "",
      "track_prefs_v1:m1": kidsPrefs,
    });
    // Written after everything else, so a move cut short still finds the new main's state and reruns whole.
    expect(plan.finish).toEqual([
      { key: "p:kids:episode_resume_v1:e1", value: "" },
      { key: "p:kids:track_prefs_v1:m1", value: "" },
      { key: "p:kids:media_progress_v1:show1", value: "" },
      { key: "p:kids:playlist_v1:favorites", value: "" },
      { key: "p:kids:playlist_v1:cartoons", value: "" },
      { key: MAIN_PROFILE_SETTING_KEY, value: "kids" },
    ]);
    expect(Object.fromEntries(plan.progress.map((p) => [p.mediaId, [p.progressPct, p.lastWatchedAt]]))).toEqual({
      movie1: [0, null],
      show1: [20, T2],
    });
    expect(plan.playlistDeletes).toEqual(["mine"]);
    expect(plan.playlistItemRemoves).toEqual([
      { playlistId: "fav-row", mediaId: "m1" },
      { playlistId: "fav-row", mediaId: "m2" },
    ]);
    expect(plan.playlistItemAdds).toEqual([{ playlistId: "fav-row", mediaId: "m7" }]);
    expect(plan.playlistCreates).toEqual([{ key: "cartoons", name: "Cartoons", slug: null, isSystem: false, mediaIds: ["m8"] }]);
  });

  it("@req ACCT-PROF-02 @bugfix a main profile whose move never finished is moved again; a finished or never-needed one is left alone", () => {
    const leftovers = [
      { key: "episode_resume_v1:e1", value: "{\"deleted\":true}" },
      { key: "p:kids:episode_resume_v1:e1", value: "{\"kids\":true}" },
      { key: "p:kids:playlist_v1:old", value: "" },
    ];
    const cases = [
      { name: "move never ran (no marker)", mainId: "kids", rows: leftovers, expected: true },
      { name: "move never ran (older main marked)", mainId: "kids", rows: [...leftovers, { key: MAIN_PROFILE_SETTING_KEY, value: "ada" }], expected: true },
      { name: "move finished, a stale device wrote later", mainId: "kids", rows: [...leftovers, { key: MAIN_PROFILE_SETTING_KEY, value: "kids" }], expected: false },
      { name: "only blanked keys left", mainId: "kids", rows: [{ key: "p:kids:playlist_v1:old", value: "" }], expected: false },
      { name: "original main, never had p: keys", mainId: "ada", rows: leftovers, expected: false },
      { name: "another profile's keys", mainId: "kid", rows: leftovers, expected: false },
    ];
    for (const c of cases) {
      const got = needsMainPromotion(c.mainId, c.rows);
      log("heal", { case: c.name, got });
      expect(got, c.name).toBe(c.expected);
    }
  });
});

describe("deleting a media (LIB-OPS-02, ACCT-SQUAD-02)", () => {
  it("@req LIB-OPS-02 every profile's progress, resume points, track choices and playlist entries of the media are cleared, nothing else", () => {
    const fav = serializeProfilePlaylist({
      name: "Favorites",
      slug: "favorites",
      isSystem: true,
      items: [
        { mediaId: "m1", addedAt: T1 },
        { mediaId: "m2", addedAt: T1 },
      ],
      createdAt: "",
      updatedAt: T1,
    });
    const onlyOther = serializeProfilePlaylist({ name: "Road", slug: null, isSystem: false, items: [{ mediaId: "m2", addedAt: T1 }], createdAt: T1, updatedAt: T1 });
    const rows = [
      { key: "p:kids:media_progress_v1:m1", value: "{}" },
      { key: "p:kids:track_prefs_v1:m1", value: "{}" },
      { key: "p:kids:episode_resume_v1:e1", value: "{}" },
      { key: "p:kids:episode_resume_v1:e9", value: "{}" }, // another title's episode
      { key: "p:kids:playlist_v1:favorites", value: fav },
      { key: "p:kids:playlist_v1:road", value: onlyOther },
      { key: "p:teen:media_progress_v1:m1", value: "{}" },
      { key: "p:teen:media_progress_v1:m10", value: "{}" }, // a media id that only starts like the deleted one
      { key: "p:teen:track_prefs_v1:m1", value: "" }, // already blank
      { key: "p:kids:media_progress_v1:m2", value: "{}" },
      { key: "media_progress_v1:m1", value: "{}" }, // not a profile key
    ];
    const writes = planMediaDeleteProfileCleanup({ mediaId: "m1", episodeIds: ["e1", "e2"], rows, now: T2 });
    log("media delete cleanup", writes);
    expect(writes.filter((w) => w.value === "").map((w) => w.key)).toEqual([
      "p:kids:media_progress_v1:m1",
      "p:kids:track_prefs_v1:m1",
      "p:kids:episode_resume_v1:e1",
      "p:teen:media_progress_v1:m1",
    ]);
    const playlistWrites = writes.filter((w) => w.value !== "");
    expect(playlistWrites.map((w) => w.key)).toEqual(["p:kids:playlist_v1:favorites"]);
    const after = parseProfilePlaylist(playlistWrites[0]?.value);
    expect(after?.items).toEqual([{ mediaId: "m2", addedAt: T1 }]);
    expect(after?.updatedAt).toBe(T2);
  });
});
