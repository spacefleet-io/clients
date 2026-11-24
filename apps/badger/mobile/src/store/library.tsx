import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";
import type { MediaDetails, MediaRow, PlaylistRow } from "@space/shared/libraryTypes";
import { ApiError, getApiBaseUrl, getSystemContract, getSystemContractIssue } from "@space/shared/api";
import { libraryReadOpStreamVersion, readLibraryMeta } from "../lib/library/libraryReads";
import type { LibraryMeta, RotationOwnLibrary, SystemContract } from "@space/shared/api";
import type { TrackPrefs, TrackPrefsPatch } from "@space/shared/trackPrefs";
import { LibraryFormatTooNewError } from "@space/library-db-definition";
import EventSource from "react-native-sse";
import { LibraryDb, QuotaExceededError, type PlaybackChunks } from "../lib/libraryDb";
import type { EpisodeResume } from "@space/shared/playbackResume";
import type { SearchEpisode } from "../lib/phoneSearch";
import { onViewingScopeChange } from "../lib/profiles/activeViewingScope";
import { attachProfileSettingsLibrary } from "../lib/profileSettings";
import { setMobileTextsLibrary } from "../lib/metadata/keptTexts";
import { useAppSettings } from "../lib/appSettings";
import { shownTitleArt, type TitleVariants } from "@space/shared/titleLanguage";
import { startLibraryTitleVariants } from "../lib/libraryTitleVariants";
import type { TitleVariantsRunner } from "../lib/titleVariants";
import { profileStore, useProfiles, type ProfileLibraryMoves } from "../lib/profiles/profileStore";
import {
  clearLibraryKey,
  getStoredLibraryKey,
  isLibraryKeyAcknowledged,
  setLibraryKeyAcknowledged,
} from "../lib/onboarding";
import { setMediaKeyFromBase64 } from "../lib/mediaCrypto";
import { decryptBase64ToBytes } from "../lib/crypto";
import { checkKeptLibraryKey, keptLibraryKeyIsStale, keptLibraryKeyVerdict, type KeptLibraryKeyVerdict } from "@space/mobile-shell/kept-library-key";
import { classifyLibraryMeta, LibrarySyncUnavailableError } from "@space/shared/libraryMetaState";
import { onNetworkRecover } from "../lib/networkListener";
import { computeStreamBackoff } from "../lib/streamBackoff";
import { createForegroundSyncScheduler, type AppStateLike } from "../lib/foregroundSync";
import { createLibrarySyncTracker, type LibrarySyncSource, type LibrarySyncState } from "../lib/librarySyncStatus";
import { createBackgroundStreamGate } from "../lib/backgroundStreamGate";
import {
  getOrCreateDeviceId,
  initializePushNotifications,
  unregisterPushNotifications,
} from "../native/pushHandler";
import { EMPTY_LIBRARY_EXTRAS, type LibraryExtras } from "../lib/libraryExtras";
import { useAuth } from "./auth";
import { withNetworkTimeout } from "../lib/withNetworkTimeout";
import { startLibraryArtworkCopy } from "../lib/libraryArtworkCopy";
import { useTranslation } from "@space/mobile-shell/i18n";

/**
 * How long the contract and meta preflight requests may stall before the load proceeds without them. The API
 * client has no timeout of its own, so a hung connection would otherwise hold the library behind it forever.
 */
const PREFLIGHT_TIMEOUT_MS = 15_000;

export type OfflineReason = "network" | "sync_error";

/** A user-facing failure held as an i18n key + params, translated when rendered so it follows the current language. */
type LibraryMessage = { key: string; params?: Record<string, unknown> };

type LoadStatusOf<E> =
  | { kind: "ready" }
  | { kind: "loading"; phase: "contract" | "meta" | "snapshot" | "sync" }
  | {
      kind: "offline";
      cacheVersion: number;
      lastError: E;
      pendingOps: number;
      // Distinguishes "device can't reach the API" (network) from "device is
      // online but library sync failed for an app-level reason" (sync_error,
      // e.g., missing op blob on storage). UX renders different copy per reason.
      reason: OfflineReason;
    }
  | { kind: "needs_key" }
  // A library surface is at a version newer than this build supports (Part D3).
  // Distinct from `fatal` so the navigator can route to the dedicated
  // store-deep-link screen instead of a generic error.
  | { kind: "format_too_new"; detail: LibraryFormatTooNewDetail }
  | { kind: "fatal"; error: E };

/** What consumers see: failures already translated in the current language. */
export type LoadStatus = LoadStatusOf<string>;

type StoredLoadStatus = LoadStatusOf<LibraryMessage>;

type LibraryStatusValue = {
  loading: boolean;
  initializing: boolean;
  error: string | null;
  loadStatus: LoadStatus;
  contractIssue: string | null;
  /**
   * UX-WAIT-04: true once this load has said what the library holds — the sync with the server ended (or there was
   * nothing to sync with: offline, signed out, a blocking screen). Until then an empty `media` is "not known yet", never
   * "empty": screens gate the empty library on `libraryContent({ itemCount, settled })` from `@space/shared`.
   */
  settled: boolean;
  /**
   * What the library sync is doing (LIB-SYNC-13): the tab bar's "Updating media library…" sign with its progress, then the
   * short result ("12 new episodes"), or the failure. Every sync trigger (cold start, back to the front, the live
   * stream, pull-to-refresh) shows here; the saved library stays usable throughout.
   */
  syncState: LibrarySyncState;
  needsKey: boolean;
  /**
   * Non-null when the library is at a format version newer than this build
   * supports — drives `LibraryFormatTooNewScreen`. See `parseLibraryFormatTooNew`.
   */
  formatTooNew: LibraryFormatTooNewDetail | null;
  datasetStatus: { core: boolean; metadata: boolean; playback: boolean };
  awaitDatasetReady: (stage: "core" | "metadata" | "playback") => Promise<void>;
  reload: () => void;
  /**
   * Pull-to-refresh: syncs the open library and re-lists it in place, so the
   * navigator never leaves the current screen. An offline library still on
   * screen syncs in place too (and is back to ready when the sync works); only
   * when no library is open does it fall back to a full `reload()`.
   */
  refresh: () => Promise<void>;
};

type LibraryDataValue = {
  media: MediaRow[];
  playlists: PlaylistRow[];
};

type LibraryActionsValue = {
  getMediaDetails: (mediaId: string, options?: { chunks?: boolean }) => Promise<MediaDetails | null>;
  /** Segment rows of just the given formats / audio tracks (the player's file), after `getMediaDetails(id, { chunks: false })`. */
  getPlaybackChunks: (formatIds: string[], audioTrackIds: string[]) => Promise<PlaybackChunks>;
  /** Ids of the title's formats / audio tracks that have segment rows (next-episode playability without loading them). */
  getPlayableTrackIds: (mediaId: string) => Promise<string[]>;
  getEpisodeResumeMap: (mediaId: string) => Promise<Record<string, EpisodeResume>>;
  /** Remembered audio + subtitle choice of a movie / show (PLAY-TRACK-04); null when none. */
  getTrackPrefs: (mediaId: string) => Promise<TrackPrefs | null>;
  /** Record a user's audio / subtitle pick for a movie / show (never an episode). */
  setTrackPrefs: (mediaId: string, patch: TrackPrefsPatch) => Promise<void>;
  /** Seals a fetched subtitle's text and stores it in the vault on the media's silo; returns its object key (PLAY-SUBGET-03). */
  uploadSubtitleContent: (mediaId: string, episodeId: string | null, content: string, format: string) => Promise<string>;
  /** Adds a subtitle track already in the vault and syncs the title; returns its id (PLAY-SUBGET-01, -17). */
  addSubtitleTrack: (track: {
    mediaId: string;
    episodeId: string | null;
    language: string;
    label: string;
    objectKey: string;
    format: string | null;
    source: string;
  }) => Promise<string>;
  /** Removes a subtitle track and syncs the title; the replaced track of "Try another version" (PLAY-SUBGET-07). */
  removeSubtitleTrack: (trackId: string) => Promise<void>;
  /** Whether a subtitle track still names this stored file (the replaced one's file is deleted when none does). */
  subtitleObjectInUse: (objectKey: string) => Promise<boolean>;
  /** Deletes stored files from the vault. */
  deleteStoredObjects: (keys: string[]) => Promise<void>;
  /** Cast, season counts and runtimes for the media library list; waits for the metadata + playback databases. */
  getLibraryExtras: () => Promise<LibraryExtras>;
  /** Every episode of the library for the phone's search (UX-PHONE-12); waits for the metadata database. */
  listEpisodesForSearch: () => Promise<SearchEpisode[]>;
  listPlaylistItems: (playlistId: string) => Promise<string[]>;
  createPlaylist: (name: string) => Promise<void>;
  deletePlaylist: (playlistId: string) => Promise<void>;
  addToPlaylist: (playlistId: string, mediaId: string) => Promise<void>;
  removeFromPlaylist: (playlistId: string, mediaId: string) => Promise<void>;
  /** Deletes a title with everything attached to it (files, progress, playlist entries) and syncs the deletion. */
  deleteMedia: (mediaId: string) => Promise<void>;
  getSystemPlaylistId: (slug: "favorites" | "watchlist") => Promise<string | null>;
  setProgress: (mediaId: string, progressPct: number) => Promise<void>;
  /** `final` (pause/exit/background) also refreshes list state + rebuilds the snapshot cache. */
  setPlaybackProgress: (
    mediaId: string,
    episodeId: string | null,
    progressPct: number,
    timing: { positionSeconds?: number | null; durationSeconds?: number | null } | null,
    final?: boolean
  ) => Promise<void>;
  acknowledgeKey: () => Promise<void>;
  clearLibrary: () => Promise<void>;
  /** PRIV-KEY-13: this library sealed under the new key for a rotation, or null when none is open. */
  sealForRotation: (newKeyBase64: string, copies: ReadonlyMap<string, string>) => Promise<RotationOwnLibrary | null>;
  /** ACCT-PROF-02: the data moves of a profile deletion (`profileStore.deleteProfile`). */
  profileMoves: ProfileLibraryMoves;
};

