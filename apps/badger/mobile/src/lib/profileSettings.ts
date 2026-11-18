/**
 * The active profile's playback settings on phone and TV (ACCT-SQUAD-03). The app language is the account's, the
 * same on every profile (UX-I18N-07, `useAccountLanguageSync.ts`): switching profile never changes it.
 *
 * They live in the profile's `[p:<pid>:]profile_settings_v1` library value (shared with desktop,
 * `@space/shared/profileSettings`), so they follow the profile onto every device through the library sync and a
 * change in one profile never moves another's. This module binds that value to the screen:
 *   - on attach, on a profile switch and after every library sync it reads the active profile's value and shows it
 *     (`applyProfileAppSettings`);
 *   - a field the profile never had is seeded from this device's current value, once;
 *   - a user edit (Settings) is saved in the active profile.
 * Every read, apply and write runs on one chain, so a switch or sync never interleaves with a save.
 * Device settings ("Downloads over Wi-Fi only", library view, animated background, error reports) are not touched.
 */
import {
  AUDIO_LANGUAGE_CHOICES,
  missingProfileSettings,
  profileSettingsSeedAt,
  profileSubtitleLanguage,
  type AudioLanguageChoice,
  type ProfileSettings,
  type ProfileSettingsPatch,
  type SeededProfileSetting,
} from "@space/shared/profileSettings";
import { isTitleLanguage, profileTitleLanguage } from "@space/shared/titleLanguage";
import { useSyncExternalStore } from "react";
import type { ViewingScope } from "@space/shared/profileViewing";
import {
  DEFAULT_QUALITIES,
  applyProfileAppSettings,
  getAppSettings,
  loadAppSettings,
  setProfileEditSink,
  type DefaultQuality,
  type ProfileAppSettings,
} from "./appSettings";
import type { LibraryDb } from "./libraryDb";
import { scopeLogger } from "@space/mobile-shell/logger";
import { getViewingScope, onViewingScopeChange } from "./profiles/activeViewingScope";

const log = scopeLogger("profile-settings");

export type ProfileSettingsLibrary = Pick<LibraryDb, "getProfileSettings" | "setProfileSettings" | "onDataChanged">;

/** Desktop also offers 360p, 240p and 144p; the phone and TV start no lower than 480p. */
const toDefaultQuality = (quality: ProfileSettings["quality"]): DefaultQuality | undefined => {
  if (quality === undefined) return undefined;
  return (DEFAULT_QUALITIES as readonly string[]).includes(quality) ? (quality as DefaultQuality) : "480p";
};

/** What the stored profile value shows on this device; fields this device cannot show are left out. */
const fromProfile = (stored: ProfileSettings | null): Partial<ProfileAppSettings> => {
  if (!stored) return { titleLanguage: "app", defaultSubtitleLanguage: null, defaultSubtitleLanguageSetAt: null };
  const out: Partial<ProfileAppSettings> = {};
  if (stored.autoplayNextEpisode !== undefined) out.autoplayNextEpisode = stored.autoplayNextEpisode;
  if (stored.autoSkipIntro !== undefined) out.autoSkipIntro = stored.autoSkipIntro;
  if (stored.autoSkipCredits !== undefined) out.autoSkipCredits = stored.autoSkipCredits;
  if (stored.forceQuality !== undefined) out.forceQuality = stored.forceQuality;
  // ACCT-PROF-03: a profile that never answered shows titles in the app's language, whatever another profile picked
  // on this device; never seeded.
  out.titleLanguage = profileTitleLanguage(stored);
  const quality = toDefaultQuality(stored.quality);
  if (quality !== undefined) out.defaultQuality = quality;
  if (stored.audioLanguage === null) out.defaultAudioLanguage = null;
  else if (stored.audioLanguage !== undefined && (AUDIO_LANGUAGE_CHOICES as readonly string[]).includes(stored.audioLanguage)) {
    out.defaultAudioLanguage = stored.audioLanguage as AudioLanguageChoice;
  }
  // Never seeded: a profile that never chose has no preference, whatever another profile picked on this device.
  out.defaultSubtitleLanguage = profileSubtitleLanguage(stored);
  // PLAY-TRACK-11: when it was last changed, so a newer change beats a title's remembered subtitle choice.
  out.defaultSubtitleLanguageSetAt = stored.fieldUpdatedAt?.subtitleLanguage ?? null;
  return out;
};

/** The profile value's fields for app-settings fields (`defaultQuality` → `quality`, `defaultAudioLanguage` → `audioLanguage`,
 * `defaultSubtitleLanguage` → `subtitleLanguage`). */
const toProfilePatch = (settings: Partial<ProfileAppSettings>): ProfileSettingsPatch => {
  const out: ProfileSettingsPatch = {};
  if (settings.autoplayNextEpisode !== undefined) out.autoplayNextEpisode = settings.autoplayNextEpisode;
  if (settings.autoSkipIntro !== undefined) out.autoSkipIntro = settings.autoSkipIntro;
  if (settings.autoSkipCredits !== undefined) out.autoSkipCredits = settings.autoSkipCredits;
  if (settings.forceQuality !== undefined) out.forceQuality = settings.forceQuality;
  if (settings.defaultQuality !== undefined) out.quality = settings.defaultQuality;
  if (settings.defaultAudioLanguage !== undefined) out.audioLanguage = settings.defaultAudioLanguage;
  if (settings.defaultSubtitleLanguage !== undefined) out.subtitleLanguage = settings.defaultSubtitleLanguage;
  if (settings.titleLanguage !== undefined) out.titleLanguage = settings.titleLanguage;
  return out;
};

