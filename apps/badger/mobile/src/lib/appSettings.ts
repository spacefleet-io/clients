/**
 * App settings (playback + downloads preferences), read synchronously by the Player, Downloads and Settings code.
 *
 * Where each setting belongs (ACCT-SQUAD-03): the playback settings in `PROFILE_APP_SETTING_KEYS` belong to the
 * active PROFILE and live in its `[p:<pid>:]profile_settings_v1` library value (`profileSettings.ts` loads them on
 * attach, profile switch and library sync, and saves edits there); every other setting stays on this device. The
 * AsyncStorage blob keeps the last values shown, so the app starts with them before the library opens.
 *
 * Contract (shared with the Player / Downloads code):
 *   getAppSettings()      sync read of the last loaded value (defaults until loaded)
 *   useAppSettings()      React hook: [settings, update(patch)]
 *   loadAppSettings()     async load from storage; call once at startup
 *   updateAppSettings()   non-hook writer (same as the hook's setter); a user edit, so profile fields go to the profile
 *   applyProfileAppSettings()  shows the active profile's stored values (never written back to the profile)
 */
import { useSyncExternalStore } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  DEFAULT_LIBRARY_VIEW_PREFS,
  sanitizeLibraryViewPrefs,
  type LibraryViewPrefs,
} from "@space/shared/libraryView";
import { AUDIO_LANGUAGE_CHOICES, type AudioLanguageChoice } from "@space/shared/profileSettings";
import { isTitleLanguage, type TitleLanguage } from "@space/shared/titleLanguage";
import { normalizeLanguageCode } from "@space/shared/trackPrefs";
import { scopeLogger } from "@space/mobile-shell/logger";

const log = scopeLogger("app-settings");

/**
 * The playback quality the user picked in Settings. Auto (adaptive) is the default MODE, not a quality: this rung is
 * where playback starts and the highest rung Auto may climb back to. `forceQuality` pins it (no automatic switching).
 */
export type DefaultQuality = "2160p" | "1080p" | "720p" | "480p";

/** "Animated background" (UX-SKY-01): shooting stars fly (On) or are frozen (Off); Automatic is On except on a low-RAM phone. */
export type AnimatedBackground = "auto" | "on" | "off";

export const ANIMATED_BACKGROUND_CHOICES: readonly AnimatedBackground[] = ["auto", "on", "off"];

/** The Settings row is a single-choice group of strings: "" stands for Original (no preference). */
export const AUDIO_LANGUAGE_ORIGINAL = "";

export const audioLanguageToChoice = (language: AudioLanguageChoice | null): string => language ?? AUDIO_LANGUAGE_ORIGINAL;

/** The setting a Settings choice stands for (`updateAppSettings` drops a code outside `AUDIO_LANGUAGE_CHOICES`). */
export const audioLanguageFromChoice = (choice: string): AudioLanguageChoice | null =>
  choice === AUDIO_LANGUAGE_ORIGINAL ? null : (choice as AudioLanguageChoice);

export type AppSettings = {
  /** Continue TV episodes automatically. */
  autoplayNextEpisode: boolean;
  /** Skip the intro automatically (5 s countdown, like desktop). */
  autoSkipIntro: boolean;
  /** Skip the credits automatically. */
  autoSkipCredits: boolean;
  /** Start rung and Auto ceiling (see `DefaultQuality`). */
  defaultQuality: DefaultQuality;
  /** "Force this quality": never adapt to the network or the decoder; stay on `defaultQuality`. Off = Auto. */
  forceQuality: boolean;
  /** Only download over Wi-Fi (never mobile data). */
  downloadsWifiOnly: boolean;
  /** Media library view (posters / compact / details) and sort, remembered per Movies / TV tab on this device. */
  libraryView: LibraryViewPrefs;
  /** Animated sky behind the app (see `AnimatedBackground`). */
  animatedBackground: AnimatedBackground;
  /**
   * "Default audio language" (PLAY-TRACK-01, PLAY-TRACK-04): the ISO 639-1 code audio starts in when the title has
   * no remembered choice and the file has that language. `null` = Original: no preference, the file's own default.
   * Follows the profile (ACCT-SQUAD-03), like the other playback settings.
   */
  defaultAudioLanguage: AudioLanguageChoice | null;
  /**
   * "Subtitle language" (ACCT-SQUAD-03, PLAY-TRACK-04, PLAY-TRACK-11): the ISO 639-1 code subtitles start in when the
   * file has that language and the title has no remembered subtitle choice, or one older than this setting's last
   * change. `null` = no preference: the file's own default (off on phone and TV). The profile's shared
   * `subtitleLanguage`; a profile that never chose shows `null`, never seeded.
   */
  defaultSubtitleLanguage: AudioLanguageChoice | null;
  /**
   * PLAY-TRACK-11: when the profile's "Subtitle language" was last changed (its `fieldUpdatedAt.subtitleLanguage`,
   * ISO time), so a change newer than a title's remembered subtitle choice wins at the next play. `null` = unknown.
   * Shown from the profile, stamped on an edit made here; never written to the profile itself.
   */
  defaultSubtitleLanguageSetAt: string | null;
  /**
   * How titles appear (ACCT-PROF-03): "app" = title, poster and backdrop in the account's language, "original" = in
   * the media's original language (non-Latin originals stay in the account's language). Follows the profile; a
   * profile that never answered shows "app", never seeded from this device.
   */
  titleLanguage: TitleLanguage;
  /**
   * Send error reports to SpaceFleet (REL-LOG-06). Off until the user turns it on; never synced with the account.
   * Nothing initialises the reporting SDK while this is false (see `errorReporting.ts`).
   */
  errorReports: boolean;
  /** The user has answered the "Send error reports" question (setup step or Settings); existing installs are asked once. */
  errorReportsDecided: boolean;
};

