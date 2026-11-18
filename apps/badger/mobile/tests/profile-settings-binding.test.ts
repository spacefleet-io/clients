/**
 * @test-id MOBILE-PROFILE-SETTINGS-001
 * @level unit
 *
 * ACCT-SQUAD-03 on the phone and TV (same code): the playback settings (autoplay next episode, auto-skip intro and
 * credits, quality, "Force this quality", default audio language) belong to the PROFILE. They live in the profile's
 * `[p:<pid>:]profile_settings_v1` library value, which the library sync carries to the profile's other devices. A
 * profile's first read seeds it from this device's current values; switching profile loads the new profile's values;
 * "Downloads over Wi-Fi only" stays on the device. The app language is the account's (UX-I18N-07): no profile
 * stores it, and a switch never changes it.
 *
 * The library is an in-memory stand-in with LibraryDb's `getProfileSettings` / `setProfileSettings` /
 * `onDataChanged` contract (the real LibraryDb side is library-profile-scope.test.ts); i18n is the real one.
 *
 * @req ACCT-SQUAD-03[badger-mobile,badger-tv]
 * @req ACCT-PROF-03[badger-mobile,badger-tv]
 * @req UX-I18N-07[badger-mobile,badger-tv]
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCurrentLanguage } from "@space/mobile-shell/i18n";
import {
  PROFILE_SETTINGS_SEED_AT,
  mergeProfileSettings,
  parseProfileSettings,
  resetProfileSettingsValue,
  scopedProfileSettingsKey,
  serializeProfileSettings,
  type ProfileSettings,
  type ProfileSettingsPatch,
} from "@space/shared/profileSettings";
import { MAIN_VIEWING_SCOPE, viewingScopeFor, type ViewingScope } from "@space/shared/profileViewing";
import * as appSettings from "../src/lib/appSettings";
import * as binding from "../src/lib/profileSettings";
import * as scope from "../src/lib/profiles/activeViewingScope";
import * as uiLanguage from "../src/lib/uiLanguage";
import { createFakeAsyncStorage } from "./harness";

const TAG = "[profile-settings-binding]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const fakeStorage = createFakeAsyncStorage();

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: (key: string) => fakeStorage.getItem(key),
    setItem: (key: string, value: string) => fakeStorage.setItem(key, value),
    removeItem: (key: string) => fakeStorage.removeItem(key),
  },
}));

vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  I18nManager: { getConstants: () => ({ localeIdentifier: "en_US" }) },
  Settings: { get: () => undefined },
}));

/** The encrypted library as seen by the binding: one value per profile key, plus the sync's change signal. */
const createLibrary = () => {
  const values = new Map<string, string>();
  const listeners = new Set<() => void>();
  const writes: Array<{ key: string; patch: ProfileSettingsPatch; updatedAt?: string }> = [];
  let clock = 0;
  const library = {
    values,
    writes,
    async getProfileSettings(scope: ViewingScope): Promise<ProfileSettings | null> {
      return parseProfileSettings(values.get(scopedProfileSettingsKey(scope)));
    },
    async setProfileSettings(patch: ProfileSettingsPatch, scope: ViewingScope, options: { updatedAt?: string } = {}): Promise<void> {
      const key = scopedProfileSettingsKey(scope);
      writes.push({ key, patch, updatedAt: options.updatedAt });
      const updatedAt = options.updatedAt ?? `2026-10-30T10:00:${String(++clock).padStart(2, "0")}.000Z`;
      values.set(key, serializeProfileSettings(mergeProfileSettings(parseProfileSettings(values.get(key)), patch, updatedAt)));
    },
    onDataChanged(callback: () => void) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    /** Another device's write arriving through the library sync. */
    remote(scope: ViewingScope, patch: ProfileSettingsPatch) {
      const key = scopedProfileSettingsKey(scope);
      values.set(key, serializeProfileSettings(mergeProfileSettings(parseProfileSettings(values.get(key)), patch, "2026-10-30T11:00:00.000Z")));
      for (const listener of [...listeners]) listener();
    },
    dump: () => Object.fromEntries([...values].map(([key, value]) => [key, JSON.parse(value) as unknown])),
  };
  return library;
};

const KIDS = viewingScopeFor({ id: "kids", isMain: false });
const PARENTS = viewingScopeFor({ id: "parents", isMain: false });

/** Waits for every load, apply and library write the binding started (it chains them all). */
const settle = () => binding.profileSettingsIdle();

/** Fresh state for each test: no library attached, settings reloaded from the fake device storage, main profile. */
const loadModules = async () => {
  binding.__resetProfileSettingsForTests();
  appSettings.__resetAppSettingsForTests();
  scope.setViewingScope(MAIN_VIEWING_SCOPE);
  await uiLanguage.ensureI18n();
  await appSettings.loadAppSettings();
  return { appSettings, scope, uiLanguage, binding };
};