let library: ProfileSettingsLibrary | null = null;
let chain: Promise<void> = Promise.resolve();
/**
 * Each field's last edit, numbered by a counter that only grows. A load queued before an edit must not show the
 * older stored value of that field, even when a later load was queued in between (review of PR 836).
 */
let editSeq = 0;
const lastEdit = new Map<keyof ProfileSettingsPatch, number>();
const markEdited = (key: keyof ProfileSettingsPatch) => lastEdit.set(key, ++editSeq);

/**
 * The active profile's stored "How should titles appear?" answer (ACCT-PROF-03), as `needsTitleLanguageQuestion`
 * takes it; null until the profile's settings are read, so the question never flashes for a profile that answered.
 */
let titleAnswer: { titleLanguage?: unknown } | null = null;
const titleAnswerListeners = new Set<() => void>();
const setTitleAnswer = (next: { titleLanguage?: unknown } | null) => {
  if (next === titleAnswer || (next && titleAnswer && next.titleLanguage === titleAnswer.titleLanguage)) return;
  titleAnswer = next;
  for (const listener of titleAnswerListeners) listener();
};
export const getActiveTitleLanguageAnswer = (): { titleLanguage?: unknown } | null => titleAnswer;
export const subscribeActiveTitleLanguageAnswer = (listener: () => void): (() => void) => {
  titleAnswerListeners.add(listener);
  return () => titleAnswerListeners.delete(listener);
};
export const useActiveTitleLanguageAnswer = () =>
  useSyncExternalStore(subscribeActiveTitleLanguageAnswer, getActiveTitleLanguageAnswer, getActiveTitleLanguageAnswer);

const enqueue = (label: string, job: () => Promise<void>): Promise<void> => {
  chain = chain.then(job).catch((error: unknown) => {
    log.warn(`${label}.failed`, { message: error instanceof Error ? error.message : String(error) });
  });
  return chain;
};

/** Saves a user edit in the profile active NOW (a switch right after must not carry it to the next profile). */
const saveEdit = (patch: ProfileSettingsPatch) => {
  const target = library;
  if (!target) {
    log.info("edit.no_library", { fields: Object.keys(patch) });
    return;
  }
  const scope = getViewingScope();
  for (const key of Object.keys(patch) as (keyof ProfileSettingsPatch)[]) markEdited(key);
  if (isTitleLanguage(patch.titleLanguage)) setTitleAnswer({ titleLanguage: patch.titleLanguage });
  void enqueue("save", async () => {
    await target.setProfileSettings(patch, scope);
    log.info("saved", { profileId: scope.profileId, ...patch });
  });
};

/** Reads the active profile's value, seeds what it never had from this device, and shows the rest. */
const reload = (reason: "attach" | "switch" | "sync"): Promise<void> => {
  const target = library;
  if (!target) return chain;
  const queuedAt = editSeq;
  return enqueue("load", async () => {
    if (target !== library) return;
    const scope: ViewingScope = getViewingScope();
    await loadAppSettings();
    const stored = await target.getProfileSettings(scope);
    if (target !== library || scope !== getViewingScope()) return;

    const missing = missingProfileSettings(stored);
    if (missing.length > 0) {
      const device = toProfilePatch(getAppSettings());
      const seed: ProfileSettingsPatch = {};
      for (const key of missing as SeededProfileSetting[]) (seed as Record<string, unknown>)[key] = device[key];
      log.info("seeded", { reason, profileId: scope.profileId, ...seed });
      // Stamped with the epoch (or the value's reset, after a promotion): any real value another device saved beats
      // this device's guess, and a reset never drops the seed again (review of PR 836).
      await target.setProfileSettings(seed, scope, { updatedAt: profileSettingsSeedAt(stored) });
    }

    const edited = new Set([...lastEdit].filter(([, seq]) => seq > queuedAt).map(([key]) => key));
    if (!edited.has("titleLanguage")) setTitleAnswer({ titleLanguage: stored?.titleLanguage });
    const playback = fromProfile(stored);
    for (const key of edited) {
      if (key === "quality") delete playback.defaultQuality;
      else if (key === "audioLanguage") delete playback.defaultAudioLanguage;
      else if (key === "subtitleLanguage") {
        delete playback.defaultSubtitleLanguage;
        delete playback.defaultSubtitleLanguageSetAt;
      } else delete (playback as Record<string, unknown>)[key];
    }
    log.info("loaded", { reason, profileId: scope.profileId, stored: stored !== null, ...playback, skipped: [...edited] });
    applyProfileAppSettings(playback);
  });
};

/**
 * Binds the active profile's settings to `db` (call when the library opens; the returned function detaches it when
 * the library closes or is replaced). Loads the profile's values now, then on every profile switch and library sync.
 */
export const attachProfileSettingsLibrary = (db: ProfileSettingsLibrary): (() => void) => {
  library = db;
  setProfileEditSink((patch) => saveEdit(toProfilePatch(patch)));
  const offScope = onViewingScopeChange(() => {
    setTitleAnswer(null);
    void reload("switch");
  });
  const offData = db.onDataChanged(() => void reload("sync"));
  void reload("attach");
  return () => {
    offScope();
    offData();
    if (library !== db) return;
    library = null;
    setTitleAnswer(null);
    setProfileEditSink(null);
  };
};

/** Resolves once every queued load, apply and save has finished. */
export const profileSettingsIdle = (): Promise<void> => chain;

/** Test hook: detach any library and drop the queue. */
export const __resetProfileSettingsForTests = (): void => {
  library = null;
  chain = Promise.resolve();
  editSeq = 0;
  lastEdit.clear();
  setTitleAnswer(null);
  setProfileEditSink(null);
};
