/**
 * @test-id MOBILE-SETTINGS-001
 * @level unit
 * @why App settings (autoplay, auto-skip, default quality, Wi-Fi-only downloads)
 *   drive Player and Downloads behaviour. Defaults must match the desktop
 *   defaults (everything on, ABR quality), edits must persist across an app
 *   restart, and corrupt/foreign stored values must never break startup.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { findMediaLanguage } from "@space/shared/media-languages";
import { AUDIO_LANGUAGE_CHOICES } from "@space/shared/profileSettings";
import { createFakeAsyncStorage } from "./harness";

const fakeStorage = createFakeAsyncStorage();

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: (key: string) => fakeStorage.getItem(key),
    setItem: (key: string, value: string) => fakeStorage.setItem(key, value),
    removeItem: (key: string) => fakeStorage.removeItem(key),
  },
}));

const loadModule = async () => {
  const mod = await import("../src/lib/appSettings");
  mod.__resetAppSettingsForTests();
  return mod;
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  console.info("[app-settings:reset] clearing fake AsyncStorage");
  fakeStorage._backing.clear();
});

describe("appSettings defaults", () => {
  // @req PLAY-QUAL-01[badger-mobile,badger-tv] @req PLAY-NEXT-01[badger-mobile,badger-tv] @req PLAY-NEXT-02[badger-mobile,badger-tv]
  it("returns the documented defaults before and after loading an empty store", async () => {
    const mod = await loadModule();
    console.info("[app-settings:defaults]", JSON.stringify(mod.getAppSettings()));
    expect(mod.getAppSettings()).toEqual({
      autoplayNextEpisode: true,
      autoSkipIntro: true,
      autoSkipCredits: true,
      defaultQuality: "1080p",
      forceQuality: false,
      downloadsWifiOnly: true,
      animatedBackground: "auto",
      defaultAudioLanguage: null,
      // ACCT-SQUAD-03 / PLAY-TRACK-11: no subtitle language, and no time it was changed, until the profile picks one.
      defaultSubtitleLanguage: null,
      defaultSubtitleLanguageSetAt: null,
      // @req REL-LOG-06[badger-mobile]: error reports are off, and unanswered, until the user decides.
      errorReports: false,
      errorReportsDecided: false,
      libraryView: {
        movie: { view: "posters", sortBy: "name", sortDirection: "asc" },
        tv: { view: "posters", sortBy: "name", sortDirection: "asc" },
      },
      // ACCT-PROF-03: titles, posters and backdrops show in the app's language until the profile picks otherwise.
      titleLanguage: "app",
    });
    const loaded = await mod.loadAppSettings();
    expect(loaded).toEqual(mod.DEFAULT_APP_SETTINGS);
    expect(mod.getAppSettings()).toEqual(mod.DEFAULT_APP_SETTINGS);
  });
});

describe("appSettings persistence", () => {
  it("persists updates and restores them after a simulated app restart", async () => {
    const first = await loadModule();
    await first.loadAppSettings();
    first.updateAppSettings({ autoplayNextEpisode: false, defaultQuality: "720p" });
    expect(first.getAppSettings().autoplayNextEpisode).toBe(false);
    await flush();
    console.info("[app-settings:stored]", fakeStorage._backing.get(first.APP_SETTINGS_STORAGE_KEY));

    // "Restart": fresh in-memory state, same storage.
    const second = await loadModule();
    expect(second.getAppSettings().autoplayNextEpisode).toBe(true); // not yet loaded
    const restored = await second.loadAppSettings();
    expect(restored).toEqual({
      ...second.DEFAULT_APP_SETTINGS,
      autoplayNextEpisode: false,
      defaultQuality: "720p",
    });
  });

  it("keeps edits made while the initial load is still in flight", async () => {
    fakeStorage._backing.set(
      "sf:app-settings:v1",
      JSON.stringify({ autoSkipIntro: false, downloadsWifiOnly: false }),
    );
    const mod = await loadModule();
    const pending = mod.loadAppSettings();
    mod.updateAppSettings({ downloadsWifiOnly: true });
    const loaded = await pending;
    expect(loaded.autoSkipIntro).toBe(false); // from storage
    expect(loaded.downloadsWifiOnly).toBe(true); // edit wins over stored value
  });

  it("persists only real changes (no-op updates do not write)", async () => {
    const mod = await loadModule();
    await mod.loadAppSettings();
    const seen: boolean[] = [];
    seen.push(mod.getAppSettings().autoSkipCredits);
    mod.updateAppSettings({ autoSkipCredits: true }); // no change
    await flush();
    expect(fakeStorage._backing.has(mod.APP_SETTINGS_STORAGE_KEY)).toBe(false);
    mod.updateAppSettings({ autoSkipCredits: false });
    seen.push(mod.getAppSettings().autoSkipCredits);
    await flush();
    expect(seen).toEqual([true, false]);
    expect(fakeStorage._backing.has(mod.APP_SETTINGS_STORAGE_KEY)).toBe(true);
  });
});

describe("appSettings robustness", () => {
  it("ignores corrupt JSON, unknown keys and invalid values", async () => {
    fakeStorage._backing.set("sf:app-settings:v1", "{not json");
    const corrupt = await loadModule();
    expect(await corrupt.loadAppSettings()).toEqual(corrupt.DEFAULT_APP_SETTINGS);

    fakeStorage._backing.set(
      "sf:app-settings:v1",
      JSON.stringify({ defaultQuality: "8k", autoplayNextEpisode: "yes", bogus: 1, autoSkipIntro: false }),
    );
    const invalid = await loadModule();
    expect(await invalid.loadAppSettings()).toEqual({
      ...invalid.DEFAULT_APP_SETTINGS,
      autoSkipIntro: false,
    });
  });

  it("migrates the legacy stored \"auto\" quality to 1080p (Auto is a mode now) and keeps forceQuality off", async () => {
    fakeStorage._backing.set("sf:app-settings:v1", JSON.stringify({ defaultQuality: "auto" }));
    const mod = await loadModule();
    const loaded = await mod.loadAppSettings();
    console.info("[app-settings:migrated]", JSON.stringify(loaded));
    expect(loaded.defaultQuality).toBe("1080p");
    expect(loaded.forceQuality).toBe(false);
  });

  // @req PLAY-QUAL-03[badger-mobile,badger-tv]
  it("persists Force this quality", async () => {
    const first = await loadModule();
    await first.loadAppSettings();
    first.updateAppSettings({ forceQuality: true, defaultQuality: "480p" });
    await flush();
    const second = await loadModule();
    const restored = await second.loadAppSettings();
    expect(restored.forceQuality).toBe(true);
    expect(restored.defaultQuality).toBe("480p");
  });

  it("rejects invalid patch values", async () => {
    const mod = await loadModule();
    await mod.loadAppSettings();
    mod.updateAppSettings({ defaultQuality: "8k" } as never);
    expect(mod.getAppSettings().defaultQuality).toBe("1080p");
  });
});

describe("appSettings animated background (UX-SKY-01)", () => {
  // @req UX-SKY-01[badger-mobile]
  it("defaults to Automatic and persists On / Off across a restart", async () => {
    const first = await loadModule();
    await first.loadAppSettings();
    expect(first.getAppSettings().animatedBackground).toBe("auto");
    first.updateAppSettings({ animatedBackground: "off" });
    await flush();
    const second = await loadModule();
    const restored = await second.loadAppSettings();
    console.info("[app-settings:animatedBackground]", restored.animatedBackground);
    expect(restored.animatedBackground).toBe("off");
    second.updateAppSettings({ animatedBackground: "on" });
    await flush();
    expect((await (await loadModule()).loadAppSettings()).animatedBackground).toBe("on");
  });

  // @req UX-SKY-01[badger-mobile]
  it("ignores an invalid stored or patched value", async () => {
    fakeStorage._backing.set("sf:app-settings:v1", JSON.stringify({ animatedBackground: "sometimes" }));
    const mod = await loadModule();
    expect((await mod.loadAppSettings()).animatedBackground).toBe("auto");
    mod.updateAppSettings({ animatedBackground: "maybe" } as never);
    expect(mod.getAppSettings().animatedBackground).toBe("auto");
  });
});

describe("appSettings default audio language (PLAY-TRACK-01)", () => {
  // @req PLAY-TRACK-01[badger-mobile]
  it("defaults to Original (no preference) and persists a pick, and a return to Original, across a restart", async () => {
    const first = await loadModule();
    await first.loadAppSettings();
    expect(first.getAppSettings().defaultAudioLanguage, "Original = no preference").toBeNull();
    first.updateAppSettings({ defaultAudioLanguage: "fr" });
    await flush();
    const second = await loadModule();
    const restored = await second.loadAppSettings();
    console.info("[app-settings:defaultAudioLanguage]", restored.defaultAudioLanguage);
    expect(restored.defaultAudioLanguage).toBe("fr");
    second.updateAppSettings({ defaultAudioLanguage: null });
    await flush();
    expect((await (await loadModule()).loadAppSettings()).defaultAudioLanguage).toBeNull();
  });

  // @req PLAY-TRACK-01[badger-mobile]
  it("ignores a language outside the offered choices, stored or patched; a 639-2 spelling is normalized", async () => {
    fakeStorage._backing.set("sf:app-settings:v1", JSON.stringify({ defaultAudioLanguage: "klingon" }));
    const mod = await loadModule();
    expect((await mod.loadAppSettings()).defaultAudioLanguage).toBeNull();
    mod.updateAppSettings({ defaultAudioLanguage: "xx" as never });
    expect(mod.getAppSettings().defaultAudioLanguage).toBeNull();
    mod.updateAppSettings({ defaultAudioLanguage: "fre" as never });
    expect(mod.getAppSettings().defaultAudioLanguage).toBe("fr");
  });

  // @req PLAY-TRACK-01[badger-mobile]
  it("the Settings row maps Original to no preference and a language to its code; every offered language has a label", async () => {
    const mod = await loadModule();
    expect(mod.audioLanguageFromChoice(mod.AUDIO_LANGUAGE_ORIGINAL)).toBeNull();
    expect(mod.audioLanguageToChoice(null)).toBe(mod.AUDIO_LANGUAGE_ORIGINAL);
    for (const code of AUDIO_LANGUAGE_CHOICES) {
      expect(mod.audioLanguageFromChoice(mod.audioLanguageToChoice(code))).toBe(code);
      expect(findMediaLanguage(code), `media language table has ${code}`).not.toBeNull();
    }
    expect(AUDIO_LANGUAGE_CHOICES).toEqual(expect.arrayContaining(["en", "fr"]));
  });
});
