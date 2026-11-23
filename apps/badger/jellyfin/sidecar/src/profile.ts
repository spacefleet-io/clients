import type { MediaDetails, MediaRow } from "@space/shared/libraryTypes";
import { profileKeyPrefix, type ApiProfile, type ProfilesResponse } from "@space/shared/profiles";
import { airDateToday, showEpisodeTotal, showWatchedPct } from "@space/shared/showProgress";
import { mergeTrackPrefs, parseTrackPrefs, serializeTrackPrefs, TRACK_PREFS_KEY_PREFIX, type TrackPrefs, type TrackPrefsPatch } from "@space/shared/trackPrefs";

/**
 * The one profile the Jellyfin plugin follows (INTG-PROF-01), and that profile's viewing keys.
 *
 * Contract: the main profile (`isMain`, the account's oldest) keeps the
 * library's own storage (`media_items.progress_pct`, `episode_resume_v1:<episodeId>`, `track_prefs_v1:<mediaId>`);
 * any other profile keeps the same values in `app_settings` under `p:<profileId>:` keys written with `setting.set`:
 *   p:<pid>:media_progress_v1:<mediaId>   {progressPct, lastWatchedAt, updatedAt} (movie, or a show's aggregate)
 *   p:<pid>:episode_resume_v1:<episodeId> same JSON as the main profile's
 *   p:<pid>:track_prefs_v1:<mediaId>      same JSON as the main profile's
 * A missing key or "" means not started; a non-main profile never falls back to the main profile's values.
 */

export const EPISODE_RESUME_KEY_PREFIX = "episode_resume_v1:";
export const MEDIA_PROGRESS_KEY_PREFIX = "media_progress_v1:";

/** The stored choice (`profile.json`). `prefix` is recomputed from every fresh `GET /profiles` (isMain can move). */
export type ChosenProfile = { id: string; name: string; prefix: string };

export const chosenProfileOf = (profile: ApiProfile): ChosenProfile => ({ id: profile.id, name: profile.name, prefix: profileKeyPrefix(profile) });

/** `GET /profiles` with the device's session token (paired devices included). */
export const fetchProfiles = async (apiUrl: string, token: string): Promise<ApiProfile[]> => {
  const res = await fetch(`${apiUrl}/profiles`, { headers: { Authorization: `Bearer ${token}`, "x-space-app": "badger" } });
  const body = (await res.json().catch(() => null)) as Partial<ProfilesResponse> | null;
  if (!res.ok || !body || !Array.isArray(body.profiles)) {
    throw Object.assign(new Error(`profiles_unavailable_${res.status}`), { status: res.status });
  }
  return body.profiles;
};

export type ProfileFollow =
  /** The chosen profile is listed; `profile` carries its current name and prefix. */
  | { kind: "listed"; profile: ChosenProfile; changed: boolean; prefixChanged: boolean }
  /** Not in the list: deleted elsewhere. The caller never switches; it pauses viewing state until the owner picks (INTG-PROF-01). */
  | { kind: "missing" };

/** Follows the stored choice through a fresh profile list. */
export const followChosenProfile = (stored: ChosenProfile, profiles: readonly ApiProfile[]): ProfileFollow => {
  const listed = profiles.find((entry) => entry.id === stored.id);
  if (!listed) return { kind: "missing" };
  const profile = chosenProfileOf(listed);
  return { kind: "listed", profile, changed: profile.name !== stored.name || profile.prefix !== stored.prefix, prefixChanged: profile.prefix !== stored.prefix };
};

// --- viewing state ---------------------------------------------------------

type Setting = { value: string | null; updatedAt?: string | null } | null | undefined;

/** What the viewing reads need from the library (LibraryDb, or a fake in tests). */
export type ViewingReader = {
  getSetting(key: string): Setting;
};

/** What the viewing writes need from the library. */
export type ViewingStore = ViewingReader & {
  getMediaDetails(mediaId: string): MediaDetails | null;
  setSetting(key: string, value: string): unknown;
  setProgress(
    mediaId: string,
    progressPct: number,
    episodeId?: string | null,
    timing?: { positionSeconds?: number | null; durationSeconds?: number | null } | null
  ): unknown;
  setTrackPrefs(mediaId: string, patch: TrackPrefsPatch): unknown;
};

/** Same rounding as the library's own `setProgress` (and the phone's `normalizeProgressPct`). */
const normalizePct = (progressPct: number) => {
  const normalized = Math.max(0, Math.min(100, Number.isFinite(progressPct) ? progressPct : 0));
  return normalized > 0 ? Math.max(0.0001, Math.round(normalized * 10000) / 10000) : 0;
};

const nowIso = () => new Date().toISOString();

/** The profile's resume entry of one episode (raw setting, "" = absent). */
export const readEpisodeResumeSetting = (reader: ViewingReader, prefix: string, episodeId: string) =>
  reader.getSetting(`${prefix}${EPISODE_RESUME_KEY_PREFIX}${episodeId}`);

