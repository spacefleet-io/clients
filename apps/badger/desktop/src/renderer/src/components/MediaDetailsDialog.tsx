import { formatRating } from "@/lib/localeFormat";
import { Suspense, lazy, startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMediaDetailHistory } from "@/lib/mediaDetailHistory";
import { useAuth } from "@/auth";
import { deleteStorageObjects } from "@/api";
import { extractAssetObjectKey } from "@/lib/assets";
import { findMediaPlacementId } from "@space/shared/mediaPlacement";
import { formatEditionLength, listEditions, orderEditionsForPage } from "@space/shared/mediaEditions";
import { subtitleFetchCopy } from "@space/shared/subtitleFetch";
import { seasonDisplayName } from "@space/shared/seasonName";
import SubtitleFetchDialog from "./SubtitleFetchDialog";
import { useOnline } from "@space/desktop-shell/hooks";
import { useLibraryOnline } from "@/lib/useLibraryOnline";
import { subtitleFormatFromName, subtitleLanguageFromName } from "@space/shared/libraryTypes";
import { crewLines } from "@space/shared/libraryCrew";
import { loadClientConfig } from "@/lib/config";
import { isClientUiLanguage } from "@space/shared";
import { getTmdbTrailersForLanguages, trailerOriginalLanguage } from "@/lib/metadata";
import { useLocalizedOverview } from "@/lib/useLocalizedOverview";
import { useLocalizedEpisodes } from "@/lib/useLocalizedEpisodes";
import { localizedEpisodeOverview } from "@space/metadata-client";
import {
  useCurrentLibraryVersion,
  useLibraryActions,
  useLibraryData,
  useLibraryIngest,
  useLibraryShell,
} from "@/lib/libraryContext";
import { plainDataEqual } from "@/lib/plainDataEqual";
import { useLabJobsData } from "@/lib/labJobs";
import { isLibraryVersionPending } from "@/lib/runtimeIngestJobs";
import { useLoadingModal } from "@/components/LoadingModalProvider";
import { useClientConfig } from "@/lib/useClientConfig";
import MediaImage from "@/components/MediaImage";
import { BadgerMultiSelect } from "@space/ui/badger";
import { Button, RenderBoundary, toast } from "@space/ui";
import { useAsyncAction } from "@space/desktop-shell/hooks";
import { OWN_FILE_DROP } from "@space/desktop-shell/window-drop";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@space/ui";
import {
  MediaDetailCast,
  MediaDetailCrew,
  MediaDetailChip,
  MediaDetailGenres,
  MediaDetailPage,
  MediaDetailEpisodeList,
  MediaDetailEpisodeProgress,
  MediaDetailEpisodeRow,
  MediaDetailSeasonCard,
  MediaDetailSeasonCrumb,
  MediaDetailSeasonList,
  MediaDetailTabs,
  mediaDetailPlayClass,
  mediaDetailSecondaryClass,
  mediaDetailTabs,
  type MediaDetailTab,
} from "@space/ui/badger/media-detail";
import { versionChips, versionLabel } from "@space/playback-abr";
import { pickSettingsFormat } from "@/lib/mpvPlaybackSelection";
import { Input } from "@space/ui";
import { Label } from "@space/ui";
import { isOcrTwin } from "@space/shared/subtitleTwins";
import { CheckCircle2, ChevronRight, Download, DownloadCloud, Heart, ImagePlus, ListPlus, Pencil, PlayCircle, Plus, RotateCcw, Save, Trash2, X, MoreHorizontal, Loader2 } from "lucide-react";
import { MediaCastDraft, MediaDetails, MediaEpisodeDraft, MediaFormat, MediaSeasonDraft } from "@/lib/libraryDb";
import { ESTIMATE_MB_BYTES, mediaSizeLabel } from "@/lib/sizeLabel";
import OfflineBadge, { RemoveOfflineIcon } from "@/components/OfflineBadge";
import {
  resolveButtonState,
  type OfflineScope,
} from "@/lib/offlineEstimator";
import {
  computeOfflineLocalCountsForDetails,
  refreshOfflineStateForMedia,
  useOfflineState,
} from "@/lib/offlineState";
import {
  callOfflineDeleteLocal,
  callOfflineReconcile,
  isOfflineIpcError,
} from "@/lib/offlineIpc";
import { formatMediaLanguageLabelForUi, sortedMediaLanguageOptionsForUi } from "@space/shared/mediaLanguageDisplay";
import { uploadEncryptedAssetFromFile, uploadEncryptedAssetFromUrl } from "@/lib/assets";
import { getStoredLibraryKey } from "@/lib/onboarding";
import { getGenreOptions } from "@/lib/genres";
import { getProgressBand, getProgressLabelPct, getVisibleProgressPct } from "@space/shared/progressBand";
import { resolveSelectedMediaDetails } from "@/lib/mediaDetailsSelection";
import {
  buildEpisodeCreditsMap,
  buildEpisodeResumeMap,
  buildMediaFilePresence,
  collectAvailableMovieQualities,
  collectEpisodeQualities,
  countEpisodeTracks,
  isEpisodeResumeCompleted,
  resolveDefaultPlayableEpisodeId,
  playableNowPresence,
  resolveDefaultPlayableEpisodeLabel,
} from "@/lib/mediaDetailsProcessing";
import { buildMediaDetailsJobSummary } from "@/lib/mediaDetailsJobs";
import { useTrailerParamSync } from "@/lib/useTrailerParamSync";
import { rendererLogger } from "@/logger";

const playbackDiagLog = rendererLogger.child({ scope: "playback-diag" });

const MediaDetailsActionDialogs = lazy(() => import("@/components/MediaDetailsActionDialogs"));
const MediaDetailsProcessingPanel = lazy(() => import("@/components/MediaDetailsProcessingPanel"));
const MediaPlaybackController = lazy(() => import("@/components/MediaPlaybackController"));
const AddQualityModal = lazy(() => import("@/components/AddQualityModal"));
const OfflineDownloadConfirmDialog = lazy(() => import("@/components/OfflineDownloadConfirmDialog"));

const KNOWN_REPLAN_ERROR_CODES = new Set([
  "source-protected",
  "quality-exists",
  "cannot-transcode-up",
  "media-not-found",
]);

const replanErrorLabel = (
  t: (key: string, options?: Record<string, unknown>) => string,
  code: string | null | undefined,
): string =>
  code && KNOWN_REPLAN_ERROR_CODES.has(code)
    ? t(`library.qualities.errors.${code}`)
    : code ?? t("library.qualities.errors.media-not-found");

const buildTrailerUrl = (key: string) => {
  const config = loadClientConfig();
  const source = config.trailerSource;
  if (source.provider === "invidious" && source.validated && source.invidiousUrl.trim()) {
    const base = source.invidiousUrl.trim().replace(/\/+$/, "");
    return `${base}/embed/${key}`;
  }
  return `https://www.youtube.com/embed/${key}`;
};

const trailerLanguageLabel = (lang: string, t: (key: string) => string) => {
  if (lang === "fr") return t("library.trailerLanguage.fr");
  if (lang === "en") return t("library.trailerLanguage.en");
  return t("library.trailerLanguage.other");
};

const normalizeLanguageCode = (raw?: string | null) => {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value) return "und";
  if (value === "eng") return "en";
  if (value === "fre" || value === "fra") return "fr";
  if (value === "spa") return "es";
  if (value === "por") return "pt";
  if (value === "ger" || value === "deu") return "de";
  if (value === "ita") return "it";
  if (value === "jpn") return "ja";
  if (value === "kor") return "ko";
  if (value === "chi" || value === "zho") return "zh";
  if (value.length === 2) return value;
  return "und";
};

const sortSubtitleTracks = <T extends { language: string }>(
  tracks: T[],
  getLanguageLabel: (code: string) => string
) => tracks.slice().sort((a, b) => getLanguageLabel(a.language).localeCompare(getLanguageLabel(b.language)));

type ImageDraft = {
  current: string | null;
  file: File | null;
  url: string;
};

type CastDraft = {
  id: string;
  personId?: string | null;
  tmdbId?: number | null;
  name: string;
  role: string;
  profile: ImageDraft;
};

type SeasonDraft = {
  id: string;
  seasonNumber: number;
  name: string;
  overview: string;
  poster: ImageDraft;
  episodeCount: number;
  airDate: string;
};

type EpisodeDraft = {
  id: string;
  seasonNumber: number;
  episodeNumber: number;
  name: string;
  overview: string;
  still: ImageDraft;
  airDate: string;
};

type MediaEditDraft = {
  title: string;
  originalTitle: string;
  originalLanguage: string;
  overview: string;
  year: string;
  rating: string;
  genres: number[];
  poster: ImageDraft;
  backdrop: ImageDraft;
  cast: CastDraft[];
  seasons: SeasonDraft[];
  episodes: EpisodeDraft[];
};

type MediaDetailsDialogProps = {
  selectedId: string | null;
  onClose: () => void;
};

