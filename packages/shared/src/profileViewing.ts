/**
 * Per-profile viewing state inside the encrypted library (ACCT-SQUAD-02), the pure half.
 *
 * Cross-client contract. The main profile (the account's oldest, `isMain` from
 * `GET /profiles`) keeps the library's own storage: `media_items.progress_pct`, `episode_resume_v1:<id>`,
 * `track_prefs_v1:<id>`, the `playlists` tables. Every other profile keeps the same data under
 * `p:<profileId>:` keys in `app_settings`, written with `setting.set` ops:
 *   p:<pid>:media_progress_v1:<mediaId>   {progressPct, lastWatchedAt, updatedAt}
 *   p:<pid>:episode_resume_v1:<episodeId> same JSON as the main profile's
 *   p:<pid>:track_prefs_v1:<mediaId>      same JSON as the main profile's
 *   p:<pid>:playlist_v1:<playlistId>      {name, slug, isSystem, items: [{mediaId, addedAt}], createdAt, updatedAt}
 * There is no delete op: a deleted entry is overwritten with "" and readers treat "" as absent.
 *
 * Every client that opens the library (phone/TV LibraryDb, the runtime LibraryDb behind desktop) owns its SQL and
 * imports this module for the rest, so a profile's state written on one device reads the same on every other one.
 * Everything here is a pure function so the keying, the merges and the two data moves (wiping a deleted profile,
 * promoting the oldest remaining profile to main) are unit-tested on their own.
 */
import { profileKeyPrefix, type ApiProfile } from "./profiles";
import { PROFILE_SETTINGS_KEY } from "./profileSettings";
import { TRACK_PREFS_KEY_PREFIX } from "./trackPrefs";

/** Main profile's per-episode resume point (`app_settings`), JSON `{progressPct, updatedAt, positionSeconds?, durationSeconds?}`. */
export const EPISODE_RESUME_KEY_PREFIX = "episode_resume_v1:";
/**
 * Resume spot of one edition of a film or episode with two or more editions (PLAY-RESUME-05), same JSON as an episode's.
 * Kept beside the title's own progress (`media_items.progress_pct` / `episode_resume_v1:`), which still drives
 * Continue watching with the edition watched last (PLAY-RESUME-06). "" = cleared (the edition was finished).
 */
export const EDITION_RESUME_KEY_PREFIX = "edition_resume_v1:";

/** A key holding one profile's resume spot (episode or edition), without its `p:<pid>:` prefix. */
export const isResumeSpotKey = (bareKey: string): boolean =>
  bareKey.startsWith(EPISODE_RESUME_KEY_PREFIX) || bareKey.startsWith(EDITION_RESUME_KEY_PREFIX);
export const MEDIA_PROGRESS_KEY_PREFIX = "media_progress_v1:";
export const PLAYLIST_KEY_PREFIX = "playlist_v1:";

/** Clamp + round progress like every LibraryDb `setProgress` (4 decimals, min 0.0001 when > 0). */
export const normalizeProgressPct = (progressPct: number): number => {
  const normalized = Math.max(0, Math.min(100, Number.isFinite(progressPct) ? progressPct : 0));
  return normalized > 0 ? Math.max(0.0001, Math.round(normalized * 10000) / 10000) : 0;
};

/** `p:<profileId>:` prefix of a non-main profile's key, or "" for any other key. */
export const profilePrefixOfKey = (key: string): string => /^p:[^:]+:/.exec(key)?.[0] ?? "";

/**
 * Playback-position settings of any profile: `[p:<pid>:]episode_resume_v1:*` and `[p:<pid>:]media_progress_v1:*`.
 * Only non-main profiles write `media_progress_v1:` (the main profile's title progress travels as `media.progress`),
 * but an unprefixed one is classified the same way. Saved every few seconds while watching, so sync treats them as
 * progress-class (LIB-SYNC-07).
 */
export const isPlaybackProgressSettingKey = (key: string): boolean => {
  const bare = key.slice(profilePrefixOfKey(key).length);
  return isResumeSpotKey(bare) || bare.startsWith(MEDIA_PROGRESS_KEY_PREFIX);
};

/** Ids of the two playlists every profile has, as the main profile has them (`librarySchema.ensureDefaultPlaylists`). */
export const FAVORITES_PLAYLIST_ID = "favorites";
export const WATCHLIST_PLAYLIST_ID = "watchlist";

