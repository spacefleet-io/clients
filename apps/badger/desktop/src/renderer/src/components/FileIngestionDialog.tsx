import { Fragment, Suspense, lazy, useCallback, useEffect, useState, useMemo, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  Button,
  Input,
  toast,
  ImportReviewActions,
  ImportReviewBody,
  ImportReviewDetail,
  ImportReviewItem,
  ImportReviewItems,
  ImportReviewMatchHeader,
  ImportReviewNoMatch,
  ImportReviewSearching,
  ImportReviewMatchResult,
  ImportReviewMatchSearch,
  ImportReviewDialog,
  ImportReviewPicker,
  ImportReviewFooter,
  ImportReviewList,
  ImportReviewSummary,
} from "@space/ui";
import { Loader2, Clock, Check, AlertCircle, Film, Tv, X, Upload, Plus, Play, Square, Shuffle, Eye, Pencil } from "lucide-react";
import { guessQualityLabel, qualityRank, type LabQueueAction } from "@/lib/labJobs";
import { useAuth } from "@/auth";
import { useClientConfig } from "@/lib/useClientConfig";
import { useDeviceFallbackCopy } from "@/lib/deviceTranscode";
import { applyFallbackCopyToOutputs } from "../../../shared/transcodeDefault";
import { getTitleDetailsForLibrary, getTitleTrailersForLanguages, localizeSearchResultForLibrary, searchTitles } from "@/lib/metadata";
import { withMetadataRetry, withMetadataTimeout } from "@/lib/metadataRetry";
import { parseFilename } from "@/lib/parseMediaFilename";
import { searchFailureText } from "@/lib/metadataSearchError";
import { onMetadataTicketsAvailable } from "@/lib/metadataTickets";
import ImportCandidateImage from "@/components/ImportCandidateImage";
import { TitleSearchResult, Trailer, getAccountStorage, getMetadataSkipMarkers } from "@/api";
import {
  EXTERNAL_SKIP_MARKER_SHOW_KIND,
  type ExternalSkipMarkerCoverageEntry,
  type ShowSkipMarker,
  type ShowSkipCachePayload,
  createShowSkipCachePayload,
  parseShowSkipCachePayload,
  SKIP_MARKER_PROVIDER,
  showEpisodeKey,
} from "../../../shared/skipMarkerCache";
import { rendererLogger } from "@/logger";
import { notify, notifySuccess } from "@/lib/notify";
import type { AccountStorageSummary } from "@space/shared/api";
import { estimateImportItemBytes, estimatePendingLocalBytes, evaluateImportQuota, storageWarningLevel } from "@/lib/importQuota";
import { loadBillingPeriod } from "@space/shared/storagePlans";
import { sidecarSubtitleFileId } from "@space/shared/libraryTypes";
import { fileUriPath } from "@space/desktop-shell/window-drop";
import { getSnapshot as getRuntimeJobsSnapshot } from "@/lib/runtimeJobsStore";
import type { QuotaDialogItem } from "@/components/FileIngestionQuotaDialog";

const subtitleDetectLog = rendererLogger.child({ scope: "subtitle-detect" });
const subtitleSampleLog = rendererLogger.child({ scope: "subtitle-sample-ui" });
const ingestLog = rendererLogger.child({ scope: "ingest" });
import { useLibraryActions, useLibraryData } from "@/lib/libraryContext";
import type { MediaRow } from "@/lib/libraryDb";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { isMediaLanguage } from "@/lib/languages";
import { formatMediaLanguageLabelForUi, sortedMediaLanguageOptionsForUi } from "@space/shared/mediaLanguageDisplay";
import {
  buildSelectedVideoVariants,
  buildTrackSummary,
  isUndefinedLikeTrackLabel,
  normalizeFileIngestionLanguageCode,
  pickPreferredCodec,
  resolveFileIngestionTrackSelection,
  type FileIngestionTrackKey as TrackKey,
  type FileIngestionTrackSelection,
} from "@/components/fileIngestionTracks";
import {
  buildFileIngestionMergedGroups,
  isLookupInProgress,
  buildFileIngestionTvSeasonState,
  type FileIngestionEpisodeGroup,
  type FileIngestionMergedGroup,
} from "@/components/fileIngestionGroups";
import {
  buildFileIngestionVideoDecisionItems,
  countFileIngestionAutoIgnoredVideoOverlaps,
  type FileIngestionVideoDecisionItem,
} from "@/components/fileIngestionDecisions";
import {
  buildFileIngestionActiveInputGroups,
  buildFileIngestionTrackOverrideMaps,
  buildFileIngestionUndefinedTrackRows,
  type FileIngestionUndefinedTrackDecision as UndefinedTrackDecision,
  type FileIngestionUndefinedTrackRow as UndefinedTrackRow,
} from "@/components/fileIngestionInputs";
import {
  detectSubtitleLanguage,
  detectSubtitleLanguageFromSamples,
} from "@space/ingest-core/subtitleLanguageDetection";
import type { LabQueueFileInput } from "../../../shared/labQueueShared";
import { translateActionsToV2Sources, type V2SubmitSource } from "@/components/fileIngestionV2Translate";
import {
  existingMediaPlacementId,
  pickSubtitleBindFilename,
  placementIdsBySourceFilename,
} from "@/components/fileIngestionSubtitlePlacement";
import type { BadgerIngestShowSkipCache } from "@space/runtime-contracts/badger/ingest";

