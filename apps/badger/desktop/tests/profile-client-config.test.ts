import { describe, expect, it } from "vitest";
import { PROFILE_SETTINGS_SEED_AT, mergeProfileSettingsOps, parseProfileSettings } from "@space/shared/profileSettings";
import type { DeviceCapacityValues } from "../src/shared/deviceCapacity";
import { coerceLanguageChoice, defaultClientConfig, type ClientConfig } from "../src/renderer/src/lib/config";
import {
  CLIENT_CONFIG_SETTING_KEY,
  loadComposedClientConfig,
  persistComposedClientConfig,
  type ClientConfigSettingsStore,
  type DeviceCapacityStore,
} from "../src/renderer/src/lib/profileClientConfig";

/**
 * The library's `app_settings` as the renderer bridge sees it: raw keys, string values, and the row time the runtime
 * stores (now, unless the caller passes one). `receive` is a remote `setting.set` arriving: profile settings ops are
 * folded with the local row like the runtime's `applyLibraryOps`, then the newer-or-equal row time wins.
 */
const memoryStore = (initial: Record<string, string> = {}) => {
  const rows = new Map(Object.entries(initial));
  const times = new Map<string, string>([...rows.keys()].map((key) => [key, "2026-01-01T00:00:00.000Z"]));
  const store: ClientConfigSettingsStore = {
    getSetting: async (key) => (rows.has(key) ? { value: rows.get(key)!, updatedAt: times.get(key)! } : null),
    setSetting: async (key, value, updatedAt) => {
      rows.set(key, value);
      times.set(key, updatedAt ?? new Date().toISOString());
    },
  };
  const receive = (key: string, value: string, updatedAt: string) => {
    const local = new Map([[key, rows.has(key) ? { value: rows.get(key)!, updatedAt: times.get(key)! } : null]]);
    const [op] = mergeProfileSettingsOps(
      [{ id: "remote", type: "setting.set", createdAt: updatedAt, payload: { key, value, updatedAt } }],
      local,
    );
    if (op?.type !== "setting.set") throw new Error("expected a setting.set op");
    if (times.has(key) && op.payload.updatedAt < times.get(key)!) return;
    rows.set(key, op.payload.value);
    times.set(key, op.payload.updatedAt);
  };
  return { rows, times, store, receive };
};

const MAIN = { id: "a", isMain: true };
const OTHER = { id: "b", isMain: false };

const accountBlob = JSON.stringify({
  ...defaultClientConfig,
  playbackQuality: "720p",
  forcePlaybackQuality: false,
  autoplayNextEpisode: false,
  introSkipEnabled: true,
  creditsSkipEnabled: true,
  skipMode: "auto",
  uiLanguage: "fr",
  maxParallelTranscodes: 2,
  enableCodecSelection: true,
});

const profileFields = (config: ClientConfig) => ({
  playbackQuality: config.playbackQuality,
  forcePlaybackQuality: config.forcePlaybackQuality,
  autoplayNextEpisode: config.autoplayNextEpisode,
  introSkipEnabled: config.introSkipEnabled,
  creditsSkipEnabled: config.creditsSkipEnabled,
  skipMode: config.skipMode,
});