/** Which profile's viewing state LibraryDb reads and writes. `prefix` "" = the main profile's own storage. */
export type ViewingScope = { profileId: string | null; prefix: string };

export const MAIN_VIEWING_SCOPE: ViewingScope = { profileId: null, prefix: "" };

export const viewingScopeFor = (profile: Pick<ApiProfile, "id" | "isMain"> | null): ViewingScope =>
  profile ? { profileId: profile.id, prefix: profileKeyPrefix(profile) } : MAIN_VIEWING_SCOPE;

export const isMainScope = (scope: ViewingScope) => scope.prefix === "";

export const scopedEpisodeResumeKey = (scope: ViewingScope, episodeId: string) =>
  `${scope.prefix}${EPISODE_RESUME_KEY_PREFIX}${episodeId}`;
export const scopedEditionResumeKey = (scope: ViewingScope, editionId: string) =>
  `${scope.prefix}${EDITION_RESUME_KEY_PREFIX}${editionId}`;
export const scopedTrackPrefsKey = (scope: ViewingScope, mediaId: string) => `${scope.prefix}${TRACK_PREFS_KEY_PREFIX}${mediaId}`;
export const scopedMediaProgressKey = (scope: ViewingScope, mediaId: string) =>
  `${scope.prefix}${MEDIA_PROGRESS_KEY_PREFIX}${mediaId}`;
export const scopedPlaylistKey = (scope: ViewingScope, playlistId: string) => `${scope.prefix}${PLAYLIST_KEY_PREFIX}${playlistId}`;

export type MediaProgress = { progressPct: number; lastWatchedAt: string | null; updatedAt: string };

export const buildMediaProgressValue = (input: MediaProgress): string =>
  JSON.stringify({
    progressPct: normalizeProgressPct(input.progressPct),
    lastWatchedAt: input.lastWatchedAt,
    updatedAt: input.updatedAt,
  });

export const parseMediaProgressValue = (raw: string | null | undefined): MediaProgress | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const pct = Number(parsed.progressPct);
    if (!Number.isFinite(pct)) return null;
    return {
      progressPct: Math.max(0, Math.min(100, pct)),
      lastWatchedAt: typeof parsed.lastWatchedAt === "string" && parsed.lastWatchedAt !== "" ? parsed.lastWatchedAt : null,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
    };
  } catch {
    return null;
  }
};

/** `media_progress_v1` rows of one profile by media id (rows of other keys are skipped). */
export const collectMediaProgress = (scope: ViewingScope, rows: ReadonlyArray<{ key: string; value: string | null }>) => {
  const prefix = `${scope.prefix}${MEDIA_PROGRESS_KEY_PREFIX}`;
  const result = new Map<string, MediaProgress>();
  for (const row of rows) {
    if (!row.key.startsWith(prefix)) continue;
    const parsed = parseMediaProgressValue(row.value);
    if (parsed) result.set(row.key.slice(prefix.length), parsed);
  }
  return result;
};

/**
 * Replaces the main profile's progress on library rows with a non-main profile's own: a title the profile never
 * started reads as not started (0, never watched), whatever the main profile did with it.
 */
export const overlayProfileProgress = <T extends { id: string; progressPct: number; lastWatchedAt: string | null }>(
  rows: readonly T[],
  progress: ReadonlyMap<string, MediaProgress>,
): T[] =>
  rows.map((row) => {
    const own = progress.get(row.id);
    return { ...row, progressPct: own?.progressPct ?? 0, lastWatchedAt: own?.lastWatchedAt ?? null };
  });

// ---------------------------------------------------------------------------------------------------------------
// Playlists of a non-main profile
// ---------------------------------------------------------------------------------------------------------------

export type ProfilePlaylist = {
  name: string;
  slug: string | null;
  isSystem: boolean;
  items: Array<{ mediaId: string; addedAt: string }>;
  createdAt: string;
  updatedAt: string;
};

export type PlaylistRow = { id: string; name: string; slug: string | null; isSystem: boolean; createdAt: string };

export const parseProfilePlaylist = (raw: string | null | undefined): ProfilePlaylist | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const items = Array.isArray(parsed.items)
      ? parsed.items.flatMap((item) => {
          if (typeof item !== "object" || item === null) return [];
          const { mediaId, addedAt } = item as Record<string, unknown>;
          return typeof mediaId === "string" && mediaId !== ""
            ? [{ mediaId, addedAt: typeof addedAt === "string" ? addedAt : "" }]
            : [];
        })
      : [];
    return {
      name: typeof parsed.name === "string" ? parsed.name : "",
      slug: typeof parsed.slug === "string" && parsed.slug !== "" ? parsed.slug : null,
      isSystem: parsed.isSystem === true,
      items,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
    };
  } catch {
    return null;
  }
};