type FileIngestionDialogProps = {
  paths: string[];
  pathsNonce: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

type Candidate = {
  id: string;
  path: string;
  name: string;
  size: number;
  kind: "video" | "subtitle";
  parsed: ReturnType<typeof parseFilename>;
  match: TitleSearchResult | null;
  probe?: {
    video: { codec: string | null; width: number | null; height: number | null } | null;
    audio: { count: number; languages: string[] };
    subtitles: { count: number; languages: string[] };
    chapters: { count: number };
    durationSeconds: number | null;
    audioTracks: Array<{ index: number; language: string; label: string; codec: string | null; channels: number | null }>;
    subtitleTracks: Array<{ index: number; language: string; label: string; codec: string | null }>;
  } | null;
  probeError?: string;
  status: "pending" | "scanning" | "searching" | "ready" | "error";
  error?: string;
  /** Translated hint under `error` when the automatic search failed (it differs from the no-match hint). */
  errorHint?: string;
  /** The automatic search failed because title search was unavailable (no ticket, service busy): asked again when tickets arrive. */
  searchUnavailable?: boolean;
  manualQuery?: string;
  selected?: boolean;
  subtitleDraft?: { language: string; label: string };
  skipMarkerData?: {
    showCatalogId: number;
    coverage: ExternalSkipMarkerCoverageEntry[];
    markersByEpisode: Record<string, ShowSkipMarker[]>;
    status: "fetching" | "ready" | "unavailable";
    cacheHit: boolean;
    fetchedAt: string;
  } | null;
};

type EpisodeGroup = FileIngestionEpisodeGroup<
  Candidate,
  {
    audioTracks: Array<TrackKey & { refs: Array<{ candidateId: string; index: number }> }>;
    subtitleTracks: Array<TrackKey & { refs: Array<{ candidateId: string; index: number }> }>;
    videoVariants: Array<{
      candidate: Candidate;
      quality: string;
      codec: string;
      hasChapters: boolean;
    }>;
  }
>;

type MergedGroup = FileIngestionMergedGroup<
  Candidate,
  TitleSearchResult,
  {
    audioTracks: Array<TrackKey & { refs: Array<{ candidateId: string; index: number }> }>;
    subtitleTracks: Array<TrackKey & { refs: Array<{ candidateId: string; index: number }> }>;
    videoVariants: Array<{
      candidate: Candidate;
      quality: string;
      codec: string;
      hasChapters: boolean;
    }>;
  }
>;


type VideoDecision = "add" | "skip";

type E2eSeedCandidate = {
  id?: string;
  path?: string;
  name: string;
  size?: number;
  kind?: "video" | "subtitle";
  parsed?: ReturnType<typeof parseFilename>;
  match?: TitleSearchResult | null;
  probe?: Candidate["probe"];
  probeError?: string;
  status?: Candidate["status"];
  error?: string;
  errorHint?: string;
  searchUnavailable?: boolean;
  manualQuery?: string;
  subtitleDraft?: { language: string; label: string };
};

const FileIngestionResolveVideoDialog = lazy(() => import("@/components/FileIngestionResolveVideoDialog"));
const FileIngestionDummyDialog = lazy(() => import("@/components/FileIngestionDummyDialog"));
const FileIngestionTrailerDialogs = lazy(() => import("@/components/FileIngestionTrailerDialogs"));
const FileIngestionQuotaDialog = lazy(() => import("@/components/FileIngestionQuotaDialog"));

export default function FileIngestionDialog({ paths: initialPaths, pathsNonce, open, onOpenChange }: FileIngestionDialogProps) {
  const { t, i18n } = useTranslation();
  const { token, user } = useAuth();
  const clientConfig = useClientConfig();
  // #25: the fallback 360p copy follows THIS computer's value, not the account
  // ladder, so the preview matches what main submits (main enforces it too).
  const { value: deviceFallbackCopy } = useDeviceFallbackCopy("ingest-dialog");
  const ingestOutputs = useMemo(
    () =>
      typeof deviceFallbackCopy === "boolean"
        ? applyFallbackCopyToOutputs(clientConfig.transcodeOutputs ?? [], deviceFallbackCopy)
        : clientConfig.transcodeOutputs ?? [],
    [clientConfig.transcodeOutputs, deviceFallbackCopy],
  );
  const { media } = useLibraryData();
  const {
    getMediaDetails,
    fetchMediaDetails,
    getSharedSetting,
    addMediaFromCatalog,
    addSubtitleTrackWithObject,
    listSkipAnalysis,
    upsertSkipAnalysis,
  } = useLibraryActions();
  const navigate = useNavigate();

  // ACCT-PROF-03: a match is shown and stored with its title, poster and backdrop in the account's language
  // (UX-I18N-07), which the interface language follows.
  const accountLanguage = i18n.language || "en";

  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [scanning, setScanning] = useState(false);
  const [adding, setAdding] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState<number>(0);
  const [manualSearchQuery, setManualSearchQuery] = useState("");
  const [manualSearchResults, setManualSearchResults] = useState<TitleSearchResult[]>([]);
  const [searchingManual, setSearchingManual] = useState(false);
  const [manualSearchType, setManualSearchType] = useState<"movie" | "tv">("movie");
  const [manualSearchPage, setManualSearchPage] = useState(1);
  const [manualSearchTotalPages, setManualSearchTotalPages] = useState(1);
  const [manualSearchLoadingMore, setManualSearchLoadingMore] = useState(false);
  const [manualSearchOpen, setManualSearchOpen] = useState(false);
  const [pendingFocusGroupKey, setPendingFocusGroupKey] = useState<string | null>(null);
  const [trailerCache, setTrailerCache] = useState<Record<string, { status: "idle" | "loading" | "ready" | "empty" | "error"; trailers: Trailer[] }>>({});
  const [openTrailerId, setOpenTrailerId] = useState<string | null>(null);
  const [activeTrailerKey, setActiveTrailerKey] = useState<string | null>(null);
  const [isDraggingLocal, setIsDraggingLocal] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [videoDecisions, setVideoDecisions] = useState<Record<string, VideoDecision>>({});
  const [resolveModalOpen, setResolveModalOpen] = useState(false);
  const [resolveIndex, setResolveIndex] = useState(0);
  const [showAddBlocker, setShowAddBlocker] = useState(false);
  const [dummyIngestOpen, setDummyIngestOpen] = useState(false);
  const [dummyIngestQuery, setDummyIngestQuery] = useState("");
  const [dummyIngestResults, setDummyIngestResults] = useState<TitleSearchResult[]>([]);
  const [dummyIngestLoading, setDummyIngestLoading] = useState(false);
  const [dummyIngestError, setDummyIngestError] = useState<string | null>(null);
  const [dummyIngestType, setDummyIngestType] = useState<"movie" | "tv">("movie");
  const [dummyIngestRunning, setDummyIngestRunning] = useState(false);
  const [inputResolveModalOpen, setInputResolveModalOpen] = useState(false);
  const [inputResolveIndex, setInputResolveIndex] = useState(0);
  const [undefinedTrackDecisions, setUndefinedTrackDecisions] = useState<Record<string, UndefinedTrackDecision>>({});
  const [customNameEditingRows, setCustomNameEditingRows] = useState<Set<string>>(() => new Set());
  const [ignoreUndefinedByKind, setIgnoreUndefinedByKind] = useState<{ audio: boolean; subtitle: boolean }>({
    audio: false,
    subtitle: false,
  });
  const [audioSampleCache, setAudioSampleCache] = useState<Record<string, string>>({});
  const [audioSampleLoadingId, setAudioSampleLoadingId] = useState<string | null>(null);
  const [audioPlayingId, setAudioPlayingId] = useState<string | null>(null);
  const [subtitleSampleCache, setSubtitleSampleCache] = useState<
    Record<string, { kind: "text" | "image" | "message"; value: string }>
  >({});
  const [subtitleSampleLoadingId, setSubtitleSampleLoadingId] = useState<string | null>(null);
  const [subtitleSampleModalRowId, setSubtitleSampleModalRowId] = useState<string | null>(null);
  const [subtitleImagePreviewSrc, setSubtitleImagePreviewSrc] = useState<string | null>(null);
  const [storageWarning, setStorageWarning] = useState<"ok" | "warning" | "blocked">("ok");
  // INGS-QUOTA-01/02: the whole summary, so Add can check the import fits before submitting.
  const [storageSummary, setStorageSummary] = useState<AccountStorageSummary | null>(null);
  // The upsell window raised by Add; null when no gate is open.
  const [quotaGate, setQuotaGate] = useState<{ items: QuotaDialogItem[]; pendingLocalBytes: number } | null>(null);
  const audioPlaybackRef = useRef<{ id: string | null; audio: HTMLAudioElement | null }>({ id: null, audio: null });
  const resetTimeoutRef = useRef<number | null>(null);
  const mediaRef = useRef(media);
  const skipDataFetchRef = useRef<Map<number, Promise<Candidate["skipMarkerData"]>>>(new Map());
  // Per show: what this dialog session already fetched (markers + hit/miss
  // coverage) and every episode key already queued (incl. failures, so a
  // failed episode is not retried in a loop). A show that is not in the
  // library yet has no persisted cache, so without this a second pass would
  // refetch every episode the first pass already got.
  const skipSessionRef = useRef<
    Map<
      number,
      {
        attempted: Set<string>;
        coverage: ExternalSkipMarkerCoverageEntry[];
        markersByEpisode: Record<string, ShowSkipMarker[]>;
        fetchedAt: string | null;
      }
    >
  >(new Map());
  // Shows that gained an unfetched episode while their fetch was in flight;
  // the in-flight pass re-runs once it settles (PLAY-NEXT-02).
  const skipRepassRef = useRef<Set<number>>(new Set());
  const candidatesRef = useRef<Candidate[]>([]);

  useEffect(() => {
    mediaRef.current = media;
  }, [media]);

  // Signal that the dialog has finished its first mount so the drop overlay
  // (in AuthenticatedRoutes) knows it can stop showing "identifying...". The
  // dialog is lazy-loaded with a null Suspense fallback, so on slow machines
  // there is a measurable gap between the drop and the dialog appearing —
  // the drop overlay listens for this event to bridge that gap.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("sf:ingestion-dialog-ready"));
  }, []);

  // Fetch storage quota status when dialog opens
  useEffect(() => {
    if (!open || !token) return;
    getAccountStorage(token)
      .then((storage) => {
        setStorageSummary(storage);
        setStorageWarning(storageWarningLevel(storage));
      })
      .catch((err) => {
        ingestLog.warn({ error: err instanceof Error ? err.message : String(err) }, "import-quota.storage-fetch-failed");
      });
  }, [open, token]);

  // Keep candidatesRef in sync so resolveShowSkipData can enumerate
  // episodes-for-this-show without re-creating the callback on every render.
  useEffect(() => {
    candidatesRef.current = candidates;
  }, [candidates]);

  const applySkipDataToShow = useCallback(
    (showCatalogId: number, data: Candidate["skipMarkerData"]) => {
      setCandidates((prev) =>
        prev.map((c) =>
          c.match?.type === "tv" && c.match.id === showCatalogId ? { ...c, skipMarkerData: data } : c
        )
      );
    },
    []
  );

  const resolveShowSkipData = useCallback(
    (requestedShowCatalogId: number): Promise<Candidate["skipMarkerData"]> => {
    const run = (showCatalogId: number): Promise<Candidate["skipMarkerData"]> => {
      const existing = skipDataFetchRef.current.get(showCatalogId);
      if (existing) {
        // A fetch for this show is in flight and enumerated the candidates
        // before this call's episode was matched: re-run once it settles so
        // that episode is fetched too.
        skipRepassRef.current.add(showCatalogId);
        // eslint-disable-next-line no-console -- intentional [skip-markers] diagnostic (keep-diagnostic-logs)
        console.info("[skip-markers] fetch in flight, re-pass queued", { showCatalogId });
        return existing;
      }
      let session = skipSessionRef.current.get(showCatalogId);
      if (!session) {
        session = { attempted: new Set(), coverage: [], markersByEpisode: {}, fetchedAt: null };
        skipSessionRef.current.set(showCatalogId, session);
      }
      const sessionData = session;

      const promise = (async (): Promise<Candidate["skipMarkerData"]> => {
        // eslint-disable-next-line no-console -- intentional [skip-markers] diagnostic (keep-diagnostic-logs)
        console.info("[skip-markers] resolveShowSkipData start", { showCatalogId });
        applySkipDataToShow(showCatalogId, {
          showCatalogId,
          coverage: [],
          markersByEpisode: {},
          status: "fetching",
          cacheHit: false,
          fetchedAt: new Date().toISOString(),
        });

        // 1) Load existing cache if the show is already in the local library.
        const showMedia = mediaRef.current?.find(
          (item) => item.type === "tv" && Number(item.catalogId) === showCatalogId
        );
        let cached: ShowSkipCachePayload | null = null;
        if (showMedia) {
          try {
            const rows = await listSkipAnalysis(showMedia.id, EXTERNAL_SKIP_MARKER_SHOW_KIND);
            const fresh = rows
              .map((row) => ({ updatedAt: row.updatedAt, payload: parseShowSkipCachePayload(row.payload) }))
              .filter((row) => row.payload !== null)
              .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))[0];
            if (fresh?.payload) {
              const cacheAgeMs = Date.now() - new Date(fresh.payload.fetchedAt).getTime();
              if (cacheAgeMs < 30 * 24 * 60 * 60 * 1000) {
                cached = fresh.payload;
              }
            }
          } catch {
            // proceed with cached = null
          }
        }
        // Fold in what earlier passes of this dialog session fetched: a show
        // not in the library yet has no persisted cache to remember them.
        if (sessionData.coverage.length > 0) {
          const sessionKeys = new Set(
            sessionData.coverage.map((c) => showEpisodeKey(c.seasonNumber, c.episodeNumber)),
          );
          cached = createShowSkipCachePayload({
            showCatalogId,
            fetchedAt: sessionData.fetchedAt ?? cached?.fetchedAt ?? new Date().toISOString(),
            coverage: [
              ...(cached?.coverage ?? []).filter(
                (c) => !sessionKeys.has(showEpisodeKey(c.seasonNumber, c.episodeNumber)),
              ),
              ...sessionData.coverage,
            ],
            markersByEpisode: { ...(cached?.markersByEpisode ?? {}), ...sessionData.markersByEpisode },
          });
        }

        // 2) Enumerate episodes to consider — the union of (a) episodes already
        // recorded in the cache and (b) episodes currently in the modal's
        // candidates for this show. Any episode not in the cache becomes a
        // fetch target.
        const attemptedKeys = new Set<string>([
          ...Object.keys(cached?.markersByEpisode ?? {}),
          ...(cached?.coverage ?? []).map((c) => showEpisodeKey(c.seasonNumber, c.episodeNumber)),
        ]);
        const seen = new Set<string>([...attemptedKeys, ...sessionData.attempted]);
        for (const key of attemptedKeys) sessionData.attempted.add(key);
        type FetchTarget = { season: number; episode: number; durationSeconds: number | null };
        const toFetch: FetchTarget[] = [];
        const candidateDebug: Array<{ name: string; matchType?: string; matchId?: number; season: unknown; episode: unknown; skipped?: string }> = [];
        for (const c of candidatesRef.current) {
          if (c.kind !== "video") {
            candidateDebug.push({ name: c.name, skipped: "not video", season: c.parsed?.season, episode: c.parsed?.episode });
            continue;
          }
          if (c.match?.type !== "tv") {
            candidateDebug.push({ name: c.name, matchType: c.match?.type, skipped: "not tv match", season: c.parsed?.season, episode: c.parsed?.episode });
            continue;
          }
          if (c.match.id !== showCatalogId) {
            candidateDebug.push({ name: c.name, matchId: c.match.id, skipped: "different show", season: c.parsed?.season, episode: c.parsed?.episode });
            continue;
          }
          const season = typeof c.parsed?.season === "number" ? c.parsed.season : null;
          const episode = typeof c.parsed?.episode === "number" ? c.parsed.episode : null;
          if (season === null || episode === null) {
            candidateDebug.push({ name: c.name, matchId: c.match.id, season: c.parsed?.season, episode: c.parsed?.episode, skipped: "no season/episode parsed" });
            continue;
          }
          const key = showEpisodeKey(season, episode);
          if (seen.has(key)) {
            candidateDebug.push({ name: c.name, matchId: c.match.id, season, episode, skipped: "already cached or queued" });
            continue;
          }
          seen.add(key);
          sessionData.attempted.add(key);
          toFetch.push({ season, episode, durationSeconds: c.probe?.durationSeconds ?? null });
          candidateDebug.push({ name: c.name, matchId: c.match.id, season, episode });
        }
        // eslint-disable-next-line no-console -- intentional [skip-markers] diagnostic
        console.info("[skip-markers] candidates inspected", {
          showCatalogId,
          totalCandidates: candidatesRef.current.length,
          toFetchCount: toFetch.length,
          alreadyCachedCount: attemptedKeys.size,
          candidates: candidateDebug,
        });

        // 3) Fetch markers for any new episodes via the metadata service.
        const newMarkers: Record<string, ShowSkipMarker[]> = {};
        const newCoverage: ExternalSkipMarkerCoverageEntry[] = [];
        for (const target of toFetch) {
          try {
            // eslint-disable-next-line no-console -- intentional [skip-markers] diagnostic
            console.info("[skip-markers] fetching", {
              showCatalogId,
              season: target.season,
              episode: target.episode,
              durationSeconds: target.durationSeconds,
            });
            const result = await getMetadataSkipMarkers(
              token ?? "",
              "tv",
              showCatalogId,
              target.season,
              target.episode,
              target.durationSeconds,
            );
            // eslint-disable-next-line no-console -- intentional [skip-markers] diagnostic
            console.info("[skip-markers] response", {
              showCatalogId,
              season: target.season,
              episode: target.episode,
              markerCount: result?.markers?.length ?? 0,
              coverageCount: result?.coverage?.length ?? 0,
            });
            const markers: ShowSkipMarker[] = (result?.markers ?? [])
              .filter((m) => m.endSeconds != null)
              .map((m) => ({
                type: m.type,
                startSeconds: m.startSeconds,
                endSeconds: m.endSeconds as number,
                source: m.source,
                confidence: m.confidence,
              }));
            const key = showEpisodeKey(target.season, target.episode);
            if (markers.length > 0) {
              newMarkers[key] = markers;
              newCoverage.push({
                seasonNumber: target.season,
                episodeNumber: target.episode,
                status: "hit",
                markerTypes: [...new Set(markers.map((m) => m.type))].sort() as Array<"intro" | "credits">,
              });
            } else {
              newCoverage.push({
                seasonNumber: target.season,
                episodeNumber: target.episode,
                status: "miss",
              });
            }
          } catch (err) {
            // individual episode failure stays out of the cache so a future
            // resolve attempt can retry it.
            // eslint-disable-next-line no-console -- intentional [skip-markers] diagnostic
            console.error("[skip-markers] fetch failed", {
              showCatalogId,
              season: target.season,
              episode: target.episode,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // 4) Merge cache + new fetches.
        const mergedMarkers = { ...(cached?.markersByEpisode ?? {}), ...newMarkers };
        const fetchedKeys = new Set(
          newCoverage.map((c) => showEpisodeKey(c.seasonNumber, c.episodeNumber)),
        );
        const mergedCoverage = [
          ...(cached?.coverage ?? []).filter(
            (c) => !fetchedKeys.has(showEpisodeKey(c.seasonNumber, c.episodeNumber)),
          ),
          ...newCoverage,
        ];
        const fetchedAt = toFetch.length > 0
          ? new Date().toISOString()
          : cached?.fetchedAt ?? new Date().toISOString();
        if (newCoverage.length > 0) {
          sessionData.coverage = mergedCoverage;
          sessionData.markersByEpisode = mergedMarkers;
          sessionData.fetchedAt = fetchedAt;
        }

        // 5) Persist the merged cache when the show has a local media row and
        // we actually fetched something new (avoids touching the row on
        // pure cache hits).
        if (showMedia && toFetch.length > 0) {
          try {
            const payload = createShowSkipCachePayload({
              showCatalogId,
              fetchedAt,
              coverage: mergedCoverage,
              markersByEpisode: mergedMarkers,
            });
            await upsertSkipAnalysis(showMedia.id, null, EXTERNAL_SKIP_MARKER_SHOW_KIND, payload);
          } catch {
            // cache write failure is non-fatal — the in-memory result still drives the UI
          }
        }

        // 6) Decide modal display status.
        const hasAny = Object.keys(mergedMarkers).length > 0;
        const data: Candidate["skipMarkerData"] = {
          showCatalogId,
          coverage: mergedCoverage,
          markersByEpisode: mergedMarkers,
          status: hasAny ? "ready" : "unavailable",
          cacheHit: cached !== null && toFetch.length === 0,
          fetchedAt,
        };
        applySkipDataToShow(showCatalogId, data);
        return data;
      })();

      skipDataFetchRef.current.set(showCatalogId, promise);
      // Clear the dedupe slot once this fetch completes so future calls for
      // the same show (e.g., after the user adds another episode) re-run and
      // pick up newly-needed episodes from candidatesRef. A call that arrived
      // while this fetch was in flight re-runs it now.
      void promise.finally(() => {
        if (skipDataFetchRef.current.get(showCatalogId) === promise) {
          skipDataFetchRef.current.delete(showCatalogId);
        }
        if (skipRepassRef.current.delete(showCatalogId)) {
          // eslint-disable-next-line no-console -- intentional [skip-markers] diagnostic
          console.info("[skip-markers] running queued re-pass", { showCatalogId });
          void run(showCatalogId);
        }
      });
      return promise;
    };
    return run(requestedShowCatalogId);
    },
    [applySkipDataToShow, listSkipAnalysis, token, upsertSkipAnalysis],
  );

  // Fetch markers for every matched episode once React has committed the
  // match (PLAY-NEXT-02). Calling the resolver straight after setCandidates
  // read candidatesRef before the new match landed, so only the first few
  // episodes of a drop were ever fetched. Runs after the candidatesRef sync
  // effect above, so the resolver enumerates the committed candidates.
  useEffect(() => {
    const needs = new Map<number, string[]>();
    for (const c of candidates) {
      if (c.kind !== "video" || c.match?.type !== "tv" || !c.match.id) continue;
      const showCatalogId = c.match.id;
      const season = typeof c.parsed?.season === "number" ? c.parsed.season : null;
      const episode = typeof c.parsed?.episode === "number" ? c.parsed.episode : null;
      const attempted = skipSessionRef.current.get(showCatalogId)?.attempted;
      const key = season !== null && episode !== null ? showEpisodeKey(season, episode) : null;
      const unfetched = key !== null && !attempted?.has(key);
      const notApplied = c.skipMarkerData?.showCatalogId !== showCatalogId;
      if (!unfetched && !notApplied) continue;
      const reasons = needs.get(showCatalogId) ?? [];
      reasons.push(`${key ?? c.name}:${unfetched ? "unfetched" : "not-applied"}`);
      needs.set(showCatalogId, reasons);
    }
    for (const [showCatalogId, reasons] of needs) {
      // eslint-disable-next-line no-console -- intentional [skip-markers] diagnostic
      console.info("[skip-markers] episodes need markers", { showCatalogId, reasons });
      void resolveShowSkipData(showCatalogId);
    }
  }, [candidates, resolveShowSkipData]);

  const showQueuedConfirmation = (types: Set<"movie" | "tv">, count: number) => {
    const baseMessage =
      count === 1 ? t("ingestion.toasts.queuedSingle") : t("ingestion.toasts.queuedMany", { count });

    if (types.size !== 1) {
      notify({
        title: t("ingestion.toasts.queuedTitle"),
        message: baseMessage,
        level: "success",
        toastOptions: {
          action: {
            label: t("ingestion.toasts.openLibrary"),
            onClick: () => navigate("/media-library"),
          },
        },
      });
      return;
    }

    const only = Array.from(types)[0];
    notify({
      title: t("ingestion.toasts.queuedTitle"),
      message: baseMessage,
      level: "success",
      toastOptions: {
        action: {
          label: only === "tv" ? t("ingestion.toasts.viewTv") : t("ingestion.toasts.viewMovies"),
          onClick: () => navigate(`/media-library?tab=${only}`),
        },
      },
    });
  };

  const closeIngestionDialog = () => {
    window.dispatchEvent(new CustomEvent("sf:ingestion-closed"));
    onOpenChange(false);
  };

  const handleDialogOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      window.dispatchEvent(new CustomEvent("sf:ingestion-closed"));
    }
    onOpenChange(nextOpen);
  };

  const waitForQueuedTitlesVisible = async (
    catalogKeys: Set<string>,
    timeoutMs = 2200,
    mode: "any" | "all" = "any"
  ) => {
    if (catalogKeys.size === 0) return;
    const start = Date.now();
    const hasReady = () => {
      const current = mediaRef.current;
      if (!current || current.length === 0) return false;
      const found = new Set(
        current
          .filter((item) => Number.isFinite(Number(item.catalogId)))
          .map((item) => `${item.type}:${Number(item.catalogId)}`)
      );
      if (mode === "all") {
        return Array.from(catalogKeys).every((key) => found.has(key));
      }
      return Array.from(catalogKeys).some((key) => found.has(key));
    };
    if (hasReady()) return;
    while (Date.now() - start < timeoutMs) {
      await new Promise((resolve) => window.setTimeout(resolve, 120));
      if (hasReady()) return;
    }
  };

  const selectedCandidate = candidates[selectedIndex] ?? null;
  const undefinedLanguageLabel = t("ingestion.ui.undefined");
  const hasNativeFs = Boolean(window.sf?.scanFiles && window.sf?.openFileDialog);
  // Dummy-ingest dev tool was removed alongside the legacy main-process
  // labQueue plumbing (Day 1A). Keep the local UI state shape intact to
  // minimise churn but always gate the entry point off.
  const showDummyIngest = false;
  const subtitleDetectDebug =
    typeof window !== "undefined" &&
    (import.meta.env.DEV || window.localStorage.getItem("sf.debug.subtitleDetection") === "1");
  const logSubtitleDetect = useCallback(
    (event: string, payload: Record<string, unknown>) => {
      if (!subtitleDetectDebug) return;
      subtitleDetectLog.debug({ ...payload }, event);
    },
    [subtitleDetectDebug]
  );

  const normalizeMatchTitle = (value?: string | null) => (value ?? "").trim().toLowerCase();
  const candidateFingerprint = (candidate: Candidate) => {
    const title = normalizeMatchTitle(candidate.parsed?.title);
    if (!title) return null;
    const year = candidate.parsed?.year ? String(candidate.parsed.year) : "";
    return `${title}:${year}`;
  };

  const normalizeLanguageCode = useCallback((raw?: string | null) => {
    const normalized = normalizeFileIngestionLanguageCode(raw);
    return normalized.length === 2 && isMediaLanguage(normalized) ? normalized : "und";
  }, []);

  const languageLabel = useCallback((code?: string | null) => {
    const normalized = normalizeLanguageCode(code);
    return formatMediaLanguageLabelForUi(normalized, i18n.language || "en", undefinedLanguageLabel);
  }, [i18n.language, normalizeLanguageCode, undefinedLanguageLabel]);

  const sortedLanguageOptions = useMemo(
    () => sortedMediaLanguageOptionsForUi(i18n.language || "en", undefinedLanguageLabel).filter((lang) => lang.code !== "und"),
    [i18n.language, undefinedLanguageLabel]
  );

  useEffect(() => {
    // Preload the media library route chunk to speed up "See movies/TV" toast navigation.
    void import("@/pages/Library");
  }, []);

  const toSubtitleDraft = (name: string, parsed: ReturnType<typeof parseFilename>) => {
    const normalized = normalizeLanguageCode(typeof parsed?.language === "string" ? parsed.language : null);
    return {
      language: normalized,
      label: languageLabel(normalized),
    };
  };

  const tryDetectSubtitleDraftLanguage = useCallback(
    async (candidate: Candidate) => {
      if (candidate.kind !== "subtitle") return;
      const current = normalizeLanguageCode(candidate.subtitleDraft?.language);
      if (current !== "und") {
        logSubtitleDetect("external.skip.already_labeled", { candidateId: candidate.id, language: current, name: candidate.name });
        return;
      }
      if (!window.sf?.sampleSubtitleText) {
        logSubtitleDetect("external.skip.api_unavailable", { candidateId: candidate.id, name: candidate.name });
        return;
      }
      try {
        let combined = "";
        const seen = new Set<string>();
        const textSamples: string[] = [];
        const sampleKinds: string[] = [];
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const sample = await window.sf.sampleSubtitleText({
            path: candidate.path,
            index: 0,
            external: true,
            sampleIndex: attempt,
          });
          sampleKinds.push(sample?.kind ?? "none");
          if (!sample || sample.kind !== "text" || !sample.value) continue;
          const chunk = sample.value.trim();
          if (!chunk || seen.has(chunk)) continue;
          seen.add(chunk);
          textSamples.push(chunk);
          combined = combined ? `${combined}\n${chunk}` : chunk;
          if (combined.length >= 420) break;
        }
        if (!combined) {
          logSubtitleDetect("external.no_text_samples", {
            candidateId: candidate.id,
            name: candidate.name,
            sampleKinds,
          });
          return;
        }
        const detected = (await detectSubtitleLanguageFromSamples(textSamples)) ?? (await detectSubtitleLanguage(combined));
        if (!detected) {
          logSubtitleDetect("external.detect.none", {
            candidateId: candidate.id,
            name: candidate.name,
            sampleKinds,
            sampleCount: textSamples.length,
            combinedLength: combined.length,
          });
          return;
        }
        logSubtitleDetect("external.detect.hit", {
          candidateId: candidate.id,
          name: candidate.name,
          language: detected.language,
          confidence: detected.confidence,
          sampleCount: textSamples.length,
          combinedLength: combined.length,
        });
        setCandidates((prev) =>
          prev.map((entry) => {
            if (entry.id !== candidate.id) return entry;
            if (normalizeLanguageCode(entry.subtitleDraft?.language) !== "und") return entry;
            return {
              ...entry,
              subtitleDraft: {
                language: detected.language,
                label: languageLabel(detected.language),
              },
            };
          })
        );
      } catch {
        logSubtitleDetect("external.detect.error", {
          candidateId: candidate.id,
          name: candidate.name,
        });
        // Keep fallback flow; manual language prompt still handles uncertain cases.
      }
    },
    [languageLabel, logSubtitleDetect]
  );

  const normalizeTrackLabelForUi = useCallback(
    (label: string | null | undefined, language: string | null | undefined) => {
      if (isUndefinedLikeTrackLabel(label)) {
        return languageLabel(language);
      }
      return (label ?? "").trim();
    },
    [languageLabel]
  );

  const trackNeedsLanguageReview = useCallback(
    (track: { language?: string | null; label?: string | null }) => {
      const hasExplicitName = !isUndefinedLikeTrackLabel(track.label);
      if (hasExplicitName) {
        return false;
      }
      const language = normalizeLanguageCode(track.language);
      return language === "und";
    },
    [normalizeLanguageCode]
  );

  const tryDetectEmbeddedSubtitleTrackLanguages = useCallback(
    async (
      candidateId: string,
      candidatePath: string,
      probe: NonNullable<Candidate["probe"]>
    ) => {
      if (!window.sf?.sampleSubtitleText) return;
      const reviewTracks = probe.subtitleTracks.filter((track) => trackNeedsLanguageReview(track));
      if (reviewTracks.length === 0) {
        logSubtitleDetect("embedded.skip.no_review_tracks", { candidateId, trackCount: probe.subtitleTracks.length });
        return;
      }
      logSubtitleDetect("embedded.detect.start", {
        candidateId,
        trackCount: probe.subtitleTracks.length,
        reviewTrackIndexes: reviewTracks.map((track) => track.index),
      });

      const detectedByIndex = new Map<number, string>();
      for (const track of reviewTracks) {
        try {
          let combined = "";
          const seen = new Set<string>();
          const textSamples: string[] = [];
          const sampleKinds: string[] = [];
          for (let attempt = 0; attempt < 4; attempt += 1) {
            const sample = await window.sf.sampleSubtitleText({
              path: candidatePath,
              index: Math.max(0, track.index),
              external: false,
              sampleIndex: attempt,
            });
            sampleKinds.push(sample?.kind ?? "none");
            if (!sample || sample.kind !== "text" || !sample.value) continue;
            const chunk = sample.value.trim();
            if (!chunk || seen.has(chunk)) continue;
            seen.add(chunk);
            textSamples.push(chunk);
            combined = combined ? `${combined}\n${chunk}` : chunk;
            if (combined.length >= 420) break;
          }
          if (!combined) {
            logSubtitleDetect("embedded.no_text_samples", {
              candidateId,
              trackIndex: track.index,
              sampleKinds,
              sampleCount: textSamples.length,
            });
            continue;
          }
          const detected =
            (await detectSubtitleLanguageFromSamples(textSamples)) ?? (await detectSubtitleLanguage(combined));
          if (!detected) {
            logSubtitleDetect("embedded.detect.none", {
              candidateId,
              trackIndex: track.index,
              sampleKinds,
              sampleCount: textSamples.length,
              combinedLength: combined.length,
            });
            continue;
          }
          logSubtitleDetect("embedded.detect.hit", {
            candidateId,
            trackIndex: track.index,
            language: detected.language,
            confidence: detected.confidence,
            sampleCount: textSamples.length,
            combinedLength: combined.length,
          });
          detectedByIndex.set(track.index, detected.language);
        } catch {
          logSubtitleDetect("embedded.detect.error", {
            candidateId,
            trackIndex: track.index,
          });
          // Keep fallback flow for uncertain/unsupported subtitle tracks.
        }
      }

      if (detectedByIndex.size === 0) {
        logSubtitleDetect("embedded.detect.no_updates", { candidateId });
        return;
      }
      setCandidates((prev) =>
        prev.map((entry) => {
          if (entry.id !== candidateId) return entry;
          const baseProbe = entry.probe ?? probe;
          if (!baseProbe) return entry;
          let changed = false;
          const nextSubtitleTracks = baseProbe.subtitleTracks.map((track) => {
            const detectedLanguage = detectedByIndex.get(track.index);
            if (!detectedLanguage) return track;
            if (!trackNeedsLanguageReview(track)) return track;
            changed = true;
            return {
              ...track,
              language: detectedLanguage,
              label: languageLabel(detectedLanguage),
            };
          });
          if (!changed) return entry;
          return {
            ...entry,
            probe: {
              ...baseProbe,
              subtitleTracks: nextSubtitleTracks,
            },
          };
        })
      );
      logSubtitleDetect("embedded.applied", {
        candidateId,
        detectedIndexes: Array.from(detectedByIndex.keys()),
      });
    },
    [languageLabel, logSubtitleDetect]
  );

  const subtitleFormatFromName = (name: string) => {
    const ext = name.split(".").pop()?.toLowerCase();
    if (!ext) return null;
    if (["srt", "vtt", "ass", "ssa", "sub", "sup"].includes(ext)) return ext;
    return null;
  };
  const buildTrailerUrl = (key: string) => {
    const source = clientConfig.trailerSource;
    if (source.provider === "invidious" && source.validated && source.invidiousUrl.trim()) {
      const base = source.invidiousUrl.trim().replace(/\/+$/, "");
      return `${base}/embed/${key}`;
    }
    return `https://www.youtube.com/embed/${key}`;
  };

  const pickPreferredTrailersByLanguage = (trailers: Trailer[]) => {
    const grouped = new Map<string, Trailer[]>();
    trailers.forEach((trailer) => {
      const language = trailer.language || "und";
      const list = grouped.get(language) ?? [];
      list.push(trailer);
      grouped.set(language, list);
    });
    const pickBest = (items: Trailer[]) => {
      const sorted = [...items].sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
      return sorted[0];
    };
    const selected: Trailer[] = [];
    grouped.forEach((items) => {
      const official = items.filter((item) => item.official);
      if (official.length > 0) {
        const picked = pickBest(official);
        if (picked) selected.push(picked);
        return;
      }
      const picked = pickBest(items);
      if (picked) selected.push(picked);
    });
    return selected;
  };

  const getExistingQualities = (match: TitleSearchResult, season: number | null, episode: number | null) => {
    const existingMedia = media.find((item) => item.catalogId === match.id && item.type === match.type) ?? null;
    if (!existingMedia) return new Set<string>();
    const details = getMediaDetails(existingMedia.id);
    if (!details) return new Set<string>();
    const fileIds = details.files
      .filter((file) => file.season === season && file.episode === episode)
      .map((file) => file.id);
    const fileIdSet = new Set(fileIds);
    const relevantFormats =
      fileIdSet.size > 0
        ? details.formats.filter((format) => fileIdSet.has(format.fileId))
        : season === null && episode === null
          ? details.formats
          : [];
    const qualities = relevantFormats.map((format) => format.quality);
    return new Set(qualities);
  };

  const mergedGroups = useMemo<MergedGroup[]>(
    () =>
      buildFileIngestionMergedGroups(candidates, (groupCandidates) =>
        buildTrackSummary(groupCandidates, languageLabel)
      ) as MergedGroup[],
    [candidates, languageLabel]
  );

  const [selectedGroupIndex, setSelectedGroupIndex] = useState(0);
  const [selectedSeasonKey, setSelectedSeasonKey] = useState<string | null>(null);
  const [selectedEpisodeId, setSelectedEpisodeId] = useState<string | null>(null);
  const [selectionMode, setSelectionMode] = useState<"group" | "candidate">("group");
  const selectedGroup = selectionMode === "group" ? mergedGroups[selectedGroupIndex] ?? null : null;
  const selectedEpisode =
    selectedGroup?.episodeGroups && selectedGroup.episodeGroups.length > 0
      ? selectedGroup.episodeGroups.find((episodeGroup) => episodeGroup.id === selectedEpisodeId) ?? null
      : null;
  const activeGroup = selectedEpisode ?? selectedGroup;
  const activeCandidate = selectionMode === "candidate" ? selectedCandidate : null;
  // Each slot's stored track choice and the track keys it was last reconciled against, kept in one state so a render
  // always reads a matching pair. Read a slot's selection through `resolveTrackSelection`: a probe that lands after
  // the slot was seeded adds tracks the stored choice has not caught up with yet, and they count from that render.
  const [trackSelectionState, setTrackSelectionState] = useState<{
    selections: Record<string, FileIngestionTrackSelection>;
    known: Record<string, FileIngestionTrackSelection>;
  }>(() => ({ selections: {}, known: {} }));
  const setTrackSelections = useCallback(
    (update: (prev: Record<string, FileIngestionTrackSelection>) => Record<string, FileIngestionTrackSelection>) =>
      setTrackSelectionState((prev) => ({ ...prev, selections: update(prev.selections) })),
    []
  );
  const [trackSelectionTouched, setTrackSelectionTouched] = useState<Set<string>>(() => new Set());
  const resolveTrackSelection = useCallback(
    (slotId: string, audioTracks: readonly TrackKey[], subtitleTracks: readonly TrackKey[]) =>
      resolveFileIngestionTrackSelection(
        { audio: audioTracks.map((track) => track.key), subtitles: subtitleTracks.map((track) => track.key) },
        trackSelectionState.selections[slotId],
        trackSelectionState.known[slotId],
        trackSelectionTouched.has(slotId)
      ),
    [trackSelectionState, trackSelectionTouched]
  );

  // Files whose automatic lookup ended without a match (none found, or the lookup failed). A file still being looked
  // up is not unmatched (INGS-IDENT-02): it is counted in `searchingCandidates`.
  const unmatchedCandidates = useMemo(
    () => candidates.filter((c) => (!c.match || c.status !== "ready") && !isLookupInProgress(c)),
    [candidates]
  );
  const searchingCandidates = useMemo(() => candidates.filter((c) => isLookupInProgress(c)), [candidates]);

  const existingCatalogMap = useMemo(() => {
    const map = new Map<string, MediaRow>();
    media.forEach((item) => {
      if (typeof item.catalogId !== "number") return;
      map.set(`${item.type}:${item.catalogId}`, item);
    });
    return map;
  }, [media]);

  const stagedCatalogKeys = useMemo(() => {
    const keys = new Set<string>();
    candidates.forEach((candidate) => {
      if (!candidate.match) return;
      keys.add(`${candidate.match.type}:${candidate.match.id}`);
    });
    return keys;
  }, [candidates]);

  const groupIndexById = useMemo(() => {
    const map = new Map<string, number>();
    mergedGroups.forEach((group, index) => map.set(group.id, index));
    return map;
  }, [mergedGroups]);

  const videoDecisionItems = useMemo<FileIngestionVideoDecisionItem[]>(
    () =>
      buildFileIngestionVideoDecisionItems({
        groups: mergedGroups,
        hasExistingFiles: (match) =>
          Boolean(media.find((item) => item.catalogId === match.id && item.type === match.type)?.hasFiles),
        getExistingQualities,
        selectVariants: (variants) => buildSelectedVideoVariants(variants, clientConfig.enableCodecSelection),
        movieLabel: t("ingestion.ui.movie"),
      }),
    [buildSelectedVideoVariants, clientConfig.enableCodecSelection, media, mergedGroups, t]
  );

  useEffect(() => {
    setVideoDecisions((prev) => {
      const validIds = new Set(videoDecisionItems.map((item) => item.id));
      let changed = false;
      const next: Record<string, VideoDecision> = {};
      Object.entries(prev).forEach(([key, value]) => {
        if (validIds.has(key)) {
          next[key] = value;
        } else {
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [videoDecisionItems]);

  const unresolvedVideoDecisions = useMemo(
    () => videoDecisionItems.filter((item) => !videoDecisions[item.id]),
    [videoDecisionItems, videoDecisions]
  );

  const resolveDecisionItems = useMemo(
    () => unresolvedVideoDecisions.sort((a, b) => a.title.localeCompare(b.title) || a.slotLabel.localeCompare(b.slotLabel)),
    [unresolvedVideoDecisions]
  );

  const activeResolveItem = resolveDecisionItems[Math.min(resolveIndex, Math.max(0, resolveDecisionItems.length - 1))] ?? null;

  useEffect(() => {
    if (resolveDecisionItems.length === 0) {
      setResolveModalOpen(false);
      setResolveIndex(0);
      return;
    }
    if (resolveIndex >= resolveDecisionItems.length) {
      setResolveIndex(resolveDecisionItems.length - 1);
    }
  }, [resolveDecisionItems, resolveIndex]);

  const unresolvedVideoDecisionGroupIds = useMemo(
    () => new Set(unresolvedVideoDecisions.map((item) => item.groupId)),
    [unresolvedVideoDecisions]
  );

  const readyGroups = useMemo(
    () => mergedGroups.filter((group) => !unresolvedVideoDecisionGroupIds.has(group.id)),
    [mergedGroups, unresolvedVideoDecisionGroupIds]
  );

  const groupsNeedingDecision = useMemo(
    () => mergedGroups.filter((group) => unresolvedVideoDecisionGroupIds.has(group.id)),
    [mergedGroups, unresolvedVideoDecisionGroupIds]
  );

  const autoIgnoredVideoOverlaps = useMemo(
    () =>
      countFileIngestionAutoIgnoredVideoOverlaps({
        groups: mergedGroups,
        hasExistingFiles: (match) =>
          Boolean(media.find((item) => item.catalogId === match.id && item.type === match.type)?.hasFiles),
        getExistingQualities,
        selectVariants: (variants) => buildSelectedVideoVariants(variants, clientConfig.enableCodecSelection),
      }),
    [buildSelectedVideoVariants, clientConfig.enableCodecSelection, media, mergedGroups]
  );

  const readyGroupCount = useMemo(
    () =>
      readyGroups.reduce((total, group) => {
        if (group.episodeGroups && group.episodeGroups.length > 0) {
          return total + group.episodeGroups.length;
        }
        return total + 1;
      }, 0),
    [readyGroups]
  );
  const readyCandidateCount = useMemo(
    () => candidates.filter((candidate) => candidate.status === "ready").length,
    [candidates]
  );
  const readyCount = mergedGroups.length > 0 ? readyGroupCount : readyCandidateCount;
  const pendingProbeCount = useMemo(
    () =>
      candidates.filter(
        (candidate) =>
          candidate.kind === "video" &&
          candidate.status === "ready" &&
          candidate.match &&
          !candidate.probe &&
          !candidate.probeError
      ).length,
    [candidates]
  );

  const activeGroupKey = activeGroup?.id ?? selectedGroup?.id ?? null;
  const activeGroupTracks = activeGroup ?? selectedGroup ?? null;
  const activeTrackSelection = useMemo(
    () =>
      activeGroupKey && activeGroupTracks
        ? resolveTrackSelection(activeGroupKey, activeGroupTracks.audioTracks ?? [], activeGroupTracks.subtitleTracks ?? [])
        : null,
    [activeGroupKey, activeGroupTracks, resolveTrackSelection]
  );
  const subtitleSelectionActive = Boolean(
    (selectedGroup?.candidates ?? [activeCandidate]).length &&
      (selectedGroup?.candidates ?? [activeCandidate]).every((candidate) => candidate?.kind === "subtitle")
  );
  const selectedSeason = selectedEpisode?.season ?? selectedGroup?.candidates?.[0]?.parsed?.season ?? null;
  const selectedEpisodeNumber = selectedEpisode?.episode ?? selectedGroup?.candidates?.[0]?.parsed?.episode ?? null;
  const resolveTrackPreview = (
    kind: "audio" | "subtitle",
    track: { label: string; language: string; refs: Array<{ candidateId: string; index: number }> }
  ) => {
    const decisions = track.refs
      .map((ref) => undefinedTrackDecisions[`${ref.candidateId}:${kind}:${ref.index}`])
      .filter((entry): entry is UndefinedTrackDecision => Boolean(entry));
    const firstResolved = decisions.find((entry) => !entry.keepUndefined);
    if (!firstResolved) return normalizeTrackLabelForUi(track.label, track.language);
    return firstResolved.label?.trim() || languageLabel(firstResolved.language);
  };
  const activeGroupProbeReady = useMemo(() => {
    if (!activeGroupTracks) return true;
    return activeGroupTracks.candidates.every((candidate) =>
      candidate.kind === "subtitle" ? true : Boolean(candidate.probe) || Boolean(candidate.probeError)
    );
  }, [activeGroupTracks]);
  const tvSeasonState = useMemo(
    () => buildFileIngestionTvSeasonState(selectedGroup?.episodeGroups, selectedSeasonKey),
    [selectedGroup?.episodeGroups, selectedSeasonKey]
  );
  const activeAutoOutputs = useMemo(() => {
    if (!selectedGroup || !activeGroupTracks) return [];
    const desiredOutputs = ingestOutputs;
    const availableQualities = new Set<string>();
    (activeGroupTracks.videoVariants ?? []).forEach((variant) => {
      if (variant.quality) {
        availableQualities.add(variant.quality);
      }
    });
    const existing = getExistingQualities(selectedGroup.match, selectedSeason, selectedEpisodeNumber);
    existing.forEach((quality) => availableQualities.add(quality));
    videoDecisionItems
      .filter(
        (item) =>
          item.groupId === selectedGroup.id &&
          item.slotId === (activeGroup?.id ?? selectedGroup.id) &&
          videoDecisions[item.id] === "add"
      )
      .forEach((item) => availableQualities.add(item.quality));
    return desiredOutputs.filter((output) => !availableQualities.has(output.quality));
  }, [
    activeGroup?.id,
    activeGroupTracks,
    ingestOutputs,
    selectedGroup,
    selectedSeason,
    selectedEpisodeNumber,
    videoDecisionItems,
    videoDecisions,
  ]);
  const activeIsSubtitleOnly = Boolean(
    activeGroupTracks &&
      (activeGroupTracks.videoVariants?.length ?? 0) === 0 &&
      (activeGroupTracks.subtitleTracks?.length ?? 0) > 0
  );

  useEffect(() => {
    setTrackSelectionState((prev) => {
      const selections = { ...prev.selections };
      const known = { ...prev.known };
      mergedGroups.forEach((group) => {
        const groupsToSeed = group.episodeGroups && group.episodeGroups.length > 0 ? group.episodeGroups : [group];
        groupsToSeed.forEach((entry) => {
          const key = entry.id;
          const current = {
            audio: entry.audioTracks?.map((track) => track.key) ?? [],
            subtitles: entry.subtitleTracks?.map((track) => track.key) ?? [],
          };
          selections[key] = resolveFileIngestionTrackSelection(
            current,
            prev.selections[key],
            prev.known[key],
            trackSelectionTouched.has(key)
          );
          known[key] = { audio: new Set(current.audio), subtitles: new Set(current.subtitles) };
        });
      });
      return { selections, known };
    });
  }, [mergedGroups, trackSelectionTouched]);

  // helpers above useMemo

  const processPaths = async (pathsToProcess: string[]) => {
    if (pathsToProcess.length === 0) return;
    setScanError(null);
    if (!window.sf?.scanFiles) {
      setScanError(t("ingestion.errors.desktopOnly"));
      return;
    }
    setScanning(true);
    try {
      const scanned = await window.sf.scanFiles(pathsToProcess);
      const initialList: Candidate[] = scanned.map((file) => {
        const parsed = parseFilename(file.name);
        return {
          id: crypto.randomUUID(),
          path: file.path,
          name: file.name,
          size: file.size,
          kind: file.kind,
          parsed,
          match: null,
          status: "pending",
          subtitleDraft: file.kind === "subtitle" ? toSubtitleDraft(file.name, parsed) : undefined,
        };
      });

      setCandidates(prev => [...prev, ...initialList]);
      setScanning(false);

      const subtitleCandidates = initialList.filter((candidate) => candidate.kind === "subtitle");
      void Promise.all(subtitleCandidates.map((candidate) => tryDetectSubtitleDraftLanguage(candidate)));

      const probeCandidates = async () => {
        if (!window.sf?.probeMedia) return;
        for (const candidate of initialList) {
          if (candidate.kind !== "video") continue;
          try {
            logSubtitleDetect("probe.start", {
              candidateId: candidate.id,
              name: candidate.name,
              path: candidate.path,
            });
            const probe = await window.sf.probeMedia(candidate.path);
            logSubtitleDetect("probe.complete", {
              candidateId: candidate.id,
              name: candidate.name,
              subtitleTracks: probe?.subtitleTracks?.length ?? 0,
            });
            setCandidates((prev) =>
              prev.map((c) => (c.id === candidate.id ? { ...c, probe, probeError: undefined } : c))
            );
            if (probe?.subtitleTracks?.length) {
              logSubtitleDetect("probe.detect_dispatch", {
                candidateId: candidate.id,
                name: candidate.name,
              });
              void tryDetectEmbeddedSubtitleTrackLanguages(candidate.id, candidate.path, probe);
            }
          } catch (err) {
            const message =
              err && typeof (err as { message?: string }).message === "string" &&
              (err as { message?: string }).message === "ffprobe_not_found"
                ? t("ingestion.errors.ffprobeMissing")
                : t("ingestion.errors.probeFailed");
            setCandidates((prev) =>
              prev.map((c) => (c.id === candidate.id ? { ...c, probe: null, probeError: message } : c))
            );
          }
        }
      };
      void probeCandidates();

      // Start identification for new candidates
      for (const candidate of initialList) await identifyCandidate(candidate);
      linkStagedSubtitles();
    } catch (err) {
      ingestLog.error({ err: String(err) }, "scan_failed");
      setScanError(t("ingestion.errors.scanFailed"));
      setScanning(false);
    }
  };

  /** The automatic title search of one file: its best match, or why there is none. */
  const identifyCandidate = async (candidate: Candidate) => {
    setCandidates((prev) =>
      prev.map((c) => c.id === candidate.id ? { ...c, status: "searching", searchUnavailable: false } : c)
    );

    try {
      if (!token) throw new Error("No token");
      const isTv = typeof candidate.parsed?.season === "number" || typeof candidate.parsed?.episode === "number";
      const type = isTv ? "tv" : "movie";
      const query = candidate.parsed?.title ?? candidate.name;

      // A drop of many titles reaches the service's per-connection limit: wait it out rather than fail the title.
      // Each attempt has a deadline, so a lookup that never answers ends in a final state (INGS-IDENT-02).
      const results = await withMetadataRetry(() => withMetadataTimeout(() => searchTitles(token, type, query)));
      // Staged matches are read from the latest state: on a retry other files of the drop may have matched since.
      const staged = new Set(stagedCatalogKeys);
      for (const c of candidatesRef.current) if (c.match) staged.add(`${c.match.type}:${c.match.id}`);
      const bestRaw =
        candidate.kind === "subtitle"
          ? results.results.find((entry: TitleSearchResult) => {
              const key = `${entry.type}:${entry.id}`;
              return existingCatalogMap.has(key) || staged.has(key);
            }) ?? null
          : results.results[0] ?? null;
      // Search hits the catalog with language=en-US, so a French film returns the
      // English title/poster/overview. For library-resolved display, swap
      // those fields to the resolved-language variant before showing the
      // match in the preview pane. A found match is never dropped: if localizing fails or passes its deadline, the
      // raw (English) hit is shown instead (INGS-IDENT-02).
      const best = bestRaw
        ? await withMetadataTimeout(() => localizeSearchResultForLibrary(token, bestRaw, { accountLanguage })).catch(
            (error: unknown) => {
              ingestLog.warn(
                { file: candidate.name, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) },
                "match-localize-failed: showing the raw hit"
              );
              return bestRaw;
            }
          )
        : null;

      setCandidates((prev) =>
        prev.map((c) => c.id === candidate.id ? {
          ...c,
          match: best,
          status: (best ? "ready" : "error") as Candidate["status"],
          error: best
            ? undefined
            : candidate.kind === "subtitle"
              ? t("ingestion.errors.noExistingMatch")
              : t("ingestion.errors.noMatch"),
          errorHint: undefined,
          searchUnavailable: false,
        } : c)
      );
    } catch (error) {
      const failure = searchFailureText(error);
      const unavailable = failure.retryOnTickets;
      ingestLog.warn(
        {
          file: candidate.name,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          failure: failure.error,
          hint: failure.hint,
          ...(failure.values ? { values: failure.values } : {}),
          retryOnTickets: unavailable,
        },
        "title-search-failed"
      );
      setCandidates((prev) =>
        prev.map((c) => c.id === candidate.id ? { ...c, status: "error", error: t(failure.error), errorHint: t(failure.hint, failure.values), searchUnavailable: unavailable } : c)
      );
    }
  };

  // If a subtitle file is identifiable and matches media already staged in this import,
  // auto-link it even when the media isn't in the existing library yet.
  const linkStagedSubtitles = () => {
    setCandidates((prev) => {
      const stagedByFingerprint = new Map<string, TitleSearchResult | null>();
      prev.forEach((candidate) => {
        if (!candidate.match) return;
        const key = candidateFingerprint(candidate);
        if (!key) return;
        const existing = stagedByFingerprint.get(key);
        if (!existing) {
          stagedByFingerprint.set(key, candidate.match);
          return;
        }
        if (existing.id !== candidate.match.id || existing.type !== candidate.match.type) {
          stagedByFingerprint.set(key, null);
        }
      });
      let changed = false;
      const next = prev.map((candidate) => {
        if (candidate.kind !== "subtitle" || candidate.match) return candidate;
        const key = candidateFingerprint(candidate);
        if (!key) return candidate;
        const staged = stagedByFingerprint.get(key);
        if (!staged) return candidate;
        changed = true;
        return { ...candidate, match: staged, status: "ready" as Candidate["status"], error: undefined, errorHint: undefined, searchUnavailable: false };
      });
      return changed ? next : prev;
    });
  };

  // Files whose title search was unavailable (no ticket yet right after sign-in, or the service was busy) are looked
  // up again as soon as tickets arrive (a refill batch landed), with no action from the user (META-ANON-02: the
  // lookup never triggers a refill; it waits for the app's own).
  const identifyCandidateRef = useRef(identifyCandidate);
  identifyCandidateRef.current = identifyCandidate;
  const linkStagedSubtitlesRef = useRef(linkStagedSubtitles);
  linkStagedSubtitlesRef.current = linkStagedSubtitles;
  // A file the user matched by hand meanwhile is left alone.
  const waitingForTickets = candidates.some((c) => c.searchUnavailable === true && !c.match);
  useEffect(() => {
    if (!waitingForTickets) return;
    let retrying = false;
    return onMetadataTicketsAvailable(() => {
      if (retrying) return;
      const waiting = candidatesRef.current.filter((c) => c.searchUnavailable === true && !c.match);
      if (waiting.length === 0) return;
      retrying = true;
      ingestLog.info({ titles: waiting.length }, "tickets-arrived: searching again");
      void (async () => {
        // Videos first, so a subtitle can find the title its video just matched.
        const ordered = [...waiting.filter((c) => c.kind !== "subtitle"), ...waiting.filter((c) => c.kind === "subtitle")];
        for (const candidate of ordered) await identifyCandidateRef.current(candidate);
        linkStagedSubtitlesRef.current();
      })().finally(() => {
        retrying = false;
      });
    });
  }, [waitingForTickets]);

  // Process initial paths when dialog opens
  const lastProcessedPathsNonceRef = useRef<number | null>(null);
  useEffect(() => {
    if (open) {
      if (resetTimeoutRef.current !== null) {
        window.clearTimeout(resetTimeoutRef.current);
        resetTimeoutRef.current = null;
      }
      if (initialPaths.length > 0 && lastProcessedPathsNonceRef.current !== pathsNonce) {
        lastProcessedPathsNonceRef.current = pathsNonce;
        void processPaths(initialPaths);
      }
      return;
    }

    if (resetTimeoutRef.current !== null) {
      window.clearTimeout(resetTimeoutRef.current);
    }

    resetTimeoutRef.current = window.setTimeout(() => {
      lastProcessedPathsNonceRef.current = null;
      setCandidates([]);
      setSelectedIndex(0);
      setSelectedGroupIndex(0);
      setSelectedSeasonKey(null);
      setSelectedEpisodeId(null);
      setSelectionMode("group");
      setScanError(null);
      setVideoDecisions({});
      setResolveModalOpen(false);
      setResolveIndex(0);
      setTrackSelectionState({ selections: {}, known: {} });
      setTrackSelectionTouched(new Set());
      setInputResolveModalOpen(false);
      setInputResolveIndex(0);
      setUndefinedTrackDecisions({});
      setIgnoreUndefinedByKind({ audio: false, subtitle: false });
      setAudioSampleCache({});
      setAudioSampleLoadingId(null);
      setAudioPlayingId(null);
      setSubtitleSampleCache({});
      setSubtitleSampleLoadingId(null);
      setSubtitleSampleModalRowId(null);
      setManualSearchOpen(false);
      if (audioPlaybackRef.current.audio) {
        audioPlaybackRef.current.audio.pause();
      }
      audioPlaybackRef.current = { id: null, audio: null };
      clearManualSearch();
      resetTimeoutRef.current = null;
      setQuotaGate(null);
    }, 250);
  }, [open, initialPaths, pathsNonce]);

  useEffect(() => {
    if (selectedGroupIndex >= mergedGroups.length) {
      setSelectedGroupIndex(0);
    }
  }, [mergedGroups.length, selectedGroupIndex]);

  useEffect(() => {
    if (!pendingFocusGroupKey) return;
    const index = mergedGroups.findIndex((group) => group.id === pendingFocusGroupKey);
    if (index >= 0) {
      setSelectionMode("group");
      setSelectedGroupIndex(index);
      setSelectedSeasonKey(null);
      setSelectedEpisodeId(null);
      setPendingFocusGroupKey(null);
      return;
    }
    if (mergedGroups.length === 0) return;
    setPendingFocusGroupKey(null);
  }, [mergedGroups, pendingFocusGroupKey]);

  useEffect(() => {
    if (mergedGroups.length === 0 && candidates.length > 0 && selectionMode !== "candidate") {
      setSelectionMode("candidate");
    }
  }, [candidates.length, mergedGroups.length, selectionMode]);

  useEffect(() => {
    if (!selectedGroup?.episodeGroups || selectedGroup.episodeGroups.length === 0) {
      setSelectedSeasonKey((prev) => (prev === null ? prev : null));
      setSelectedEpisodeId((prev) => (prev === null ? prev : null));
      return;
    }
    const seasons = Array.from(
      new Set(
        selectedGroup.episodeGroups.map((episodeGroup) =>
          episodeGroup.season === null ? "unknown" : String(episodeGroup.season)
        )
      )
    ).sort((a, b) => {
      if (a === "unknown") return 1;
      if (b === "unknown") return -1;
      return Number(a) - Number(b);
    });
    const nextSeasonKey = selectedSeasonKey && seasons.includes(selectedSeasonKey) ? selectedSeasonKey : seasons[0];
    setSelectedSeasonKey((prev) => (prev === nextSeasonKey ? prev : nextSeasonKey));
    const episodeCandidates = selectedGroup.episodeGroups.filter((episodeGroup) => {
      const key = episodeGroup.season === null ? "unknown" : String(episodeGroup.season);
      return key === nextSeasonKey;
    });
    const nextEpisodeId =
      selectedEpisodeId && episodeCandidates.some((episodeGroup) => episodeGroup.id === selectedEpisodeId)
        ? selectedEpisodeId
        : episodeCandidates[0]?.id ?? null;
    if (nextEpisodeId !== selectedEpisodeId) {
      setSelectedEpisodeId(nextEpisodeId);
    }
  }, [selectedGroup?.id, selectedGroup?.episodeGroups, selectedEpisodeId, selectedSeasonKey]);

  useEffect(() => {
    if (selectionMode === "candidate" && (!activeCandidate || !candidates.length)) {
      setSelectionMode("group");
    }
  }, [selectionMode, activeCandidate, candidates.length]);

  useEffect(() => {
    if (selectionMode !== "candidate" || !activeCandidate?.match) return;
    const groupId = `${activeCandidate.match.type}:${activeCandidate.match.id}`;
    const index = groupIndexById.get(groupId);
    if (index === undefined) return;
    setSelectionMode("group");
    setSelectedGroupIndex(index);
    setSelectedSeasonKey(null);
    setSelectedEpisodeId(null);
  }, [selectionMode, activeCandidate, groupIndexById]);

  useEffect(() => {
    if (!activeCandidate || selectedGroup) return;
    if (activeCandidate.match) {
      setManualSearchOpen(false);
      return;
    }
    setManualSearchOpen(true);
  }, [activeCandidate, selectedGroup]);

  useEffect(() => {
    if (!openTrailerId) return;
    const handleClose = () => setOpenTrailerId(null);
    window.addEventListener("scroll", handleClose, true);
    return () => {
      window.removeEventListener("scroll", handleClose, true);
    };
  }, [openTrailerId]);

  useEffect(() => {
    return () => {
      if (audioPlaybackRef.current.audio) {
        audioPlaybackRef.current.audio.pause();
      }
      audioPlaybackRef.current = { id: null, audio: null };
    };
  }, []);

  useEffect(() => {
    const type = (selectedGroup?.match ?? activeCandidate?.match)?.type;
    if (type === "movie" || type === "tv") {
      setManualSearchType(type);
    }
  }, [selectedGroup?.match, activeCandidate?.match]);

  useEffect(() => {
    if (!dummyIngestOpen) {
      setDummyIngestQuery("");
      setDummyIngestResults([]);
      setDummyIngestError(null);
      setDummyIngestLoading(false);
      setDummyIngestRunning(false);
    }
  }, [dummyIngestOpen]);

  useEffect(() => {
    if (inputResolveModalOpen) return;
    stopAudioSample();
    setSubtitleSampleModalRowId(null);
  }, [inputResolveModalOpen]);

  useEffect(() => {
    const sample = subtitleSampleModalRowId ? subtitleSampleCache[subtitleSampleModalRowId] : null;
    if (!sample || sample.kind !== "image") {
      setSubtitleImagePreviewSrc(null);
      return;
    }

    let cancelled = false;
    const run = async () => {
      const cropped = await cropSubtitleSampleImage(sample.value).catch(() => sample.value);
      if (!cancelled) {
        setSubtitleImagePreviewSrc(cropped);
      }
    };
    setSubtitleImagePreviewSrc(sample.value);
    void run();
    return () => {
      cancelled = true;
    };
  }, [subtitleSampleModalRowId, subtitleSampleCache]);

  const handleLocalDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingLocal(false);
    if (!window.sf?.getPathForFile && !window.sf?.scanFiles) {
      setScanError(t("ingestion.errors.desktopOnly"));
      return;
    }
    const files = Array.from(e.dataTransfer?.files ?? []);
    const filePaths = files
      .map((f) => window.sf?.getPathForFile?.(f) || (f as unknown as { path?: string }).path)
      .filter((value): value is string => Boolean(value));
    const uriListRaw = e.dataTransfer?.getData("text/uri-list") ?? "";
    const uriPaths = uriListRaw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((uri) => {
        try {
          return uri.startsWith("file://") ? fileUriPath(uri) : decodeURIComponent(uri);
        } catch {
          return "";
        }
      })
      .filter((value): value is string => Boolean(value));
    const paths = Array.from(new Set([...filePaths, ...uriPaths]));
    if (paths.length === 0) {
      return;
    }
    void processPaths(paths);
  };

  const handleNativeBrowse = async (type: "file" | "folder") => {
    if (!window.sf?.openFileDialog) {
      setScanError(t("ingestion.errors.desktopOnly"));
      return;
    }
    const paths = await window.sf.openFileDialog({
      properties: type === "folder" ? ["openDirectory", "multiSelections"] : ["openFile", "multiSelections"]
    });
    if (paths.length > 0) {
      void processPaths(paths);
    }
  };

  const handleManualSearch = async () => {
    if (!token || !manualSearchQuery.trim()) return;
    setSearchingManual(true);
    try {
      const selection = (selectedGroup?.candidates ?? [activeCandidate]).filter(Boolean) as Candidate[];
      const isSubtitleSelection =
        selection.length > 0 && selection.every((candidate) => candidate.kind === "subtitle");
      const results = await searchTitles(token, manualSearchType, manualSearchQuery.trim(), 1);
      const filtered = isSubtitleSelection
        ? results.results.filter((item: TitleSearchResult) => {
            const key = `${item.type}:${item.id}`;
            return existingCatalogMap.has(key) || stagedCatalogKeys.has(key);
          })
        : results.results;
      setManualSearchResults(filtered);
      setManualSearchPage(results.page ?? 1);
      setManualSearchTotalPages(results.totalPages ?? 1);
      setTrailerCache({});
      setOpenTrailerId(null);
    } catch {
      // ignore
    } finally {
      setSearchingManual(false);
    }
  };

  const clearManualSearch = () => {
    setManualSearchQuery("");
    setManualSearchResults([]);
    setManualSearchPage(1);
    setManualSearchTotalPages(1);
    setTrailerCache({});
    setOpenTrailerId(null);
  };

  const getTrailerLanguages = (item: TitleSearchResult) => {
    const shared = getSharedSetting("trailer_languages");
    let extras: string[] = [];
    if (shared) {
      try {
        const payload = JSON.parse(shared.value) as { extras?: string[] };
        if (Array.isArray(payload.extras)) {
          extras = payload.extras.filter((lang) => typeof lang === "string");
        }
      } catch {
        extras = [];
      }
    }
    const base = item.originalLanguage || "en";
    return Array.from(new Set([base, ...extras].filter(Boolean)));
  };

  const ensureTrailers = async (item: TitleSearchResult, openMenu: boolean) => {
    if (!token) return;
    const key = `${item.type}:${item.id}`;
    const cached = trailerCache[key];
    if (cached && cached.status !== "idle" && cached.status !== "error") {
      if (openMenu && cached.status === "ready") {
        setOpenTrailerId(key);
      }
      return;
    }
    setTrailerCache((prev) => ({ ...prev, [key]: { status: "loading", trailers: [] } }));
    try {
      const languages = getTrailerLanguages(item);
      const trailers = await getTitleTrailersForLanguages(token, item.type, item.id, languages);
      const selected = pickPreferredTrailersByLanguage(trailers);
      if (selected.length === 0) {
        setTrailerCache((prev) => ({ ...prev, [key]: { status: "empty", trailers: [] } }));
        if (openMenu) {
          setOpenTrailerId(null);
        }
        return;
      }
      setTrailerCache((prev) => ({ ...prev, [key]: { status: "ready", trailers: selected } }));
      if (openMenu) {
        setOpenTrailerId(key);
      }
    } catch {
      setTrailerCache((prev) => ({ ...prev, [key]: { status: "error", trailers: [] } }));
    }
  };

  const loadMoreManualResults = async () => {
    if (!token || !manualSearchQuery.trim()) return;
    if (manualSearchLoadingMore || searchingManual) return;
    if (manualSearchPage >= manualSearchTotalPages) return;
    setManualSearchLoadingMore(true);
    const nextPage = manualSearchPage + 1;
    try {
      const selection = (selectedGroup?.candidates ?? [activeCandidate]).filter(Boolean) as Candidate[];
      const isSubtitleSelection =
        selection.length > 0 && selection.every((candidate) => candidate.kind === "subtitle");
      const results = await searchTitles(token, manualSearchType, manualSearchQuery.trim(), nextPage);
      setManualSearchResults((prev) => {
        const seen = new Set(prev.map((item) => item.id));
        const merged = [...prev];
      const filtered = isSubtitleSelection
          ? results.results.filter((item: TitleSearchResult) => {
              const key = `${item.type}:${item.id}`;
              return existingCatalogMap.has(key) || stagedCatalogKeys.has(key);
            })
          : results.results;
        filtered.forEach((item: TitleSearchResult) => {
          if (!seen.has(item.id)) {
            merged.push(item);
            seen.add(item.id);
          }
        });
        return merged;
      });
      setManualSearchPage(results.page ?? nextPage);
      setManualSearchTotalPages(results.totalPages ?? manualSearchTotalPages);
    } finally {
      setManualSearchLoadingMore(false);
    }
  };

  const applyManualMatch = async (rawMatch: TitleSearchResult) => {
    const selection = (selectedGroup?.candidates ?? [activeCandidate]).filter(Boolean) as Candidate[];
    const isSubtitleSelection =
      selection.length > 0 && selection.every((candidate) => candidate.kind === "subtitle");
    if (isSubtitleSelection && !existingCatalogMap.has(`${rawMatch.type}:${rawMatch.id}`) && !stagedCatalogKeys.has(`${rawMatch.type}:${rawMatch.id}`)) {
      toast(t("ingestion.toasts.pickExistingTitle"));
      return;
    }
    // Manual search runs in en-US too. Localize the picked hit to the
    // resolved language so the preview pane shows the French title/poster
    // (etc.) immediately, not the English one we just received from search.
    const match = token
      ? await localizeSearchResultForLibrary(token, rawMatch, { accountLanguage })
      : rawMatch;
    if (selectedGroup) {
      const candidateIds = new Set(selectedGroup.candidates.map((c) => c.id));
      setCandidates((prev) =>
        prev.map((c) =>
          candidateIds.has(c.id)
            ? {
                ...c,
                match,
                status: "ready",
                error: undefined,
                skipMarkerData: match.type === "movie" ? null : c.skipMarkerData,
              }
            : c
        )
      );
      setPendingFocusGroupKey(`${match.type}:${match.id}`);
    } else {
      setCandidates((prev) =>
        prev.map((c, i) =>
          i === selectedIndex
            ? {
                ...c,
                match,
                status: "ready",
                error: undefined,
                skipMarkerData: match.type === "movie" ? null : c.skipMarkerData,
              }
            : c
        )
      );
      setPendingFocusGroupKey(`${match.type}:${match.id}`);
    }
    setManualSearchResults([]);
    setManualSearchQuery("");
    setManualSearchOpen(false);
  };

  const handleDummySearch = async () => {
    if (!token) {
      setDummyIngestError(t("ingestion.errors.signInSearchTitles"));
      return;
    }
    if (!dummyIngestQuery.trim()) return;
    setDummyIngestLoading(true);
    setDummyIngestError(null);
    try {
      const results = await searchTitles(token, dummyIngestType, dummyIngestQuery.trim());
      setDummyIngestResults(results.results);
    } catch (error) {
      setDummyIngestError(t(searchFailureText(error).error));
    } finally {
      setDummyIngestLoading(false);
    }
  };

  const handleDummySelect = async (_result: TitleSearchResult) => {
    // Dummy-ingest dev tool was removed alongside the legacy main-process
    // labQueue plumbing (Day 1A). The handler is retained as a no-op so
    // existing JSX bindings don't fail typecheck.
    void _result;
    toast(t("ingestion.toasts.dummyUnavailable"));
  };

  const selectedUndefinedTrackRowIds = useMemo(() => {
    const selectedIds = new Set<string>();
    mergedGroups.forEach((group) => {
      const slots: Array<{
        id: string;
        audioTracks: Array<TrackKey & { refs: Array<{ candidateId: string; index: number }> }>;
        subtitleTracks: Array<TrackKey & { refs: Array<{ candidateId: string; index: number }> }>;
      }> =
        group.episodeGroups && group.episodeGroups.length > 0
          ? group.episodeGroups
          : [
              {
                id: group.id,
                audioTracks: group.audioTracks ?? [],
                subtitleTracks: group.subtitleTracks ?? [],
              },
            ];
      slots.forEach((slot) => {
        const selection = resolveTrackSelection(slot.id, slot.audioTracks, slot.subtitleTracks);
        slot.audioTracks.forEach((track) => {
          if (!selection.audio.has(track.key)) return;
          track.refs.forEach((ref) => selectedIds.add(`${ref.candidateId}:audio:${ref.index}`));
        });
        slot.subtitleTracks.forEach((track) => {
          if (!selection.subtitles.has(track.key)) return;
          track.refs.forEach((ref) => selectedIds.add(`${ref.candidateId}:subtitle:${ref.index}`));
        });
      });
    });
    return selectedIds;
  }, [mergedGroups, resolveTrackSelection]);

  const undefinedTrackRows = useMemo(() => {
    const ready = candidates.filter((candidate) => candidate.status === "ready" && candidate.match);
    return buildFileIngestionUndefinedTrackRows(ready, {
      normalizeLanguageCode,
      normalizeTrackLabelForUi,
      trackNeedsLanguageReview,
    }).filter((row) => selectedUndefinedTrackRowIds.has(row.id));
  }, [candidates, normalizeLanguageCode, normalizeTrackLabelForUi, selectedUndefinedTrackRowIds, trackNeedsLanguageReview]);

  useEffect(() => {
    const validIds = new Set(undefinedTrackRows.map((row) => row.id));
    setUndefinedTrackDecisions((prev) => {
      let changed = false;
      const next: Record<string, UndefinedTrackDecision> = {};
      Object.entries(prev).forEach(([key, value]) => {
        if (!validIds.has(key)) {
          changed = true;
          return;
        }
        next[key] = value;
      });
      return changed ? next : prev;
    });
  }, [undefinedTrackRows]);

  useEffect(() => {
    const validIds = new Set(undefinedTrackRows.map((row) => row.id));
    setCustomNameEditingRows((prev) => {
      let changed = false;
      const next = new Set<string>();
      prev.forEach((rowId) => {
        if (validIds.has(rowId)) {
          next.add(rowId);
        } else {
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [undefinedTrackRows]);

  const unresolvedInputRows = useMemo(
    () =>
      undefinedTrackRows.filter((row) => {
        if (ignoreUndefinedByKind[row.kind]) return false;
        const decision = undefinedTrackDecisions[row.id];
        if (!decision) return true;
        const language = normalizeLanguageCode(decision.language);
        return decision.keepUndefined || language === "und";
      }),
    [ignoreUndefinedByKind, undefinedTrackDecisions, undefinedTrackRows]
  );
  const unresolvedInputCount = unresolvedInputRows.length;
  // Count TV candidates whose skip-marker fetch is still in flight. The Add
  // button blocks on these so markers travel with the ingest payload — adding
  // before the fetch completes would skip persistence and force a lazy fetch
  // on first playback.
  const pendingSkipDataCount = useMemo(
    () =>
      candidates.filter(
        (c) =>
          c.kind === "video" &&
          c.match?.type === "tv" &&
          c.skipMarkerData?.status === "fetching",
      ).length,
    [candidates],
  );
  const unresolvedInputCandidateIds = useMemo(
    () => new Set(unresolvedInputRows.map((row) => row.candidateId)),
    [unresolvedInputRows]
  );
  const groupsNeedingInput = useMemo(
    () =>
      readyGroups.filter((group) => group.candidates.some((candidate) => unresolvedInputCandidateIds.has(candidate.id))),
    [readyGroups, unresolvedInputCandidateIds]
  );
  const fullyReadyGroups = useMemo(
    () =>
      readyGroups.filter((group) => !group.candidates.some((candidate) => unresolvedInputCandidateIds.has(candidate.id))),
    [readyGroups, unresolvedInputCandidateIds]
  );
  const inputRows = undefinedTrackRows;
  const inputKinds = useMemo(
    () =>
      (["audio", "subtitle"] as const).filter((kind) => inputRows.some((row) => row.kind === kind)),
    [inputRows]
  );
  const activeInputKind = inputKinds[Math.min(inputResolveIndex, Math.max(0, inputKinds.length - 1))] ?? null;
  const activeInputRows = useMemo(
    () => (activeInputKind ? inputRows.filter((row) => row.kind === activeInputKind) : []),
    [activeInputKind, inputRows]
  );
  const activeInputGroups = useMemo(
    () =>
      buildFileIngestionActiveInputGroups(activeInputRows, candidates, {
        unknownMediaLabel: t("ingestion.ui.unknownMedia"),
        movieLabel: t("ingestion.ui.movie"),
      }),
    [activeInputRows, candidates, t]
  );
  const isInputScreenResolved = (kind: "audio" | "subtitle") => {
    if (ignoreUndefinedByKind[kind]) return true;
    const rows = inputRows.filter((row) => row.kind === kind);
    if (rows.length === 0) return true;
    return rows.every((row) => {
      const decision = undefinedTrackDecisions[row.id];
      if (!decision || decision.keepUndefined) return false;
      return normalizeLanguageCode(decision.language) !== "und";
    });
  };

  const openInputResolver = () => {
    if (inputKinds.length === 0) return;
    const firstUnresolvedKindIndex = inputKinds.findIndex((kind) => !isInputScreenResolved(kind));
    setInputResolveIndex(firstUnresolvedKindIndex >= 0 ? firstUnresolvedKindIndex : 0);
    setInputResolveModalOpen(true);
  };

  useEffect(() => {
    if (inputKinds.length === 0) {
      setInputResolveIndex(0);
      setInputResolveModalOpen(false);
      return;
    }
    if (inputResolveIndex >= inputKinds.length) {
      setInputResolveIndex(inputKinds.length - 1);
    }
  }, [inputKinds.length, inputResolveIndex]);

  const setTrackDecision = (
    row: UndefinedTrackRow,
    next: Partial<UndefinedTrackDecision>
  ) => {
    setUndefinedTrackDecisions((prev) => ({
      ...prev,
      [row.id]: {
        language: next.language ?? prev[row.id]?.language ?? row.language ?? "und",
        label: next.label ?? prev[row.id]?.label ?? row.label ?? languageLabel(row.language),
        keepUndefined: next.keepUndefined ?? prev[row.id]?.keepUndefined ?? false,
      },
    }));
  };

  const stopAudioSample = () => {
    if (audioPlaybackRef.current.audio) {
      audioPlaybackRef.current.audio.pause();
      audioPlaybackRef.current.audio.currentTime = 0;
    }
    audioPlaybackRef.current = { id: null, audio: null };
    setAudioPlayingId(null);
  };

  const stopInputSamples = () => {
    stopAudioSample();
    setSubtitleSampleModalRowId(null);
  };

  const loadAudioSample = async (row: UndefinedTrackRow, force = false) => {
    if (audioSampleLoadingId === row.id) return;
    if (!force && audioSampleCache[row.id]) return audioSampleCache[row.id];
    const candidate = candidates.find((item) => item.id === row.candidateId);
    if (!candidate || !window.sf?.sampleAudioTrack) return;
    setAudioSampleLoadingId(row.id);
    try {
      const duration = candidate.probe?.durationSeconds ?? null;
      const maxStart = duration && duration > 65 ? Math.max(0, Math.floor(duration - 65)) : 0;
      const startSeconds = maxStart > 0 ? Math.floor(Math.random() * maxStart) : 0;
      const url = await window.sf.sampleAudioTrack({
        path: candidate.path,
        index: row.index,
        startSeconds,
        durationSeconds: 60,
      });
      if (url) {
        setAudioSampleCache((prev) => ({ ...prev, [row.id]: url }));
        return url;
      }
    } catch {
      toast(t("ingestion.toasts.audioSampleFailed"));
    } finally {
      setAudioSampleLoadingId(null);
    }
    return null;
  };

  const toggleAudioSample = async (row: UndefinedTrackRow) => {
    if (audioPlayingId === row.id) {
      stopAudioSample();
      return;
    }
    const source = audioSampleCache[row.id] ?? (await loadAudioSample(row));
    if (!source) return;
    stopAudioSample();
    const audio = new Audio(source);
    audioPlaybackRef.current = { id: row.id, audio };
    setAudioPlayingId(row.id);
    audio.onended = () => {
      if (audioPlaybackRef.current.id === row.id) {
        audioPlaybackRef.current = { id: null, audio: null };
        setAudioPlayingId(null);
      }
    };
    audio.onerror = () => {
      if (audioPlaybackRef.current.id === row.id) {
        audioPlaybackRef.current = { id: null, audio: null };
        setAudioPlayingId(null);
      }
    };
    await audio.play().catch(() => {
      setAudioPlayingId(null);
    });
  };

  const loadSubtitleSample = async (row: UndefinedTrackRow, force = false) => {
    if (!force && subtitleSampleCache[row.id]) return subtitleSampleCache[row.id];
    if (subtitleSampleLoadingId === row.id) return;
    const candidate = candidates.find((item) => item.id === row.candidateId);
    if (!candidate) {
      subtitleSampleLog.warn({ rowId: row.id, candidateId: row.candidateId }, "candidate_not_found");
      return;
    }
    if (!window.sf?.sampleSubtitleText) {
      subtitleSampleLog.warn({ rowId: row.id, candidatePath: candidate.path }, "api_unavailable");
      return;
    }
    setSubtitleSampleLoadingId(row.id);
    try {
      const isLikelyBlankImage = async (src: string) => {
        const image = await new Promise<HTMLImageElement>((resolve, reject) => {
          const element = new Image();
          element.onload = () => resolve(element);
          element.onerror = () => reject(new Error("image_load_failed"));
          element.src = src;
        });
        const width = image.naturalWidth;
        const height = image.naturalHeight;
        if (!width || !height) return true;
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) return false;
        context.drawImage(image, 0, 0, width, height);
        const data = context.getImageData(0, 0, width, height).data;
        let brightPixels = 0;
        const totalPixels = width * height;
        const step = Math.max(1, Math.floor(totalPixels / 120_000));
        for (let i = 0; i < totalPixels; i += step) {
          const offset = i * 4;
          const r = data[offset] ?? 0;
          const g = data[offset + 1] ?? 0;
          const b = data[offset + 2] ?? 0;
          const a = data[offset + 3] ?? 0;
          if (a > 8 && r + g + b > 36) {
            brightPixels += 1;
          }
        }
        return brightPixels < 30;
      };

      let sample =
        (await window.sf.sampleSubtitleText({
          path: candidate.path,
          index: row.index,
          external: candidate.kind === "subtitle",
          sampleIndex: 0,
        })) ?? null;
      subtitleSampleLog.debug({
        rowId: row.id,
        candidatePath: candidate.path,
        index: row.index,
        external: candidate.kind === "subtitle",
        kind: sample?.kind ?? "null",
      }, "sample_response");
      if (sample?.kind === "message") {
        subtitleSampleLog.warn({
          candidatePath: candidate.path,
          index: row.index,
          value: sample.value,
        }, "sample_message");
      }
      if (sample?.kind === "image") {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const blank = await isLikelyBlankImage(sample.value).catch(() => false);
          if (!blank) break;
          sample = await window.sf.sampleSubtitleText({
            path: candidate.path,
            index: row.index,
            external: candidate.kind === "subtitle",
            sampleIndex: attempt + 1,
          });
          if (!sample || sample.kind !== "image") break;
        }
      }
      const next = sample ?? { kind: "message", value: t("ingestion.samples.noSubtitleSample") };
      setSubtitleSampleCache((prev) => ({
        ...prev,
        [row.id]: next,
      }));
      return next;
    } catch (error) {
      subtitleSampleLog.warn({
        rowId: row.id,
        candidatePath: candidate.path,
        index: row.index,
        error: error instanceof Error ? error.message : String(error),
      }, "sample_exception");
      const fallback = { kind: "message" as const, value: t("ingestion.samples.subtitleSampleFailed") };
      setSubtitleSampleCache((prev) => ({
        ...prev,
        [row.id]: fallback,
      }));
      return fallback;
    } finally {
      setSubtitleSampleLoadingId(null);
    }
  };

  const toggleSubtitleSample = async (row: UndefinedTrackRow) => {
    setSubtitleSampleModalRowId(row.id);
    void loadSubtitleSample(row, true);
  };

  const toggleIgnoreUndefinedForKind = (kind: "audio" | "subtitle", checked: boolean) => {
    setIgnoreUndefinedByKind((prev) => ({ ...prev, [kind]: checked }));
    if (!checked) return;
    const rows = inputRows.filter((row) => row.kind === kind);
    setUndefinedTrackDecisions((prev) => {
      const next = { ...prev };
      rows.forEach((row) => {
        next[row.id] = {
          language: "und",
          label: row.label,
          keepUndefined: true,
        };
      });
      return next;
    });
  };

  const validateInputScreen = (kind: "audio" | "subtitle" | null) => {
    if (!kind) return true;
    if (ignoreUndefinedByKind[kind]) return true;
    const rows = inputRows.filter((row) => row.kind === kind);
    for (const row of rows) {
      const decision = undefinedTrackDecisions[row.id];
      if (!decision || decision.keepUndefined || normalizeLanguageCode(decision.language) === "und") {
        toast(t("ingestion.toasts.setTrackLanguages"));
        return false;
      }
    }
    return true;
  };

  const activeSubtitleSample = subtitleSampleModalRowId ? subtitleSampleCache[subtitleSampleModalRowId] : null;

  const cropSubtitleSampleImage = async (src: string) => {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("image_load_failed"));
      element.src = src;
    });
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (!width || !height) return src;

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return src;
    context.drawImage(image, 0, 0, width, height);
    const data = context.getImageData(0, 0, width, height).data;

    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < height; y += 1) {
      const rowOffset = y * width * 4;
      for (let x = 0; x < width; x += 1) {
        const i = rowOffset + x * 4;
        const r = data[i] ?? 0;
        const g = data[i + 1] ?? 0;
        const b = data[i + 2] ?? 0;
        const a = data[i + 3] ?? 0;
        const brightness = r + g + b;
        if (a > 8 && brightness > 40) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < minX || maxY < minY) return src;

    const boxWidth = maxX - minX + 1;
    const boxHeight = maxY - minY + 1;
    const areaRatio = (boxWidth * boxHeight) / (width * height);
    if (areaRatio > 0.45) return src;

    const padX = Math.max(24, Math.floor(boxWidth * 0.2));
    const padY = Math.max(16, Math.floor(boxHeight * 0.8));
    const cropX = Math.max(0, minX - padX);
    const cropY = Math.max(0, minY - padY);
    const cropW = Math.min(width - cropX, boxWidth + padX * 2);
    const cropH = Math.min(height - cropY, boxHeight + padY * 2);

    const out = document.createElement("canvas");
    out.width = cropW;
    out.height = cropH;
    const outContext = out.getContext("2d");
    if (!outContext) return src;
    outContext.drawImage(canvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
    return out.toDataURL("image/png");
  };

  /** One movie, or each episode of a show: the slots Add imports. */
  const listEpisodeGroups = (group: MergedGroup): EpisodeGroup[] =>
    group.episodeGroups && group.episodeGroups.length > 0
      ? group.episodeGroups
      : [
          {
            id: group.id,
            season: group.candidates[0]?.parsed?.season ?? null,
            episode: group.candidates[0]?.parsed?.episode ?? null,
            candidates: group.candidates,
            audioTracks: group.audioTracks ?? [],
            subtitleTracks: group.subtitleTracks ?? [],
            videoVariants: group.videoVariants ?? [],
          },
        ];

  /** The video versions of one slot Add uploads: no quality the library already has, and the user's decisions. */
  const selectSlotVideos = (
    match: NonNullable<MergedGroup["match"]>,
    existingMedia: MediaRow | null,
    episodeGroup: EpisodeGroup,
    videoCandidates: Candidate[],
  ) => {
    const episodeSummary = buildTrackSummary(videoCandidates, languageLabel);
    const selectedVersions = buildSelectedVideoVariants(episodeSummary.videoVariants, clientConfig.enableCodecSelection);
    const existingQualities = existingMedia?.hasFiles
      ? getExistingQualities(match, episodeGroup.season, episodeGroup.episode)
      : new Set<string>();
    const selectedForImport = selectedVersions.filter((entry) => {
      if (existingQualities.has(entry.quality)) {
        return false;
      }
      if (!existingMedia?.hasFiles) return true;
      const decision = videoDecisions[`${episodeGroup.id}:${entry.quality}`];
      if (!decision) return false;
      return decision === "add";
    });
    return { episodeSummary, selectedVersions, existingQualities, selectedForImport };
  };

  /** INGS-QUOTA-01: what each movie/episode of this import adds to the account's storage. */
  const buildQuotaItems = (candidateIds: ReadonlySet<string>): QuotaDialogItem[] => {
    const items: QuotaDialogItem[] = [];
    for (const group of mergedGroups) {
      const match = group.match;
      if (!match) continue;
      const existingMedia = media.find((item) => item.catalogId === match.id && item.type === match.type) ?? null;
      for (const episodeGroup of listEpisodeGroups(group)) {
        const videoCandidates = episodeGroup.candidates.filter(
          (candidate) => candidateIds.has(candidate.id) && candidate.kind === "video",
        );
        if (videoCandidates.length === 0) continue;
        const { selectedForImport } = selectSlotVideos(match, existingMedia, episodeGroup, videoCandidates);
        if (selectedForImport.length === 0) continue;
        const bytes = estimateImportItemBytes({
          sources: selectedForImport.map((entry) => ({
            sizeBytes: entry.candidate.size ?? null,
            quality: entry.quality === "unknown" ? null : entry.quality,
            durationSeconds: entry.candidate.probe?.durationSeconds ?? null,
          })),
          outputs: ingestOutputs,
          mediaType: match.type,
        });
        const label =
          match.type === "tv" && episodeGroup.season !== null && episodeGroup.episode !== null
            ? `${match.title} – S${String(episodeGroup.season).padStart(2, "0")}E${String(episodeGroup.episode).padStart(2, "0")}`
            : match.title;
        items.push({ id: episodeGroup.id, label, bytes });
      }
    }
    return items;
  };

  /**
   * `bypassQuota`: the quota window was answered (upgrade, current plan, or a selection).
   * `onlyItemIds`: the movies/episodes ticked in that window; the others stay out of the import.
   */
  const handleAdd = async ({ bypassQuota = false, onlyItemIds }: { bypassQuota?: boolean; onlyItemIds?: ReadonlySet<string> } = {}) => {
    if (candidates.length === 0) return;
    if (
      unmatchedCandidates.length > 0 ||
      searchingCandidates.length > 0 ||
      unresolvedVideoDecisions.length > 0 ||
      unresolvedInputCount > 0 ||
      pendingSkipDataCount > 0
    ) return;
    const readyCandidates = candidates.filter((c) => c.status === "ready" && c.match);

    // INGS-QUOTA-01/02: check the import fits before anything is submitted. Without a
    // storage summary (offline, fetch failed) the server's own refusal stays the backstop.
    if (!bypassQuota && storageSummary) {
      const items = buildQuotaItems(new Set(readyCandidates.map((candidate) => candidate.id)));
      const pendingLocalBytes = estimatePendingLocalBytes(getRuntimeJobsSnapshot().byId.values());
      const verdict = evaluateImportQuota({
        items,
        storage: storageSummary,
        pendingLocalBytes,
        billingPeriod: loadBillingPeriod(),
      });
      ingestLog.info(
        {
          verdict: verdict.verdict,
          items: items.length,
          neededBytes: verdict.neededBytes,
          spaceLeftBytes: verdict.spaceLeftBytes,
          pendingLocalBytes,
          usageRatioAfter: verdict.usageRatioAfter,
          plan: storageSummary.plan,
          smallestFittingPlan: verdict.smallestFittingPlan,
          nextPlan: verdict.nextPlan,
        },
        "import-quota.checked",
      );
      if (verdict.verdict !== "fits" && items.length > 0) {
        ingestLog.info({ verdict: verdict.verdict, items: items.length }, "import-quota.shown");
        setQuotaGate({ items, pendingLocalBytes });
        return;
      }
    }

    setAdding(true);
    const duplicatesByPath = new Map<string, Candidate>();
    const deduped: Candidate[] = [];
    readyCandidates.forEach((candidate) => {
      if (duplicatesByPath.has(candidate.path)) {
        return;
      }
      duplicatesByPath.set(candidate.path, candidate);
      deduped.push(candidate);
    });
    if (deduped.length !== readyCandidates.length) {
      const diff = readyCandidates.length - deduped.length;
      toast(t("ingestion.toasts.removedDuplicates", { count: diff }));
    }
    // Movies/episodes left unticked in the quota window stay out of the import (INGS-QUOTA-01).
    const keptSlotCandidateIds = onlyItemIds
      ? new Set(
          mergedGroups.flatMap((group) =>
            listEpisodeGroups(group)
              .filter((episodeGroup) => onlyItemIds.has(episodeGroup.id))
              .flatMap((episodeGroup) => episodeGroup.candidates.map((candidate) => candidate.id)),
          ),
        )
      : null;
    const dedupedIds = new Set(
      deduped.map((candidate) => candidate.id).filter((id) => !keptSlotCandidateIds || keptSlotCandidateIds.has(id)),
    );
    const subtitleAutoOverrideByCandidate = new Map<string, Array<{ index: number; language: string; label: string }>>();
    deduped.forEach((candidate) => {
      if (candidate.kind !== "video" || !candidate.probe?.subtitleTracks?.length) return;
      const byIndex = new Map<number, { index: number; language: string; label: string }>();
      candidate.probe.subtitleTracks.forEach((track) => {
        const language = normalizeLanguageCode(track.language);
        if (language === "und") return;
        const normalizedLabel = normalizeTrackLabelForUi(track.label, language);
        const label = normalizedLabel.trim() || languageLabel(language);
        byIndex.set(track.index, { index: track.index, language, label });
      });
      if (byIndex.size > 0) {
        subtitleAutoOverrideByCandidate.set(candidate.id, Array.from(byIndex.values()));
      }
    });
    const { audioOverrideByCandidate, subtitleOverrideByCandidate } =
      buildFileIngestionTrackOverrideMaps({
        decisions: undefinedTrackDecisions,
        rows: undefinedTrackRows,
        normalizeLanguageCode,
        languageLabel,
      });
    const mergedSubtitleOverrideByCandidate = new Map<string, Array<{ index: number; language: string; label: string }>>();
    const mergeSubtitleOverrides = (candidateId: string, list: Array<{ index: number; language: string; label: string }>) => {
      const byIndex = new Map<number, { index: number; language: string; label: string }>();
      (mergedSubtitleOverrideByCandidate.get(candidateId) ?? []).forEach((entry) => byIndex.set(entry.index, entry));
      list.forEach((entry) => byIndex.set(entry.index, entry));
      mergedSubtitleOverrideByCandidate.set(candidateId, Array.from(byIndex.values()));
    };
    subtitleAutoOverrideByCandidate.forEach((list, candidateId) => mergeSubtitleOverrides(candidateId, list));
    subtitleOverrideByCandidate.forEach((list, candidateId) => mergeSubtitleOverrides(candidateId, list));

    const actions: LabQueueAction[] = [];
    // Subtitle files attached next to a video upload AFTER the submit, under
    // the placementId of the source they belong to (#145, one media = one
    // silo). See fileIngestionSubtitlePlacement.ts.
    const pendingSubtitles: Array<{
      candidate: Candidate;
      mediaId: string;
      mediaType: "movie" | "tv";
      season: number | null;
      episode: number | null;
      language: string;
      label: string;
      bindFilename: string | null;
    }> = [];
    let uploadedSubtitleCount = 0;
    let skippedVideoOverlapCount = 0;
    const queuedCatalogKeys = new Set<string>();
    // Titles whose metadata could not be fetched even after waiting out the service's Retry-After: the others are
    // still added, these stay in the dialog to try again (their candidate ids, subtitles included).
    const failedMetadataCandidateIds = new Set<string>();
    let failedMetadataTitles = 0;

    for (const group of mergedGroups) {
      const match = group.match;
      if (!match) continue;
      const groupCandidates = group.candidates.filter((candidate) => dedupedIds.has(candidate.id));
      if (groupCandidates.length === 0) continue;
      const hasVideoCandidates = groupCandidates.some((candidate) => candidate.kind === "video");
      const hasSubtitleCandidates = groupCandidates.some((candidate) => candidate.kind === "subtitle");

      const existingMedia = media.find((item) => item.catalogId === match.id && item.type === match.type) ?? null;

      let resolvedMedia: MediaRow | null = existingMedia;
      if (!resolvedMedia && hasVideoCandidates) {
        try {
          if (!token) {
            throw new Error("AUTH_REQUIRED");
          }
          // ACCT-PROF-03: titles + artwork are stored in the account's language; the original set a profile may
          // want is fetched in the background (`titleVariantsPass`). Descriptions stay live.
          const details = await withMetadataRetry(() =>
            getTitleDetailsForLibrary(token, match.type, match.id, { accountLanguage: i18n.language || "en" })
          );
          const mediaId = await addMediaFromCatalog(details);
          const now = new Date().toISOString();
          resolvedMedia = {
            id: mediaId,
            type: details.type,
            catalogId: details.id ?? null,
            title: details.title ?? "",
            originalTitle: details.originalTitle ?? null,
            originalLanguage: details.originalLanguage ?? null,
            overview: details.overview ?? null,
            year: details.year ?? null,
            rating: details.rating ?? null,
            posterPath: details.posterPath ?? null,
            backdropPath: details.backdropPath ?? null,
            genres: details.genres ?? [],
            addedAt: now,
            updatedAt: now,
            hasFiles: false,
            progressPct: 0,
            lastWatchedAt: null,
            totalEpisodes: details.totalEpisodes ?? null,
            episodeCount: details.totalEpisodes ?? 0,
          };
        } catch (error) {
          ingestLog.warn(
            { errorName: error instanceof Error ? error.name : "unknown", message: error instanceof Error ? error.message : String(error) },
            "addMetadataFailed",
          );
          failedMetadataTitles += 1;
          group.candidates.forEach((candidate) => failedMetadataCandidateIds.add(candidate.id));
          continue;
        }
      }
      if (!resolvedMedia && hasSubtitleCandidates) {
        toast(t("ingestion.toasts.mediaNotInLibrary", { title: group.match.title }));
        continue;
      }
      if (!resolvedMedia) {
        continue;
      }
      if (hasVideoCandidates && Number.isFinite(Number(match.id))) {
        queuedCatalogKeys.add(`${match.type}:${Number(match.id)}`);
      }

      const episodeGroups = listEpisodeGroups(group);

      for (const episodeGroup of episodeGroups) {
        const slotCandidates = episodeGroup.candidates.filter((candidate) => dedupedIds.has(candidate.id));
        if (slotCandidates.length === 0) continue;
        const videoCandidates = slotCandidates.filter((candidate) => candidate.kind === "video");
        const subtitleCandidates = slotCandidates.filter((candidate) => candidate.kind === "subtitle");
        const groupId = crypto.randomUUID();
        const { episodeSummary, selectedVersions, existingQualities, selectedForImport } = selectSlotVideos(
          match,
          existingMedia,
          episodeGroup,
          videoCandidates,
        );
        skippedVideoOverlapCount += selectedVersions.filter((entry) => existingQualities.has(entry.quality)).length;
        const selectedIds = new Set<string>(selectedForImport.map((entry) => entry.candidate.id));

        const chapterSource =
          selectedForImport
            .filter((entry) => entry.hasChapters)
            .sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality))[0] ?? null;

        const transcodeSource =
          selectedForImport.find((entry) => entry.quality === "1080p") ??
          selectedForImport.sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality))[0];

        const trackSelection = resolveTrackSelection(
          episodeGroup.id,
          episodeSummary.audioTracks,
          episodeSummary.subtitleTracks
        );
        const effectiveAudioKeys = trackSelection.audio;
        const effectiveSubtitleKeys = trackSelection.subtitles;

        const allTrackCandidates = [
          ...videoCandidates.filter((candidate) => !selectedIds.has(candidate.id)),
          ...selectedForImport.map((entry) => entry.candidate),
        ];

        const audioRefs = new Map<string, Array<{ candidateId: string; index: number }>>();
        const subtitleRefs = new Map<string, Array<{ candidateId: string; index: number }>>();
        episodeSummary.audioTracks.forEach((track) => {
          if (!effectiveAudioKeys.has(track.key)) return;
          audioRefs.set(track.key, track.refs);
        });
        episodeSummary.subtitleTracks.forEach((track) => {
          if (!effectiveSubtitleKeys.has(track.key)) return;
          subtitleRefs.set(track.key, track.refs);
        });

        const perCandidateAudio = new Map<string, Set<number>>();
        audioRefs.forEach((refs) => {
          refs.forEach((ref) => {
            const set = perCandidateAudio.get(ref.candidateId) ?? new Set<number>();
            set.add(ref.index);
            perCandidateAudio.set(ref.candidateId, set);
          });
        });
        const perCandidateSubs = new Map<string, Set<number>>();
        subtitleRefs.forEach((refs) => {
          refs.forEach((ref) => {
            const set = perCandidateSubs.get(ref.candidateId) ?? new Set<number>();
            set.add(ref.index);
            perCandidateSubs.set(ref.candidateId, set);
          });
        });

        const files: LabQueueFileInput[] = selectedForImport.map((entry) => {
          const { candidate, quality, codec } = entry;
          const normalizedCodec = codec === "unknown" ? pickPreferredCodec(quality, ["hevc", "h264"]) : codec;
          const selectedFormats =
            quality === "unknown"
              ? undefined
              : [{ quality, codec: normalizedCodec === "unknown" ? "h264" : normalizedCodec }];
          const videoMeta = candidate.probe?.video
            ? {
                width: candidate.probe.video.width ?? 0,
                height: candidate.probe.video.height ?? 0,
                durationSec: candidate.probe.durationSeconds ?? 0,
                // The real source codec (av1, vp9 ... included); "unknown" only when the probe reported none.
                codec,
              }
            : undefined;
          const audioIndexes = Array.from(perCandidateAudio.get(candidate.id) ?? []);
          const subtitleIndexes = Array.from(perCandidateSubs.get(candidate.id) ?? []);
          return {
            id: crypto.randomUUID(),
            filename: candidate.path,
            sizeMb: candidate.size ? Math.round(candidate.size / (1024 * 1024)) : null,
            sourceQuality: quality === "unknown" ? undefined : quality,
            groupId,
            jobType: "source",
            includeSource: true,
            includeFallback: false,
            // Keep source imports playable: always extract at least one audio track.
            includeAudio: true,
            includeSubtitles: subtitleIndexes.length > 0,
            includeChapters: chapterSource?.candidate.id === candidate.id,
            audioTrackIndexes: audioIndexes.length > 0 ? audioIndexes : undefined,
            subtitleTrackIndexes: subtitleIndexes.length > 0 ? subtitleIndexes : undefined,
            audioTrackOverrides: audioOverrideByCandidate.get(candidate.id),
            subtitleTrackOverrides: mergedSubtitleOverrideByCandidate.get(candidate.id),
            selectedFormats,
            videoMeta,
          } as LabQueueFileInput;
        });

        allTrackCandidates
          .filter((candidate) => !selectedIds.has(candidate.id))
          .forEach((candidate) => {
          const audioIndexes = Array.from(perCandidateAudio.get(candidate.id) ?? []);
          const subtitleIndexes = Array.from(perCandidateSubs.get(candidate.id) ?? []);
          if (audioIndexes.length === 0 && subtitleIndexes.length === 0) return;
          files.push({
            id: crypto.randomUUID(),
            filename: candidate.path,
            sizeMb: candidate.size ? Math.round(candidate.size / (1024 * 1024)) : null,
            sourceQuality: undefined,
            groupId,
            jobType: "source",
            includeSource: false,
            includeFallback: false,
            includeAudio: audioIndexes.length > 0,
            includeSubtitles: subtitleIndexes.length > 0,
            includeChapters: false,
            audioTrackIndexes: audioIndexes,
            subtitleTrackIndexes: subtitleIndexes,
            audioTrackOverrides: audioOverrideByCandidate.get(candidate.id),
            subtitleTrackOverrides: mergedSubtitleOverrideByCandidate.get(candidate.id),
            selectedFormats: [],
            videoMeta: undefined,
          } as LabQueueFileInput);
        });

        const desiredOutputs = ingestOutputs;
        const availableQualities = new Set(selectedForImport.map((entry) => entry.quality));
        existingQualities.forEach((quality) => availableQualities.add(quality));
        const missingOutputs = desiredOutputs.filter((output) => !availableQualities.has(output.quality));

        if (transcodeSource && missingOutputs.length > 0) {
          files.push({
            id: crypto.randomUUID(),
            filename: transcodeSource.candidate.path,
            sizeMb: transcodeSource.candidate.size ? Math.round(transcodeSource.candidate.size / (1024 * 1024)) : null,
            sourceQuality: undefined,
            groupId,
            jobType: "transcode",
            includeSource: false,
            includeFallback: true,
            includeAudio: false,
            includeSubtitles: false,
            includeChapters: false,
            audioTrackIndexes: undefined,
            subtitleTrackIndexes: undefined,
            audioTrackOverrides: undefined,
            subtitleTrackOverrides: undefined,
            selectedFormats: missingOutputs.map((output) => ({ quality: output.quality, codec: output.codec })),
            videoMeta: undefined,
          } as LabQueueFileInput);
        }

        const preset = {
          media: resolvedMedia!,
          season: episodeGroup.season ?? undefined,
          episode: episodeGroup.episode ?? undefined,
        };

        ingestLog.debug({
          media: match.title,
          type: match.type,
          season: episodeGroup.season,
          episode: episodeGroup.episode,
          files: files.map((file) => ({
            filename: file.filename,
            jobType: file.jobType,
            includeSource: file.includeSource,
            includeFallback: file.includeFallback,
            includeAudio: file.includeAudio,
            includeSubtitles: file.includeSubtitles,
            includeChapters: file.includeChapters,
            selectedFormats: file.selectedFormats,
            audioTrackIndexes: file.audioTrackIndexes,
            subtitleTrackIndexes: file.subtitleTrackIndexes,
          })),
        }, "queue_files");

        if (files.length > 0) {
          actions.push({
            type: "queue_files",
            files,
            preset,
          });
        }

        if (subtitleCandidates.length > 0) {
          if (!token || !window.sf?.uploadSubtitleFile) {
            setAdding(false);
            toast(t("ingestion.toasts.subtitleUploadsUnavailable"));
            return;
          }
          if (match.type === "tv" && (episodeGroup.season === null || episodeGroup.episode === null)) {
            toast(t("ingestion.toasts.pickEpisodeForSubtitles", { title: group.match.title }));
            continue;
          }
          const bindFilename = pickSubtitleBindFilename(files, transcodeSource?.candidate.path ?? null);
          for (const candidate of subtitleCandidates) {
            const rowId = `${candidate.id}:subtitle:0`;
            const subtitleOverride = undefinedTrackDecisions[rowId];
            const language = normalizeLanguageCode(
              subtitleOverride?.language ?? candidate.subtitleDraft?.language ?? "und"
            );
            const label =
              (subtitleOverride?.label ?? candidate.subtitleDraft?.label ?? "").trim() || languageLabel(language);
            pendingSubtitles.push({
              candidate,
              mediaId: resolvedMedia.id,
              mediaType: match.type,
              season: match.type === "tv" ? episodeGroup.season : null,
              episode: match.type === "tv" ? episodeGroup.episode : null,
              language,
              label,
              bindFilename,
            });
          }
        }
      }
    }

    const toastFailedMetadata = () => {
      if (failedMetadataTitles === 0) return;
      toast(
        failedMetadataTitles === 1
          ? t("ingestion.toasts.addMetadataFailedSingle")
          : t("ingestion.toasts.addMetadataFailedMany", { count: failedMetadataTitles })
      );
    };
    if (actions.length === 0 && pendingSubtitles.length === 0) {
      setAdding(false);
      toastFailedMetadata();
      if (skippedVideoOverlapCount > 0) {
        toast(
          skippedVideoOverlapCount === 1
            ? t("ingestion.toasts.skippedDuplicateSingle")
            : t("ingestion.toasts.skippedDuplicateMany", { count: skippedVideoOverlapCount })
        );
      }
      return;
    }

    const queuedTypes = new Set<"movie" | "tv">();
    let queuedTitles = 0;
    actions.forEach((action) => {
      if (action.type !== "queue_files") return;
      const kind = action.preset?.media?.type ?? action.preset?.pendingMedia?.type;
      if (kind === "movie" || kind === "tv") {
        queuedTypes.add(kind);
      }
      queuedTitles += 1;
    });

    // V2 ingest submission. We only translate `queue_files` actions — every
    // other action type (manual match, format toggles) is a no-op in V2
    // because V2 has no such state model.
    let applyPromise: Promise<{ submitted: Array<{ placementId: string | null }> }> | undefined;
    let submittedSources: V2SubmitSource[] = [];
    {
      const desiredFormats = ingestOutputs
        .map((o) => o.quality)
        .filter((q): q is "144p" | "240p" | "360p" | "480p" | "720p" | "1080p" =>
          q === "144p" || q === "240p" || q === "360p" || q === "480p" || q === "720p" || q === "1080p",
        );
      // Bugfix (effervescent-teapot symptom A): the legacy `queue_files`
      // action embeds BOTH the real source AND a synthetic transcode
      // placeholder as separate file entries. V2 derives format jobs from
      // `desiredFormats` itself, so forwarding the placeholder as a second
      // source produced 4 jobs per movie (2 sources × (1 source + 1 format)).
      // The translator filters non-source entries before flatMapping.
      const showSkipDataByCatalogId = new Map<number, BadgerIngestShowSkipCache>();
      candidates.forEach((c) => {
        const data = c.skipMarkerData;
        // "unavailable" (every episode a miss) still travels: the runtime
        // records the misses so the library backfill does not ask again.
        if (!data || data.status === "fetching" || data.coverage.length === 0) return;
        if (c.match?.type !== "tv") return;
        if (showSkipDataByCatalogId.has(data.showCatalogId)) return;
        showSkipDataByCatalogId.set(data.showCatalogId, {
          showCatalogId: data.showCatalogId,
          provider: SKIP_MARKER_PROVIDER,
          fetchedAt: data.fetchedAt,
          coverage: data.coverage,
          markersByEpisode: data.markersByEpisode,
        });
      });
      const sources = translateActionsToV2Sources(actions, desiredFormats, {
        showSkipDataByCatalogId,
      });
      submittedSources = sources;
      applyPromise = sources.length > 0 && window.sf?.runtimeJobs?.submitSources && user
        ? window.sf.runtimeJobs.submitSources({ userId: user.id, sources })
        : undefined;
    }
    const uploadPendingSubtitles = async (placementByFilename: Map<string, string>) => {
      const uploadSubtitleFile = window.sf?.uploadSubtitleFile;
      if (pendingSubtitles.length === 0 || !token || !uploadSubtitleFile) return;
      for (const pending of pendingSubtitles) {
        const boundPlacementId = pending.bindFilename ? placementByFilename.get(pending.bindFilename) : undefined;
        const placementId =
          boundPlacementId ??
          existingMediaPlacementId(await fetchMediaDetails(pending.mediaId), pending.season, pending.episode);
        ingestLog.debug(
          {
            subtitle: pending.candidate.name,
            mediaId: pending.mediaId,
            season: pending.season,
            episode: pending.episode,
            bindFilename: pending.bindFilename,
            placementId,
            placementSource: boundPlacementId ? "submitted-source" : placementId ? "existing-media" : "fresh",
          },
          "subtitle_placement"
        );
        try {
          const uploaded = await uploadSubtitleFile({ token, path: pending.candidate.path, placementId });
          if (!uploaded?.key) {
            throw new Error("subtitle_upload_failed");
          }
          await addSubtitleTrackWithObject({
            mediaId: pending.mediaId,
            fileId: sidecarSubtitleFileId(pending.candidate.id),
            season: pending.season,
            episode: pending.episode,
            language: pending.language,
            label: pending.label,
            objectKey: uploaded.key,
            format: subtitleFormatFromName(pending.candidate.name),
            isDefault: false,
            source: "upload",
          });
          uploadedSubtitleCount += 1;
        } catch {
          toast(t("ingestion.toasts.subtitleUploadFailed", { name: pending.candidate.name }));
        }
      }
    };
    try {
      if (actions.length > 0 && !applyPromise) {
        throw new Error("ingestion_queue_unavailable");
      }
      const submitResult = actions.length > 0 ? await applyPromise : undefined;
      await uploadPendingSubtitles(placementIdsBySourceFilename(submittedSources, submitResult?.submitted ?? []));
      await waitForQueuedTitlesVisible(queuedCatalogKeys, 2200, "any");
      if (failedMetadataTitles > 0) {
        // Partial progress is kept: what was queued leaves the dialog, the failed titles stay for another try.
        setCandidates((prev) => prev.filter((candidate) => failedMetadataCandidateIds.has(candidate.id)));
        toastFailedMetadata();
      } else {
        closeIngestionDialog();
      }
      if (queuedTitles > 0) {
        showQueuedConfirmation(queuedTypes, queuedTitles);
      }
      if (uploadedSubtitleCount > 0) {
        notifySuccess(
          uploadedSubtitleCount === 1
            ? t("ingestion.toasts.subtitleTrackAddedSingle")
            : t("ingestion.toasts.subtitleTrackAddedMany", { count: uploadedSubtitleCount })
        );
      }
    } catch (err) {
      ingestLog.error(
        { message: err instanceof Error ? err.message : String(err) },
        "queueFailed",
      );
      notify({ title: "Error", message: t("ingestion.toasts.queueFailed"), level: "error" });
    } finally {
      setAdding(false);
    }
  };

  const applyResolveDecision = (decision: VideoDecision) => {
    const item = activeResolveItem;
    if (!item) return;
    setVideoDecisions((prev) => ({ ...prev, [item.id]: decision }));
    if (resolveIndex >= resolveDecisionItems.length - 1) {
      setResolveModalOpen(false);
      setResolveIndex(0);
      return;
    }
    setResolveIndex((prev) => prev + 1);
  };

  useEffect(() => {
    const handleE2eSeed = (event: Event) => {
      const custom = event as CustomEvent<{ candidates?: E2eSeedCandidate[] }>;
      const rawCandidates = Array.isArray(custom.detail?.candidates) ? custom.detail.candidates : [];
      if (rawCandidates.length === 0) return;
      const seeded: Candidate[] = rawCandidates.map((item, index) => ({
        id: item.id || `e2e-seed-${index}-${item.name}`,
        path: item.path || item.name,
        name: item.name,
        size: item.size ?? 0,
        kind: item.kind ?? "video",
        parsed: item.parsed ?? parseFilename(item.name),
        match: item.match ?? null,
        probe: item.probe,
        probeError: item.probeError,
        status: item.status ?? "ready",
        error: item.error,
        errorHint: item.errorHint,
        searchUnavailable: item.searchUnavailable,
        manualQuery: item.manualQuery,
        selected: true,
        subtitleDraft: item.subtitleDraft,
      }));
      setCandidates(seeded);
      setScanning(false);
      setScanError(null);
      setSelectionMode("candidate");
      setSelectedIndex(0);
      setManualSearchQuery("");
      setManualSearchResults([]);
      setManualSearchOpen(true);
      setManualSearchType("movie");
    };
    window.addEventListener("sf:e2e-seed-ingestion", handleE2eSeed as EventListener);
    return () => {
      window.removeEventListener("sf:e2e-seed-ingestion", handleE2eSeed as EventListener);
    };
  }, []);

  return (
    <>
      <ImportReviewDialog
        open={open}
        onOpenChange={handleDialogOpenChange}
        title={t("ingestion.ui.title")}
        // UX-TOUR-01 step 2: the first-open tour shows its card here once the dialog lists what it found.
        data-tour={candidates.length > 0 && !scanning ? "import-review" : undefined}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDraggingLocal(true);
        }}
        onDragLeave={() => setIsDraggingLocal(false)}
        onDrop={handleLocalDrop}
      >
          <ImportReviewBody>
          {isDraggingLocal && (
            <div className="absolute inset-0 z-50 flex items-center justify-center bg-primary/10 pointer-events-none border-2 border-dashed border-primary m-4 rounded-3xl">
              <div className="text-xl font-bold text-primary">{t("ingestion.ui.dropMore")}</div>
            </div>
          )}

          {candidates.length === 0 && !scanning ? (
            <ImportReviewPicker
              icon={<Upload className="h-10 w-10 text-muted-foreground" />}
              title={t("ingestion.ui.emptyTitle")}
              subtitle={t("ingestion.ui.emptySubtitle")}
              error={scanError}
              browseFilesLabel={t("ingestion.ui.browseFiles")}
              browseFoldersLabel={t("ingestion.ui.browseFolders")}
              onBrowse={(kind) => handleNativeBrowse(kind)}
              disabled={!hasNativeFs}
            />
          ) : (
            <>
              {/* Left: File List */}
              <ImportReviewList>
                {mergedGroups.length > 0 ? (
                  <>
                    {groupsNeedingDecision.length > 0 ? (
                      <div className="px-4 py-2 text-[11px] uppercase tracking-[0.2em] text-amber-300">{t("ingestion.ui.needsDecision")}</div>
                    ) : null}
                    {groupsNeedingDecision.map((group) => {
                      const i = groupIndexById.get(group.id) ?? 0;
                      const unresolvedCount = unresolvedVideoDecisions.filter((item) => item.groupId === group.id).length;
                      const fileCount = group.candidates.length;
                      const episodeCount = group.episodeGroups?.length ?? 0;
                      return (
                        <div
                          key={group.id}
                          className={`p-4 border-b border-border/50 cursor-pointer transition-colors hover:bg-muted/20 ${
                            selectionMode === "group" && i === selectedGroupIndex ? "bg-muted/30 border-l-4 border-l-primary" : ""
                          }`}
                          onClick={() => { setSelectionMode("group"); setSelectedGroupIndex(i); setSelectedSeasonKey(null); setSelectedEpisodeId(null); setManualSearchQuery(""); setManualSearchResults([]); }}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                {group.match.type === "movie" ? (
                                  <Film className="h-3.5 w-3.5 text-muted-foreground" />
                                ) : (
                                  <Tv className="h-3.5 w-3.5 text-muted-foreground" />
                                )}
                                <div className="font-medium text-sm truncate" title={group.match.title}>{group.match.title}</div>
                              </div>
                              <div className="text-xs text-muted-foreground mt-1">{group.match.year}</div>
                              <div className="text-[11px] text-muted-foreground mt-1">
                                {group.match.type === "tv"
                                  ? `${episodeCount} ${episodeCount === 1 ? t("ingestion.ui.episode") : t("ingestion.ui.episodesLower")} · ${fileCount} ${
                                      fileCount === 1 ? t("ingestion.ui.file") : t("ingestion.ui.files")
                                    }`
                                  : `${fileCount} ${fileCount === 1 ? t("ingestion.ui.file") : t("ingestion.ui.files")}`}
                              </div>
                              <div className="mt-2 text-[11px] text-amber-300">
                                {t("ingestion.ui.videoDecisionsPending", {
                                  count: unresolvedCount,
                                  decisionLabel: unresolvedCount === 1 ? t("ingestion.ui.videoDecision") : t("ingestion.ui.videoDecisions"),
                                })}
                              </div>
                            </div>
                            <div className="shrink-0 flex items-center gap-2">
                              <AlertCircle className="h-4 w-4 text-amber-400" />
                              <button
                                type="button"
                                className="rounded-full p-1 text-muted-foreground hover:text-foreground hover:bg-muted/40"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  const candidateIds = new Set(group.candidates.map((c) => c.id));
                                  setCandidates((prev) => prev.filter((c) => !candidateIds.has(c.id)));
                                  setTrackSelections((prev) => {
                                    const next = { ...prev };
                                    delete next[group.id];
                                    group.episodeGroups?.forEach((episodeGroup) => {
                                      delete next[episodeGroup.id];
                                    });
                                    return next;
                                  });
                                  if (selectionMode === "group" && i === selectedGroupIndex) {
                                    setSelectionMode("candidate");
                                    setSelectedIndex(0);
                                  }
                                }}
                                aria-label={t("ingestion.ui.removeGroup")}
                              >
                                <X className="h-3 w-3" />
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                    {groupsNeedingInput.length > 0 ? (
                      <div className="px-4 py-2 text-[11px] uppercase tracking-[0.2em] text-amber-300">{t("ingestion.ui.needsInput")}</div>
                    ) : null}
                    {groupsNeedingInput.map((group) => {
                      const i = groupIndexById.get(group.id) ?? 0;
                      const fileCount = group.candidates.length;
                      const episodeCount = group.episodeGroups?.length ?? 0;
                      return (
                        <div
                          key={group.id}
                          className={`p-4 border-b border-border/50 cursor-pointer transition-colors hover:bg-muted/20 ${
                            selectionMode === "group" && i === selectedGroupIndex ? "bg-muted/30 border-l-4 border-l-primary" : ""
                          }`}
                          onClick={() => { setSelectionMode("group"); setSelectedGroupIndex(i); setSelectedSeasonKey(null); setSelectedEpisodeId(null); setManualSearchQuery(""); setManualSearchResults([]); }}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                {group.match.type === "movie" ? (
                                  <Film className="h-3.5 w-3.5 text-muted-foreground" />
                                ) : (
                                  <Tv className="h-3.5 w-3.5 text-muted-foreground" />
                                )}
                                <div className="font-medium text-sm truncate" title={group.match.title}>{group.match.title}</div>
                              </div>
                              <div className="text-xs text-muted-foreground mt-1">{group.match.year}</div>
                              <div className="text-[11px] text-muted-foreground mt-1">
                                {group.match.type === "tv"
                                  ? `${episodeCount} ${episodeCount === 1 ? t("ingestion.ui.episode") : t("ingestion.ui.episodesLower")} · ${fileCount} ${
                                      fileCount === 1 ? t("ingestion.ui.file") : t("ingestion.ui.files")
                                    }`
                                  : `${fileCount} ${fileCount === 1 ? t("ingestion.ui.file") : t("ingestion.ui.files")}`}
                              </div>
                              <div className="mt-2 text-[11px] text-amber-300">{t("ingestion.ui.needsInputToContinue")}</div>
                            </div>
                            <div className="shrink-0 flex items-center gap-2">
                              <AlertCircle className="h-4 w-4 text-amber-400" />
                              <button
                                type="button"
                                className="rounded-full p-1 text-muted-foreground hover:text-foreground hover:bg-muted/40"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  const candidateIds = new Set(group.candidates.map((c) => c.id));
                                  setCandidates((prev) => prev.filter((c) => !candidateIds.has(c.id)));
                                  setTrackSelections((prev) => {
                                    const next = { ...prev };
                                    delete next[group.id];
                                    group.episodeGroups?.forEach((episodeGroup) => {
                                      delete next[episodeGroup.id];
                                    });
                                    return next;
                                  });
                                  if (selectionMode === "group" && i === selectedGroupIndex) {
                                    setSelectionMode("candidate");
                                    setSelectedIndex(0);
                                  }
                                }}
                                aria-label={t("ingestion.ui.removeGroup")}
                              >
                                <X className="h-3 w-3" />
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                    {fullyReadyGroups.length > 0 ? (
                      <div className="px-4 py-2 text-[11px] uppercase tracking-[0.2em] text-muted-foreground">{t("ingestion.ui.readyToImport")}</div>
                    ) : null}
                    {fullyReadyGroups.map((group) => {
                      const i = groupIndexById.get(group.id) ?? 0;
                      const fileCount = group.candidates.length;
                      const episodeCount = group.episodeGroups?.length ?? 0;
                      return (
                        <div
                          key={group.id}
                          className={`p-4 border-b border-border/50 cursor-pointer transition-colors hover:bg-muted/20 ${
                            selectionMode === "group" && i === selectedGroupIndex ? "bg-muted/30 border-l-4 border-l-primary" : ""
                          }`}
                          onClick={() => { setSelectionMode("group"); setSelectedGroupIndex(i); setSelectedSeasonKey(null); setSelectedEpisodeId(null); setManualSearchQuery(""); setManualSearchResults([]); }}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                {group.match.type === "movie" ? (
                                  <Film className="h-3.5 w-3.5 text-muted-foreground" />
                                ) : (
                                  <Tv className="h-3.5 w-3.5 text-muted-foreground" />
                                )}
                                <div className="font-medium text-sm truncate" title={group.match.title}>{group.match.title}</div>
                              </div>
                              <div className="text-xs text-muted-foreground mt-1">{group.match.year}</div>
                              <div className="text-[11px] text-muted-foreground mt-1">
                                {group.match.type === "tv"
                                  ? `${episodeCount} ${episodeCount === 1 ? t("ingestion.ui.episode") : t("ingestion.ui.episodesLower")} · ${fileCount} ${
                                      fileCount === 1 ? t("ingestion.ui.file") : t("ingestion.ui.files")
                                    }`
                                  : `${fileCount} ${fileCount === 1 ? t("ingestion.ui.file") : t("ingestion.ui.files")}`}
                              </div>
                            </div>
                            <div className="shrink-0 flex items-center gap-2">
                              <Check className="h-4 w-4 text-green-500" />
                              <button
                                type="button"
                                className="rounded-full p-1 text-muted-foreground hover:text-foreground hover:bg-muted/40"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  const candidateIds = new Set(group.candidates.map((c) => c.id));
                                  setCandidates((prev) => prev.filter((c) => !candidateIds.has(c.id)));
                                  setTrackSelections((prev) => {
                                    const next = { ...prev };
                                    delete next[group.id];
                                    group.episodeGroups?.forEach((episodeGroup) => {
                                      delete next[episodeGroup.id];
                                    });
                                    return next;
                                  });
                                  if (selectionMode === "group" && i === selectedGroupIndex) {
                                    setSelectionMode("candidate");
                                    setSelectedIndex(0);
                                  }
                                }}
                                aria-label={t("ingestion.ui.removeGroup")}
                              >
                                <X className="h-3 w-3" />
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                    {/* Files still being looked up are listed under their own heading, never under "Unmatched" (INGS-IDENT-02). */}
                    {([
                      ["ingestion.ui.searchingHeading", searchingCandidates],
                      ["ingestion.ui.unmatched", unmatchedCandidates],
                    ] as const).map(([heading, files]) => files.length === 0 ? null : (
                    <Fragment key={heading}>
                    <div className="px-4 py-2 text-[11px] uppercase tracking-[0.2em] text-muted-foreground">{t(heading)}</div>
                    {files.map((file) => {
                      const index = candidates.findIndex((c) => c.id === file.id);
                      return (
                        <div
                          key={file.id}
                          className={`p-4 border-b border-border/50 cursor-pointer transition-colors hover:bg-muted/20 ${selectionMode === "candidate" && index === selectedIndex ? "bg-muted/30 border-l-4 border-l-primary" : ""}`}
                          onClick={() => { setSelectionMode("candidate"); setSelectedIndex(index); setManualSearchQuery(""); setManualSearchResults([]); }}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex-1 min-w-0">
                              <div className="font-medium text-sm truncate" title={file.name}>{file.name}</div>
                              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                                {file.kind === "subtitle" ? t("ingestion.ui.subtitle") : t("ingestion.ui.video")}
                              </div>
                              <div className="text-xs text-muted-foreground mt-1">
                                {file.parsed?.title} 
                                {file.parsed?.season ? ` · S${file.parsed.season}E${file.parsed.episode}` : ""}
                              </div>
                            </div>
                            <div className="shrink-0 flex items-center gap-2">
                              {file.status === "scanning" || file.status === "searching" ? (
                                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                              ) : file.status === "ready" ? (
                                <Check className="h-4 w-4 text-green-500" />
                              ) : file.status === "pending" ? (
                                <Clock className="h-4 w-4 text-muted-foreground" aria-label={t("ingestion.ui.queued")} />
                              ) : (
                                <AlertCircle className="h-4 w-4 text-red-500" />
                              )}
                              <button
                                type="button"
                                className="rounded-full p-1 text-muted-foreground hover:text-foreground hover:bg-muted/40"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setCandidates((prev) => prev.filter((c) => c.id !== file.id));
                                }}
                                aria-label={t("ingestion.ui.removeFile")}
                              >
                                <X className="h-3 w-3" />
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                    </Fragment>
                    ))}
                  </>
                ) : candidates.map((file, i) => (
                  <div
                    key={file.id}
                    className={`p-4 border-b border-border/50 cursor-pointer transition-colors hover:bg-muted/20 ${i === selectedIndex ? "bg-muted/30 border-l-4 border-l-primary" : ""}`}
                    onClick={() => {
                      setSelectionMode("candidate");
                      setSelectedIndex(i);
                      setManualSearchQuery("");
                      setManualSearchResults([]);
                    }}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-sm truncate" title={file.name}>{file.name}</div>
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                          {file.kind === "subtitle" ? t("ingestion.ui.subtitle") : t("ingestion.ui.video")}
                        </div>
                        <div className="text-xs text-muted-foreground mt-1">
                          {file.parsed?.title} 
                          {file.parsed?.season ? ` · S${file.parsed.season}E${file.parsed.episode}` : ""}
                        </div>
                      </div>
                      <div className="shrink-0 flex items-center gap-2">
                        {file.status === "scanning" || file.status === "searching" ? (
                          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                        ) : file.status === "ready" ? (
                          <Check className="h-4 w-4 text-green-500" />
                        ) : file.status === "pending" ? (
                          <Clock className="h-4 w-4 text-muted-foreground" aria-label={t("ingestion.ui.queued")} />
                        ) : (
                          <AlertCircle className="h-4 w-4 text-red-500" />
                        )}
                        <button
                          type="button"
                          className="rounded-full p-1 text-muted-foreground hover:text-foreground hover:bg-muted/40"
                          onClick={(event) => {
                            event.stopPropagation();
                            setCandidates((prev) => {
                              const next = prev.filter((c) => c.id !== file.id);
                              if (next.length === 0) {
                                setSelectedIndex(0);
                                setManualSearchQuery("");
                                setManualSearchResults([]);
                                return next;
                              }
                              const currentIndex = prev.findIndex((c) => c.id === file.id);
                              if (currentIndex === selectedIndex) {
                                const nextIndex = Math.min(selectedIndex, next.length - 1);
                                setSelectedIndex(nextIndex);
                                setManualSearchQuery("");
                                setManualSearchResults([]);
                              } else if (currentIndex < selectedIndex) {
                                setSelectedIndex((index) => Math.max(0, index - 1));
                              }
                              return next;
                            });
                          }}
                          aria-label={t("ingestion.ui.removeFile")}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
                {scanning && (
                    <div className="p-4 flex items-center justify-center gap-2 text-muted-foreground text-sm">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        {t("ingestion.ui.scanning")}
                    </div>
                )}
                {candidates.length > 0 && !scanning && (
                  <div className="p-4 flex justify-center">
                    <Button variant="ghost" size="sm" className="text-xs" onClick={() => handleNativeBrowse("file")}>
                      <Plus className="h-3 w-3 mr-1" /> {t("ingestion.ui.addMore")}
                    </Button>
                  </div>
                )}
              </ImportReviewList>

              {/* Right: Match Details */}
              <ImportReviewDetail>
                {selectedGroup || activeCandidate ? (
                  <div className="space-y-6">
                    {(selectedGroup?.match ?? activeCandidate?.match) ? (
                      <ImportReviewMatchHeader
                        artwork={<ImportCandidateImage path={(selectedGroup?.match ?? activeCandidate?.match)?.posterPath ?? null} alt={(selectedGroup?.match ?? activeCandidate?.match)?.title ?? ""} className="w-full h-full object-cover" />}
                        kind={
                          <>
                            {(selectedGroup?.match ?? activeCandidate?.match)?.type === "movie" ? <Film className="h-3 w-3" /> : <Tv className="h-3 w-3" />}
                            {(selectedGroup?.match ?? activeCandidate?.match)?.type === "movie"
                              ? t("ingestion.ui.movie")
                              : t("ingestion.ui.tvShow")}
                          </>
                        }
                        title={(selectedGroup?.match ?? activeCandidate?.match)?.title}
                        meta={(selectedGroup?.match ?? activeCandidate?.match)?.year}
                      >
                        <p className="text-sm text-muted-foreground leading-relaxed">
                          {(selectedGroup?.match ?? activeCandidate?.match)?.overview}
                        </p>
                        {selectedSeason !== null && selectedEpisodeNumber !== null ? (
                          <div className="inline-flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1 text-sm font-medium text-primary">
                              <span className="opacity-70">{t("ingestion.ui.addingLabel")}</span>{" "}
                              {t("ingestion.ui.seasonEpisode", { season: selectedSeason, episode: selectedEpisodeNumber })}
                          </div>
                        ) : null}
                      </ImportReviewMatchHeader>
                    ) : activeCandidate && isLookupInProgress(activeCandidate) ? (
                      // The lookup has not ended: "No match found" would be a guess (INGS-IDENT-02).
                      <ImportReviewSearching
                        icon={<Loader2 className="h-4 w-4 animate-spin" />}
                        title={t("ingestion.ui.searchingTitle")}
                        hint={t("ingestion.ui.searchingHint")}
                      />
                    ) : (
                      <ImportReviewNoMatch
                        icon={<AlertCircle className="h-4 w-4" />}
                        title={activeCandidate?.error ?? t("ingestion.errors.noMatch")}
                        hint={activeCandidate?.errorHint ?? t("ingestion.ui.noMatchHint")}
                      />
                    )}

                    {activeCandidate?.kind === "subtitle" && activeCandidate.match ? (
                      <div className="rounded-xl border border-border bg-muted/20 p-4 space-y-3">
                        <div className="text-sm font-semibold">{t("ingestion.ui.subtitleDetails")}</div>
                        <div className="grid gap-2">
                          <div className="text-xs text-muted-foreground">{t("ingestion.ui.language")}</div>
                          <select
                            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                            value={activeCandidate.subtitleDraft?.language ?? "und"}
                            onChange={(event) => {
                              const nextLanguage = event.target.value;
                              setCandidates((prev) =>
                                prev.map((candidate) =>
                                  candidate.id === activeCandidate.id
                                    ? {
                                        ...candidate,
                                        subtitleDraft: {
                                          language: nextLanguage,
                                          label: candidate.subtitleDraft?.label?.trim()
                                            ? candidate.subtitleDraft.label
                                            : languageLabel(nextLanguage),
                                        },
                                      }
                                    : candidate
                                )
                              );
                            }}
                          >
                            <option value="und">{t("ingestion.ui.undefined")}</option>
                            {sortedLanguageOptions.map((lang) => (
                              <option key={lang.code} value={lang.code}>
                                {lang.label}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="grid gap-2">
                          <div className="text-xs text-muted-foreground">{t("ingestion.ui.trackName")}</div>
                          <Input
                            value={activeCandidate.subtitleDraft?.label ?? ""}
                            onChange={(event) => {
                              const nextLabel = event.target.value;
                              setCandidates((prev) =>
                                prev.map((candidate) =>
                                  candidate.id === activeCandidate.id
                                    ? {
                                        ...candidate,
                                        subtitleDraft: {
                                          language: candidate.subtitleDraft?.language ?? "und",
                                          label: nextLabel,
                                        },
                                      }
                                    : candidate
                                )
                              );
                            }}
                            placeholder={t("ingestion.ui.subtitleNamePlaceholder")}
                          />
                        </div>
                      </div>
                    ) : null}

                    {selectedGroup ? (
                      <>
                        {selectedGroup.match.type === "tv" && selectedGroup.episodeGroups && selectedGroup.episodeGroups.length > 0 ? (
                          <ImportReviewItems
                            heading={t("ingestion.ui.episodes")}
                            chips={tvSeasonState.seasons.map((seasonKey) => {
                                const isActive = seasonKey === (tvSeasonState.activeKey ?? "");
                                const label =
                                  seasonKey === "unknown"
                                    ? t("ingestion.ui.unknownSeason")
                                    : t("ingestion.ui.seasonLabel", { season: seasonKey });
                                return (
                                  <button
                                    key={seasonKey}
                                    type="button"
                                    className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                                      isActive ? "border-primary/40 bg-primary/15 text-primary" : "border-border/60 bg-muted/30 text-muted-foreground"
                                    }`}
                                    onClick={() => setSelectedSeasonKey(seasonKey)}
                                  >
                                    {label}
                                  </button>
                                );
                            })}
                          >
                              {tvSeasonState.episodes.map((episodeGroup) => {
                                  const isSelected = episodeGroup.id === selectedEpisodeId;
                                  const label =
                                    episodeGroup.season !== null && episodeGroup.episode !== null
                                      ? `S${episodeGroup.season}E${String(episodeGroup.episode).padStart(2, "0")}`
                                      : t("ingestion.ui.unlabeledEpisode");
                                  const fileLabel = `${episodeGroup.candidates.length} ${
                                    episodeGroup.candidates.length === 1 ? t("ingestion.ui.file") : t("ingestion.ui.files")
                                  }`;
                                  return (
                                    <ImportReviewItem
                                      key={episodeGroup.id}
                                      selected={isSelected}
                                      onSelect={() => setSelectedEpisodeId(episodeGroup.id)}
                                      label={label}
                                      sub={fileLabel}
                                      trailing={
                                      <button
                                        type="button"
                                        className="ml-2 rounded-full p-1 text-muted-foreground hover:text-foreground hover:bg-muted/50"
                                        aria-label={t("ingestion.ui.removeEpisodeGroup")}
                                        onClick={() => {
                                          const candidateIds = new Set(episodeGroup.candidates.map((candidate) => candidate.id));
                                          setCandidates((prev) => prev.filter((candidate) => !candidateIds.has(candidate.id)));
                                          setTrackSelections((prev) => {
                                            const next = { ...prev };
                                            delete next[episodeGroup.id];
                                            return next;
                                          });
                                          if (selectedEpisodeId === episodeGroup.id) {
                                            setSelectedEpisodeId(null);
                                          }
                                        }}
                                      >
                                        <X className="h-3 w-3" />
                                      </button>
                                      }
                                    />
                                  );
                                })}
                          </ImportReviewItems>
                        ) : null}

                        <div className="rounded-xl border border-border bg-muted/20 p-4 space-y-4">
                          <div className="text-sm font-semibold">{t("ingestion.ui.tracks")}</div>
                          {!activeGroupProbeReady ? (
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                              <Loader2 className="h-3 w-3 animate-spin" />
                              {t("ingestion.ui.readingMetadata")}
                            </div>
                          ) : (
                            <div className="space-y-3">
                              <div>
                                <div className="text-xs font-medium text-muted-foreground mb-2">{t("ingestion.ui.audio")}</div>
                                <div className="flex flex-wrap gap-2">
                                  {!activeGroupTracks || activeGroupTracks.audioTracks?.length === 0 ? (
                                    <span className="text-xs text-muted-foreground">{t("ingestion.ui.noAudioTracksDetected")}</span>
                                  ) : (
                                    activeGroupTracks.audioTracks?.map((track) => {
                                      const selected = activeTrackSelection?.audio.has(track.key) ?? true;
                                      return (
                                        <button
                                          key={track.key}
                                          type="button"
                                          className={`inline-flex items-center gap-2 rounded-full border px-2 py-1 text-xs font-medium transition ${
                                            selected
                                              ? "border-primary/40 bg-primary/15 text-primary"
                                              : "border-border/60 bg-muted/20 text-muted-foreground"
                                          }`}
                                          onClick={() => {
                                            if (activeGroupKey) {
                                              setTrackSelectionTouched((prev) => new Set(prev).add(activeGroupKey));
                                            }
                                            setTrackSelections((prev) => {
                                              const next = { ...prev };
                                              const key = activeGroupKey ?? selectedGroup.id;
                                              const entry = next[key] ?? { audio: new Set(), subtitles: new Set() };
                                              const audio = new Set(entry.audio);
                                              if (audio.has(track.key)) {
                                                audio.delete(track.key);
                                              } else {
                                                audio.add(track.key);
                                              }
                                              next[key] = { ...entry, audio };
                                              return next;
                                            });
                                          }}
                                        >
                                          <span
                                            className={`relative inline-flex h-4 w-8 items-center rounded-full border transition ${
                                              selected ? "border-primary/40 bg-primary/20" : "border-border/60 bg-muted/20"
                                            }`}
                                          >
                                            <span
                                              className={`absolute flex h-4 w-4 items-center justify-center rounded-full text-[10px] transition-transform ${
                                                selected
                                                  ? "translate-x-4 bg-primary text-primary-foreground"
                                                  : "translate-x-0 bg-muted-foreground/30 text-muted-foreground"
                                              }`}
                                            >
                                              {selected ? <Check className="h-2.5 w-2.5" /> : <X className="h-2.5 w-2.5" />}
                                            </span>
                                          </span>
                                          <span>{resolveTrackPreview("audio", track)}</span>
                                        </button>
                                      );
                                    })
                                  )}
                                </div>
                              </div>
                              <div>
                                <div className="text-xs font-medium text-muted-foreground mb-2">{t("ingestion.ui.subtitles")}</div>
                                <div className="flex flex-wrap gap-2">
                                  {!activeGroupTracks || activeGroupTracks.subtitleTracks?.length === 0 ? (
                                    <span className="text-xs text-muted-foreground">{t("ingestion.ui.noSubtitlesDetected")}</span>
                                  ) : (
                                    activeGroupTracks.subtitleTracks?.map((track) => {
                                      const selected = activeTrackSelection?.subtitles.has(track.key) ?? true;
                                      return (
                                        <button
                                          key={track.key}
                                          type="button"
                                          className={`inline-flex items-center gap-2 rounded-full border px-2 py-1 text-xs font-medium transition ${
                                            selected
                                              ? "border-primary/40 bg-primary/15 text-primary"
                                              : "border-border/60 bg-muted/20 text-muted-foreground"
                                          }`}
                                          onClick={() => {
                                            if (activeGroupKey) {
                                              setTrackSelectionTouched((prev) => new Set(prev).add(activeGroupKey));
                                            }
                                            setTrackSelections((prev) => {
                                              const next = { ...prev };
                                              const key = activeGroupKey ?? selectedGroup.id;
                                              const entry = next[key] ?? { audio: new Set(), subtitles: new Set() };
                                              const subtitles = new Set(entry.subtitles);
                                              if (subtitles.has(track.key)) {
                                                subtitles.delete(track.key);
                                              } else {
                                                subtitles.add(track.key);
                                              }
                                              next[key] = { ...entry, subtitles };
                                              return next;
                                            });
                                          }}
                                        >
                                          <span
                                            className={`relative inline-flex h-4 w-8 items-center rounded-full border transition ${
                                              selected ? "border-primary/40 bg-primary/20" : "border-border/60 bg-muted/20"
                                            }`}
                                          >
                                            <span
                                              className={`absolute flex h-4 w-4 items-center justify-center rounded-full text-[10px] transition-transform ${
                                                selected
                                                  ? "translate-x-4 bg-primary text-primary-foreground"
                                                  : "translate-x-0 bg-muted-foreground/30 text-muted-foreground"
                                              }`}
                                            >
                                              {selected ? <Check className="h-2.5 w-2.5" /> : <X className="h-2.5 w-2.5" />}
                                            </span>
                                          </span>
                                          <span>{resolveTrackPreview("subtitle", track)}</span>
                                        </button>
                                      );
                                    })
                                  )}
                                </div>
                              </div>
                            </div>
                          )}
                          {(() => {
                            const matchData = selectedGroup?.match ?? activeCandidate?.match;
                            if (matchData?.type !== "tv") return null;
                            const ownerCandidate =
                              selectedGroup?.candidates.find((c) => c.skipMarkerData !== undefined) ??
                              activeCandidate;
                            const skipData = ownerCandidate?.skipMarkerData;
                            if (!skipData) {
                              return (
                                <div className="text-xs text-muted-foreground">
                                  {t("fileIngestion.skipData.fetching")}
                                </div>
                              );
                            }
                            if (skipData.status === "fetching") {
                              return (
                                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                  {t("fileIngestion.skipData.fetching")}
                                </div>
                              );
                            }
                            if (skipData.status === "unavailable") {
                              return (
                                <div className="text-xs text-muted-foreground">
                                  {t("fileIngestion.skipData.unavailable")}
                                </div>
                              );
                            }
                            const total = skipData.coverage.length;
                            const covered = skipData.coverage.filter((e) => e.status === "hit").length;
                            if (total === 0) {
                              return (
                                <div className="text-xs text-muted-foreground">
                                  {t("fileIngestion.skipData.unavailable")}
                                </div>
                              );
                            }
                            if (skipData.cacheHit) {
                              return (
                                <div className="text-xs text-emerald-400">
                                  {t("fileIngestion.skipData.cached")}
                                </div>
                              );
                            }
                            if (covered === total) {
                              return (
                                <div className="text-xs text-emerald-400">
                                  {t("fileIngestion.skipData.all")}
                                </div>
                              );
                            }
                            return (
                              <div className="text-xs text-emerald-400">
                                {t("fileIngestion.skipData.partial", { covered, total })}
                              </div>
                            );
                          })()}
                        </div>

                        <details className="rounded-xl border border-border bg-muted/10 p-4 text-sm">
                          <summary className="cursor-pointer text-sm font-medium text-muted-foreground hover:text-foreground">
                            {t("ingestion.ui.importDetails")}
                          </summary>
                          {activeIsSubtitleOnly ? (
                            <div className="mt-4 text-xs text-muted-foreground">
                              {t("ingestion.ui.subtitleOnlyImportHint")}
                            </div>
                          ) : (
                            <div className="mt-4 grid grid-cols-2 gap-3 text-xs text-muted-foreground">
                              <div>
                                <div className="text-muted-foreground">{t("ingestion.ui.inputQualities")}</div>
                                <div className="font-medium text-foreground">
                                  {Array.from(
                                    new Set(
                                      (activeGroupTracks?.videoVariants ?? [])
                                        .map((variant) => variant.quality)
                                        .filter((quality) => quality && quality !== "unknown")
                                    )
                                  ).join(", ") || t("ingestion.ui.unknown")}
                                </div>
                              </div>
                              <div>
                                <div className="text-muted-foreground">{t("ingestion.ui.preferredCodecs")}</div>
                                <div className="font-medium text-foreground">
                                  {Array.from(
                                    new Set(
                                      (activeGroupTracks?.videoVariants ?? [])
                                        .map((variant) => variant.codec)
                                        .filter((codec) => codec && codec !== "unknown")
                                    )
                                  )
                                    .map((codec) => codec.toUpperCase())
                                    .join(", ") || t("ingestion.ui.unknown")}
                                </div>
                              </div>
                              <div>
                                <div className="text-muted-foreground">{t("ingestion.ui.videoSources")}</div>
                                <div className="font-medium text-foreground">{activeGroupTracks?.videoVariants?.length ?? 0}</div>
                              </div>
                              <div>
                                <div className="text-muted-foreground">{t("ingestion.ui.autoOutputs")}</div>
                                <div className="font-medium text-foreground">
                                  {activeAutoOutputs.length > 0
                                    ? activeAutoOutputs.map((output) => `${output.quality} ${output.codec.toUpperCase()}`).join(", ")
                                    : t("ingestion.ui.noneAlreadyAvailable")}
                                </div>
                              </div>
                              <div>
                                <div className="text-muted-foreground">{t("ingestion.ui.audioTracks")}</div>
                                <div className="font-medium text-foreground">{activeGroupTracks?.audioTracks?.length ?? 0}</div>
                              </div>
                              <div>
                                <div className="text-muted-foreground">{t("ingestion.ui.subtitles")}</div>
                                <div className="font-medium text-foreground">{activeGroupTracks?.subtitleTracks?.length ?? 0}</div>
                              </div>
                            </div>
                          )}
                        </details>
                      </>
                    ) : (
                      <div className="rounded-xl border border-border bg-muted/20 p-4">
                        <div className="text-sm font-semibold mb-3">{t("ingestion.ui.fileDetails")}</div>
                        {activeCandidate?.probeError ? (
                          <div className="text-xs text-muted-foreground">{activeCandidate.probeError}</div>
                        ) : activeCandidate?.kind === "subtitle" ? (
                          <div className="text-xs text-muted-foreground">
                            {t("ingestion.ui.subtitleFileDetected")}
                          </div>
                        ) : !activeCandidate?.probe ? (
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            {t("ingestion.ui.readingMetadata")}
                          </div>
                        ) : (
                          <div className="grid grid-cols-2 gap-3 text-xs">
                            <div>
                              <div className="text-muted-foreground">{t("ingestion.ui.quality")}</div>
                              <div className="font-medium">
                                {activeCandidate.probe.video?.height
                                  ? guessQualityLabel(
                                      activeCandidate.probe.video.height,
                                      activeCandidate.probe.video.width ?? undefined
                                    )
                                  : t("ingestion.ui.unknown")}
                              </div>
                            </div>
                            <div>
                              <div className="text-muted-foreground">{t("ingestion.ui.resolution")}</div>
                              <div className="font-medium">
                                {activeCandidate.probe.video?.width && activeCandidate.probe.video?.height
                                  ? `${activeCandidate.probe.video.width}x${activeCandidate.probe.video.height}`
                                  : t("ingestion.ui.unknown")}
                              </div>
                            </div>
                            <div>
                              <div className="text-muted-foreground">{t("ingestion.ui.videoCodec")}</div>
                              <div className="font-medium">
                                {activeCandidate.probe.video?.codec
                                  ? activeCandidate.probe.video.codec.toUpperCase()
                                  : t("ingestion.ui.unknown")}
                              </div>
                            </div>
                            <div>
                              <div className="text-muted-foreground">{t("ingestion.ui.audioTracks")}</div>
                              <div className="font-medium">
                                {activeCandidate.probe.audio.count}
                                {activeCandidate.probe.audio.languages.length
                                  ? ` · ${activeCandidate.probe.audio.languages.map((lang) => languageLabel(lang)).join(", ")}`
                                  : ""}
                              </div>
                            </div>
                            <div>
                              <div className="text-muted-foreground">{t("ingestion.ui.subtitles")}</div>
                              <div className="font-medium">
                                {activeCandidate.probe.subtitles.count}
                                {activeCandidate.probe.subtitles.languages.length
                                  ? ` · ${activeCandidate.probe.subtitles.languages.map((lang) => languageLabel(lang)).join(", ")}`
                                  : ""}
                              </div>
                            </div>
                            <div>
                              <div className="text-muted-foreground">{t("ingestion.ui.chapters")}</div>
                              <div className="font-medium">{activeCandidate.probe.chapters.count}</div>
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    <ImportReviewMatchSearch
                      open={manualSearchOpen}
                      onOpenChange={setManualSearchOpen}
                      label={
                        subtitleSelectionActive
                          ? t("ingestion.ui.matchWithExistingLibraryMedia")
                          : t("ingestion.ui.wrongMatchSearchManually")
                      }
                      controls={
                        <>
                            <select
                              className="h-10 rounded-md border border-border bg-background px-3 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                              value={manualSearchType}
                              onChange={(event) => setManualSearchType(event.target.value as "movie" | "tv")}
                            >
                              <option value="movie">{t("ingestion.ui.movies")}</option>
                              <option value="tv">{t("ingestion.ui.tvShows")}</option>
                            </select>
                            <Input 
                                value={manualSearchQuery} 
                                onChange={(e) => setManualSearchQuery(e.target.value)} 
                                placeholder={
                                  subtitleSelectionActive
                                    ? manualSearchType === "movie"
                                      ? t("ingestion.ui.searchLibraryMoviesPlaceholder")
                                      : t("ingestion.ui.searchLibraryTvPlaceholder")
                                    : manualSearchType === "movie"
                                      ? t("ingestion.ui.searchTitlesMoviesPlaceholder")
                                      : t("ingestion.ui.searchTitlesTvPlaceholder")
                                } 
                                className="flex-1"
                                onKeyDown={(e) => e.key === "Enter" && handleManualSearch()}
                            />
                            <Button variant="secondary" onClick={handleManualSearch} disabled={searchingManual}>
                                {searchingManual ? <Loader2 className="h-4 w-4 animate-spin" /> : t("ingestion.ui.search")}
                            </Button>
                            {manualSearchResults.length > 0 && (
                              <Button variant="ghost" onClick={clearManualSearch}>
                                {t("ingestion.ui.clear")}
                              </Button>
                            )}
                        </>
                      }
                    >
                        {manualSearchResults.length > 0 && (
                            <div
                              className="mt-4 flex-1 min-h-0 overflow-y-auto pr-2"
                            >
                              <div className="grid grid-cols-2 md:grid-cols-3 gap-4 pb-2 overflow-visible">
                                  {manualSearchResults.map(result => {
                                    const key = `${result.type}:${result.id}`;
                                    const trailerEntry = trailerCache[key];
                                    const showTrailerButton =
                                      trailerEntry?.status === "ready" || trailerEntry?.status === "loading";
                                    return (
                                      <ImportReviewMatchResult
                                        key={result.id}
                                        onMouseEnter={() => {
                                          if (!trailerEntry || trailerEntry.status === "idle" || trailerEntry.status === "error") {
                                            void ensureTrailers(result, false);
                                          }
                                        }}
                                        artwork={<ImportCandidateImage path={result.posterPath} alt={result.title} className="w-full h-full object-cover group-hover:opacity-80 transition-opacity" />}
                                        title={result.title}
                                        meta={result.year}
                                        selectLabel={t("ingestion.ui.select")}
                                        onSelect={() => applyManualMatch(result)}
                                        actions={
                                          showTrailerButton ? (
                                              <Button
                                                size="sm"
                                                variant="secondary"
                                                className="w-full max-w-[11rem]"
                                                onClick={() => {
                                                  if (openTrailerId === key) {
                                                    setOpenTrailerId(null);
                                                    return;
                                                  }
                                                  void ensureTrailers(result, true);
                                                }}
                                                disabled={trailerEntry?.status === "loading"}
                                              >
                                                {trailerEntry?.status === "loading" ? (
                                                  <Loader2 className="h-3 w-3 animate-spin" />
                                                ) : (
                                                  t("ingestion.ui.trailer")
                                                )}
                                              </Button>
                                          ) : null
                                        }
                                      />
                                    );
                                  })}
                              </div>
                              {manualSearchPage < manualSearchTotalPages ? (
                                <div className="mt-4 flex justify-center">
                                  <Button
                                    variant="secondary"
                                    onClick={loadMoreManualResults}
                                    disabled={manualSearchLoadingMore}
                                  >
                                    {manualSearchLoadingMore ? (
                                      <>
                                        <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                                        {t("ingestion.ui.loadingMore")}
                                      </>
                                    ) : (
                                      t("ingestion.ui.moreResults")
                                    )}
                                  </Button>
                                </div>
                              ) : null}
                              {manualSearchLoadingMore ? (
                                <div className="mt-3 flex items-center justify-center text-xs text-muted-foreground">
                                  <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                                  {t("ingestion.ui.loadingMore")}
                                </div>
                              ) : null}
                          </div>
                        )}
                    </ImportReviewMatchSearch>
                  </div>
                ) : (
                  <div className="h-full flex items-center justify-center text-muted-foreground">
                    {t("ingestion.ui.selectFileToReview")}
                  </div>
                )}
              </ImportReviewDetail>
            </>
          )}
        </ImportReviewBody>

          <ImportReviewFooter>
                  <ImportReviewSummary>
                    {t("ingestion.ui.readyToImportCount", { count: readyCount })}
                    {autoIgnoredVideoOverlaps > 0
                      ? ` · ${
                          autoIgnoredVideoOverlaps === 1
                            ? t("ingestion.ui.sameQualityOverlapIgnoredSingle", { count: autoIgnoredVideoOverlaps })
                            : t("ingestion.ui.sameQualityOverlapIgnoredMany", { count: autoIgnoredVideoOverlaps })
                        }`
                      : ""}
                  </ImportReviewSummary>
                  {storageWarning === "blocked" && (
                    <div className="flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
                      <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                      <span className="flex-1">{t("ingestion.ui.storageBlocked")}</span>
                      <Button
                        variant="secondary"
                        size="sm"
                        className="h-6 text-[10px] shrink-0"
                        onClick={() => { onOpenChange(false); navigate("/account"); }}
                      >
                        {t("lab.errors.upgradePlan")}
                      </Button>
                    </div>
                  )}
                  {storageWarning === "warning" && (
                    <div className="flex items-center gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-500">
                      <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                      <span>{t("ingestion.ui.storageWarning")}</span>
                    </div>
                  )}
                  <ImportReviewActions>
                    {showDummyIngest && (
                      <Button variant="outline" onClick={() => setDummyIngestOpen(true)}>
                        {t("ingestion.ui.addWithDummyData")}
                      </Button>
                    )}
                    {unresolvedVideoDecisions.length > 0 ? (
                      <Button variant="secondary" onClick={() => { setResolveIndex(0); setResolveModalOpen(true); }}>
                        {t("ingestion.ui.resolveVideoChoices", { count: unresolvedVideoDecisions.length })}
                      </Button>
                    ) : null}
                    <Button variant="ghost" onClick={closeIngestionDialog}>{t("ingestion.ui.cancel")}</Button>
                    {unresolvedInputCount > 0 ? (
                      <Button
                        onClick={openInputResolver}
                        className="bg-amber-400 text-amber-950 hover:bg-amber-300"
                      >
                        {t("ingestion.ui.yourInputNeeded", { count: unresolvedInputCount })}
                      </Button>
                    ) : null}
                    <div
                      className="relative"
                      onMouseEnter={() => setShowAddBlocker(true)}
                      onMouseLeave={() => setShowAddBlocker(false)}
                    >
                      <Button
                        onClick={() => void handleAdd()}
                        disabled={
                          adding ||
                          readyCount === 0 ||
                          unmatchedCandidates.length > 0 ||
                          searchingCandidates.length > 0 ||
                          unresolvedVideoDecisions.length > 0 ||
                          pendingProbeCount > 0 ||
                          unresolvedInputCount > 0 ||
                          pendingSkipDataCount > 0 ||
                          quotaGate !== null
                        }
                        className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:border disabled:border-border disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100"
                      >
                        {adding ? (
                          <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            {t("ingestion.ui.adding")}
                          </>
                        ) : (
                          <>
                            <Upload className="mr-2 h-4 w-4" />
                            {t("ingestion.ui.addToLibrary")}
                          </>
                        )}
                      </Button>
                      {(showAddBlocker && (unmatchedCandidates.length > 0 || searchingCandidates.length > 0 || unresolvedVideoDecisions.length > 0 || pendingProbeCount > 0 || unresolvedInputCount > 0 || pendingSkipDataCount > 0)) ? (
                        <div className="absolute bottom-full right-0 mb-2 w-64 rounded-lg border border-border bg-background p-3 text-xs shadow-lg">
                          <div className="font-semibold text-foreground">{t("ingestion.ui.resolveBeforeAddingTitle")}</div>
                          <ul className="mt-2 space-y-1 text-muted-foreground">
                            {unmatchedCandidates.length > 0 && (
                              <li>• {t("ingestion.ui.blockerMatchOrRemove", { count: unmatchedCandidates.length })}</li>
                            )}
                            {searchingCandidates.length > 0 && (
                              <li>• {t("ingestion.ui.blockerWaitSearch", { count: searchingCandidates.length })}</li>
                            )}
                            {unresolvedVideoDecisions.length > 0 && (
                              <li>• {t("ingestion.ui.blockerResolveVideo", { count: unresolvedVideoDecisions.length })}</li>
                            )}
                            {pendingProbeCount > 0 && (
                              <li>• {t("ingestion.ui.blockerWaitMetadata", { count: pendingProbeCount })}</li>
                            )}
                            {unresolvedInputCount > 0 && (
                              <li>• {t("ingestion.ui.blockerClickInput", { count: unresolvedInputCount })}</li>
                            )}
                            {pendingSkipDataCount > 0 && (
                              <li>• {t("ingestion.ui.blockerSkipDataLoading", { count: pendingSkipDataCount, defaultValue: "Waiting for skip-marker fetch ({{count}})" })}</li>
                            )}
                          </ul>
                        </div>
                      ) : null}
                    </div>
                  </ImportReviewActions>
          </ImportReviewFooter>
      </ImportReviewDialog>

      <Dialog
        open={inputResolveModalOpen}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            stopInputSamples();
          }
          setInputResolveModalOpen(nextOpen);
        }}
      >
        {/* The track rows scroll inside a window-bounded dialog, so Close/Back/Finish stay on screen however many items need input. */}
        <DialogContent aria-describedby={undefined} className="flex max-h-[85vh] max-w-3xl flex-col" data-testid="ingestion-input-dialog">
          <DialogHeader>
            <DialogTitle>
              {t("ingestion.ui.yourInputNeededProgress", {
                current: Math.min(inputResolveIndex + 1, Math.max(1, inputKinds.length)),
                total: Math.max(1, inputKinds.length),
              })}
            </DialogTitle>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto pr-1" data-testid="ingestion-input-scroll">
          {activeInputKind ? (
            <div className="space-y-4">
              <div className="text-sm font-medium">
                {activeInputKind === "audio"
                  ? t("ingestion.ui.setLanguageAndNameAudioTracks")
                  : t("ingestion.ui.setLanguageAndNameSubtitleTracks")}
              </div>
              <div className="text-xs text-muted-foreground">
                {t("ingestion.ui.mediaItemsTracksCounts", {
                  mediaCount: activeInputGroups.length,
                  mediaLabel: activeInputGroups.length === 1 ? t("ingestion.ui.mediaItem") : t("ingestion.ui.mediaItems"),
                  trackCount: activeInputRows.length,
                  trackLabel: activeInputRows.length === 1 ? t("ingestion.ui.track") : t("ingestion.ui.tracks"),
                })}
              </div>
              <div className="space-y-3">
                {activeInputGroups.map((group) => (
                  <div key={group.candidateId} className="rounded-lg border border-border bg-muted/15 p-3">
                    <div className="mb-3">
                      <div className="text-sm font-semibold text-foreground">{group.primaryLabel}</div>
                    </div>
                    <div className="space-y-2">
                      {group.rows.map((row) => {
                        const decision = undefinedTrackDecisions[row.id] ?? {
                          language: row.language,
                          label: normalizeTrackLabelForUi(row.label, row.language),
                          keepUndefined: false,
                        };
                        const controlsDisabled = ignoreUndefinedByKind[activeInputKind];
                        const isAudioRow = row.kind === "audio";
                        const audioLoading = audioSampleLoadingId === row.id;
                        const subtitleLoading = subtitleSampleLoadingId === row.id;
                        const isPlayingAudio = audioPlayingId === row.id;
                        const isEditingCustomName = customNameEditingRows.has(row.id);
                        const effectiveLanguageLabel = languageLabel(decision.language);
                        const normalizedDecisionLabel = normalizeTrackLabelForUi(decision.label, decision.language);
                        const hasCustomLabel =
                          normalizedDecisionLabel.length > 0 &&
                          normalizedDecisionLabel !== effectiveLanguageLabel;
                        const isCustomMode = isEditingCustomName || hasCustomLabel;
                        return (
                          <div key={row.id} className="rounded-lg border border-border bg-muted/20 p-3">
                            <div
                              className={`grid items-center gap-2 ${
                                isAudioRow
                                  ? "grid-cols-[auto_auto_minmax(180px,1fr)_auto_auto]"
                                  : "grid-cols-[auto_minmax(180px,1fr)_auto_auto]"
                              }`}
                            >
                              {isAudioRow ? (
                                <Button
                                  type="button"
                                  variant="secondary"
                                  size="icon"
                                  title={t("ingestion.ui.shuffleSample")}
                                  onClick={async () => {
                                    stopAudioSample();
                                    await loadAudioSample(row, true);
                                  }}
                                  disabled={audioLoading}
                                >
                                  {audioLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Shuffle className="h-4 w-4" />}
                                </Button>
                              ) : null}
                              <Button
                                type="button"
                                variant="secondary"
                                size="icon"
                                title={
                                  isAudioRow
                                    ? isPlayingAudio
                                      ? t("ingestion.ui.stopSample")
                                      : t("ingestion.ui.playSample")
                                    : t("ingestion.ui.showSample")
                                }
                                onClick={() => {
                                  if (isAudioRow) {
                                    void toggleAudioSample(row);
                                    return;
                                  }
                                  void toggleSubtitleSample(row);
                                }}
                                disabled={audioLoading || subtitleLoading}
                              >
                                {isAudioRow ? (
                                  isPlayingAudio ? <Square className="h-4 w-4" /> : <Play className="h-4 w-4" />
                                ) : (
                                  subtitleLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />
                                )}
                              </Button>
                              {isCustomMode ? (
                                <Input
                                  value={normalizedDecisionLabel}
                                  disabled={controlsDisabled}
                                  onChange={(event) =>
                                    setTrackDecision(row, {
                                      label: event.target.value,
                                      keepUndefined: false,
                                    })
                                  }
                                  placeholder={t("ingestion.ui.trackName")}
                                />
                              ) : (
                                <select
                                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
                                  value={controlsDisabled ? "und" : normalizeLanguageCode(decision.language)}
                                  disabled={controlsDisabled}
                                  onChange={(event) => {
                                    const nextLanguage = normalizeLanguageCode(event.target.value);
                                    setTrackDecision(row, {
                                      language: nextLanguage,
                                      label: languageLabel(nextLanguage),
                                      keepUndefined: false,
                                    });
                                    setCustomNameEditingRows((prev) => {
                                      if (!prev.has(row.id)) return prev;
                                      const next = new Set(prev);
                                      next.delete(row.id);
                                      return next;
                                    });
                                  }}
                                >
                                  <option value="und">{t("ingestion.ui.undefined")}</option>
                                  {sortedLanguageOptions.map((lang) => (
                                    <option key={lang.code} value={lang.code}>
                                      {lang.label}
                                    </option>
                                  ))}
                                </select>
                              )}
                              <Button
                                type="button"
                                variant="secondary"
                                size="icon"
                                title={isEditingCustomName ? t("ingestion.ui.saveCustomName") : t("ingestion.ui.editCustomName")}
                                disabled={controlsDisabled}
                                onClick={() => {
                                  if (!isCustomMode) {
                                    setTrackDecision(row, {
                                      label: normalizedDecisionLabel || effectiveLanguageLabel,
                                      keepUndefined: false,
                                    });
                                  }
                                  setCustomNameEditingRows((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(row.id)) {
                                      next.delete(row.id);
                                    } else {
                                      next.add(row.id);
                                    }
                                    return next;
                                  });
                                }}
                              >
                                {isEditingCustomName ? <Check className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
                              </Button>
                              {isCustomMode ? (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  title={t("ingestion.ui.useLanguageLabel")}
                                  disabled={controlsDisabled}
                                  onClick={() => {
                                    const nextLanguage = normalizeLanguageCode(decision.language);
                                    setTrackDecision(row, {
                                      language: nextLanguage,
                                      label: languageLabel(nextLanguage),
                                      keepUndefined: false,
                                    });
                                    setCustomNameEditingRows((prev) => {
                                      if (!prev.has(row.id)) return prev;
                                      const next = new Set(prev);
                                      next.delete(row.id);
                                      return next;
                                    });
                                  }}
                                >
                                  <X className="h-4 w-4" />
                                </Button>
                              ) : (
                                <span className="hidden sm:block" />
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
              <div className="rounded-lg border border-border bg-muted/10 px-3 py-2">
                <label className="inline-flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={ignoreUndefinedByKind[activeInputKind]}
                    onChange={(event) => toggleIgnoreUndefinedForKind(activeInputKind, event.target.checked)}
                  />
                  {t("ingestion.ui.ignoreAndKeepTracksUndefined")}
                </label>
              </div>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">{t("ingestion.ui.noInputNeeded")}</div>
          )}
          </div>
          <DialogFooter className="shrink-0">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                stopInputSamples();
                setInputResolveModalOpen(false);
              }}
            >
              {t("ingestion.ui.close")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={!activeInputKind || inputResolveIndex === 0}
              onClick={() => {
                stopInputSamples();
                setInputResolveIndex((prev) => Math.max(0, prev - 1));
              }}
            >
              {t("ingestion.ui.back")}
            </Button>
            <Button
              type="button"
              disabled={!activeInputKind}
              onClick={() => {
                if (!activeInputKind) return;
                if (!validateInputScreen(activeInputKind)) return;
                stopInputSamples();
                if (inputResolveIndex >= inputKinds.length - 1) {
                  setInputResolveModalOpen(false);
                  return;
                }
                setInputResolveIndex((prev) => prev + 1);
              }}
            >
              {inputResolveIndex >= inputKinds.length - 1 ? t("ingestion.ui.finish") : t("ingestion.ui.next")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(subtitleSampleModalRowId)} onOpenChange={(openValue) => !openValue && setSubtitleSampleModalRowId(null)}>
        <DialogContent aria-describedby={undefined} className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("ingestion.ui.subtitleSampleTitle")}</DialogTitle>
          </DialogHeader>
          {!activeSubtitleSample ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t("ingestion.ui.preparingSample")}
            </div>
          ) : activeSubtitleSample.kind === "image" ? (
            <div className="rounded-md border border-border bg-background p-2">
              <div className="h-72 w-full overflow-hidden rounded-sm bg-black">
                <img
                  src={subtitleImagePreviewSrc ?? activeSubtitleSample.value}
                  alt={t("ingestion.ui.subtitleSampleAlt")}
                  className="h-full w-full object-contain"
                />
              </div>
            </div>
          ) : (
            <div className="rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
              {activeSubtitleSample.value}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Suspense fallback={null}>
        <FileIngestionResolveVideoDialog
          open={resolveModalOpen}
          onOpenChange={setResolveModalOpen}
          activeItem={activeResolveItem}
          resolveIndex={resolveIndex}
          totalCount={resolveDecisionItems.length}
          onBack={() => setResolveIndex((prev) => Math.max(0, prev - 1))}
          onSkip={() => applyResolveDecision("skip")}
          onAdd={() => applyResolveDecision("add")}
          t={t}
          language={accountLanguage}
        />
      </Suspense>

      <Suspense fallback={null}>
        <FileIngestionDummyDialog
          open={dummyIngestOpen}
          onOpenChange={setDummyIngestOpen}
          ingestType={dummyIngestType}
          onIngestTypeChange={setDummyIngestType}
          query={dummyIngestQuery}
          onQueryChange={setDummyIngestQuery}
          loading={dummyIngestLoading}
          error={dummyIngestError}
          results={dummyIngestResults}
          running={dummyIngestRunning}
          onSearch={handleDummySearch}
          onSelect={handleDummySelect}
          t={t}
        />
      </Suspense>

      <Suspense fallback={null}>
        <FileIngestionTrailerDialogs
          activeTrailerKey={activeTrailerKey}
          onActiveTrailerKeyChange={setActiveTrailerKey}
          openTrailerId={openTrailerId}
          onOpenTrailerIdChange={setOpenTrailerId}
          trailerCache={trailerCache}
          buildTrailerUrl={buildTrailerUrl}
          onSelectTrailer={setActiveTrailerKey}
          t={t}
        />
      </Suspense>

      {open && quotaGate && storageSummary ? (
        <Suspense fallback={null}>
          <FileIngestionQuotaDialog
            items={quotaGate.items}
            storage={storageSummary}
            pendingLocalBytes={quotaGate.pendingLocalBytes}
            billingPeriod={loadBillingPeriod()}
            onContinue={(itemIds, reason, storage) => {
              ingestLog.info({ reason, items: itemIds.length, of: quotaGate.items.length }, "import-quota.continue");
              if (storage) {
                setStorageSummary(storage);
                setStorageWarning(storageWarningLevel(storage));
              }
              setQuotaGate(null);
              void handleAdd({
                bypassQuota: true,
                onlyItemIds: reason === "selection" ? new Set(itemIds) : undefined,
              });
            }}
            onCancel={() => {
              ingestLog.info({ items: quotaGate.items.length }, "import-quota.cancelled");
              setQuotaGate(null);
            }}
          />
        </Suspense>
      ) : null}
    </>
  );
}
