/**
 * @test-id MOBILE-LIBRARY-PROFILE-SCOPE-001
 * @level unit
 *
 * ACCT-SQUAD-02 through the REAL `LibraryDb`: each profile has its own resume points, progress and track choices.
 * The main profile writes the library's own keys (`episode_resume_v1:`, `media_items.progress_pct`); after switching
 * to another profile the same calls write `p:<profileId>:` keys (synced as `setting.set` ops) and never touch the main
 * profile's row; switching back finds each profile's own resume point untouched.
 *
 * Same fixture as library-episode-resume-sync.test.ts, with a tiny `app_settings` table behind the fake SQLite.
 *
 * @req ACCT-SQUAD-02[badger-mobile,badger-tv]
 * @req ACCT-SQUAD-03[badger-mobile,badger-tv]
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as SharedApi from "@space/shared/api";
import { LibraryDb } from "../src/lib/libraryDb";
import { setViewingScope } from "../src/lib/profiles/activeViewingScope";
import { MAIN_VIEWING_SCOPE, viewingScopeFor } from "@space/shared/profileViewing";
import { fx, resetFixture, seedSplitCache, setServer, settingOp, settle } from "./library-db-fixture";

const TAG = "[library-profile-scope]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const scopeStore = vi.hoisted(() => ({ settings: new Map<string, string>(), mediaUpdates: [] as unknown[][] }));

// vi.mock factories are hoisted above the static imports, so they load the fixture with `await import()`.
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("react-native-fs", async () => ({ default: (await import("./library-db-fixture")).fakeRnfs }));
vi.mock("react-native-sqlite-storage", () => ({ default: { enablePromise: () => undefined } }));
vi.mock("react-native-quick-crypto", async () => (await import("./library-db-fixture")).quickCryptoMock());
vi.mock("@space/shared/api", async (importOriginal) =>
  (await import("./library-db-fixture")).sharedApiMock(await importOriginal<typeof SharedApi>())
);
vi.mock("../src/lib/library/transport", async () => (await import("./library-db-fixture")).transportMock());
vi.mock("../src/lib/library/dbFiles", async () => {
  const fixture = await import("./library-db-fixture");
  const base = fixture.dbFilesMock();
  const { settings, mediaUpdates } = scopeStore;
  const rows = (list: Record<string, unknown>[]) => ({ length: list.length, item: (i: number) => list[i] });

  class SettingsDb extends fixture.FakeDb {
    async executeSql(sql: string, params: unknown[] = []) {
      const base = await super.executeSql(sql, params);
      if (/^\s*INSERT INTO app_settings/i.test(sql)) {
        settings.set(String(params[0]), String(params[1]));
        return [{ rows: rows([]), rowsAffected: 1 }];
      }
      if (/SELECT key, value FROM app_settings WHERE key LIKE/i.test(sql)) {
        const prefix = String(params[0]).replace(/%$/, "");
        return [{ rows: rows([...settings].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value }))) }];
      }
      if (/SELECT key, value FROM app_settings WHERE key IN/i.test(sql)) {
        return [{ rows: rows(params.map(String).filter((key) => settings.has(key)).map((key) => ({ key, value: settings.get(key) }))) }];
      }
      if (/SELECT value(, updated_at)? FROM app_settings WHERE key = \?/i.test(sql)) {
        const value = settings.get(String(params[0]));
        // This store keeps no times; a JSON value carries its own.
        return [{ rows: rows(value === undefined ? [] : [{ value, updated_at: null }]) }];
      }
      if (/UPDATE media_items SET progress_pct/i.test(sql)) mediaUpdates.push(params);
      if (/SELECT id FROM media_episodes WHERE media_id/i.test(sql)) {
        return [{ rows: rows(["ep-1", "ep-2"].map((id) => ({ id }))) }];
      }
      if (/SELECT id, season_number, air_date FROM media_episodes/i.test(sql)) {
        return [{ rows: rows(["ep-1", "ep-2"].map((id) => ({ id, season_number: 1, air_date: null }))) }];
      }
      if (/SELECT type FROM media_items/i.test(sql)) return [{ rows: rows([{ type: "tv" }]) }];
      if (/SELECT total_episodes FROM media_items/i.test(sql)) return [{ rows: rows([{ total_episodes: null }]) }];
      return base;
    }

    async sqlBatch(statements: Array<[string, unknown[]]>) {
      await super.sqlBatch(statements);
      for (const [sql, params] of statements) {
        if (/INSERT (OR REPLACE )?INTO app_settings/i.test(sql)) settings.set(String(params[0]), String(params[1]));
      }
    }
  }

  const open = async (name: string) => {
    fx.nativeOpen.set(name, true);
    const handle = new SettingsDb(name);
    fx.handles.push(handle);
    return handle;
  };
  return {
    ...base,
    openCoreDb: () => open("library.core.sqlite"),
    openMetadataDb: () => open("library.metadata.sqlite"),
  };
});
vi.mock("../src/lib/library/snapshot", async () => (await import("./library-db-fixture")).snapshotMock());
vi.mock("../src/lib/crypto", async () => (await import("./library-db-fixture")).cryptoMock());
vi.mock("../src/lib/librarySchema", () => ({}));

const PENDING_OPS = "/docs/library/pending_ops.json";
const queuedKeys = (): string[] =>
  (JSON.parse(fx.files.get(PENDING_OPS) ?? "[]") as Array<{ type: string; payload: Record<string, unknown> }>)
    .filter((op) => op.type === "setting.set")
    .map((op) => String(op.payload.key));

const KIDS = viewingScopeFor({ id: "kids", isMain: false });

beforeEach(() => {
  resetFixture();
  scopeStore.settings.clear();
  scopeStore.mediaUpdates.length = 0;
  setViewingScope(MAIN_VIEWING_SCOPE);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  setServer({ version: 10, snapshotVersion: 10 });
  seedSplitCache({ version: 10 });
});

describe("per-profile viewing state in the library (ACCT-SQUAD-02)", () => {
  it("@req ACCT-SQUAD-02 each profile resumes at its own spot; the other profile's is untouched", async () => {
    const db = await LibraryDb.open("token", "key");
    try {
      log("phase=main-writes");
      await db.setPlaybackProgress("show-1", "ep-1", 40, { positionSeconds: 900, durationSeconds: 2250 });
      expect(scopeStore.mediaUpdates, "the main profile writes the library's own progress row").toHaveLength(1);
      expect((await db.getEpisodeResumeMap("show-1"))["ep-1"]).toMatchObject({ positionSeconds: 900 });

      log("phase=switch-to-kids");
      setViewingScope(KIDS);
      expect(await db.getEpisodeResumeMap("show-1"), "a new profile has watched nothing").toEqual({});
      await db.setPlaybackProgress("show-1", "ep-1", 10, { positionSeconds: 225, durationSeconds: 2250 });
      const kidsMap = await db.getEpisodeResumeMap("show-1");
      log("kids map", kidsMap);
      expect(kidsMap["ep-1"]).toMatchObject({ positionSeconds: 225, progressPct: 10 });
      expect(scopeStore.mediaUpdates, "another profile never writes the main profile's row").toHaveLength(1);
      expect(scopeStore.settings.get("p:kids:media_progress_v1:show-1")).toContain('"progressPct":5');
      log("queued keys", queuedKeys());
      expect(queuedKeys()).toEqual(
        expect.arrayContaining(["episode_resume_v1:ep-1", "p:kids:episode_resume_v1:ep-1", "p:kids:media_progress_v1:show-1"])
      );

      log("phase=switch-back-to-main");
      setViewingScope(MAIN_VIEWING_SCOPE);
      expect((await db.getEpisodeResumeMap("show-1"))["ep-1"]).toMatchObject({ positionSeconds: 900, progressPct: 40 });
      setViewingScope(KIDS);
      expect((await db.getEpisodeResumeMap("show-1"))["ep-1"]).toMatchObject({ positionSeconds: 225 });
    } finally {
      await db.close();
    }
  });

  it("@req ACCT-SQUAD-02 audio and subtitle choices are kept per profile", async () => {
    const db = await LibraryDb.open("token", "key");
    try {
      await db.setTrackPrefs("movie-1", { audioLanguage: "en" });
      setViewingScope(KIDS);
      expect(await db.getTrackPrefs("movie-1"), "the other profile has no choice yet").toBeNull();
      await db.setTrackPrefs("movie-1", { audioLanguage: "fr" });
      const kids = await db.getTrackPrefs("movie-1");
      setViewingScope(MAIN_VIEWING_SCOPE);
      const main = await db.getTrackPrefs("movie-1");
      log("track prefs", { main, kids, keys: [...scopeStore.settings.keys()] });
      expect(main?.audioLanguage).toBe("en");
      expect(kids?.audioLanguage).toBe("fr");
      expect(scopeStore.settings.has("track_prefs_v1:movie-1")).toBe(true);
      expect(scopeStore.settings.has("p:kids:track_prefs_v1:movie-1")).toBe(true);
    } finally {
      await db.close();
    }
  });
});

describe("per-profile settings in the library (ACCT-SQUAD-03)", () => {
  it("@req ACCT-SQUAD-03 each profile keeps its own playback settings; a write is a synced setting.set op", async () => {
    const db = await LibraryDb.open("token", "key");
    try {
      log("phase=main-writes");
      expect(await db.getProfileSettings(), "nothing stored yet").toBeNull();
      await db.setProfileSettings({ quality: "2160p", autoSkipIntro: false });
      await db.setProfileSettings({ audioLanguage: "en" });

      log("phase=kids-writes");
      expect(await db.getProfileSettings(KIDS), "the other profile has no settings yet").toBeNull();
      await db.setProfileSettings({ quality: "480p", audioLanguage: "fr" }, KIDS);

      const main = await db.getProfileSettings(MAIN_VIEWING_SCOPE);
      const kids = await db.getProfileSettings(KIDS);
      log("settings", { main, kids, queued: queuedKeys() });
      expect(main).toMatchObject({ quality: "2160p", autoSkipIntro: false, audioLanguage: "en" });
      expect(kids).toMatchObject({ quality: "480p", audioLanguage: "fr" });
      expect(kids?.autoSkipIntro, "a write in one profile never changes another's").toBeUndefined();
      expect(scopeStore.settings.has("profile_settings_v1")).toBe(true);
      expect(scopeStore.settings.has("p:kids:profile_settings_v1")).toBe(true);
      expect(queuedKeys()).toEqual(expect.arrayContaining(["profile_settings_v1", "p:kids:profile_settings_v1"]));

      log("phase=active-scope");
      setViewingScope(KIDS);
      expect((await db.getProfileSettings())?.quality, "the default scope is the active profile").toBe("480p");
    } finally {
      await db.close();
    }
  });

  it("@req ACCT-SQUAD-03 @req UX-I18N-07 settings another device saved for the profile arrive with the library sync; an old per-profile language is dropped", async () => {
    const fromDesktop = JSON.stringify({ quality: "720p", forceQuality: true, uiLanguage: "de", updatedAt: "2026-10-30T10:00:00.000Z" });
    setServer({
      version: 12,
      snapshotVersion: 10,
      ops: [{ opId: "op-12", version: 12, op: settingOp("op-12", "p:kids:profile_settings_v1", fromDesktop) }],
    });
    seedSplitCache({ version: 10 });
    const db = await LibraryDb.open("token", "key");
    try {
      const changed = await db.syncFromRemoteIfNewer(fx.meta ?? undefined);
      await settle(db);
      const kids = await db.getProfileSettings(KIDS);
      log("after sync", { changed, kids });
      expect(kids).toMatchObject({ quality: "720p", forceQuality: true });
      expect(kids, "the app language is the account's, not the profile's").not.toHaveProperty("uiLanguage");
      expect(await db.getProfileSettings(MAIN_VIEWING_SCOPE), "the main profile is untouched").toBeNull();
    } finally {
      await db.close();
    }
  });
});

/**
 * @test-id LIB-LANG-02-MOBILE-001
 * @level unit
 * Why: the phone and TV keep a title's per-language texts in the library (LIB-LANG-02) so later pages read them
 * instead of asking the metadata service again. The row is library-wide (never a profile's `p:` key) and syncs.
 */
describe("kept per-language texts in the library (LIB-LANG-02)", () => {
  it("@req LIB-LANG-02 a written row reads back and is a synced setting.set op, in any profile", async () => {
    const db = await LibraryDb.open("token", "key");
    try {
      log("phase=empty");
      expect(await db.readSetting("localized_text_v1:tv:100:fr")).toBeNull();
      log("phase=write-in-kids");
      setViewingScope(KIDS);
      await db.writeSetting("localized_text_v1:tv:100:fr", '{"v":1}');
      log("phase=read", { keys: [...scopeStore.settings.keys()], queued: queuedKeys() });
      expect(await db.readSetting("localized_text_v1:tv:100:fr")).toBe('{"v":1}');
      expect(scopeStore.settings.has("p:kids:localized_text_v1:tv:100:fr"), "never a profile's key").toBe(false);
      expect(queuedKeys()).toContain("localized_text_v1:tv:100:fr");
    } finally {
      await db.close();
    }
  });
});