export const serializeProfilePlaylist = (playlist: ProfilePlaylist): string => JSON.stringify(playlist);

/** The two playlists a profile has before it ever wrote one (same names and flags as the main profile's). */
export const defaultProfilePlaylist = (playlistId: string, now: string): ProfilePlaylist | null => {
  if (playlistId === FAVORITES_PLAYLIST_ID) {
    return { name: "Favorites", slug: "favorites", isSystem: true, items: [], createdAt: "", updatedAt: now };
  }
  if (playlistId === WATCHLIST_PLAYLIST_ID) {
    return { name: "Watchlist", slug: "watchlist", isSystem: false, items: [], createdAt: "", updatedAt: now };
  }
  return null;
};

/** Every live playlist of a non-main profile: stored ones plus the default favorites/watchlist when never written. */
export const listProfilePlaylists = (
  scope: ViewingScope,
  rows: ReadonlyArray<{ key: string; value: string | null }>,
): Array<PlaylistRow & { items: ProfilePlaylist["items"] }> => {
  const prefix = `${scope.prefix}${PLAYLIST_KEY_PREFIX}`;
  const seen = new Set<string>();
  const result: Array<PlaylistRow & { items: ProfilePlaylist["items"] }> = [];
  for (const row of rows) {
    if (!row.key.startsWith(prefix)) continue;
    const id = row.key.slice(prefix.length);
    if (id === "") continue;
    seen.add(id);
    const playlist = parseProfilePlaylist(row.value);
    if (!playlist) continue; // "" = deleted
    result.push({ id, name: playlist.name, slug: playlist.slug, isSystem: playlist.isSystem, createdAt: playlist.createdAt, items: playlist.items });
  }
  for (const id of [FAVORITES_PLAYLIST_ID, WATCHLIST_PLAYLIST_ID]) {
    if (seen.has(id)) continue;
    const fallback = defaultProfilePlaylist(id, "");
    if (fallback) result.push({ id, name: fallback.name, slug: fallback.slug, isSystem: fallback.isSystem, createdAt: "", items: [] });
  }
  return result.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
};

export const addProfilePlaylistItem = (playlist: ProfilePlaylist, mediaId: string, now: string): ProfilePlaylist =>
  playlist.items.some((item) => item.mediaId === mediaId)
    ? playlist
    : { ...playlist, items: [...playlist.items, { mediaId, addedAt: now }], updatedAt: now };

export const removeProfilePlaylistItem = (playlist: ProfilePlaylist, mediaId: string, now: string): ProfilePlaylist => ({
  ...playlist,
  items: playlist.items.filter((item) => item.mediaId !== mediaId),
  updatedAt: now,
});

// ---------------------------------------------------------------------------------------------------------------
// Data moves
// ---------------------------------------------------------------------------------------------------------------

/** Every key of a deleted non-main profile, to overwrite with "" (no delete op exists). Already-blank keys are skipped. */
export const planProfileWipe = (profileId: string, rows: ReadonlyArray<{ key: string; value: string | null }>): string[] => {
  const prefix = `p:${profileId}:`;
  return rows.filter((row) => row.key.startsWith(prefix) && row.value !== "" && row.value !== null).map((row) => row.key);
};

/**
 * ACCT-PROF-02: the profile ids that still hold viewing data under their own `p:<profileId>:` prefix (blank keys are
 * deleted ones). An id the API no longer lists belongs to a profile deleted elsewhere (the website), whose data the
 * next app to open the library erases with `planProfileWipe`.
 */
export const viewingProfileIds = (rows: ReadonlyArray<{ key: string; value: string | null }>): string[] => {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.value === "" || row.value === null) continue;
    const id = /^p:([^:]+):/.exec(row.key)?.[1];
    if (id) ids.add(id);
  }
  return [...ids].sort();
};

