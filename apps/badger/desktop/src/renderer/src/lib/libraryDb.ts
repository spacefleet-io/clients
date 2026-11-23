import type { LibraryMeta, TitleDetails } from "@/api";
import type {
  LibrarySnapshot,
  MediaCastDraft,
  MediaCrewDraft,
  MediaDetails,
  MediaEpisodeDraft,
  MediaFormat,
  MediaRow,
  MediaSeasonDraft,
  MediaSkipMarkerType,
  MediaType,
  DelistedEpisodeRemovalResult,
  EpisodeMoveResult,
  PlaylistRow,
  ShowEpisodeRefreshResult,
} from "@space/shared/libraryTypes";
import type { TrackPrefsPatch } from "@space/shared/trackPrefs";
import type { ArtworkApplyResult, ArtworkCopy, ArtworkSlot } from "@space/library-db-definition/artworkCopy";
import type { TitleArt } from "@space/shared/titleLanguage";

export type {
  AudioTrack,
  IngestJob,
  IngestJobEvent,
  LibrarySnapshot,
  MediaCastDraft,
  MediaCrewDraft,
  MediaDetails,
  MediaEpisodeDraft,
  MediaRow,
  MediaSeasonDraft,
  MediaSkipMarker,
  MediaSkipMarkerType,
  MediaType,
  PlaylistRow,
  ShowEpisodeRefreshResult,
  ShowEpisodeNotListed,
  ShowEpisodeSlot,
  EpisodeMoveSuggestion,
  EpisodeMoveResult,
  DelistedEpisodeRemovalResult,
  MediaChapter,
  MediaFormat,
  SubtitleTrack,
} from "@space/shared/libraryTypes";

/**
 * What a progress save knows besides the percentage: the absolute spot and length (credits-aware completion), and
 * the edition playing when the title has two or more (PLAY-RESUME-05: that edition's own resume spot).
 */
export type ProgressTiming = { positionSeconds?: number | null; durationSeconds?: number | null; editionId?: string | null };

type LibraryDbHandle = string;
type DatasetStatus = { core: boolean; metadata: boolean; playback: boolean };

const getBridge = () => {
  const bridge = window.sf?.libraryDb;
  if (!bridge) {
    throw new Error("LIBRARY_DB_BRIDGE_MISSING");
  }
  return bridge;
};

const localCacheClearedListeners = new Set<() => void>();

const call = <T>(handle: LibraryDbHandle, method: string, args: unknown[] = []) => {
  const bridge = getBridge();
  if (!bridge.call) {
    throw new Error("LIBRARY_DB_CALL_MISSING");
  }
  return bridge.call({ handle, method, args }) as Promise<T>;
};

export class LibraryDb {
  private handle: LibraryDbHandle;

  private constructor(handle: LibraryDbHandle) {
    this.handle = handle;
  }

  /** Open `userId`'s library: each account keeps its own library files on this computer (LIB-STORE-06). */
  static async open(token: string, keyBase64: string, userId: string) {
    const bridge = getBridge();
    if (!bridge.open) {
      throw new Error("LIBRARY_DB_OPEN_MISSING");
    }
    const response = await bridge.open({ token, keyBase64, userId });
    if (!response?.handle) {
      throw new Error("LIBRARY_DB_OPEN_FAILED");
    }
    return new LibraryDb(response.handle);
  }

  static async openLocal(token: string, keyBase64: string, userId: string) {
    const bridge = getBridge();
    if (!bridge.openLocal) {
      throw new Error("LIBRARY_DB_OPEN_MISSING");
    }
    const response = await bridge.openLocal({ token, keyBase64, userId });
    if (!response?.handle) {
      throw new Error("LIBRARY_DB_OPEN_FAILED");
    }
    return new LibraryDb(response.handle);
  }

  static async getLocalCacheBytes(keyBase64?: string) {
    const bridge = getBridge();
    if (!bridge.getLocalCacheBytes) {
      throw new Error("LIBRARY_DB_CACHE_MISSING");
    }
    return bridge.getLocalCacheBytes(keyBase64);
  }