describe("desktop playback settings per profile", () => {
  // @req ACCT-SQUAD-03
  it("keeps each profile's quality, skips and autoplay apart, seeded from the account value", async () => {
    const { rows, store } = memoryStore({ [CLIENT_CONFIG_SETTING_KEY]: accountBlob });

    // Profile A (main) opens: no stored settings yet, so it starts from the account-wide values.
    const a0 = await loadComposedClientConfig({ db: store, profile: MAIN, local: defaultClientConfig });
    expect(profileFields(a0)).toMatchObject({ playbackQuality: "720p", autoplayNextEpisode: false });
    // The app language is the account's (UX-I18N-07): neither the library's blob nor a profile changes the shown one.
    expect(a0.uiLanguage).toBe(defaultClientConfig.uiLanguage);
    expect(rows.has("profile_settings_v1")).toBe(true);

    const aEdited: ClientConfig = {
      ...a0,
      playbackQuality: "2160p",
      forcePlaybackQuality: true,
      autoplayNextEpisode: true,
      introSkipEnabled: false,
      creditsSkipEnabled: false,
      skipMode: "manual",
      uiLanguage: "en",
    };
    await persistComposedClientConfig({ db: store, profile: MAIN, config: aEdited });
    const aStored = rows.get("profile_settings_v1");

    // Switch to B: its own values, seeded from the account value, not from A's edits.
    const b0 = await loadComposedClientConfig({ db: store, profile: OTHER, local: aEdited });
    expect(profileFields(b0)).toEqual({
      playbackQuality: "720p",
      forcePlaybackQuality: false,
      autoplayNextEpisode: false,
      introSkipEnabled: true,
      creditsSkipEnabled: true,
      skipMode: "auto",
    });
    expect(rows.has("p:b:profile_settings_v1")).toBe(true);
    // Switching profile keeps the language this computer shows.
    expect(b0.uiLanguage).toBe("en");

    // A change in B leaves A alone; an account setting changed in B is shared.
    await persistComposedClientConfig({
      db: store,
      profile: OTHER,
      config: { ...b0, playbackQuality: "480p", introSkipEnabled: false, trailerLanguages: { ...b0.trailerLanguages, extras: ["de"] } },
    });
    expect(rows.get("profile_settings_v1")).toBe(aStored);
    expect(JSON.parse(rows.get(CLIENT_CONFIG_SETTING_KEY)!)).toMatchObject({ playbackQuality: "720p" });

    // Reopen (fresh renderer state): each profile gets its own values back.
    const aReopened = await loadComposedClientConfig({ db: store, profile: MAIN, local: defaultClientConfig });
    expect(profileFields(aReopened)).toEqual(profileFields(aEdited));
    expect(aReopened.trailerLanguages.extras).toEqual(["de"]);
    const bReopened = await loadComposedClientConfig({ db: store, profile: OTHER, local: defaultClientConfig });
    expect(profileFields(bReopened)).toMatchObject({ playbackQuality: "480p", introSkipEnabled: false });
  });

  // @req ACCT-SQUAD-03
  it("keeps a field the phone wrote into the profile's settings when desktop saves", async () => {
    const { rows, store } = memoryStore({
      [CLIENT_CONFIG_SETTING_KEY]: accountBlob,
      "p:b:profile_settings_v1": JSON.stringify({ audioLanguage: "ja", quality: "1080p", updatedAt: "2026-10-30T00:00:00.000Z" }),
    });
    const b0 = await loadComposedClientConfig({ db: store, profile: OTHER, local: defaultClientConfig });
    expect(b0.playbackQuality).toBe("1080p");
    expect(b0.uiLanguage).toBe(defaultClientConfig.uiLanguage);
    await persistComposedClientConfig({ db: store, profile: OTHER, config: { ...b0, autoplayNextEpisode: true } });
    expect(JSON.parse(rows.get("p:b:profile_settings_v1")!)).toMatchObject({
      audioLanguage: "ja",
      quality: "1080p",
      autoplayNextEpisode: true,
    });
  });

  // @req PLAY-TRACK-01[badger-desktop] @req ACCT-SQUAD-03
  it("the default audio language is the profile's `audioLanguage`, shared with phone and TV", async () => {
    const T = "[profile-client-config:audio-language]";
    const { rows, store } = memoryStore({
      [CLIENT_CONFIG_SETTING_KEY]: accountBlob,
      // Picked on the phone for profile B.
      "p:b:profile_settings_v1": JSON.stringify({ audioLanguage: "ja", updatedAt: "2026-10-30T00:00:00.000Z" }),
    });
    const b0 = await loadComposedClientConfig({ db: store, profile: OTHER, local: defaultClientConfig });
    console.info(`${T} phase=load-b defaultAudioLanguage=${JSON.stringify(b0.defaultAudioLanguage)}`);
    expect(b0.defaultAudioLanguage).toBe("ja");

    // A profile with no value yet starts from Original (the account value), not from B's.
    const a0 = await loadComposedClientConfig({ db: store, profile: MAIN, local: b0 });
    console.info(`${T} phase=load-a defaultAudioLanguage=${JSON.stringify(a0.defaultAudioLanguage)} row=${rows.get("profile_settings_v1")}`);
    expect(a0.defaultAudioLanguage).toBeNull();

    // Desktop picks French for B: saved in B's row under the shared name; Original saves null.
    await persistComposedClientConfig({ db: store, profile: OTHER, previous: b0, config: { ...b0, defaultAudioLanguage: "fr" } });
    const savedFr = parseProfileSettings(rows.get("p:b:profile_settings_v1"));
    console.info(`${T} phase=save-fr row=${JSON.stringify(savedFr)}`);
    expect(savedFr?.audioLanguage).toBe("fr");
    const b1 = await loadComposedClientConfig({ db: store, profile: OTHER, local: defaultClientConfig });
    await persistComposedClientConfig({ db: store, profile: OTHER, previous: b1, config: { ...b1, defaultAudioLanguage: null } });
    const savedOriginal = parseProfileSettings(rows.get("p:b:profile_settings_v1"));
    console.info(`${T} phase=save-original row=${JSON.stringify(savedOriginal)}`);
    expect(savedOriginal?.audioLanguage).toBeNull();
    // The account blob never carries a profile's choice.
    expect(JSON.parse(rows.get(CLIENT_CONFIG_SETTING_KEY)!).defaultAudioLanguage ?? null).toBeNull();
  });

  // @req PLAY-TRACK-01[badger-desktop]
  it("a stored default audio language outside the offered choices reads as Original", async () => {
    const { store } = memoryStore({
      [CLIENT_CONFIG_SETTING_KEY]: accountBlob,
      "p:b:profile_settings_v1": JSON.stringify({ audioLanguage: "xx", updatedAt: "2026-10-30T00:00:00.000Z" }),
    });
    const b0 = await loadComposedClientConfig({ db: store, profile: OTHER, local: defaultClientConfig });
    console.info(`[profile-client-config:audio-language] phase=unknown-code value=${JSON.stringify(b0.defaultAudioLanguage)}`);
    expect(b0.defaultAudioLanguage).toBeNull();
    expect(coerceLanguageChoice("fre")).toBe("fr");
    expect(coerceLanguageChoice("klingon")).toBeNull();
  });

  // @req ACCT-SQUAD-03[badger-desktop] @req ACCT-SQUAD-02[badger-desktop]
  it("each profile keeps its own subtitle language, shared with phone and TV as `subtitleLanguage`, and a switch restores it", async () => {
    const T = "[profile-client-config:subtitle-language]";
    const { rows, store } = memoryStore({ [CLIENT_CONFIG_SETTING_KEY]: accountBlob });

    // A picks English subtitles.
    const a0 = await loadComposedClientConfig({ db: store, profile: MAIN, local: defaultClientConfig });
    console.info(`${T} phase=load-a value=${JSON.stringify(a0.defaultSubtitleLanguage)}`);
    expect(a0.defaultSubtitleLanguage).toBeNull();
    await persistComposedClientConfig({ db: store, profile: MAIN, previous: a0, config: { ...a0, defaultSubtitleLanguage: "en" } });
    console.info(`${T} phase=save-a row=${rows.get("profile_settings_v1")}`);
    expect(parseProfileSettings(rows.get("profile_settings_v1"))?.subtitleLanguage).toBe("en");

    // B switches in with A's view on screen: B has no preference of its own, never A's.
    const a1 = await loadComposedClientConfig({ db: store, profile: MAIN, local: defaultClientConfig });
    const b0 = await loadComposedClientConfig({ db: store, profile: OTHER, local: a1 });
    console.info(`${T} phase=load-b value=${JSON.stringify(b0.defaultSubtitleLanguage)} row=${rows.get("p:b:profile_settings_v1")}`);
    expect(b0.defaultSubtitleLanguage).toBeNull();
    await persistComposedClientConfig({ db: store, profile: OTHER, previous: b0, config: { ...b0, defaultSubtitleLanguage: "fr" } });
    expect(parseProfileSettings(rows.get("p:b:profile_settings_v1"))?.subtitleLanguage).toBe("fr");

    // Back on A: A's English, untouched by B's French; the account blob carries neither.
    const a2 = await loadComposedClientConfig({ db: store, profile: MAIN, local: b0 });
    console.info(`${T} phase=back-to-a value=${JSON.stringify(a2.defaultSubtitleLanguage)}`);
    expect(a2.defaultSubtitleLanguage).toBe("en");
    expect(JSON.parse(rows.get(CLIENT_CONFIG_SETTING_KEY)!).defaultSubtitleLanguage ?? null).toBeNull();

    // A value picked on the phone for B shows on desktop.
    const { store: phoneStore } = memoryStore({
      [CLIENT_CONFIG_SETTING_KEY]: accountBlob,
      "p:b:profile_settings_v1": JSON.stringify({ subtitleLanguage: "ja", updatedAt: "2026-11-11T00:00:00.000Z" }),
    });
    const fromPhone = await loadComposedClientConfig({ db: phoneStore, profile: OTHER, local: defaultClientConfig });
    console.info(`${T} phase=from-phone value=${JSON.stringify(fromPhone.defaultSubtitleLanguage)}`);
    expect(fromPhone.defaultSubtitleLanguage).toBe("ja");
  });

  // @req ACCT-PROF-03[badger-desktop]
  it("each profile keeps its own title option, shared with phone and TV, and a profile that never answered reads as App language and is never seeded", async () => {
    const T = "[profile-client-config:title-language]";
    const { rows, store } = memoryStore({
      [CLIENT_CONFIG_SETTING_KEY]: accountBlob,
      // Answered on the phone for profile B.
      "p:b:profile_settings_v1": JSON.stringify({ titleLanguage: "original", updatedAt: "2026-11-17T00:00:00.000Z" }),
    });
    const b0 = await loadComposedClientConfig({ db: store, profile: OTHER, local: defaultClientConfig });
    console.info(`${T} phase=load-b titleLanguage=${b0.titleLanguage}`);
    expect(b0.titleLanguage).toBe("original");

    // A switches in with B's view still on screen: A never answered, so it is unanswered (shown as "app") and not seeded.
    const a0 = await loadComposedClientConfig({ db: store, profile: MAIN, local: b0 });
    console.info(`${T} phase=load-a titleLanguage=${a0.titleLanguage} row=${rows.get("profile_settings_v1")}`);
    expect(a0.titleLanguage).toBeNull();
    expect(parseProfileSettings(rows.get("profile_settings_v1"))?.titleLanguage, "never seeded").toBeUndefined();

    // Desktop answers for A: saved in A's row under the shared name, never in B's or the account's.
    await persistComposedClientConfig({ db: store, profile: MAIN, previous: a0, config: { ...a0, titleLanguage: "original" } });
    expect(parseProfileSettings(rows.get("profile_settings_v1"))?.titleLanguage).toBe("original");
    await persistComposedClientConfig({ db: store, profile: OTHER, previous: b0, config: { ...b0, titleLanguage: "app" } });
    console.info(`${T} phase=saved a=${rows.get("profile_settings_v1")} b=${rows.get("p:b:profile_settings_v1")}`);
    expect(parseProfileSettings(rows.get("p:b:profile_settings_v1"))?.titleLanguage).toBe("app");
    expect(parseProfileSettings(rows.get("profile_settings_v1"))?.titleLanguage, "B's change leaves A's choice").toBe("original");
    expect(JSON.parse(rows.get(CLIENT_CONFIG_SETTING_KEY)!).titleLanguage ?? null).toBeNull();
  });

  // @req ACCT-PROF-03[badger-desktop]
  it("keeping the preselected 'App language everywhere' is saved in the profile (UX-SETUP-09), even when this computer's config still shows 'app'", async () => {
    const T = "[profile-client-config:title-keep-default]";
    const { rows, store } = memoryStore({ [CLIENT_CONFIG_SETTING_KEY]: accountBlob });
    // This computer's config answered "app" for an earlier profile; the new profile never answered.
    const stale: ClientConfig = { ...defaultClientConfig, titleLanguage: "app" };
    const shown = await loadComposedClientConfig({ db: store, profile: OTHER, local: stale });
    console.info(`${T} phase=load titleLanguage=${shown.titleLanguage} row=${rows.get("p:b:profile_settings_v1")}`);
    expect(shown.titleLanguage, "an unanswered profile reads null, never this computer's value").toBeNull();

    // The gate's Finish with the preselected answer: `{ ...loadClientConfig(), titleLanguage: "app" }`.
    await persistComposedClientConfig({ db: store, profile: OTHER, previous: shown, config: { ...shown, titleLanguage: "app" } });
    console.info(`${T} phase=answered row=${rows.get("p:b:profile_settings_v1")}`);
    expect(parseProfileSettings(rows.get("p:b:profile_settings_v1"))?.titleLanguage, "the kept default reaches the profile").toBe("app");
  });

  // @req ACCT-SQUAD-03
  it("leaves the profile fields and the app language alone while no profile is picked", async () => {
    const { store } = memoryStore({ [CLIENT_CONFIG_SETTING_KEY]: accountBlob });
    const local: ClientConfig = { ...defaultClientConfig, uiLanguage: "en", playbackQuality: "2160p" };
    const composed = await loadComposedClientConfig({ db: store, profile: null, local });
    expect(composed.uiLanguage).toBe("en");
    expect(composed.playbackQuality).toBe("2160p");
    expect(composed.enableCodecSelection).toBe(true);
  });

  // @req ACCT-SQUAD-03
  it("@bugfix @regression-proof a seed never beats the profile's real settings that arrive later, even older ones", async () => {
    const { rows, times, store, receive } = memoryStore({ [CLIENT_CONFIG_SETTING_KEY]: accountBlob });

    // This computer opens profile B before its record from another device has synced: B is seeded from the account.
    const seededView = await loadComposedClientConfig({ db: store, profile: OTHER, local: defaultClientConfig });
    expect(seededView.playbackQuality).toBe("720p");
    const seed = parseProfileSettings(rows.get("p:b:profile_settings_v1"));
    expect(seed?.updatedAt).toBe(PROFILE_SETTINGS_SEED_AT);
    expect(seed?.fieldUpdatedAt?.quality).toBe(PROFILE_SETTINGS_SEED_AT);
    expect(times.get("p:b:profile_settings_v1")).toBe(PROFILE_SETTINGS_SEED_AT);

    // B's real record, written on the phone last week, arrives now.
    const lastWeek = "2026-10-23T10:00:00.000Z";
    receive(
      "p:b:profile_settings_v1",
      JSON.stringify({ quality: "1080p", autoplayNextEpisode: true, updatedAt: lastWeek }),
      lastWeek,
    );
    const real = await loadComposedClientConfig({ db: store, profile: OTHER, local: seededView });
    expect(real.playbackQuality).toBe("1080p");
    expect(real.autoplayNextEpisode).toBe(true);
    // A field the real record never had keeps the seed.
    expect(real.introSkipEnabled).toBe(true);
  });

  // @req ACCT-SQUAD-03
  it("@bugfix @regression-proof saving one setting stamps only that field, so other devices' edits to the rest survive", async () => {
    const earlier = "2026-10-29T08:00:00.000Z";
    const { rows, store, receive } = memoryStore({
      [CLIENT_CONFIG_SETTING_KEY]: accountBlob,
      "p:b:profile_settings_v1": JSON.stringify({
        quality: "720p",
        forceQuality: false,
        autoplayNextEpisode: false,
        autoSkipIntro: true,
        autoSkipCredits: true,
        skipMode: "auto",
        updatedAt: earlier,
      }),
    });
    const before = await loadComposedClientConfig({ db: store, profile: OTHER, local: defaultClientConfig });
    // Another device turns autoplay on; this computer has not shown it yet and changes only the quality.
    const phoneEdit = "2026-10-30T07:00:00.000Z";
    receive(
      "p:b:profile_settings_v1",
      JSON.stringify({ autoplayNextEpisode: true, fieldUpdatedAt: { autoplayNextEpisode: phoneEdit }, updatedAt: phoneEdit }),
      phoneEdit,
    );
    await persistComposedClientConfig({
      db: store,
      profile: OTHER,
      previous: before,
      config: { ...before, playbackQuality: "2160p" },
    });
    const saved = parseProfileSettings(rows.get("p:b:profile_settings_v1"));
    expect(saved?.quality).toBe("2160p");
    expect(saved?.fieldUpdatedAt?.quality).not.toBe(earlier);
    expect(saved?.autoplayNextEpisode).toBe(true);
    expect(saved?.fieldUpdatedAt?.autoplayNextEpisode).toBe(phoneEdit);
    for (const field of ["forceQuality", "autoSkipIntro", "autoSkipCredits", "skipMode"] as const) {
      expect(saved?.fieldUpdatedAt?.[field]).toBe(earlier);
    }
  });

  // @req ACCT-SQUAD-03 @req ACCT-PROF-02
  it("@bugfix @regression-proof after a main-profile promotion the seed is stamped at the reset, so it is not dropped and seeded again", async () => {
    const resetAt = "2026-10-29T12:00:00.000Z";
    const { rows, store } = memoryStore({
      [CLIENT_CONFIG_SETTING_KEY]: accountBlob,
      // The promoted profile's moved value: quality only, reset at the promotion.
      "profile_settings_v1": JSON.stringify({ quality: "480p", fieldUpdatedAt: { quality: resetAt }, resetAt, updatedAt: resetAt }),
    });
    const shown = await loadComposedClientConfig({ db: store, profile: MAIN, local: defaultClientConfig });
    expect(shown.playbackQuality).toBe("480p");
    expect(shown.autoplayNextEpisode).toBe(false);
    const seeded = parseProfileSettings(rows.get("profile_settings_v1"));
    expect(seeded?.fieldUpdatedAt?.autoplayNextEpisode, "a seed older than resetAt would be dropped on every device").toBe(resetAt);
    const written: string[] = [];
    const watched = { ...store, setSetting: async (key: string, value: string, at?: string) => (written.push(key), store.setSetting(key, value, at)) };
    await loadComposedClientConfig({ db: watched, profile: MAIN, local: shown });
    expect(written, "seeded once, not on every load").toEqual([]);
  });

  // @req ACCT-SQUAD-03 @req ACCT-PROF-02
  it("@bugfix @regression-proof a blank row (a wipe, or a promoted profile with no settings) seeds at the row's reset time", async () => {
    const resetAt = "2026-10-29T12:00:00.000Z";
    const { rows, times, store } = memoryStore({ [CLIENT_CONFIG_SETTING_KEY]: accountBlob, profile_settings_v1: "" });
    times.set("profile_settings_v1", resetAt);
    const shown = await loadComposedClientConfig({ db: store, profile: MAIN, local: defaultClientConfig });
    expect(shown.playbackQuality).toBe("720p");
    const seeded = parseProfileSettings(rows.get("profile_settings_v1"));
    expect(seeded?.resetAt).toBe(resetAt);
    expect(seeded?.fieldUpdatedAt?.quality, "an epoch seed would be dropped by the reset on the other devices").toBe(resetAt);
    expect(times.get("profile_settings_v1")).toBe(resetAt);
  });
});