/**
 * LIB-OPS-02 for the per-profile keys of a deleted media: every non-main profile's progress, track choices and
 * resume points of its episodes are overwritten with "" and the media leaves every profile playlist that holds it
 * (no delete op exists; the writes travel as `setting.set` ops). `rows` are the `p:%` rows of `app_settings`; already
 * blank keys are skipped. The main profile's rows (progress, playlist entries) go with the `media.delete` statements;
 * its `episode_resume_v1:` / `track_prefs_v1:` settings are left by every delete path today (LIB-OPS-02 notes).
 */
export const planMediaDeleteProfileCleanup = (input: {
  mediaId: string;
  episodeIds: readonly string[];
  rows: ReadonlyArray<{ key: string; value: string | null }>;
  now: string;
}): Array<{ key: string; value: string }> => {
  const { mediaId, now } = input;
  const episodes = new Set(input.episodeIds);
  const writes: Array<{ key: string; value: string }> = [];
  for (const row of input.rows) {
    if (row.value === "" || row.value === null) continue;
    // The part of a non-main profile's key after `p:<profileId>:`; any other key is the main profile's.
    const rest = /^p:[^:]+:(.*)$/.exec(row.key)?.[1];
    if (rest === undefined) continue;
    if (
      rest === `${MEDIA_PROGRESS_KEY_PREFIX}${mediaId}` ||
      rest === `${TRACK_PREFS_KEY_PREFIX}${mediaId}` ||
      (rest.startsWith(EPISODE_RESUME_KEY_PREFIX) && episodes.has(rest.slice(EPISODE_RESUME_KEY_PREFIX.length)))
    ) {
      writes.push({ key: row.key, value: "" });
      continue;
    }
    if (!rest.startsWith(PLAYLIST_KEY_PREFIX)) continue;
    const playlist = parseProfilePlaylist(row.value);
    if (!playlist?.items.some((item) => item.mediaId === mediaId)) continue;
    writes.push({ key: row.key, value: serializeProfilePlaylist(removeProfilePlaylistItem(playlist, mediaId, now)) });
  }
  return writes;
};

export type MainPlaylistState = { id: string; slug: string | null; isSystem: boolean; mediaIds: string[] };

/**
 * Library setting naming the profile whose state the library's own storage holds, written last by every promotion.
 * Absent on libraries that never had one: their storage is the original (oldest) profile's.
 */
export const MAIN_PROFILE_SETTING_KEY = "profiles_main_v1";

export type PromotionPlan = {
  /** `setting.set` writes: clears of the old main's keys and the new main's entries. */
  settings: Array<{ key: string; value: string }>;
  /** `media.progress` writes on `media_items` (0 / null clears the old main's progress). */
  progress: Array<{ mediaId: string; progressPct: number; lastWatchedAt: string | null }>;
  /** Playlist changes on the library's own tables. */
  playlistDeletes: string[];
  playlistItemRemoves: Array<{ playlistId: string; mediaId: string }>;
  playlistCreates: Array<{ key: string; name: string; slug: string | null; isSystem: boolean; mediaIds: string[] }>;
  playlistItemAdds: Array<{ playlistId: string; mediaId: string }>;
  /**
   * `setting.set` writes made after all of the above: blanks of the new main's `p:` keys, then
   * `MAIN_PROFILE_SETTING_KEY`. A move cut short keeps the new main's state and no marker, so it reruns whole.
   */
  finish: Array<{ key: string; value: string }>;
};

/** A promotion with nothing to do: what a repeat of a finished move returns. */
export const emptyPromotionPlan = (): PromotionPlan => ({
  settings: [],
  progress: [],
  playlistDeletes: [],
  playlistItemRemoves: [],
  playlistCreates: [],
  playlistItemAdds: [],
  finish: [],
});

/**
 * True when `mainId` is main but its move into the library's own storage never finished (the deleting device went
 * offline or closed the library halfway): its `p:<mainId>:` keys still hold state and the library does not name it
 * as main. A finished move named it, so later writes from a device with a stale list never trigger a second move.
 */
export const needsMainPromotion = (mainId: string, settingRows: ReadonlyArray<{ key: string; value: string | null }>): boolean => {
  const prefix = `p:${mainId}:`;
  const marker = settingRows.find((row) => row.key === MAIN_PROFILE_SETTING_KEY)?.value ?? null;
  return marker !== mainId && settingRows.some((row) => row.key.startsWith(prefix) && Boolean(row.value));
};

