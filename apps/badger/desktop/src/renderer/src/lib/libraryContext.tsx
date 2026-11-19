import React, { createContext, startTransition, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useRuntimeInstanceId } from "@space/desktop-shell/services/runtime-status";
import { checkKeptLibraryKey } from "@space/desktop-shell/library-kept-key";
import { ApiError, deleteStorageObjects, getLibraryMeta, getMe, getMetadataDetails, TitleDetails } from "@/api";
import { useAuth } from "@/auth";
import { clearLibraryKey, getStoredLibraryKey, isLibraryKeyAcknowledged } from "@/lib/onboarding";
import {
  IngestJob,
  LibraryDb,
  LibrarySnapshot,
  MediaCastDraft,
  MediaCrewDraft,
  MediaDetails,
  MediaEpisodeDraft,
  MediaRow,
  MediaSeasonDraft,
  MediaSkipMarkerType,
  MediaType,
  PlaylistRow,
  ShowEpisodeRefreshResult,
  DelistedEpisodeRemovalResult,
  EpisodeMoveResult,
  type ProgressTiming,
} from "@/lib/libraryDb";
import { editionResumeKey, editionResumeValue } from "@space/shared/mediaEditions";
import { loadClientConfig, saveClientConfig, subscribeClientConfig } from "@/lib/config";
import { useClientConfig } from "@/lib/useClientConfig";
import { readProfileSettingsRow, scopedProfileSettingsKey, type ProfileSettings } from "@space/shared/profileSettings";
import { parseTitleVariants, profileTitleLanguage, shownTitleArt, titleVariantsKey } from "@space/shared/titleLanguage";
import { viewingScopeFor } from "@space/shared/profileViewing";
import { loadComposedClientConfig, persistComposedClientConfig, type DeviceCapacityStore } from "@/lib/profileClientConfig";
import { decryptBase64ToBytes } from "@/lib/crypto";
import { getTitleDetails, getTitleTrailersForLanguages, setDesktopTextsLibrary } from "@/lib/metadata";
import { pickLibraryCrew } from "@space/shared/libraryCrew";
import { attachCatalogAssets } from "@/lib/catalogAssets";
import { ARTWORK_COPY_TICKET_FLOOR, ARTWORK_REFRESH_GAP_MS, createDesktopArtworkCopyQueue, toUploadOutcome } from "@/lib/artworkCopy";
import { scheduleArtworkMigration } from "@space/library-db-definition/artworkCopy";
import { coalesceRefresh } from "@/lib/coalesceRefresh";
import { createDesktopArtworkHealer, getDesktopArtworkHealer, setDesktopArtworkHealer } from "@/lib/artworkHeal";
import { refetchCollapsedCasts } from "@space/library-db-runtime/castRefetch";
import { startCrewBackfill } from "@/lib/crewBackfill";
import { startTitleVariantsReconcile } from "@/lib/titleVariantsPass";
import { uploadEncryptedAssetFromMetadata } from "@/lib/assets";
import { getDesktopMetadata } from "@/lib/metadataTickets";
import { shouldLogoutAfterAuthProbe } from "@/lib/authGuards";
import {
  clearLibrarySnapshotCache,
  loadLibrarySnapshotCache,
  saveLibrarySnapshotCache,
} from "@/lib/librarySnapshotCache";
import {
  createLibrarySnapshotPersister,
  type LibrarySnapshotPersister,
} from "@/lib/librarySnapshotPersister";
import { buildLibraryShellValue } from "@/lib/libraryShellData";
import { mergeTrackPrefs, parseTrackPrefs, serializeTrackPrefs, trackPrefsKey, type TrackPrefsPatch } from "@space/shared/trackPrefs";
import { notifyError } from "@/lib/notify";
import { createOptimisticWriteTracker } from "@/lib/optimisticWriteFailures";
import { rendererLogger } from "@/logger";
import { attachProfileLibrary, useProfiles, type ProfileLibraryMoves } from "@/lib/profileStore";
import { createProfileLibraryMoves } from "@/lib/profileLibraryMoves";

const libraryContextLog = rendererLogger.child({ scope: "library" });
const profileMovesLog = rendererLogger.child({ scope: "profile-moves" });
const libraryStartupLog = rendererLogger.child({ scope: "library-startup" });
const libraryPreflightLog = rendererLogger.child({ scope: "library-preflight" });
/** STOR-PLACE-09: the first missing-artwork check waits until the library has settled, then repeats this often. */
const ARTWORK_HEAL_FIRST_SWEEP_MS = 30_000;
const ARTWORK_HEAL_SWEEP_INTERVAL_MS = 6 * 60 * 60_000;
import { EMPTY_LIBRARY_DATASET_STATUS, resetLibraryState } from "@/lib/libraryStateReset";
import { ensureWriteAllowed } from "@/lib/writeGuard";
import { attachLibraryRemoteSyncStream } from "@/lib/libraryRemoteSyncStream";
import { markMediaDeleted } from "@/lib/libraryGhosts";
import { clearAssetCaches } from "@/lib/assets";

const EXTERNAL_MPV_SESSION_EVENT = "sf:external-mpv-session";

type LibraryContextValue = {
  loading: boolean;
  error: string | null;
  /**
   * Non-null when the library is at a format version newer than this build
   * supports — drives the blocking `LibraryFormatTooNewModal`. See
   * `parseLibraryFormatTooNew`.
   */
  formatTooNew: LibraryFormatTooNewDetail | null;
  writeBlockedReason: string | null;
  media: MediaRow[];
  playlists: PlaylistRow[];
  ingestJobs: IngestJob[];
  datasetStatus: { core: boolean; metadata: boolean; playback: boolean };
  awaitDatasetReady: (stage: "core" | "metadata" | "playback") => Promise<void>;
  /** Re-runs the full library load; resolves once that load settled (UX-CRASH-01's "Try again" waits for it). */
  reload: () => Promise<void>;
  activateRemoteLibrary: (token: string, keyBase64: string) => Promise<void>;
  addMediaFromCatalog: (item: TitleDetails) => Promise<string>;
  linkFileToMedia: (mediaId: string, filename: string, season?: number | null, episode?: number | null) => Promise<string>;
  setProgress: (
    mediaId: string,
    progressPct: number,
    episodeId?: string | null,
    // Phase 2: optional absolute position + duration so the persisted resume
    // payload can carry seconds (not just pct). Used by the credits-aware
    // completion check (the metadata service) to compare "watched past credits-start"
    // in absolute time. Old callers stay on the pct-only payload.
    timing?: ProgressTiming | null,
    // Issue #25 P19-residual: persist only, leave library React state alone
    // (the hidden playback window re-applies the latest value on show).
    options?: { deferUi?: boolean }
  ) => Promise<void>;
  /** The details as the active profile sees them (ACCT-PROF-03 title). */
  getMediaDetails: (mediaId: string) => MediaDetails | null;
  /** The details exactly as the library holds them: what a metadata edit starts from. */
  getLibraryMediaDetails: (mediaId: string) => MediaDetails | null;
  fetchMediaDetails: (mediaId: string) => Promise<MediaDetails | null>;
  listPlaylistItems: (playlistId: string) => string[];
  createPlaylist: (name: string) => Promise<void>;
  deletePlaylist: (playlistId: string) => Promise<void>;
  addToPlaylist: (playlistId: string, mediaId: string) => Promise<void>;
  removeFromPlaylist: (playlistId: string, mediaId: string) => Promise<void>;
  getSystemPlaylistId: (slug: "favorites") => string | null;
  getPlaylistIdBySlug: (slug: string) => string | null;
  deleteMedia: (mediaId: string) => Promise<{ keys: string[] }>;
  deleteMediaFile: (fileId: string) => Promise<void>;
  replaceMediaTrailers: (mediaId: string, trailers: TitleDetails["trailers"]) => Promise<void>;
  updateMediaMetadata: (payload: {
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
  }) => Promise<void>;
  restoreMediaFromCatalog: (mediaId: string, options: { resetCast: boolean }) => Promise<void>;
  /** META-ART-01: copy this title's artwork still stored as catalog paths into the user's storage, in the background. */
  copyMediaArtwork: (mediaId: string) => void;
  /** LIB-SHOW-01: merge a running show's fresh catalog season + episode lists, keeping every stored episode id. */
  refreshShowEpisodes: (mediaId: string, item: TitleDetails) => Promise<ShowEpisodeRefreshResult>;
  /** LIB-SHOW-02: remove the episodes the user agreed to drop after the catalog stopped listing them. */
  removeEpisodesNotInCatalog: (mediaId: string, episodeIds: string[]) => Promise<DelistedEpisodeRemovalResult>;
  /** LIB-SHOW-04: move an episode the user has a file for to another episode slot, after they said yes. */
  moveEpisodeToSlot: (mediaId: string, episodeId: string, targetEpisodeId: string) => Promise<EpisodeMoveResult>;
  getSharedSetting: (key: string) => { value: string; updatedAt: string } | null;
  /** The active profile's playback settings record (ACCT-SQUAD-03) with each field's change time; null without a profile. */
  getActiveProfileSettings: () => ProfileSettings | null;
  setSharedSetting: (key: string, value: string) => Promise<void>;
  addMediaFormat: (
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
  ) => Promise<string>;
  setMediaFormatChunks: (
    formatId: string,
    chunks: Array<{ key: string; sizeBytes?: number | null; startSeconds?: number | null }> | string[]
  ) => Promise<void>;
  replaceSkipMarkers: (
    mediaId: string,
    episodeId: string | null,
    markers: Array<{
      type: MediaSkipMarkerType;
      startSeconds: number;
      endSeconds: number;
      source: string;
      confidence?: number | null;
    }>
  ) => Promise<void>;
  upsertSkipAnalysis: (
    mediaId: string,
    episodeId: string | null,
    kind: string,
    payload: Record<string, unknown>
  ) => Promise<void>;
  listSkipAnalysis: (
    mediaId: string,
    kind?: string
  ) => Promise<
    Array<{
      id: string;
      mediaId: string;
      episodeId: string | null;
      kind: string;
      payload: Record<string, unknown>;
      createdAt: string;
      updatedAt: string;
    }>
  >;
  removeMediaFormat: (formatId: string) => Promise<void>;
  setMediaFileDesiredFormats: (
    fileId: string,
    formats: Array<{ quality: string; codec: string; bitrateKbps?: number | null }>
  ) => Promise<void>;
  addFileTracks: (
    mediaId: string,
    fileId: string,
    season: number | null,
    episode: number | null,
    audioTracks: Array<{ language: string; label: string }>,
    subtitleTracks: Array<{ language: string; label: string }>,
    defaultAudioLanguage?: string | null,
    defaultSubtitleLanguage?: string | null
  ) => Promise<void>;
  addSubtitleTrack: (
    mediaId: string,
    episodeId: string | null,
    language: string,
    label: string,
    objectKey: string,
    format?: string | null,
    source?: string | null
  ) => Promise<void>;
  removeSubtitleTrack: (trackId: string) => Promise<void>;
  /**
   * Deletes a subtitle track and resolves only once the library has (the view rolls back and it throws otherwise), so
   * "Try another version" can then delete the old stored file (PLAY-SUBGET-07).
   */
  removeSubtitleTrackNow: (trackId: string) => Promise<void>;
  /** Every stored file the library names for this media (posters, formats, subtitles…). */
  getMediaObjectKeys: (mediaId: string) => Promise<string[]>;
  removeAudioTrack: (trackId: string) => Promise<void>;
  updateAudioTrack: (trackId: string, language: string, label: string) => Promise<void>;
  updateSubtitleTrack: (trackId: string, language: string, label: string) => Promise<void>;
  setDefaultAudioTrack: (mediaId: string, episodeId: string | null, trackId: string | null) => Promise<void>;
  setDefaultSubtitleTrack: (mediaId: string, episodeId: string | null, trackId: string | null) => Promise<void>;
  addAudioTrackWithChunks: (input: {
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
  }) => Promise<void>;
  addSubtitleTrackWithObject: (input: {
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
  }) => Promise<void>;
  /** Remember the audio/subtitle choice of a movie or TV show (PLAY-TRACK-04); synced like resume. */
  setTrackPrefs: (mediaId: string, patch: TrackPrefsPatch) => Promise<void>;
  addChaptersForFormat: (formatId: string, chapters: Array<{ title: string; startSeconds: number }>) => Promise<void>;
  purgeMissingObjects: (missingKeys: string[]) => Promise<void>;
  syncFromRemote: () => Promise<void>;
  resetKey: () => Promise<void>;
  exportLocalDb: () => Promise<Uint8Array>;
  clearLocalCache: () => Promise<void>;
  getDebugSnapshot: () => Promise<Record<string, unknown> | null>;
  debugRevision: number;
  suspendUiUpdates: () => void;
  resumeUiUpdates: () => void;
  batchLibraryUpdates: <T>(fn: () => Promise<T>) => Promise<T>;
};

export const getLibraryLoadErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error ?? "unknown");

export const isDecryptFailureMessage = (error: unknown) => {
  // The decrypt failure can reach the renderer two ways: thrown bare from the
  // direct-SQLite path (`new Error("DECRYPT_FAILED")`, message === the code) or
  // wrapped by the runtime proxy as `RuntimeCommandFailedError` whose message
  // carries the code embedded in a longer string. An exact `===` only matched
  // the first form and silently missed every proxy-wrapped failure — so a
  // runtime-mode decrypt error fell through to the generic "could not load"
  // copy. `includes()` matches both forms.
  const message = getLibraryLoadErrorMessage(error).toUpperCase();
  return message.includes("DECRYPT_FAILED") || message.includes("MANIFEST_DECRYPT_FAILED");
};

/**
 * Structured detail of a "library format too new" failure, parsed from the
 * error a too-old client hits when it opens a library a newer build wrote.
 *
 * `LibraryFormatTooNewError` (from `@space/library-db-definition`) is thrown by
 * every open path that observes a forward version skew. The typed class itself
 * does not survive the runtime-proxy boundary — `RuntimeCommandFailedError`
 * only copies `message`/`code`/`details` — so detection works off the
 * deterministic message string `LIBRARY_FORMAT_TOO_NEW: <surface[:group]>
 * observed=<N> supported=<M>`, exactly the robust-substring approach used for
 * the decrypt matcher above.
 */
export type LibraryFormatTooNewDetail = {
  surface: "storage" | "op-stream" | "schema";
  observed: number;
  supported: number;
  group?: string;
};

const LIBRARY_FORMAT_TOO_NEW_TOKEN = "LIBRARY_FORMAT_TOO_NEW";

/**
 * Parse the `LibraryFormatTooNewError` detail out of any error that reached the
 * renderer. Returns `null` when the error is not a format-too-new failure.
 * Triggers for ANY surface (`storage` / `op-stream` / `schema`).
 *
 * Deliberately NOT an `instanceof LibraryFormatTooNewError` check: every
 * library error reaches this *renderer* across an IPC boundary that discards
 * the prototype. The preload's `libraryDb.call` rethrows as a plain
 * `new Error(__sfIpcError)`, and the runtime proxy collapses to
 * `RuntimeCommandFailedError` — so the genuine typed class never survives to
 * the renderer. (The mobile client runs in-process and *does* `instanceof`-check
 * first — see `apps/badger/mobile/src/store/library.tsx`.)
 *
 * Order of precedence here: structured `{ surface, observed, supported, group }`
 * in `RuntimeCommandFailedError.details` if the proxy preserved it, else the
 * deterministic message string.
 */
export const parseLibraryFormatTooNew = (error: unknown): LibraryFormatTooNewDetail | null => {
  const isSurface = (value: unknown): value is LibraryFormatTooNewDetail["surface"] =>
    value === "storage" || value === "op-stream" || value === "schema";

  // Prefer structured details when the runtime proxy preserved them. The
  // runtime envelope contract (runtime-impl): a too-new failure carries
  // `details = { kind: "library_format_too_new", surface, observed, supported,
  // group? }`. `kind` is the discriminator — the runtime `code` stays the
  // closed-enum `internal_error`, so we gate on `details.kind`, not `code`.
  const details = (error as { details?: Record<string, unknown> } | null)?.details;
  if (
    details &&
    typeof details === "object" &&
    (details as { kind?: unknown }).kind === "library_format_too_new"
  ) {
    const { surface, observed, supported, group } = details as Record<string, unknown>;
    if (isSurface(surface) && typeof observed === "number" && typeof supported === "number") {
      return {
        surface,
        observed,
        supported,
        group: typeof group === "string" && group ? group : undefined,
      };
    }
  }

  const message = getLibraryLoadErrorMessage(error);
  if (!message.includes(LIBRARY_FORMAT_TOO_NEW_TOKEN)) return null;

  // `LIBRARY_FORMAT_TOO_NEW: <surface[:group]> observed=<N> supported=<M>`
  const match = message.match(
    /LIBRARY_FORMAT_TOO_NEW:\s*([a-z-]+)(?::([^\s]+))?\s+observed=(\d+)\s+supported=(\d+)/i
  );
  if (match) {
    const [, surfaceRaw, groupRaw, observedRaw, supportedRaw] = match;
    if (isSurface(surfaceRaw)) {
      return {
        surface: surfaceRaw,
        observed: Number(observedRaw),
        supported: Number(supportedRaw),
        group: groupRaw || undefined,
      };
    }
  }

  // Message carried the token but not the parseable tail (e.g. a future
  // message-format change) — still report it as a format-too-new failure so
  // the blocking modal fires; the UI copy degrades to the generic wording.
  return { surface: "storage", observed: 0, supported: 0 };
};