export type LibraryContextValue = LibraryStatusValue & LibraryDataValue & LibraryActionsValue;

const LibraryStatusContext = createContext<LibraryStatusValue | undefined>(undefined);
const LibraryDataContext = createContext<LibraryDataValue | undefined>(undefined);
const LibraryActionsContext = createContext<LibraryActionsValue | undefined>(undefined);
const LibraryContext = createContext<LibraryContextValue | undefined>(undefined);

const describeError = (err: unknown) => {
  if (err instanceof Error && err.message) {
    return err.stack ? `${err.message} | ${err.stack}` : err.message;
  }
  // react-native-sqlite-storage rejects a failed statement with a plain `{ message, code }` object, which
  // String() turns into "[object Object]" and so hid the "disk I/O error" behind library.stream.sync.failed.
  if (err && typeof err === "object") {
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
};

const isDecryptError = (err: unknown) =>
  err instanceof Error && err.message === "DECRYPT_FAILED";

/**
 * Structured detail of a "library format too new" failure (Part D3) — a
 * surface of the library is at a version newer than this mobile build
 * supports. Surfaced to `LibraryFormatTooNewScreen`, which deep-links the user
 * to the app store (mobile has no in-app updater).
 */
export type LibraryFormatTooNewDetail = {
  surface: "storage" | "op-stream" | "schema";
  observed: number;
  supported: number;
  group?: string;
};

/**
 * Parse the `LibraryFormatTooNewError` detail out of any error from a library
 * open path. Returns `null` when the error is not a format-too-new failure.
 * Triggers for ANY surface (`storage` / `op-stream` / `schema`) — `.surface`
 * is display detail, not a gate on whether to show the update screen.
 *
 * Three detection tiers, most precise first:
 *   1. `instanceof LibraryFormatTooNewError` — the genuine typed error. Mobile
 *      runs migrations in-process (the shared runner throws it directly), so
 *      this is the common case for the schema surface.
 *   2. structured `error.details` — for an error carrier that preserved the
 *      `{surface,observed,supported,group}` payload.
 *   3. the deterministic message string `LIBRARY_FORMAT_TOO_NEW: <surface
 *      [:group]> observed=<N> supported=<M>` — survives error re-wrapping.
 */
const parseLibraryFormatTooNew = (err: unknown): LibraryFormatTooNewDetail | null => {
  const isSurface = (value: unknown): value is LibraryFormatTooNewDetail["surface"] =>
    value === "storage" || value === "op-stream" || value === "schema";

  // Tier 1: the genuine typed error, with its fields as direct properties.
  if (err instanceof LibraryFormatTooNewError) {
    return {
      surface: err.surface,
      observed: err.observed,
      supported: err.supported,
      group: err.group,
    };
  }

  // Tier 2: structured carrier details. The runtime envelope contract gates a
  // too-new failure with `details.kind === "library_format_too_new"` (the
  // `code` field stays a closed enum), so check `kind` before reading fields.
  const details = (err as { details?: Record<string, unknown> } | null)?.details;
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

  // Tier 3: the deterministic message string.
  const message = err instanceof Error ? err.message : String(err ?? "");
  if (!message.includes("LIBRARY_FORMAT_TOO_NEW")) return null;

  const match = message.match(
    /LIBRARY_FORMAT_TOO_NEW:\s*([a-z-]+)(?::([^\s]+))?\s+observed=(\d+)\s+supported=(\d+)/i
  );
  if (match && isSurface(match[1])) {
    return {
      surface: match[1],
      observed: Number(match[3]),
      supported: Number(match[4]),
      group: match[2] || undefined,
    };
  }
  // Token present but tail unparseable — still flag it so the screen fires.
  return { surface: "storage", observed: 0, supported: 0 };
};

const isQuotaApiError = (err: unknown) =>
  err instanceof ApiError &&
  (err.status === 413 ||
    err.payload?.error === "upload_quota_exceeded" ||
    err.payload?.error === "quota_exceeded");

// True when an error indicates "device cannot reach the API". Distinguishes
// hard network failures from app-level sync errors so the UI can show
// "Library sync failed" instead of "Offline" when we're online but the storage
// tunnel or library data path failed.
const isNetworkError = (err: unknown): boolean => {
  if (!(err instanceof Error)) return false;
  const detail = err.stack ? `${err.message} | ${err.stack}` : err.message;
  if (detail.includes("Network request failed")) return true;
  // ApiError without a network signal means the API answered; not a network
  // outage even though the response was an error.
  return false;
};

const inferOfflineReason = (err: unknown): OfflineReason =>
  isNetworkError(err) ? "network" : "sync_error";

const formatLibraryError = (err: unknown): LibraryMessage => {
  const detail = describeError(err);
  if (detail.includes("Network request failed")) {
    return { key: "errors.library.unreachable", params: { url: getApiBaseUrl() } };
  }
  if (err instanceof LibrarySyncUnavailableError) {
    return { key: "errors.library.syncUnavailable" };
  }
  if (isQuotaApiError(err) || err instanceof QuotaExceededError) {
    return { key: "errors.library.quotaExceeded" };
  }
  if (detail) {
    return { key: "errors.library.loadFailedDetail", params: { detail } };
  }
  return { key: "errors.library.loadFailed" };
};

const localizeLoadStatus = (
  status: StoredLoadStatus,
  t: (key: string, params?: Record<string, unknown>) => string,
): LoadStatus => {
  if (status.kind === "offline") {
    return { ...status, lastError: t(status.lastError.key, status.lastError.params) };
  }
  if (status.kind === "fatal") {
    return { ...status, error: t(status.error.key, status.error.params) };
  }
  return status;
};

export const LibraryProvider = ({ children }: { children: React.ReactNode }) => {
  const { token, user, logout, loading: authLoading } = useAuth();
  // Primitives, not `user`: auth swaps in a fresh `user` object (same account) once its background `/auth/me`
  // answers, and that must not tear the library down and reload it.
  const userId = user?.id ?? null;
  const [db, setDb] = useState<LibraryDb | null>(null);
  const [media, setMedia] = useState<MediaRow[]>([]);
  const [playlists, setPlaylists] = useState<PlaylistRow[]>([]);
  // ACCT-PROF-03: every title's variant row (`title_variants_v1:<media id>`), re-read with the lists.
  const [titleVariants, setTitleVariants] = useState<ReadonlyMap<string, TitleVariants>>(() => new Map());
  const titleVariantsRunnerRef = useRef<TitleVariantsRunner | null>(null);
  const [loading, setLoading] = useState(false);
  const [initializing, setInitializing] = useState(false);
  const { t, i18n } = useTranslation();
  const [error, setError] = useState<LibraryMessage | null>(null);
  const [loadStatus, setLoadStatus] = useState<StoredLoadStatus>({ kind: "ready" });
  const [contractIssue, setContractIssue] = useState<string | null>(null);
  const [needsKey, setNeedsKey] = useState(false);
  const [datasetStatus, setDatasetStatus] = useState({
    core: false,
    metadata: false,
    playback: false,
  });
  const [reloadNonce, setReloadNonce] = useState(0);
  const loadInFlight = useRef<Promise<void> | null>(null);
  const loadGenerationRef = useRef(0);
  const activeDbRef = useRef<LibraryDb | null>(null);
  const hasLoadedOnce = useRef(false);
  const streamRef = useRef<EventSource | null>(null);
  const streamTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamHealthTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastStreamEventRef = useRef<number | null>(null);
  // The live stream answering again proves the server is back: it hands recovery from "offline" to `refresh`,
  // which re-checks the snapshot and the key before clearing the banner. Refs, so the stream effect stays put.
  const offlineRef = useRef(false);
  const recoverRef = useRef<() => Promise<void>>(async () => undefined);
  const datasetWaitersRef = useRef<{
    core: Array<() => void>;
    metadata: Array<() => void>;
    playback: Array<() => void>;
  }>({ core: [], metadata: [], playback: [] });
  const datasetUnsubscribeRef = useRef<(() => void) | null>(null);
  const listRefreshRef = useRef<{ running: Promise<void> | null; again: boolean }>({ running: null, again: false });
  // UX-WAIT-04: bumped by `reload`, so a load that started before it can never mark the new one's content as known.
  const settleEpochRef = useRef(0);
  const [settled, setSettled] = useState(false);
  const [syncState, setSyncState] = useState<LibrarySyncState>({ kind: "idle" });
  // One tracker for the provider's life: every sync caller runs through it, the open db reports progress into it.
  const [syncTracker] = useState(() =>
    createLibrarySyncTracker({
      onState: setSyncState,
      counts: async () => {
        const open = activeDbRef.current;
        if (!open) throw new Error("LIBRARY_NOT_OPEN");
        return await open.countLibraryContents();
      },
    })
  );
  useEffect(() => () => syncTracker.dispose(), [syncTracker]);

  // Coalesced re-list for onDataChanged bursts; drops the result when the db
  // is no longer the active one (reload/logout closed it). Resolves once the
  // lists on screen are the db's latest (a call during a run waits for the rerun).
  const refreshListsFrom = useCallback((source: LibraryDb): Promise<void> => {
    const state = listRefreshRef.current;
    if (state.running) {
      state.again = true;
      return state.running;
    }
    state.running = (async () => {
      try {
        do {
          state.again = false;
          const [nextMedia, nextPlaylists, nextVariants] = await Promise.all([
            source.listMedia(),
            source.listPlaylists(),
            source.readTitleVariants(),
          ]);
          if (activeDbRef.current !== source) return;
          setMedia(nextMedia);
          setPlaylists(nextPlaylists);
          setTitleVariants(nextVariants);
          console.warn(
            "library.data.refreshed",
            JSON.stringify({ mediaCount: nextMedia.length, playlistCount: nextPlaylists.length })
          );
        } while (state.again);
      } catch (error) {
        console.warn("library.data.refresh_failed", JSON.stringify({ error: describeError(error) }));
      } finally {
        state.running = null;
      }
    })();
    return state.running;
  }, []);

  // A profile switch (UX-PROF-01) changes the progress, playlists and favorites every list shows (ACCT-SQUAD-02).
  useEffect(
    () =>
      onViewingScopeChange((scope) => {
        const source = activeDbRef.current;
        console.info("library.data.profile_switch", JSON.stringify({ profileId: scope.profileId, hasDb: Boolean(source) }));
        if (source) void refreshListsFrom(source);
      }),
    [refreshListsFrom]
  );

  const reload = useCallback(() => {
    setReloadNonce((prev) => prev + 1);
    hasLoadedOnce.current = false;
    settleEpochRef.current += 1;
    setSettled(false);
    console.warn("library.content.unsettled", JSON.stringify({ where: "reload" }));
    activeDbRef.current = null;
    setDb((prev) => {
      prev?.close().catch((error: unknown) => {
        console.warn("library.db.close.failed", JSON.stringify({ where: "reload", error: describeError(error) }));
      });
      return null;
    });
    datasetUnsubscribeRef.current?.();
    datasetUnsubscribeRef.current = null;
    setDatasetStatus({ core: false, metadata: false, playback: false });
  }, []);

  /**
   * The kept key is no longer the account's (UX-KEY-01, `@space/mobile-shell/kept-library-key`): the library was
   * erased account-wide elsewhere (no probe left) or erased and remade with another key (the probe no longer opens).
   * The open library closes before anything else can sync or publish with that key, then the key and every local
   * library file go, and the key step opens: it asks for the account's key when there is a probe, else makes one.
   */
  const forgetKeptKey = useCallback(async (verdict: KeptLibraryKeyVerdict, where: string) => {
    console.warn("library.kept_key.forgotten", JSON.stringify({ verdict, where }));
    const open = activeDbRef.current;
    activeDbRef.current = null;
    datasetUnsubscribeRef.current?.();
    datasetUnsubscribeRef.current = null;
    setDb(null);
    setMedia([]);
    setPlaylists([]);
    setDatasetStatus({ core: false, metadata: false, playback: false });
    await open?.close().catch((error: unknown) => {
      console.warn("library.db.close.failed", JSON.stringify({ where: `kept_key_${where}`, error: describeError(error) }));
    });
    await clearLibraryKey().catch(() => undefined);
    await LibraryDb.clearLocalCache().catch((error: unknown) => {
      console.warn("library.kept_key.cache_clear_failed", JSON.stringify({ error: describeError(error) }));
    });
    settleEpochRef.current += 1;
    setSettled(false);
    setNeedsKey(true);
    // A key that no longer opens the library says so; an erased account just shows the key step's new key.
    setError(verdict === "mismatch" ? { key: "errors.library.decryptFailed" } : null);
    setLoading(false);
    setLoadStatus({ kind: "needs_key" });
  }, []);

  const load = useCallback(async () => {
    console.warn(
      "library.load.start",
      JSON.stringify({ hasToken: Boolean(token), hasUser: userId !== null })
    );
    if (authLoading) {
      setLoading(false);
      console.warn("library.load.skip", JSON.stringify({ reason: "auth_loading" }));
      return;
    }

    if (loadInFlight.current) {
      console.warn("library.load.inflight");
      await loadInFlight.current;
      return;
    }

    const generation = ++loadGenerationRef.current;
    const settleEpoch = settleEpochRef.current;
    // UX-WAIT-04: the library's content is known from here on (see `settled`). A reload since this load began wins.
    const settle = (where: string) => {
      if (settleEpochRef.current !== settleEpoch) return;
      console.warn("library.content.settled", JSON.stringify({ where }));
      setSettled(true);
    };
    // False while the background sync started below still has to say what the library holds, when nobody is signed
    // in (the next account's library is not known yet), or at the key step (the library is not opened yet).
    let settleOnExit = true;
    loadInFlight.current = (async () => {
      let coreReady = false;
      let openedDb: LibraryDb | null = null;
      try {
        if (!token || !userId) {
          setDb((prev) => {
            prev?.close().catch((error: unknown) => {
              console.warn("library.db.close.failed", JSON.stringify({ where: "no_token", error: describeError(error) }));
            });
            return null;
          });
          setMedia([]);
          setPlaylists([]);
          setNeedsKey(false);
          setError(null);
          setContractIssue(null);
          setLoading(false);
          setLoadStatus({ kind: "ready" });
          setDatasetStatus({ core: false, metadata: false, playback: false });
          settleOnExit = false;
          setSettled(false);
          console.warn("library.load.skip", JSON.stringify({ reason: "no_token_or_user_or_admin" }));
          return;
        }

        // The local library files are global to the install: bind them to this account before any
        // open (online or offline fallback) so another user's cache is never reused.
        await LibraryDb.claimLocalCache(userId);

        // Closes the library already painted from the saved copy (it must not stay on screen once the verdict says so).
        const dropActiveDb = (where: string) => {
          datasetUnsubscribeRef.current?.();
          datasetUnsubscribeRef.current = null;
          activeDbRef.current = null;
          setDb((prev) => {
            prev?.close().catch((error: unknown) => {
              console.warn("library.db.close.failed", JSON.stringify({ where, error: describeError(error) }));
            });
            return null;
          });
          setMedia([]);
          setPlaylists([]);
        };

        // True when this build is refused by the server contract (the update gate outranks everything).
        // A request that fails or stalls is not a verdict: the library keeps loading.
        const contractBlocks = async (): Promise<boolean> => {
          try {
            const contract = await withNetworkTimeout(getSystemContract(), PREFLIGHT_TIMEOUT_MS, "system contract");
            const issue = getSystemContractIssue(contract, "badger");
            if (issue) {
              console.warn("library.contract.blocked", JSON.stringify({ issue }));
              setContractIssue(issue);
              const blockedMessage: LibraryMessage = { key: "errors.library.contractBlocked", params: { issue } };
              setError(blockedMessage);
              setLoading(false);
              setLoadStatus({ kind: "fatal", error: blockedMessage });
              setDatasetStatus({ core: false, metadata: false, playback: false });
              return true;
            }
            setContractIssue(null);
            console.warn("library.contract.ok", JSON.stringify({
              apiVersion: contract.apiVersion,
              badgerStage: contract.apps.badger?.releaseStage,
            }));
          } catch (contractErr) {
            console.warn("library.contract.fetch_failed", JSON.stringify({ error: describeError(contractErr) }));
            setContractIssue(null);
          }
          return false;
        };

        // Key checks read the keychain only (no network), so the saved library can paint before any request.
        const keyAck = await isLibraryKeyAcknowledged().catch(() => false);
        if (!keyAck) {
          setLoadStatus({ kind: "loading", phase: "contract" });
          if (await contractBlocks()) return;
          settleOnExit = false;
          setSettled(false);
          setNeedsKey(true);
          setError(null);
          setLoading(false);
          setLoadStatus({ kind: "needs_key" });
          setDatasetStatus({ core: false, metadata: false, playback: false });
          console.warn("library.load.needs_key_ack");
          return;
        }

        const key = await getStoredLibraryKey().catch(() => null);
        if (!key) {
          setLoadStatus({ kind: "loading", phase: "contract" });
          if (await contractBlocks()) return;
          settleOnExit = false;
          setSettled(false);
          setNeedsKey(true);
          setError({ key: "errors.library.missingKey" });
          setLoading(false);
          setLoadStatus({ kind: "needs_key" });
          setDatasetStatus({ core: false, metadata: false, playback: false });
          console.warn("library.load.missing_key");
          return;
        }

        setNeedsKey(false);
        setMediaKeyFromBase64(key);
        if (!hasLoadedOnce.current) {
          setInitializing(true);
        }
        setLoading(true);
        setError(null);

        // Subscribe to `nextDb`, list it and mark Home ready: the first paint of the library.
        const adoptDb = async (nextDb: LibraryDb) => {
          const nextStatus = nextDb.getDatasetStatus();
          setDatasetStatus(nextStatus);
          coreReady = nextStatus.core;
          datasetUnsubscribeRef.current?.();
          const unsubscribeStatus = nextDb.onDatasetStatus((next) => {
            setDatasetStatus(next);
          });
          // META-ART-01: artwork still stored as metadata-service paths is copied into the user's storage, one title
          // at a time, on open, after each sync and when tickets arrive. Screens only ever show the copies.
          const artworkCopy = startLibraryArtworkCopy({
            library: nextDb,
            token,
            keyBase64: key,
            onApplied: () => void refreshListsFrom(nextDb),
          });
          // Remote ops applied by ANY sync (initial load, foreground sync,
          // 409 recovery) re-list media/playlists. Previously only this
          // load's own sync result refreshed them, behind generation/active-db
          // guards, so a first-login sync that finished while the guard was
          // false left Home on "No media yet" until a manual pull-to-refresh.
          // ACCT-PROF-03: titles, posters and backdrops follow the profiles' title-language choices; the pass runs in
          // the background on open, after each sync, when a choice or the account language changes, and when tickets
          // arrive. The old titles stay shown until it replaces them.
          const titleVariantsRunner = startLibraryTitleVariants({
            db: nextDb,
            token,
            keyBase64: key,
            onRowArtChanged: () => artworkCopy.migrate(),
            onChanged: () => void refreshListsFrom(nextDb),
          });
          titleVariantsRunnerRef.current = titleVariantsRunner;
          const unsubscribeData = nextDb.onDataChanged(() => {
            void refreshListsFrom(nextDb);
            artworkCopy.migrate();
            titleVariantsRunner.request("sync");
          });
          // LIB-SYNC-13: the tab bar's sign follows what this db's syncs do (found newer, each page, a snapshot).
          const unsubscribeProgress = nextDb.onSyncProgress(syncTracker.progress);
          // The active profile's playback settings and language live in this library (ACCT-SQUAD-03).
          const detachProfileSettings = attachProfileSettingsLibrary(nextDb);
          datasetUnsubscribeRef.current = () => {
            unsubscribeStatus();
            unsubscribeData();
            unsubscribeProgress();
            artworkCopy.stop();
            titleVariantsRunner.stop();
            if (titleVariantsRunnerRef.current === titleVariantsRunner) titleVariantsRunnerRef.current = null;
            detachProfileSettings();
          };
          setDb(nextDb);
          activeDbRef.current = nextDb;
          openedDb = null;
          const [nextMedia, nextPlaylists, nextVariants] = await Promise.all([
            nextDb.listMedia(),
            nextDb.listPlaylists(),
            nextDb.readTitleVariants(),
          ]);
          setMedia(nextMedia);
          setPlaylists(nextPlaylists);
          setTitleVariants(nextVariants);
          const dbMediaCount = await nextDb.countMediaItems();
          const mediaIds = nextMedia.map((item) => item.id);
          const uniqueMediaIds = new Set(mediaIds);
          console.warn(
            "library.debug.list",
            JSON.stringify({
              mediaCount: nextMedia.length,
              mediaUnique: uniqueMediaIds.size,
              mediaSample: mediaIds.slice(0, 5),
              playlistCount: nextPlaylists.length,
              dbMediaCount,
            })
          );

          // Mark ready BEFORE the sync — first paint is done.
          // Sync is a separate concern; consumers gate on
          // `loadStatus.kind === "ready"` for "is the home rendered".
          setLoadStatus({ kind: "ready" });
          artworkCopy.migrate();
          titleVariantsRunner.request("open");
        };

        try {
          // The saved library paints BEFORE any request is answered. A cold start used to wait on the
          // contract and meta round trips (and on a stalled API, for the whole timeout) with the cache
          // sitting on disk. The contract verdict and the sync now follow the paint.
          let cachedDb: LibraryDb | null = null;
          try {
            cachedDb = await LibraryDb.openCachedSplit(token, key);
          } catch (cacheErr) {
            // Not fatal here: the full open below hits the same error and routes it (too new, corrupt, ...).
            console.warn("library.load.cached_open_failed", JSON.stringify({ error: describeError(cacheErr) }));
          }
          if (cachedDb) {
            openedDb = cachedDb;
            await adoptDb(cachedDb);
            setInitializing(false);
          } else {
            setLoadStatus({ kind: "loading", phase: "contract" });
          }

          // LIB-SYNC-13: the meta request (the cheap "is the server newer?" check) starts WITH the contract check, not
          // after it, so a cold start learns one round trip sooner that a sync is due and the sign shows sooner. Its
          // answer is only used once the contract verdict let the load go on.
          let metaError: unknown = null;
          const metaStartedAt = Date.now();
          const metaRequest = withNetworkTimeout(readLibraryMeta(token), PREFLIGHT_TIMEOUT_MS, "library meta").catch((err) => {
            if (err instanceof ApiError && err.status === 401) {
              void logout("sessionRejected");
            }
            metaError = err;
            console.warn(
              "library.meta.failed",
              JSON.stringify({ apiBase: getApiBaseUrl(), error: describeError(err) })
            );
            return null;
          });

          if (await contractBlocks()) {
            if (cachedDb) dropActiveDb("contract_blocked");
            return;
          }

          if (!cachedDb) setLoadStatus({ kind: "loading", phase: "meta" });
          const fetchedMeta = await metaRequest;
          console.warn(
            "library.meta.result",
            JSON.stringify({
              exists: fetchedMeta?.exists ?? null,
              version: fetchedMeta?.version ?? null,
              ms: Date.now() - metaStartedAt,
            })
          );
          // Before any sync or publish: a key the account no longer has (erased or remade elsewhere) goes, with the
          // saved library; a failed meta request keeps both (UX-KEY-01).
          const keptKey = await keptLibraryKeyVerdict(key, fetchedMeta, decryptBase64ToBytes);
          if (keptLibraryKeyIsStale(keptKey)) {
            await forgetKeptKey(keptKey, "load");
            return;
          }
          const metaState = fetchedMeta ? classifyLibraryMeta(fetchedMeta) : null;
          // A library exists but its snapshot can't be confirmed right now: handle it like a failed meta
          // request (keep the saved library, or fall back to the cache), never as an empty library.
          if (metaState === "unavailable") metaError = new LibrarySyncUnavailableError();
          const meta = metaState === "unavailable" ? null : fetchedMeta;
          if (metaState === "absent") {
            // The server has no Badger library (yet) but the account has this key (its probe opened above: a key made
            // in Parrot, brought here by pairing). Never replace what is on the device with an empty one: a saved
            // library stays on screen (the split one is already painted; one saved in the older combined format
            // opens here). Otherwise Badger's library is created with the account's key, as the key step does
            // (`createOwnLibrary`) and Badger desktop does on open: pairing skips the key step, and without a library
            // the profile's settings have nowhere to live, so "How should titles appear?" waited forever (ACCT-PROF-03).
            let savedDb = cachedDb;
            if (!savedDb) {
              savedDb = await LibraryDb.openLocal(token, key).catch((localErr: unknown) => {
                console.warn("library.load.no_library.no_saved", JSON.stringify({ error: describeError(localErr) }));
                return null;
              });
              if (savedDb) {
                openedDb = savedDb;
                await adoptDb(savedDb);
              }
            }
            if (savedDb) {
              setLoadStatus({ kind: "ready" });
              console.warn("library.load.no_library", JSON.stringify({ keptSaved: true }));
              return;
            }
            console.warn("library.load.no_library.create", JSON.stringify({ keyVerdict: keptKey }));
            setLoadStatus({ kind: "loading", phase: "snapshot" });
            const createdDb = await LibraryDb.open(token, key, fetchedMeta ?? undefined);
            openedDb = createdDb;
            await adoptDb(createdDb);
            await createdDb.flushPending();
            setLoadStatus({ kind: "ready" });
            console.warn("library.load.no_library.created");
            return;
          }
          if (cachedDb && !meta) {
            // Offline with the saved library on screen: keep it and say so (same state the fallback open ends in).
            // Offline lives in `loadStatus` alone (the tab bar's sign and the passing notice, UX-NOTICE-02): no error line.
            const reason = inferOfflineReason(metaError);
            setError(null);
            setLoadStatus({
              kind: "offline",
              cacheVersion: cachedDb.getVersion(),
              lastError: formatLibraryError(metaError),
              pendingOps: cachedDb.getPendingOpsCount(),
              reason,
            });
            return;
          }
          let nextDb = cachedDb;
          if (!nextDb) {
            // No saved library to paint: the snapshot download is the first paint. A null `meta` means the
            // request failed or stalled; re-requesting it inside `open` would only repeat that wait.
            if (!meta) throw metaError ?? new Error("Network request failed: library meta unavailable");
            setLoadStatus({ kind: "loading", phase: "snapshot" });
            console.warn("library.db.open.start");
            nextDb = await LibraryDb.open(token, key, meta);
            openedDb = nextDb;
            console.warn("library.db.open.ready");
            await adoptDb(nextDb);
          }

          if (meta?.exists && typeof meta.version === "number") {
            const capturedDb = nextDb;
            const isCurrent = () =>
              loadGenerationRef.current === generation &&
              activeDbRef.current === capturedDb;
            settleOnExit = false;
            void (async () => {
              try {
                const changed = await syncTracker.track("start", () => capturedDb.syncFromRemoteIfNewer(meta));
                if (!isCurrent()) return;
                if (changed) {
                  // Lists are refreshed by the onDataChanged subscription
                  // above, which fires as soon as the ops are applied; waiting
                  // for it keeps a saved empty copy from showing as empty.
                  await refreshListsFrom(capturedDb);
                  console.warn(
                    "library.load.sync.done",
                    JSON.stringify({ version: meta.version })
                  );
                }
                settle(changed ? "sync_changed" : "sync_unchanged");
                await capturedDb.flushPending();
              } catch (syncErr) {
                if (!isCurrent()) return;
                console.warn(
                  "library.load.sync.failed",
                  JSON.stringify({ error: describeError(syncErr) })
                );
                settle("sync_failed");
                if (isDecryptError(syncErr)) {
                  await clearLibraryKey().catch(() => undefined);
                  if (!isCurrent()) return;
                  setNeedsKey(true);
                  setError({ key: "errors.library.decryptFailed" });
                  setLoadStatus({ kind: "needs_key" });
                  return;
                }
                // The saved library stays on screen. Meta answered just before, so the API is reachable: a sync that
                // fails now (an op read that broke, LIB-SYNC-11) is a sync failure, never "Offline". The next stream
                // event retries, and the sync resumes after the last page it applied.
                setLoadStatus({
                  kind: "offline",
                  cacheVersion: capturedDb.getVersion(),
                  lastError: formatLibraryError(syncErr),
                  pendingOps: capturedDb.getPendingOpsCount(),
                  reason: "sync_error",
                });
              }
            })();
          } else {
            await nextDb.flushPending();
          }
        } catch (err) {
          console.warn(
            "library.load.remote.failed",
            JSON.stringify({ apiBase: getApiBaseUrl(), error: describeError(err) })
          );
          if (openedDb) {
            await openedDb.close().catch(() => undefined);
            openedDb = null;
          }
          if (isDecryptError(err)) {
            dropActiveDb("decrypt_failed");
            await clearLibraryKey().catch(() => undefined);
            setNeedsKey(true);
            setError({ key: "errors.library.decryptFailed" });
            setLoadStatus({ kind: "needs_key" });
            setMedia([]);
            setPlaylists([]);
            setDatasetStatus({ core: false, metadata: false, playback: false });
            return;
          }
          // A forward version skew is not recoverable by falling back to the
          // local cache — the cache is the same too-new format. Route straight
          // to the store-update screen.
          const remoteTooNew = parseLibraryFormatTooNew(err);
          if (remoteTooNew) {
            setError({ key: "errors.library.formatTooNew" });
            setLoadStatus({ kind: "format_too_new", detail: remoteTooNew });
            setMedia([]);
            setPlaylists([]);
            setDatasetStatus({ core: false, metadata: false, playback: false });
            return;
          }
          try {
            const fallbackDb = await LibraryDb.openLocal(token, key);
            setDb(fallbackDb);
            const fallbackStatus = fallbackDb.getDatasetStatus();
            setDatasetStatus(fallbackStatus);
            coreReady = fallbackStatus.core;
            datasetUnsubscribeRef.current?.();
            const unsubscribeFallbackStatus = fallbackDb.onDatasetStatus((next) => {
              setDatasetStatus(next);
            });
            const detachFallbackSettings = attachProfileSettingsLibrary(fallbackDb);
            datasetUnsubscribeRef.current = () => {
              unsubscribeFallbackStatus();
              detachFallbackSettings();
            };
            const [nextMedia, nextPlaylists, nextVariants] = await Promise.all([
              fallbackDb.listMedia(),
              fallbackDb.listPlaylists(),
              fallbackDb.readTitleVariants(),
            ]);
            setMedia(nextMedia);
            setPlaylists(nextPlaylists);
            setTitleVariants(nextVariants);
            const offlineDetail = formatLibraryError(err);
            const reason = inferOfflineReason(err);
            setError(null);
            setLoadStatus({
              kind: "offline",
              cacheVersion: fallbackDb.getVersion(),
              lastError: offlineDetail,
              pendingOps: fallbackDb.getPendingOpsCount(),
              reason,
            });
          } catch (localErr) {
            console.warn(
              "library.load.local.failed",
              JSON.stringify({ error: describeError(localErr) })
            );
            if (isDecryptError(localErr)) {
              await clearLibraryKey().catch(() => undefined);
              setNeedsKey(true);
              setError({ key: "errors.library.decryptFailed" });
              setLoadStatus({ kind: "needs_key" });
              setMedia([]);
              setPlaylists([]);
              setDatasetStatus({ core: false, metadata: false, playback: false });
              return;
            }
            // The local cache can itself be too new (a newer build wrote it,
            // then the user downgraded) — surface that as the update screen.
            const localTooNew = parseLibraryFormatTooNew(localErr) ?? parseLibraryFormatTooNew(err);
            if (localTooNew) {
              setError({ key: "errors.library.formatTooNew" });
              setLoadStatus({ kind: "format_too_new", detail: localTooNew });
              setMedia([]);
              setPlaylists([]);
              setDatasetStatus({ core: false, metadata: false, playback: false });
              return;
            }
            const message = formatLibraryError(err);
            setError(message);
            setLoadStatus({ kind: "fatal", error: message });
            setMedia([]);
            setPlaylists([]);
            setDatasetStatus({ core: false, metadata: false, playback: false });
          }
        }
      } finally {
        setLoading(false);
        // Every other way out of a load says what the library holds: the lists are read, or a screen
        // (key, update, blocked, signed out) replaces Home. The background sync settles on its own.
        if (settleOnExit) settle("load_done");
        if (!hasLoadedOnce.current) {
          hasLoadedOnce.current = true;
        }
        if (coreReady) {
          setInitializing(false);
        }
        console.warn("library.load.done");
        loadInFlight.current = null;
      }
    })();

    await loadInFlight.current;
  }, [authLoading, forgetKeptKey, logout, refreshListsFrom, token, userId]);

  useEffect(() => {
    if (authLoading || !token || !userId) return;
    console.warn(
      "library.load.trigger",
      JSON.stringify({ authLoading, hasToken: Boolean(token), hasUser: true })
    );
    void load();
    return () => {
      // Another account, a sign-out or a reload: what this load knew about the library no longer holds (UX-WAIT-04).
      settleEpochRef.current += 1;
      setSettled(false);
      activeDbRef.current = null;
      setDb((prev) => {
        prev?.close().catch((error: unknown) => {
          console.warn("library.db.close.failed", JSON.stringify({ where: "unmount", error: describeError(error) }));
        });
        return null;
      });
      datasetUnsubscribeRef.current?.();
      datasetUnsubscribeRef.current = null;
    };
  }, [authLoading, token, userId, load, reloadNonce]);

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
    if (!token || !user) {
      hasLoadedOnce.current = false;
      setInitializing(false);
      setDatasetStatus({ core: false, metadata: false, playback: false });
      datasetUnsubscribeRef.current?.();
      datasetUnsubscribeRef.current = null;
    }
  }, [token, user]);

  useEffect(() => {
    if (error) {
      setInitializing(false);
    }
  }, [error]);

  useEffect(() => {
    if (loadStatus.kind !== "offline") return;
    console.warn("library.network.listener.registered");
    const unsubscribe = onNetworkRecover(() => {
      console.warn("library.network.recovered");
      reload();
    });
    return () => {
      console.warn("library.network.listener.unregistered");
      unsubscribe();
    };
  }, [loadStatus.kind, reload]);

  useEffect(() => {
    if (!db) return;
    if (!datasetStatus.core) return;
    if (!hasLoadedOnce.current) return;
    setInitializing(false);
  }, [db, datasetStatus.core]);

  const syncLists = useCallback(async () => {
    if (!db) return;
    const [nextMedia, nextPlaylists] = await Promise.all([db.listMedia(), db.listPlaylists()]);
    setMedia(nextMedia);
    setPlaylists(nextPlaylists);
    const dbMediaCount = await db.countMediaItems();
    const mediaIds = nextMedia.map((item) => item.id);
    const uniqueMediaIds = new Set(mediaIds);
    console.warn(
      "library.debug.list",
      JSON.stringify({
        mediaCount: nextMedia.length,
        mediaUnique: uniqueMediaIds.size,
        mediaSample: mediaIds.slice(0, 5),
        playlistCount: nextPlaylists.length,
        dbMediaCount,
      })
    );
  }, [db]);

  useEffect(() => {
    if (!db || !token) return;
    let closed = false;
    const streamBackoffRef = { attempts: 0 };

    if (streamRef.current) {
      streamRef.current.close();
      streamRef.current = null;
    }
    if (streamTimerRef.current) {
      clearTimeout(streamTimerRef.current);
      streamTimerRef.current = null;
    }
    if (streamHealthTimerRef.current) {
      clearInterval(streamHealthTimerRef.current);
      streamHealthTimerRef.current = null;
    }

    const markStreamEvent = () => {
      lastStreamEventRef.current = Date.now();
    };

    const HEARTBEAT_MS = 25_000;
    const STALE_MS = HEARTBEAT_MS * 3;

    const isStreamStale = () => {
      if (!lastStreamEventRef.current) return true;
      return Date.now() - lastStreamEventRef.current > STALE_MS;
    };

    const handleMeta = async (meta: LibraryMeta | null) => {
      if (!meta || typeof meta.version !== "number") return;
      console.warn("library.stream.meta", JSON.stringify({ version: meta.version, exists: meta.exists }));
      if (meta.exists === false) {
        console.warn("library.stream.meta.exists_false_ignored");
        return;
      }
      // No in-flight guard here: LibraryDb.syncFromRemoteIfNewer is single-flight and queues one
      // follow-up for a meta that arrives mid-sync. Dropping the event (the old guard) left a newer
      // remote version unsynced until the next event or foreground.
      try {
        console.warn(
          "library.stream.sync.start",
          JSON.stringify({ metaVersion: meta.version, localVersion: db.getVersion() })
        );
        const changed = await syncTracker.track("stream", () => db.syncFromRemoteIfNewer(meta));
        console.warn(
          "library.stream.sync.done",
          JSON.stringify({ changed, localVersion: db.getVersion() })
        );
        if (changed) {
          await syncLists();
        }
        if (offlineRef.current) {
          console.warn("library.stream.offline.recover");
          await recoverRef.current();
        }
      } catch (error) {
        console.warn("library.stream.sync.failed", JSON.stringify({ error: describeError(error) }));
      }
    };

    const connect = () => {
      if (closed || paused) return;
      const url = `${getApiBaseUrl()}/library/db/stream?token=${encodeURIComponent(token)}&app=badger&opStream=${libraryReadOpStreamVersion}`;
      console.warn("library.stream.connect", JSON.stringify({ url }));
      const es = new EventSource(url, { lineEndingCharacter: "\n" });
      streamRef.current = es;

      const handleMessage = (event: { data?: string }) => {
        markStreamEvent();
        console.warn("library.stream.message", JSON.stringify({ length: event.data?.length ?? 0 }));
        if (!event.data || typeof event.data !== "string") return;
        const meta = (() => {
          try {
            return event.data ? (JSON.parse(event.data) as LibraryMeta) : null;
          } catch (error) {
            console.warn("library.stream.message.parse_failed", JSON.stringify({ error: describeError(error) }));
            return null;
          }
        })();
        void handleMeta(meta);
      };

      // react-native-sse's EventSource has a different type shape from the
      // standard web EventSource. Use type-erased access for these properties.
      const esAny = es as unknown as Record<string, unknown>;
      esAny.onmessage = handleMessage;
      es.addEventListener("message" as never, handleMessage as never);

      esAny.onerror = () => {
        console.warn("library.stream.error");
        es.close();
        if (closed || paused) return;
        if (streamTimerRef.current) clearTimeout(streamTimerRef.current);
        const delay = computeStreamBackoff(streamBackoffRef.attempts);
        console.warn(
          "library.stream.backoff",
          JSON.stringify({ attempts: streamBackoffRef.attempts, delayMs: delay })
        );
        streamBackoffRef.attempts += 1;
        streamTimerRef.current = setTimeout(connect, delay);
      };

      es.addEventListener("open" as never, (() => {
        console.warn("library.stream.open");
        streamBackoffRef.attempts = 0;
        markStreamEvent();
      }) as never);

      es.addEventListener("ping" as never, (() => {
        console.warn("library.stream.ping");
        markStreamEvent();
      }) as never);
    };

    // Shuts the connection and its timers; `start` opens them again.
    const stop = () => {
      if (streamRef.current) {
        streamRef.current.close();
        streamRef.current = null;
      }
      if (streamTimerRef.current) {
        clearTimeout(streamTimerRef.current);
        streamTimerRef.current = null;
      }
      if (streamHealthTimerRef.current) {
        clearInterval(streamHealthTimerRef.current);
        streamHealthTimerRef.current = null;
      }
    };

    const start = () => {
      streamBackoffRef.attempts = 0;
      // A fresh connection gets the full stale window to open before the health check replaces it.
      markStreamEvent();
      connect();
      streamHealthTimerRef.current = setInterval(() => {
        if (closed || paused) return;
        if (!streamRef.current) return;
        if (isStreamStale()) {
          streamRef.current.close();
          streamRef.current = null;
          if (streamTimerRef.current) clearTimeout(streamTimerRef.current);
          streamTimerRef.current = setTimeout(connect, 1000);
        }
      }, 10_000);
    };

    // No open stream while the app is in the background (#957, PERF-MOBILE-04): it holds a connection and wakes the
    // JS thread for every heartbeat and change. On return the foreground sync catches up and the stream reopens.
    let paused = false;
    const gate = createBackgroundStreamGate((AppState.currentState ?? "unknown") as AppStateLike, {
      open: () => {
        paused = false;
        console.warn("library.stream.foreground.open");
        start();
      },
      close: () => {
        paused = true;
        console.warn("library.stream.background.close");
        stop();
      },
    });
    const appStateSubscription = AppState.addEventListener("change", (next: AppStateStatus) => {
      gate.observe(next as AppStateLike);
    });

    return () => {
      closed = true;
      appStateSubscription.remove();
      stop();
    };
  }, [db, token, logout, syncLists, syncTracker]);

  useEffect(() => {
    if (!db || !token) return;

    const scheduler = createForegroundSyncScheduler(() => {
      console.warn("library.appstate.foreground.sync.start");
      void (async () => {
        try {
          // Back to the front: the library may have been erased (or its key remade) on another device meanwhile.
          // That verdict comes before this sync, which would otherwise publish pending changes under the old key.
          const key = await getStoredLibraryKey().catch(() => null);
          // The key check's meta answer is the sync's too: one meta round trip on the way back, not two.
          let checkedMeta: LibraryMeta | undefined;
          if (key) {
            const verdict = await checkKeptLibraryKey(key, {
              fetchMeta: async () => {
                const meta = await withNetworkTimeout(readLibraryMeta(token), PREFLIGHT_TIMEOUT_MS, "library meta");
                checkedMeta = meta;
                return meta;
              },
              decrypt: decryptBase64ToBytes,
              log: (event, details) => console.warn(`library.${event}`, JSON.stringify(details)),
            });
            if (keptLibraryKeyIsStale(verdict)) {
              await forgetKeptKey(verdict, "foreground");
              return;
            }
          }
          const changed = await syncTracker.track("foreground", () => db.syncFromRemoteIfNewer(checkedMeta));
          if (changed) {
            await syncLists();
          }
          console.warn(
            "library.appstate.foreground.sync.done",
            JSON.stringify({ changed })
          );
        } catch (error) {
          console.warn(
            "library.appstate.foreground.sync.failed",
            JSON.stringify({ error: describeError(error) })
          );
        }
      })();
    });

    // Seed with the current state so the *next* transition is judged
    // correctly. AppState.currentState may be "unknown" before the first
    // listener tick on some platforms.
    const initialState = (AppState.currentState ?? "unknown") as AppStateLike;
    scheduler.observe(initialState);

    const handler = (next: AppStateStatus) => {
      console.warn("library.appstate.change", JSON.stringify({ next }));
      scheduler.observe(next as AppStateLike);
    };

    const subscription = AppState.addEventListener("change", handler);

    // Mobile push receiver. The push handler is fail-soft: if Firebase isn't
    // linked yet (fresh checkout, Pod install not run), it logs once and
    // disables — the existing AppState polling still works. Foreground pushes
    // route to `scheduler.triggerFromPush()` so debounce semantics apply.
    let teardownPush: (() => Promise<void>) | null = null;
    let activeDeviceId: string | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const deviceId = await getOrCreateDeviceId();
        if (cancelled) return;
        activeDeviceId = deviceId;
        teardownPush = await initializePushNotifications({
          authToken: token,
          deviceId,
          baseUrl: getApiBaseUrl(),
          onPushReceived: () => {
            scheduler.triggerFromPush();
          },
        });
      } catch (error) {
        console.warn(
          "library.push.init.failed",
          JSON.stringify({ error: describeError(error) })
        );
      }
    })();

    return () => {
      cancelled = true;
      scheduler.cancel();
      // RN >=0.65 returns a NativeEventSubscription with .remove(); older
      // versions return void and use AppState.removeEventListener. We support
      // both shapes defensively.
      const sub = subscription as unknown as { remove?: () => void } | undefined;
      if (sub && typeof sub.remove === "function") {
        sub.remove();
      } else {
        const legacy = AppState as unknown as {
          removeEventListener?: (event: "change", cb: (next: AppStateStatus) => void) => void;
        };
        legacy.removeEventListener?.("change", handler);
      }
      void (async () => {
        if (teardownPush) await teardownPush().catch(() => undefined);
        if (activeDeviceId) {
          await unregisterPushNotifications(
            getApiBaseUrl(),
            token,
            activeDeviceId
          ).catch(() => undefined);
        }
      })();
    };
  }, [db, forgetKeptKey, token, syncLists, syncTracker]);

  const ensureRemoteFresh = useCallback(async () => {
    if (!db) return;
    try {
      const changed = await db.syncFromRemoteIfNewer();
      if (changed) {
        await syncLists();
      }
    } catch (error) {
      console.warn("library.preflight.sync.failed", JSON.stringify({ error: describeError(error) }));
    }
  }, [db, syncLists]);

  // `source`: "pull" for the user's pull-to-refresh (its result says "up to date" too), "stream" when the live stream
  // answering again recovers an offline library.
  const refreshFrom = useCallback(async (source: LibrarySyncSource) => {
    // An open library (ready, or offline with the saved copy on screen) syncs in place; only a missing one
    // needs the full load, which swaps the navigator to the loading screen.
    if (!db || !datasetStatus.core) {
      console.warn("library.refresh.reload", JSON.stringify({ hasDb: db !== null, status: loadStatus.kind, source }));
      reload();
      return;
    }
    console.warn("library.refresh.start", JSON.stringify({ status: loadStatus.kind, source }));
    try {
      // LIB-SYNC-13: the meta check runs inside the tracked sync, so a failing pull shows on the tab bar's sign too.
      const synced = await syncTracker.track(source, async () => {
        // Same time limit as the load's meta check: a stalled API must not hold the pull spinner open.
        const meta = token ? await withNetworkTimeout(readLibraryMeta(token), PREFLIGHT_TIMEOUT_MS, "library meta") : null;
        // The library may have been erased, or its key remade, elsewhere: check the kept key first, as the load
        // does, so nothing below syncs or publishes with a key the account no longer has (UX-KEY-01).
        const key = meta ? await getStoredLibraryKey().catch(() => null) : null;
        if (key) {
          const keptKey = await keptLibraryKeyVerdict(key, meta, decryptBase64ToBytes);
          if (keptLibraryKeyIsStale(keptKey)) {
            await forgetKeptKey(keptKey, "refresh");
            return null;
          }
        }
        // Only a confirmed snapshot means the server is reachable again; the sync itself returns false
        // without throwing when it skips the server, so its outcome cannot clear the offline state.
        if (!meta || classifyLibraryMeta(meta) !== "present") throw new LibrarySyncUnavailableError();
        const changed = await db.syncFromRemoteIfNewer(meta);
        await db.flushPending();
        console.warn("library.refresh.sync.done", JSON.stringify({ changed, version: meta.version, source }));
        return changed;
      });
      if (synced === null) return;
      if (loadStatus.kind === "offline") {
        setError(null);
        setLoadStatus({ kind: "ready" });
      }
    } catch (error) {
      console.warn("library.refresh.sync.failed", JSON.stringify({ error: describeError(error), source }));
      // Same outcomes as the load path: a rejected session signs out, a wrong key asks for the key again.
      if (error instanceof ApiError && error.status === 401) {
        void logout("sessionRejected");
        return;
      }
      if (isDecryptError(error)) {
        await clearLibraryKey().catch(() => undefined);
        setNeedsKey(true);
        setError({ key: "errors.library.decryptFailed" });
        setLoadStatus({ kind: "needs_key" });
        return;
      }
    }
    // Re-list even when nothing synced: the lists then reflect local edits too.
    await syncLists();
  }, [db, datasetStatus.core, forgetKeptKey, loadStatus.kind, logout, reload, syncLists, syncTracker, token]);
  const refresh = useCallback(() => refreshFrom("pull"), [refreshFrom]);
  offlineRef.current = loadStatus.kind === "offline";
  recoverRef.current = () => refreshFrom("stream");

  // ACCT-PROF-03: every screen shows the active profile's choice of title, poster and backdrop, from the title's
  // variant row; the library row keeps the account language's set.
  const [{ titleLanguage }] = useAppSettings();
  const getMediaDetails = useCallback(
    async (mediaId: string, options?: { chunks?: boolean }) => {
      if (!db) return null;
      const details = await db.getMediaDetails(mediaId, options);
      return details ? shownTitleArt(details, titleVariants.get(mediaId) ?? null, titleLanguage) : null;
    },
    [db, titleVariants, titleLanguage]
  );
  // A new choice or account language: the pass fetches what the profiles now need (never blocking the screens).
  const accountLanguage = i18n.language;
  const { profiles } = useProfiles();
  useEffect(() => {
    titleVariantsRunnerRef.current?.request("choice");
  }, [titleLanguage, accountLanguage, profiles]);

  const getPlaybackChunks = useCallback(
    async (formatIds: string[], audioTrackIds: string[]): Promise<PlaybackChunks> => {
      if (!db) return { formats: {}, audio: {} };
      return await db.getPlaybackChunks(formatIds, audioTrackIds);
    },
    [db],
  );

  const getPlayableTrackIds = useCallback(
    async (mediaId: string): Promise<string[]> => {
      if (!db) return [];
      return await db.getPlayableTrackIds(mediaId);
    },
    [db],
  );

  const getEpisodeResumeMap = useCallback(
    async (mediaId: string) => {
      if (!db) return {};
      return await db.getEpisodeResumeMap(mediaId);
    },
    [db]
  );

  const getTrackPrefs = useCallback(
    async (mediaId: string) => {
      if (!db) return null;
      return await db.getTrackPrefs(mediaId);
    },
    [db]
  );

  const setTrackPrefs = useCallback(
    async (mediaId: string, patch: TrackPrefsPatch) => {
      if (!db) return;
      await db.setTrackPrefs(mediaId, patch);
    },
    [db]
  );

  const uploadSubtitleContent = useCallback(
    async (mediaId: string, episodeId: string | null, content: string, format: string) => {
      if (!db) throw new Error("library_not_ready");
      return await db.uploadSubtitleContent(mediaId, episodeId, content, format);
    },
    [db]
  );

  const addSubtitleTrack = useCallback(
    async (track: Parameters<LibraryDb["addSubtitleTrack"]>[0]) => {
      if (!db) throw new Error("library_not_ready");
      return await db.addSubtitleTrack(track);
    },
    [db]
  );

  const removeSubtitleTrack = useCallback(
    async (trackId: string) => {
      if (!db) throw new Error("library_not_ready");
      await db.removeSubtitleTrack(trackId);
    },
    [db]
  );

  const subtitleObjectInUse = useCallback(
    async (objectKey: string) => {
      if (!db) throw new Error("library_not_ready");
      return await db.subtitleObjectInUse(objectKey);
    },
    [db]
  );

  const deleteStoredObjects = useCallback(
    async (keys: string[]) => {
      if (!db) throw new Error("library_not_ready");
      await db.deleteStoredObjects(keys);
    },
    [db]
  );

  const awaitDatasetReady = useCallback(
    (stage: "core" | "metadata" | "playback") => {
      if (datasetStatus[stage]) {
        console.warn("library.dataset.await.ready", JSON.stringify({ stage }));
        return Promise.resolve();
      }
      console.warn("library.dataset.await.waiting", JSON.stringify({ stage }));
      return new Promise<void>((resolve) => {
        datasetWaitersRef.current[stage].push(resolve);
      });
    },
    [datasetStatus]
  );

  const listPlaylistItems = useCallback(
    async (playlistId: string) => {
      if (!db) return [];
      return await db.listPlaylistItems(playlistId);
    },
    [db]
  );

  const createPlaylist = useCallback(
    async (name: string) => {
      if (!db) return;
      await ensureRemoteFresh();
      await db.createPlaylist(name);
      await syncLists();
    },
    [db, ensureRemoteFresh, syncLists]
  );

  const deletePlaylist = useCallback(
    async (playlistId: string) => {
      if (!db) return;
      await ensureRemoteFresh();
      await db.deletePlaylist(playlistId);
      await syncLists();
    },
    [db, ensureRemoteFresh, syncLists]
  );

  const addToPlaylist = useCallback(
    async (playlistId: string, mediaId: string) => {
      if (!db) return;
      await ensureRemoteFresh();
      await db.addToPlaylist(playlistId, mediaId);
      await syncLists();
    },
    [db, ensureRemoteFresh, syncLists]
  );

  const removeFromPlaylist = useCallback(
    async (playlistId: string, mediaId: string) => {
      if (!db) return;
      await ensureRemoteFresh();
      await db.removeFromPlaylist(playlistId, mediaId);
      await syncLists();
    },
    [db, ensureRemoteFresh, syncLists]
  );

  const deleteMedia = useCallback(
    async (mediaId: string) => {
      if (!db) return;
      await ensureRemoteFresh();
      await db.deleteMedia(mediaId);
      await syncLists();
    },
    [db, ensureRemoteFresh, syncLists]
  );

  const getSystemPlaylistId = useCallback(
    async (slug: "favorites" | "watchlist") => {
      if (!db) return null;
      return await db.getSystemPlaylistId(slug);
    },
    [db]
  );

  const setProgress = useCallback(
    async (mediaId: string, progressPct: number) => {
      if (!db) return;
      await db.setProgress(mediaId, progressPct);
      await syncLists();
    },
    [db, syncLists]
  );

  const setPlaybackProgress = useCallback(
    async (
      mediaId: string,
      episodeId: string | null,
      progressPct: number,
      timing: { positionSeconds?: number | null; durationSeconds?: number | null } | null,
      final = false
    ) => {
      if (!db) return;
      await db.setPlaybackProgress(mediaId, episodeId, progressPct, timing);
      if (final) await syncLists();
    },
    [db, syncLists]
  );

  // The detail pages keep each title's texts in this library (LIB-LANG-02); none while it is closed or signed out.
  useEffect(() => {
    if (!db) return;
    setMobileTextsLibrary(db);
    return () => setMobileTextsLibrary(null);
  }, [db]);

  const acknowledgeKey = useCallback(async () => {
    await setLibraryKeyAcknowledged();
    await load();
  }, [load]);

  const clearLibrary = useCallback(async () => {
    setMediaKeyFromBase64(null);
    await db?.clearLocalCache();
    setDb(null);
    setMedia([]);
    setPlaylists([]);
    setDatasetStatus({ core: false, metadata: false, playback: false });
  }, [db]);

  const sealForRotation = useCallback(
    async (newKeyBase64: string, copies: ReadonlyMap<string, string>) => {
      if (!db) return null;
      return await db.sealForRotation(newKeyBase64, copies);
    },
    [db]
  );

  // ACCT-PROF-02 data moves, run by the device that deletes a profile (the library is end-to-end encrypted, so no
  // server can do it). Each pulls the latest ops first, as deleteMedia does, so nothing written elsewhere is missed.
  // `ensureReady` and `healMainPromotion` need a confirmed sync (same check as `refresh`); the others are best effort
  // after it. Every move throws without an open library instead of skipping silently.
  const syncConfirmed = useCallback(async () => {
    if (!db) throw new Error("LIBRARY_NOT_OPEN");
    const meta = token ? await withNetworkTimeout(readLibraryMeta(token), PREFLIGHT_TIMEOUT_MS, "library meta") : null;
    if (!meta || classifyLibraryMeta(meta) !== "present") throw new LibrarySyncUnavailableError();
    if (await db.syncFromRemoteIfNewer(meta)) await syncLists();
    return db;
  }, [db, syncLists, token]);

  const profileMoves = useMemo<ProfileLibraryMoves>(
    () => ({
      ensureReady: async () => {
        await syncConfirmed();
      },
      wipeProfileViewing: async (profileId) => {
        if (!db) throw new Error("LIBRARY_NOT_OPEN");
        await ensureRemoteFresh();
        await db.wipeProfileViewing(profileId);
        await syncLists();
      },
      promoteProfileToMain: async (profileId) => {
        if (!db) throw new Error("LIBRARY_NOT_OPEN");
        await ensureRemoteFresh();
        await db.promoteProfileToMain(profileId);
        await syncLists();
      },
      healMainPromotion: async (mainId) => {
        const open = await syncConfirmed();
        if (await open.healMainPromotion(mainId)) await syncLists();
      },
      listViewingProfileIds: async () => {
        if (!db) throw new Error("LIBRARY_NOT_OPEN");
        return db.listViewingProfileIds();
      },
    }),
    [db, ensureRemoteFresh, syncConfirmed, syncLists]
  );

  // An open library finishes a main profile's move another device (or this one, offline) left halfway.
  useEffect(() => {
    if (!db) return;
    profileStore.attachLibrary(profileMoves);
    return () => profileStore.attachLibrary(null);
  }, [db, profileMoves]);

  const statusValue = useMemo<LibraryStatusValue>(
    () => ({
      loading,
      initializing,
      error: error ? t(error.key, error.params) : null,
      loadStatus: localizeLoadStatus(loadStatus, t),
      contractIssue,
      settled,
      needsKey,
      // Derived from `loadStatus` — the single source of truth — so the field
      // can never drift out of sync with the navigator's screen decision.
      formatTooNew: loadStatus.kind === "format_too_new" ? loadStatus.detail : null,
      datasetStatus,
      awaitDatasetReady,
      reload,
      refresh,
      syncState,
    }),
    [
      loading,
      initializing,
      error,
      loadStatus,
      t,
      contractIssue,
      settled,
      needsKey,
      datasetStatus,
      awaitDatasetReady,
      reload,
      refresh,
      syncState,
    ],
  );

  const getLibraryExtras = useCallback(async (): Promise<LibraryExtras> => {
    if (!db) return EMPTY_LIBRARY_EXTRAS;
    await Promise.all([awaitDatasetReady("metadata"), awaitDatasetReady("playback")]);
    return await db.getLibraryExtras();
  }, [db, awaitDatasetReady]);

  const listEpisodesForSearch = useCallback(async (): Promise<SearchEpisode[]> => {
    if (!db) return [];
    await awaitDatasetReady("metadata");
    return await db.listEpisodesForSearch();
  }, [db, awaitDatasetReady]);

  const shownMedia = useMemo(
    () => media.map((item) => shownTitleArt(item, titleVariants.get(item.id) ?? null, titleLanguage)),
    [media, titleVariants, titleLanguage],
  );
  const dataValue = useMemo<LibraryDataValue>(
    () => ({ media: shownMedia, playlists }),
    [shownMedia, playlists],
  );

  const actionsValue = useMemo<LibraryActionsValue>(
    () => ({
      getMediaDetails,
      getPlaybackChunks,
      getPlayableTrackIds,
      getEpisodeResumeMap,
      getTrackPrefs,
      setTrackPrefs,
      uploadSubtitleContent,
      addSubtitleTrack,
      removeSubtitleTrack,
      subtitleObjectInUse,
      deleteStoredObjects,
      getLibraryExtras,
      listEpisodesForSearch,
      listPlaylistItems,
      createPlaylist,
      deletePlaylist,
      addToPlaylist,
      removeFromPlaylist,
      deleteMedia,
      getSystemPlaylistId,
      setProgress,
      setPlaybackProgress,
      acknowledgeKey,
      clearLibrary,
      sealForRotation,
      profileMoves,
    }),
    [
      getMediaDetails,
      getPlaybackChunks,
      getPlayableTrackIds,
      getEpisodeResumeMap,
      getTrackPrefs,
      setTrackPrefs,
      uploadSubtitleContent,
      addSubtitleTrack,
      removeSubtitleTrack,
      subtitleObjectInUse,
      deleteStoredObjects,
      getLibraryExtras,
      listEpisodesForSearch,
      listPlaylistItems,
      createPlaylist,
      deletePlaylist,
      addToPlaylist,
      deleteMedia,
      removeFromPlaylist,
      getSystemPlaylistId,
      setProgress,
      setPlaybackProgress,
      acknowledgeKey,
      clearLibrary,
      sealForRotation,
      profileMoves,
    ],
  );

  const aggregatedValue = useMemo<LibraryContextValue>(
    () => ({ ...statusValue, ...dataValue, ...actionsValue }),
    [statusValue, dataValue, actionsValue],
  );

  return (
    <LibraryActionsContext.Provider value={actionsValue}>
      <LibraryStatusContext.Provider value={statusValue}>
        <LibraryDataContext.Provider value={dataValue}>
          <LibraryContext.Provider value={aggregatedValue}>{children}</LibraryContext.Provider>
        </LibraryDataContext.Provider>
      </LibraryStatusContext.Provider>
    </LibraryActionsContext.Provider>
  );
};

export const useLibraryStatus = () => {
  const value = useContext(LibraryStatusContext);
  if (!value) throw new Error("LIBRARY_CONTEXT_MISSING");
  return value;
};

export const useLibraryData = () => {
  const value = useContext(LibraryDataContext);
  if (!value) throw new Error("LIBRARY_CONTEXT_MISSING");
  return value;
};

export const useLibraryActions = () => {
  const value = useContext(LibraryActionsContext);
  if (!value) throw new Error("LIBRARY_CONTEXT_MISSING");
  return value;
};

export const useLibrary = () => {
  const value = useContext(LibraryContext);
  if (!value) {
    throw new Error("LIBRARY_CONTEXT_MISSING");
  }
  return value;
};