/**
 * ACCT-PROF-02: the main profile was deleted, the oldest remaining profile becomes main, and "main" says where a
 * profile's data is stored. So the new main's `p:<id>:` state moves into the library's own storage, replacing the
 * deleted main profile's, and its `p:` keys are blanked.
 *
 * `settingRows`: every `app_settings` row (both the old main's unprefixed keys and the new main's prefixed ones).
 * `mainProgress`: media ids whose `media_items` progress or last-watched is set. `mainPlaylists`: the library's
 * playlists with their items. The favorites/watchlist rows are kept (emptied and refilled) so their ids, which
 * other devices hold, stay valid.
 */
export const planMainPromotion = (input: {
  newMainId: string;
  settingRows: ReadonlyArray<{ key: string; value: string | null }>;
  mainProgress: ReadonlyArray<{ mediaId: string; progressPct: number; lastWatchedAt: string | null }>;
  mainPlaylists: ReadonlyArray<MainPlaylistState>;
}): PromotionPlan => {
  const scope: ViewingScope = { profileId: input.newMainId, prefix: `p:${input.newMainId}:` };
  const plan = emptyPromotionPlan();
  const settings = new Map<string, string>();
  const blanks: string[] = [];

  // 1. Clear the deleted main profile's own state.
  for (const row of input.settingRows) {
    if (row.key.startsWith("p:")) continue;
    const owned =
      isResumeSpotKey(row.key) || row.key.startsWith(TRACK_PREFS_KEY_PREFIX) || row.key === PROFILE_SETTINGS_KEY;
    if (owned && row.value) settings.set(row.key, "");
  }
  const progress = new Map<string, { progressPct: number; lastWatchedAt: string | null }>();
  for (const entry of input.mainProgress) {
    if (entry.progressPct > 0 || entry.lastWatchedAt) progress.set(entry.mediaId, { progressPct: 0, lastWatchedAt: null });
  }
  const systemIds = new Map<string, string>();
  for (const playlist of input.mainPlaylists) {
    if (playlist.slug === FAVORITES_PLAYLIST_ID || playlist.slug === WATCHLIST_PLAYLIST_ID) {
      systemIds.set(playlist.slug, playlist.id);
      for (const mediaId of playlist.mediaIds) plan.playlistItemRemoves.push({ playlistId: playlist.id, mediaId });
    } else {
      plan.playlistDeletes.push(playlist.id);
    }
  }

  // 2. Move the new main profile's state in, then blank its prefixed keys.
  for (const row of input.settingRows) {
    if (!row.key.startsWith(scope.prefix)) continue;
    if (!row.value) continue;
    blanks.push(row.key);
    const bare = row.key.slice(scope.prefix.length);
    if (isResumeSpotKey(bare) || bare.startsWith(TRACK_PREFS_KEY_PREFIX) || bare === PROFILE_SETTINGS_KEY) {
      settings.set(bare, row.value);
    } else if (bare.startsWith(MEDIA_PROGRESS_KEY_PREFIX)) {
      const parsed = parseMediaProgressValue(row.value);
      if (parsed) progress.set(bare.slice(MEDIA_PROGRESS_KEY_PREFIX.length), { progressPct: parsed.progressPct, lastWatchedAt: parsed.lastWatchedAt });
    }
  }
  for (const playlist of listProfilePlaylists(scope, input.settingRows)) {
    const mediaIds = playlist.items.map((item) => item.mediaId);
    const systemId = playlist.slug ? systemIds.get(playlist.slug) : undefined;
    if (systemId) {
      for (const mediaId of mediaIds) plan.playlistItemAdds.push({ playlistId: systemId, mediaId });
    } else if (playlist.id !== FAVORITES_PLAYLIST_ID && playlist.id !== WATCHLIST_PLAYLIST_ID) {
      plan.playlistCreates.push({ key: playlist.id, name: playlist.name, slug: playlist.slug, isSystem: playlist.isSystem, mediaIds });
    } else if (mediaIds.length > 0) {
      // The library has no favorites/watchlist row yet (never initialised here): create it with its items.
      plan.playlistCreates.push({ key: playlist.id, name: playlist.name, slug: playlist.slug, isSystem: playlist.isSystem, mediaIds });
    }
  }

  plan.settings = [...settings].map(([key, value]) => ({ key, value }));
  plan.finish = [...blanks.map((key) => ({ key, value: "" })), { key: MAIN_PROFILE_SETTING_KEY, value: input.newMainId }];
  plan.progress = [...progress].map(([mediaId, value]) => ({ mediaId, ...value }));
  return plan;
};