const playback = (settings: Record<string, unknown>) => ({
  autoplayNextEpisode: settings.autoplayNextEpisode,
  autoSkipIntro: settings.autoSkipIntro,
  autoSkipCredits: settings.autoSkipCredits,
  defaultQuality: settings.defaultQuality,
  forceQuality: settings.forceQuality,
  defaultAudioLanguage: settings.defaultAudioLanguage,
});

beforeEach(() => {
  fakeStorage._backing.clear();
});

describe("profile settings on phone and TV (ACCT-SQUAD-03)", () => {
  it("@req ACCT-SQUAD-03 a profile's first read is seeded from this device's current values", async () => {
    fakeStorage._backing.set(
      "sf:app-settings:v1",
      JSON.stringify({ autoplayNextEpisode: false, autoSkipIntro: false, defaultQuality: "720p", forceQuality: true, defaultAudioLanguage: "de" })
    );
    fakeStorage._backing.set("sf_ui_language", "fr");
    const { appSettings, binding } = await loadModules();
    log("device before attach", { settings: appSettings.getAppSettings(), language: getCurrentLanguage() });
    const library = createLibrary();
    const detach = binding.attachProfileSettingsLibrary(library);
    await settle();
    log("library after seed", library.dump());
    expect(JSON.parse(library.values.get("profile_settings_v1") ?? "null")).toMatchObject({
      autoplayNextEpisode: false,
      autoSkipIntro: false,
      autoSkipCredits: true,
      quality: "720p",
      forceQuality: true,
      audioLanguage: "de",
    });
    expect(playback(appSettings.getAppSettings()), "seeding changes nothing on screen").toEqual({
      autoplayNextEpisode: false,
      autoSkipIntro: false,
      autoSkipCredits: true,
      defaultQuality: "720p",
      forceQuality: true,
      defaultAudioLanguage: "de",
    });
    expect(getCurrentLanguage()).toBe("fr");
    expect(library.values.get("profile_settings_v1"), "the app language is the account's, never seeded into a profile").not.toContain("uiLanguage");
    expect(
      library.writes.map((write) => write.updatedAt),
      "the seed is stamped with the epoch, so any real value from another device beats it (review of PR 836)"
    ).toEqual([PROFILE_SETTINGS_SEED_AT]);
    const seeds = library.writes.length;
    detach();
    binding.attachProfileSettingsLibrary(library);
    await settle();
    expect(library.writes.length, "a profile that has every field is not seeded again").toBe(seeds);
  });

  it("@req ACCT-SQUAD-03 @req UX-I18N-07 each profile keeps its own values; a switch loads the new profile's settings, never a language", async () => {
    const { appSettings, scope, binding } = await loadModules();
    const library = createLibrary();
    library.values.set(
      scopedProfileSettingsKey(KIDS),
      serializeProfileSettings({
        autoplayNextEpisode: false,
        autoSkipIntro: false,
        autoSkipCredits: false,
        quality: "480p",
        forceQuality: false,
        audioLanguage: "fr",
        updatedAt: "2026-10-30T09:00:00.000Z",
      })
    );
    scope.setViewingScope(PARENTS);
    binding.attachProfileSettingsLibrary(library);
    await settle();

    log("phase=parents-edit");
    appSettings.updateAppSettings({ defaultQuality: "2160p", autoSkipCredits: false, defaultAudioLanguage: "en", downloadsWifiOnly: false });
    await settle();
    log("library after parents edit", library.dump());
    expect(JSON.parse(library.values.get("p:parents:profile_settings_v1") ?? "null")).toMatchObject({
      quality: "2160p",
      autoSkipCredits: false,
      audioLanguage: "en",
    });
    expect(library.values.get("p:parents:profile_settings_v1"), "Wi-Fi-only downloads stay on the device").not.toContain("downloadsWifiOnly");

    log("phase=switch-to-kids");
    scope.setViewingScope(KIDS);
    await settle();
    log("kids on screen", { settings: appSettings.getAppSettings(), language: getCurrentLanguage() });
    expect(playback(appSettings.getAppSettings())).toEqual({
      autoplayNextEpisode: false,
      autoSkipIntro: false,
      autoSkipCredits: false,
      defaultQuality: "480p",
      forceQuality: false,
      defaultAudioLanguage: "fr",
    });
    expect(getCurrentLanguage(), "a switch never changes the app language").toBe("en");
    expect(appSettings.getAppSettings().downloadsWifiOnly, "the device setting does not follow the profile").toBe(false);

    log("phase=kids-edit");
    appSettings.updateAppSettings({ autoSkipCredits: true });
    await settle();
    expect(JSON.parse(library.values.get("p:kids:profile_settings_v1") ?? "null").autoSkipCredits).toBe(true);
    expect(JSON.parse(library.values.get("p:parents:profile_settings_v1") ?? "null").autoSkipCredits, "an edit in one profile never changes another's").toBe(false);

    log("phase=switch-back");
    scope.setViewingScope(PARENTS);
    await settle();
    expect(playback(appSettings.getAppSettings())).toMatchObject({ defaultQuality: "2160p", autoSkipCredits: false, defaultAudioLanguage: "en" });
    expect(getCurrentLanguage()).toBe("en");
  });

  it("@req ACCT-PROF-03 each profile keeps its own title language, never seeded: a profile that never answered sees the app's language", async () => {
    const { appSettings, scope, binding } = await loadModules();
    const library = createLibrary();
    scope.setViewingScope(PARENTS);
    binding.attachProfileSettingsLibrary(library);
    await settle();
    expect(appSettings.getAppSettings().titleLanguage, "never answered: the app's language").toBe("app");
    expect(library.values.get("p:parents:profile_settings_v1") ?? "", "the first read never seeds the title language").not.toContain("titleLanguage");
    appSettings.updateAppSettings({ titleLanguage: "original" });
    await settle();
    log("library after parents pick the original version", library.dump());
    expect(JSON.parse(library.values.get("p:parents:profile_settings_v1") ?? "null").titleLanguage).toBe("original");

    scope.setViewingScope(KIDS);
    await settle();
    expect(appSettings.getAppSettings().titleLanguage, "the kids never answered: the app's language").toBe("app");
    expect(library.values.get("p:kids:profile_settings_v1") ?? "", "the switch never writes the parents' choice into the kids'").not.toContain("titleLanguage");

    scope.setViewingScope(PARENTS);
    await settle();
    expect(appSettings.getAppSettings().titleLanguage).toBe("original");

    library.remote(PARENTS, { titleLanguage: "app" });
    await settle();
    expect(appSettings.getAppSettings().titleLanguage, "a choice made on another device shows here").toBe("app");
  });

  it("@req ACCT-SQUAD-03 each profile keeps its own subtitle language (shared `subtitleLanguage`, never seeded); one set on desktop shows here", async () => {
    const { appSettings, scope, binding } = await loadModules();
    const library = createLibrary();
    scope.setViewingScope(PARENTS);
    binding.attachProfileSettingsLibrary(library);
    await settle();
    log("phase=parents-first-read", library.dump());
    expect(appSettings.getAppSettings().defaultSubtitleLanguage, "no preference until the profile picks one").toBeNull();
    expect(library.values.get("p:parents:profile_settings_v1") ?? "", "the first read never seeds a subtitle language").not.toContain("subtitleLanguage");

    log("phase=parents-pick-fr");
    appSettings.updateAppSettings({ defaultSubtitleLanguage: "fr" });
    await settle();
    log("library after parents pick French subtitles", library.dump());
    expect(JSON.parse(library.values.get("p:parents:profile_settings_v1") ?? "null").subtitleLanguage).toBe("fr");

    log("phase=switch-to-kids");
    scope.setViewingScope(KIDS);
    await settle();
    log("kids on screen", appSettings.getAppSettings());
    expect(appSettings.getAppSettings().defaultSubtitleLanguage, "the kids never chose: no preference, not the parents' French").toBeNull();
    expect(library.values.get("p:kids:profile_settings_v1") ?? "", "the switch never writes the parents' choice into the kids'").not.toContain("subtitleLanguage");

    log("phase=desktop-sets-kids-de");
    library.remote(KIDS, { subtitleLanguage: "de" });
    await settle();
    expect(appSettings.getAppSettings().defaultSubtitleLanguage, "the kids' choice made on desktop arrives through the sync").toBe("de");

    log("phase=switch-back");
    scope.setViewingScope(PARENTS);
    await settle();
    expect(appSettings.getAppSettings().defaultSubtitleLanguage).toBe("fr");
    appSettings.updateAppSettings({ defaultSubtitleLanguage: null });
    await settle();
    log("library after parents pick no preference", library.dump());
    expect(JSON.parse(library.values.get("p:parents:profile_settings_v1") ?? "null").subtitleLanguage, "No preference is stored as null").toBeNull();
  });

  // @bugfix default-subs-lang (Chris 2026-11-12, Coco) @regression-proof: the player needs WHEN the subtitle language
  // was last changed, so a change newer than a title's remembered subtitle choice wins at the next play.
  it("@req PLAY-TRACK-11[badger-mobile,badger-tv] the subtitle language's change time follows the profile and a change made here", async () => {
    const { appSettings, scope, binding } = await loadModules();
    const library = createLibrary();
    scope.setViewingScope(PARENTS);
    binding.attachProfileSettingsLibrary(library);
    await settle();
    expect(appSettings.getAppSettings().defaultSubtitleLanguageSetAt, "a profile that never chose has no change time").toBeNull();

    const before = Date.now();
    appSettings.updateAppSettings({ defaultSubtitleLanguage: "fr" });
    const stampedHere = appSettings.getAppSettings().defaultSubtitleLanguageSetAt;
    log("phase=parents-pick-fr", { stampedHere });
    expect(Date.parse(stampedHere ?? ""), "a change made here is stamped at once, before the save lands").toBeGreaterThanOrEqual(before);
    await settle();
    expect(library.writes.at(-1)?.patch, "the change time is never written into the profile").toEqual({ subtitleLanguage: "fr" });

    library.remote(PARENTS, { subtitleLanguage: "de" });
    await settle();
    log("phase=desktop-sets-de", appSettings.getAppSettings());
    expect(appSettings.getAppSettings().defaultSubtitleLanguage).toBe("de");
    expect(appSettings.getAppSettings().defaultSubtitleLanguageSetAt, "a change from another device carries its own time").toBe("2026-10-30T11:00:00.000Z");

    scope.setViewingScope(KIDS);
    await settle();
    expect(appSettings.getAppSettings().defaultSubtitleLanguageSetAt, "another profile never shows the parents' time").toBeNull();
  });

  it("@req UX-I18N-07 a language picked in Settings is the account's: no profile stores it, and a switch or sync keeps it", async () => {
    const { scope, uiLanguage, binding } = await loadModules();
    const library = createLibrary();
    // An older build stored a per-profile language in the kids' profile.
    library.values.set(scopedProfileSettingsKey(KIDS), JSON.stringify({ uiLanguage: "fr", updatedAt: "2026-10-30T09:00:00.000Z" }));
    binding.attachProfileSettingsLibrary(library);
    await settle();
    await uiLanguage.chooseUiLanguage("de", { pushToAccount: false });
    await settle();
    scope.setViewingScope(KIDS);
    await settle();
    library.remote(KIDS, { autoSkipIntro: false });
    await settle();
    log("library after pick and switch", { language: getCurrentLanguage(), library: library.dump() });
    expect(getCurrentLanguage(), "the switch and the sync keep the picked language").toBe("de");
    expect(library.writes.filter((write) => "uiLanguage" in write.patch), "no profile write carries a language").toEqual([]);
  });

  it("@req ACCT-SQUAD-03 a change another device made in this profile arrives through the library sync", async () => {
    const { appSettings, scope, binding } = await loadModules();
    const library = createLibrary();
    scope.setViewingScope(MAIN_VIEWING_SCOPE);
    binding.attachProfileSettingsLibrary(library);
    await settle();
    library.remote(MAIN_VIEWING_SCOPE, { autoSkipIntro: false, quality: "360p", forceQuality: true });
    await settle();
    log("after remote", { settings: appSettings.getAppSettings() });
    expect(appSettings.getAppSettings()).toMatchObject({ autoSkipIntro: false, forceQuality: true, defaultQuality: "480p" });
    library.remote(KIDS, { autoSkipIntro: true });
    await settle();
    expect(appSettings.getAppSettings().autoSkipIntro, "another profile's change does not apply here").toBe(false);
  });

  it("@req ACCT-SQUAD-03 @req ACCT-PROF-02 @bugfix a seed after a promotion is stamped at the reset, so the reset never drops it again", async () => {
    const { binding } = await loadModules();
    const library = createLibrary();
    const resetAt = "2026-10-30T09:00:00.000Z";
    library.values.set(
      "profile_settings_v1",
      resetProfileSettingsValue(serializeProfileSettings(mergeProfileSettings(null, { quality: "480p" }, "2026-10-01T00:00:00.000Z")), resetAt)
    );
    binding.attachProfileSettingsLibrary(library);
    await settle();
    log("seeded after reset", { writes: library.writes });
    expect(library.writes.map((entry) => entry.updatedAt)).toEqual([resetAt]);
  });

  it("@req ACCT-SQUAD-03 @bugfix an edit made while older syncs are still queued is never reverted by them", async () => {
    const { appSettings, binding } = await loadModules();
    const library = createLibrary();
    binding.attachProfileSettingsLibrary(library);
    await settle();
    log("two syncs then an edit");
    library.remote(MAIN_VIEWING_SCOPE, { autoSkipIntro: true });
    library.remote(MAIN_VIEWING_SCOPE, { autoSkipIntro: true });
    await appSettings.updateAppSettings({ autoSkipIntro: false });
    await settle();
    log("after", { shown: appSettings.getAppSettings().autoSkipIntro, stored: library.dump() });
    expect(appSettings.getAppSettings().autoSkipIntro, "the edit stays on screen").toBe(false);
    expect(JSON.parse(library.values.get("profile_settings_v1") ?? "null")).toMatchObject({ autoSkipIntro: false });
  });
});