  /**
   * PRIV-KEY-06: every other app's library (Parrot's) opened with the old key and re-encrypted under the new one, for
   * the rotation's `otherLibraries`. Throws `ROTATION_REENCRYPT_<UNREADABLE|NOT_SNAPSHOTTED|FAILED>`: nothing rotated.
   */
  static async reencryptForRotation(token: string, oldKeyBase64: string, newKeyBase64: string) {
    const bridge = getBridge();
    if (!bridge.reencryptForRotation) {
      throw new Error("ROTATION_REENCRYPT_FAILED");
    }
    const result = await bridge.reencryptForRotation({ token, oldKeyBase64, newKeyBase64 });
    if (!result.ok) throw new Error(`ROTATION_REENCRYPT_${result.error.toUpperCase()}`);
    return result.copies;
  }

  static async hasLocalCache() {
    const bridge = getBridge();
    if (!bridge.hasLocalCache) {
      throw new Error("LIBRARY_DB_CACHE_MISSING");
    }
    return Boolean(await bridge.hasLocalCache());
  }

  static async clearLocalCache() {
    const bridge = getBridge();
    if (!bridge.clearLocalCache) {
      throw new Error("LIBRARY_DB_CACHE_MISSING");
    }
    await bridge.clearLocalCache();
    await window.sf?.clearExternalMpvSubtitleCache?.().catch(() => null);
    // Main dropped the active profile with the cache (`sf-library-db-clear-local-cache`): listeners send it again.
    for (const listener of localCacheClearedListeners) listener();
  }

  /** Called after every `clearLocalCache` (the profile store re-sends the active profile to main). */
  static onLocalCacheCleared(listener: () => void) {
    localCacheClearedListeners.add(listener);
    return () => void localCacheClearedListeners.delete(listener);
  }

  /**
   * ACCT-SQUAD-02 / UX-PROF-01: viewing state reads and writes follow this profile (main = the library's own storage).
   * Its own channel, not the generic call: the picker can answer before the library opens, and main keeps the choice
   * for every library it opens until sign-out. `applied` is false when no library is open yet.
   */
  static async setActiveProfile(profile: { id: string; isMain: boolean } | null) {
    const bridge = getBridge();
    if (!bridge.setActiveProfile) {
      throw new Error("LIBRARY_DB_PROFILE_BRIDGE_MISSING");
    }
    return await bridge.setActiveProfile(profile);
  }

  onDatasetStatus(callback: (status: DatasetStatus) => void) {
    const bridge = getBridge();
    if (!bridge.onDatasetStatus) {
      throw new Error("LIBRARY_DB_DATASET_MISSING");
    }
    return bridge.onDatasetStatus((status: unknown) => callback(status as DatasetStatus));
  }

  async close() {
    await call<void>(this.handle, "close");
  }

  getVersion() {
    return call<number>(this.handle, "getVersion");
  }

  getDatasetStatus() {
    return call<DatasetStatus>(this.handle, "getDatasetStatus");
  }

  exportBytes() {
    return call<Uint8Array>(this.handle, "exportBytes");
  }

  setSyncEnabled(enabled: boolean) {
    return call<void>(this.handle, "setSyncEnabled", [enabled]);
  }

  async clearPendingSync() {
    await call<void>(this.handle, "clearPendingSync");
  }

  hasPendingSync() {
    return call<boolean>(this.handle, "hasPendingSync");
  }

  listMedia(type?: MediaType) {
    return call<MediaRow[]>(this.handle, "listMedia", [type]);
  }

  hasAnyMedia() {
    return call<boolean>(this.handle, "hasAnyMedia");
  }

  async addMediaFromCatalog(item: TitleDetails) {
    return call<string>(this.handle, "addMediaFromCatalog", [item]);
  }

  /** LIB-SHOW-01: merge a running show's fresh catalog season + episode lists (keeps episode ids). */
  refreshShowEpisodes(mediaId: string, item: TitleDetails) {
    return call<ShowEpisodeRefreshResult>(this.handle, "refreshShowEpisodes", [mediaId, item]);
  }

  /** LIB-SHOW-02: remove episodes the user agreed to drop after the catalog stopped listing them (never one with a file). */
  removeEpisodesNotInCatalog(mediaId: string, episodeIds: string[]) {
    return call<DelistedEpisodeRemovalResult>(this.handle, "removeEpisodesNotInCatalog", [mediaId, episodeIds]);
  }

  /** LIB-SHOW-04: move an episode the user has a file for to another episode slot (the user said yes). */
  moveEpisodeToSlot(mediaId: string, episodeId: string, targetEpisodeId: string) {
    return call<EpisodeMoveResult>(this.handle, "moveEpisodeToSlot", [mediaId, episodeId, targetEpisodeId]);
  }