export const APP_SETTINGS_STORAGE_KEY = "sf:app-settings:v1";

export const DEFAULT_QUALITIES: readonly DefaultQuality[] = [
  "2160p",
  "1080p",
  "720p",
  "480p",
];

export const DEFAULT_APP_SETTINGS: AppSettings = Object.freeze({
  autoplayNextEpisode: true,
  autoSkipIntro: true,
  autoSkipCredits: true,
  defaultQuality: "1080p",
  forceQuality: false,
  downloadsWifiOnly: true,
  libraryView: DEFAULT_LIBRARY_VIEW_PREFS,
  animatedBackground: "auto",
  defaultAudioLanguage: null,
  defaultSubtitleLanguage: null,
  defaultSubtitleLanguageSetAt: null,
  titleLanguage: "app",
  errorReports: false,
  errorReportsDecided: false,
}) as AppSettings;

const BOOLEAN_KEYS = [
  "autoplayNextEpisode",
  "autoSkipIntro",
  "autoSkipCredits",
  "forceQuality",
  "downloadsWifiOnly",
  "errorReports",
  "errorReportsDecided",
] as const;

/** Keeps only valid, known keys; anything else (old/corrupt storage) is dropped. */
const sanitize = (raw: unknown): Partial<AppSettings> => {
  if (!raw || typeof raw !== "object") return {};
  const input = raw as Record<string, unknown>;
  const out: Partial<AppSettings> = {};
  for (const key of BOOLEAN_KEYS) {
    if (typeof input[key] === "boolean") out[key] = input[key] as boolean;
  }
  if (
    typeof input.defaultQuality === "string" &&
    (DEFAULT_QUALITIES as readonly string[]).includes(input.defaultQuality)
  ) {
    out.defaultQuality = input.defaultQuality as DefaultQuality;
  } else if (input.defaultQuality === "auto") {
    // Pre-ABR-rules builds stored "auto" (start 1080p, adaptive): that is now 1080p + Auto mode.
    out.defaultQuality = DEFAULT_APP_SETTINGS.defaultQuality;
  }
  if (
    typeof input.animatedBackground === "string" &&
    (ANIMATED_BACKGROUND_CHOICES as readonly string[]).includes(input.animatedBackground)
  ) {
    out.animatedBackground = input.animatedBackground as AnimatedBackground;
  }
  for (const key of ["defaultAudioLanguage", "defaultSubtitleLanguage"] as const) {
    if (input[key] === null) {
      out[key] = null;
    } else if (typeof input[key] === "string") {
      const code = normalizeLanguageCode(input[key]);
      if (code !== null && (AUDIO_LANGUAGE_CHOICES as readonly string[]).includes(code)) {
        out[key] = code as AudioLanguageChoice;
      }
    }
  }
  if (input.defaultSubtitleLanguageSetAt === null) out.defaultSubtitleLanguageSetAt = null;
  else if (typeof input.defaultSubtitleLanguageSetAt === "string" && Number.isFinite(Date.parse(input.defaultSubtitleLanguageSetAt))) {
    out.defaultSubtitleLanguageSetAt = input.defaultSubtitleLanguageSetAt;
  }
  if (isTitleLanguage(input.titleLanguage)) out.titleLanguage = input.titleLanguage;
  if (input.libraryView !== undefined) out.libraryView = sanitizeLibraryViewPrefs(input.libraryView);
  return out;
};

/** The playback settings that belong to the profile (ACCT-SQUAD-03); every other setting stays on this device. */
export const PROFILE_APP_SETTING_KEYS = [
  "autoplayNextEpisode",
  "autoSkipIntro",
  "autoSkipCredits",
  "defaultQuality",
  "forceQuality",
  "defaultAudioLanguage",
  "defaultSubtitleLanguage",
  "defaultSubtitleLanguageSetAt",
  "titleLanguage",
] as const satisfies ReadonlyArray<keyof AppSettings>;

export type ProfileAppSettings = Pick<AppSettings, (typeof PROFILE_APP_SETTING_KEYS)[number]>;

