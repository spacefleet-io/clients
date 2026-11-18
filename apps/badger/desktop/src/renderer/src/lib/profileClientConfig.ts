/**
 * ACCT-SQUAD-03: the playback settings belong to the profile, the rest of `ClientConfig` to the account. The app
 * language is neither: it is the account's own language (`/auth/me`, `@space/shared/accountLanguage`), shown by this
 * computer from its local config, so a profile switch never changes it.
 * The renderer keeps one composed `ClientConfig` (localStorage `sf_client_config_v1`, read by every screen);
 * the library stores its two halves apart:
 *   client_config_v1                 the account's settings, shared by every profile (the profile fields in it are only
 *                                    the account-wide values from before profiles had their own, used to seed them)
 *   [p:<pid>:]profile_settings_v1    one profile's settings (`@space/shared/profileSettings`, same key on phone and TV);
 *                                    the main profile keeps the unprefixed key, like its track choices
 * A profile with no stored value for a field starts from the account-wide value, so nobody loses a setting (except
 * `titleLanguage`, ACCT-PROF-03, which the profile answers itself). The seed is
 * stamped `profileSettingsSeedAt` (the epoch, or the value's `resetAt` after a main-profile promotion so the reset does
 * not drop it), row and op included, so the profile's real record wins when it arrives later, however old. A save
 * stamps only the fields the user changed: the library merges field by field.
 *
 * The capacity settings (`DEVICE_CAPACITY_FIELDS`: parallel transcodes, parallel extractions, watched folders, and the
 * download file format of OFFL-FILE-01) are this computer's (ACCT-SQUAD-03, Chris 2026-10-30): kept in `<userData>/device-settings.json` through
 * `DeviceCapacityStore`, copied there once from the values this computer showed, and never written to
 * `client_config_v1` again. The values already in `client_config_v1` stay as they are, so a desktop on an older
 * build keeps reading its own.
 */
import {
  isAudioLanguageChoice,
  mergeProfileSettings,
  profileSettingsSeedAt,
  readProfileSettingsRow,
  scopedProfileSettingsKey,
  serializeProfileSettings,
  type ProfileSettings,
  type ProfileSettingsPatch,
} from "@space/shared/profileSettings";
import { viewingScopeFor } from "@space/shared/profileViewing";
import { isTitleLanguage } from "@space/shared/titleLanguage";
import { coerceClientConfig, isQualityPreset, type ClientConfig } from "./config";
import { DEVICE_CAPACITY_FIELDS, type DeviceCapacityValues } from "../../../shared/deviceCapacity";

export const CLIENT_CONFIG_SETTING_KEY = "client_config_v1";

/** The `ClientConfig` fields a profile owns (ACCT-SQUAD-03); every other field is the account's or this computer's. */
export const PROFILE_CLIENT_CONFIG_FIELDS = [
  "playbackQuality",
  "forcePlaybackQuality",
  "autoplayNextEpisode",
  "introSkipEnabled",
  "creditsSkipEnabled",
  "skipMode",
  "defaultAudioLanguage",
  "defaultSubtitleLanguage",
  "titleLanguage",
] as const;

type ProfileClientConfig = Pick<ClientConfig, (typeof PROFILE_CLIENT_CONFIG_FIELDS)[number]>;

export type ClientConfigSettingsStore = {
  getSetting(key: string): Promise<{ value: string; updatedAt: string } | null | undefined>;
  /** `updatedAt`: the row and op time; the runtime stamps now when absent. */
  setSetting(key: string, value: string, updatedAt?: string): Promise<unknown>;
};

export type ActiveProfile = { id: string; isMain: boolean };

/** This computer's capacity settings (main/deviceSettings.ts through the `deviceSettings` bridge). */
export type DeviceCapacityStore = {
  /** Stores `seed` unless this computer already has values; returns this computer's values. */
  adoptCapacity(seed: DeviceCapacityValues): Promise<DeviceCapacityValues>;
  setCapacity(values: DeviceCapacityValues): Promise<unknown>;
};

const deviceFieldsOf = (config: DeviceCapacityValues): DeviceCapacityValues => ({
  maxParallelTranscodes: config.maxParallelTranscodes,
  maxParallelExtractions: config.maxParallelExtractions,
  watchedDirectories: config.watchedDirectories,
  offlineExportFormat: config.offlineExportFormat,
});

/** `config` as it may go to `client_config_v1`: without this computer's capacity settings. */
const withoutDeviceFields = (config: ClientConfig): Partial<ClientConfig> =>
  Object.fromEntries(Object.entries(config).filter(([key]) => !(DEVICE_CAPACITY_FIELDS as readonly string[]).includes(key)));