  updateMediaMetadata(payload: {
    mediaId: string;
    media?: {
      title?: string;
      originalTitle?: string | null;
      originalLanguage?: string | null;
      overview?: string | null;
      year?: string | null;
      rating?: number | null;
      posterPath?: string | null;
      backdropPath?: string | null;
      genres?: number[];
      totalEpisodes?: number | null;
    };
    cast?: MediaCastDraft[];
    crew?: MediaCrewDraft[];
    seasons?: MediaSeasonDraft[];
    episodes?: MediaEpisodeDraft[];
  }) {
    return call<void>(this.handle, "updateMediaMetadata", [payload]);
  }

  /** META-ART-01: images of `mediaId` still stored as catalog paths. */
  listArtworkToCopy(mediaId: string) {
    return call<ArtworkSlot[]>(this.handle, "listArtworkToCopy", [mediaId]);
  }

  /** META-ART-01 migration: titles that still hold a catalog image path somewhere. */
  listMediaWithArtworkToCopy() {
    return call<string[]>(this.handle, "listMediaWithArtworkToCopy", []);
  }

  /** LIB-CAST-01: titles whose cast the old code merged into one person (`@space/library-db-runtime/castRefetch`). */
  listMediaWithCollapsedCast() {
    return call<string[]>(this.handle, "listMediaWithCollapsedCast", []);
  }

  /** LIB-CREW-01: titles with a catalog id and no crew at all (`@space/library-db-runtime/crewBackfill`). */
  listMediaMissingCrew() {
    return call<string[]>(this.handle, "listMediaMissingCrew", []);
  }

  /** META-ART-01: swap copied artwork in (compare-and-set against the catalog path each copy was made from). */
  applyArtworkCopies(mediaId: string, copies: ArtworkCopy[]) {
    return call<ArtworkApplyResult>(this.handle, "applyArtworkCopies", [mediaId, copies]);
  }

  /** ACCT-PROF-03: put the account-language title art on a media row (compare-and-set against `expected`). */
  replaceMediaTitleArt(mediaId: string, expected: TitleArt, next: TitleArt) {
    return call<boolean>(this.handle, "replaceMediaTitleArt", [mediaId, expected, next]);
  }

  replaceMediaTrailers(mediaId: string, trailers: TitleDetails["trailers"]) {
    return call<void>(this.handle, "replaceMediaTrailers", [mediaId, trailers]);
  }

  getSetting(key: string) {
    return call<{ value: string; updatedAt: string } | null>(this.handle, "getSetting", [key]);
  }

  /** `updatedAt`: the row and op time (a profile settings seed is stamped the epoch); the runtime stamps now when absent. */
  setSetting(key: string, value: string, updatedAt?: string) {
    return call<void>(this.handle, "setSetting", updatedAt ? [key, value, updatedAt] : [key, value]);
  }

  getSnapshot() {
    return call<LibrarySnapshot>(this.handle, "getSnapshot");
  }

  /** ACCT-PROF-02: blanks every `p:<profileId>:` key of a deleted non-main profile; returns how many. */
  wipeProfileViewing(profileId: string) {
    return call<number>(this.handle, "wipeProfileViewing", [profileId]);
  }

  /** ACCT-PROF-02: the deleted main profile's storage takes the oldest remaining profile's state. */
  promoteProfileToMain(newMainId: string) {
    return call<unknown>(this.handle, "promoteProfileToMain", [newMainId]);
  }

  /** ACCT-PROF-02: finishes a main-profile move another device left halfway; returns whether one ran. */
  listViewingProfileIds() {
    return call<string[]>(this.handle, "listViewingProfileIds", []);
  }

  healMainPromotion(mainId: string) {
    return call<boolean>(this.handle, "healMainPromotion", [mainId]);
  }

  linkFileToMedia(mediaId: string, filename: string, season?: number | null, episode?: number | null) {
    return call<string>(this.handle, "linkFileToMedia", [mediaId, filename, season ?? null, episode ?? null]);
  }

  markMediaPlayable(mediaId: string) {
    return call<void>(this.handle, "markMediaPlayable", [mediaId]);
  }

  deleteMediaFile(fileId: string) {
    return call<void>(this.handle, "deleteMediaFile", [fileId]);
  }

