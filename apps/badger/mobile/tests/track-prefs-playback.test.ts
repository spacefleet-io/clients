/**
 * @test-id MOBILE-TRACK-PREFS-PLAYBACK-001
 * @level unit
 *
 * PLAY-TRACK-04: the phone shares desktop's synced per-movie / per-SHOW audio + subtitle memory
 * (`track_prefs_v1:<mediaId>` in the synced `app_settings`):
 *  - read: a `setting.set` op written by another device lands in `app_settings` and becomes the play-start plan
 *    (audio language, subtitle language or Off), falling back to mpv's own defaults when the file lacks the track;
 *  - write: only a USER pick writes (a `setting.set` op keyed by the show id, never the episode id), as a
 *    read-modify-write so an audio pick keeps the remembered subtitle.
 *
 * Drives the REAL `LibraryDb` over the shared fixture (same tiny `app_settings` table as the resume-sync test).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as SharedApi from "@space/shared/api";
import {
  audioPickPatch,
  mergeTrackPrefs,
  parseTrackPrefs,
  serializeTrackPrefs,
  subtitlePickPatch,
  trackPrefsKey,
  type TrackPrefsPatch,
} from "@space/shared/trackPrefs";
import type { AudioTrack, MpvTrack, SubtitleTrack } from "@space/mobile-mpv-playback";
import { LibraryDb } from "../src/lib/libraryDb";
import {
  applyStartTracks,
  planStartTracks,
  rememberAudioPick,
  rememberSubtitlePick,
  resolveMpvAudioId,
  type StartTrackPlayer,
  type TrackPrefsSaver,
} from "../src/lib/playback/trackPrefs";
import { fx, resetFixture, seedSplitCache, setServer, settingOp, settle } from "./library-db-fixture";

const TAG = "[track-prefs-playback]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const trackStore = vi.hoisted(() => ({ settings: new Map<string, string>() }));

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
  const { settings } = trackStore;
  const rows = (list: Record<string, unknown>[]) => ({ length: list.length, item: (i: number) => list[i] });

  class SettingsDb extends fixture.FakeDb {
    async executeSql(sql: string, params: unknown[] = []) {
      const result = await super.executeSql(sql, params);
      if (/^\s*INSERT INTO app_settings/i.test(sql)) {
        settings.set(String(params[0]), String(params[1]));
        return [{ rows: rows([]), rowsAffected: 1 }];
      }
      if (/SELECT value FROM app_settings WHERE key = \?/i.test(sql)) {
        const value = settings.get(String(params[0]));
        return [{ rows: rows(value === undefined ? [] : [{ value }]) }];
      }
      return result;
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
const NOW = "2026-10-16T12:00:00.000Z";

type PendingOp = { id: string; type: string; payload: Record<string, unknown> };
type LibraryDbSeam = Pick<LibraryDb, keyof LibraryDb> & {
  pendingOps: PendingOp[];
  flushOps(): Promise<void>;
  secondaryOpsInFlight: Promise<void> | null;
};

const openLocal = async () => (await LibraryDb.open("token", "key")) as unknown as LibraryDbSeam;
const queuedTrackOps = (): PendingOp[] =>
  (JSON.parse(fx.files.get(PENDING_OPS) ?? "[]") as PendingOp[]).filter(
    (op) => op.type === "setting.set" && String(op.payload.key).startsWith("track_prefs_v1:")
  );

const audio = (id: string, language: string, isDefault = false): AudioTrack => ({
  id,
  language,
  label: language,
  isDefault,
  codec: "aac",
  codecString: "mp4a.40.2",
  initKey: `init-${id}`,
  initSize: 1,
  durationSeconds: 1,
  totalSize: 1,
  chunks: [],
});
const sub = (id: string, language: string, format: SubtitleTrack["format"] = "vtt"): SubtitleTrack => ({
  id,
  language,
  label: language,
  isDefault: false,
  format,
  encrypted: false,
  url: `subs/${id}`,
});

const audioTracks = [audio("a-en", "eng", true), audio("a-fr", "fre")];
const subtitleTracks = [sub("s-en", "eng"), sub("s-fr", "fre")];

beforeEach(() => {
  resetFixture();
  trackStore.settings.clear();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("a remembered choice becomes the play-start plan (PLAY-TRACK-04)", () => {
  // @req PLAY-TRACK-04[badger-mobile,badger-tv]
  it("French audio + a French subtitle track are selected over mpv's defaults", () => {
    const prefs = mergeTrackPrefs(mergeTrackPrefs(null, { audioLanguage: "fr" }, NOW), { subtitle: { language: "fr" } }, NOW);
    const plan = planStartTracks(prefs, audioTracks, subtitleTracks);
    log("plan fr+fr", plan);
    expect(plan).toEqual({ audioIdx: 1, subtitle: { mode: "track", idx: 1 } });
  });

  // @req PLAY-TRACK-04[badger-mobile,badger-tv]
  it("a remembered Off stays off", () => {
    const prefs = mergeTrackPrefs(null, { subtitle: "off" }, NOW);
    expect(planStartTracks(prefs, audioTracks, subtitleTracks).subtitle).toEqual({ mode: "off" });
  });

  // @req PLAY-TRACK-04[badger-mobile,badger-tv]
  it("no record, or a language this file lacks, leaves mpv's own defaults (nothing forced)", () => {
    expect(planStartTracks(null, audioTracks, subtitleTracks)).toEqual({ audioIdx: null, subtitle: { mode: "default" } });
    const prefs = mergeTrackPrefs(mergeTrackPrefs(null, { audioLanguage: "ja" }, NOW), { subtitle: { language: "ja" } }, NOW);
    const plan = planStartTracks(prefs, audioTracks, subtitleTracks);
    log("plan lacking ja", plan);
    expect(plan).toEqual({ audioIdx: null, subtitle: { mode: "default" } });
  });
});

// @bugfix default-subs-lang (Chris 2026-11-12, Coco): English subtitles picked in the player, then Settings
// "Subtitle language" set to French; the next play still started in English because the title's remembered choice
// always beat the profile's language. @regression-proof
describe("a subtitle language changed after the title's choice wins (PLAY-TRACK-11)", () => {
  const english = mergeTrackPrefs(null, { subtitle: { language: "en" } }, NOW);
  const LATER = "2026-10-16T12:05:00.000Z";
  const EARLIER = "2026-10-16T11:00:00.000Z";

  it("@req PLAY-TRACK-11[badger-mobile,badger-tv] English picked, then Settings set to French: French starts", () => {
    const plan = planStartTracks(english, audioTracks, subtitleTracks, { subtitleLanguage: "fr", subtitleSetAt: LATER });
    log("plan english-then-french-setting", plan);
    expect(plan.subtitle).toEqual({ mode: "track", idx: 1 });
  });

  it("@req PLAY-TRACK-11[badger-mobile,badger-tv] the title's choice wins when it is newer, the file lacks the language, or the time is unknown", () => {
    const older = planStartTracks(english, audioTracks, subtitleTracks, { subtitleLanguage: "fr", subtitleSetAt: EARLIER });
    const lacking = planStartTracks(english, audioTracks, [sub("s-en", "eng")], { subtitleLanguage: "fr", subtitleSetAt: LATER });
    const unknown = planStartTracks(english, audioTracks, subtitleTracks, { subtitleLanguage: "fr" });
    log("plan title-wins", { older, lacking, unknown });
    expect(older.subtitle).toEqual({ mode: "track", idx: 0 });
    expect(lacking.subtitle).toEqual({ mode: "track", idx: 0 });
    expect(unknown.subtitle).toEqual({ mode: "track", idx: 0 });
  });
});

describe("the plan is applied to the player once (PLAY-TRACK-04)", () => {
  const fakePlayer = () => {
    const calls: Array<{ call: string; args: unknown[] }> = [];
    const player: StartTrackPlayer = {
      getTrackList: async () =>
        [
          { id: 1, type: "audio", lang: "eng" },
          { id: 2, type: "audio", lang: "fre" },
        ] as MpvTrack[],
      setAudioTrack: async (...args) => void calls.push({ call: "setAudioTrack", args }),
      addSubtitle: async (...args) => void calls.push({ call: "addSubtitle", args }),
    };
    return { player, calls };
  };
  const PLAY_URL = "http://127.0.0.1:5000/playback/master.m3u8";

  // @req PLAY-TRACK-04[badger-mobile,badger-tv]
  it("remembered French audio + French subtitle: mpv switches to audio id 2 and loads the French sidecar", async () => {
    const prefs = mergeTrackPrefs(mergeTrackPrefs(null, { audioLanguage: "fr" }, NOW), { subtitle: { language: "fr" } }, NOW);
    const { player, calls } = fakePlayer();
    await applyStartTracks({ plan: planStartTracks(prefs, audioTracks, subtitleTracks), audioTracks, subtitleTracks, playUrl: PLAY_URL, directRender: false, player });
    log("player calls", calls);
    expect(calls).toEqual([
      { call: "setAudioTrack", args: [2] },
      { call: "addSubtitle", args: ["http://127.0.0.1:5000/playback/object/subs%2Fs-fr", "fre", "fre"] },
    ]);
  });

  // @req PLAY-TRACK-04[badger-mobile,badger-tv]
  it("no record, a remembered Off, or a language the file lacks: the player is left on mpv's defaults", async () => {
    const lacking = mergeTrackPrefs(mergeTrackPrefs(null, { audioLanguage: "ja" }, NOW), { subtitle: { language: "ja" } }, NOW);
    for (const prefs of [null, mergeTrackPrefs(null, { subtitle: "off" }, NOW), lacking]) {
      const { player, calls } = fakePlayer();
      await applyStartTracks({ plan: planStartTracks(prefs, audioTracks, subtitleTracks), audioTracks, subtitleTracks, playUrl: PLAY_URL, directRender: false, player });
      expect(calls).toEqual([]);
    }
  });
});

describe("picks become prefs patches (PLAY-TRACK-04)", () => {
  // @req PLAY-TRACK-04[badger-mobile,badger-tv]
  it("an audio pick is the track's language; a subtitle pick is language + format; Off is \"off\"", () => {
    expect(audioPickPatch(audioTracks[1]!)).toEqual({ audioLanguage: "fr" });
    expect(audioPickPatch(audio("a-und", "und"))).toBeNull();
    expect(subtitlePickPatch(subtitleTracks[1]!)).toEqual({ subtitle: { language: "fr", format: "vtt" } });
    expect(subtitlePickPatch(sub("s-x", "und"))).toBeNull();
    expect(subtitlePickPatch(null)).toEqual({ subtitle: "off" });
  });

  // @req PLAY-TRACK-04[badger-mobile,badger-tv]
  it("the mpv audio id matches by language across eng/en spellings, else by position", () => {
    const mpvTracks = [
      { id: 1, type: "audio", lang: "eng" },
      { id: 2, type: "audio", lang: "fra" },
      { id: 1, type: "video" },
    ] as MpvTrack[];
    expect(resolveMpvAudioId(mpvTracks, audioTracks, 1)).toBe(2);
    expect(resolveMpvAudioId([], audioTracks, 1)).toBe(2);
  });

  // @req PLAY-TRACK-04[badger-mobile,badger-tv]
  it("a second track in the same language (a commentary) picks mpv's second track in that language, not the first", () => {
    const withCommentary = [audio("a-en", "eng", true), audio("a-fr", "fre"), audio("a-en-comm", "eng")];
    const mpvTracks = [
      { id: 1, type: "audio", lang: "en" },
      { id: 2, type: "audio", lang: "fr" },
      { id: 3, type: "audio", lang: "en" },
    ] as MpvTrack[];
    expect(resolveMpvAudioId(mpvTracks, withCommentary, 0)).toBe(1);
    expect(resolveMpvAudioId(mpvTracks, withCommentary, 2)).toBe(3);
    expect(resolveMpvAudioId(mpvTracks, withCommentary, 1)).toBe(2);
  });
});

describe("track prefs sync through the library (PLAY-TRACK-04)", () => {
  // @req PLAY-TRACK-04[badger-mobile,badger-tv]
  // @req PLAY-TRACK-01[badger-mobile,badger-tv]
  it("a user pick queues a setting.set op keyed by the SHOW id, as a read-modify-write", async () => {
    setServer({ version: 10, snapshotVersion: 10 });
    seedSplitCache({ version: 10 });
    fx.nextPutVersion = 11;
    const db = await openLocal();
    try {
      expect(await db.getTrackPrefs("show-1"), "nothing remembered yet").toBeNull();
      await db.setTrackPrefs("show-1", { subtitle: { language: "fr", format: "vtt" } });
      await db.setTrackPrefs("show-1", { audioLanguage: "fr" });
      const queued = queuedTrackOps();
      log("queued", queued.map((op) => ({ key: op.payload.key, value: op.payload.value })));
      expect(queued, "the newest write supersedes the older queued one").toHaveLength(1);
      expect(queued[0]?.payload.key).toBe(trackPrefsKey("show-1"));
      expect(queued[0]?.payload.key).toBe("track_prefs_v1:show-1");
      const synced = parseTrackPrefs(String(queued[0]?.payload.value));
      expect(synced, "the audio pick kept the subtitle choice").toMatchObject({ audioLanguage: "fr", subtitle: { language: "fr", format: "vtt" } });
      expect(synced?.updatedAt, "value.updatedAt equals the op's updatedAt").toBe(queued[0]?.payload.updatedAt);

      expect(await db.getTrackPrefs("show-1")).toEqual(synced);
      expect(await db.getTrackPrefs("ep-1"), "never keyed by episode").toBeNull();

      await db.flushOps();
      expect(fx.putOpCalls, "uploaded so desktop receives it").toBeGreaterThan(0);
    } finally {
      await db.close();
    }
  });

  // @req PLAY-TRACK-04[badger-mobile,badger-tv]
  it("a record written by desktop arrives as a setting.set op and drives the start plan without being rewritten", async () => {
    const desktop = serializeTrackPrefs(
      mergeTrackPrefs(mergeTrackPrefs(null, { audioLanguage: "fr" }, "2026-10-15T10:00:00.000Z"), { subtitle: "off" }, "2026-10-15T10:00:00.000Z")
    );
    setServer({
      version: 12,
      snapshotVersion: 10,
      ops: [{ opId: "op-12", version: 12, op: settingOp("op-12", trackPrefsKey("show-1"), desktop) }],
    });
    seedSplitCache({ version: 10 });
    const db = await openLocal();
    try {
      expect(await db.getTrackPrefs("show-1")).toBeNull();
      expect(await db.syncFromRemoteIfNewer(fx.meta ?? undefined)).toBe(true);
      await settle(db);
      const prefs = await db.getTrackPrefs("show-1");
      const plan = planStartTracks(prefs, audioTracks, subtitleTracks);
      log("plan from desktop record", plan);
      expect(plan).toEqual({ audioIdx: 1, subtitle: { mode: "off" } });
      expect(queuedTrackOps(), "reading and applying the record never writes").toEqual([]);

      // The next episode lacks French: the plan falls back and the record stays untouched.
      const lacking = planStartTracks(prefs, [audio("a-en2", "eng", true)], []);
      expect(lacking).toEqual({ audioIdx: null, subtitle: { mode: "off" } });
      expect(queuedTrackOps()).toEqual([]);
      expect(await db.getTrackPrefs("show-1")).toEqual(prefs);
    } finally {
      await db.close();
    }
  });
});

describe("the Settings default audio language is the fallback of the start plan (PLAY-TRACK-01, PLAY-TRACK-04)", () => {
  const PLAY_URL = "http://127.0.0.1:5000/playback/master.m3u8";
  const fakePlayer = () => {
    const calls: Array<{ call: string; args: unknown[] }> = [];
    const player: StartTrackPlayer = {
      getTrackList: async () =>
        [
          { id: 1, type: "audio", lang: "eng" },
          { id: 2, type: "audio", lang: "fre" },
        ] as MpvTrack[],
      setAudioTrack: async (...args) => void calls.push({ call: "setAudioTrack", args }),
      addSubtitle: async (...args) => void calls.push({ call: "addSubtitle", args }),
    };
    return { player, calls };
  };
  // English is mpv's own default here, so French can only come from the Settings default.
  const frenchDefault = "fr";

  // @req PLAY-TRACK-01[badger-mobile,badger-tv]
  it("a title with no record starts in the default language when the file has it", () => {
    const plan = planStartTracks(null, audioTracks, subtitleTracks, { audioLanguage: frenchDefault });
    log("plan default fr, no record", plan);
    expect(plan).toEqual({ audioIdx: 1, subtitle: { mode: "default" } });
  });

  // @req PLAY-TRACK-01[badger-mobile,badger-tv]
  it("Original (no preference) or a language the file lacks forces nothing", () => {
    expect(planStartTracks(null, audioTracks, subtitleTracks, { audioLanguage: null })).toEqual({ audioIdx: null, subtitle: { mode: "default" } });
    const plan = planStartTracks(null, audioTracks, subtitleTracks, { audioLanguage: "ja" });
    log("plan default ja (file lacks it)", plan);
    expect(plan).toEqual({ audioIdx: null, subtitle: { mode: "default" } });
  });

  // @req PLAY-TRACK-04[badger-mobile,badger-tv]
  it("the title's remembered choice wins over the default; a remembered language the file lacks falls back to the default", () => {
    const english = mergeTrackPrefs(null, { audioLanguage: "en" }, NOW);
    expect(planStartTracks(english, audioTracks, subtitleTracks, { audioLanguage: frenchDefault }).audioIdx, "remembered English beats default French").toBe(0);
    const japanese = mergeTrackPrefs(null, { audioLanguage: "ja" }, NOW);
    const plan = planStartTracks(japanese, audioTracks, subtitleTracks, { audioLanguage: frenchDefault });
    log("plan remembered ja lacking, default fr", plan);
    expect(plan.audioIdx, "next episode lacks the remembered track: default language settings apply").toBe(1);
  });

  // @req PLAY-TRACK-04[badger-mobile,badger-tv]
  it("a remembered subtitle choice is kept next to a default-language audio start", () => {
    const off = mergeTrackPrefs(null, { subtitle: "off" }, NOW);
    expect(planStartTracks(off, audioTracks, subtitleTracks, { audioLanguage: frenchDefault })).toEqual({ audioIdx: 1, subtitle: { mode: "off" } });
  });

  // @req PLAY-TRACK-01[badger-mobile,badger-tv]
  it("the player is switched to the default-language audio at start, and left alone for Original", async () => {
    const withDefault = fakePlayer();
    await applyStartTracks({
      plan: planStartTracks(null, audioTracks, subtitleTracks, { audioLanguage: frenchDefault }),
      audioTracks,
      subtitleTracks,
      playUrl: PLAY_URL,
      directRender: false,
      player: withDefault.player,
    });
    log("player calls (default fr)", withDefault.calls);
    expect(withDefault.calls).toEqual([{ call: "setAudioTrack", args: [2] }]);

    const original = fakePlayer();
    await applyStartTracks({
      plan: planStartTracks(null, audioTracks, subtitleTracks, { audioLanguage: null }),
      audioTracks,
      subtitleTracks,
      playUrl: PLAY_URL,
      directRender: false,
      player: original.player,
    });
    expect(original.calls).toEqual([]);
  });
});

describe("the profile's Subtitle language is the subtitle fallback of the start plan (ACCT-SQUAD-03, PLAY-TRACK-04)", () => {
  const PLAY_URL = "http://127.0.0.1:5000/playback/master.m3u8";

  // @req ACCT-SQUAD-03[badger-mobile,badger-tv]
  it("a title with no subtitle record starts with the profile's subtitle language when the file has it", () => {
    const plan = planStartTracks(null, audioTracks, subtitleTracks, { subtitleLanguage: "fr" });
    log("plan subtitle default fr, no record", plan);
    expect(plan).toEqual({ audioIdx: null, subtitle: { mode: "track", idx: 1 } });
  });

  // @req ACCT-SQUAD-03[badger-mobile,badger-tv]
  it("no preference, or a language the file lacks, leaves subtitles at the file's default (off)", () => {
    const none = planStartTracks(null, audioTracks, subtitleTracks, { subtitleLanguage: null });
    const lacking = planStartTracks(null, audioTracks, subtitleTracks, { subtitleLanguage: "ja" });
    log("plans subtitle default none / ja", { none, lacking });
    expect(none).toEqual({ audioIdx: null, subtitle: { mode: "default" } });
    expect(lacking).toEqual({ audioIdx: null, subtitle: { mode: "default" } });
  });

  // @req ACCT-SQUAD-03[badger-mobile,badger-tv] @req PLAY-TRACK-04[badger-mobile,badger-tv]
  it("the title's remembered subtitle choice (a track or Off) wins over the profile's subtitle language", () => {
    const english = mergeTrackPrefs(null, { subtitle: { language: "en" } }, NOW);
    const off = mergeTrackPrefs(null, { subtitle: "off" }, NOW);
    const audioOnly = mergeTrackPrefs(null, { audioLanguage: "en" }, NOW);
    const plans = {
      english: planStartTracks(english, audioTracks, subtitleTracks, { subtitleLanguage: "fr" }),
      off: planStartTracks(off, audioTracks, subtitleTracks, { subtitleLanguage: "fr" }),
      audioOnly: planStartTracks(audioOnly, audioTracks, subtitleTracks, { audioLanguage: "fr", subtitleLanguage: "fr" }),
    };
    log("plans remembered vs profile fr", plans);
    expect(plans.english.subtitle).toEqual({ mode: "track", idx: 0 });
    expect(plans.off.subtitle).toEqual({ mode: "off" });
    expect(plans.audioOnly, "a remembered audio choice only: audio stays English, subtitles take the profile's French").toEqual({
      audioIdx: 0,
      subtitle: { mode: "track", idx: 1 },
    });
  });

  // @req ACCT-SQUAD-03[badger-mobile,badger-tv]
  it("the player loads the profile-language subtitle at start", async () => {
    const calls: Array<{ call: string; args: unknown[] }> = [];
    const player: StartTrackPlayer = {
      getTrackList: async () => [] as MpvTrack[],
      setAudioTrack: async (...args) => void calls.push({ call: "setAudioTrack", args }),
      addSubtitle: async (...args) => void calls.push({ call: "addSubtitle", args }),
    };
    await applyStartTracks({
      plan: planStartTracks(null, audioTracks, subtitleTracks, { subtitleLanguage: "fr" }),
      audioTracks,
      subtitleTracks,
      playUrl: PLAY_URL,
      directRender: false,
      player,
    });
    log("player calls (subtitle default fr)", calls);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ call: "addSubtitle", args: [expect.stringContaining("s-fr"), "fre", "fre"] });
  });
});

describe("the player's picker callbacks remember picks per media (PLAY-TRACK-04)", () => {
  const fakeSaver = () => {
    const saved: Array<{ mediaId: string; patch: TrackPrefsPatch }> = [];
    const save: TrackPrefsSaver = async (mediaId, patch) => void saved.push({ mediaId, patch });
    return { save, saved };
  };

  // @req PLAY-TRACK-04[badger-mobile,badger-tv]
  it("an audio pick saves the track's language for the media; a track without a language saves nothing", async () => {
    const { save, saved } = fakeSaver();
    await rememberAudioPick(save, "show-1", audioTracks[0]!);
    await rememberAudioPick(save, "show-1", audio("a-und", "und"));
    log("saved audio picks", saved);
    expect(saved).toEqual([{ mediaId: "show-1", patch: { audioLanguage: "en" } }]);
  });

  // @req PLAY-TRACK-04[badger-mobile,badger-tv]
  it("a subtitle pick saves language + format, Off saves \"off\", an unusable track saves nothing", async () => {
    const { save, saved } = fakeSaver();
    await rememberSubtitlePick(save, "movie-1", subtitleTracks[1]!);
    await rememberSubtitlePick(save, "movie-1", null);
    await rememberSubtitlePick(save, "movie-1", sub("s-x", "und"));
    log("saved subtitle picks", saved);
    expect(saved).toEqual([
      { mediaId: "movie-1", patch: { subtitle: { language: "fr", format: "vtt" } } },
      { mediaId: "movie-1", patch: { subtitle: "off" } },
    ]);
  });

  // @req PLAY-TRACK-04[badger-mobile,badger-tv]
  it("a failed write is logged and never thrown into the player", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const save: TrackPrefsSaver = async () => {
      throw new Error("disk full");
    };
    await expect(rememberAudioPick(save, "show-1", audioTracks[1]!)).resolves.toBeUndefined();
    await expect(rememberSubtitlePick(save, "show-1", null)).resolves.toBeUndefined();
    log("warnings", warn.mock.calls);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0]?.[0])).toBe("playback.tracks.save_failed");
  });

  // @req PLAY-TRACK-04[badger-mobile,badger-tv]
  it("picking English while the default is French overwrites that media's default audio, which then beats the Settings default", async () => {
    setServer({ version: 10, snapshotVersion: 10 });
    seedSplitCache({ version: 10 });
    fx.nextPutVersion = 11;
    const db = await openLocal();
    try {
      const save: TrackPrefsSaver = (mediaId, patch) => db.setTrackPrefs(mediaId, patch);
      expect(planStartTracks(await db.getTrackPrefs("show-1"), audioTracks, subtitleTracks, { audioLanguage: "fr" }).audioIdx, "Settings default French").toBe(1);
      await rememberAudioPick(save, "show-1", audioTracks[0]!);
      const prefs = await db.getTrackPrefs("show-1");
      log("record after English pick", prefs);
      expect(prefs).toMatchObject({ audioLanguage: "en" });
      expect(planStartTracks(prefs, audioTracks, subtitleTracks, { audioLanguage: "fr" }).audioIdx, "that show now starts in English").toBe(0);
      expect(planStartTracks(await db.getTrackPrefs("other-show"), audioTracks, subtitleTracks, { audioLanguage: "fr" }).audioIdx, "another show still uses the default").toBe(1);
    } finally {
      await db.close();
    }
  });
});

describe("picture subtitles on the TV's direct rendering start on their OCR twin (PLAY-TRACK-05)", () => {
  const PLAY_URL = "http://127.0.0.1:5000/playback/master.m3u8";
  const picture = (id: string, language: string, format: "pgs" | "vobsub"): SubtitleTrack => ({
    ...sub(id, language, format),
    ocrTwin: { id: `${id}-ocr`, url: `subs/${id}.ocr.srt` },
  });
  const pictureTracks = [sub("s-en", "eng"), picture("p-fr", "fre", "pgs"), picture("v-de", "ger", "vobsub")];
  const recorder = () => {
    const calls: Array<{ call: string; args: unknown[] }> = [];
    const player: StartTrackPlayer = {
      getTrackList: async () => [] as MpvTrack[],
      setAudioTrack: async (...args) => void calls.push({ call: "setAudioTrack", args }),
      addSubtitle: async (...args) => void calls.push({ call: "addSubtitle", args }),
    };
    return { player, calls };
  };

  // @req PLAY-TRACK-05
  it("a remembered PGS / VobSub choice loads the twin's SRT under direct rendering, the picture elsewhere", async () => {
    for (const [language, format, id] of [["fr", "pgs", "p-fr"], ["de", "vobsub", "v-de"]] as const) {
      const prefs = mergeTrackPrefs(null, { subtitle: { language, format } }, NOW);
      const plan = planStartTracks(prefs, audioTracks, pictureTracks);
      log(`phase: plan for remembered ${language}/${format}`, plan);
      expect(plan.subtitle).toEqual({ mode: "track", idx: pictureTracks.findIndex((t) => t.id === id) });

      const tv = recorder();
      await applyStartTracks({ plan, audioTracks, subtitleTracks: pictureTracks, playUrl: PLAY_URL, directRender: true, player: tv.player });
      const phone = recorder();
      await applyStartTracks({ plan, audioTracks, subtitleTracks: pictureTracks, playUrl: PLAY_URL, directRender: false, player: phone.player });
      log("player calls (tv direct render, phone)", { tv: tv.calls, phone: phone.calls });
      expect(tv.calls).toEqual([
        { call: "addSubtitle", args: [`http://127.0.0.1:5000/playback/object/subs%2F${id}.ocr.srt`, language === "fr" ? "fre" : "ger", language === "fr" ? "fre" : "ger"] },
      ]);
      expect(phone.calls).toEqual([
        { call: "addSubtitle", args: [`http://127.0.0.1:5000/playback/object/subs%2F${id}`, language === "fr" ? "fre" : "ger", language === "fr" ? "fre" : "ger"] },
      ]);
    }
  });

  // @req PLAY-TRACK-05
  it("a picture track without a twin keeps loading the picture, and text tracks never change", async () => {
    const noTwin = [sub("p-fr", "fre", "pgs"), sub("s-en", "eng")];
    for (const [language, idx] of [["fr", 0], ["en", 1]] as const) {
      const tv = recorder();
      await applyStartTracks({
        plan: { audioIdx: null, subtitle: { mode: "track", idx } },
        audioTracks,
        subtitleTracks: noTwin,
        playUrl: PLAY_URL,
        directRender: true,
        player: tv.player,
      });
      log(`player calls (no twin, ${language})`, tv.calls);
      expect(tv.calls).toEqual([{ call: "addSubtitle", args: [`http://127.0.0.1:5000/playback/object/subs%2F${noTwin[idx]!.id}`, noTwin[idx]!.language, noTwin[idx]!.language] }]);
    }
  });

  // @req PLAY-TRACK-05
  it("under direct rendering a remembered picture track without a twin is never started; elsewhere it is", () => {
    const tracks = [sub("p-ja", "jpn", "pgs"), sub("s-ja", "jpn"), sub("s-en", "eng")];
    const prefs = mergeTrackPrefs(null, { subtitle: { language: "ja", format: "pgs" } }, NOW);
    const tv = planStartTracks(prefs, audioTracks, tracks, { audioLanguage: null }, true);
    const phone = planStartTracks(prefs, audioTracks, tracks, { audioLanguage: null }, false);
    log("plans (no twin, tv vs phone)", { tv, phone });
    expect(tv.subtitle, "falls to the Japanese text track").toEqual({ mode: "track", idx: 1 });
    expect(phone.subtitle).toEqual({ mode: "track", idx: 0 });
    const only = planStartTracks(prefs, audioTracks, [tracks[0]!], { audioLanguage: null }, true);
    log("plan (no twin, nothing else)", only);
    expect(only.subtitle.mode).not.toBe("track");
  });

  // @req PLAY-TRACK-05
  it("picking a picture track remembers the picture's format, never the twin's", async () => {
    const patch = subtitlePickPatch(pictureTracks[1]!);
    log("pick patch", patch);
    expect(patch).toEqual({ subtitle: { language: "fr", format: "pgs" } });
    expect(subtitlePickPatch(pictureTracks[2]!)).toEqual({ subtitle: { language: "de", format: "vobsub" } });
  });
});