const profileFieldsOf = (config: ClientConfig): ProfileClientConfig => ({
  playbackQuality: config.playbackQuality,
  forcePlaybackQuality: config.forcePlaybackQuality,
  autoplayNextEpisode: config.autoplayNextEpisode,
  introSkipEnabled: config.introSkipEnabled,
  creditsSkipEnabled: config.creditsSkipEnabled,
  skipMode: config.skipMode,
  defaultAudioLanguage: config.defaultAudioLanguage,
  defaultSubtitleLanguage: config.defaultSubtitleLanguage,
  titleLanguage: config.titleLanguage,
});

/** The desktop fields in the shared shape (the phone names some of them differently). */
const toProfileSettings = (fields: ProfileClientConfig): ProfileSettingsPatch => ({
  quality: fields.playbackQuality,
  forceQuality: fields.forcePlaybackQuality,
  autoplayNextEpisode: fields.autoplayNextEpisode,
  autoSkipIntro: fields.introSkipEnabled,
  autoSkipCredits: fields.creditsSkipEnabled,
  skipMode: fields.skipMode,
  audioLanguage: fields.defaultAudioLanguage,
  subtitleLanguage: fields.defaultSubtitleLanguage,
  // Unset (null) is never written: "never answered" stays distinct from "app" (`needsTitleLanguageQuestion`).
  ...(fields.titleLanguage ? { titleLanguage: fields.titleLanguage } : {}),
});

/** `config` with every field the profile has stored; a field it has not stored keeps `config`'s value. */
const applyProfileSettings = (config: ClientConfig, settings: ProfileSettings): ClientConfig => ({
  ...config,
  ...(isQualityPreset(settings.quality) ? { playbackQuality: settings.quality } : {}),
  ...(typeof settings.forceQuality === "boolean" ? { forcePlaybackQuality: settings.forceQuality } : {}),
  ...(typeof settings.autoplayNextEpisode === "boolean" ? { autoplayNextEpisode: settings.autoplayNextEpisode } : {}),
  ...(typeof settings.autoSkipIntro === "boolean" ? { introSkipEnabled: settings.autoSkipIntro } : {}),
  ...(typeof settings.autoSkipCredits === "boolean" ? { creditsSkipEnabled: settings.autoSkipCredits } : {}),
  ...(settings.skipMode === "auto" || settings.skipMode === "manual" ? { skipMode: settings.skipMode } : {}),
  // null = Original; a code outside the offered choices (written by a newer client) is not shown.
  ...(settings.audioLanguage === null || isAudioLanguageChoice(settings.audioLanguage)
    ? { defaultAudioLanguage: settings.audioLanguage }
    : {}),
  // null = no preference; a code outside the offered choices is not shown.
  ...(settings.subtitleLanguage === null || isAudioLanguageChoice(settings.subtitleLanguage)
    ? { defaultSubtitleLanguage: settings.subtitleLanguage }
    : {}),
  // ACCT-PROF-03: never the account's or this computer's value; a profile that never answered reads as "app".
  titleLanguage: isTitleLanguage(settings.titleLanguage) ? settings.titleLanguage : null,
});

const profileSettingsKey = (profile: ActiveProfile) => scopedProfileSettingsKey(viewingScopeFor(profile));

const readAccountConfig = async (db: ClientConfigSettingsStore): Promise<ClientConfig | null> =>
  (await readAccountRow(db))?.config ?? null;

/** `client_config_v1` coerced, plus the capacity fields exactly as an older build left them (none on a newer blob). */
const readAccountRow = async (
  db: ClientConfigSettingsStore,
): Promise<{ config: ClientConfig; legacyCapacity: Partial<DeviceCapacityValues> } | null> => {
  const stored = await db.getSetting(CLIENT_CONFIG_SETTING_KEY);
  if (!stored?.value) return null;
  try {
    const raw: unknown = JSON.parse(stored.value);
    const legacyCapacity =
      raw && typeof raw === "object"
        ? Object.fromEntries(Object.entries(raw).filter(([key]) => (DEVICE_CAPACITY_FIELDS as readonly string[]).includes(key)))
        : {};
    return { config: { ...coerceClientConfig(raw), configured: true }, legacyCapacity };
  } catch {
    return null;
  }
};

/** A blank row (a wipe, or a promoted profile that had no settings) reads as an empty set reset at the row's time. */
const readProfileSettings = async (db: ClientConfigSettingsStore, profile: ActiveProfile) => {
  const row = await db.getSetting(profileSettingsKey(profile));
  return row ? readProfileSettingsRow(row.value, row.updatedAt) : null;
};