export const isLibraryFormatTooNewMessage = (error: unknown): boolean =>
  parseLibraryFormatTooNew(error) !== null;

export const createInFlightOnce = <T,>(factory: () => Promise<T>) => {
  let inFlight: Promise<T> | null = null;
  return () => {
    if (inFlight) return inFlight;
    const currentWrapped: Promise<T> = factory().then(
      (value) => {
        if (inFlight === currentWrapped) {
          inFlight = null;
        }
        return value;
      },
      (error) => {
        if (inFlight === currentWrapped) {
          inFlight = null;
        }
        throw error;
      }
    );
    inFlight = currentWrapped;
    return currentWrapped;
  };
};

export const SYNC_UNAVAILABLE_FALLBACK_MESSAGE =
  "Sync is temporarily unavailable. You're using local data until it recovers.";
export const SYNC_UNAVAILABLE_BLOCKING_MESSAGE =
  "Sync is temporarily unavailable. Please try again in a few moments.";

export const isSyncUnavailableFallbackMessage = (message: string | null | undefined) =>
  typeof message === "string" && message.trim() === SYNC_UNAVAILABLE_FALLBACK_MESSAGE;

/**
 * Offline mode — the remote library couldn't be reached at open time, but a
 * local cache exists, so we opened it locally and show only downloaded titles.
 * Distinct from the transient SYNC_UNAVAILABLE copy ("until it recovers"): this
 * is the user's "I'm offline" state, surfaced with a permanent banner.
 */
export const OFFLINE_MODE_FALLBACK_MESSAGE =
  "You're offline. Showing your downloaded titles.";

export const isOfflineModeFallbackMessage = (message: string | null | undefined) =>
  typeof message === "string" && message.trim() === OFFLINE_MODE_FALLBACK_MESSAGE;

/**
 * Does this library-open failure mean "the remote backend is unreachable"
 * (OS offline, runtime can't reach the API, connection refused/reset/timeout)
 * — as opposed to a decrypt failure, a format-too-new version skew, or an auth
 * error, which MUST stay hard failures (falling back to stale local data would
 * hide a real problem)? When true AND a local cache exists, we open the library
 * locally and enter offline mode instead of dead-ending on "Library
 * unavailable". Substring-based because the message crosses an IPC +
 * runtime-proxy boundary that flattens typed errors to plain strings.
 */
export const isRemoteUnreachableError = (error: unknown): boolean => {
  const m = getLibraryLoadErrorMessage(error).toLowerCase();
  if (!m) return false;
  // Conditions that must NOT silently fall back to local — surface them.
  if (m.includes("decrypt") || m.includes("library_format_too_new")) return false;
  return (
    m.includes("unable to connect") || // runtime sendCommand reachability error
    m.includes("able to access the url") ||
    m.includes("econnrefused") ||
    m.includes("enotfound") ||
    m.includes("etimedout") ||
    m.includes("econnreset") ||
    m.includes("socket hang up") ||
    m.includes("network") ||
    m.includes("fetch failed") ||
    m.includes("failed to fetch") ||
    m.includes("runtime_jobs_unreachable") ||
    m.includes("runtime_unreachable") ||
    m.includes("offline")
  );
};

/**
 * Decide how `load()` recovers from a failed REMOTE library open:
 *   - "sync_unavailable" → open locally + transient "recovering" banner;
 *   - "offline"          → open locally + permanent offline-mode banner;
 *   - null               → hard failure (decrypt, format-too-new, auth, …).
 */
export type LibraryOpenFallbackKind = "sync_unavailable" | "offline" | null;

// `ipcRenderer.invoke` rejects with the main-process message wrapped as
// "Error invoking remote method '<channel>': <Name>: <message>".
const IPC_REMOTE_ERROR_PREFIX = /^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/;

export const classifyLibraryOpenFallback = (error: unknown): LibraryOpenFallbackKind => {
  const message = getLibraryLoadErrorMessage(error).replace(IPC_REMOTE_ERROR_PREFIX, "");
  if (message === "SYNC_UNAVAILABLE") return "sync_unavailable";
  return isRemoteUnreachableError(error) ? "offline" : null;
};

// ---------------------------------------------------------------------------
// Offline → online auto-recovery.
//
// Once we enter offline mode (error === OFFLINE_MODE_FALLBACK_MESSAGE) the only
// existing recovery trigger is the window 'online' listener, which fires on
// navigator.onLine (OS link-state) transitions. When the OS network stayed UP
// the whole time and only the backend (API/runtime) was down, that event never
// fires — so the app would be stuck on downloaded titles even after the backend
// came back. The provider runs a backend-reachability poll while offline; on
// the first reachable verdict it calls reload(), which re-runs the full online
// open and clears offline mode via setError(null). These pure helpers are
// exported so the decision logic is unit-testable without an RTL harness
// (mirrors isRemoteUnreachableError's test surface).
// ---------------------------------------------------------------------------
export const RECONNECT_PROBE_INTERVAL_MS = 10_000;
export const RECONNECT_PROBE_TIMEOUT_MS = 5_000;
export const RECONNECT_PROBE_TIMEOUT_MESSAGE = "reconnect_probe_timeout";

/**
 * Given a reachability-probe rejection, is the backend STILL unreachable (keep
 * polling)? Our injected timeout counts as still-down. A reachable-but-erroring
 * backend (ApiError 401/500, or any non-connection error) is treated as UP, so
 * a recovered backend that briefly returns 5xx still triggers a reload() — and
 * load() then owns the auth/hard-fail decision.
 */
export const isReconnectProbeStillDown = (err: unknown): boolean =>
  (err instanceof Error && err.message === RECONNECT_PROBE_TIMEOUT_MESSAGE) ||
  isRemoteUnreachableError(err);

/**
 * Should the provider be polling for backend recovery? Only while in offline
 * mode (NEVER for the transient SYNC_UNAVAILABLE surface) and with a token to
 * probe with. navigator.onLine is checked separately at the effect site — a
 * genuine OS-offline state is handled by the existing 'online' listener.
 */
export const shouldPollForBackendRecovery = (
  error: string | null | undefined,
  token: string | null | undefined
): boolean => isOfflineModeFallbackMessage(error) && Boolean(token);

/**
 * Should the provider re-run load() because the runtime just (re)became ready
 * while the library is not open and sitting in a load-failure state? A healthy
 * library (db open) is left alone — main re-opens the runtime-side DB itself —
 * and so is a load still in flight (no error yet): that avoids a double open on
 * the normal boot-time 0 -> 1 transition.
 */
export const shouldReloadLibraryAfterRuntimeReady = (input: {
  previousInstanceId: number;
  instanceId: number;
  hasDb: boolean;
  error: string | null | undefined;
  userId: string | null | undefined;
}): boolean =>
  input.instanceId > 0 &&
  input.instanceId !== input.previousInstanceId &&
  !input.hasDb &&
  Boolean(input.error) &&
  Boolean(input.userId);

// ---------------------------------------------------------------------------
// Online → offline auto-switch (the SYMMETRIC counterpart of the recovery poll
// above). When the app is open+online and the backend dies mid-session, the app
// must AUTO-switch into offline mode (banner + downloaded-only) with no user
// interaction.
//
// FAILED-OP-DRIVEN, not a steady poll: the signal is an ACTUAL unreachable
// failure from the sync path we already run. The remote sync stream's fallback
// poll (LIBRARY_STREAM_FALLBACK_INTERVAL_MS = 30s) already calls getLibraryMeta;
// on a NON-401 failure it now hands us an onBackendUnreachable HINT instead of
// swallowing it. We add ZERO steady traffic while healthy — nothing extra runs
// until the backend was actually needed and unreachable. Because that fallback
// poll fires every 30s whenever the SSE stream is dead/stale (independent of
// user activity), it doubles as the IDLE HEARTBEAT: an idle user whose backend
// dies still gets a hint within ~30s, so no separate heartbeat timer is needed.
//
// CONFIRM, don't trust the first hint: a single failed poll is noisy (one flaky
// request, a benign reconnect). On each hint we run ONE reachability probe
// (getLibraryMeta raced vs a timeout, classified by isReconnectProbeStillDown —
// the exact confirmation the recovery poll already trusts) and only flip when it
// ALSO says still-down. A reachable-but-erroring backend (ApiError 401/500) is
// NOT an outage; the existing handleForcedLogout / hard-fail paths own it.
//
// Two properties make this safe:
//   1. MUTUAL EXCLUSION with the recovery poll is structural — we confirm/flip
//      ONLY while NOT offline (shouldConfirmBackendOutage), whereas
//      shouldPollForBackendRecovery is true ONLY in offline mode. No `error`
//      value satisfies both, so they can never both fire reload() → no flap loop.
//      Once we flip offline, this trigger disarms and the recovery poll takes
//      over to recover when the backend returns — a stable bidirectional cycle.
//   2. SINGLE-FLIGHT + RE-CHECK — only one confirmation probe runs at a time, and
//      we re-check the gate after the ~5s probe (the user may have flipped
//      offline / logged out meanwhile), so a stale confirmation never reload()s.
// ---------------------------------------------------------------------------

/**
 * Should we ACT on a backend-unreachable HINT from the sync stream? Only while
 * currently ONLINE+OPEN: a token to probe with AND NOT already in offline mode.
 * Guarding on "not offline mode" is the EXACT complement of
 * shouldPollForBackendRecovery's "is offline mode", so the confirmation and the
 * recovery poll are mutually exclusive for every `error` value (no flap loop).
 * The SYNC_UNAVAILABLE transient surfaces are non-offline → confirmation may run,
 * but the probe must say still-down before we flip, so they are harmless here.
 */
export const shouldConfirmBackendOutage = (
  error: string | null | undefined,
  token: string | null | undefined
): boolean => Boolean(token) && !isOfflineModeFallbackMessage(error);

export const clearStaleLibraryErrorAfterSnapshot = (message: string | null | undefined) =>
  message?.trim() === SYNC_UNAVAILABLE_BLOCKING_MESSAGE ? null : (message ?? null);

const arraysShallowEqual = (a: unknown[], b: unknown[]): boolean => {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((item, i) => item === b[i]);
};

type LibraryDataValue = Pick<
  LibraryContextValue,
  "loading" | "error" | "writeBlockedReason" | "media" | "playlists"
>;
type LibraryDebugValue = Pick<LibraryContextValue, "debugRevision">;
type LibraryIngestValue = Pick<LibraryContextValue, "ingestJobs">;
type LibraryShellValue = Pick<
  LibraryContextValue,
  "loading" | "error" | "formatTooNew" | "writeBlockedReason"
> & {
  datasetStatus: LibraryContextValue["datasetStatus"];
  mediaCount: number;
};
type LibraryActionsValue = Omit<
  LibraryContextValue,
  | "loading"
  | "error"
  | "formatTooNew"
  | "writeBlockedReason"
  | "media"
  | "playlists"
  | "ingestJobs"
  | "debugRevision"
>;

const LibraryDataContext = createContext<LibraryDataValue | undefined>(undefined);
const LibraryIngestContext = createContext<LibraryIngestValue | undefined>(undefined);
const LibraryDebugContext = createContext<LibraryDebugValue | undefined>(undefined);
const LibraryShellContext = createContext<LibraryShellValue | undefined>(undefined);
const LibraryActionsContext = createContext<LibraryActionsValue | undefined>(undefined);
// Latest library snapshot version. Isolated context to avoid re-rendering
// shell/data consumers (TopNav, gallery) every time the version bumps —
// only the play-button gate listens. `undefined` until the first snapshot
// applies; gates must treat that as "not yet ready".
const LibraryVersionContext = createContext<number | undefined>(undefined);

const STARTUP_PROFILE = import.meta.env.DEV && import.meta.env.VITE_PROFILE_STARTUP === "1";

const markStartup = (name: string) => {
  if (!STARTUP_PROFILE) return;
  performance.mark(name);
};

const measureStartup = (name: string, start: string, end: string) => {
  if (!STARTUP_PROFILE) return;
  performance.measure(name, start, end);
  const entry = performance.getEntriesByName(name).slice(-1)[0];
  if (entry) {
    libraryStartupLog.debug({ name, ms: Math.round(entry.duration) }, "startup");
  }
  performance.clearMarks(start);
  performance.clearMarks(end);
  performance.clearMeasures(name);
};

/** ACCT-SQUAD-03: this computer's capacity settings (`<userData>/device-settings.json`); none without the Electron bridge. */
const deviceCapacityStore = (): DeviceCapacityStore | undefined => {
  const bridge = window.sf?.deviceSettings;
  if (!bridge?.adoptCapacity || !bridge.setCapacity) return undefined;
  return { adoptCapacity: (seed) => bridge.adoptCapacity(seed), setCapacity: (values) => bridge.setCapacity(values) };
};

const describeError = (error: unknown) => {
  if (error instanceof Error) return error.message;
  return String(error ?? "unknown_error");
};

export const addMediaFromCatalogWithSnapshotRefresh = async ({
  db,
  item,
  requestSnapshotRefresh,
}: {
  db: Pick<LibraryDb, "addMediaFromCatalog">;
  item: TitleDetails;
  requestSnapshotRefresh: () => Promise<unknown>;
}) => {
  const mediaId = await db.addMediaFromCatalog(item);
  try {
    await requestSnapshotRefresh();
  } catch (error) {
    libraryContextLog.error({
      mediaType: item.type,
      catalogId: item.id ?? null,
      message: describeError(error),
    }, "addMediaFromCatalog snapshot refresh failed");
  }
  return mediaId;
};

/**
 * V2 cascade for the delete-media flow. Calls
 * `window.sf.runtimeJobs.cancelByGroup(mediaId)` when V2 is enabled, so the
 * runtime cancels in-flight jobs and dismisses terminal jobs for this media.
 * No-op when V2 is disabled or the IPC surface is unavailable. Errors are
 * swallowed (logged via `onError`) — the legacy lab-queue path is the safety
 * net. (effervescent-teapot Round 3 — "delete + re-add same file".)
 */
/**
 * Phase 6: parse the IPC payload shape sent by `libraryDbRuntimeProxy`'s
 * `sf-library-db-snapshot` channel. Main now emits `{ snapshot, version }`
 * (preferred) but older preload bundles forward bare `LibrarySnapshot`
 * objects. Both shapes must round-trip cleanly so the renderer keeps
 * working across preload + main version skew (e.g. an in-flight upgrade).
 *
 * Returns `null` when the payload is empty or unrecognized — caller skips
 * the apply step.
 */
export const parseSnapshotIpcPayload = (
  payload: unknown,
): { snapshot: LibrarySnapshot; version: number | undefined } | null => {
  if (!payload || typeof payload !== "object") return null;
  // New shape: { snapshot, version } where snapshot is a LibrarySnapshot
  // and version is an optional number. Tag detection: the new shape has
  // a `snapshot` property; the legacy shape has `media` (LibrarySnapshot
  // is the bare object).
  const obj = payload as Record<string, unknown>;
  if (obj.snapshot && typeof obj.snapshot === "object") {
    const v = obj.version;
    return {
      snapshot: obj.snapshot as LibrarySnapshot,
      version: typeof v === "number" ? v : undefined,
    };
  }
  if (Array.isArray(obj.media)) {
    // Legacy bare-snapshot shape.
    return { snapshot: obj as unknown as LibrarySnapshot, version: undefined };
  }
  return null;
};

export const cancelRuntimeJobsByGroupForDelete = async ({
  mediaId,
  v2Enabled,
  cancelByGroup,
  onError,
}: {
  mediaId: string;
  v2Enabled: boolean;
  cancelByGroup:
    | ((payload: { groupId: string; reason?: string }) => Promise<unknown>)
    | undefined;
  onError?: (error: unknown) => void;
}) => {
  if (!v2Enabled) return;
  if (!cancelByGroup) return;
  try {
    await cancelByGroup({ groupId: mediaId, reason: "media-deleted" });
  } catch (error) {
    onError?.(error);
  }
};