const pickProfileFields = (patch: Partial<AppSettings>): Partial<ProfileAppSettings> => {
  const out: Partial<ProfileAppSettings> = {};
  for (const key of PROFILE_APP_SETTING_KEYS) {
    if (patch[key] !== undefined) (out as Record<string, unknown>)[key] = patch[key];
  }
  return out;
};

/** Receives the profile fields of every user edit (`profileSettings.ts` saves them in the active profile). */
let profileEditSink: ((patch: Partial<ProfileAppSettings>) => void) | null = null;

export const setProfileEditSink = (sink: ((patch: Partial<ProfileAppSettings>) => void) | null): void => {
  profileEditSink = sink;
};

let current: AppSettings = DEFAULT_APP_SETTINGS;
let loadPromise: Promise<AppSettings> | null = null;
let loaded = false;
/** Patches applied before the first load finished; they win over stored values. */
let pendingPatch: Partial<AppSettings> = {};
let writeChain: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();

const notify = () => {
  for (const listener of Array.from(listeners)) listener();
};

const persist = (snapshot: AppSettings) => {
  writeChain = writeChain
    .then(() => AsyncStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify(snapshot)))
    .then(() => log.debug("persisted", { ...snapshot }))
    .catch((error) => {
      log.warn("persist.failed", { message: error instanceof Error ? error.message : String(error) });
    });
};

export const getAppSettings = (): AppSettings => current;

export const loadAppSettings = (): Promise<AppSettings> => {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    let stored: Partial<AppSettings> = {};
    try {
      const text = await AsyncStorage.getItem(APP_SETTINGS_STORAGE_KEY);
      if (text) stored = sanitize(JSON.parse(text));
    } catch (error) {
      log.warn("load.failed", { message: error instanceof Error ? error.message : String(error) });
    }
    current = { ...DEFAULT_APP_SETTINGS, ...stored, ...pendingPatch };
    pendingPatch = {};
    loaded = true;
    log.info("loaded", { ...current });
    notify();
    return current;
  })();
  return loadPromise;
};

/** Applies `clean` on screen and in the device copy; returns the fields whose value changed. */
const apply = (clean: Partial<AppSettings>): Partial<AppSettings> => {
  const changed: Partial<AppSettings> = {};
  for (const key of Object.keys(clean) as (keyof AppSettings)[]) {
    if (clean[key] !== current[key]) (changed as Record<string, unknown>)[key] = clean[key];
  }
  if (Object.keys(changed).length === 0) return changed;
  current = { ...current, ...clean };
  notify();
  persist(current);
  return changed;
};

const edit = (patch: Partial<AppSettings>, answer: boolean): void => {
  const clean = sanitize(patch);
  // Choosing on or off (setup step or Settings) is the answer to the error-report question.
  if (clean.errorReports !== undefined) clean.errorReportsDecided = true;
  // Before the first load completes an edit must beat the stored value even if
  // it equals the default, so record it regardless of `changed`.
  if (!loaded) pendingPatch = { ...pendingPatch, ...clean };
  const changed = apply(clean);
  // PLAY-TRACK-11: a subtitle language changed here is newer than every title's choice so far; the profile's own
  // stamp replaces this one at the next load.
  if (changed.defaultSubtitleLanguage !== undefined) apply({ defaultSubtitleLanguageSetAt: new Date().toISOString() });
  const profilePatch = pickProfileFields(answer ? clean : changed);
  if (profileEditSink && Object.keys(profilePatch).length > 0) profileEditSink(profilePatch);
};

/** A user edit (Settings): only the fields whose value changed go to the profile. */
export const updateAppSettings = (patch: Partial<AppSettings>): void => edit(patch, false);

/**
 * UX-SETUP-09: a first-run answer confirmed with Next. Every given profile field goes to the profile even when it
 * equals the value already shown (the preselected default), so the question counts as answered.
 */
export const answerAppSettings = (patch: Partial<AppSettings>): void => edit(patch, true);

/** Shows the active profile's stored playback settings (ACCT-SQUAD-03); unlike a user edit, nothing goes back to the profile. */
export const applyProfileAppSettings = (patch: Partial<ProfileAppSettings>): void => {
  const clean = pickProfileFields(sanitize(patch));
  if (!loaded) pendingPatch = { ...pendingPatch, ...clean };
  const changed = apply(clean);
  if (Object.keys(changed).length > 0) log.info("profile.applied", { ...changed });
};

/** Calls `listener` after every settings change (including the first load); returns the unsubscribe. */
export const subscribeAppSettings = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const useAppSettings = (): [AppSettings, (patch: Partial<AppSettings>) => void] => {
  const settings = useSyncExternalStore(subscribeAppSettings, getAppSettings, getAppSettings);
  return [settings, updateAppSettings];
};

/** Test hook: forget in-memory state so a fresh `loadAppSettings` re-reads storage. */
export const __resetAppSettingsForTests = (): void => {
  current = DEFAULT_APP_SETTINGS;
  loadPromise = null;
  loaded = false;
  pendingPatch = {};
  writeChain = Promise.resolve();
  listeners.clear();
  profileEditSink = null;
};