/** Progress of a movie for the profile: the row for the main profile, else its own `media_progress_v1` key. */
export const readMediaProgress = (
  reader: ViewingReader,
  prefix: string,
  row: Pick<MediaRow, "id" | "progressPct" | "lastWatchedAt">
): { progressPct: number; lastWatchedAt: string | null } => {
  if (prefix === "") return { progressPct: row.progressPct, lastWatchedAt: row.lastWatchedAt };
  const raw = reader.getSetting(`${prefix}${MEDIA_PROGRESS_KEY_PREFIX}${row.id}`)?.value;
  if (!raw) return { progressPct: 0, lastWatchedAt: null };
  try {
    const parsed = JSON.parse(raw) as { progressPct?: unknown; lastWatchedAt?: unknown };
    const pct = Number(parsed.progressPct);
    return {
      progressPct: Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0,
      lastWatchedAt: typeof parsed.lastWatchedAt === "string" && parsed.lastWatchedAt !== "" ? parsed.lastWatchedAt : null,
    };
  } catch {
    return { progressPct: 0, lastWatchedAt: null };
  }
};

/** The profile's audio/subtitle choice (PLAY-TRACK-04): `track_prefs_v1:` for the main profile, `p:<id>:track_prefs_v1:` otherwise. */
export const readTrackPrefs = (reader: ViewingReader, prefix: string, mediaId: string): TrackPrefs | null =>
  parseTrackPrefs(reader.getSetting(`${prefix}${TRACK_PREFS_KEY_PREFIX}${mediaId}`)?.value);

export type ProgressInput = {
  mediaId: string;
  episodeId: string | null;
  progressPct: number;
  positionSeconds?: number | null;
  durationSeconds?: number | null;
};

/**
 * LIB-PROG-01 for a non-main profile: its regular episodes' watched parts (its own `episode_resume_v1` keys) over every
 * aired episode, like the library's own aggregate for the main profile.
 */
const profileShowAggregate = (store: ViewingStore, prefix: string, details: MediaDetails, now: string) => {
  const episodes = details.episodes.map((episode) => ({ seasonNumber: episode.seasonNumber, airDate: episode.airDate }));
  const total = showEpisodeTotal({ episodes, totalEpisodes: details.totalEpisodes, today: airDateToday() });
  if (!total) return { progressPct: 0, lastWatchedAt: now };
  const watched: Array<{ seasonNumber: number; progressPct: number }> = [];
  let latest: string | null = null;
  for (const episode of details.episodes) {
    const raw = readEpisodeResumeSetting(store, prefix, episode.id)?.value;
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as { progressPct?: unknown; updatedAt?: unknown };
      const pct = Number(parsed.progressPct);
      if (!Number.isFinite(pct)) continue;
      watched.push({ seasonNumber: episode.seasonNumber, progressPct: pct });
      if (typeof parsed.updatedAt === "string" && (!latest || parsed.updatedAt > latest)) latest = parsed.updatedAt;
    } catch {
      // unreadable entry: not started
    }
  }
  return { progressPct: showWatchedPct(watched, total.total), lastWatchedAt: latest ?? now };
};

/** Resume / watched write for the profile: the library's own `setProgress` for main, `p:<id>:` settings otherwise. */
export const writeProgress = async (store: ViewingStore, prefix: string, input: ProgressInput) => {
  const timing = { positionSeconds: input.positionSeconds ?? null, durationSeconds: input.durationSeconds ?? null };
  if (prefix === "") {
    if (input.positionSeconds === undefined) await store.setProgress(input.mediaId, input.progressPct, input.episodeId);
    else await store.setProgress(input.mediaId, input.progressPct, input.episodeId, timing);
    return;
  }
  const pct = normalizePct(input.progressPct);
  const now = nowIso();
  const details = store.getMediaDetails(input.mediaId);
  let mediaProgress = { progressPct: pct, lastWatchedAt: now };
  if (input.episodeId) {
    const value: Record<string, unknown> = { progressPct: pct, updatedAt: now };
    if (typeof timing.positionSeconds === "number" && Number.isFinite(timing.positionSeconds) && timing.positionSeconds >= 0) value.positionSeconds = timing.positionSeconds;
    if (typeof timing.durationSeconds === "number" && Number.isFinite(timing.durationSeconds) && timing.durationSeconds > 0) value.durationSeconds = timing.durationSeconds;
    await store.setSetting(`${prefix}${EPISODE_RESUME_KEY_PREFIX}${input.episodeId}`, JSON.stringify(value));
    if (details?.type === "tv") mediaProgress = profileShowAggregate(store, prefix, details, now);
  }
  await store.setSetting(
    `${prefix}${MEDIA_PROGRESS_KEY_PREFIX}${input.mediaId}`,
    JSON.stringify({ progressPct: mediaProgress.progressPct, lastWatchedAt: mediaProgress.lastWatchedAt, updatedAt: now })
  );
};

/** Read-modify-write of the profile's remembered audio/subtitle choice (PLAY-TRACK-04). */
export const writeTrackPrefs = async (store: ViewingStore, prefix: string, mediaId: string, patch: TrackPrefsPatch) => {
  if (prefix === "") {
    await store.setTrackPrefs(mediaId, patch);
    return;
  }
  const merged = mergeTrackPrefs(readTrackPrefs(store, prefix, mediaId), patch, nowIso());
  await store.setSetting(`${prefix}${TRACK_PREFS_KEY_PREFIX}${mediaId}`, serializeTrackPrefs(merged));
};