/** This computer's `<userData>/device-settings.json` capacity block, as the renderer bridge sees it. */
const memoryDevice = (initial: DeviceCapacityValues | null = null) => {
  let stored = initial;
  const device: DeviceCapacityStore = {
    adoptCapacity: async (seed) => (stored ??= seed),
    setCapacity: async (values) => {
      stored = values;
    },
  };
  return { device, current: () => stored };
};

const capacityOf = (config: ClientConfig) => ({
  maxParallelTranscodes: config.maxParallelTranscodes,
  maxParallelExtractions: config.maxParallelExtractions,
  watchedDirectories: config.watchedDirectories,
});

describe("desktop capacity settings per computer", () => {
  const films = [{ id: "w1", label: "Films", path: "/media/films", library: "movies" as const }];
  const syncedBlob = JSON.stringify({
    ...JSON.parse(accountBlob),
    maxParallelTranscodes: 3,
    maxParallelExtractions: 2,
    watchedDirectories: films,
  });

  // @req ACCT-SQUAD-03[badger-desktop]
  it("copies the synced values to this computer once, and another computer's later values never replace them", async () => {
    const { rows, store } = memoryStore({ [CLIENT_CONFIG_SETTING_KEY]: syncedBlob });
    const { device, current } = memoryDevice();
    const local = { ...defaultClientConfig, ...JSON.parse(syncedBlob), configured: true } as ClientConfig;

    const first = await loadComposedClientConfig({ db: store, profile: MAIN, local, device });
    expect(capacityOf(first)).toEqual({ maxParallelTranscodes: 3, maxParallelExtractions: 2, watchedDirectories: films });
    expect(current()).toEqual({ maxParallelTranscodes: 3, maxParallelExtractions: 2, watchedDirectories: films, offlineExportFormat: "mkv" });

    // An older desktop of the account writes its own values into the synced config.
    rows.set(CLIENT_CONFIG_SETTING_KEY, JSON.stringify({ ...JSON.parse(syncedBlob), maxParallelTranscodes: 1, watchedDirectories: [] }));
    const later = await loadComposedClientConfig({ db: store, profile: MAIN, local: first, device });
    expect(capacityOf(later)).toEqual({ maxParallelTranscodes: 3, maxParallelExtractions: 2, watchedDirectories: films });
  });

  // @req ACCT-SQUAD-03[badger-desktop]
  it("a change on this computer is saved to this computer only and leaves the synced values of other computers alone", async () => {
    const { rows, store } = memoryStore({ [CLIENT_CONFIG_SETTING_KEY]: syncedBlob });
    const { device, current } = memoryDevice();
    const before = await loadComposedClientConfig({ db: store, profile: MAIN, local: defaultClientConfig, device });
    const next = { ...before, maxParallelTranscodes: 1, watchedDirectories: [], trailerLanguages: { ...before.trailerLanguages, extras: ["de"] } };

    await persistComposedClientConfig({ db: store, profile: MAIN, config: next, previous: before, device });

    expect(current()).toEqual({ maxParallelTranscodes: 1, maxParallelExtractions: 2, watchedDirectories: [], offlineExportFormat: "mkv" });
    const synced = JSON.parse(rows.get(CLIENT_CONFIG_SETTING_KEY)!) as ClientConfig;
    expect(synced.trailerLanguages.extras, "account settings still sync").toEqual(["de"]);
    expect(capacityOf(synced), "an older desktop still reads its own values there").toEqual({
      maxParallelTranscodes: 3,
      maxParallelExtractions: 2,
      watchedDirectories: films,
    });
  });

  // @req OFFL-FILE-01 @req ACCT-SQUAD-03[badger-desktop]
  it("the download file format is this computer's: the account's MP4 is copied once, a change stays on this computer", async () => {
    const accountMp4 = JSON.stringify({ ...JSON.parse(syncedBlob), offlineExportFormat: "mp4" });
    const { rows, store } = memoryStore({ [CLIENT_CONFIG_SETTING_KEY]: accountMp4 });
    const { device, current } = memoryDevice();

    const first = await loadComposedClientConfig({ db: store, profile: MAIN, local: defaultClientConfig, device });
    console.info(`[profile-client-config]:offline-format adopted=${first.offlineExportFormat} device=${current()?.offlineExportFormat}`);
    expect(first.offlineExportFormat, "a format someone already chose is kept").toBe("mp4");
    expect(current()?.offlineExportFormat).toBe("mp4");

    await persistComposedClientConfig({ db: store, profile: MAIN, config: { ...first, offlineExportFormat: "mkv" }, previous: first, device });
    expect(current()?.offlineExportFormat).toBe("mkv");
    expect((JSON.parse(rows.get(CLIENT_CONFIG_SETTING_KEY)!) as ClientConfig).offlineExportFormat, "the synced value is never rewritten").toBe("mp4");

    // Another computer of the account starts from the account's value, once, like this one did.
    const other = memoryDevice();
    const second = await loadComposedClientConfig({ db: store, profile: MAIN, local: defaultClientConfig, device: other.device });
    expect(second.offlineExportFormat).toBe("mp4");
  });

  // @req ACCT-SQUAD-03[badger-desktop]
  it("never puts this computer's values into a synced config that has none", async () => {
    const { rows, store } = memoryStore();
    const writes: string[] = [];
    const counted: ClientConfigSettingsStore = {
      getSetting: store.getSetting,
      setSetting: async (key, value, updatedAt) => {
        writes.push(key);
        await store.setSetting(key, value, updatedAt);
      },
    };
    const { device, current } = memoryDevice();
    const local = { ...defaultClientConfig, configured: true, maxParallelTranscodes: 2 };
    const before = await loadComposedClientConfig({ db: counted, profile: null, local, device });
    const next = { ...before, maxParallelTranscodes: 3 };
    await persistComposedClientConfig({ db: counted, profile: null, config: next, previous: before, device });
    await persistComposedClientConfig({ db: counted, profile: null, config: next, previous: next, device });

    expect(current()?.maxParallelTranscodes).toBe(3);
    const synced = JSON.parse(rows.get(CLIENT_CONFIG_SETTING_KEY)!) as Record<string, unknown>;
    expect(Object.keys(synced).filter((key) => key in capacityOf(defaultClientConfig))).toEqual([]);
    expect(writes.filter((key) => key === CLIENT_CONFIG_SETTING_KEY), "a save that changes no account setting writes nothing").toHaveLength(1);
  });
});