  setProgress(
    mediaId: string,
    progressPct: number,
    episodeId?: string | null,
    // Phase 2 optional 4th arg: absolute positionSeconds + durationSeconds.
    // The runtime persists them inside the episode_resume_v1 JSON payload
    // so the credits-aware completion check (the metadata service) can compare in
    // absolute time. Old callers without timing keep the legacy pct-only
    // payload — both reads stay backward-compatible.
    timing?: ProgressTiming | null
  ) {
    return call<void>(this.handle, "setProgress", [
      mediaId,
      progressPct,
      episodeId ?? null,
      timing ?? null,
    ]);
  }

  addMediaFormat(
    mediaId: string,
    fileId: string,
    quality: string,
    codec: string,
    sizeMb: number,
    chunks: Array<{ key: string; sizeBytes?: number | null; startSeconds?: number | null }> | string[],
    bitrateKbps: number | null,
    options?: {
      initKey?: string | null;
      initSize?: number | null;
      durationSeconds?: number | null;
      totalSize?: number | null;
    }
  ) {
    return call<string>(this.handle, "addMediaFormat", [
      mediaId,
      fileId,
      quality,
      codec,
      sizeMb,
      chunks,
      bitrateKbps,
      options ?? {},
    ]);
  }

  setMediaFormatChunks(
    formatId: string,
    chunks: Array<{ key: string; sizeBytes?: number | null; startSeconds?: number | null }> | string[]
  ) {
    return call<void>(this.handle, "setMediaFormatChunks", [formatId, chunks]);
  }

  removeMediaFormat(formatId: string) {
    return call<void>(this.handle, "removeMediaFormat", [formatId]);
  }

  setMediaFileDesiredFormats(
    fileId: string,
    formats: Array<{ quality: string; codec: string; bitrateKbps?: number | null }>
  ) {
    return call<void>(this.handle, "setMediaFileDesiredFormats", [fileId, formats]);
  }

  addAudioTracksForFile(
    mediaId: string,
    fileId: string,
    season: number | null,
    episode: number | null,
    audioTracks: Array<{ language: string; label: string }>,
    defaultAudioLanguage?: string | null
  ) {
    return call<void>(this.handle, "addAudioTracksForFile", [
      mediaId,
      fileId,
      season,
      episode,
      audioTracks,
      defaultAudioLanguage ?? null,
    ]);
  }

  addSubtitleTracksForFile(
    mediaId: string,
    fileId: string,
    season: number | null,
    episode: number | null,
    subtitleTracks: Array<{ language: string; label: string }>,
    defaultSubtitleLanguage?: string | null
  ) {
    return call<void>(this.handle, "addSubtitleTracksForFile", [
      mediaId,
      fileId,
      season,
      episode,
      subtitleTracks,
      defaultSubtitleLanguage ?? null,
    ]);
  }

  addSubtitleTrack(
    mediaId: string,
    episodeId: string | null,
    language: string,
    label: string,
    objectKey: string,
    format?: string | null,
    source?: string | null
  ) {
    return call<void>(this.handle, "addSubtitleTrack", [
      mediaId,
      episodeId,
      language,
      label,
      objectKey,
      format ?? null,
      source ?? null,
    ]);
  }

  removeSubtitleTrack(trackId: string) {
    return call<void>(this.handle, "removeSubtitleTrack", [trackId]);
  }

  removeAudioTrack(trackId: string) {
    return call<void>(this.handle, "removeAudioTrack", [trackId]);
  }

  updateAudioTrack(trackId: string, language: string, label: string) {
    return call<void>(this.handle, "updateAudioTrack", [trackId, language, label]);
  }

  updateSubtitleTrack(trackId: string, language: string, label: string) {
    return call<void>(this.handle, "updateSubtitleTrack", [trackId, language, label]);
  }

  setDefaultAudioTrack(mediaId: string, episodeId: string | null, trackId: string | null) {
    return call<void>(this.handle, "setDefaultAudioTrack", [mediaId, episodeId, trackId]);
  }

  setDefaultSubtitleTrack(mediaId: string, episodeId: string | null, trackId: string | null) {
    return call<void>(this.handle, "setDefaultSubtitleTrack", [mediaId, episodeId, trackId]);
  }

  setTrackPrefs(mediaId: string, patch: TrackPrefsPatch) {
    return call<void>(this.handle, "setTrackPrefs", [mediaId, patch]);
  }