/**
 * The config to show: the library's account settings with the active profile's settings and this computer's capacity
 * settings on top. With no profile picked, the profile fields stay as `local` has them. A profile missing some fields
 * gets them from the account-wide values and they are written to its key, so the seed is taken once. This computer's
 * capacity settings are copied once from the values `client_config_v1` holds (the ones an older build applied here);
 * without a `device` store they stay as `local` has them. The app language stays as `local` has it: it is the
 * account's (applied from `/auth/me`), never the library's or a profile's.
 */
export const loadComposedClientConfig = async ({
  db,
  profile,
  local,
  device,
}: {
  db: ClientConfigSettingsStore;
  profile: ActiveProfile | null;
  local: ClientConfig;
  device?: DeviceCapacityStore;
}): Promise<ClientConfig> => {
  let account = await readAccountConfig(db);
  if (!account) {
    if (local.configured) await db.setSetting(CLIENT_CONFIG_SETTING_KEY, JSON.stringify(withoutDeviceFields(local)));
    account = local;
  }
  const own = device
    ? deviceFieldsOf(await device.adoptCapacity(deviceFieldsOf(account)))
    : deviceFieldsOf(local);
  return { ...(await composeProfile(db, profile, account, local)), ...own, uiLanguage: local.uiLanguage };
};

const composeProfile = async (
  db: ClientConfigSettingsStore,
  profile: ActiveProfile | null,
  account: ClientConfig,
  local: ClientConfig,
): Promise<ClientConfig> => {
  if (!profile) return { ...account, ...profileFieldsOf(local) };
  const stored = await readProfileSettings(db, profile);
  // `titleLanguage` is never seeded (ACCT-PROF-03): another profile's choice must not become this one's.
  const { titleLanguage: _unseeded, ...accountValues } = toProfileSettings(profileFieldsOf(account));
  const missing = Object.entries(accountValues).filter(([key]) => stored?.[key] === undefined);
  if (stored && missing.length === 0) return applyProfileSettings(account, stored);
  const seeded = mergeProfileSettings(stored, Object.fromEntries(missing), profileSettingsSeedAt(stored));
  await db.setSetting(profileSettingsKey(profile), serializeProfileSettings(seeded), seeded.updatedAt);
  return applyProfileSettings(account, seeded);
};

/**
 * Saves a changed config: the capacity settings to this computer's `device` store when they changed, the account half
 * to `client_config_v1` (its profile fields keep the account-wide values already stored there, its capacity fields
 * whatever an older build left there) and, when a profile is picked, the fields the user changed since `previous` (the config shown
 * before this save) to that profile's key, stamped now; the other fields keep their value and time, so another
 * device's newer edit not shown here yet is never overwritten. Without `previous`, the fields that differ from the
 * stored record are saved. Unchanged halves are not written.
 */
export const persistComposedClientConfig = async ({
  db,
  profile,
  config,
  previous,
  device,
}: {
  db: ClientConfigSettingsStore;
  profile: ActiveProfile | null;
  config: ClientConfig;
  previous?: ClientConfig;
  device?: DeviceCapacityStore;
}): Promise<void> => {
  const capacity = deviceFieldsOf(config);
  if (device && (!previous || JSON.stringify(deviceFieldsOf(previous)) !== JSON.stringify(capacity))) {
    await device.setCapacity(capacity);
  }
  const row = await readAccountRow(db);
  const account = row ? { ...withoutDeviceFields(row.config), ...row.legacyCapacity } : null;
  const nextAccount = {
    ...withoutDeviceFields(config),
    ...(profile && row ? profileFieldsOf(row.config) : {}),
    ...row?.legacyCapacity,
  };
  if (!account || JSON.stringify(account) !== JSON.stringify({ ...nextAccount, configured: true })) {
    await db.setSetting(CLIENT_CONFIG_SETTING_KEY, JSON.stringify(nextAccount));
  }
  if (!profile) return;
  const stored = await readProfileSettings(db, profile);
  const own = toProfileSettings(profileFieldsOf(config));
  const shown = previous ? toProfileSettings(profileFieldsOf(previous)) : stored;
  const patch = Object.fromEntries(
    Object.entries(own).filter(([key, value]) => shown?.[key as keyof ProfileSettingsPatch] !== value),
  );
  if (Object.keys(patch).length === 0) return;
  const merged = mergeProfileSettings(stored, patch, new Date().toISOString());
  await db.setSetting(profileSettingsKey(profile), serializeProfileSettings(merged), merged.updatedAt);
};