export default function MediaDetailsDialog({ selectedId, onClose }: MediaDetailsDialogProps) {
  const { t, i18n } = useTranslation();
  const clientConfig = useClientConfig();
  const { searchParams, setTrailerParam } = useMediaDetailHistory();
  // The page is routed at /media/:id, so the trailer param belongs to this media while the page shows it.
  const searchTrailerParam = searchParams.get("trailer");
  const [playbackRequestId, setPlaybackRequestId] = useState(0);
  const [playbackEpisodeId, setPlaybackEpisodeId] = useState<string | null>(null);
  const { token } = useAuth();
  const { datasetStatus } = useLibraryShell();
  const { media, playlists } = useLibraryData();
  const { ingestJobs } = useLibraryIngest();
  const {
    getMediaDetails,
    getLibraryMediaDetails,
    fetchMediaDetails,
    awaitDatasetReady,
    addToPlaylist,
    removeFromPlaylist,
    getSystemPlaylistId,
    deleteMedia,
    replaceMediaTrailers,
    updateMediaMetadata,
    restoreMediaFromTmdb,
    copyMediaArtwork,
    getSharedSetting,
    addSubtitleTrack,
    removeSubtitleTrack,
    removeAudioTrack,
    updateAudioTrack,
    updateSubtitleTrack,
    setDefaultAudioTrack,
    setDefaultSubtitleTrack,
  } = useLibraryActions();
  const { showLoading, hideLoading } = useLoadingModal();
  const detailsLoadingRef = useRef<string | null>(null);

  const [selectedDetails, setSelectedDetails] = useState<MediaDetails | null>(null);
  // Descriptions follow the device UI language (Phase 1). Titles + artwork are
  // left as stored (the synced library-language layer); only the synopsis is
  // overlaid live here, falling back to the stored overview while loading.
  const localizedOverview = useLocalizedOverview(selectedDetails);
  // Episode names + per-episode synopses follow the device UI language too, else English (LIB-LANG-01).
  // Lookup key is `${seasonNumber}:${episodeNumber}`; render sites fall back to the stored value when a key or
  // field is missing (loading, offline, miss). A show with no stored season has no episode to show: no lookup.
  const localizedEpisodes = useLocalizedEpisodes(
    selectedDetails && selectedDetails.seasons.length > 0 ? selectedDetails : null
  );
  const [selectedSeason, setSelectedSeason] = useState<number | null>(null);
  const [selectedEpisodeId, setSelectedEpisodeId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<"seasons" | "details" | "processing">("seasons");
  const [movieTab, setMovieTab] = useState<"details" | "versions" | "subtitles" | "processing">("details");
  const [activeTrailerKey, setActiveTrailerKey] = useState<string | null>(null);
  const [trailerMenuOpen, setTrailerMenuOpen] = useState(false);
  const [trailerRefreshing, setTrailerRefreshing] = useState(false);
  useEffect(() => {
    if (selectedId) return;
    setPlaybackRequestId(0);
    setPlaybackEpisodeId(null);
  }, [selectedId]);
  // Opening a title is the first sign of a play: take the bundled mpv's first exec (Defender's scan of a
  // new binary, seconds on low-end Windows) now, off the main thread, instead of inside the launch (#928).
  useEffect(() => {
    if (selectedId) void window.sf?.warmExternalMpv?.().catch(() => undefined);
  }, [selectedId]);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
  const [deletingMedia, setDeletingMedia] = useState(false);
  const [showPlaylistPicker, setShowPlaylistPicker] = useState(false);
  const { jobs, activeJobs, libraryVersionAtDoneByMediaId } = useLabJobsData();
  const currentLibraryVersion = useCurrentLibraryVersion();
  const [trackModalEpisodeId, setTrackModalEpisodeId] = useState<string | null>(null);
  const [trackDrafts, setTrackDrafts] = useState<Record<string, { language: string; label: string }>>({});
  const [deleteAudioTrackTarget, setDeleteAudioTrackTarget] = useState<{
    id: string;
    episodeId: string | null;
    label: string;
  } | null>(null);
  const [movieSubtitleDraft, setMovieSubtitleDraft] = useState({
    file: null as File | null,
    language: "en",
    label: "",
  });
  const [episodeSubtitleDraft, setEpisodeSubtitleDraft] = useState({
    file: null as File | null,
    language: "en",
    label: "",
  });
  const [editMode, setEditMode] = useState(false);
  const [draft, setDraft] = useState<MediaEditDraft | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [showEditFloating, setShowEditFloating] = useState(false);
  const [movieSubtitleModalOpen, setMovieSubtitleModalOpen] = useState(false);
  const [episodeSubtitleModalOpen, setEpisodeSubtitleModalOpen] = useState(false);
  // "Get subtitles" (PLAY-SUBGET-01): the episode being searched (null = the film); undefined = closed.
  const [subtitleFetchEpisodeId, setSubtitleFetchEpisodeId] = useState<string | null | undefined>(undefined);
  const online = useOnline();
  // OFFL-PLAY-03: offline (no network, or the library opened locally), only what is on this computer plays.
  const libraryOnline = useLibraryOnline();
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  // Offline-mode (Phase 3): the confirm dialog opens with a scope hint, the
  // pending-delete state holds a media or file scope for the inline confirm.
  const [offlineConfirmScope, setOfflineConfirmScope] = useState<OfflineScope | null>(null);
  const [offlineDeletePending, setOfflineDeletePending] = useState(false);
  // Subscribe to the shared offline-state store. The hook handles the
  // refcount lifecycle (acquire on mount, release on unmount) AND returns
  // the current snapshot — the `.version` field changes on every mutation
  // so re-computing `offlineCounts` keys off it.
  const offlineStateSnapshot = useOfflineState();
  const editActionsRef = useRef<HTMLDivElement | null>(null);
  const moreMenuRef = useRef<HTMLDivElement | null>(null);
  const trailerMenuRef = useRef<HTMLDivElement | null>(null);
  const languageLabel = useCallback(
    (code: string) =>
      formatMediaLanguageLabelForUi(
        normalizeLanguageCode(code),
        i18n.language || "en",
        t("mediaLanguages.options.und")
      ),
    [i18n.language, t]
  );
  const sortedLanguageOptions = useMemo(
    () => sortedMediaLanguageOptionsForUi(i18n.language || "en", t("mediaLanguages.options.und")),
    [i18n.language, t]
  );

  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (moreMenuRef.current && !moreMenuRef.current.contains(target)) {
        setMoreMenuOpen(false);
      }
      if (trailerMenuRef.current && !trailerMenuRef.current.contains(target)) {
        setTrailerMenuOpen(false);
      }
    };
    if (moreMenuOpen || trailerMenuOpen) {
      document.addEventListener("mousedown", handleClick);
    }
    return () => document.removeEventListener("mousedown", handleClick);
  }, [moreMenuOpen, trailerMenuOpen]);

  useEffect(() => {
    if (clientConfig.enableMetadataTools) return;
    setEditMode(false);
    setRestoreOpen(false);
  }, [clientConfig.enableMetadataTools]);

  const prevMediaIdRef = useRef<string | null>(null);

  const hasCustomCast = useMemo(
    () => selectedDetails?.cast.some((member) => member.tmdbId === null) ?? false,
    [selectedDetails]
  );

  const genreOptions = useMemo(() => {
    if (!selectedDetails) return [];
    return getGenreOptions(selectedDetails.type === "tv" ? "tv" : "movie", i18n.language);
  }, [selectedDetails, i18n.language]);

  const playlistLabel = (name: string, slug: string | null) => {
    if (slug === "favorites") return t("playlists.systemFavorites");
    return name;
  };

  const toImageDraft = (current: string | null): ImageDraft => ({
    current,
    file: null,
    url: "",
  });

  const buildDraft = (details: MediaDetails): MediaEditDraft => ({
    title: details.title ?? "",
    originalTitle: details.originalTitle ?? "",
    originalLanguage: details.originalLanguage ?? "",
    overview: details.overview ?? "",
    year: details.year ?? "",
    rating: details.rating !== null && details.rating !== undefined ? String(details.rating) : "",
    genres: Array.isArray(details.genres) ? details.genres : [],
    poster: toImageDraft(details.posterPath),
    backdrop: toImageDraft(details.backdropPath),
    cast: details.cast.map((member) => ({
      id: member.id,
      personId: member.personId,
      tmdbId: member.tmdbId ?? null,
      name: member.name ?? "",
      role: member.role ?? "",
      profile: toImageDraft(member.profilePath ?? null),
    })),
    seasons: details.seasons.map((season) => ({
      id: season.id,
      seasonNumber: season.seasonNumber,
      name: season.name ?? "",
      overview: season.overview ?? "",
      poster: toImageDraft(season.posterPath ?? null),
      episodeCount: season.episodeCount ?? 0,
      airDate: season.airDate ?? "",
    })),
    episodes: details.episodes.map((episode) => ({
      id: episode.id,
      seasonNumber: episode.seasonNumber,
      episodeNumber: episode.episodeNumber,
      name: episode.name ?? "",
      overview: episode.overview ?? "",
      still: toImageDraft(episode.stillPath ?? null),
      airDate: episode.airDate ?? "",
    })),
  });

  const refreshSelected = () => {
    if (!selectedId) {
      setSelectedDetails(null);
      setShowPlaylistPicker(false);
      setEditMode(false);
      setDraft(null);
      setEditError(null);
      setRestoreOpen(false);
      return;
    }
    setSelectedDetails(getMediaDetails(selectedId));
  };

  // Fetch media details when dialog opens (selectedId changes).
  // Deliberately excludes media/playlists to avoid re-fetching on every background sync.
  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    const run = async () => {
      if (!datasetStatus.metadata) {
        detailsLoadingRef.current = showLoading({ title: t("app.loading") });
      }
      await awaitDatasetReady("metadata");
      if (!active) return;
      if (detailsLoadingRef.current) {
        hideLoading(detailsLoadingRef.current);
        detailsLoadingRef.current = null;
      }
      const details = await resolveSelectedMediaDetails(selectedId, getMediaDetails, fetchMediaDetails);
      if (!active) return;
      setSelectedDetails(details);
      // META-ART-01: artwork a previous copy could not move yet is retried when the title is viewed.
      copyMediaArtwork(selectedId);
    };
    void run();
    return () => {
      active = false;
      if (detailsLoadingRef.current) {
        hideLoading(detailsLoadingRef.current);
        detailsLoadingRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-fetch when selectedId changes, not on every library sync
  }, [selectedId]);

  // Refresh details from in-memory cache when library data changes while dialog is open.
  // This is cheap (no DB call) and keeps the dialog in sync with background updates.
  // Unchanged details keep the current object so a no-op library push does not
  // re-render the dialog (#25 P1).
  useEffect(() => {
    if (!selectedId) return;
    const cached = getMediaDetails(selectedId);
    if (cached) {
      setSelectedDetails((prev) => (prev && plainDataEqual(prev, cached) ? prev : cached));
    }
  }, [selectedId, media, playlists, getMediaDetails]);

  useTrailerParamSync({
    selectedId,
    detailsId: selectedDetails?.id ?? null,
    searchTrailerParam,
    activeTrailerKey,
    setActiveTrailerKey,
    setTrailerParam,
  });

  useEffect(() => {
    setTrackDrafts({});
    setDeleteAudioTrackTarget(null);
  }, [selectedDetails?.id]);

  // Offline reconcile on media-modal open. Targeted single-media stat so the
  // user gets a fresh "saved offline" badge state even if they renamed /
  // moved the file outside the app. Cheap (few stat calls per modal open).
  // See badger.offline.reconcile contract.
  useEffect(() => {
    if (!selectedDetails) return;
    const mediaId = selectedDetails.id;
    let cancelled = false;
    void (async () => {
      try {
        const result = await callOfflineReconcile({ mediaIds: [mediaId] });
        if (cancelled) return;
        if (isOfflineIpcError(result)) {
          // Soft-fail — the badge will just stay potentially stale until
          // the next bootstrap. Log it for diagnostics but don't toast.
          playbackDiagLog.warn(
            { errorCode: result.errorCode, status: result.status, mediaId },
            "offline_reconcile_ipc_failed",
          );
          return;
        }
        if (result.dropped.length > 0) {
          // Refresh the offline-state store so badges update immediately.
          refreshOfflineStateForMedia(mediaId);
          // Notify the user about any external rename/delete.
          toast(t("library.offline.toast.fileMissingDroppedFromOffline"));
        }
      } catch (err) {
        if (cancelled) return;
        playbackDiagLog.warn(
          { error: err instanceof Error ? err.message : String(err), mediaId },
          "offline_reconcile_threw",
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedDetails?.id, t]);

  // Stabilize the `media` prop fed into MediaPlaybackController so churn
  // from libraryContext background syncs (which re-runs the selectedDetails
  // effect at line ~451 and assigns a new object reference even when the
  // underlying media is functionally unchanged) doesn't propagate
  // unnecessary re-renders into the playback engine. Only re-emit when a
  // load-bearing field changes — identity, server-update marker, the file
  // list, or the track lists that the engine's resolvers depend on. This
  // is defensive depth on top of the position-based controller key fix
  // (3d94a69a): even if some future change makes `selectedDetails` flip
  // more aggressively, the engine downstream sees a stable reference
  // until something it actually cares about changes.
  // @bugfix mpv-launch-loop-from-controller-mount-storm
  const playbackMedia = useMemo(
    () => selectedDetails,
    [
      selectedDetails?.id,
      selectedDetails?.updatedAt,
      selectedDetails?.files,
      selectedDetails?.formats,
      selectedDetails?.audioTracks,
      selectedDetails?.subtitleTracks,
      selectedDetails?.skipMarkers,
      selectedDetails?.episodes,
      selectedDetails?.hasFiles,
    ]
  );

  // Diagnostic: log every selectedDetails reassignment so future field
  // traces show whether libraryContext background syncs are still
  // producing prop churn into the playback path. Cheap — fires only
  // when selectedDetails changes reference.
  useEffect(() => {
    if (!selectedDetails) return;
    playbackDiagLog.info({
      mediaId: selectedDetails.id,
      audioTracksCount: selectedDetails.audioTracks.length,
      subtitleTracksCount: selectedDetails.subtitleTracks.length,
    }, "selectedDetails: reassigned");
  }, [selectedDetails]);

  const requestPlayback = useCallback(
    (episodeId?: string | null) => {
      if (!selectedDetails?.hasFiles) return;
      setPlaybackEpisodeId(episodeId ?? null);
      // Use Date.now() (always-increasing) instead of value+1 so the request
      // ID is unique across MediaDetailsDialog mount/unmount cycles. The
      // module-level shouldHandlePlaybackRequest dedupe in
      // @space/desktop-mpv-playback is keyed on `${mediaId}:${episodeId}:${requestId}`
      // with a 5s TTL — without monotonic IDs, a second play click on the
      // same media/episode after the dialog closes and re-opens (the
      // requestId state would reset to 0 then increment back to 1) collides
      // with the previous click and the resume prompt is silently dropped.
      // @bugfix dialog-reopen-resume-prompt-dropped
      // @regression-proof
      setPlaybackRequestId(Date.now());
    },
    [selectedDetails?.hasFiles]
  );
  const playAction = useAsyncAction(async (episodeId?: string | null) => {
    requestPlayback(episodeId ?? null);
    // Hold pending for a short window so re-clicks during launch are dropped
    // and the button can show a spinner while MediaPlaybackController claims
    // the request and opens the loading modal.
    await new Promise<void>((resolve) => setTimeout(resolve, 600));
  });

  const isTrailerRefreshNeeded = () => {
    if (!selectedDetails) return false;
    const shared = getSharedSetting("trailer_languages");
    if (!shared) return false;
    try {
      const payload = JSON.parse(shared.value) as { updatedAt?: string };
      if (!payload?.updatedAt) return false;
      const updatedAt = Date.parse(payload.updatedAt);
      const mediaUpdatedAt = Date.parse(selectedDetails.updatedAt);
      if (!Number.isFinite(updatedAt) || !Number.isFinite(mediaUpdatedAt)) return false;
      return mediaUpdatedAt < updatedAt;
    } catch {
      return false;
    }
  };

  const ensureTrailersFresh = async () => {
    if (!token || !selectedDetails || selectedDetails.tmdbId === null) return;
    const shared = getSharedSetting("trailer_languages");
    if (!shared) return;
    let payload: { extras?: string[]; updatedAt?: string } | null = null;
    try {
      payload = JSON.parse(shared.value) as { extras?: string[]; updatedAt?: string };
    } catch {
      payload = null;
    }
    if (!payload?.updatedAt) return;
    const updatedAt = Date.parse(payload.updatedAt);
    const mediaUpdatedAt = Date.parse(selectedDetails.updatedAt);
    if (!Number.isFinite(updatedAt) || !Number.isFinite(mediaUpdatedAt)) return;
    if (mediaUpdatedAt >= updatedAt) return;

    try {
      // The stored original language, else the one the kept texts name (LIB-LANG-02): asked at most once per title
      // and interface language, and that answer is kept as the detail page's texts.
      const originalLanguage = await trailerOriginalLanguage(
        token,
        { type: selectedDetails.type, tmdbId: selectedDetails.tmdbId, originalLanguage: selectedDetails.originalLanguage },
        isClientUiLanguage(i18n.language) ? i18n.language : "en"
      );
      const extras = Array.isArray(payload.extras) ? payload.extras : [];
      const trailers = await getTmdbTrailersForLanguages(token, selectedDetails.type, selectedDetails.tmdbId, [
        originalLanguage,
        ...extras,
      ]);
      await replaceMediaTrailers(selectedDetails.id, trailers);
      refreshSelected();
    } catch {
      return;
    }
  };

  useEffect(() => {
    refreshSelected();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, playlists]);

  // The open trailer and the trailer menu reset only when the page moves to another title or closes. A library refresh
  // hands the page a new details object for the same title; resetting on that closed the menu under the user's click
  // and closed a playing trailer (#2682, LIB-DETAIL-05).
  useEffect(() => {
    const uiLanguage = i18n.language || "en";
    const mediaChanged = (selectedDetails?.id ?? null) !== prevMediaIdRef.current;
    if (!selectedDetails) {
      if (!selectedId) {
        setSelectedSeason(null);
        setSelectedEpisodeId(null);
        setDetailTab("details");
        setMovieTab("details");
        setTrackModalEpisodeId(null);
        setMovieSubtitleModalOpen(false);
        setEpisodeSubtitleModalOpen(false);
        setMovieSubtitleDraft({ file: null, language: uiLanguage, label: "" });
        setEpisodeSubtitleDraft({ file: null, language: uiLanguage, label: "" });
        setActiveTrailerKey(null);
        setTrailerMenuOpen(false);
        prevMediaIdRef.current = null;
      }
      return;
    }
    if (!selectedDetails || selectedDetails.type !== "tv") {
      if (mediaChanged) {
        setSelectedSeason(null);
        setSelectedEpisodeId(null);
        setDetailTab("details");
        setMovieTab("details");
        setTrackModalEpisodeId(null);
        setMovieSubtitleModalOpen(false);
        setEpisodeSubtitleModalOpen(false);
        setActiveTrailerKey(null);
        setTrailerMenuOpen(false);
      }
      setMovieSubtitleDraft({ file: null, language: uiLanguage, label: "" });
      setEpisodeSubtitleDraft({ file: null, language: uiLanguage, label: "" });
      prevMediaIdRef.current = selectedDetails.id;
      return;
    }
    if (selectedDetails.seasons.length === 0) {
      if (mediaChanged) {
        setSelectedSeason(null);
        setSelectedEpisodeId(null);
        setDetailTab("details");
        setMovieTab("details");
        setTrackModalEpisodeId(null);
        setMovieSubtitleModalOpen(false);
        setEpisodeSubtitleModalOpen(false);
        setActiveTrailerKey(null);
        setTrailerMenuOpen(false);
      }
      setMovieSubtitleDraft({ file: null, language: uiLanguage, label: "" });
      setEpisodeSubtitleDraft({ file: null, language: uiLanguage, label: "" });
      prevMediaIdRef.current = selectedDetails.id;
      return;
    }
    if (mediaChanged) {
      setSelectedEpisodeId(null);
      setSelectedSeason(null);
      setDetailTab("seasons");
      setMovieTab("details");
      setTrackModalEpisodeId(null);
      setMovieSubtitleModalOpen(false);
      setEpisodeSubtitleModalOpen(false);
      setActiveTrailerKey(null);
      setTrailerMenuOpen(false);
    }
    setMovieSubtitleDraft({ file: null, language: uiLanguage, label: "" });
    setEpisodeSubtitleDraft({ file: null, language: uiLanguage, label: "" });
    prevMediaIdRef.current = selectedDetails.id;
  }, [selectedDetails, selectedId, i18n.language]);

  useEffect(() => {
    if (!editMode) {
      setDraft(null);
      setEditError(null);
      return;
    }
    if (selectedDetails) {
      // The edit starts from the library's own title, never the profile's original-title view (ACCT-PROF-03).
      setDraft(buildDraft(getLibraryMediaDetails(selectedDetails.id) ?? selectedDetails));
    }
  }, [editMode, selectedDetails, getLibraryMediaDetails]);

  useEffect(() => {
    if (!editMode) {
      setShowEditFloating(false);
      return;
    }
    // The detail page scrolls inside the app shell, so the edit row is observed against the viewport.
    const target = editActionsRef.current;
    if (!target) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        setShowEditFloating(!entry.isIntersecting);
      },
      { threshold: 0.1 }
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [editMode]);

  const favoriteId = useMemo(() => getSystemPlaylistId("favorites"), [getSystemPlaylistId]);

  const isFavorite = favoriteId ? selectedDetails?.playlistIds.includes(favoriteId) : false;

  const togglePlaylist = async (playlistId: string | null | undefined) => {
    if (!playlistId || !selectedDetails) return;
    if (selectedDetails.playlistIds.includes(playlistId)) {
      await removeFromPlaylist(playlistId, selectedDetails.id);
    } else {
      await addToPlaylist(playlistId, selectedDetails.id);
    }
    setSelectedDetails(getMediaDetails(selectedDetails.id));
  };

  const handleDeleteMedia = async () => {
    if (!selectedDetails) return;
    setDeleteTarget({ id: selectedDetails.id, title: selectedDetails.title });
  };

  // ------------------------------------------------------------------
  // Offline-mode handlers (Phase 3). Click → resolve the button state
  // → either open the confirm dialog (save / complete) or fire the
  // delete IPC directly. Toast on failure, refresh the local-state
  // store on success.
  // ------------------------------------------------------------------
  const handleOfflineAction = (scope: OfflineScope) => {
    if (!selectedDetails) return;
    const buttonState = resolveButtonState(scope, offlineCounts);
    if (buttonState.state === "hidden") return;
    if (buttonState.state === "save" || buttonState.state === "complete") {
      setOfflineConfirmScope(scope);
      return;
    }
    // "delete" — fire the delete IPC. For movies/shows the runtime takes a
    // media-scope; for an episode we pass the media-scope too because the
    // contract delete_local doesn't have a per-episode scope (only "media"
    // or single "file"). We delete by media which covers all episodes of
    // the same media, OR — for an episode specifically — we'd ideally pass
    // a fileId. Surface this as a known caveat in the report.
    void runOfflineDelete(scope);
  };

  const runOfflineDelete = async (scope: OfflineScope) => {
    if (!selectedDetails || offlineDeletePending) return;
    setOfflineDeletePending(true);
    try {
      // Resolve the scope→contract-scope translation. The contract accepts
      // { type:"media", mediaId } OR { type:"season", mediaId, seasonNumber }
      // OR { type:"file", fileId }. For episode scope we look up the
      // fileId of the matching file; if found, use it. Otherwise we soft-
      // fall to a media-wide delete (which deletes ALL offline files for
      // the media — a coarser action) and surface that via toast so the
      // user isn't surprised.
      let contractScope:
        | { type: "media"; mediaId: string }
        | { type: "season"; mediaId: string; seasonNumber: number }
        | { type: "file"; fileId: string };
      if (scope.kind === "episode") {
        const file = selectedDetails.files.find(
          (f) => f.season === scope.seasonNumber && f.episode === scope.episodeNumber,
        );
        contractScope = file
          ? { type: "file", fileId: file.id }
          : { type: "media", mediaId: selectedDetails.id };
      } else if (scope.kind === "season") {
        // Season scope (added in offline-v2): the runtime enumerates files
        // matching (mediaId AND seasonNumber) and runs cancel→unlink→drop
        // on exactly that set — no over-delete of adjacent seasons.
        contractScope = {
          type: "season",
          mediaId: selectedDetails.id,
          seasonNumber: scope.seasonNumber,
        };
      } else {
        contractScope = { type: "media", mediaId: selectedDetails.id };
      }
      const result = await callOfflineDeleteLocal({ scope: contractScope });
      if (isOfflineIpcError(result)) {
        toast(
          t("library.offline.button.deleteFailedToast", {
            reason: result.message ?? result.errorCode ?? "",
          }),
        );
        return;
      }
      toast(t("library.offline.button.deletedToast", { count: result.deleted }));
      refreshOfflineStateForMedia(selectedDetails.id);
    } catch (err) {
      toast(
        t("library.offline.button.deleteFailedToast", {
          reason: err instanceof Error ? err.message : String(err),
        }),
      );
    } finally {
      setOfflineDeletePending(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeletingMedia(true);
    try {
      const { keys } = await deleteMedia(deleteTarget.id);
      if (token) {
        const objectKeys = keys
          .map((key) => extractAssetObjectKey(key))
          .filter((key): key is string => typeof key === "string" && !key.startsWith("dummy_"));
        if (objectKeys.length > 0) {
          await deleteStorageObjects(token, objectKeys).catch(() => undefined);
        }
      }
      if (selectedId === deleteTarget.id) {
        onClose();
      }
      setDeleteTarget(null);
    } finally {
      setDeletingMedia(false);
    }
  };

  const handleAddSubtitle = async (
    mediaId: string,
    episodeId: string | null,
    draft: { file: File | null; language: string; label: string },
    reset: (next: { file: File | null; language: string; label: string }) => void
  ) => {
    if (!draft.file) return;
    if (!token) {
      throw new Error("AUTH_REQUIRED");
    }
    const language = normalizeLanguageCode(draft.language.trim() || i18n.language || "en");
    const label = draft.label.trim() || languageLabel(language);
    const path =
      window.sf?.getPathForFile?.(draft.file) ||
      ((draft.file as File & { path?: string }).path ?? "");
    if (!path) {
      throw new Error("subtitle_path_missing");
    }
    // Per-media silo placement (#145): the subtitle joins the silo this
    // media's objects already live on (null = legacy keys → main mints one).
    const placementId =
      selectedDetails && selectedDetails.id === mediaId ? findMediaPlacementId(selectedDetails, episodeId) : null;
    const uploaded = await window.sf?.uploadSubtitleFile?.({ token, path, placementId });
    if (!uploaded?.key) {
      throw new Error("subtitle_upload_failed");
    }
    const format = subtitleFormatFromName(draft.file.name);
    await addSubtitleTrack(mediaId, episodeId, language, label, uploaded.key, format);
    reset({ file: null, language, label: "" });
    refreshSelected();
  };

  // Track-edit handlers below are paired with optimistic libraryContext
  // actions: the React state mutation is queued SYNCHRONOUSLY inside
  // libraryContext, and a `useEffect` further down auto-syncs
  // `selectedDetails` whenever `mediaDetailsMap` changes. Explicit
  // `refreshSelected()` here would read the stale closure-captured
  // `getMediaDetails`, overwriting `selectedDetails` with the pre-optimistic
  // value and defeating the whole optimistic flow.
  const handleRemoveSubtitle = async (trackId: string) => {
    await removeSubtitleTrack(trackId);
  };

  const handleSetDefaultSubtitle = async (
    mediaId: string,
    episodeId: string | null,
    trackId: string | null
  ) => {
    await setDefaultSubtitleTrack(mediaId, episodeId, trackId);
  };

  const handleSetDefaultAudio = async (mediaId: string, episodeId: string | null, trackId: string) => {
    await setDefaultAudioTrack(mediaId, episodeId, trackId);
  };

  const handleRemoveAudioTrack = async (trackId: string, episodeId: string | null) => {
    const tracks =
      selectedDetails?.audioTracks.filter((track) =>
        episodeId ? track.episodeId === episodeId : !track.episodeId
      ) ?? [];
    if (tracks.length <= 1) return;
    await removeAudioTrack(trackId);
    if (deleteAudioTrackTarget?.id === trackId) {
      setDeleteAudioTrackTarget(null);
    }
    setTrackDrafts((prev) => {
      const next = { ...prev };
      delete next[trackId];
      return next;
    });
  };

  const setTrackDraft = (trackId: string, next: { language?: string; label?: string }) => {
    setTrackDrafts((prev) => {
      const current = prev[trackId] ?? { language: "", label: "" };
      return {
        ...prev,
        [trackId]: {
          language: next.language ?? current.language,
          label: next.label ?? current.label,
        },
      };
    });
  };

  const clearTrackDraft = (trackId: string) => {
    setTrackDrafts((prev) => {
      if (!(trackId in prev)) return prev;
      const next = { ...prev };
      delete next[trackId];
      return next;
    });
  };

  const handleSaveAudioTrack = async (trackId: string, language: string, label: string) => {
    await updateAudioTrack(trackId, language, label);
    clearTrackDraft(trackId);
  };

  const handleSaveSubtitleTrack = async (trackId: string, language: string, label: string) => {
    await updateSubtitleTrack(trackId, language, label);
    clearTrackDraft(trackId);
  };

  const addCastRow = () => {
    if (!draft) return;
    setDraft({
      ...draft,
      cast: [
        ...draft.cast,
        {
          id: crypto.randomUUID(),
          name: "",
          role: "",
          profile: toImageDraft(null),
        },
      ],
    });
  };

  const removeCastRow = (id: string) => {
    if (!draft) return;
    setDraft({ ...draft, cast: draft.cast.filter((member) => member.id !== id) });
  };

  const resolveImageDraft = async (draft: ImageDraft, tokenValue: string, keyBase64: string) => {
    if (draft.file) {
      return uploadEncryptedAssetFromFile(tokenValue, keyBase64, draft.file);
    }
    if (draft.url.trim()) {
      return uploadEncryptedAssetFromUrl(tokenValue, keyBase64, draft.url.trim());
    }
    return draft.current ?? null;
  };

  const handleSaveEdit = async () => {
    if (!draft || !selectedDetails || !token) return;
    setSavingEdit(true);
    setEditError(null);
    try {
      const key = await getStoredLibraryKey();
      if (!key) throw new Error("KEY_REQUIRED");

      const posterPath = await resolveImageDraft(draft.poster, token, key);
      const backdropPath = await resolveImageDraft(draft.backdrop, token, key);

      const cast: MediaCastDraft[] = await Promise.all(
        draft.cast.map(async (member) => ({
          personId: member.personId,
          tmdbId: member.tmdbId ?? null,
          name: member.name.trim() || member.name,
          role: member.role.trim() || null,
          profilePath: await resolveImageDraft(member.profile, token, key),
        }))
      );

      const seasons: MediaSeasonDraft[] = await Promise.all(
        draft.seasons.map(async (season) => ({
          id: season.id,
          name: season.name.trim() || season.name,
          overview: season.overview.trim() || null,
          posterPath: await resolveImageDraft(season.poster, token, key),
          episodeCount: Number.isFinite(Number(season.episodeCount)) ? Number(season.episodeCount) : null,
          airDate: season.airDate.trim() || null,
        }))
      );

      const episodes: MediaEpisodeDraft[] = await Promise.all(
        draft.episodes.map(async (episode) => ({
          id: episode.id,
          name: episode.name.trim() || episode.name,
          overview: episode.overview.trim() || null,
          stillPath: await resolveImageDraft(episode.still, token, key),
          airDate: episode.airDate.trim() || null,
        }))
      );

      const ratingValue = draft.rating.trim();
      const rating = ratingValue ? Number(ratingValue) : null;

      await updateMediaMetadata({
        mediaId: selectedDetails.id,
        media: {
          title: draft.title.trim() || selectedDetails.title,
          originalTitle: draft.originalTitle.trim() || null,
          originalLanguage: draft.originalLanguage.trim() || null,
          overview: draft.overview.trim() || null,
          year: draft.year.trim() || null,
          rating: Number.isFinite(rating) ? rating : null,
          posterPath,
          backdropPath,
          genres: Array.isArray(draft.genres) ? draft.genres : [],
          totalEpisodes: selectedDetails.totalEpisodes ?? null,
        },
        cast,
        seasons,
        episodes,
      });

      setEditMode(false);
      refreshSelected();
    } catch {
      setEditError(t("library.edit.saveError"));
    } finally {
      setSavingEdit(false);
    }
  };

  const handleRestore = async (resetCast: boolean) => {
    if (!selectedDetails) return;
    setRestoring(true);
    setEditError(null);
    try {
      await restoreMediaFromTmdb(selectedDetails.id, { resetCast });
      setRestoreOpen(false);
      setEditMode(false);
      refreshSelected();
    } catch {
      setEditError(t("library.edit.restoreError"));
    } finally {
      setRestoring(false);
    }
  };

  const ImageField = ({
    label,
    draftValue,
    onChange,
    alt,
  }: {
    label: string;
    draftValue: ImageDraft;
    onChange: (next: ImageDraft) => void;
    alt: string;
  }) => {
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);

    useEffect(() => {
      if (draftValue.file) {
        const next = URL.createObjectURL(draftValue.file);
        setPreviewUrl(next);
        return () => URL.revokeObjectURL(next);
      }
      setPreviewUrl(null);
    }, [draftValue.file]);

    const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const file = event.dataTransfer.files?.[0];
      const uri = event.dataTransfer.getData("text/uri-list") || event.dataTransfer.getData("text/plain");
      if (file) {
        onChange({ ...draftValue, file, url: "" });
        return;
      }
      if (uri) {
        onChange({ ...draftValue, url: uri, file: null });
      }
    };

    const handlePaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
      const file = event.clipboardData.files?.[0];
      const text = event.clipboardData.getData("text/plain");
      if (file) {
        onChange({ ...draftValue, file, url: "" });
        return;
      }
      if (text) {
        onChange({ ...draftValue, url: text, file: null });
      }
    };

    const preview = previewUrl ?? (draftValue.url.trim() ? draftValue.url.trim() : null);

    return (
      <div
        {...OWN_FILE_DROP}
        className="space-y-2 rounded-lg border border-dashed border-border p-3"
        onDrop={handleDrop}
        onDragOver={(event) => event.preventDefault()}
        onPaste={handlePaste}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => onChange({ current: null, file: null, url: "" })}
          >
            <Trash2 className="mr-2 h-3 w-3" />
            {t("library.edit.clearImage")}
          </Button>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="h-32 w-24 overflow-hidden rounded-md bg-muted sm:h-36 sm:w-28">
            {preview ? (
              <img src={preview} alt={alt} className="h-full w-full object-cover" />
            ) : (
              <MediaImage path={draftValue.current} alt={alt} className="h-full w-full object-cover" />
            )}
          </div>
          <div className="flex flex-1 flex-col gap-2">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <ImagePlus className="h-4 w-4" />
              <span>{t("library.edit.dropImage")}</span>
            </div>
            <Input
              value={draftValue.url}
              onChange={(event: React.ChangeEvent<HTMLInputElement>) => onChange({ ...draftValue, url: event.target.value })}
              placeholder={t("library.edit.imageUrl")}
            />
            <Input
              type="file"
              accept="image/*"
              onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
                const file = event.target.files?.[0] ?? null;
                if (file) {
                  onChange({ ...draftValue, file, url: "" });
                }
              }}
            />
          </div>
        </div>
      </div>
    );
  };

  const InlineImageField = ({
    label,
    draftValue,
    onChange,
    alt,
  }: {
    label: string;
    draftValue: ImageDraft;
    onChange: (next: ImageDraft) => void;
    alt: string;
  }) => {
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);

    useEffect(() => {
      if (draftValue.file) {
        const next = URL.createObjectURL(draftValue.file);
        setPreviewUrl(next);
        return () => URL.revokeObjectURL(next);
      }
      setPreviewUrl(null);
    }, [draftValue.file]);

    const preview = previewUrl ?? (draftValue.url.trim() ? draftValue.url.trim() : null);

    const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const file = event.dataTransfer.files?.[0];
      const uri = event.dataTransfer.getData("text/uri-list") || event.dataTransfer.getData("text/plain");
      if (file) {
        onChange({ ...draftValue, file, url: "" });
        return;
      }
      if (uri) {
        onChange({ ...draftValue, url: uri, file: null });
      }
    };

    const handlePaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
      const file = event.clipboardData.files?.[0];
      const text = event.clipboardData.getData("text/plain");
      if (file) {
        onChange({ ...draftValue, file, url: "" });
        return;
      }
      if (text) {
        onChange({ ...draftValue, url: text, file: null });
      }
    };

    return (
      <div {...OWN_FILE_DROP} className="flex flex-col gap-2" onDrop={handleDrop} onDragOver={(event) => event.preventDefault()} onPaste={handlePaste}>
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="flex items-center gap-3">
          <div className="h-12 w-12 overflow-hidden rounded-full bg-muted">
            {preview ? (
              <img src={preview} alt={alt} className="h-full w-full object-cover" />
            ) : (
              <MediaImage path={draftValue.current} alt={alt} className="h-full w-full object-cover" />
            )}
          </div>
          <div className="flex flex-1 flex-col gap-2">
            <Input
              value={draftValue.url}
              onChange={(event: React.ChangeEvent<HTMLInputElement>) => onChange({ ...draftValue, url: event.target.value })}
              placeholder={t("library.edit.imageUrl")}
            />
            <Input
              type="file"
              accept="image/*"
              onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
                const file = event.target.files?.[0] ?? null;
                if (file) onChange({ ...draftValue, file, url: "" });
              }}
            />
          </div>
        </div>
      </div>
    );
  };

  const filePresence = useMemo(() => buildMediaFilePresence(selectedDetails), [selectedDetails]);

  // Offline-mode roll-up (Phase 3). Reads the shared offlineState store +
  // selectedDetails. The `helper` reads the store directly (not via the
  // snapshot prop), so we key off `offlineStateSnapshot.version` to force
  // a re-compute when the store mutates — the snapshot identity itself is
  // not part of the inputs.
  const offlineCounts = useMemo(
    () => computeOfflineLocalCountsForDetails(selectedDetails),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedDetails, offlineStateSnapshot.version],
  );
  const playablePresence = useMemo(
    () => playableNowPresence(filePresence, libraryOnline, offlineCounts.episodesLocal),
    [filePresence, libraryOnline, offlineCounts],
  );
  const movieUnavailableOffline = !libraryOnline && !offlineCounts.movieLocal;

  const { entries: episodeResumeById, isReady: episodeResumesReady } = useMemo(
    () => buildEpisodeResumeMap(selectedDetails, getSharedSetting, datasetStatus.playback),
    [datasetStatus.playback, getSharedSetting, selectedDetails]
  );

  // Phase 2: per-episode credits-start lookup (from MediaDetails.skipMarkers,
  // TheIntroDB-derived). Drives the credits-aware "completed" check in the
  // picker and the episode-row band UI. Episodes with no credits marker
  // fall through to the legacy 95 % pct rule — no degradation.
  const episodeCreditsById = useMemo(
    () => buildEpisodeCreditsMap(selectedDetails),
    [selectedDetails]
  );

  const defaultPlayableEpisodeId = useMemo(
    () => resolveDefaultPlayableEpisodeId(selectedDetails, playablePresence, episodeResumeById, episodeCreditsById),
    [episodeCreditsById, episodeResumeById, playablePresence, selectedDetails]
  );

  const defaultPlayableEpisodeLabel = useMemo(
    () => resolveDefaultPlayableEpisodeLabel(selectedDetails, defaultPlayableEpisodeId),
    [defaultPlayableEpisodeId, selectedDetails]
  );
  // "Resume" only for a started, unfinished episode: once every episode is watched the picker
  // falls back to the first one, which is a fresh Play, not a resume. @req PLAY-RESUME-02
  const defaultPlayableEpisodeResumable = useMemo(() => {
    const resume = episodeResumeById.get(defaultPlayableEpisodeId ?? "");
    return Boolean(resume) && !isEpisodeResumeCompleted(resume, episodeCreditsById.get(defaultPlayableEpisodeId ?? ""));
  }, [defaultPlayableEpisodeId, episodeCreditsById, episodeResumeById]);

  // Cross-stream race gate: when an in-flight or recently succeeded ingest
  // job stamped a `libraryVersionAtDone`, hold the play button disabled
  // until the renderer's last-seen library snapshot has caught up — or
  // until the stabilization timeout elapses, whichever comes first. Falls
  // through to the existing hasFiles check when no version is stamped
  // (older runtime, replayed event, or commit didn't write).
  const versionEntry = selectedDetails?.id
    ? libraryVersionAtDoneByMediaId.get(selectedDetails.id)
    : undefined;
  const versionPending = isLibraryVersionPending(
    versionEntry
      ? {
          libraryVersionAtDone: versionEntry.version,
          libraryVersionDoneAt: versionEntry.doneAt,
        }
      : null,
    currentLibraryVersion,
  );

  const availableMovieQualities = useMemo(() => collectAvailableMovieQualities(selectedDetails), [selectedDetails]);
  // LIB-DETAIL-02: the film's versions as chips, best first. Play starts on the Settings quality (PLAY-QUAL-02),
  // the same pick the player makes, and its chip is marked.
  const detailVersionChips = useMemo(() => versionChips(availableMovieQualities), [availableMovieQualities]);
  const playVersionChipId = useMemo(() => {
    const picked = pickSettingsFormat(availableMovieQualities, clientConfig.playbackQuality);
    if (!picked) return null;
    const label = versionLabel(picked);
    return detailVersionChips.find((chip) => chip.label === label)?.id ?? null;
  }, [availableMovieQualities, clientConfig.playbackQuality, detailVersionChips]);

  const episodeQualities = useMemo(() => collectEpisodeQualities(selectedDetails), [selectedDetails]);

  // Post-ingest re-plan state: hover-delete + add modal both target a single
  // file at a time. AddQualityTarget carries the file + existing formats so the
  // modal can compute candidates / source picks via pickReTranscodeSource.
  const [deleteFormatTarget, setDeleteFormatTarget] = useState<
    | {
        format: MediaFormat;
        mediaId: string;
      }
    | null
  >(null);
  const [deletingFormat, setDeletingFormat] = useState(false);
  const [addQualityTarget, setAddQualityTarget] = useState<
    | {
        mediaId: string;
        fileId: string;
        existingFormats: MediaFormat[];
        durationSeconds: number | null;
      }
    | null
  >(null);

  const confirmDeleteFormat = async () => {
    if (!deleteFormatTarget || deletingFormat) return;
    const api = window.sf?.runtimeJobs?.replanQualities;
    if (!api) {
      toast(
        t("library.qualities.deleteFailedToast", {
          quality: deleteFormatTarget.format.quality,
          reason: t("library.qualities.errors.media-not-found"),
        }),
      );
      return;
    }
    setDeletingFormat(true);
    try {
      const result = await api({
        mediaId: deleteFormatTarget.mediaId,
        fileId: deleteFormatTarget.format.fileId,
        addQualities: [],
        removeFormatIds: [deleteFormatTarget.format.id],
      });
      if ("__runtimeJobsError" in result) {
        toast(
          t("library.qualities.deleteFailedToast", {
            quality: deleteFormatTarget.format.quality,
            reason: result.message ?? result.errorCode ?? "",
          }),
        );
        return;
      }
      if (result.errorCode) {
        toast(
          t("library.qualities.deleteFailedToast", {
            quality: deleteFormatTarget.format.quality,
            reason: replanErrorLabel(t, result.errorCode),
          }),
        );
        return;
      }
      toast(
        t("library.qualities.deletedToast", { quality: deleteFormatTarget.format.quality }),
      );
      setDeleteFormatTarget(null);
    } catch (err) {
      toast(
        t("library.qualities.deleteFailedToast", {
          quality: deleteFormatTarget.format.quality,
          reason: err instanceof Error ? err.message : String(err),
        }),
      );
    } finally {
      setDeletingFormat(false);
    }
  };

  const { hasProcessingJobsForMedia } = useMemo(
    () =>
      buildMediaDetailsJobSummary(selectedDetails?.id, {
        jobs,
        activeJobs,
        ingestJobs,
      }),
    [activeJobs, ingestJobs, jobs, selectedDetails?.id]
  );


  const audioTrackCounts = useMemo(
    () => countEpisodeTracks(selectedDetails?.audioTracks ?? []),
    [selectedDetails]
  );

  // OCR twins (PLAY-TRACK-05) ride on their picture track for the Android TV: never a row of their own here.
  const subtitleTrackCounts = useMemo(
    () => countEpisodeTracks((selectedDetails?.subtitleTracks ?? []).filter((track) => !isOcrTwin(track))),
    [selectedDetails]
  );

  const getEpisodeAudioTracks = (episodeId: string) =>
    selectedDetails ? selectedDetails.audioTracks.filter((track) => track.episodeId === episodeId) : [];

  const getEpisodeSubtitleTracks = (episodeId: string) =>
    selectedDetails
      ? selectedDetails.subtitleTracks.filter((track) => track.episodeId === episodeId && !isOcrTwin(track))
      : [];

  const sortAudioTracks = <T extends { language: string; label: string }>(tracks: T[]) =>
    tracks.slice().sort((a, b) => {
      const byLang = languageLabel(a.language).localeCompare(languageLabel(b.language));
      if (byLang !== 0) return byLang;
      return (a.label ?? "").localeCompare(b.label ?? "");
    });

  const activeSubtitleEpisode =
    selectedDetails?.episodes.find((episode) => episode.id === trackModalEpisodeId) ?? null;

  const getTrackDraftValue = (trackId: string, language: string, label: string) => {
    const draft = trackDrafts[trackId];
    return {
      language: draft?.language || normalizeLanguageCode(language),
      label: draft?.label ?? label ?? "",
    };
  };

  const renderTrackRow = (
    track: { id: string; language: string; label: string; isDefault: boolean; source?: string },
    options: {
      kind: "audio" | "subtitle";
      episodeId: string | null;
      audioTracksCount?: number;
      mediaId: string;
    }
  ) => {
    const draft = getTrackDraftValue(track.id, track.language, track.label);
    const normLang = normalizeLanguageCode(draft.language);
    const isUnd = normLang === "und";
    const trimmedLabel = (draft.label ?? "").trim();
    const langName = languageLabel(normLang);
    // Hide a redundant descriptor (label === language name) so legacy rows
    // ingested as e.g. {language: "en", label: "English"} appear with an
    // empty descriptor field instead of a surprise prefill.
    const displayLabel = !isUnd && trimmedLabel === langName ? "" : draft.label;

    const onLanguageChange = (rawValue: string) => {
      const nextLang = normalizeLanguageCode(rawValue);
      const oldLangName = languageLabel(normLang);
      const currentLabel = (draft.label ?? "").trim();
      const labelIsRedundant = currentLabel === oldLangName;

      let nextLabel: string;
      if (nextLang === "und") {
        // Custom-label mode requires a label — "und + empty" isn't a valid
        // track. Prefer the existing descriptor; otherwise seed with the old
        // language name so the user has something to edit from.
        nextLabel = currentLabel || oldLangName || "";
      } else {
        // Drop a redundant label (label === old language name) on language
        // change so we don't carry e.g. "English" as a descriptor onto a
        // Spanish row.
        nextLabel = labelIsRedundant ? "" : draft.label ?? "";
      }

      setTrackDraft(track.id, { language: nextLang, label: nextLabel });
      if (nextLang === "und" && nextLabel.trim() === "") {
        // Can't persist a label-less custom track. Keep in draft only — the
        // user must type something into the label field.
        return;
      }
      if (options.kind === "audio") {
        void handleSaveAudioTrack(track.id, nextLang, nextLabel);
      } else {
        void handleSaveSubtitleTrack(track.id, nextLang, nextLabel);
      }
    };

    const onLabelBlur = () => {
      const latest = getTrackDraftValue(track.id, track.language, track.label);
      const normalizedLanguage = normalizeLanguageCode(latest.language);
      // Invariant: a track with no language (custom-label mode) MUST carry a
      // label — otherwise there's nothing to identify it by. If the user
      // cleared the field while in und mode, revert silently.
      if (normalizedLanguage === "und" && latest.label.trim() === "") {
        clearTrackDraft(track.id);
        return;
      }
      if (latest.label === track.label && normalizedLanguage === normalizeLanguageCode(track.language)) {
        return; // nothing changed
      }
      if (options.kind === "audio") {
        void handleSaveAudioTrack(track.id, normalizedLanguage, latest.label);
      } else {
        void handleSaveSubtitleTrack(track.id, normalizedLanguage, latest.label);
      }
    };

    const onRadioClick = () => {
      if (options.kind === "audio") {
        if (track.isDefault) return;
        void handleSetDefaultAudio(options.mediaId, options.episodeId, track.id);
      } else {
        void handleSetDefaultSubtitle(
          options.mediaId,
          options.episodeId,
          track.isDefault ? null : track.id
        );
      }
    };

    const onTrashClick = () => {
      if (options.kind === "audio") {
        setDeleteAudioTrackTarget({
          id: track.id,
          episodeId: options.episodeId,
          label: track.label || languageLabel(track.language),
        });
      } else {
        void handleRemoveSubtitle(track.id);
      }
    };

    const singleAudio = options.kind === "audio" && (options.audioTracksCount ?? 0) <= 1;
    const trashDisabled = singleAudio;
    const radioDisabled = options.kind === "audio" && track.isDefault;

    return (
      <div
        key={track.id}
        className={[
          "rounded-lg border bg-muted/10 px-3 py-2",
          track.isDefault ? "border-l-4 border-l-primary border-border" : "border-border",
        ].join(" ")}
      >
        <div className="grid min-h-9 items-center gap-2 sm:grid-cols-[auto_minmax(180px,1fr)_minmax(160px,1.4fr)_auto]">
          <button
            type="button"
            role="radio"
            aria-checked={track.isDefault}
            aria-label={t("library.tracks.setAsDefault")}
            disabled={radioDisabled}
            onClick={onRadioClick}
            className={[
              "flex h-5 w-5 items-center justify-center rounded-full border-2 transition-colors",
              track.isDefault
                ? "border-primary bg-primary/10"
                : "border-input hover:border-primary",
              radioDisabled ? "cursor-default" : "cursor-pointer",
            ].join(" ")}
          >
            {track.isDefault && <span className="h-2.5 w-2.5 rounded-full bg-primary" />}
          </button>
          <select
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            value={normLang}
            onChange={(event) => onLanguageChange(event.target.value)}
          >
            <option value="und">{t("library.tracks.noLanguageOption")}</option>
            <option disabled>──────────</option>
            {sortedLanguageOptions.map((lang) => (
              <option key={lang.code} value={lang.code}>
                {lang.label}
              </option>
            ))}
          </select>
          <Input
            className="h-9"
            value={displayLabel}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
              setTrackDraft(track.id, { label: event.target.value })
            }
            onBlur={onLabelBlur}
            placeholder={
              isUnd
                ? t("library.tracks.customLabelPlaceholder")
                : t("library.tracks.descriptorPlaceholder")
            }
          />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={trashDisabled}
            className={trashDisabled ? "opacity-50" : ""}
            aria-label={
              options.kind === "audio" ? t("library.tracks.deleteAudio") : t("library.subtitles.remove")
            }
            onClick={onTrashClick}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
    );
  };

  // `part`: a film's detail page shows audio on "Versions & tracks" and subtitles on "Subtitles"; an episode's
  // track modal shows both.
  const renderTracksManager = (episodeId: string | null, part: "all" | "audio" | "subtitles" = "all") => {
    if (!selectedDetails) return null;
    const audioTracks = sortAudioTracks(
      episodeId ? getEpisodeAudioTracks(episodeId) : selectedDetails.audioTracks.filter((track) => !track.episodeId)
    );
    const subtitleTracks = sortSubtitleTracks(
      episodeId
        ? getEpisodeSubtitleTracks(episodeId)
        : selectedDetails.subtitleTracks.filter((track) => !track.episodeId && !isOcrTwin(track))
    , languageLabel);
    const hasDefaultSubtitle = subtitleTracks.some((track) => track.isDefault);

    return (
      <div className="space-y-5 overflow-hidden">
        {part !== "subtitles" ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="text-sm font-semibold">{t("library.labels.audio")}</div>
            <div className="text-xs text-muted-foreground">{t("library.tracks.audioIngestHint")}</div>
          </div>
          {audioTracks.length === 0 ? (
            <div className="text-sm text-muted-foreground">{t("library.audioDialog.empty")}</div>
          ) : (
            <div className="grid max-h-[32vh] gap-2 overflow-y-auto pr-1">
              {audioTracks.map((track) =>
                renderTrackRow(track, {
                  kind: "audio",
                  episodeId,
                  audioTracksCount: audioTracks.length,
                  mediaId: selectedDetails.id,
                })
              )}
            </div>
          )}
        </div>
        ) : null}
        {part !== "audio" ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold">{t("library.subtitles.title")}</div>
            <div className="flex flex-wrap items-center gap-2">
              {/* PLAY-SUBGET-01, -12: greyed out offline, back by itself when the connection returns. */}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!online}
                title={online ? undefined : subtitleFetchCopy(i18n.language).offline}
                data-testid="subtitle-fetch-open"
                onClick={() => setSubtitleFetchEpisodeId(episodeId)}
              >
                <DownloadCloud className="mr-1 h-4 w-4" />
                {t("library.tracks.fetchSubtitles")}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="subtitle-upload-open"
                onClick={() => {
                  if (episodeId) {
                    setEpisodeSubtitleModalOpen(true);
                  } else {
                    setMovieSubtitleModalOpen(true);
                  }
                }}
              >
                <Plus className="mr-1 h-4 w-4" />
                {t("library.tracks.addSubtitle")}
              </Button>
            </div>
          </div>
          {!online ? (
            <div className="text-xs text-muted-foreground" data-testid="subtitle-fetch-offline-hint">
              {subtitleFetchCopy(i18n.language).offline}
            </div>
          ) : null}
          {subtitleTracks.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              {episodeId ? t("library.subtitlesDialog.empty") : t("library.subtitles.emptyMovie")}
            </div>
          ) : (
            <>
              <div
                className={[
                  "rounded-lg border px-3 py-2 bg-card",
                  !hasDefaultSubtitle
                    ? "border-l-4 border-l-primary border-border"
                    : "border-border",
                ].join(" ")}
              >
                <div className="grid min-h-9 items-center gap-2 sm:grid-cols-[auto_1fr]">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={!hasDefaultSubtitle}
                    aria-label={t("library.tracks.noDefaultSubtitle")}
                    onClick={() =>
                      void handleSetDefaultSubtitle(selectedDetails.id, episodeId, null)
                    }
                    disabled={!hasDefaultSubtitle}
                    className={[
                      "flex h-5 w-5 items-center justify-center rounded-full border-2 transition-colors",
                      !hasDefaultSubtitle
                        ? "border-primary bg-primary/10 cursor-default"
                        : "border-input hover:border-primary cursor-pointer",
                    ].join(" ")}
                  >
                    {!hasDefaultSubtitle && <span className="h-2.5 w-2.5 rounded-full bg-primary" />}
                  </button>
                  <div className="text-sm text-muted-foreground">
                    {t("library.tracks.noDefaultSubtitle")}
                  </div>
                </div>
              </div>
              <div className="grid max-h-[32vh] gap-2 overflow-y-auto pr-1">
                {subtitleTracks.map((track) =>
                  renderTrackRow(track, { kind: "subtitle", episodeId, mediaId: selectedDetails.id })
                )}
              </div>
            </>
          )}
        </div>
        ) : null}
      </div>
    );
  };

  // LIB-DETAIL-01: the tabs come from the shared tab set; the TV and film views keep their own tab state.
  const isShow = selectedDetails?.type === "tv";
  const activeDetailTab: MediaDetailTab = isShow
    ? detailTab === "seasons"
      ? "seasons"
      : detailTab === "processing"
        ? "jobs"
        : "about"
    : movieTab === "details"
      ? "about"
      : movieTab === "processing"
        ? "jobs"
        : movieTab;
  const detailTabLabels: Record<MediaDetailTab, string> = {
    seasons: t("library.tabs.seasons"),
    about: t("library.tabs.about"),
    versions: t("library.tabs.versionsTracks"),
    subtitles: t("library.tabs.subtitles"),
    jobs: t("library.tabs.jobs"),
  };
  const detailTabsBar = (
    <MediaDetailTabs
      label={t("library.tabs.label")}
      active={activeDetailTab}
      onChange={(tab) =>
        startTransition(() => {
          if (isShow) setDetailTab(tab === "seasons" ? "seasons" : tab === "jobs" ? "processing" : "details");
          else setMovieTab(tab === "versions" || tab === "subtitles" ? tab : tab === "jobs" ? "processing" : "details");
        })
      }
      tabs={mediaDetailTabs({ seasons: isShow, jobs: true }).map((id) => ({
        id,
        label: detailTabLabels[id],
        icon: id === "jobs" && hasProcessingJobsForMedia ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : undefined,
      }))}
    />
  );
  const aboutPanel = selectedDetails ? (
    <div className="space-y-6">
      <MediaDetailCrew
        heading={t("library.crew.title")}
        groups={crewLines(selectedDetails.crew, {
          director: t("library.crew.director"),
          writing: t("library.crew.writing"),
        })}
      />
      <MediaDetailCast
        heading={t("library.cast")}
        unknownRole={t("library.castUnknownRole")}
        empty={t("library.noCast")}
        showAll={t("library.castShowAll", { count: selectedDetails.cast.length })}
        showLess={t("library.castShowLess")}
        cast={selectedDetails.cast.map((member) => ({
          id: member.id,
          name: member.name,
          role: member.role,
          avatar: member.profilePath ? (
            <MediaImage path={member.profilePath} kind="profile" alt={member.name} className="h-full w-full object-cover" />
          ) : undefined,
        }))}
      />
    </div>
  ) : null;

  return (
    <>
      {selectedDetails ? (
        <MediaDetailPage
          poster={<MediaImage path={selectedDetails.posterPath} alt={selectedDetails.title} className="h-full w-full object-cover" />}
          backdrop={selectedDetails.backdropPath ? <MediaImage path={selectedDetails.backdropPath} kind="backdrop" alt="" className="h-full w-full object-cover" /> : undefined}
          backLabel={t("library.detail.back")}
          onBack={onClose}
          kindLabel={selectedDetails.type === "movie" ? t("library.media.movie") : t("library.media.tv")}
          versions={isShow ? [] : detailVersionChips}
          playVersionId={playVersionChipId}
          playVersionHint={t("library.detail.playsThisVersion")}
          title={selectedDetails.title}
          subtitle={(() => {
            // Surface the original-language title when the displayed title differs from it — primarily for
            // non-Latin originals (anime, K-drama, Russian cinema), whose title is always shown in the account's
            // language (ACCT-PROF-03), so the user otherwise loses sight of the native title.
            const original = (selectedDetails.originalTitle ?? "").trim();
            const displayed = (selectedDetails.title ?? "").trim();
            if (!original || original.toLowerCase() === displayed.toLowerCase()) return null;
            return (
              <>
                <span className="opacity-70">{t("library.media.originalTitleLabel")}</span>{" "}
                <span lang={selectedDetails.originalLanguage ?? undefined}>{original}</span>
              </>
            );
          })()}
          meta={(() => {
            const base = [selectedDetails.year ?? null, selectedDetails.rating ? formatRating(selectedDetails.rating) : null]
              .filter(Boolean)
              .join(" · ");
            // PLAY-OPEN-04: a film with two or more editions shows each edition's length next to its name.
            const editions = selectedDetails.type === "movie" ? listEditions(selectedDetails, null) : [];
            if (editions.length < 2) return base;
            const lengths = orderEditionsForPage(editions)
              .map((edition) => {
                const name = edition.name || t("player.editionUnnamed");
                return edition.durationSeconds ? `${name} ${formatEditionLength(edition.durationSeconds)}` : name;
              })
              .join(" · ");
            return (
              <>
                {base ? `${base} · ` : null}
                <span data-testid="edition-lengths">{lengths}</span>
              </>
            );
          })()}
          genres={
            <MediaDetailGenres
              category={selectedDetails.type === "tv" ? "tv" : "movie"}
              ids={Array.isArray(selectedDetails.genres) ? selectedDetails.genres : []}
              language={i18n.language}
            />
          }
          extraChips={(() => {
            const band = getProgressBand(selectedDetails.progressPct);
            // Offline chip: movies → "Saved offline" when the single file is local. TV shows show none — the
            // per-season + per-episode stamps carry the offline state.
            const showOfflineHeader = selectedDetails.type === "movie" && offlineCounts.movieLocal;
            return (
              <>
                {band === "watched" ? (
                  <MediaDetailChip data-testid="media-detail-watched">
                    <CheckCircle2 className="mr-1 h-3 w-3" aria-hidden="true" />
                    {t("library.watched")}
                  </MediaDetailChip>
                ) : band !== "not-started" ? (
                  <MediaDetailChip>
                    {t("library.progress", { value: getProgressLabelPct(selectedDetails.progressPct) })}
                  </MediaDetailChip>
                ) : null}
                {showOfflineHeader ? <OfflineBadge state="full" size="md" /> : null}
              </>
            );
          })()}
          actions={

                  <div ref={editActionsRef} className="flex flex-wrap items-center gap-2.5">
                    {editMode ? (
                      <>
                        <Button type="button" onClick={() => void handleSaveEdit()} disabled={savingEdit}>
                          <Save className="mr-2 h-4 w-4" />
                          {savingEdit ? t("library.edit.saving") : t("library.edit.save")}
                        </Button>
                        <Button type="button" variant="ghost" onClick={() => setEditMode(false)} disabled={savingEdit}>
                          {t("library.edit.cancel")}
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          type="button"
                          className={mediaDetailPlayClass}
                          disabled={
                            (selectedDetails.type === "tv"
                              ? !defaultPlayableEpisodeId
                              : !selectedDetails.hasFiles || movieUnavailableOffline) || versionPending
                          }
                          pending={playAction.spinnerVisible}
                          spinnerLabel={t("player.launching")}
                          onClick={() => {
                            if (selectedDetails.type === "tv" && !defaultPlayableEpisodeId) return;
                            if (selectedDetails.type !== "tv" && (!selectedDetails?.hasFiles || movieUnavailableOffline)) return;
                            if (versionPending) return;
                            const nextEpisodeId =
                              selectedDetails.type === "tv" ? defaultPlayableEpisodeId : null;
                            void playAction.trigger(nextEpisodeId ?? null);
                          }}
                        >
                          <PlayCircle className="mr-2 h-5 w-5" />
                          {selectedDetails.type === "tv" && defaultPlayableEpisodeLabel
                            ? `${defaultPlayableEpisodeResumable ? t("player.resume") : t("library.play")} ${defaultPlayableEpisodeLabel}`
                            : t("library.play")}
                        </Button>
                        
                        <div className="relative" ref={trailerMenuRef}>
                          <Button
                            type="button"
                            variant="outline"
                            className={mediaDetailSecondaryClass}
                            onClick={async () => {
                              const needsRefresh = isTrailerRefreshNeeded();
                              if (needsRefresh) {
                                setTrailerRefreshing(true);
                                await ensureTrailersFresh();
                                setTrailerRefreshing(false);
                                setTrailerMenuOpen(true);
                                return;
                              }
                              setTrailerMenuOpen((prev) => !prev);
                            }}
                            disabled={trailerRefreshing || (selectedDetails.trailers.length === 0 && !isTrailerRefreshNeeded())}
                          >
                            <PlayCircle className="mr-2 h-4 w-4" />
                            {trailerRefreshing ? t("library.trailerRefreshing") : t("library.trailer")}
                          </Button>
                          {trailerMenuOpen ? (
                            <div className="absolute left-0 top-full z-20 mt-2 w-56 rounded-xl border border-border bg-popover p-2 shadow-lg">
                              {selectedDetails.trailers.length === 0 ? (
                                <div className="px-2 py-1 text-xs text-muted-foreground">{t("library.noTrailer")}</div>
                              ) : (
                                <div className="space-y-1">
                                  {selectedDetails.trailers.map((trailer) => (
                                    <button
                                      key={`${trailer.key}-${trailer.language}`}
                                      type="button"
                                      className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-xs transition hover:bg-muted/40"
                                      onClick={() => {
                                        setActiveTrailerKey(trailer.key);
                                        setTrailerMenuOpen(false);
                                      }}
                                    >
                                      <span className="font-medium">
                                        {trailer.name ? trailer.name : t("library.trailer")}
                                      </span>
                                      <span className="text-[10px] text-muted-foreground">
                                        {trailerLanguageLabel(trailer.language, t)}
                                      </span>
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          ) : null}
                        </div>

                        <Button
                          type="button"
                          variant="outline"
                          className={mediaDetailSecondaryClass}
                          onClick={() => setShowPlaylistPicker(true)}
                          data-testid="media-detail-add-to-playlist"
                        >
                          <ListPlus className="mr-2 h-4 w-4" />
                          {t("library.playlists.add")}
                        </Button>

                        <Button
                          type="button"
                          size="icon"
                          variant="outline"
                          className={[mediaDetailSecondaryClass, "w-[46px] px-0", isFavorite ? "text-primary" : ""].join(" ")}
                          onClick={() => void togglePlaylist(favoriteId)}
                          title={isFavorite ? t("library.favorites.remove") : t("library.favorites.add")}
                          aria-label={isFavorite ? t("library.favorites.remove") : t("library.favorites.add")}
                        >
                          <Heart className={["h-5 w-5", isFavorite ? "fill-current" : ""].join(" ")} />
                        </Button>

                        <div className="relative" ref={moreMenuRef}>
                          <Button
                            type="button"
                            size="icon"
                            variant="outline"
                            className={[mediaDetailSecondaryClass, "w-[46px] px-0"].join(" ")}
                            aria-label={t("library.detail.more")}
                            data-testid="media-detail-more"
                            onClick={() => setMoreMenuOpen(!moreMenuOpen)}
                          >
                            <MoreHorizontal className="h-5 w-5" />
                          </Button>
                          {moreMenuOpen && (
                            <div className="absolute left-0 top-full z-50 mt-2 w-48 rounded-xl border border-border bg-popover p-1 shadow-xl text-popover-foreground">
                              {clientConfig.enableMetadataTools ? (
                                <button
                                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-muted/50 transition text-left"
                                  onClick={() => {
                                    setEditMode(true);
                                    setMoreMenuOpen(false);
                                  }}
                                >
                                  <Pencil className="h-4 w-4" />
                                  {t("library.edit.edit")}
                                </button>
                              ) : null}
                              {clientConfig.enableMetadataTools && selectedDetails.tmdbId !== null ? (
                                <button
                                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-muted/50 transition text-left"
                                  onClick={() => {
                                    setRestoreOpen(true);
                                    setMoreMenuOpen(false);
                                  }}
                                >
                                  <RotateCcw className="h-4 w-4" />
                                  {t("library.edit.restore")}
                                </button>
                              ) : null}
                              {/* Offline-mode menu item — Site 2 of the 5-site
                                  edit. Single button per the plan: state shows
                                  Save / Complete (N/Total) / Delete depending
                                  on local-availability. */}
                              {(() => {
                                const scope: OfflineScope =
                                  selectedDetails.type === "tv"
                                    ? { kind: "show" }
                                    : { kind: "movie" };
                                const buttonState = resolveButtonState(scope, offlineCounts);
                                if (buttonState.state === "hidden") return null;
                                const Icon =
                                  buttonState.iconName === "RemoveOffline"
                                    ? RemoveOfflineIcon
                                    : buttonState.iconName === "DownloadCloud"
                                      ? DownloadCloud
                                      : Download;
                                return (
                                  <button
                                    type="button"
                                    data-testid="offline-menu-item"
                                    data-state={buttonState.state}
                                    className={[
                                      "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-muted/50 transition text-left",
                                      buttonState.state === "delete" ? "text-foreground" : "",
                                    ].join(" ")}
                                    disabled={offlineDeletePending}
                                    onClick={() => {
                                      setMoreMenuOpen(false);
                                      handleOfflineAction(scope);
                                    }}
                                  >
                                    <Icon className="h-4 w-4" />
                                    {t(buttonState.labelKey, buttonState.badgeCount ?? {})}
                                  </button>
                                );
                              })()}
                              <div className="my-1 h-px bg-border/50" />
                              <button
                                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-destructive hover:bg-destructive/10 transition text-left"
                                onClick={() => {
                                  void handleDeleteMedia();
                                  setMoreMenuOpen(false);
                                }}
                              >
                                <Trash2 className="h-4 w-4" />
                                {t("library.delete")}
                              </button>
                            </div>
                          )}
                        </div>
                      </>
                    )}
                  </div>
          }
        >
          {localizedOverview ? (
            <p className="mt-7 max-w-[720px] text-base leading-relaxed text-foreground/90" data-testid="media-detail-overview">
              {localizedOverview}
            </p>
          ) : null}
                  {editError ? (
                    <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
                      {editError}
                    </div>
                  ) : null}

                  {editMode && draft ? (
                    <div className="space-y-4 rounded-xl border border-border bg-muted/10 p-4">
                    <div className="text-sm font-semibold">{t("library.edit.metadataTitle")}</div>
                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="space-y-2">
                        <Label>{t("library.edit.fields.title")}</Label>
                        <Input value={draft.title} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, title: e.target.value })} />
                      </div>
                      <div className="space-y-2">
                        <Label>{t("library.edit.fields.originalTitle")}</Label>
                        <Input
                          value={draft.originalTitle}
                          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, originalTitle: e.target.value })}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>{t("library.edit.fields.originalLanguage")}</Label>
                        <Input
                          value={draft.originalLanguage}
                          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, originalLanguage: e.target.value })}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>{t("library.edit.fields.year")}</Label>
                        <Input value={draft.year} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, year: e.target.value })} />
                      </div>
                      <div className="space-y-2">
                        <Label>{t("library.edit.fields.rating")}</Label>
                        <Input
                          type="number"
                          min="0"
                          max="10"
                          step="0.1"
                          value={draft.rating}
                          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, rating: e.target.value })}
                        />
                      </div>
                      <div className="md:col-span-2">
                        <BadgerMultiSelect
                          label={t("library.edit.fields.genres")}
                          placeholder={t("library.edit.genres.empty")}
                          searchPlaceholder={t("library.edit.genres.search")}
                          emptyText={t("library.edit.genres.noResults")}
                          options={genreOptions.map((genre) => ({
                            value: String(genre.id),
                            label: genre.name,
                            icon: <genre.Icon className="h-4 w-4 text-primary" />,
                          }))}
                          selected={draft.genres.map((id) => String(id))}
                          onChange={(next) =>
                            setDraft({
                              ...draft,
                              genres: next.map((value) => Number(value)).filter((value) => Number.isFinite(value)),
                            })
                          }
                        />
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label>{t("library.edit.fields.overview")}</Label>
                      <textarea
                        className="min-h-[120px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        name="media-overview"
                        value={draft.overview}
                        onChange={(e) => setDraft({ ...draft, overview: e.target.value })}
                      />
                    </div>
                    <div className="grid gap-4 lg:grid-cols-2">
                      <ImageField
                        label={t("library.edit.fields.poster")}
                        draftValue={draft.poster}
                        onChange={(next) => setDraft({ ...draft, poster: next })}
                        alt={selectedDetails.title}
                      />
                      <ImageField
                        label={t("library.edit.fields.backdrop")}
                        draftValue={draft.backdrop}
                        onChange={(next) => setDraft({ ...draft, backdrop: next })}
                        alt={selectedDetails.title}
                      />
                    </div>
                  </div>
                ) : null}

                {selectedDetails.type === "tv" ? (
                  <div className="space-y-4">
                    {detailTabsBar}

                    {detailTab === "seasons" && (
                      <div className="space-y-4">
                        {editMode && draft ? (
                          selectedSeason === null ? (
                            <>
                              <div className="text-sm font-semibold">{t("library.seasons.title")}</div>
                              {draft.seasons.length === 0 ? (
                                <div className="text-sm text-muted-foreground">{t("library.seasons.empty")}</div>
                              ) : (
                                <div className="grid gap-4 lg:grid-cols-2">
                                  {draft.seasons.map((season) => (
                                    <div key={season.id} className="space-y-3 rounded-xl border border-border bg-muted/10 p-4">
                                      <div className="flex items-center justify-between">
                                        <div className="text-sm font-semibold">
                                          {t("library.edit.seasonLabel", { season: season.seasonNumber })}
                                        </div>
                                        <Button
                                          type="button"
                                          size="sm"
                                          variant="ghost"
                                          onClick={() => {
                                            setSelectedSeason(season.seasonNumber);
                                            setSelectedEpisodeId(null);
                                          }}
                                        >
                                          {t("library.edit.seasonEditEpisodes")}
                                        </Button>
                                      </div>
                                      <div className="grid gap-3 md:grid-cols-[160px_1fr]">
                                        <InlineImageField
                                          label={t("library.edit.fields.poster")}
                                          draftValue={season.poster}
                                          onChange={(next) => {
                                            const updated = draft.seasons.map((entry) =>
                                              entry.id === season.id ? { ...entry, poster: next } : entry
                                            );
                                            setDraft({ ...draft, seasons: updated });
                                          }}
                                          alt={season.name}
                                        />
                                        <div className="space-y-3">
                                          <div className="space-y-2">
                                            <Label>{t("library.edit.fields.name")}</Label>
                                            <Input
                                              value={season.name}
                                              onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
                                                const updated = draft.seasons.map((entry) =>
                                                  entry.id === season.id ? { ...entry, name: event.target.value } : entry
                                                );
                                                setDraft({ ...draft, seasons: updated });
                                              }}
                                            />
                                          </div>
                                          <div className="space-y-2">
                                            <Label>{t("library.edit.fields.airDate")}</Label>
                                            <Input
                                              value={season.airDate}
                                              onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
                                                const updated = draft.seasons.map((entry) =>
                                                  entry.id === season.id ? { ...entry, airDate: event.target.value } : entry
                                                );
                                                setDraft({ ...draft, seasons: updated });
                                              }}
                                            />
                                          </div>
                                        </div>
                                      </div>
                                      <div className="space-y-2">
                                        <Label>{t("library.edit.fields.overview")}</Label>
                                        <textarea
                                          className="min-h-[90px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                          name={`season-${season.id}-overview`}
                                          value={season.overview}
                                          onChange={(event) => {
                                            const updated = draft.seasons.map((entry) =>
                                              entry.id === season.id ? { ...entry, overview: event.target.value } : entry
                                            );
                                            setDraft({ ...draft, seasons: updated });
                                          }}
                                        />
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </>
                          ) : (
                            <div className="space-y-3">
                              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                <button
                                  type="button"
                                  className="rounded-full border border-border px-2 py-1 hover:border-primary/40"
                                  onClick={() => setSelectedSeason(null)}
                                >
                                  {t("library.seasons.title")}
                                </button>
                                <ChevronRight className="h-3 w-3" />
                                <span>
                                  {seasonDisplayName(
                                    selectedSeason,
                                    draft.seasons.find((entry) => entry.seasonNumber === selectedSeason)?.name,
                                    { specials: t("library.seasons.specials"), season: t("library.episodes.breadcrumb", { season: selectedSeason }) }
                                  )}
                                </span>
                              </div>
                              <div className="grid gap-4">
                                {draft.episodes.filter((ep) => ep.seasonNumber === selectedSeason).length === 0 ? (
                                  <div className="text-sm text-muted-foreground">{t("library.episodes.empty")}</div>
                                ) : (
                                  draft.episodes
                                    .filter((ep) => ep.seasonNumber === selectedSeason)
                                    .map((episode) => (
                                      <div key={episode.id} className="space-y-3 rounded-xl border border-border bg-muted/10 p-4">
                                        <div className="text-sm font-semibold">
                                          {t("library.edit.episodeLabel", { number: episode.episodeNumber })}
                                        </div>
                                        <div className="grid gap-3 md:grid-cols-[180px_1fr]">
                                          <InlineImageField
                                            label={t("library.edit.fields.still")}
                                            draftValue={episode.still}
                                            onChange={(next) => {
                                              const updated = draft.episodes.map((entry) =>
                                                entry.id === episode.id ? { ...entry, still: next } : entry
                                              );
                                              setDraft({ ...draft, episodes: updated });
                                            }}
                                            alt={episode.name}
                                          />
                                          <div className="space-y-3">
                                            <div className="space-y-2">
                                              <Label>{t("library.edit.fields.name")}</Label>
                                              <Input
                                                value={episode.name}
                                                onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
                                                  const updated = draft.episodes.map((entry) =>
                                                    entry.id === episode.id ? { ...entry, name: event.target.value } : entry
                                                  );
                                                  setDraft({ ...draft, episodes: updated });
                                                }}
                                              />
                                            </div>
                                            <div className="space-y-2">
                                              <Label>{t("library.edit.fields.airDate")}</Label>
                                              <Input
                                                value={episode.airDate}
                                                onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
                                                  const updated = draft.episodes.map((entry) =>
                                                    entry.id === episode.id ? { ...entry, airDate: event.target.value } : entry
                                                  );
                                                  setDraft({ ...draft, episodes: updated });
                                                }}
                                              />
                                            </div>
                                          </div>
                                        </div>
                                        <div className="space-y-2">
                                          <Label>{t("library.edit.fields.overview")}</Label>
                                          <textarea
                                            className="min-h-[90px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                            name={`episode-${episode.id}-overview`}
                                            value={episode.overview}
                                            onChange={(event) => {
                                              const updated = draft.episodes.map((entry) =>
                                                entry.id === episode.id ? { ...entry, overview: event.target.value } : entry
                                              );
                                              setDraft({ ...draft, episodes: updated });
                                            }}
                                          />
                                        </div>
                                      </div>
                                    ))
                                )}
                              </div>
                            </div>
                          )
                        ) : selectedSeason === null ? (
                          <MediaDetailSeasonList
                            heading={t("library.seasons.title")}
                            empty={selectedDetails.seasons.length === 0 ? t("library.seasons.empty") : null}
                          >
                                {selectedDetails.seasons.map((season) => {
                                  const hasFiles = filePresence.seasonHasFiles.get(season.seasonNumber) ?? false;
                                  // Site 3 of the 5-site edit — season card
                                  // hover overlay. Greyed (no-file) seasons
                                  // never get the overlay.
                                  const seasonScope: OfflineScope = {
                                    kind: "season",
                                    seasonNumber: season.seasonNumber,
                                  };
                                  const seasonButton = hasFiles
                                    ? resolveButtonState(seasonScope, offlineCounts)
                                    : { state: "hidden" as const, labelKey: "", iconName: "Download" as const };
                                  const SeasonIcon =
                                    seasonButton.iconName === "RemoveOffline"
                                      ? RemoveOfflineIcon
                                      : seasonButton.iconName === "DownloadCloud"
                                        ? DownloadCloud
                                        : Download;
                                  return (
                                    <MediaDetailSeasonCard
                                      key={season.id}
                                      seasonNumber={season.seasonNumber}
                                      onSelect={() => {
                                        setSelectedSeason(season.seasonNumber);
                                        setSelectedEpisodeId(null);
                                      }}
                                      available={playablePresence.seasonHasFiles.get(season.seasonNumber) ?? false}
                                      poster={
                                        <MediaImage
                                          path={season.posterPath}
                                          alt={season.name}
                                          className="h-full w-full object-cover"
                                        />
                                      }
                                      name={seasonDisplayName(season.seasonNumber, season.name, {
                                        specials: t("library.seasons.specials"),
                                        season: t("library.episodes.breadcrumb", { season: season.seasonNumber }),
                                      })}
                                      episodeCount={t("library.seasons.episodeCount", { count: season.episodeCount })}
                                      status={hasFiles ? t("library.seasons.available") : t("library.seasons.missing")}
                                    >
                                      {seasonButton.state !== "hidden" ? (
                                        <button
                                          type="button"
                                          data-testid={`offline-season-button-${season.seasonNumber}`}
                                          data-state={seasonButton.state}
                                          title={t("library.offline.tooltipSeasonHover")}
                                          disabled={offlineDeletePending}
                                          className={[
                                            "absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-full",
                                            seasonButton.state === "complete"
                                              ? "border border-primary/60 bg-primary/10 text-primary"
                                              : seasonButton.state === "delete"
                                                ? "bg-foreground/10 text-foreground"
                                                : "bg-primary text-primary-foreground",
                                            "opacity-0 transition group-hover:opacity-100 focus:opacity-100",
                                            "shadow",
                                          ].join(" ")}
                                          onClick={(event) => {
                                            event.stopPropagation();
                                            handleOfflineAction(seasonScope);
                                          }}
                                          aria-label={t(seasonButton.labelKey, seasonButton.badgeCount ?? {})}
                                        >
                                          <SeasonIcon className="h-4 w-4" />
                                        </button>
                                      ) : null}
                                      {/* Persistent "fully offline" stamp — only
                                          when EVERY episode of the season is
                                          local (delete state). No partial
                                          "X/Y" count, matching the movie /
                                          show-poster treatment. */}
                                      {seasonButton.state === "delete" ? (
                                        <div
                                          className="pointer-events-none absolute left-2 top-2 z-10"
                                          data-testid={`offline-season-badge-${season.seasonNumber}`}
                                          data-state="full"
                                        >
                                          <OfflineBadge state="full" size="sm" inline />
                                        </div>
                                      ) : null}
                                    </MediaDetailSeasonCard>
                                  );
                                })}
                          </MediaDetailSeasonList>
                        ) : (
                          <MediaDetailEpisodeList
                            crumb={
                              <MediaDetailSeasonCrumb
                                seasons={t("library.seasons.title")}
                                current={seasonDisplayName(
                                  selectedSeason,
                                  selectedDetails.seasons.find((entry) => entry.seasonNumber === selectedSeason)?.name,
                                  { specials: t("library.seasons.specials"), season: t("library.episodes.breadcrumb", { season: selectedSeason }) }
                                )}
                                onSeasons={() => setSelectedSeason(null)}
                              />
                            }
                            empty={
                              selectedDetails.episodes.some((ep) => ep.seasonNumber === selectedSeason)
                                ? null
                                : t("library.episodes.empty")
                            }
                          >
                            {selectedDetails.episodes
                                  .filter((ep) => ep.seasonNumber === selectedSeason)
                                  .map((episode) => {
                                    const hasFile = filePresence.episodeHasFile.has(
                                      `${episode.seasonNumber}-${episode.episodeNumber}`
                                    );
                                    const isSelected = selectedEpisodeId === episode.id;
                                    const episodeResume = episodeResumeById.get(episode.id) ?? null;
                                    const audioCount = audioTrackCounts.get(episode.id) ?? 0;
                                    const subtitleCount = subtitleTrackCounts.get(episode.id) ?? 0;
                                    const qualityKey = `${episode.seasonNumber}-${episode.episodeNumber}`;
                                    const qualities = episodeQualities.get(qualityKey) ?? [];
                                    return (
                                      <MediaDetailEpisodeRow
                                        key={episode.id}
                                        episodeId={episode.id}
                                        available={playablePresence.episodeHasFile.has(qualityKey)}
                                        selected={isSelected}
                                        onSelect={() => setSelectedEpisodeId(episode.id)}
                                        thumbnail={
                                                <MediaImage
                                                  path={episode.stillPath}
                                                  kind="still"
                                                  alt={
                                                    localizedEpisodes.get(`${episode.seasonNumber}:${episode.episodeNumber}`)?.name ??
                                                    episode.name
                                                  }
                                                  className="h-full w-full object-cover"
                                                />
                                        }
                                        thumbnailBadge={
                                              offlineCounts.episodesLocal.has(
                                                `${episode.seasonNumber}-${episode.episodeNumber}`,
                                              ) ? (
                                                <div
                                                  className="pointer-events-none absolute -left-2.5 -top-2.5 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground shadow ring-2 ring-background"
                                                  data-testid={`offline-episode-badge-${episode.seasonNumber}-${episode.episodeNumber}`}
                                                  data-state="full"
                                                  title={t("library.offline.badge.savedOffline")}
                                                  aria-label={t("library.offline.badge.savedOffline")}
                                                >
                                                  <Download className="h-3 w-3" aria-hidden="true" />
                                                </div>
                                              ) : null
                                        }
                                        title={t("library.episodes.label", {
                                          number: episode.episodeNumber,
                                          title:
                                            localizedEpisodes.get(`${episode.seasonNumber}:${episode.episodeNumber}`)?.name ??
                                            episode.name,
                                        })}
                                        titleChips={
                                          <>
                                                {audioCount > 0 ? (
                                                  <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                                                    {t("library.labels.audio")} {audioCount}
                                                  </span>
                                                ) : null}
                                                {subtitleCount > 0 ? (
                                                  <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                                                    {t("library.labels.subtitles")} {subtitleCount}
                                                  </span>
                                                ) : null}
                                          </>
                                        }
                                        chips={
                                              qualities.length > 0 ? (
                                                <div className="flex flex-wrap items-center gap-1">
                                                  {qualities.map((format) => (
                                                    <span
                                                      key={format.id}
                                                      className="group relative inline-flex items-center rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] text-muted-foreground"
                                                    >
                                                      {format.quality}
                                                      {format.isSource === true ? null : (
                                                        <button
                                                          type="button"
                                                          aria-label={t("library.qualities.deleteChipAria", { quality: format.quality })}
                                                          className="ml-1 hidden h-3.5 w-3.5 items-center justify-center rounded-full bg-destructive/15 text-destructive hover:bg-destructive/25 focus:flex group-hover:flex"
                                                          onClick={(event) => {
                                                            event.stopPropagation();
                                                            if (!selectedDetails) return;
                                                            setDeleteFormatTarget({ format, mediaId: selectedDetails.id });
                                                          }}
                                                        >
                                                          <X className="h-2.5 w-2.5" />
                                                        </button>
                                                      )}
                                                    </span>
                                                  ))}
                                                  {qualities[0] ? (
                                                    <button
                                                      type="button"
                                                      aria-label={t("library.qualities.addChipAria")}
                                                      className="inline-flex h-[18px] items-center gap-0.5 rounded-full border border-dashed border-border px-2 text-[10px] text-muted-foreground hover:border-primary/60 hover:text-foreground"
                                                      onClick={(event) => {
                                                        event.stopPropagation();
                                                        if (!selectedDetails) return;
                                                        const fileId = qualities[0]?.fileId;
                                                        if (!fileId) return;
                                                        const durationSeconds =
                                                          qualities.find((f) => f.durationSeconds != null)?.durationSeconds ?? null;
                                                        setAddQualityTarget({
                                                          mediaId: selectedDetails.id,
                                                          fileId,
                                                          existingFormats: qualities,
                                                          durationSeconds,
                                                        });
                                                      }}
                                                    >
                                                      <Plus className="h-2.5 w-2.5" />
                                                    </button>
                                                  ) : null}
                                                </div>
                                              ) : null
                                        }
                                        overview={localizedEpisodeOverview(localizedEpisodes, episode) || t("library.noOverview")}
                                        progress={(() => {
                                                if (!episodeResumesReady) {
                                                  return (
                                                    <div
                                                      className="mt-2 h-1.5 w-36 rounded-full bg-muted/50 animate-pulse"
                                                      aria-hidden="true"
                                                    />
                                                  );
                                                }
                                                if (!episodeResume) return null;
                                                // Phase 2: pass credits-aware inputs so an episode watched past
                                                // its TheIntroDB credits-start renders "Watched" even when its
                                                // pct is below the flat 95 % ceiling.
                                                const credits = episodeCreditsById.get(episode.id) ?? null;
                                                const band = getProgressBand(episodeResume.progressPct, {
                                                  positionSeconds: episodeResume.positionSeconds,
                                                  durationSeconds: episodeResume.durationSeconds ?? credits?.durationSeconds ?? null,
                                                  creditsStartSeconds: credits?.creditsStartSeconds ?? null,
                                                });
                                                if (band === "not-started") return null;
                                                return (
                                                  <MediaDetailEpisodeProgress
                                                    watched={band === "watched"}
                                                    label={
                                                      band === "watched"
                                                        ? t("library.watched")
                                                        : t("library.progress", { value: getProgressLabelPct(episodeResume.progressPct) })
                                                    }
                                                    pct={getVisibleProgressPct(episodeResume.progressPct)}
                                                  />
                                                );
                                              })()}
                                        actions={
                                            hasFile ? (
                                              <>
                                                <Button
                                                  type="button"
                                                  size="sm"
                                                  className="min-w-[7.5rem] justify-center"
                                                  title={t("library.play")}
                                                  pending={playAction.spinnerVisible}
                                                  spinnerLabel={t("player.launching")}
                                                  disabled={playAction.pending || !playablePresence.episodeHasFile.has(qualityKey)}
                                                  onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
                                                    event.stopPropagation();
                                                    void playAction.trigger(episode.id);
                                                  }}
                                                >
                                                  <PlayCircle className="mr-2 h-3 w-3" />
                                                  {t("library.play")}
                                                </Button>
                                                <Button
                                                  type="button"
                                                  size="sm"
                                                  className="min-w-[7.5rem] justify-center"
                                                  variant="secondary"
                                                  onClick={() => {
                                                    setEpisodeSubtitleDraft({ file: null, language: i18n.language || "en", label: "" });
                                                    setTrackModalEpisodeId(episode.id);
                                                  }}
                                                >
                                                  {t("library.tabs.tracks")}
                                                </Button>
                                                {(() => {
                                                  // Site 4 of the 5-site edit — icon-only per-episode
                                                  // offline button. Sits next to Play + Tracks which
                                                  // are text buttons; this one is intentionally
                                                  // compact to keep the row legible. The action label
                                                  // surfaces in a hover tooltip positioned above the
                                                  // button (matches the season-card hover pattern).
                                                  const epScope: OfflineScope = {
                                                    kind: "episode",
                                                    episodeId: episode.id,
                                                    seasonNumber: episode.seasonNumber,
                                                    episodeNumber: episode.episodeNumber,
                                                  };
                                                  const ebs = resolveButtonState(epScope, offlineCounts);
                                                  if (ebs.state === "hidden") return null;
                                                  const EpIcon = ebs.iconName === "RemoveOffline"
                                                    ? RemoveOfflineIcon
                                                    : ebs.iconName === "DownloadCloud"
                                                      ? DownloadCloud
                                                      : Download;
                                                  const isDelete = ebs.state === "delete";
                                                  const epLabel = t(ebs.labelKey, ebs.badgeCount ?? {});
                                                  return (
                                                    <div className="group/offlineEp relative inline-flex">
                                                      <Button
                                                        type="button"
                                                        size="sm"
                                                        // Both states are the same rounded-square
                                                        // button; delete uses "outline" so it reads
                                                        // as a distinct colour at a glance vs the
                                                        // filled "secondary" save button.
                                                        variant={isDelete ? "outline" : "secondary"}
                                                        data-testid={`offline-episode-button-${episode.id}`}
                                                        data-state={ebs.state}
                                                        className="h-9 w-9 p-0"
                                                        aria-label={epLabel}
                                                        title={epLabel}
                                                        disabled={offlineDeletePending}
                                                        onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
                                                          event.stopPropagation();
                                                          handleOfflineAction(epScope);
                                                        }}
                                                      >
                                                        <EpIcon className="h-4 w-4" />
                                                      </Button>
                                                      <span
                                                        role="tooltip"
                                                        className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-xs font-medium text-popover-foreground opacity-0 shadow-md transition-opacity group-hover/offlineEp:opacity-100 group-focus-within/offlineEp:opacity-100"
                                                      >
                                                        {epLabel}
                                                      </span>
                                                    </div>
                                                  );
                                                })()}
                                              </>
                                            ) : null
                                        }
                                      />
                                    );
                                  })
                            }
                          </MediaDetailEpisodeList>
                        )}
                      </div>
                    )}
                    {detailTab !== "seasons" && editMode && draft && (
                      <div className="space-y-4">
                        <div className="flex items-center justify-between">
                          <div className="text-sm font-semibold">{t("library.cast")}</div>
                          <Button type="button" size="sm" variant="secondary" onClick={addCastRow}>
                            <ListPlus className="mr-2 h-4 w-4" />
                            {t("library.edit.addCast")}
                          </Button>
                        </div>
                        {draft.cast.length === 0 ? (
                          <div className="text-sm text-muted-foreground">{t("library.noCast")}</div>
                        ) : (
                          <div className="space-y-4">
                            {draft.cast.map((member) => (
                              <div key={member.id} className="rounded-lg border border-border bg-muted/10 p-3 space-y-3">
                                <div className="flex items-center justify-between gap-2">
                                  <div className="text-sm font-semibold">{t("library.edit.castMember")}</div>
                                  <Button type="button" size="sm" variant="ghost" onClick={() => removeCastRow(member.id)}>
                                    <Trash2 className="mr-2 h-4 w-4" />
                                    {t("library.edit.removeCast")}
                                  </Button>
                                </div>
                                <div className="grid gap-3 sm:grid-cols-2">
                                  <div className="space-y-2">
                                    <Label>{t("library.edit.fields.name")}</Label>
                                    <Input
                                      value={member.name}
                                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                                        const next = draft.cast.map((entry) =>
                                          entry.id === member.id ? { ...entry, name: e.target.value } : entry
                                        );
                                        setDraft({ ...draft, cast: next });
                                      }}
                                    />
                                  </div>
                                  <div className="space-y-2">
                                    <Label>{t("library.edit.fields.role")}</Label>
                                    <Input
                                      value={member.role}
                                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                                        const next = draft.cast.map((entry) =>
                                          entry.id === member.id ? { ...entry, role: e.target.value } : entry
                                        );
                                        setDraft({ ...draft, cast: next });
                                      }}
                                    />
                                  </div>
                                </div>
                                <InlineImageField
                                  label={t("library.edit.fields.profile")}
                                  draftValue={member.profile}
                                  onChange={(next) => {
                                    const updated = draft.cast.map((entry) =>
                                      entry.id === member.id ? { ...entry, profile: next } : entry
                                    );
                                    setDraft({ ...draft, cast: updated });
                                  }}
                                  alt={member.name}
                                />
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                    {detailTab === "details" ? aboutPanel : null}
                    {detailTab === "processing" && (
                      <div className="space-y-3">
                        <Suspense fallback={null}>
                          <MediaDetailsProcessingPanel mediaId={selectedDetails.id} />
                        </Suspense>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="space-y-4">
                    {detailTabsBar}

                    {movieTab === "details" && (
                      editMode && draft ? (
                        <div className="space-y-4">
                          <div className="flex items-center justify-between">
                            <div className="text-sm font-semibold">{t("library.cast")}</div>
                            <Button type="button" size="sm" variant="secondary" onClick={addCastRow}>
                              <ListPlus className="mr-2 h-4 w-4" />
                              {t("library.edit.addCast")}
                            </Button>
                          </div>
                          {draft.cast.length === 0 ? (
                            <div className="text-sm text-muted-foreground">{t("library.noCast")}</div>
                          ) : (
                            <div className="space-y-4">
                              {draft.cast.map((member) => (
                                <div key={member.id} className="rounded-lg border border-border bg-muted/10 p-3 space-y-3">
                                  <div className="flex items-center justify-between gap-2">
                                    <div className="text-sm font-semibold">{t("library.edit.castMember")}</div>
                                    <Button type="button" size="sm" variant="ghost" onClick={() => removeCastRow(member.id)}>
                                      <Trash2 className="mr-2 h-4 w-4" />
                                      {t("library.edit.removeCast")}
                                    </Button>
                                  </div>
                                  <div className="grid gap-3 sm:grid-cols-2">
                                    <div className="space-y-2">
                                      <Label>{t("library.edit.fields.name")}</Label>
                                      <Input
                                        value={member.name}
                                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                                          const next = draft.cast.map((entry) =>
                                            entry.id === member.id ? { ...entry, name: e.target.value } : entry
                                          );
                                          setDraft({ ...draft, cast: next });
                                        }}
                                      />
                                    </div>
                                    <div className="space-y-2">
                                      <Label>{t("library.edit.fields.role")}</Label>
                                      <Input
                                        value={member.role}
                                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                                          const next = draft.cast.map((entry) =>
                                            entry.id === member.id ? { ...entry, role: e.target.value } : entry
                                          );
                                          setDraft({ ...draft, cast: next });
                                        }}
                                      />
                                    </div>
                                  </div>
                                  <InlineImageField
                                    label={t("library.edit.fields.profile")}
                                    draftValue={member.profile}
                                    onChange={(next) => {
                                      const updated = draft.cast.map((entry) =>
                                        entry.id === member.id ? { ...entry, profile: next } : entry
                                      );
                                      setDraft({ ...draft, cast: updated });
                                    }}
                                    alt={member.name}
                                  />
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ) : (
                        aboutPanel
                      )
                    )}
                    {movieTab === "versions" && (
                      <div className="space-y-6" data-testid="media-detail-versions-panel">
                          {availableMovieQualities.length > 0 ? (
                            <div className="space-y-2">
                              <div className="text-sm font-semibold">{t("library.availableQualities")}</div>
                              <div className="flex flex-wrap items-center gap-2 text-xs">
                                {availableMovieQualities.map((format) => (
                                  <span
                                    key={format.id}
                                    className="group relative inline-flex items-center rounded-full border border-border bg-muted/40 px-3 py-1 text-muted-foreground"
                                  >
                                    {format.quality}
                                    {format.isSource === true ? null : (
                                      <button
                                        type="button"
                                        aria-label={t("library.qualities.deleteChipAria", { quality: format.quality })}
                                        className="ml-1 hidden h-4 w-4 items-center justify-center rounded-full bg-destructive/15 text-destructive hover:bg-destructive/25 focus:flex group-hover:flex"
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          if (!selectedDetails) return;
                                          setDeleteFormatTarget({ format, mediaId: selectedDetails.id });
                                        }}
                                      >
                                        <X className="h-3 w-3" />
                                      </button>
                                    )}
                                  </span>
                                ))}
                                {availableMovieQualities[0] ? (
                                  <button
                                    type="button"
                                    aria-label={t("library.qualities.addChipAria")}
                                    className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-3 py-1 text-muted-foreground hover:border-primary/60 hover:text-foreground"
                                    onClick={() => {
                                      if (!selectedDetails) return;
                                      const movieFormats = availableMovieQualities;
                                      const fileId = movieFormats[0]?.fileId;
                                      if (!fileId) return;
                                      const durationSeconds =
                                        movieFormats.find((f) => f.durationSeconds != null)?.durationSeconds ?? null;
                                      setAddQualityTarget({
                                        mediaId: selectedDetails.id,
                                        fileId,
                                        existingFormats: movieFormats,
                                        durationSeconds,
                                      });
                                    }}
                                  >
                                    <Plus className="h-3 w-3" />
                                  </button>
                                ) : null}
                              </div>
                            </div>
                          ) : null}
                        {renderTracksManager(null, "audio")}
                      </div>
                    )}
                    {movieTab === "subtitles" && (
                      <div className="space-y-4" data-testid="media-detail-subtitles-panel">
                        {renderTracksManager(null, "subtitles")}
                      </div>
                    )}
                    {movieTab === "processing" && (
                      <div className="space-y-3">
                        <Suspense fallback={null}>
                          <MediaDetailsProcessingPanel mediaId={selectedDetails.id} />
                        </Suspense>
                      </div>
                    )}
                  </div>
                )}
              {editMode && showEditFloating ? (
                <div className="pointer-events-none fixed bottom-6 right-10 z-20 flex items-center gap-2">
                  <Button type="button" onClick={() => void handleSaveEdit()} disabled={savingEdit} className="pointer-events-auto shadow-lg">
                    <Save className="mr-2 h-4 w-4" />
                    {savingEdit ? t("library.edit.saving") : t("library.edit.save")}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => setEditMode(false)}
                    disabled={savingEdit}
                    className="pointer-events-auto shadow-lg"
                  >
                    <X className="mr-2 h-4 w-4" />
                    {t("library.edit.cancel")}
                  </Button>
                </div>
              ) : null}
        </MediaDetailPage>
      ) : null}

      <Suspense fallback={null}>
        <MediaDetailsActionDialogs
          restoreOpen={restoreOpen}
          onRestoreOpenChange={setRestoreOpen}
          hasCustomCast={hasCustomCast}
          restoring={restoring}
          onRestoreKeepCast={() => void handleRestore(false)}
          onRestoreFull={() => void handleRestore(true)}
          activeTrailerKey={activeTrailerKey}
          onActiveTrailerKeyChange={setActiveTrailerKey}
          buildTrailerUrl={buildTrailerUrl}
          deleteTarget={deleteTarget}
          deletingMedia={deletingMedia}
          onDeleteTargetChange={setDeleteTarget}
          onConfirmDelete={() => void confirmDelete()}
          showPlaylistPicker={showPlaylistPicker}
          onShowPlaylistPickerChange={setShowPlaylistPicker}
          playlists={playlists}
          selectedPlaylistIds={selectedDetails?.playlistIds ?? []}
          playlistLabel={playlistLabel}
          onTogglePlaylist={(playlistId) => void togglePlaylist(playlistId)}
          t={t}
        />
      </Suspense>

      <Dialog
        open={Boolean(deleteFormatTarget)}
        onOpenChange={(open) => !open && !deletingFormat && setDeleteFormatTarget(null)}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {deleteFormatTarget
                ? t("library.qualities.deleteTitle", { quality: deleteFormatTarget.format.quality })
                : ""}
            </DialogTitle>
            <DialogDescription>
              {deleteFormatTarget
                ? (() => {
                    // Prefer the exact byte count from `total_size` when ingest
                    // recorded it (post-Phase-7 manifests do); fall back to the
                    // pre-computed `size_mb` for legacy rows. Both are real
                    // numbers, never an "estimate" — drop the hedging copy.
                    const exactBytes = deleteFormatTarget.format.totalSize;
                    const bytes = exactBytes != null && exactBytes > 0
                      ? exactBytes
                      : deleteFormatTarget.format.sizeMb * ESTIMATE_MB_BYTES;
                    return bytes > 0
                      ? t("library.qualities.deleteDescription", {
                          size: mediaSizeLabel(bytes, i18n.language),
                        })
                      : t("library.qualities.deleteUnknownSize");
                  })()
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setDeleteFormatTarget(null)}
              disabled={deletingFormat}
            >
              {t("library.qualities.deleteCancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void confirmDeleteFormat()}
              disabled={deletingFormat}
            >
              {deletingFormat ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t("library.qualities.deleteConfirm")}
                </span>
              ) : (
                t("library.qualities.deleteConfirm")
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Suspense fallback={null}>
        {addQualityTarget ? (
          <AddQualityModal
            open={Boolean(addQualityTarget)}
            onOpenChange={(open) => !open && setAddQualityTarget(null)}
            mediaId={addQualityTarget.mediaId}
            fileId={addQualityTarget.fileId}
            existingFormats={addQualityTarget.existingFormats}
            durationSeconds={addQualityTarget.durationSeconds}
          />
        ) : null}
      </Suspense>

      {/* Offline confirm dialog — opens with a scope hint (movie / show /
          season / episode) and submits via the runtime's offline contracts.
          Mirrors the AddQualityModal pattern. Phase 3 of the offline-mode
          plan (Layer C item 11). */}
      <Suspense fallback={null}>
        {offlineConfirmScope && selectedDetails ? (
          <OfflineDownloadConfirmDialog
            open={Boolean(offlineConfirmScope)}
            onOpenChange={(open) => {
              if (!open) setOfflineConfirmScope(null);
            }}
            scope={offlineConfirmScope}
            details={selectedDetails}
            clientConfig={clientConfig}
            onSubmitted={() => {
              // Refresh the offline-state store so badges update once jobs
              // settle. The badges themselves reflect saved files, so the
              // truly-final update arrives via `runtime.jobs.succeeded`
              // → `media_local_downloads` insert → list_local re-fetch.
              refreshOfflineStateForMedia(selectedDetails.id);
            }}
          />
        ) : null}
      </Suspense>

      <Dialog open={Boolean(trackModalEpisodeId)} onOpenChange={(open) => !open && setTrackModalEpisodeId(null)}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-hidden">
          <DialogHeader>
            <DialogTitle>{t("library.tabs.tracks")}</DialogTitle>
            <DialogDescription>
              {activeSubtitleEpisode
                ? t("library.subtitlesDialog.subtitle", {
                    season: activeSubtitleEpisode.seasonNumber,
                    episode: activeSubtitleEpisode.episodeNumber,
                  })
                : t("library.subtitlesDialog.subtitleFallback")}
            </DialogDescription>
          </DialogHeader>
          {trackModalEpisodeId ? (
            <div className="space-y-4 overflow-hidden">{renderTracksManager(trackModalEpisodeId)}</div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setTrackModalEpisodeId(null)}>
              {t("library.close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(deleteAudioTrackTarget)}
        onOpenChange={(open) => !open && setDeleteAudioTrackTarget(null)}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("library.deleteTitle")}</DialogTitle>
            <DialogDescription>
              {deleteAudioTrackTarget
                ? t("library.tracks.deleteAudioConfirm", { label: deleteAudioTrackTarget.label })
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button type="button" variant="secondary" onClick={() => setDeleteAudioTrackTarget(null)}>
              {t("library.edit.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() =>
                deleteAudioTrackTarget
                  ? void handleRemoveAudioTrack(
                      deleteAudioTrackTarget.id,
                      deleteAudioTrackTarget.episodeId
                    )
                  : undefined
              }
            >
              {t("library.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {selectedDetails && subtitleFetchEpisodeId !== undefined ? (
        <SubtitleFetchDialog
          media={selectedDetails}
          episodeId={subtitleFetchEpisodeId}
          open
          offline={!online}
          onOpenChange={(open) => {
            if (!open) setSubtitleFetchEpisodeId(undefined);
          }}
        />
      ) : null}

      <Dialog open={movieSubtitleModalOpen} onOpenChange={setMovieSubtitleModalOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("library.subtitles.addTitle")}</DialogTitle>
            <DialogDescription>{t("library.subtitles.addSubtitleHint")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid gap-2">
              <label className="text-xs text-muted-foreground">{t("library.subtitles.fileLabel")}</label>
              <input
                type="file"
                accept=".srt,.vtt,.ass,.ssa,.sub,.sup"
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null;
                  const detectedLanguage = file ? subtitleLanguageFromName(file.name) : null;
                  setMovieSubtitleDraft((prev) => {
                    const nextLanguage = detectedLanguage ?? prev.language ?? i18n.language ?? "en";
                    return {
                      ...prev,
                      file,
                      language: nextLanguage,
                      label: file ? languageLabel(nextLanguage) : prev.label,
                    };
                  });
                }}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="movieSubtitleLang">{t("library.subtitles.languageLabel")}</Label>
              <select
                id="movieSubtitleLang"
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={movieSubtitleDraft.language}
                onChange={(event) =>
                  setMovieSubtitleDraft((prev) => ({
                    ...prev,
                    language: event.target.value,
                    label: languageLabel(event.target.value),
                  }))
                }
              >
                {sortedLanguageOptions.map((lang) => (
                  <option key={lang.code} value={lang.code}>
                    {lang.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="movieSubtitleLabel">{t("library.subtitles.labelLabel")}</Label>
              <Input
                id="movieSubtitleLabel"
                value={movieSubtitleDraft.label}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) => setMovieSubtitleDraft((prev) => ({ ...prev, label: event.target.value }))}
                placeholder={t("library.subtitles.labelPlaceholder")}
              />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button type="button" variant="secondary" onClick={() => setMovieSubtitleModalOpen(false)}>
              {t("library.edit.cancel")}
            </Button>
            <Button
              type="button"
              onClick={() => {
                void handleAddSubtitle(selectedDetails?.id ?? "", null, movieSubtitleDraft, setMovieSubtitleDraft);
                setMovieSubtitleModalOpen(false);
              }}
              disabled={!movieSubtitleDraft.file}
            >
              {t("library.subtitles.addButton")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={episodeSubtitleModalOpen} onOpenChange={setEpisodeSubtitleModalOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("library.subtitles.addTitle")}</DialogTitle>
            <DialogDescription>{t("library.subtitles.addSubtitleHint")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid gap-2">
              <label className="text-xs text-muted-foreground">{t("library.subtitles.fileLabel")}</label>
              <input
                type="file"
                accept=".srt,.vtt,.ass,.ssa,.sub,.sup"
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null;
                  const detectedLanguage = file ? subtitleLanguageFromName(file.name) : null;
                  setEpisodeSubtitleDraft((prev) => {
                    const nextLanguage = detectedLanguage ?? prev.language ?? i18n.language ?? "en";
                    return {
                      ...prev,
                      file,
                      language: nextLanguage,
                      label: file ? languageLabel(nextLanguage) : prev.label,
                    };
                  });
                }}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="episodeSubtitleLang">{t("library.subtitles.languageLabel")}</Label>
              <select
                id="episodeSubtitleLang"
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={episodeSubtitleDraft.language}
                onChange={(event) =>
                  setEpisodeSubtitleDraft((prev) => ({
                    ...prev,
                    language: event.target.value,
                    label: languageLabel(event.target.value),
                  }))
                }
              >
                {sortedLanguageOptions.map((lang) => (
                  <option key={lang.code} value={lang.code}>
                    {lang.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="episodeSubtitleLabel">{t("library.subtitles.labelLabel")}</Label>
              <Input
                id="episodeSubtitleLabel"
                value={episodeSubtitleDraft.label}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) => setEpisodeSubtitleDraft((prev) => ({ ...prev, label: event.target.value }))}
                placeholder={t("library.subtitles.labelPlaceholder")}
              />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button type="button" variant="secondary" onClick={() => setEpisodeSubtitleModalOpen(false)}>
              {t("library.edit.cancel")}
            </Button>
            <Button
              type="button"
              onClick={() => {
                void handleAddSubtitle(
                  selectedDetails?.id ?? "",
                  trackModalEpisodeId,
                  episodeSubtitleDraft,
                  setEpisodeSubtitleDraft
                );
                setEpisodeSubtitleModalOpen(false);
              }}
              disabled={!episodeSubtitleDraft.file}
            >
              {t("library.subtitles.addButton")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {playbackMedia ? (
        // UX-CRASH-01: a player crash shows a notice, not a dark window.
        <RenderBoundary name="player-overlay" variant="overlay">
        <Suspense fallback={null}>
          <MediaPlaybackController
            // STABLE position-based instance — no requestId in the key.
            //
            // The earlier `key={mediaId:requestId}` (5181c00f) caused a
            // mount storm: every transient re-render of MediaDetailsDialog
            // that changed `selectedDetails` (e.g. background library sync
            // re-runs the effect at line 451 with `setSelectedDetails(
            // getMediaDetails(...))` returning a new object reference)
            // combined with the requestId-keyed reconciler key produced 8
            // controller remounts in 72 ms per Play click. Each remount
            // disposed the just-launched mpv and re-entered the LAUNCH
            // branch (see useMpvPlaybackEngine: loadStream/branch chosen
            // logs), with `lifecycleRef.current` bouncing back to "idle"
            // mid-loop, tripping the `signalPlaybackReady` gate's bail
            // predicate. User saw "plays 3 times before stabilizing" + the
            // Electron window not hiding behind mpv.
            //
            // The default-track-change-on-replay behavior the keyed
            // remount used to deliver is now handled inside
            // MediaPlaybackController via a requestId useEffect that
            // resets the engine's selectedAudioId / selectedSubtitleId so
            // resolvePlayback*State falls through to the current default.
            //
            // @bugfix dialog-default-track-change-ignored
            // @bugfix mpv-launch-loop-from-controller-mount-storm
            // @regression-proof
            media={playbackMedia}
            episodeId={playbackEpisodeId}
            requestId={playbackRequestId}
          />
        </Suspense>
        </RenderBoundary>
      ) : null}
    </>
  );
}