  addAudioTrackWithChunks(input: {
    mediaId: string;
    fileId: string;
    season: number | null;
    episode: number | null;
    language: string;
    label: string;
    codec: string | null;
    initKey: string | null;
    initSize: number | null;
    durationSeconds: number | null;
    totalSize: number | null;
    chunks: Array<{ key: string; sizeBytes?: number | null; startSeconds?: number | null }>;
    isDefault?: boolean;
    source?: string;
  }) {
    return call<void>(this.handle, "addAudioTrackWithChunks", [input]);
  }

  addSubtitleTrackWithObject(input: {
    mediaId: string;
    fileId: string;
    season: number | null;
    episode: number | null;
    language: string;
    label: string;
    objectKey: string;
    format?: string | null;
    isDefault?: boolean;
    source?: string;
  }) {
    return call<void>(this.handle, "addSubtitleTrackWithObject", [input]);
  }

  addChaptersForFormat(formatId: string, chapters: Array<{ title: string; startSeconds: number }>) {
    return call<void>(this.handle, "addChaptersForFormat", [formatId, chapters]);
  }

  replaceSkipMarkers(
    mediaId: string,
    episodeId: string | null,
    markers: Array<{
      type: MediaSkipMarkerType;
      startSeconds: number;
      endSeconds: number;
      source: string;
      confidence?: number | null;
    }>
  ) {
    return call<void>(this.handle, "replaceSkipMarkers", [mediaId, episodeId, markers]);
  }

  upsertSkipAnalysis(
    mediaId: string,
    episodeId: string | null,
    kind: string,
    payload: Record<string, unknown>
  ) {
    return call<void>(this.handle, "upsertSkipAnalysis", [mediaId, episodeId, kind, payload]);
  }

  listSkipAnalysis(mediaId: string, kind?: string) {
    return call<
      Array<{
        id: string;
        mediaId: string;
        episodeId: string | null;
        kind: string;
        payload: Record<string, unknown>;
        createdAt: string;
        updatedAt: string;
      }>
    >(this.handle, "listSkipAnalysis", [mediaId, kind]);
  }

  listMediaFormats(mediaId: string) {
    return call<MediaFormat[]>(this.handle, "listMediaFormats", [mediaId]);
  }

  getMediaObjectKeys(mediaId: string) {
    return call<string[]>(this.handle, "getMediaObjectKeys", [mediaId]);
  }

  getMediaStorageBytes(mediaId: string) {
    return call<number>(this.handle, "getMediaStorageBytes", [mediaId]);
  }

  purgeMissingObjects(missingKeys: string[]) {
    return call<void>(this.handle, "purgeMissingObjects", [missingKeys]);
  }

  getMediaDetails(mediaId: string) {
    return call<MediaDetails | null>(this.handle, "getMediaDetails", [mediaId]);
  }

  listPlaylists() {
    return call<PlaylistRow[]>(this.handle, "listPlaylists");
  }

  listPlaylistItems(playlistId: string) {
    return call<string[]>(this.handle, "listPlaylistItems", [playlistId]);
  }

  createPlaylist(name: string) {
    return call<void>(this.handle, "createPlaylist", [name]);
  }

  deletePlaylist(playlistId: string) {
    return call<void>(this.handle, "deletePlaylist", [playlistId]);
  }

  addToPlaylist(playlistId: string, mediaId: string) {
    return call<void>(this.handle, "addToPlaylist", [playlistId, mediaId]);
  }

  removeFromPlaylist(playlistId: string, mediaId: string) {
    return call<void>(this.handle, "removeFromPlaylist", [playlistId, mediaId]);
  }

  getSystemPlaylistId(slug: "favorites") {
    return call<string | null>(this.handle, "getSystemPlaylistId", [slug]);
  }

  deleteMedia(mediaId: string) {
    return call<{ deletedKeys: number; reclaimedBytes: number }>(this.handle, "deleteMedia", [mediaId]);
  }

  getDebugSnapshot() {
    return call<Record<string, unknown> | null>(this.handle, "getDebugSnapshot");
  }

  syncFromRemoteIfNewer(metaOverride?: LibraryMeta) {
    return call<boolean>(this.handle, "syncFromRemoteIfNewer", [metaOverride ?? null]);
  }

  flushPending() {
    return call<boolean>(this.handle, "flushPending");
  }
}