export const LibraryProvider = ({
  children,
  suspendLoad = false,
}: {
  children: React.ReactNode;
  suspendLoad?: boolean;
}) => {
  const { token, user, logout, systemIssue } = useAuth();
  const profiles = useProfiles();
  // UX-PROF-01: the cold-start cache holds one view per profile; none is read or written until a profile is chosen.
  const cacheProfileId =
    user && profiles.userId === user.id && profiles.status === "ready" ? profiles.activeId : null;
  const [db, setDb] = useState<LibraryDb | null>(null);
  const [media, setMedia] = useState<MediaRow[]>([]);
  const [playlists, setPlaylists] = useState<PlaylistRow[]>([]);
  const [playlistItemsMap, setPlaylistItemsMap] = useState<Record<string, string[]>>({});
  const [mediaDetailsMap, setMediaDetailsMap] = useState<Record<string, MediaDetails>>({});
  const [ingestJobs, setIngestJobs] = useState<IngestJob[]>([]);
  const [settingsMap, setSettingsMap] = useState<Record<string, { value: string; updatedAt: string }>>({});
  const [datasetStatus, setDatasetStatus] = useState(EMPTY_LIBRARY_DATASET_STATUS);
  const [debugRevision, setDebugRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when a library open fails because a surface is at a version newer than
  // this build supports. Distinct from the generic `error` string so the
  // blocking `LibraryFormatTooNewModal` can react to the typed condition and
  // render version-specific copy + the "Update Now" CTA. `null` in the common
  // case. See `parseLibraryFormatTooNew`.
  const [formatTooNew, setFormatTooNew] = useState<LibraryFormatTooNewDetail | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  /** Callers of `reload()` waiting for the load it starts to settle. */
  const reloadWaitersRef = useRef<Array<() => void>>([]);
  const [currentLibraryVersion, setCurrentLibraryVersion] = useState<number | undefined>(undefined);
  const syncingConfigRef = useRef(false);
  const activeProfile = useMemo(() => {
    const found = cacheProfileId ? profiles.profiles.find((profile) => profile.id === cacheProfileId) : undefined;
    return found ? { id: found.id, isMain: found.isMain } : null;
  }, [cacheProfileId, profiles.profiles]);
  const activeProfileRef = useRef(activeProfile);
  useEffect(() => {
    activeProfileRef.current = activeProfile;
  }, [activeProfile]);
  const streamRef = useRef<EventSource | null>(null);
  const streamTimerRef = useRef<number | null>(null);
  const fallbackTimerRef = useRef<number | null>(null);
  const lastStreamEventRef = useRef(0);
  const streamHealthTimerRef = useRef<number | null>(null);
  const externalMpvSessionActiveRef = useRef(false);
  const forcedLogoutInFlightRef = useRef(false);
  // Latest `error` value, mirrored into a ref so the STABLE confirmBackendOutage
  // callback (passed into the sync stream, which we don't want to re-attach on
  // every error change) can re-check the offline-mode gate before AND after its
  // async probe without taking `error` as a dependency.
  const errorRef = useRef<string | null>(null);
  // Single-flight guard: at most one online → offline confirmation probe runs at
  // a time, so a burst of hints (e.g. several failed fallback polls) cannot spam
  // reload() / open a probe storm.
  const confirmOutageInFlightRef = useRef(false);
  const uiSuspendCountRef = useRef(0);
  const uiSuspendedRef = useRef(false);
  const mediaRef = useRef<MediaRow[]>([]);
  const playlistsRef = useRef<PlaylistRow[]>([]);
  const mediaDetailsMapRef = useRef<Record<string, MediaDetails>>({});
  const settingsMapRef = useRef<Record<string, { value: string; updatedAt: string }>>({});
  const pendingMediaRef = useRef<MediaRow[] | ((prev: MediaRow[]) => MediaRow[]) | null>(null);
  const pendingPlaylistsRef = useRef<PlaylistRow[] | ((prev: PlaylistRow[]) => PlaylistRow[]) | null>(null);
  const pendingSnapshotRef = useRef<LibrarySnapshot | null>(null);
  const snapshotPersisterRef = useRef<LibrarySnapshotPersister | null>(null);
  const snapshotReadyRef = useRef(false);
  const snapshotBatchDepthRef = useRef(0);
  const snapshotBatchPendingRef = useRef(false);
  const loadInFlightRef = useRef<Promise<void> | null>(null);
  const datasetUnsubscribeRef = useRef<(() => void) | null>(null);
  const datasetWaitersRef = useRef<{
    core: Array<() => void>;
    metadata: Array<() => void>;
    playback: Array<() => void>;
  }>({ core: [], metadata: [], playback: [] });
  const datasetPrevRef = useRef(datasetStatus);
  const isLibraryStartupDebugEnabled = useCallback(() => {
    if (import.meta.env.DEV) return true;
    try {
      return window.localStorage.getItem("sf.debug.libraryStartup") === "1";
    } catch {
      return false;
    }
  }, []);
  const logLibraryStartup = useCallback(
    (traceId: string, event: string, payload?: Record<string, unknown>) => {
      if (!isLibraryStartupDebugEnabled()) return;
      libraryStartupLog.debug({ traceId, ...(payload ?? {}) }, event);
    },
    [isLibraryStartupDebugEnabled]
  );

  const bumpDebugRevision = useCallback(() => {
    setDebugRevision((prev) => prev + 1);
  }, []);

  // Forward the library master key both to the desktop main process (used
  // for local media decryption) and to the runtime (used for ingest
  // encryption — see apps/runtime/src/modules/badgerIngest.ts
  // `parseLibraryKey()` / `encryptMediaObject`). Without the runtime
  // forward, the OnboardingKey first-time path is the only place that
  // calls forwardKeyToRuntime, so a returning user (saved session) hits
  // `media_key_missing` at extract time.
  const userIdRef = useRef<string | null>(null);
  userIdRef.current = user?.id ?? null;
  const syncMediaKey = useCallback((key: string | null) => {
    void window.sf?.setMediaKey?.(key ?? null).catch(() => undefined);
    const uid = userIdRef.current;
    if (key && uid) {
      void window.sf?.forwardKeyToRuntime?.(uid, key).catch((err) => {
        libraryContextLog.error(
          { message: err instanceof Error ? err.message : String(err) },
          "forwardKeyToRuntime failed",
        );
      });
    }
  }, []);

  // Re-forward the library master key to the runtime whenever the runtime
  // transitions to "ready" (first spawn AND every respawn). The runtime
  // keeps its derived crypto state in memory only; on restart it loses the
  // library key it had been given; since RT-SEC-05 the runtime never writes
  // the key to disk, so nothing is replayed. The desktop authoritative copy
  // lives in localStorage — re-read it and resend, so post-restart ingest
  // jobs find the key at extract time. See plan `all-newly-added-jobs-cuddly-cookie`, Bug B.
  const runtimeInstanceId = useRuntimeInstanceId();
  useEffect(() => {
    if (!user?.id || runtimeInstanceId === 0) return;
    let cancelled = false;
    void getStoredLibraryKey()
      .then((key) => {
        if (cancelled || !key) return;
        libraryContextLog.info(
          { runtimeInstanceId, userId: user.id },
          "re-forwarding library key after runtime restart",
        );
        syncMediaKey(key);
      })
      .catch((err) => {
        libraryContextLog.warn(
          { message: err instanceof Error ? err.message : String(err) },
          "re-forward library key after runtime restart failed to read stored key",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [runtimeInstanceId, user?.id, syncMediaKey]);

  const updateMedia = useCallback(
    (next: MediaRow[] | ((prev: MediaRow[]) => MediaRow[])) => {
      if (uiSuspendedRef.current) {
        pendingMediaRef.current = next;
        return;
      }
      setMedia((prev) => (typeof next === "function" ? next(prev) : next));
      bumpDebugRevision();
    },
    [bumpDebugRevision]
  );

  const updatePlaylists = useCallback(
    (next: PlaylistRow[] | ((prev: PlaylistRow[]) => PlaylistRow[])) => {
      if (uiSuspendedRef.current) {
        pendingPlaylistsRef.current = next;
        return;
      }
      setPlaylists((prev) => (typeof next === "function" ? next(prev) : next));
      bumpDebugRevision();
    },
    [bumpDebugRevision]
  );

  const applySnapshot = useCallback(
    (snapshot: LibrarySnapshot, options?: { version?: number }) => {
      if (uiSuspendedRef.current) {
        pendingSnapshotRef.current = snapshot;
        // Stash the explicit version so the deferred flush also picks it up.
        // We thread it through `pendingSnapshotRef` by tagging the snapshot
        // with a non-enumerable hint; LibrarySnapshot already has an
        // optional `version` field so the simplest path is to set it
        // when present.
        if (typeof options?.version === "number") {
          (snapshot as LibrarySnapshot).version = options.version;
        }
        return;
      }
      // Use functional setState to skip updates when data is unchanged.
      // React bails out of re-renders when setState returns the same reference.
      let changed = false;
      setMedia((prev) => {
        if (arraysShallowEqual(prev, snapshot.media)) return prev;
        changed = true;
        return snapshot.media;
      });
      setPlaylists((prev) => {
        if (arraysShallowEqual(prev, snapshot.playlists)) return prev;
        changed = true;
        return snapshot.playlists;
      });
      setPlaylistItemsMap(snapshot.playlistItems ?? {});
      setMediaDetailsMap((prev) => {
        const nextEntries = snapshot.mediaDetails ?? [];
        const prevKeys = Object.keys(prev);
        if (prevKeys.length === nextEntries.length) {
          let same = true;
          for (let i = 0; i < nextEntries.length; i++) {
            const item = nextEntries[i];
            if (prev[item.id] !== item) {
              same = false;
              break;
            }
          }
          if (same) return prev;
        }
        const next: Record<string, MediaDetails> = {};
        for (const item of nextEntries) next[item.id] = item;
        changed = true;
        return next;
      });
      setIngestJobs((prev) => {
        const next = snapshot.ingestJobs ?? [];
        if (arraysShallowEqual(prev, next)) return prev;
        changed = true;
        return next;
      });
      setSettingsMap(snapshot.settings ?? {});
      setError((prev) => clearStaleLibraryErrorAfterSnapshot(prev));
      // Version source priority:
      //   1. Explicit `options.version` from the IPC `{snapshot, version}` shape.
      //   2. `snapshot.version` from sources that embed it (remote sync stream).
      //   3. Skip — leave context value at its previous reading.
      const incomingVersion =
        typeof options?.version === "number"
          ? options.version
          : typeof snapshot.version === "number"
            ? snapshot.version
            : undefined;
      if (typeof incomingVersion === "number") {
        setCurrentLibraryVersion((prev) =>
          prev === incomingVersion ? prev : incomingVersion,
        );
      }
      if (changed) {
        bumpDebugRevision();
      }
    },
    [bumpDebugRevision]
  );

  const flushPendingUpdates = useCallback(() => {
    if (pendingSnapshotRef.current) {
      const snapshot = pendingSnapshotRef.current;
      pendingSnapshotRef.current = null;
      pendingMediaRef.current = null;
      pendingPlaylistsRef.current = null;
      startTransition(() => {
        setMedia(snapshot.media);
        setPlaylists(snapshot.playlists);
        setPlaylistItemsMap(snapshot.playlistItems ?? {});
        setMediaDetailsMap(
          (snapshot.mediaDetails ?? []).reduce<Record<string, MediaDetails>>((acc, item) => {
            acc[item.id] = item;
            return acc;
          }, {})
        );
        setIngestJobs(snapshot.ingestJobs ?? []);
        setSettingsMap(snapshot.settings ?? {});
        setError((prev) => clearStaleLibraryErrorAfterSnapshot(prev));
        if (typeof snapshot.version === "number") {
          setCurrentLibraryVersion((prev) => (prev === snapshot.version ? prev : snapshot.version));
        }
        bumpDebugRevision();
      });
      return;
    }
    if (pendingMediaRef.current) {
      const next =
        typeof pendingMediaRef.current === "function"
          ? pendingMediaRef.current(mediaRef.current)
          : pendingMediaRef.current;
      pendingMediaRef.current = null;
      startTransition(() => {
        setMedia(next);
        bumpDebugRevision();
      });
    }
    if (pendingPlaylistsRef.current) {
      const next =
        typeof pendingPlaylistsRef.current === "function"
          ? pendingPlaylistsRef.current(playlistsRef.current)
          : pendingPlaylistsRef.current;
      pendingPlaylistsRef.current = null;
      startTransition(() => {
        setPlaylists(next);
        bumpDebugRevision();
      });
    }
  }, [bumpDebugRevision]);

  const scheduleFlush = useCallback(() => {
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(() => flushPendingUpdates(), { timeout: 1000 });
      return;
    }
    window.setTimeout(() => flushPendingUpdates(), 0);
  }, [flushPendingUpdates]);

  const suspendUiUpdates = useCallback(() => {
    uiSuspendCountRef.current += 1;
    uiSuspendedRef.current = true;
  }, []);

  const resumeUiUpdates = useCallback(() => {
    uiSuspendCountRef.current = Math.max(0, uiSuspendCountRef.current - 1);
    if (uiSuspendCountRef.current === 0 && uiSuspendedRef.current) {
      uiSuspendedRef.current = false;
      scheduleFlush();
    }
  }, [scheduleFlush]);

  useEffect(() => {
    mediaRef.current = media;
  }, [media]);

  useEffect(() => {
    playlistsRef.current = playlists;
  }, [playlists]);

  useEffect(() => {
    mediaDetailsMapRef.current = mediaDetailsMap;
  }, [mediaDetailsMap]);

  useEffect(() => {
    settingsMapRef.current = settingsMap;
  }, [settingsMap]);

  // ACCT-SQUAD-03: the account's settings with the active profile's playback settings on top (the app language is the account's, not the profile's).
  const syncClientConfigFromDb = useCallback(async (nextDb: LibraryDb) => {
    try {
      const current = loadClientConfig();
      const composed = await loadComposedClientConfig({
        db: nextDb,
        profile: activeProfileRef.current,
        local: current,
        device: deviceCapacityStore(),
      });
      if (JSON.stringify(current) === JSON.stringify(composed)) return;
      syncingConfigRef.current = true;
      saveClientConfig(composed);
    } catch {
      // Ignore invalid config payloads.
    } finally {
      syncingConfigRef.current = false;
    }
  }, []);

  const refreshSnapshot = useCallback(
    async (nextDb: LibraryDb) => {
      const snapshot = await nextDb.getSnapshot();
      applySnapshot(snapshot);
      return snapshot;
    },
    [applySnapshot]
  );

  const requestSnapshotRefresh = useCallback(
    async (nextDb: LibraryDb) => {
      if (snapshotBatchDepthRef.current > 0) {
        snapshotBatchPendingRef.current = true;
        return null;
      }
      return await refreshSnapshot(nextDb);
    },
    [refreshSnapshot]
  );

  const batchLibraryUpdates = useCallback(
    async <T,>(fn: () => Promise<T>) => {
      snapshotBatchDepthRef.current += 1;
      try {
        return await fn();
      } finally {
        snapshotBatchDepthRef.current = Math.max(0, snapshotBatchDepthRef.current - 1);
        if (snapshotBatchDepthRef.current === 0 && snapshotBatchPendingRef.current && db) {
          snapshotBatchPendingRef.current = false;
          await refreshSnapshot(db);
        }
      }
    },
    [db, refreshSnapshot]
  );

  const reload = useCallback(() => {
    const { promise, resolve } = Promise.withResolvers<void>();
    reloadWaitersRef.current.push(resolve);
    setReloadNonce((prev) => prev + 1);
    return promise;
  }, []);

  // Keep errorRef current for the stable confirmBackendOutage callback below.
  useEffect(() => {
    errorRef.current = error;
  }, [error]);

  // Online → offline auto-switch CONFIRMATION. Invoked by the sync stream's
  // onBackendUnreachable HINT (a non-401 failure of its 30s fallback poll — the
  // FAILED-OP signal). We run ONE reachability probe (raced vs
  // RECONNECT_PROBE_TIMEOUT_MS, exactly the recovery poll's probeOnce shape —
  // apiRequest has no built-in timeout, so a hung-but-TCP-accepting backend must
  // count as down) and only flip into offline mode (reload(), letting load()'s
  // catch set OFFLINE_MODE_FALLBACK_MESSAGE — the SINGLE source of truth, same as
  // the recovery direction) when the confirmation ALSO says still-down. A
  // reachable-but-erroring backend (401/500) is NOT an outage —
  // isReconnectProbeStillDown returns false, so we leave it to the existing
  // forced-logout / hard-fail paths. Gated by shouldConfirmBackendOutage (token
  // present, not already offline) so it is strictly exclusive with the recovery
  // poll and can never double-fire reload(). Single-flight via
  // confirmOutageInFlightRef so a burst of hints opens at most one probe.
  const confirmBackendOutage = useCallback(
    (reason: string) => {
      if (!shouldConfirmBackendOutage(errorRef.current, token)) return;
      if (confirmOutageInFlightRef.current) return; // single-flight
      if (!navigator.onLine) return; // genuine OS-offline owned by load()'s !online branch
      confirmOutageInFlightRef.current = true;
      const probeToken = token as string; // narrowed by shouldConfirmBackendOutage
      const traceId = `outage-${Date.now().toString(36)}`;
      logLibraryStartup(traceId, "outage.confirm.start", { reason });
      Promise.race([
        getLibraryMeta(probeToken),
        new Promise<never>((_, reject) =>
          window.setTimeout(
            () => reject(new Error(RECONNECT_PROBE_TIMEOUT_MESSAGE)),
            RECONNECT_PROBE_TIMEOUT_MS
          )
        ),
      ])
        .then(() => {
          // Probe reachable — the fallback failure was a blip. Stay online.
          logLibraryStartup(traceId, "outage.probe.up", {});
        })
        .catch((err) => {
          if (!isReconnectProbeStillDown(err)) {
            // Reachable-but-erroring (401/500): backend is UP, not an outage.
            logLibraryStartup(traceId, "outage.probe.up", { via: "error_status" });
            return;
          }
          // Re-check the gate: the user may have flipped offline (or logged out)
          // during the ~5s probe; if so, the recovery poll now owns the channel.
          if (!shouldConfirmBackendOutage(errorRef.current, token)) {
            logLibraryStartup(traceId, "outage.confirmed.stale", {});
            return;
          }
          logLibraryStartup(traceId, "outage.confirmed.reload", {
            timeout: err instanceof Error && err.message === RECONNECT_PROBE_TIMEOUT_MESSAGE,
          });
          reload(); // load()'s catch lands in offline mode
        })
        .finally(() => {
          confirmOutageInFlightRef.current = false;
        });
    },
    [token, reload, logLibraryStartup]
  );

  const activateRemoteLibrary = useCallback(
    async (nextToken: string, keyBase64: string) => {
      const startedAt = Date.now();
      const step = (name: string) =>
        libraryContextLog.info({ step: name, elapsedMs: Date.now() - startedAt }, "activateRemoteLibrary step");
      setLoading(true);
      setError(null);
      try {
        // Each account opens its own library files (LIB-STORE-06): without a signed-in user there is none to open.
        if (!user?.id) throw new Error("LIBRARY_USER_MISSING");
        step("open.start");
        const nextDb = await LibraryDb.open(nextToken, keyBase64, user.id);
        step("open.done");
        nextDb.setSyncEnabled(true);
        setDatasetStatus(await nextDb.getDatasetStatus());
        step("datasetStatus.done");
        datasetUnsubscribeRef.current?.();
        datasetUnsubscribeRef.current = nextDb.onDatasetStatus((status) => {
          setDatasetStatus(status);
        });
        await syncClientConfigFromDb(nextDb);
        step("clientConfig.done");
        setDb((prev) => {
          prev?.close();
          return nextDb;
        });
        await refreshSnapshot(nextDb);
        step("snapshot.done");
        nextDb.flushPending().catch(() => undefined);
        setError(null);
      } finally {
        setLoading(false);
      }
    },
    [refreshSnapshot, syncClientConfigFromDb, user?.id]
  );

  const handleForcedLogout = useCallback(async (reason: string, details?: Record<string, unknown>) => {
    if (forcedLogoutInFlightRef.current) return;
    if (!token) return;
    libraryContextLog.warn({ reason, ...(details ?? {}) }, "forced logout probe");
    const shouldLogout = await shouldLogoutAfterAuthProbe({
      probe: () => getMe(token),
      attempts: 2,
      delayMs: 300,
    });
    if (!shouldLogout) return;
    forcedLogoutInFlightRef.current = true;
    try {
      libraryContextLog.warn({ reason }, "forced logout confirmed");
      await logout("sessionRejected");
    } finally {
      forcedLogoutInFlightRef.current = false;
    }
  }, [logout, token]);

  const load = useCallback(async () => {
    if (loadInFlightRef.current) {
      return loadInFlightRef.current;
    }

    const run = (async () => {
      if (suspendLoad) {
        resetLibraryState({
          closeDb: () =>
            setDb((prev) => {
              prev?.close();
              return null;
            }),
          syncMediaKey,
          updateMedia,
          updatePlaylists,
          setPlaylistItemsMap,
          setMediaDetailsMap,
          setIngestJobs,
          setSettingsMap,
          setDatasetStatus,
          setError,
          error: null,
          setLoading,
          loading: false,
        });
        return;
      }

      const traceId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const loadStartedAt = performance.now();
      const stageSince = () => Math.max(0, Math.round(performance.now() - loadStartedAt));
      logLibraryStartup(traceId, "load.start", {
        hasToken: Boolean(token),
        hasUser: Boolean(user),
        online: navigator.onLine,
      });
      if (!token || !user) {
        resetLibraryState({
          closeDb: () =>
            setDb((prev) => {
              prev?.close();
              return null;
            }),
          syncMediaKey,
          updateMedia,
          updatePlaylists,
          setPlaylistItemsMap,
          setMediaDetailsMap,
          setIngestJobs,
          setSettingsMap,
          setDatasetStatus,
          setError,
          error: null,
          setLoading,
          loading: false,
        });
        logLibraryStartup(traceId, "load.skipped.session", { elapsedMs: stageSince() });
        return;
      }

      const keyAck = await isLibraryKeyAcknowledged().catch(() => false);
      if (!keyAck) {
        resetLibraryState({
          closeDb: () =>
            setDb((prev) => {
              prev?.close();
              return null;
            }),
          syncMediaKey,
          updateMedia,
          updatePlaylists,
          setPlaylistItemsMap,
          setMediaDetailsMap,
          setIngestJobs,
          setSettingsMap,
          setDatasetStatus,
          setError,
          error: null,
          setLoading,
          loading: false,
        });
        logLibraryStartup(traceId, "load.skipped.key_not_acknowledged", { elapsedMs: stageSince() });
        return;
      }

      const key = await getStoredLibraryKey().catch(() => null);
      if (!key) {
        resetLibraryState({
          syncMediaKey,
          updateMedia,
          updatePlaylists,
          setPlaylistItemsMap,
          setMediaDetailsMap,
          setIngestJobs,
          setSettingsMap,
          setDatasetStatus,
          setError,
          error: "Missing encryption key. Please set it again.",
        });
        logLibraryStartup(traceId, "load.failed.missing_key", { elapsedMs: stageSince() });
        return;
      }

      syncMediaKey(key);
      setLoading(true);
      setError(null);
      // Clear any prior format-too-new condition: a fresh open (e.g. after the
      // user updated the app) must be allowed to succeed and dismiss the modal.
      setFormatTooNew(null);
      setDatasetStatus(EMPTY_LIBRARY_DATASET_STATUS);
      try {
        const online = navigator.onLine;
        if (!online) {
          try {
            logLibraryStartup(traceId, "open.local.start", { elapsedMs: stageSince() });
            markStartup("library:open-local:start");
            const nextDb = await LibraryDb.openLocal(token, key, user.id);
            markStartup("library:open-local:end");
            measureStartup("library:open-local", "library:open-local:start", "library:open-local:end");
            nextDb.setSyncEnabled(false);
            setDatasetStatus(await nextDb.getDatasetStatus());
            datasetUnsubscribeRef.current?.();
            datasetUnsubscribeRef.current = nextDb.onDatasetStatus((status) => {
              setDatasetStatus(status);
            });
            await syncClientConfigFromDb(nextDb);
            setDb(() => nextDb);
            markStartup("library:snapshot:start");
            await refreshSnapshot(nextDb);
            markStartup("library:snapshot:end");
            measureStartup("library:snapshot", "library:snapshot:start", "library:snapshot:end");
            setError(null);
            logLibraryStartup(traceId, "open.local.success", {
              elapsedMs: stageSince(),
              datasetStatus: await nextDb.getDatasetStatus().catch(() => null),
            });
            return;
          } catch {
            logLibraryStartup(traceId, "open.local.failed", { elapsedMs: stageSince() });
            resetLibraryState({
              syncMediaKey,
              updateMedia,
              updatePlaylists,
              setPlaylistItemsMap,
              setMediaDetailsMap,
              setIngestJobs,
              setSettingsMap,
              setDatasetStatus,
              setError,
              error: "Could not load your library database.",
            });
            return;
          }
        }

        const meta = await getLibraryMeta(token).catch((err) => {
          if (err instanceof ApiError && err.status === 401) {
            void handleForcedLogout("meta_401");
          }
          return null;
        });
        logLibraryStartup(traceId, "meta.done", { elapsedMs: stageSince(), exists: meta?.exists ?? null });
        // PRIV-KEY-01: the kept key must still be the account's. An erase from any app or device (Badger or Parrot)
        // leaves no library and no probe, then the new key's probe: the erased key is forgotten here and the key step
        // asks for the account's key, or offers a new one, instead of opening (and publishing) under the old key.
        // Unread meta (offline) keeps the key. With no probe and no library, a key with no local library yet is a
        // new account's first key (its library is made now); one with a local library was erased elsewhere.
        const keptKey = await checkKeptLibraryKey(key, {
          readKeyProbe: async () => {
            if (!meta) throw new Error("library meta unavailable");
            return meta.keyProbe ?? null;
          },
          decryptProbe: decryptBase64ToBytes,
          opensAccountLibrary: async () =>
            meta?.exists || !(await LibraryDb.hasLocalCache().catch(() => false)) ? true : null,
          log: (message) => libraryContextLog.warn(message),
        });
        logLibraryStartup(traceId, "keptKey.done", { elapsedMs: stageSince(), keptKey });
        if (keptKey === "stale") {
          await clearLibraryKey().catch(() => undefined);
          syncMediaKey(null);
          await LibraryDb.clearLocalCache().catch(() => undefined);
          resetLibraryState({
            closeDb: () =>
              setDb((prev) => {
                prev?.close();
                return null;
              }),
            syncMediaKey,
            updateMedia,
            updatePlaylists,
            setPlaylistItemsMap,
            setMediaDetailsMap,
            setIngestJobs,
            setSettingsMap,
            setDatasetStatus,
            setError,
            error: "Missing encryption key. Please set it again.",
            setLoading,
            loading: false,
          });
          return;
        }

        if (meta?.exists === false && meta.bootstrapRequired === false) {
          setError(SYNC_UNAVAILABLE_BLOCKING_MESSAGE);
        }

        if (meta?.exists === false && meta.bootstrapRequired) {
          const hasLocalCache = await LibraryDb.hasLocalCache().catch(() => false);
          if (!hasLocalCache) {
            // No existing library yet for this account; continue with bootstrap.
          }
        }

        markStartup("library:open-remote:start");
        logLibraryStartup(traceId, "open.remote.start", { elapsedMs: stageSince() });
        const nextDb = await LibraryDb.open(token, key, user.id);
        markStartup("library:open-remote:end");
        measureStartup("library:open-remote", "library:open-remote:start", "library:open-remote:end");
        nextDb.setSyncEnabled(true);
        setDatasetStatus(await nextDb.getDatasetStatus());
        datasetUnsubscribeRef.current?.();
        datasetUnsubscribeRef.current = nextDb.onDatasetStatus((status) => {
          setDatasetStatus(status);
        });
        await syncClientConfigFromDb(nextDb);
        setDb(() => nextDb);
        markStartup("library:snapshot:start");
        await refreshSnapshot(nextDb);
        markStartup("library:snapshot:end");
        measureStartup("library:snapshot", "library:snapshot:start", "library:snapshot:end");
        nextDb.flushPending().catch(() => undefined);
        logLibraryStartup(traceId, "open.remote.success", {
          elapsedMs: stageSince(),
          datasetStatus: await nextDb.getDatasetStatus().catch(() => null),
        });
      } catch (err) {
        const errorMessage = getLibraryLoadErrorMessage(err);
        libraryContextLog.error({ message: errorMessage }, "load failed");
        logLibraryStartup(traceId, "load.failed", {
          elapsedMs: stageSince(),
          message: errorMessage,
        });
        // Open the library LOCALLY (offline) when the remote backend can't be
        // reached. Two flavours:
        //   - SYNC_UNAVAILABLE  → transient: show all local data + a "recovering"
        //     banner (existing behaviour).
        //   - remote-unreachable (network down, runtime can't reach the API) →
        //     OFFLINE MODE: permanent banner + only downloaded titles shown.
        // Decrypt / format-too-new / auth errors are excluded by the predicate
        // and fall through to the hard-fail below.
        const fallbackKind = classifyLibraryOpenFallback(err);
        const offlineMode = fallbackKind === "offline";
        if (fallbackKind !== null) {
          try {
            logLibraryStartup(traceId, "open.local.fallback.start", {
              elapsedMs: stageSince(),
              offlineMode,
            });
            const nextDb = await LibraryDb.openLocal(token, key, user.id);
            nextDb.setSyncEnabled(false);
            setDatasetStatus(await nextDb.getDatasetStatus());
            datasetUnsubscribeRef.current?.();
            datasetUnsubscribeRef.current = nextDb.onDatasetStatus((status) => {
              setDatasetStatus(status);
            });
            await syncClientConfigFromDb(nextDb);
            setDb(() => nextDb);
            await refreshSnapshot(nextDb);
            setError(offlineMode ? OFFLINE_MODE_FALLBACK_MESSAGE : SYNC_UNAVAILABLE_FALLBACK_MESSAGE);
            logLibraryStartup(traceId, "open.local.fallback.success", {
              elapsedMs: stageSince(),
              offlineMode,
            });
            return;
          } catch (innerErr) {
            // A LibraryFormatTooNewError from openLocal's constructor means
            // this build cannot safely open the library locally either — the
            // user needs to update. Pre-fix the bare `catch {}` here silently
            // collapsed this into the generic SYNC_UNAVAILABLE_BLOCKING_MESSAGE
            // copy, hiding the typed error from `parseLibraryFormatTooNew`
            // and the format-too-new modal at line ~1181 below. Detect it
            // here, set the modal state directly, and reset the rest of
            // the library state with the format-too-new copy.
            const innerTooNew = parseLibraryFormatTooNew(innerErr);
            if (innerTooNew) {
              setFormatTooNew(innerTooNew);
              logLibraryStartup(traceId, "open.local.fallback.format_too_new", {
                elapsedMs: stageSince(),
                surface: innerTooNew.surface,
              });
              resetLibraryState({
                syncMediaKey,
                updateMedia,
                updatePlaylists,
                setPlaylistItemsMap,
                setMediaDetailsMap,
                setIngestJobs,
                setSettingsMap,
                setDatasetStatus,
                setError,
                error: "This library was created by a newer version of Badger Desktop.",
              });
              return;
            }
            logLibraryStartup(traceId, "open.local.fallback.failed", { elapsedMs: stageSince() });
            resetLibraryState({
              syncMediaKey,
              updateMedia,
              updatePlaylists,
              setPlaylistItemsMap,
              setMediaDetailsMap,
              setIngestJobs,
              setSettingsMap,
              setDatasetStatus,
              setError,
              error: SYNC_UNAVAILABLE_BLOCKING_MESSAGE,
            });
            return;
          }
        }
        // A forward version skew on any of the three library surfaces means
        // this build cannot safely open the library — surface the typed
        // condition so the blocking `LibraryFormatTooNewModal` takes over with
        // the "Update Now" CTA instead of a dead-end generic error.
        const tooNew = parseLibraryFormatTooNew(err);
        if (tooNew) {
          setFormatTooNew(tooNew);
        }
        const message = tooNew
          ? "This library was created by a newer version of Badger Desktop."
          : isDecryptFailureMessage(err)
            ? "Could not decrypt your library. Double-check your encryption key."
            : "Could not load your library database.";
        resetLibraryState({
          closeDb: () =>
            setDb((prev) => {
              prev?.close();
              return null;
            }),
          clearDatasetSubscription: () => {
            datasetUnsubscribeRef.current?.();
            datasetUnsubscribeRef.current = null;
          },
          syncMediaKey,
          updateMedia,
          updatePlaylists,
          setPlaylistItemsMap,
          setMediaDetailsMap,
          setIngestJobs,
          setSettingsMap,
          setDatasetStatus,
          setError,
          error: message,
        });
      } finally {
        setLoading(false);
        logLibraryStartup(traceId, "load.end", { elapsedMs: stageSince() });
      }
    })();

    // `run` is the raw async IIFE; `wrapped` is what we expose to callers so
    // they all observe the same completion. The in-flight guard must compare
    // against `wrapped` (what we actually stored) — an earlier version
    // compared against `run`, which is a different Promise object, so the
    // guard was never cleared and every subsequent `load()` after the first
    // invocation returned the stale resolved Promise without actually
    // re-running. That left the React-state `db` permanently null after the
    // first bail (e.g. `load:skipped.key_not_acknowledged`) even when a
    // `reload()` nonce bump tried to re-trigger it.
    const wrapped = run.finally(() => {
      if (loadInFlightRef.current === wrapped) {
        loadInFlightRef.current = null;
      }
    });
    loadInFlightRef.current = wrapped;

    return wrapped;
  }, [
    suspendLoad,
    token,
    user,
    handleForcedLogout,
    logLibraryStartup,
    refreshSnapshot,
    syncClientConfigFromDb,
    syncMediaKey,
    updateMedia,
    updatePlaylists,
  ]);

  useEffect(() => {
    const waiters = reloadWaitersRef.current.splice(0);
    void load()
      .catch(() => undefined)
      .finally(() => {
        for (const resolve of waiters) resolve();
      });
    return () => {
      setDb((prev) => {
        prev?.close();
        return null;
      });
      datasetUnsubscribeRef.current?.();
      datasetUnsubscribeRef.current = null;
    };
  }, [load, reloadNonce]);

  // E2E readiness signal: expose a boolean on window so Playwright can wait
  // for the LibraryProvider to have finished `load()` AND set the React-state
  // `db` instance. Without this, tests that poll `window.sf.libraryDb.call`
  // pass as soon as the main-process proxy has a cached snapshot (e.g. from
  // the OnboardingKey temp-open), which is too early for flows that rely on
  // `useLibraryActions()` — those throw `LIBRARY_NOT_READY` until React has
  // observed the `setDb(nextDb)` update.
  useEffect(() => {
    const w = window as unknown as { __sfE2eLibraryActionsReady?: boolean };
    w.__sfE2eLibraryActionsReady = Boolean(db);
    return () => {
      w.__sfE2eLibraryActionsReady = false;
    };
  }, [db]);

  useEffect(() => {
    if (!window.sf?.libraryDb?.onSnapshot) return;
    const unsubscribe = window.sf.libraryDb.onSnapshot((payload: unknown) => {
      const parsed = parseSnapshotIpcPayload(payload);
      if (!parsed) return;
      applySnapshot(parsed.snapshot, { version: parsed.version });
    });
    return () => {
      unsubscribe?.();
    };
  }, [applySnapshot]);

  useEffect(() => {
    const handleE2eRefresh = () => {
      if (!db) return;
      void refreshSnapshot(db);
    };
    window.addEventListener("sf:e2e-library-refresh", handleE2eRefresh as EventListener);
    return () => window.removeEventListener("sf:e2e-library-refresh", handleE2eRefresh as EventListener);
  }, [db, refreshSnapshot]);

  useEffect(() => {
    const handle = () => {
      // Drop any pending cache write first so it cannot resurrect the cache.
      snapshotPersisterRef.current?.cancel();
      if (user?.id) {
        clearLibrarySnapshotCache(user.id);
      }
      resetLibraryState({
        closeDb: () =>
          setDb((prev) => {
            prev?.close();
            return null;
          }),
        syncMediaKey,
        updateMedia,
        updatePlaylists,
        setPlaylistItemsMap,
        setMediaDetailsMap,
        setIngestJobs,
        setSettingsMap,
        setDatasetStatus,
        setError,
        error: null,
        setLoading,
        loading: false,
      });
    };
    window.addEventListener("sf:logout", handle);
    return () => window.removeEventListener("sf:logout", handle);
  }, [syncMediaKey, updateMedia, updatePlaylists, user?.id]);

  useEffect(() => {
    if (!user?.id) return;
    snapshotReadyRef.current = false;
  }, [user?.id]);

  useEffect(() => {
    if (!datasetStatus.core) return;
    const queued = datasetWaitersRef.current.core.slice();
    if (!queued.length) return;
    datasetWaitersRef.current.core = [];
    queued.forEach((resolve) => resolve());
  }, [datasetStatus.core]);

  useEffect(() => {
    if (!datasetStatus.metadata) return;
    const queued = datasetWaitersRef.current.metadata.slice();
    if (!queued.length) return;
    datasetWaitersRef.current.metadata = [];
    queued.forEach((resolve) => resolve());
  }, [datasetStatus.metadata]);

  useEffect(() => {
    if (!datasetStatus.playback) return;
    const queued = datasetWaitersRef.current.playback.slice();
    if (!queued.length) return;
    datasetWaitersRef.current.playback = [];
    queued.forEach((resolve) => resolve());
  }, [datasetStatus.playback]);

  useEffect(() => {
    if (!db) {
      datasetPrevRef.current = datasetStatus;
      return;
    }
    const prev = datasetPrevRef.current;
    if (!prev.metadata && datasetStatus.metadata) {
      void refreshSnapshot(db);
    }
    if (!prev.playback && datasetStatus.playback) {
      void refreshSnapshot(db);
    }
    datasetPrevRef.current = datasetStatus;
  }, [datasetStatus, db, refreshSnapshot]);

  useEffect(() => {
    if (!user?.id || !cacheProfileId) return;
    if (snapshotReadyRef.current) return;
    if (db) return;
    if (media.length || playlists.length) return;
    const snapshot = loadLibrarySnapshotCache({ userId: user.id, profileId: cacheProfileId });
    if (!snapshot) return;
    snapshotReadyRef.current = true;
    applySnapshot(snapshot);
  }, [user?.id, cacheProfileId, db, media.length, playlists.length, applySnapshot]);

  // Cold-start snapshot cache (issue #25). One persister per signed-in user and chosen profile:
  // state changes only record a lazy getter; the ~1 MB stringify + setItem
  // runs in an idle slot after a 10 s quiet window, at most 60 s after the
  // first unsaved change, and synchronously on pagehide and before main
  // destroys the window for close-to-tray (which skips pagehide).
  useEffect(() => {
    if (!user?.id || !cacheProfileId) return;
    const scope = { userId: user.id, profileId: cacheProfileId };
    const persister = createLibrarySnapshotPersister({
      save: (snapshot) => saveLibrarySnapshotCache(scope, snapshot),
      log: (entry) => {
        if (entry.event === "error") libraryContextLog.warn(entry, "snapshot cache persist failed");
        else libraryContextLog.info(entry, "snapshot cache persist");
      },
    });
    snapshotPersisterRef.current = persister;
    const flushOnPageHide = () => persister.flush("pagehide");
    window.addEventListener("pagehide", flushOnPageHide);
    const unsubscribeBeforeDestroy = window.sf?.onBeforeWindowDestroy?.(() => persister.flush("window-destroy"));
    return () => {
      window.removeEventListener("pagehide", flushOnPageHide);
      unsubscribeBeforeDestroy?.();
      // User or profile switch / logout: the pending state may be a reset
      // (empty) library or the previous profile's view, so drop it rather
      // than write it under this scope.
      persister.cancel();
      if (snapshotPersisterRef.current === persister) snapshotPersisterRef.current = null;
    };
  }, [user?.id, cacheProfileId]);

  useEffect(() => {
    // Only state that came from an open library is worth caching; before the
    // DB opens the state is either empty or the cache itself.
    if (!db) return;
    snapshotPersisterRef.current?.markDirty(() => ({
      media,
      playlists,
      playlistItems: playlistItemsMap,
      mediaDetails: Object.values(mediaDetailsMap),
      ingestJobs,
      settings: settingsMap,
    }));
  }, [db, media, playlists, playlistItemsMap, mediaDetailsMap, ingestJobs, settingsMap]);

  useEffect(() => {
    const onOnline = () => {
      reload();
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [reload]);

  // F5 (ultimate stress, issue #25): when the runtime was unreachable at the
  // instant the library opened (app relaunched while the previous runtime was
  // dying), load() fails and nothing re-ran it, so the library stayed unavailable
  // for the whole session. The guardian now recovers the runtime in the
  // background and broadcasts "ready"; re-run load() on that transition if the
  // library never opened.
  const lastSeenRuntimeInstanceIdRef = useRef(runtimeInstanceId);
  useEffect(() => {
    const previous = lastSeenRuntimeInstanceIdRef.current;
    lastSeenRuntimeInstanceIdRef.current = runtimeInstanceId;
    if (
      !shouldReloadLibraryAfterRuntimeReady({
        previousInstanceId: previous,
        instanceId: runtimeInstanceId,
        hasDb: Boolean(db),
        error,
        userId: user?.id ?? null,
      })
    ) {
      return;
    }
    libraryContextLog.info(
      { runtimeInstanceId, previousInstanceId: previous, error },
      "runtime ready while library is not open: reloading library",
    );
    reload();
  }, [runtimeInstanceId, db, error, user?.id, reload]);

  // Backend-reachability recovery. The 'online' listener above only fires on
  // navigator.onLine (OS link-state). When the OS network stayed UP but the
  // API/runtime backend was down, we entered offline mode via load()'s catch
  // and 'online' NEVER fires — leaving us stuck on downloaded titles. While
  // offline, poll a cheap authenticated probe; on the first "reachable" verdict
  // call reload(), which re-runs the FULL online open (the load effect cleanup
  // closes the offline db first, then LibraryDb.open remote runs +
  // setSyncEnabled(true)). The OFFLINE_MODE_FALLBACK_MESSAGE error string is the
  // SINGLE source of truth — we never clear it here; only a clean remote open
  // does (setError(null) at the top of load()). The probe hits the API directly
  // while the open routes through the runtime/main bridge, so a probe success
  // does NOT guarantee the open succeeds: a flap re-enters offline and re-arms.
  useEffect(() => {
    if (!shouldPollForBackendRecovery(error, token)) return;
    if (!navigator.onLine) return; // genuine OS-offline handled by 'online' above
    const probeToken = token as string; // narrowed by shouldPollForBackendRecovery
    const traceId = `recover-${Date.now().toString(36)}`;
    let cancelled = false;
    let timer: number | null = null;

    // apiRequest has NO built-in timeout (bare fetch): a TCP-accepting-but-hung
    // backend would leave this probe pending forever and never re-arm. Race it
    // against a reject so a hung probe counts as "still down".
    const probeOnce = () =>
      Promise.race([
        getLibraryMeta(probeToken),
        new Promise<never>((_, reject) =>
          window.setTimeout(
            () => reject(new Error(RECONNECT_PROBE_TIMEOUT_MESSAGE)),
            RECONNECT_PROBE_TIMEOUT_MS
          )
        ),
      ]);

    const schedule = () => {
      timer = window.setTimeout(runProbe, RECONNECT_PROBE_INTERVAL_MS);
    };

    const runProbe = () => {
      probeOnce()
        .then(() => {
          if (cancelled) return;
          cancelled = true; // stop re-arming; the effect re-runs if error changes
          logLibraryStartup(traceId, "recover.probe.reachable", { via: "meta_ok" });
          reload();
        })
        .catch((err) => {
          if (cancelled) return;
          if (isReconnectProbeStillDown(err)) {
            logLibraryStartup(traceId, "recover.probe.still_down", {
              timeout:
                err instanceof Error && err.message === RECONNECT_PROBE_TIMEOUT_MESSAGE,
            });
            schedule();
            return;
          }
          // Reachable-but-erroring (401/500): backend is UP — let load() re-open
          // and own the auth/hard-fail decision (handleForcedLogout).
          cancelled = true;
          logLibraryStartup(traceId, "recover.probe.reachable", { via: "error_status" });
          reload();
        });
    };

    logLibraryStartup(traceId, "recover.poll.start", {
      intervalMs: RECONNECT_PROBE_INTERVAL_MS,
    });
    runProbe(); // fire immediately for snappy recovery; self-re-arms on still-down
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      logLibraryStartup(traceId, "recover.poll.stop", {});
    };
  }, [error, token, reload, logLibraryStartup]);

  useEffect(() => {
    if (!db) return;
    // The config shown before each save: only the fields the user changed since are stamped (ACCT-SQUAD-03).
    let previous = loadClientConfig();
    const persist = () => {
      const config = loadClientConfig();
      const shown = previous;
      previous = config;
      if (syncingConfigRef.current) return;
      void persistComposedClientConfig({
        // The player reads the profile's settings times from settingsMap at play start (PLAY-TRACK-11): reflect the
        // row as soon as it is written, the snapshot refresh may come later.
        db: {
          getSetting: (key) => db.getSetting(key),
          setSetting: async (key, value, updatedAt) => {
            const result = await db.setSetting(key, value, updatedAt);
            setSettingsMap((prev) => ({ ...prev, [key]: { value, updatedAt: updatedAt ?? new Date().toISOString() } }));
            return result;
          },
        },
        profile: activeProfileRef.current,
        config,
        previous: shown,
        device: deviceCapacityStore(),
      }).catch(
        () => undefined,
      );
    };
    const unsubscribe = subscribeClientConfig(persist);
    return () => unsubscribe();
  }, [db]);

  // ACCT-SQUAD-03: switching profile shows that profile's playback settings; the app language stays the account's.
  const activeProfileKey = activeProfile ? `${activeProfile.id}:${activeProfile.isMain}` : null;
  useEffect(() => {
    if (!db || !activeProfileKey) return;
    void syncClientConfigFromDb(db);
  }, [db, activeProfileKey, syncClientConfigFromDb]);

  useEffect(() => {
    if (!db || !token) return;
    return attachLibraryRemoteSyncStream({
      db,
      token,
      streamRef,
      streamTimerRef,
      fallbackTimerRef,
      lastStreamEventRef,
      streamHealthTimerRef,
      externalMpvSessionActiveRef,
      refreshSnapshot: async (nextDb) => {
        await refreshSnapshot(nextDb);
      },
      syncClientConfigFromDb,
      handleForcedLogout,
      onBackendUnreachable: confirmBackendOutage,
      externalMpvSessionEvent: EXTERNAL_MPV_SESSION_EVENT,
      debugStream:
        import.meta.env.DEV &&
        typeof window !== "undefined" &&
        window.localStorage.getItem("sf.debug.libraryStream") === "1",
    });
  }, [db, token, handleForcedLogout, refreshSnapshot, syncClientConfigFromDb, confirmBackendOutage]);

  // META-ART-01: a matched title's artwork is copied into the user's storage in the background, one title at a
  // time, after the match is saved (never on its critical path). A failed image keeps its catalog path and is retried
  // the next time the title is matched, refreshed, restored or opened.
  const artworkCopyQueue = useMemo(() => {
    if (!db || !token) return null;
    // A migration applies one title every few seconds: re-read the library at most every ARTWORK_REFRESH_GAP_MS.
    const refreshAfterCopy = coalesceRefresh(() => requestSnapshotRefresh(db), {
      minGapMs: ARTWORK_REFRESH_GAP_MS,
      onError: (error) => console.warn("[artwork-copy] library refresh failed", error),
    });
    const queue = createDesktopArtworkCopyQueue({
      store: db,
      upload: async (kind, path) => {
        const key = await getStoredLibraryKey();
        if (!key) throw new Error("KEY_REQUIRED");
        return uploadEncryptedAssetFromMetadata(token, key, kind, path);
      },
      ticketsLeft: () => getDesktopMetadata().reserve.count(),
      discard: (keys) => deleteStorageObjects(token, keys),
      onApplied: async () => {
        refreshAfterCopy.request();
      },
    });
    return {
      ...queue,
      stop: () => {
        refreshAfterCopy.cancel();
        queue.stop();
      },
    };
  }, [db, token, requestSnapshotRefresh]);

  useEffect(() => () => artworkCopyQueue?.stop(), [artworkCopyQueue]);

  // META-ART-01: titles saved before copies existed (or whose copy failed) still carry provider paths and show a
  // placeholder. Once per open library they are scheduled behind any user action, one title every
  // ARTWORK_COPY_PAUSE_MS, so an existing library migrates without a burst at the metadata service.
  useEffect(() => {
    if (!db || !artworkCopyQueue) return;
    void scheduleArtworkMigration({
      listMediaIds: () => db.listMediaWithArtworkToCopy(),
      hasArtworkToCopy: () => true,
      queue: artworkCopyQueue,
    })
      .then((scheduled) => {
        if (scheduled > 0) console.info("[artwork-copy] migration scheduled", { titles: scheduled });
      })
      .catch((error: unknown) => console.warn("[artwork-copy] migration not scheduled", error));
  }, [db, artworkCopyQueue]);

  const copyMediaArtwork = useCallback(
    (mediaId: string) => {
      artworkCopyQueue?.schedule(mediaId);
    },
    [artworkCopyQueue]
  );

  const addMediaFromCatalog = useCallback(
    async (item: TitleDetails) => {
      if (!db) throw new Error("LIBRARY_NOT_READY");
      const mediaId = await addMediaFromCatalogWithSnapshotRefresh({
        db,
        item,
        requestSnapshotRefresh: () => requestSnapshotRefresh(db),
      });
      copyMediaArtwork(mediaId);
      return mediaId;
    },
    [db, requestSnapshotRefresh, copyMediaArtwork]
  );

  const linkFileToMedia = useCallback(
    async (mediaId: string, filename: string, season?: number | null, episode?: number | null) => {
      if (!db) throw new Error("LIBRARY_NOT_READY");
      const fileId = await db.linkFileToMedia(mediaId, filename, season, episode);
      await requestSnapshotRefresh(db);
      return fileId;
    },
    [db, requestSnapshotRefresh]
  );

  // Apply a transform to mediaDetailsMap[mediaId] immediately and return a
  // rollback function that restores the previous value. Updates BOTH the
  // React state (queued, drives re-render) AND the ref (synchronous, so
  // any same-tick reader sees the optimistic value before React commits).
  const applyOptimisticMediaDetailsUpdate = useCallback(
    (mediaId: string, transform: (details: MediaDetails) => MediaDetails): (() => void) => {
      const before = mediaDetailsMapRef.current[mediaId] ?? null;
      if (!before) {
        // Nothing cached to mutate — caller will rely on the eventual
        // snapshot refresh to bring the UI in line.
        return () => undefined;
      }
      const next = transform(before);
      // Sync ref first so same-tick readers (e.g. a handler that reads
      // getMediaDetails right after issuing an optimistic write) observe
      // the new value before React commits the state update.
      mediaDetailsMapRef.current = { ...mediaDetailsMapRef.current, [mediaId]: next };
      setMediaDetailsMap((map) => {
        const current = map[mediaId];
        if (!current) return map;
        return { ...map, [mediaId]: next };
      });
      return () => {
        mediaDetailsMapRef.current = { ...mediaDetailsMapRef.current, [mediaId]: before };
        setMediaDetailsMap((map) => ({ ...map, [mediaId]: before }));
      };
    },
    []
  );

  // Wrap a write so it: (1) keeps the optimistic UI applied in
  // mediaDetailsMap and media (already done by the caller before this fires),
  // (2) runs the IPC write in the background, (3) reverts + toasts on
  // failure. Returns a promise that resolves the next tick so callers that
  // `await` it don't perceive any latency.
  //
  // Why no requestSnapshotRefresh after success: every current caller (set
  // default audio/subtitle, update/remove tracks, setProgress) already
  // applies a precise optimistic transform covering every field the write
  // changes. Re-fetching the full library snapshot to "confirm" identical
  // state would round-trip a multi-MB IPC payload and block the main
  // process running db.getSnapshot() — observed as a 5–10s UI freeze after
  // a single radio-button click. If a future caller needs cross-row side
  // effects surfaced (e.g. a write that mutates rows the optimistic
  // transform can't predict), call requestSnapshotRefresh(db) explicitly at
  // the caller. The runtime mirror-push path still keeps far-side state
  // eventually consistent for cross-device sync.
  //
  // #25 P5: failures go through one tracker per provider, so a burst (every
  // write in flight fails when the runtime restarts) rolls back only the
  // newest write per field (`key`) and raises one toast per message per
  // window instead of one re-render + one toast per failed write.
  const [optimisticWrites] = useState(() =>
    createOptimisticWriteTracker({
      notifyError: (message) => notifyError(message),
      log: (fields, message) => libraryContextLog.warn(fields, message),
    }),
  );
  const runOptimisticWrite = useCallback(
    (
      key: string | null,
      rollback: () => void,
      write: () => Promise<unknown>,
      revertErrorMessage: string,
    ): Promise<void> => {
      const ticket = optimisticWrites.begin(key);
      void (async () => {
        try {
          await write();
          optimisticWrites.succeeded(ticket);
        } catch (err) {
          optimisticWrites.failed(ticket, rollback, revertErrorMessage, err);
        }
      })();
      return Promise.resolve();
    },
    [optimisticWrites]
  );

  const findMediaIdByTrackId = useCallback(
    (kind: "audio" | "subtitle", trackId: string): string | null => {
      const map = mediaDetailsMapRef.current;
      for (const mediaId of Object.keys(map)) {
        const details = map[mediaId];
        const tracks = kind === "audio" ? details.audioTracks : details.subtitleTracks;
        if (tracks.some((t) => t.id === trackId)) return mediaId;
      }
      return null;
    },
    []
  );

  const setProgress = useCallback(
    async (
      mediaId: string,
      progressPct: number,
      episodeId?: string | null,
      timing?: ProgressTiming | null,
      options?: { deferUi?: boolean }
    ) => {
      if (!db) throw new Error("LIBRARY_NOT_READY");
      const normalized = Math.max(0, Math.min(100, progressPct));
      const pct =
        normalized > 0 ? Math.max(0.0001, Math.round(normalized * 10000) / 10000) : 0;
      if (options?.deferUi) {
        // No optimistic UI write, so a failure has nothing to revert.
        return runOptimisticWrite(
          episodeId ? `progress:episode:${episodeId}` : `progress:media:${mediaId}`,
          () => {},
          () => db.setProgress(mediaId, pct, episodeId ?? null, timing ?? null),
          "Couldn't save playback progress",
        );
      }
      const timestamp = new Date().toISOString();
      // Snapshot the prior local state so a failed write can revert. The IPC
      // is fire-and-forget — the renderer reflects the new value
      // synchronously and the persistence happens in the background.
      let rollback: () => void;
      if (episodeId) {
        const key = `episode_resume_v1:${episodeId}`;
        const before = settingsMapRef.current[key] ?? null;
        // Phase 2 additive payload: include positionSeconds + durationSeconds
        // when supplied. Old reads (parseEpisodeResumeSetting in
        // library-db-runtime / buildEpisodeResumeMap on the renderer) ignore
        // unknown fields, so older clients deserialize cleanly. The
        // credits-aware completion check (isEpisodeCompleted) prefers
        // positionSeconds when present, else derives from pct * duration.
        const positionSeconds =
          timing && typeof timing.positionSeconds === "number" && Number.isFinite(timing.positionSeconds) && timing.positionSeconds >= 0
            ? timing.positionSeconds
            : null;
        const durationSeconds =
          timing && typeof timing.durationSeconds === "number" && Number.isFinite(timing.durationSeconds) && timing.durationSeconds > 0
            ? timing.durationSeconds
            : null;
        const payload: Record<string, unknown> = { progressPct: pct, updatedAt: timestamp };
        if (positionSeconds !== null) payload.positionSeconds = positionSeconds;
        if (durationSeconds !== null) payload.durationSeconds = durationSeconds;
        const value = JSON.stringify(payload);
        setSettingsMap((prev) => ({
          ...prev,
          [key]: { value, updatedAt: timestamp },
        }));
        rollback = () => {
          setSettingsMap((prev) => {
            const next = { ...prev };
            if (before) {
              next[key] = before;
            } else {
              delete next[key];
            }
            return next;
          });
        };
      } else {
        const beforeMedia = mediaRef.current.find((item) => item.id === mediaId) ?? null;
        const beforeDetails = mediaDetailsMapRef.current[mediaId] ?? null;
        updateMedia((prev) =>
          prev.map((item) =>
            item.id === mediaId
              ? { ...item, progressPct: pct, lastWatchedAt: timestamp, updatedAt: timestamp }
              : item
          )
        );
        setMediaDetailsMap((prev) => {
          const current = prev[mediaId];
          if (!current) return prev;
          return {
            ...prev,
            [mediaId]: {
              ...current,
              progressPct: pct,
              lastWatchedAt: timestamp,
              updatedAt: timestamp,
            },
          };
        });
        rollback = () => {
          if (beforeMedia) {
            updateMedia((prev) => prev.map((item) => (item.id === mediaId ? beforeMedia : item)));
          }
          if (beforeDetails) {
            setMediaDetailsMap((prev) => ({ ...prev, [mediaId]: beforeDetails }));
          }
        };
      }
      // PLAY-RESUME-05: the edition playing keeps its own spot, so "Which edition?" shows it at once.
      const editionId = timing?.editionId ?? null;
      if (editionId) {
        const key = editionResumeKey(editionId);
        const before = settingsMapRef.current[key] ?? null;
        const value = editionResumeValue({
          progressPct: pct,
          updatedAt: timestamp,
          positionSeconds: timing?.positionSeconds,
          durationSeconds: timing?.durationSeconds,
        });
        setSettingsMap((prev) => ({ ...prev, [key]: { value, updatedAt: timestamp } }));
        const rollbackProgress = rollback;
        rollback = () => {
          rollbackProgress();
          setSettingsMap((prev) => {
            const next = { ...prev };
            if (before) next[key] = before;
            else delete next[key];
            return next;
          });
        };
      }
      return runOptimisticWrite(
        episodeId ? `progress:episode:${episodeId}` : `progress:media:${mediaId}`,
        rollback,
        () => db.setProgress(mediaId, pct, episodeId ?? null, timing ?? null),
        "Couldn't save playback progress — change reverted",
      );
    },
    [db, runOptimisticWrite]
  );

  // ACCT-PROF-03: every screen shows the active profile's set of title, poster and backdrop; the media row keeps the
  // account-language set and the original set rides in its `title_variants_v1:<media id>` row.
  const clientConfig = useClientConfig();
  const titleLanguage = profileTitleLanguage(clientConfig);
  const titleVariantsOf = useCallback(
    (mediaId: string) => parseTitleVariants(settingsMapRef.current[titleVariantsKey(mediaId)]?.value),
    []
  );

  const getLibraryMediaDetails = useCallback(
    (mediaId: string) => {
      return mediaDetailsMap[mediaId] ?? null;
    },
    [mediaDetailsMap]
  );

  const getMediaDetails = useCallback(
    (mediaId: string) => {
      const details = mediaDetailsMap[mediaId];
      return details
        ? shownTitleArt(details, parseTitleVariants(settingsMap[titleVariantsKey(mediaId)]?.value), titleLanguage)
        : null;
    },
    // A variant row that arrives in settingsMap re-renders the shown title.
    [mediaDetailsMap, titleLanguage, settingsMap]
  );

  const fetchMediaDetails = useCallback(
    async (mediaId: string) => {
      if (!db) throw new Error("LIBRARY_NOT_READY");
      const details = await db.getMediaDetails(mediaId);
      if (details) {
        setMediaDetailsMap((prev) => ({ ...prev, [mediaId]: details }));
      }
      return details ? shownTitleArt(details, titleVariantsOf(mediaId), titleLanguage) : null;
    },
    [db, titleLanguage, titleVariantsOf]
  );

  const listPlaylistItems = useCallback(
    (playlistId: string) => {
      return playlistItemsMap[playlistId] ?? [];
    },
    [playlistItemsMap]
  );

  const ensureRemoteFresh = useCallback(async () => {
    if (!db) return;
    try {
      const changed = await db.syncFromRemoteIfNewer();
      if (changed) {
        await refreshSnapshot(db);
        await syncClientConfigFromDb(db);
      }
    } catch (error) {
      libraryPreflightLog.warn({ error: describeError(error) }, "sync.failed");
    }
  }, [db, refreshSnapshot, syncClientConfigFromDb]);

  // ACCT-PROF-02 data moves (`createProfileLibraryMoves`): delete and heal need a sync the server confirmed.
  const profileMoves = useMemo<ProfileLibraryMoves | null>(() => {
    if (!db) return null;
    return createProfileLibraryMoves({
      db,
      token,
      getLibraryMeta,
      ensureRemoteFresh,
      refreshSnapshot: () => requestSnapshotRefresh(db),
      log: profileMovesLog,
    });
  }, [db, token, ensureRemoteFresh, requestSnapshotRefresh]);

  // An open library finishes a main profile's move another device (or this one, offline) left halfway.
  useEffect(() => {
    if (!profileMoves) return;
    attachProfileLibrary(profileMoves);
    return () => attachProfileLibrary(null);
  }, [profileMoves]);

  const awaitDatasetReady = useCallback(
    (stage: "core" | "metadata" | "playback") => {
      if (datasetStatus[stage]) return Promise.resolve();
      return new Promise<void>((resolve) => {
        datasetWaitersRef.current[stage].push(resolve);
      });
    },
    [datasetStatus]
  );

  const createPlaylist = useCallback(
    async (name: string) => {
      if (!db) throw new Error("LIBRARY_NOT_READY");
      await ensureRemoteFresh();
      await db.createPlaylist(name);
      await requestSnapshotRefresh(db);
    },
    [db, ensureRemoteFresh, requestSnapshotRefresh]
  );

  const deletePlaylist = useCallback(
    async (playlistId: string) => {
      if (!db) throw new Error("LIBRARY_NOT_READY");
      await ensureRemoteFresh();
      await db.deletePlaylist(playlistId);
      await requestSnapshotRefresh(db);
    },
    [db, ensureRemoteFresh, requestSnapshotRefresh]
  );

  const addToPlaylist = useCallback(
    async (playlistId: string, mediaId: string) => {
      if (!db) throw new Error("LIBRARY_NOT_READY");
      await db.addToPlaylist(playlistId, mediaId);
      await requestSnapshotRefresh(db);
    },
    [db, requestSnapshotRefresh]
  );

  const removeFromPlaylist = useCallback(
    async (playlistId: string, mediaId: string) => {
      if (!db) throw new Error("LIBRARY_NOT_READY");
      await db.removeFromPlaylist(playlistId, mediaId);
      await requestSnapshotRefresh(db);
    },
    [db, requestSnapshotRefresh]
  );

  const getSystemPlaylistId = useCallback(
    (slug: "favorites") => {
      return playlists.find((item) => item.slug === slug)?.id ?? null;
    },
    [playlists]
  );

  const getPlaylistIdBySlug = useCallback(
    (slug: string) => playlists.find((item) => item.slug === slug)?.id ?? null,
    [playlists]
  );

  const deleteMedia = useCallback(
    async (mediaId: string) => {
      if (!db) throw new Error("LIBRARY_NOT_READY");
      markMediaDeleted(mediaId);
      // V2 cascade: cancel + dismiss runtime_jobs.db rows for this media so a
      // re-add of the same source file produces fresh jobs instead of
      // deduping against stale (succeeded/cancelled/failed) terminal rows.
      // (effervescent-teapot Round 3.)
      await cancelRuntimeJobsByGroupForDelete({
        mediaId,
        v2Enabled: loadClientConfig().runtimeEngineV2Enabled,
        cancelByGroup: window.sf?.runtimeJobs?.cancelByGroup,
        onError: (error) =>
          libraryContextLog.warn(
            { mediaId, message: describeError(error) },
            "runtime jobs cancelByGroup failed"
          ),
      });
      const keys = await db.getMediaObjectKeys(mediaId);
      await db.deleteMedia(mediaId);
      await requestSnapshotRefresh(db);
      return { keys };
    },
    [db, requestSnapshotRefresh, token, user?.id]
  );

  const deleteMediaFile = useCallback(
    async (fileId: string) => {
      if (!db) throw new Error("LIBRARY_NOT_READY");
      await db.deleteMediaFile(fileId);
      await requestSnapshotRefresh(db);
    },
    [db, requestSnapshotRefresh]
  );

  const replaceMediaTrailers = useCallback(
    async (mediaId: string, trailers: TitleDetails["trailers"]) => {
      if (!db) throw new Error("LIBRARY_NOT_READY");
      await db.replaceMediaTrailers(mediaId, trailers);
      await requestSnapshotRefresh(db);
    },
    [db, requestSnapshotRefresh]
  );

  const updateMediaMetadata = useCallback(
    async (payload: {
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
        totalEpisodes?: number | null;
      };
      cast?: MediaCastDraft[];
      crew?: MediaCrewDraft[];
      seasons?: MediaSeasonDraft[];
      episodes?: MediaEpisodeDraft[];
    }) => {
      if (!db) throw new Error("LIBRARY_NOT_READY");
      await db.updateMediaMetadata(payload);
      await requestSnapshotRefresh(db);
    },
    [db, requestSnapshotRefresh]
  );

  const restoreMediaFromCatalog = useCallback(
    async (mediaId: string, options: { resetCast: boolean }) => {
      if (!db) throw new Error("LIBRARY_NOT_READY");
      if (!token) throw new Error("AUTH_REQUIRED");
      const key = await getStoredLibraryKey();
      if (!key) throw new Error("KEY_REQUIRED");

      const details = await db.getMediaDetails(mediaId);
      if (!details || details.catalogId === null) throw new Error("CATALOG_REQUIRED");

      const fresh = await getTitleDetails(token, details.type, details.catalogId);
      const config = loadClientConfig();
      const trailers = await getTitleTrailersForLanguages(token, details.type, details.catalogId, [
        fresh.originalLanguage,
        ...(config.trailerLanguages.extras ?? []),
      ]);
      const withAssets = await attachCatalogAssets(token, key, { ...fresh, trailers }, { includeCast: options.resetCast });

      const seasonByNumber = new Map(details.seasons.map((season) => [season.seasonNumber, season.id]));
      const episodeByKey = new Map(
        details.episodes.map((episode) => [`${episode.seasonNumber}:${episode.episodeNumber}`, episode.id])
      );

      await db.updateMediaMetadata({
        mediaId,
        media: {
          title: withAssets.title,
          originalTitle: withAssets.originalTitle,
          originalLanguage: withAssets.originalLanguage,
          overview: withAssets.overview,
          year: withAssets.year,
          rating: withAssets.rating,
          posterPath: withAssets.posterPath,
          backdropPath: withAssets.backdropPath,
          genres: Array.isArray(withAssets.genres) ? withAssets.genres : [],
          totalEpisodes: withAssets.totalEpisodes ?? null,
        },
        seasons: withAssets.seasons
          .map((season) => ({
            id: seasonByNumber.get(season.seasonNumber) ?? "",
            name: season.name,
            overview: season.overview ?? null,
            posterPath: season.posterPath ?? null,
            episodeCount: season.episodeCount ?? 0,
            airDate: season.airDate ?? null,
          }))
          .filter((season) => season.id),
        episodes: withAssets.episodes
          .map((episode) => ({
            id: episodeByKey.get(`${episode.seasonNumber}:${episode.episodeNumber}`) ?? "",
            name: episode.name,
            overview: episode.overview ?? null,
            stillPath: episode.stillPath ?? null,
            airDate: episode.airDate ?? null,
          }))
          .filter((episode) => episode.id),
        cast: options.resetCast
          ? withAssets.cast.map((member) => ({
              catalogId: member.personId ?? null,
              name: member.name,
              role: member.role ?? null,
              profilePath: member.profilePath ?? null,
            }))
          : undefined,
        crew: pickLibraryCrew(fresh.crew ?? []),
      });

      await db.replaceMediaTrailers(mediaId, withAssets.trailers);
      if (details.type === "tv") {
        // The updates above only touch stored rows; the merge adds the seasons and episodes announced since the
        // show was added (LIB-SHOW-01), keeping every stored episode id.
        const merged = await db.refreshShowEpisodes(mediaId, withAssets);
        libraryContextLog.info({ mediaId, source: "restore", ...merged }, "library.showRefresh");
      }
      await requestSnapshotRefresh(db);
      // Restore copies poster, backdrop, cast and season posters itself; stills and anything it could not copy follow.
      copyMediaArtwork(mediaId);
    },
    [db, token, requestSnapshotRefresh, copyMediaArtwork]
  );

  const refreshShowEpisodes = useCallback(
    async (mediaId: string, item: TitleDetails) => {
      if (!db) throw new Error("LIBRARY_NOT_READY");
      const result = await db.refreshShowEpisodes(mediaId, item);
      if (result.changed) await requestSnapshotRefresh(db);
      // New seasons and episodes arrive with catalog paths; earlier failures are retried here too (META-ART-01).
      copyMediaArtwork(mediaId);
      return result;
    },
    [db, requestSnapshotRefresh, copyMediaArtwork]
  );

  // LIB-CAST-01: once per opened library, titles whose cast the old code merged into one person get the catalog's cast
  // again, each title once (the marker is a synced setting). Only the cast is rewritten, unlike "Restore from
  // the catalog": titles, synopsis and artwork stay as the user has them. Cast photos keep catalog paths here and are copied
  // by the background artwork copy (META-ART-01).
  const castRefetchDbRef = useRef<LibraryDb | null>(null);
  useEffect(() => {
    if (!db || !token || systemIssue || !datasetStatus.metadata) return;
    if (castRefetchDbRef.current === db) return;
    castRefetchDbRef.current = db;
    let finished = false;
    let stopped = false;
    const refetchCast = async (mediaId: string) => {
      const details = await db.getMediaDetails(mediaId);
      if (!details || details.catalogId === null) return;
      const fresh = await getTitleDetails(token, details.type, details.catalogId);
      await db.updateMediaMetadata({
        mediaId,
        cast: fresh.cast.map((member) => ({
          catalogId: member.personId ?? null,
          name: member.name,
          role: member.role ?? null,
          profilePath: member.profilePath ?? null,
        })),
      });
      copyMediaArtwork(mediaId);
    };
    void refetchCollapsedCasts(db, refetchCast, {
      shouldStop: () => stopped,
      onError: (mediaId, err) => libraryContextLog.warn({ mediaId, err: String(err) }, "library.castRefetch.failed"),
    })
      .then(async (result) => {
        finished = true;
        if (result.found > 0) libraryContextLog.info(result, "library.castRefetch");
        if (result.refetched > 0) await requestSnapshotRefresh(db);
      })
      .catch((err) => libraryContextLog.warn({ err: String(err) }, "library.castRefetch.listFailed"));
    return () => {
      stopped = true;
      // A pass cut short (sign-out, a dependency change) starts again on the next run; repaired titles are skipped.
      if (!finished && castRefetchDbRef.current === db) castRefetchDbRef.current = null;
    };
  }, [db, token, systemIssue, datasetStatus.metadata, requestSnapshotRefresh, copyMediaArtwork]);

  // LIB-CREW-01: once per library, titles added before crew was stored get their director and writers, quietly
  // and one at a time (`startCrewBackfill`). Only the crew of a title that holds none is written.
  const crewBackfillDbRef = useRef<LibraryDb | null>(null);
  useEffect(() => {
    if (!db || !token || systemIssue || !datasetStatus.metadata) return;
    if (crewBackfillDbRef.current === db) return;
    crewBackfillDbRef.current = db;
    let finished = false;
    const run = startCrewBackfill(db, token, () => requestSnapshotRefresh(db));
    void run.done.then((result) => {
      finished = result !== null;
    });
    return () => {
      run.stop();
      // A pass cut short starts again on the next run; filled and marked titles are not asked again.
      if (!finished && crewBackfillDbRef.current === db) crewBackfillDbRef.current = null;
    };
  }, [db, token, systemIssue, datasetStatus.metadata, requestSnapshotRefresh]);

  // ACCT-PROF-03: the library keeps the title, poster and backdrop sets every profile needs. The pass runs after the
  // library opens and again when a profile's option or the account language changes, in the background; the titles
  // shown meanwhile stay until replaced.
  const accountLanguage = clientConfig.uiLanguage || "en";
  const profileOptionsKey = profiles.profiles
    .map((profile) => {
      const row = settingsMap[scopedProfileSettingsKey(viewingScopeFor(profile))];
      return profileTitleLanguage(row ? readProfileSettingsRow(row.value, row.updatedAt) : null);
    })
    .join(",");
  const titleVariantsRunRef = useRef<{ db: LibraryDb; key: string } | null>(null);
  useEffect(() => {
    if (!db || !token || systemIssue || !datasetStatus.metadata || !profileOptionsKey) return;
    const key = `${accountLanguage}|${profileOptionsKey}`;
    if (titleVariantsRunRef.current?.db === db && titleVariantsRunRef.current.key === key) return;
    titleVariantsRunRef.current = { db, key };
    let finished = false;
    const run = startTitleVariantsReconcile({
      db,
      details: (type, catalogId, language) => getMetadataDetails(token, type, catalogId, language),
      accountLanguage,
      profileOptions: profileOptionsKey.split(",").map((option) => (option === "original" ? "original" : "app")),
      legacyLibraryLanguage: settingsMapRef.current["library_metadata_language"]?.value ?? null,
      ticketsLeft: () => getDesktopMetadata().reserve.count(),
      ticketFloor: ARTWORK_COPY_TICKET_FLOOR,
      onRowArtChanged: copyMediaArtwork,
      uploadArtwork: (kind, path) =>
        toUploadOutcome(
          async (uploadKind, uploadPath) => {
            const libraryKey = await getStoredLibraryKey();
            if (!libraryKey) throw new Error("KEY_REQUIRED");
            return uploadEncryptedAssetFromMetadata(token, libraryKey, uploadKind, uploadPath);
          },
          kind,
          path
        ),
      onChanged: () => requestSnapshotRefresh(db),
    });
    libraryContextLog.info({ key }, "library.titleVariants.scheduled");
    void run.done.then((result) => {
      finished = result !== null;
    });
    return () => {
      run.stop();
      // A pass cut short (a newer option, sign-out) starts again on the next run; stored sets are not asked again.
      if (!finished && titleVariantsRunRef.current?.db === db && titleVariantsRunRef.current.key === key) {
        titleVariantsRunRef.current = null;
      }
    };
  }, [db, token, systemIssue, datasetStatus.metadata, accountLanguage, profileOptionsKey, requestSnapshotRefresh, copyMediaArtwork]);

  const removeEpisodesNotInCatalog = useCallback(
    async (mediaId: string, episodeIds: string[]) => {
      if (!db) throw new Error("LIBRARY_NOT_READY");
      const result = await db.removeEpisodesNotInCatalog(mediaId, episodeIds);
      if (result.removed > 0) await requestSnapshotRefresh(db);
      return result;
    },
    [db, requestSnapshotRefresh]
  );

  const moveEpisodeToSlot = useCallback(
    async (mediaId: string, episodeId: string, targetEpisodeId: string) => {
      if (!db) throw new Error("LIBRARY_NOT_READY");
      const result = await db.moveEpisodeToSlot(mediaId, episodeId, targetEpisodeId);
      if (result.moved) await requestSnapshotRefresh(db);
      return result;
    },
    [db, requestSnapshotRefresh]
  );

  const getSharedSetting = useCallback((key: string) => settingsMap[key] ?? null, [settingsMap]);
  const getActiveProfileSettings = useCallback((): ProfileSettings | null => {
    const profile = activeProfileRef.current;
    const row = profile ? settingsMapRef.current[scopedProfileSettingsKey(viewingScopeFor(profile))] : undefined;
    return row ? readProfileSettingsRow(row.value, row.updatedAt) : null;
  }, []);

  // STOR-PLACE-09: artwork whose stored copy is gone while its title is still in the library is fetched back. A
  // batched check runs shortly after the library opens and every 6 hours while it stays open (the runtime's storage
  // clean-up runs in the background); a failed download reports to the same healer from `useMediaImage`.
  useEffect(() => {
    if (!db || !token || systemIssue || !datasetStatus.metadata) return;
    const healer = createDesktopArtworkHealer({
      db,
      token,
      language: () => ({ accountLanguage: loadClientConfig().uiLanguage || "en" }),
      onHealed: () => {
        void requestSnapshotRefresh(db);
      },
    });
    setDesktopArtworkHealer(healer);
    const runSweep = () => {
      void healer.sweep().catch((err) => libraryContextLog.warn({ err: String(err) }, "library.artworkHeal.sweepFailed"));
    };
    const first = setTimeout(runSweep, ARTWORK_HEAL_FIRST_SWEEP_MS);
    const interval = setInterval(runSweep, ARTWORK_HEAL_SWEEP_INTERVAL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(interval);
      if (getDesktopArtworkHealer() === healer) setDesktopArtworkHealer(null);
    };
  }, [db, token, systemIssue, datasetStatus.metadata, requestSnapshotRefresh]);

  // LIB-LANG-02: the detail dialog's synopsis and episode texts are read from (and kept in) the open library.
  useEffect(() => {
    if (!db) return;
    setDesktopTextsLibrary(db);
    return () => setDesktopTextsLibrary(null);
  }, [db]);

  const setSharedSetting = useCallback(
    async (key: string, value: string) => {
      if (!db) throw new Error("LIBRARY_NOT_READY");
      await db.setSetting(key, value);
      const updatedAt = new Date().toISOString();
      setSettingsMap((prev) => ({ ...prev, [key]: { value, updatedAt } }));
    },
    [db]
  );

  const addMediaFormat = useCallback(
    async (
      mediaId: string,
      fileId: string,
      quality: string,
      codec: string,
      sizeMb: number,
      chunks: Array<{ key: string; sizeBytes?: number | null; startSeconds?: number | null }> | string[],
      bitrateKbps: number | null,
      options?: {
        codecString?: string | null;
        initKey?: string | null;
        initSize?: number | null;
        durationSeconds?: number | null;
        totalSize?: number | null;
      }
    ) => {
      if (!db) throw new Error("LIBRARY_NOT_READY");
      const formatId = await db.addMediaFormat(mediaId, fileId, quality, codec, sizeMb, chunks, bitrateKbps, options);
      await requestSnapshotRefresh(db);
      return formatId;
    },
    [db, requestSnapshotRefresh]
  );

  const setMediaFormatChunks = useCallback(
    async (
      formatId: string,
      chunks: Array<{ key: string; sizeBytes?: number | null; startSeconds?: number | null }> | string[]
    ) => {
      if (!db) throw new Error("LIBRARY_NOT_READY");
      await db.setMediaFormatChunks(formatId, chunks);
      await requestSnapshotRefresh(db);
    },
    [db, requestSnapshotRefresh]
  );

  const replaceSkipMarkers = useCallback(
    async (
      mediaId: string,
      episodeId: string | null,
      markers: Array<{
        type: MediaSkipMarkerType;
        startSeconds: number;
        endSeconds: number;
        source: string;
        confidence?: number | null;
      }>
    ) => {
      if (!db) throw new Error("LIBRARY_NOT_READY");
      await db.replaceSkipMarkers(mediaId, episodeId, markers);
      await requestSnapshotRefresh(db);
    },
    [db, requestSnapshotRefresh]
  );

  const upsertSkipAnalysis = useCallback(
    async (mediaId: string, episodeId: string | null, kind: string, payload: Record<string, unknown>) => {
      if (!db) throw new Error("LIBRARY_NOT_READY");
      await db.upsertSkipAnalysis(mediaId, episodeId, kind, payload);
      await requestSnapshotRefresh(db);
    },
    [db, requestSnapshotRefresh]
  );

  const listSkipAnalysis = useCallback(
    async (mediaId: string, kind?: string) => {
      if (!db) throw new Error("LIBRARY_NOT_READY");
      return db.listSkipAnalysis(mediaId, kind);
    },
    [db]
  );

  const removeMediaFormat = useCallback(
    async (formatId: string) => {
      if (!db) throw new Error("LIBRARY_NOT_READY");
      await db.removeMediaFormat(formatId);
      await requestSnapshotRefresh(db);
    },
    [db, requestSnapshotRefresh]
  );

  const setMediaFileDesiredFormats = useCallback(
    async (fileId: string, formats: Array<{ quality: string; codec: string; bitrateKbps?: number | null }>) => {
      if (!db) throw new Error("LIBRARY_NOT_READY");
      await db.setMediaFileDesiredFormats(fileId, formats);
      await requestSnapshotRefresh(db);
    },
    [db, requestSnapshotRefresh]
  );

  const addFileTracks = useCallback(
    async (
      mediaId: string,
      fileId: string,
      season: number | null,
      episode: number | null,
      audioTracks: Array<{ language: string; label: string }>,
      subtitleTracks: Array<{ language: string; label: string }>,
      defaultAudioLanguage?: string | null,
      defaultSubtitleLanguage?: string | null
    ) => {
      if (!db) throw new Error("LIBRARY_NOT_READY");
      await db.addAudioTracksForFile(mediaId, fileId, season, episode, audioTracks, defaultAudioLanguage);
      await db.addSubtitleTracksForFile(mediaId, fileId, season, episode, subtitleTracks, defaultSubtitleLanguage);
      await requestSnapshotRefresh(db);
    },
    [db, requestSnapshotRefresh]
  );

  const addSubtitleTrack = useCallback(
    async (
      mediaId: string,
      episodeId: string | null,
      language: string,
      label: string,
      objectKey: string,
      format?: string | null,
      source?: string | null
    ) => {
      if (!db) throw new Error("LIBRARY_NOT_READY");
      await db.addSubtitleTrack(mediaId, episodeId, language, label, objectKey, format, source);
      await requestSnapshotRefresh(db);
    },
    [db, requestSnapshotRefresh]
  );

  const removeSubtitleTrack = useCallback(
    async (trackId: string) => {
      if (!db) throw new Error("LIBRARY_NOT_READY");
      const mediaId = findMediaIdByTrackId("subtitle", trackId);
      const rollback = mediaId
        ? applyOptimisticMediaDetailsUpdate(mediaId, (details) => ({
            ...details,
            subtitleTracks: details.subtitleTracks.filter((t) => t.id !== trackId),
          }))
        : () => undefined;
      return runOptimisticWrite(
        `subtitle-track:${trackId}`,
        rollback,
        () => db.removeSubtitleTrack(trackId),
        "Couldn't remove subtitle track — change reverted",
      );
    },
    [applyOptimisticMediaDetailsUpdate, db, findMediaIdByTrackId, runOptimisticWrite]
  );

  const removeSubtitleTrackNow = useCallback(
    async (trackId: string) => {
      if (!db) throw new Error("LIBRARY_NOT_READY");
      const mediaId = findMediaIdByTrackId("subtitle", trackId);
      const rollback = mediaId
        ? applyOptimisticMediaDetailsUpdate(mediaId, (details) => ({
            ...details,
            subtitleTracks: details.subtitleTracks.filter((t) => t.id !== trackId),
          }))
        : () => undefined;
      try {
        await db.removeSubtitleTrack(trackId);
      } catch (error) {
        rollback();
        throw error;
      }
    },
    [applyOptimisticMediaDetailsUpdate, db, findMediaIdByTrackId]
  );

  const getMediaObjectKeys = useCallback(
    async (mediaId: string) => {
      if (!db) throw new Error("LIBRARY_NOT_READY");
      return db.getMediaObjectKeys(mediaId);
    },
    [db]
  );

  const removeAudioTrack = useCallback(
    async (trackId: string) => {
      if (!db) throw new Error("LIBRARY_NOT_READY");
      const mediaId = findMediaIdByTrackId("audio", trackId);
      const rollback = mediaId
        ? applyOptimisticMediaDetailsUpdate(mediaId, (details) => ({
            ...details,
            audioTracks: details.audioTracks.filter((t) => t.id !== trackId),
          }))
        : () => undefined;
      return runOptimisticWrite(
        `audio-track:${trackId}`,
        rollback,
        () => db.removeAudioTrack(trackId),
        "Couldn't remove audio track — change reverted",
      );
    },
    [applyOptimisticMediaDetailsUpdate, db, findMediaIdByTrackId, runOptimisticWrite]
  );

  const updateAudioTrack = useCallback(
    async (trackId: string, language: string, label: string) => {
      if (!db) throw new Error("LIBRARY_NOT_READY");
      const mediaId = findMediaIdByTrackId("audio", trackId);
      const rollback = mediaId
        ? applyOptimisticMediaDetailsUpdate(mediaId, (details) => ({
            ...details,
            audioTracks: details.audioTracks.map((t) =>
              t.id === trackId ? { ...t, language, label } : t,
            ),
          }))
        : () => undefined;
      return runOptimisticWrite(
        `audio-track:${trackId}`,
        rollback,
        () => db.updateAudioTrack(trackId, language, label),
        "Couldn't save audio track — change reverted",
      );
    },
    [applyOptimisticMediaDetailsUpdate, db, findMediaIdByTrackId, runOptimisticWrite]
  );

  const updateSubtitleTrack = useCallback(
    async (trackId: string, language: string, label: string) => {
      if (!db) throw new Error("LIBRARY_NOT_READY");
      const mediaId = findMediaIdByTrackId("subtitle", trackId);
      const rollback = mediaId
        ? applyOptimisticMediaDetailsUpdate(mediaId, (details) => ({
            ...details,
            subtitleTracks: details.subtitleTracks.map((t) =>
              t.id === trackId ? { ...t, language, label } : t,
            ),
          }))
        : () => undefined;
      return runOptimisticWrite(
        `subtitle-track:${trackId}`,
        rollback,
        () => db.updateSubtitleTrack(trackId, language, label),
        "Couldn't save subtitle track — change reverted",
      );
    },
    [applyOptimisticMediaDetailsUpdate, db, findMediaIdByTrackId, runOptimisticWrite]
  );

  const setDefaultAudioTrack = useCallback(
    async (mediaId: string, episodeId: string | null, trackId: string | null) => {
      if (!db) throw new Error("LIBRARY_NOT_READY");
      const rollback = applyOptimisticMediaDetailsUpdate(mediaId, (details) => ({
        ...details,
        audioTracks: details.audioTracks.map((t) => {
          const inScope = episodeId ? t.episodeId === episodeId : !t.episodeId;
          if (!inScope) return t;
          return { ...t, isDefault: trackId !== null && t.id === trackId };
        }),
      }));
      return runOptimisticWrite(
        `default-audio:${mediaId}:${episodeId ?? ""}`,
        rollback,
        () => db.setDefaultAudioTrack(mediaId, episodeId, trackId),
        "Couldn't update default audio — change reverted",
      );
    },
    [applyOptimisticMediaDetailsUpdate, db, runOptimisticWrite]
  );

  const setDefaultSubtitleTrack = useCallback(
    async (mediaId: string, episodeId: string | null, trackId: string | null) => {
      if (!db) throw new Error("LIBRARY_NOT_READY");
      const rollback = applyOptimisticMediaDetailsUpdate(mediaId, (details) => ({
        ...details,
        subtitleTracks: details.subtitleTracks.map((t) => {
          const inScope = episodeId ? t.episodeId === episodeId : !t.episodeId;
          if (!inScope) return t;
          return { ...t, isDefault: trackId !== null && t.id === trackId };
        }),
      }));
      return runOptimisticWrite(
        `default-subtitle:${mediaId}:${episodeId ?? ""}`,
        rollback,
        () => db.setDefaultSubtitleTrack(mediaId, episodeId, trackId),
        "Couldn't update default subtitle — change reverted",
      );
    },
    [applyOptimisticMediaDetailsUpdate, db, runOptimisticWrite]
  );

  const setTrackPrefs = useCallback(
    async (mediaId: string, patch: TrackPrefsPatch) => {
      if (!db) throw new Error("LIBRARY_NOT_READY");
      const key = trackPrefsKey(mediaId);
      const before = settingsMapRef.current[key] ?? null;
      const timestamp = new Date().toISOString();
      const next = mergeTrackPrefs(parseTrackPrefs(before?.value), patch, timestamp);
      // The player reads the choice back through settingsMap on the very next
      // play: reflect it now, the runtime write (and its sync op) follows.
      setSettingsMap((prev) => ({ ...prev, [key]: { value: serializeTrackPrefs(next), updatedAt: timestamp } }));
      return runOptimisticWrite(
        `track-prefs:${mediaId}`,
        () => {
          setSettingsMap((prev) => {
            const rolled = { ...prev };
            if (before) rolled[key] = before;
            else delete rolled[key];
            return rolled;
          });
        },
        () => db.setTrackPrefs(mediaId, patch),
        "Couldn't save track choice — change reverted",
      );
    },
    [db, runOptimisticWrite]
  );

  const addAudioTrackWithChunks = useCallback(
    async (input: {
      mediaId: string;
      fileId: string;
      season: number | null;
      episode: number | null;
      language: string;
      label: string;
      codec: string | null;
      codecString?: string | null;
      initKey: string | null;
      initSize: number | null;
      durationSeconds: number | null;
      totalSize: number | null;
      chunks: Array<{ key: string; sizeBytes?: number | null; startSeconds?: number | null }>;
      isDefault?: boolean;
      source?: string;
    }) => {
      if (!db) throw new Error("LIBRARY_NOT_READY");
      await db.addAudioTrackWithChunks(input);
      await requestSnapshotRefresh(db);
    },
    [db, requestSnapshotRefresh]
  );

  const addSubtitleTrackWithObject = useCallback(
    async (input: {
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
    }) => {
      if (!db) throw new Error("LIBRARY_NOT_READY");
      await db.addSubtitleTrackWithObject(input);
      await requestSnapshotRefresh(db);
    },
    [db, requestSnapshotRefresh]
  );

  const addChaptersForFormat = useCallback(
    async (formatId: string, chapters: Array<{ title: string; startSeconds: number }>) => {
      if (!db) throw new Error("LIBRARY_NOT_READY");
      await db.addChaptersForFormat(formatId, chapters);
      await requestSnapshotRefresh(db);
    },
    [db, requestSnapshotRefresh]
  );

  const purgeMissingObjects = useCallback(
    async (missingKeys: string[]) => {
      if (!db) throw new Error("LIBRARY_NOT_READY");
      await db.purgeMissingObjects(missingKeys);
      await requestSnapshotRefresh(db);
    },
    [db, requestSnapshotRefresh]
  );

  const syncFromRemote = useCallback(async () => {
    if (!db) return;
    const changed = await db.syncFromRemoteIfNewer();
    if (changed) {
      await requestSnapshotRefresh(db);
      await syncClientConfigFromDb(db);
    }
  }, [db, requestSnapshotRefresh, syncClientConfigFromDb]);

  const resetKey = useCallback(async () => {
    await clearLibraryKey().catch(() => undefined);
    syncMediaKey(null);
    reload();
  }, [reload, syncMediaKey]);

  const exportLocalDb = useCallback(async () => {
    if (!db) throw new Error("LIBRARY_NOT_READY");
    return await db.exportBytes();
  }, [db]);

  const clearLocalCache = useCallback(async () => {
    await LibraryDb.clearLocalCache();
    snapshotPersisterRef.current?.cancel();
    if (user?.id) {
      clearLibrarySnapshotCache(user.id);
    }
    clearAssetCaches();
    resetLibraryState({
      closeDb: () =>
        setDb((prev) => {
          prev?.close();
          return null;
        }),
      syncMediaKey,
      updateMedia,
      updatePlaylists,
      setPlaylistItemsMap,
      setMediaDetailsMap,
      setIngestJobs,
      setSettingsMap,
      setDatasetStatus,
    });
  }, [syncMediaKey, updateMedia, updatePlaylists, user?.id]);

  const getDebugSnapshot = useCallback(async () => {
    if (!db) return null;
    return await db.getDebugSnapshot();
  }, [db]);

  const ensureWritable = useCallback(() => {
    ensureWriteAllowed(systemIssue);
  }, [systemIssue]);

  const guardWriteAction = useCallback(
    <TArgs extends unknown[], TResult>(fn: (...args: TArgs) => Promise<TResult>) =>
      (...args: TArgs) => {
        ensureWritable();
        return fn(...args);
      },
    [ensureWritable]
  );

  const shownMedia = useMemo(
    () =>
      titleLanguage === "original"
        ? media.map((item) => shownTitleArt(item, parseTitleVariants(settingsMap[titleVariantsKey(item.id)]?.value), titleLanguage))
        : media,
    [media, titleLanguage, settingsMap]
  );
  const dataValue = useMemo<LibraryDataValue>(
    () => ({
      loading: loading || !datasetStatus.core,
      error,
      writeBlockedReason: systemIssue,
      media: shownMedia,
      playlists,
    }),
    [loading, datasetStatus.core, error, systemIssue, shownMedia, playlists]
  );

  const debugValue = useMemo<LibraryDebugValue>(
    () => ({ debugRevision }),
    [debugRevision]
  );

  const ingestValue = useMemo<LibraryIngestValue>(
    () => ({ ingestJobs }),
    [ingestJobs]
  );

  const shellValue = useMemo<LibraryShellValue>(
    () =>
      buildLibraryShellValue({
        loading,
        coreReady: datasetStatus.core,
        metadataReady: datasetStatus.metadata,
        playbackReady: datasetStatus.playback,
        error,
        formatTooNew,
        writeBlockedReason: systemIssue,
        mediaCount: media.length,
      }),
    [
      loading,
      datasetStatus.core,
      datasetStatus.metadata,
      datasetStatus.playback,
      error,
      formatTooNew,
      systemIssue,
      media.length,
    ]
  );

  const actionsValue = useMemo<LibraryActionsValue>(
    () => ({
      datasetStatus,
      awaitDatasetReady,
      reload,
      activateRemoteLibrary,
      addMediaFromCatalog: guardWriteAction(addMediaFromCatalog),
      linkFileToMedia: guardWriteAction(linkFileToMedia),
      setProgress: guardWriteAction(setProgress),
      getMediaDetails,
      getLibraryMediaDetails,
      fetchMediaDetails,
      listPlaylistItems,
      createPlaylist: guardWriteAction(createPlaylist),
      deletePlaylist: guardWriteAction(deletePlaylist),
      addToPlaylist: guardWriteAction(addToPlaylist),
      removeFromPlaylist: guardWriteAction(removeFromPlaylist),
      getSystemPlaylistId,
      getPlaylistIdBySlug,
      deleteMedia: guardWriteAction(deleteMedia),
      deleteMediaFile: guardWriteAction(deleteMediaFile),
      replaceMediaTrailers: guardWriteAction(replaceMediaTrailers),
      updateMediaMetadata: guardWriteAction(updateMediaMetadata),
      restoreMediaFromCatalog: guardWriteAction(restoreMediaFromCatalog),
      refreshShowEpisodes: guardWriteAction(refreshShowEpisodes),
      copyMediaArtwork,
      removeEpisodesNotInCatalog: guardWriteAction(removeEpisodesNotInCatalog),
      moveEpisodeToSlot: guardWriteAction(moveEpisodeToSlot),
      getSharedSetting,
      getActiveProfileSettings,
      setSharedSetting: guardWriteAction(setSharedSetting),
      addMediaFormat: guardWriteAction(addMediaFormat),
      setMediaFormatChunks: guardWriteAction(setMediaFormatChunks),
      replaceSkipMarkers: guardWriteAction(replaceSkipMarkers),
      upsertSkipAnalysis: guardWriteAction(upsertSkipAnalysis),
      listSkipAnalysis,
      removeMediaFormat: guardWriteAction(removeMediaFormat),
      setMediaFileDesiredFormats: guardWriteAction(setMediaFileDesiredFormats),
      addFileTracks: guardWriteAction(addFileTracks),
      addSubtitleTrack: guardWriteAction(addSubtitleTrack),
      removeSubtitleTrack: guardWriteAction(removeSubtitleTrack),
      removeSubtitleTrackNow: guardWriteAction(removeSubtitleTrackNow),
      getMediaObjectKeys,
      removeAudioTrack: guardWriteAction(removeAudioTrack),
      updateAudioTrack: guardWriteAction(updateAudioTrack),
      updateSubtitleTrack: guardWriteAction(updateSubtitleTrack),
      setDefaultAudioTrack: guardWriteAction(setDefaultAudioTrack),
      setDefaultSubtitleTrack: guardWriteAction(setDefaultSubtitleTrack),
      addAudioTrackWithChunks: guardWriteAction(addAudioTrackWithChunks),
      addSubtitleTrackWithObject: guardWriteAction(addSubtitleTrackWithObject),
      addChaptersForFormat: guardWriteAction(addChaptersForFormat),
      setTrackPrefs: guardWriteAction(setTrackPrefs),
      purgeMissingObjects: guardWriteAction(purgeMissingObjects),
      syncFromRemote,
      resetKey: guardWriteAction(resetKey),
      exportLocalDb,
      clearLocalCache: guardWriteAction(clearLocalCache),
      getDebugSnapshot,
      suspendUiUpdates,
      resumeUiUpdates,
      batchLibraryUpdates,
    }),
    [
      datasetStatus,
      awaitDatasetReady,
      reload,
      activateRemoteLibrary,
      addMediaFromCatalog,
      linkFileToMedia,
      setProgress,
      getMediaDetails,
      getLibraryMediaDetails,
      fetchMediaDetails,
      listPlaylistItems,
      createPlaylist,
      deletePlaylist,
      addToPlaylist,
      removeFromPlaylist,
      getSystemPlaylistId,
      getPlaylistIdBySlug,
      deleteMedia,
      deleteMediaFile,
      replaceMediaTrailers,
      updateMediaMetadata,
      restoreMediaFromCatalog,
      refreshShowEpisodes,
      copyMediaArtwork,
      removeEpisodesNotInCatalog,
      moveEpisodeToSlot,
      getSharedSetting,
      getActiveProfileSettings,
      setSharedSetting,
      addMediaFormat,
      setMediaFormatChunks,
      replaceSkipMarkers,
      upsertSkipAnalysis,
      listSkipAnalysis,
      removeMediaFormat,
      setMediaFileDesiredFormats,
      addFileTracks,
      addSubtitleTrack,
      removeSubtitleTrack,
      removeSubtitleTrackNow,
      getMediaObjectKeys,
      removeAudioTrack,
      updateAudioTrack,
      updateSubtitleTrack,
      setDefaultAudioTrack,
      setDefaultSubtitleTrack,
      addAudioTrackWithChunks,
      addSubtitleTrackWithObject,
      addChaptersForFormat,
      setTrackPrefs,
      purgeMissingObjects,
      syncFromRemote,
      resetKey,
      exportLocalDb,
      clearLocalCache,
      getDebugSnapshot,
      suspendUiUpdates,
      resumeUiUpdates,
      batchLibraryUpdates,
      guardWriteAction,
    ]
  );

  return (
    <LibraryActionsContext.Provider value={actionsValue}>
      <LibraryShellContext.Provider value={shellValue}>
        <LibraryIngestContext.Provider value={ingestValue}>
          <LibraryVersionContext.Provider value={currentLibraryVersion}>
            <LibraryDebugContext.Provider value={debugValue}>
              <LibraryDataContext.Provider value={dataValue}>{children}</LibraryDataContext.Provider>
            </LibraryDebugContext.Provider>
          </LibraryVersionContext.Provider>
        </LibraryIngestContext.Provider>
      </LibraryShellContext.Provider>
    </LibraryActionsContext.Provider>
  );
};

export const useLibrary = () => {
  const data = useLibraryData();
  const actions = useLibraryActions();
  return useMemo(() => ({ ...data, ...actions }), [data, actions]);
};

export const useLibraryData = () => {
  const ctx = useContext(LibraryDataContext);
  if (!ctx) {
    throw new Error("useLibraryData must be used within LibraryProvider");
  }
  return ctx;
};

/**
 * Non-throwing accessor. Returns `undefined` when no LibraryProvider is in
 * the tree (e.g. in tests that render a leaf component in isolation). Use
 * this only when the consumer can degrade gracefully without library data.
 */
export const useOptionalLibraryData = () => useContext(LibraryDataContext);

export const useLibraryIngest = () => {
  const ctx = useContext(LibraryIngestContext);
  if (!ctx) {
    throw new Error("useLibraryIngest must be used within LibraryProvider");
  }
  return ctx;
};

export const useLibraryDebug = () => {
  const ctx = useContext(LibraryDebugContext);
  if (!ctx) {
    throw new Error("useLibraryDebug must be used within LibraryProvider");
  }
  return ctx;
};

export const useLibraryShell = () => {
  const ctx = useContext(LibraryShellContext);
  if (!ctx) {
    throw new Error("useLibraryShell must be used within LibraryProvider");
  }
  return ctx;
};

export const useLibraryActions = () => {
  const ctx = useContext(LibraryActionsContext);
  if (!ctx) {
    throw new Error("useLibraryActions must be used within LibraryProvider");
  }
  return ctx;
};

/**
 * Latest library snapshot version observed by the renderer. Returns
 * `undefined` until the first remote snapshot has been applied. Used by
 * the play-button gate to defer enabling playback until the SQLite-side
 * library state has caught up to the version stamped on the
 * `runtime.jobs.succeeded` event (`libraryVersionAtDone`). Closes the
 * cross-stream race between the runtime jobs SSE and the library SSE.
 *
 * Non-throwing: returns `undefined` outside of LibraryProvider so leaf
 * components rendered in isolation in tests degrade gracefully.
 */
export const useCurrentLibraryVersion = (): number | undefined =>
  useContext(LibraryVersionContext);

export const useUiSuspension = (active: boolean) => {
  const { suspendUiUpdates, resumeUiUpdates } = useLibrary();
  const activeRef = useRef(false);
  useEffect(() => {
    if (active && !activeRef.current) {
      suspendUiUpdates();
      activeRef.current = true;
    }
    if (!active && activeRef.current) {
      resumeUiUpdates();
      activeRef.current = false;
    }
    return () => {
      if (activeRef.current) {
        resumeUiUpdates();
        activeRef.current = false;
      }
    };
  }, [active, resumeUiUpdates, suspendUiUpdates]);
};

export const splitMedia = (items: MediaRow[]) => {
  const movies: MediaRow[] = [];
  const tv: MediaRow[] = [];
  for (const item of items) {
    if (item.type === "tv") tv.push(item);
    else movies.push(item);
  }
  return { movies, tv };
};

export { dedupeMediaByIdentity } from "@/lib/libraryMediaDedupe";

export type { MediaType };
