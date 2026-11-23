import { formatStarRating } from "@/lib/localeFormat";
import { Suspense, lazy, useDeferredValue, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { mediaDetailPath } from "@/lib/mediaDetailRoute";
import { useTranslation } from "react-i18next";
import TopNav from "../components/TopNav";
import { ShellErrorCard } from "@space/desktop-shell/components";
import {
  dedupeMediaByIdentity,
  isOfflineModeFallbackMessage,
  isSyncUnavailableFallbackMessage,
  splitMedia,
  useCurrentLibraryVersion,
  useLibraryActions,
  useLibraryData,
  useLibraryShell,
} from "@/lib/libraryContext";
import { useIngestion } from "@/lib/ingestionContext";
import { useAuth } from "@/auth";
import { deleteStorageObjects } from "@/api";
import { extractAssetObjectKey } from "@/lib/assets";
import { useLibraryViewPrefs } from "@/lib/libraryViewPrefs";
import { useLibraryDetailsPrefetch } from "@/lib/useLibraryDetailsPrefetch";
import { useLabJobsData } from "@/lib/labJobs";
import { buildGhostLibraryItems, pruneDeletedMediaIds, useStableStageLabel } from "@/lib/libraryGhosts";
import { isLibraryVersionPending } from "@/lib/runtimeIngestJobs";
import { formatUploadSpeedLabel } from "@/lib/uploadSpeed";
import { pageLibraryContent } from "@/lib/dashboardState";
import { Button, RenderBoundary } from "@space/ui";
import { BadgerLibraryControls, BadgerLibraryRow, libraryFacetSections, BadgerPosterCard, BadgerPosterGrid, BadgerSearchField, BadgerSegmented } from "@space/ui/badger";
import { notifyWarning } from "@/lib/notify";
import { useLoadingModal } from "@/components/LoadingModalProvider";
import { MascotLoader } from "@space/ui/mascot-loader";
import mascotUrl from "@space/ui/badger/mascot.webp";
import { crewGroups } from "@space/shared/libraryCrew";
import {
  countLibraryFacetSelection,
  libraryFacetOptions,
  libraryFacetValues,
  type LibraryFacet,
  type LibraryFacetSelection,
  type LibraryFacetValues,
} from "@space/shared/libraryFacets";
import { getProgressBand, getVisibleProgressPct } from "@space/shared/progressBand";
import { Check, Film, Heart, LayoutGrid, List, ListPlus, Loader2, PlusIcon, Rows3, Trash2, Tv, User } from "lucide-react";
import MediaImage from "@/components/MediaImage";
import OfflineBadge from "@/components/OfflineBadge";
import PlayPosterOverlay from "@/components/PlayPosterOverlay";
import { useInlinePlayback } from "@/lib/useInlinePlayback";
import { getGenreName, getGenreOptions } from "@/lib/genres";
import { useOfflineStateByMediaId } from "@/lib/offlineState";
import { titleUnavailableOffline, useLibraryOnline } from "@/lib/useLibraryOnline";
import { buildActiveJobsByMediaId, mergeLibraryGridItems } from "@/pages/libraryViewState";
import {
  LIBRARY_SORT_KEYS,
  LIBRARY_VIEW_MODES,
  filterLibraryItems,
  libraryTitleMatches,
  sortLibraryItems,
  type LibraryTabPrefs,
  type LibraryViewMode,
} from "@space/shared/libraryView";
import LibraryListRows, { type LibraryListRowModel } from "@/pages/LibraryListViews";

const LibraryDeleteDialog = lazy(() => import("./LibraryDeleteDialog"));

const VIEW_MODE_ICONS = { posters: LayoutGrid, compact: List, details: Rows3 } satisfies Record<
  LibraryViewMode,
  typeof LayoutGrid
>;

// Playlists left the Library for its own top-bar tab (UX-TOP-01, Chris 2026-11-09 hand-try).
type Tab = "movie" | "tv";
const NO_TITLES: readonly { id: string }[] = [];
type GhostItem = {
  id: string;
  title: string;
  year?: string | null;
  posterPath?: string | null;
  type?: "movie" | "tv";
  progress: number;
  statusLabel: string;
  __ghost: true;
};

export default function Library() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { token } = useAuth();
  const { loading, error } = useLibraryShell();
  const { media, playlists } = useLibraryData();
  const {
    syncFromRemote,
    getMediaDetails,
    addToPlaylist,
    removeFromPlaylist,
    listPlaylistItems,
    deleteMedia,
    fetchMediaDetails,
  } = useLibraryActions();
  // Shared hover-Play plumbing (same as Home / Playlists poster grids).
  const { handlePlayMedia, pendingPlayId, playPending, playSpinnerVisible, playbackMount } =
    useInlinePlayback();
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<Tab>("movie");
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = searchParams.get("media");
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [favoriteOverrides, setFavoriteOverrides] = useState<Record<string, boolean>>({});
  const [favoritePending, setFavoritePending] = useState<Record<string, boolean>>({});
  const { openIngestion } = useIngestion();
  const { showLoading, hideLoading } = useLoadingModal();
  const prefsTab = tab === "tv" ? "tv" : "movie";
  // View mode and sort are remembered per Movies/TV tab on this computer only (local storage, never the synced client
  // config); search and filters are plain component state, so they start empty every time the screen is entered.
  const [libraryViewPrefs, setLibraryTabPrefs] = useLibraryViewPrefs();
  const { view, sortBy, sortDirection } = libraryViewPrefs[prefsTab];
  const updateTabPrefs = (patch: Partial<LibraryTabPrefs>) => setLibraryTabPrefs(prefsTab, patch);
  const [selectedGenres, setSelectedGenres] = useState<string[]>([]);
  const [selectedActors, setSelectedActors] = useState<string[]>([]);
  const [filterModalOpen, setFilterModalOpen] = useState(false);
  const [selectedFacets, setSelectedFacets] = useState<LibraryFacetSelection>({});
  const movieSentinelRef = useRef<HTMLDivElement | null>(null);
  const tvSentinelRef = useRef<HTMLDivElement | null>(null);
  const [movieRenderCount, setMovieRenderCount] = useState(40);
  const [tvRenderCount, setTvRenderCount] = useState(40);
  const { activeJobs, libraryVersionAtDoneByMediaId } = useLabJobsData();
  const currentLibraryVersion = useCurrentLibraryVersion();
  const syncUnavailableWarning = isSyncUnavailableFallbackMessage(error);

  const ghostItems = useMemo(() => {
    pruneDeletedMediaIds(activeJobs);
    return buildGhostLibraryItems(activeJobs, media, t);
  }, [activeJobs, media, t]);

  const activeJobsByMediaId = useMemo(() => buildActiveJobsByMediaId(activeJobs), [activeJobs]);

  const setMediaParam = (id: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (id) {
      next.set("media", id);
    } else {
      next.delete("media");
      next.delete("tab");
      next.delete("mediaTab");
      next.delete("player");
      next.delete("episode");
      next.delete("trailer");
    }
    setSearchParams(next);
  };

  const clearMediaOverlayParams = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("media");
    next.delete("mediaTab");
    next.delete("player");
    next.delete("episode");
    next.delete("trailer");
    setSearchParams(next, { replace: true });
  };

  useEffect(() => {
    const queryTab = searchParams.get("tab");
    // Old links to the Library's former playlists tab land on the Playlists page.
    if (queryTab === "playlists") {
      navigate("/playlists", { replace: true });
      return;
    }
    const stored = localStorage.getItem("library.tab");
    const next = queryTab === "movie" || queryTab === "tv" ? queryTab : stored === "movie" || stored === "tv" ? stored : "movie";
    setTab(next);
  }, [searchParams, navigate]);

  const handleTabChange = (nextTab: Tab) => {
    setTab(nextTab);
    localStorage.setItem("library.tab", nextTab);
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set("tab", nextTab);
    setSearchParams(nextParams);
  };

  useEffect(() => {
    const onIngestionClosed = () => {
      const next = new URLSearchParams(window.location.search);
      if (!next.has("media")) return;
      next.delete("media");
      next.delete("mediaTab");
      next.delete("player");
      next.delete("episode");
      next.delete("trailer");
      setSearchParams(next, { replace: true });
    };
    window.addEventListener("sf:ingestion-closed", onIngestionClosed);
    return () => window.removeEventListener("sf:ingestion-closed", onIngestionClosed);
  }, [setSearchParams]);

  const openIngestionFromLibrary = () => {
    if (selectedId) {
      clearMediaOverlayParams();
    }
    setDeleteTarget(null);
    setMenuOpenId(null);
    openIngestion();
  };

  const playlistLabel = (name: string, slug: string | null) => {
    if (slug === "favorites") return t("playlists.systemFavorites");
    return name;
  };

  const q = query.trim().toLowerCase();
  const activeFilterCount = selectedGenres.length + selectedActors.length;
  const matchesQuery = (title: string) => libraryTitleMatches({ title }, q);

  const dedupedMedia = useMemo(() => dedupeMediaByIdentity(media), [media]);
  const deferredMedia = useDeferredValue(dedupedMedia);
  // Offline-availability roll-up for tile badges. The hook acquires the
  // shared store once; the map is empty until the runtime bootstrap
  // completes (~one IPC round-trip on mount).
  const offlineStateByMediaId = useOfflineStateByMediaId(deferredMedia);
  // OFFL-PLAY-03: offline (no network, or the library opened locally because the
  // server is unreachable), every title stays listed but what has nothing on this
  // computer is greyed and does not open or play. @offline-mode
  const offlineMode = isOfflineModeFallbackMessage(error);
  const libraryOnline = useLibraryOnline();
  const { movies, tv } = useMemo(() => splitMedia(deferredMedia), [deferredMedia]);
  const favoritesPlaylist = useMemo(
    () => playlists.find((playlist) => playlist.slug === "favorites") ?? null,
    [playlists]
  );
  const favoritesId = favoritesPlaylist?.id ?? null;
  const favoritesSet = useMemo(
    () => (favoritesId ? new Set(listPlaylistItems(favoritesId)) : new Set<string>()),
    [favoritesId, listPlaylistItems, playlists]
  );

  const genreOptions = useMemo(() => {
    if (tab === "movie") {
      const availableGenreKeys = new Set(
        movies.flatMap((item) => (item.genres ?? []).map((id) => `movie:${id}`))
      );
      return getGenreOptions("movie", i18n.language).filter((genre) => availableGenreKeys.has(genre.key));
    }
    if (tab === "tv") {
      const availableGenreKeys = new Set(
        tv.flatMap((item) => (item.genres ?? []).map((id) => `tv:${id}`))
      );
      return getGenreOptions("tv", i18n.language).filter((genre) => availableGenreKeys.has(genre.key));
    }
    return [];
  }, [movies, tab, tv, t]);

  useEffect(() => {
    const allowed = new Set(genreOptions.map((option) => option.key));
    setSelectedGenres((prev) => prev.filter((value) => allowed.has(value)));
  }, [genreOptions]);

  const shouldBuildActors =
    filterModalOpen || selectedActors.length > 0 || countLibraryFacetSelection(selectedFacets) > 0;

  // UX-LIB-03: each title's quality / director / language / watch-state keys, from the snapshot's details.
  const facetLookup = useMemo(() => {
    const map = new Map<string, LibraryFacetValues>();
    if (!shouldBuildActors) return map;
    deferredMedia.forEach((item) => {
      const details = getMediaDetails(item.id);
      map.set(
        item.id,
        libraryFacetValues({
          qualities: (details?.formats ?? []).map((format) => format.quality),
          directors: crewGroups(details?.crew).director,
          audioLanguages: (details?.audioTracks ?? []).map((track) => track.language),
          subtitleLanguages: (details?.subtitleTracks ?? []).map((track) => track.language),
          progressPct: item.progressPct,
        })
      );
    });
    return map;
  }, [deferredMedia, getMediaDetails, shouldBuildActors]);

  const facetSections = useMemo(() => {
    if (!shouldBuildActors || (tab !== "movie" && tab !== "tv")) return [];
    const inTab = deferredMedia.filter((item) => item.type === tab).flatMap((item) => facetLookup.get(item.id) ?? []);
    return libraryFacetSections(libraryFacetOptions(inTab), t, i18n.language);
  }, [deferredMedia, facetLookup, i18n.language, shouldBuildActors, t, tab]);

  useEffect(() => {
    if (!shouldBuildActors) return;
    // As for genres and actors: a pick the tab's titles no longer offer is dropped.
    setSelectedFacets((prev) => {
      const next: LibraryFacetSelection = {};
      let changed = false;
      for (const [facet, picked] of Object.entries(prev) as [LibraryFacet, string[]][]) {
        const offered = new Set(facetSections.find((section) => section.facet === facet)?.options.map((option) => option.value));
        const kept = picked.filter((key) => offered.has(key));
        if (kept.length !== picked.length) changed = true;
        if (kept.length > 0) next[facet] = kept;
      }
      return changed ? next : prev;
    });
  }, [facetSections, shouldBuildActors]);

  const castLookup = useMemo(() => {
    if (!shouldBuildActors) return new Map<string, Set<string>>();
    const map = new Map<string, Set<string>>();
    deferredMedia.forEach((item) => {
      const details = getMediaDetails(item.id);
      const names = new Set(
        (details?.cast ?? [])
          .map((member) => member.name.trim().toLowerCase())
          .filter((name) => Boolean(name))
      );
      map.set(item.id, names);
    });
    return map;
  }, [deferredMedia, getMediaDetails, shouldBuildActors]);

  const actorOptions = useMemo(() => {
    if (!shouldBuildActors) return [];
    const options = new Set<string>();
    deferredMedia.forEach((item) => {
      if (tab === "movie" && item.type !== "movie") return;
      if (tab === "tv" && item.type !== "tv") return;
    const cast = castLookup.get(item.id);
      cast?.forEach((name) => options.add(name));
    });
    return Array.from(options)
      .map((name) => ({
        value: name,
        label: name.replace(/\b\w/g, (letter) => letter.toUpperCase()),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [castLookup, deferredMedia, tab, shouldBuildActors]);

  useEffect(() => {
    const allowed = new Set(actorOptions.map((option) => option.value));
    setSelectedActors((prev) => prev.filter((value) => allowed.has(value)));
  }, [actorOptions]);

  const genreSelectOptions = useMemo(
    () =>
      genreOptions.map((genre) => ({
        value: genre.key,
        label: genre.name,
        icon: <genre.Icon className="h-4 w-4 text-primary" />,
      })),
    [genreOptions]
  );

  const actorSelectOptions = useMemo(
    () =>
      actorOptions.map((actor) => ({
        ...actor,
        icon: <User className="h-4 w-4 text-primary" />,
      })),
    [actorOptions]
  );

  const visibleMovies = useMemo(() => {
    if (tab !== "movie") return [];
    return sortLibraryItems(
      filterLibraryItems({
        items: movies,
        query: q,
        selectedGenres,
        selectedActors,
        castLookup,
        facets: { selection: selectedFacets, lookup: facetLookup },
      }),
      sortBy,
      sortDirection
    );
  }, [movies, q, selectedGenres, selectedActors, sortBy, sortDirection, castLookup, selectedFacets, facetLookup, tab]);
  const visibleTv = useMemo(() => {
    if (tab !== "tv") return [];
    return sortLibraryItems(
      filterLibraryItems({
        items: tv,
        query: q,
        selectedGenres,
        selectedActors,
        castLookup,
        facets: { selection: selectedFacets, lookup: facetLookup },
      }),
      sortBy,
      sortDirection
    );
  }, [tv, q, selectedGenres, selectedActors, sortBy, sortDirection, castLookup, selectedFacets, facetLookup, tab]);

  const PAGE_SIZE = 40;

  useEffect(() => {
    setMovieRenderCount(Math.min(PAGE_SIZE, visibleMovies.length));
  }, [visibleMovies]);

  useEffect(() => {
    setTvRenderCount(Math.min(PAGE_SIZE, visibleTv.length));
  }, [visibleTv]);

  useEffect(() => {
    const target = movieSentinelRef.current;
    if (!target) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        setMovieRenderCount((prev) => Math.min(prev + PAGE_SIZE, visibleMovies.length));
      },
      { rootMargin: "400px" }
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [visibleMovies.length]);

  useEffect(() => {
    const target = tvSentinelRef.current;
    if (!target) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        setTvRenderCount((prev) => Math.min(prev + PAGE_SIZE, visibleTv.length));
      },
      { rootMargin: "400px" }
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [visibleTv.length]);

  const visibleMoviesSlice = visibleMovies.slice(0, movieRenderCount);
  const visibleTvSlice = visibleTv.slice(0, tvRenderCount);
  const hasMoreMovies = visibleMoviesSlice.length < visibleMovies.length;
  const hasMoreTv = visibleTvSlice.length < visibleTv.length;

  const ghostMovieItems = useMemo(
    () => {
      if (tab !== "movie") return [];
      return ghostItems
        .filter((item) => item.type === "movie" && matchesQuery(item.title))
        .map((item) => ({ ...item, id: `ghost-${item.id}`, __ghost: true as const }));
    },
    [ghostItems, q, tab]
  );
  const ghostTvItems = useMemo(
    () => {
      if (tab !== "tv") return [];
      return ghostItems
        .filter((item) => item.type === "tv" && matchesQuery(item.title))
        .map((item) => ({ ...item, id: `ghost-${item.id}`, __ghost: true as const }));
    },
    [ghostItems, q, tab]
  );
  const movieGridItems = useMemo(
    () => mergeLibraryGridItems(ghostMovieItems, visibleMoviesSlice),
    [ghostMovieItems, visibleMoviesSlice]
  );
  const tvGridItems = useMemo(
    () => mergeLibraryGridItems(ghostTvItems, visibleTvSlice),
    [ghostTvItems, visibleTvSlice]
  );
  const hasMovieItems = movieGridItems.length > 0;
  const hasTvItems = tvGridItems.length > 0;
  const handleDeleteFromGrid = async (id: string, title: string) => {
    setDeleteTarget({ id, title });
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    const loadingToken = showLoading({ title: t("library.delete"), subtitle: t("library.deleting") });
    try {
      const { keys } = await deleteMedia(deleteTarget.id);
      if (token) {
        const objectKeys = keys
          .map((key) => extractAssetObjectKey(key))
          .filter((key): key is string => typeof key === "string" && key.length > 0 && !key.startsWith("dummy_"));
        if (objectKeys.length > 0) {
          try {
            await deleteStorageObjects(token, objectKeys);
          } catch {
            notifyWarning(t("library.storageCleanupFailed", { defaultValue: "Media removed from library, but storage cleanup failed. Space will be reclaimed later." }));
          }
        }
      }
      if (selectedId === deleteTarget.id) {
        setMediaParam(null);
      }
      setDeleteTarget(null);
    } finally {
      hideLoading(loadingToken);
      setIsDeleting(false);
    }
  };

  const schedulePlaylistMutation = (
    action: () => Promise<void>,
    onSuccess?: () => void,
    onError?: () => void
  ) => {
    const run = async () => {
      try {
        await action();
        if (onSuccess) onSuccess();
      } catch {
        if (onError) onError();
      }
    };
    void run();
  };

  const handlePlaylistToggle = (mediaId: string, playlistId: string, isIn: boolean) => {
    schedulePlaylistMutation(
      () => (isIn ? removeFromPlaylist(playlistId, mediaId) : addToPlaylist(playlistId, mediaId))
    );
  };

  const isMediaDisabled = (item: (typeof media)[number]) => {
    const versionEntry = libraryVersionAtDoneByMediaId.get(item.id);
    const versionPending = isLibraryVersionPending(
      versionEntry
        ? {
            libraryVersionAtDone: versionEntry.version,
            libraryVersionDoneAt: versionEntry.doneAt,
          }
        : null,
      currentLibraryVersion,
    );
    return !item.hasFiles || versionPending;
  };

  const processingStatusLabel = (state: { hasBlocking: boolean; hasUploading: boolean } | undefined) =>
    state?.hasBlocking
      ? state.hasUploading
        ? t("library.processing.uploading")
        : t("library.processing.preparing")
      : t("library.processing.finishing");

  // The details list shows seasons and runtime, which live in the per-title details cache.
  useLibraryDetailsPrefetch(
    view === "details",
    tab === "movie" ? visibleMoviesSlice : tab === "tv" ? visibleTvSlice : NO_TITLES,
    getMediaDetails,
    fetchMediaDetails,
  );

  const renderGrid = (items: Array<(typeof media)[number] | GhostItem>) => (
    <BadgerPosterGrid testId="library-grid">
      {items.map((item) => {
        const isGhost = "__ghost" in item;
        if (isGhost) {
          return (
            <BadgerPosterCard
              key={item.id}
              testId={`library-ghost-${item.id}`}
              className="opacity-70"
              title={item.title}
              meta={item.year ?? undefined}
              onOpen={() => undefined}
              poster={
                <>
                  <MediaImage path={item.posterPath ?? null} alt={item.title} className="h-full w-full object-cover" />
                  <span className="absolute inset-0 bg-[#0d1117]/70" />
                  <span className="absolute inset-x-3 bottom-3 flex items-center gap-1.5 text-white">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <GhostStatusLabel statusLabel={item.statusLabel} />
                  </span>
                </>
              }
            />
          );
        }

        const disabled = isMediaDisabled(item);
        const activeState = activeJobsByMediaId.get(item.id);
        const isProcessing = Boolean(activeState);
        const processingProgress =
          activeState && activeState.total > 0 ? Math.round(activeState.progressSum / activeState.total) : 0;
        const statusLabel = isProcessing ? processingStatusLabel(activeState) : null;
        const uploadSpeedLabel =
          activeState && activeState.uploadSpeedCount > 0
            ? formatUploadSpeedLabel(
                t,
                activeState.uploadSpeedSum / activeState.uploadSpeedCount,
                "library.processing.uploadSpeed"
              )
            : null;
        const details = menuOpenId === item.id ? getMediaDetails(item.id) : null;
        const baseFavorite = favoritesId ? favoritesSet.has(item.id) : false;
        const isFavorite = favoriteOverrides[item.id] ?? baseFavorite;
        const isFavoritePending = Boolean(favoritePending[item.id]);
        const progressBand = getProgressBand(item.progressPct);
        const offlineState = offlineStateByMediaId.get(item.id);
        const unavailable = titleUnavailableOffline(libraryOnline, offlineState);
        return (
          <BadgerPosterCard
            key={item.id}
            testId={`library-card-${item.id}`}
            className={[menuOpenId === item.id ? "" : "library-card-cv", disabled && !unavailable ? "opacity-60 grayscale" : ""].join(" ")}
            unavailable={unavailable}
            title={item.title}
            meta={[item.year, item.rating ? formatStarRating(item.rating) : null].filter(Boolean).join(" · ") || "—"}
            watched={progressBand === "watched"}
            progressPct={progressBand === "in-progress" ? getVisibleProgressPct(item.progressPct ?? 0) : 0}
            watchedLabel={t("library.watched")}
            onOpen={() => setMediaParam(item.id)}
            poster={
              <>
                <MediaImage
                  path={item.posterPath}
                  alt={item.title}
                  className="h-full w-full object-cover transition group-hover:scale-[1.03]"
                />
                {isFavoritePending ? (
                  <span className="absolute inset-0 z-10 flex items-center justify-center bg-black/50">
                    <span className="h-6 w-6 animate-spin rounded-full border-2 border-white/30 border-t-[#ffaa54]" />
                  </span>
                ) : null}
                {isProcessing && statusLabel ? (
                  <>
                    <span className="absolute inset-0 bg-[#0d1117]/70" />
                    <span className="absolute inset-x-3 bottom-3 space-y-2 text-white">
                      <ProcessingStatusLabel
                        statusLabel={statusLabel}
                        uploadSpeedLabel={uploadSpeedLabel}
                        isFinishing={!activeState?.hasBlocking}
                      />
                      <span className="block h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                        <span
                          className={["block h-full", item.hasFiles ? "bg-[#7ee787]" : "bg-[#ffaa54]"].join(" ")}
                          style={{ width: `${processingProgress}%` }}
                        />
                      </span>
                    </span>
                  </>
                ) : null}
                {/* Offline stamp only when fully offline (movie file local, or every episode local). */}
                {offlineState === "full" ? (
                  <span className="pointer-events-none absolute left-2 top-2 z-10">
                    <OfflineBadge state="full" size="sm" inline />
                  </span>
                ) : null}
              </>
            }
            overlay={
              // OFFL-PLAY-03: an unavailable title has no hover actions and no Play button.
              unavailable ? undefined : <>
            <div
              className="absolute right-2 top-2 z-30 flex items-center gap-2 opacity-0 transition group-hover:opacity-100"
              onMouseLeave={() => setMenuOpenId((prev) => (prev === item.id ? null : prev))}
            >
            {/* hover actions: favourite, playlist, delete */}
              <Button
                type="button"
                size="icon"
                variant="secondary"
                aria-label={isFavorite ? t("library.favorites.remove") : t("library.favorites.add")}
                className="border border-[#30363d] bg-[#161b22] text-white hover:border-[#ffaa54]/60"
                onClick={async (event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (!favoritesId) return;
                  const nextValue = !isFavorite;
                  setFavoriteOverrides((prev) => ({ ...prev, [item.id]: nextValue }));
                  setFavoritePending((prev) => ({ ...prev, [item.id]: true }));
                  schedulePlaylistMutation(
                    () => (nextValue ? addToPlaylist(favoritesId, item.id) : removeFromPlaylist(favoritesId, item.id)),
                    () => {
                      setFavoriteOverrides((prev) => {
                        const next = { ...prev };
                        delete next[item.id];
                        return next;
                      });
                      setFavoritePending((prev) => {
                        const next = { ...prev };
                        delete next[item.id];
                        return next;
                      });
                    },
                    () => {
                      setFavoriteOverrides((prev) => ({ ...prev, [item.id]: isFavorite }));
                      setFavoritePending((prev) => {
                        const next = { ...prev };
                        delete next[item.id];
                        return next;
                      });
                    }
                  );
                }}
                disabled={!favoritesId || isFavoritePending}
              >
                <Heart className={["h-4 w-4", isFavorite ? "fill-[#ffaa54] text-[#ffaa54]" : ""].join(" ")} />
              </Button>
              <div className="relative">
                <Button
                  type="button"
                  size="icon"
                  variant="secondary"
                  aria-label={t("library.playlists.add")}
                  className="border border-[#30363d] bg-[#161b22] text-white hover:border-[#ffaa54]/60"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setMenuOpenId((prev) => (prev === item.id ? null : item.id));
                  }}
                >
                  <ListPlus className="h-4 w-4" />
                </Button>
                {menuOpenId === item.id ? (
                  <div
                    className="absolute right-0 top-full z-20 mt-1 w-52 rounded-xl border border-[#30363d] bg-[#0f141b] p-1 text-white shadow-2xl"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                  >
                    {playlists.filter((playlist) => playlist.slug !== "favorites").length === 0 ? (
                      <div className="px-2 py-2 text-xs text-[#8b949e]">{t("library.playlists.empty")}</div>
                    ) : (
                      playlists
                        .filter((playlist) => playlist.slug !== "favorites")
                        .map((playlist) => {
                        const isIn = details?.playlistIds.includes(playlist.id) ?? false;
                        return (
                          <button
                            key={playlist.id}
                            type="button"
                            className={[
                              "flex w-full items-center justify-between rounded-md px-2 py-2 text-sm transition",
                              isIn ? "bg-[#ffaa54]/15 text-[#ffaa54]" : "hover:bg-white/5",
                            ].join(" ")}
                            onClick={async (event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              handlePlaylistToggle(item.id, playlist.id, isIn);
                              setMenuOpenId(null);
                            }}
                          >
                            <span className="truncate">{playlistLabel(playlist.name, playlist.slug)}</span>
                            <span className="text-[#8b949e]">
                              {isIn ? <Check className="h-3.5 w-3.5" /> : <PlusIcon className="h-3.5 w-3.5" />}
                            </span>
                          </button>
                        );
                      })
                    )}
                  </div>
                ) : null}
              </div>
              <Button
                type="button"
                size="icon"
                variant="secondary"
                aria-label={t("library.delete")}
                className="border border-[#30363d] bg-[#1a1416] text-[#ff7b72] hover:bg-[#221517]"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  void handleDeleteFromGrid(item.id, item.title);
                }}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
            {!disabled ? (
              // Sized to the poster; only the Play button takes clicks, the rest falls through to the open button.
              <div className="pointer-events-none absolute inset-x-0 top-0 aspect-[2/3] overflow-hidden rounded-lg [&_button]:pointer-events-auto">
                <PlayPosterOverlay
                  mediaId={item.id}
                  pending={pendingPlayId === item.id && playPending}
                  spinnerVisible={pendingPlayId === item.id && playPending && playSpinnerVisible}
                  onPlay={handlePlayMedia}
                />
              </div>
            ) : null}
              </>
            }
          />
        );
      })}
    </BadgerPosterGrid>
  );

  const renderListSection = (
    items: Array<(typeof media)[number] | GhostItem>,
    sentinelRef: RefObject<HTMLDivElement | null>,
    hasMore: boolean,
    listView: "compact" | "details"
  ) => {
    const rows = items.map((item): LibraryListRowModel => {
      if ("__ghost" in item) {
        return {
          id: item.id,
          title: item.title,
          year: item.year ?? null,
          posterPath: item.posterPath ?? null,
          rating: null,
          overview: null,
          genres: [],
          seasonCount: null,
          runtimeMinutes: null,
          progressPct: 0,
          disabled: true,
          offlineFull: false,
          ghostStatus: <GhostStatusLabel statusLabel={item.statusLabel} />,
          processing: null,
        };
      }
      const details = listView === "details" ? getMediaDetails(item.id) : null;
      const longestFormat = Math.max(0, ...(details?.formats ?? []).map((format) => format.durationSeconds ?? 0));
      const activeState = activeJobsByMediaId.get(item.id);
      return {
        id: item.id,
        title: item.title,
        year: item.year,
        posterPath: item.posterPath,
        rating: item.rating,
        overview: item.overview,
        genres: (item.genres ?? []).flatMap((id) => getGenreName(item.type, id, i18n.language) ?? []),
        seasonCount: item.type === "tv" && details ? details.seasons.length : null,
        runtimeMinutes: item.type === "movie" && longestFormat > 0 ? Math.round(longestFormat / 60) : null,
        progressPct: item.progressPct,
        disabled: isMediaDisabled(item),
        unavailable: titleUnavailableOffline(libraryOnline, offlineStateByMediaId.get(item.id)),
        offlineFull: offlineStateByMediaId.get(item.id) === "full",
        ghostStatus: null,
        processing: activeState
          ? {
              label: processingStatusLabel(activeState),
              progress: activeState.total > 0 ? Math.round(activeState.progressSum / activeState.total) : 0,
            }
          : null,
      };
    });
    return (
      <div className="space-y-4">
        {/* UX-CRASH-01: a crashing list blanks only itself. */}
        <RenderBoundary name="library-list">
          <LibraryListRows
            rows={rows}
            view={listView}
            pendingPlayId={pendingPlayId}
            playPending={playPending}
            onOpen={setMediaParam}
            onPlay={handlePlayMedia}
          />
        </RenderBoundary>
        {hasMore ? <div ref={sentinelRef} className="h-1" /> : null}
      </div>
    );
  };

  const renderGridSection = (
    items: Array<(typeof media)[number] | GhostItem>,
    sentinelRef: RefObject<HTMLDivElement | null>,
    hasMore: boolean
  ) =>
    view === "posters" ? (
      <div className="space-y-4">
        <RenderBoundary name="library-grid">{renderGrid(items)}</RenderBoundary>
        {hasMore ? <div ref={sentinelRef} className="h-1" /> : null}
      </div>
    ) : (
      renderListSection(items, sentinelRef, hasMore, view)
    );

  // UX-WAIT-04: the page is empty only once the load says so; `deferredMedia === dedupedMedia` waits for the listed
  // copy to catch up with the provider's list, so a library still being listed never bounces to the empty Home.
  const libraryState = pageLibraryContent({
    loading,
    listed: deferredMedia === dedupedMedia,
    itemCount: deferredMedia.length + ghostItems.length,
  });
  const empty = libraryState === "empty";

  useEffect(() => {
    if (error) return;
    if (!empty) return;
    navigate("/home", { replace: true });
  }, [empty, error, navigate]);

  const movieEmptyState = (
    <div className="rounded-2xl border border-dashed border-[#30363d] bg-[#0f141b]/80 p-4 text-white">
      <div className="flex items-center gap-2 text-sm text-[#8b949e]">
        <Film className="h-4 w-4 text-[#ffaa54]" />
        {t("library.noMovies")}
      </div>
      <div className="mt-3">
        <Button
          type="button"
          size="sm"
          onClick={() => {
            openIngestionFromLibrary();
          }}
          className="bg-[#ffaa54] text-[#0d1117] hover:bg-[#ff9b30]"
        >
          {t("library.addFirstMovie")}
        </Button>
      </div>
    </div>
  );
  const tvEmptyState = (
    <div className="rounded-2xl border border-dashed border-[#30363d] bg-[#0f141b]/80 p-4 text-white">
      <div className="flex items-center gap-2 text-sm text-[#8b949e]">
        <Tv className="h-4 w-4 text-[#ffaa54]" />
        {t("library.noShows")}
      </div>
      <div className="mt-3">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => {
            openIngestionFromLibrary();
          }}
          className="border border-[#30363d] bg-[#161b22] text-white hover:border-[#ffaa54]/60"
        >
          {t("library.addFirstShow")}
        </Button>
      </div>
    </div>
  );

  return (
    <div className="relative min-h-screen text-foreground">
      <TopNav />
      <main className="relative space-y-[18px] px-10 pb-[26px] pt-3.5">

        {error && !syncUnavailableWarning && !offlineMode ? (
          <ShellErrorCard
            title={t("library.errorTitle")}
            message={error}
            actions={
              <>
                <Button type="button" onClick={() => void syncFromRemote()} className="bg-[#ffaa54] text-[#0d1117] hover:bg-[#ff9b30]">
                  {t("library.retrySync")}
                </Button>
                <Button asChild variant="secondary" className="border border-[#30363d] bg-[#0f141b] text-white">
                  <Link to="/onboarding/key">{t("library.manageKey")}</Link>
                </Button>
              </>
            }
          />
        ) : null}

        <BadgerLibraryRow
          toggle={
            <BadgerSegmented<Tab>
              ariaLabel={t("nav.library")}
              value={tab}
              onChange={handleTabChange}
              options={[
                { id: "movie", label: t("library.tabs.movies"), icon: <Film className="h-3.5 w-3.5" />, testId: "library-tab-movie" },
                { id: "tv", label: t("library.tabs.tv"), icon: <Tv className="h-3.5 w-3.5" />, testId: "library-tab-tv" },
              ]}
            />
          }
          search={
            tab === "movie" || tab === "tv" ? (
              <BadgerSearchField value={query} onChange={setQuery} placeholder={t("library.searchPlaceholder")} />
            ) : null
          }
          trailing={
            tab === "movie" || tab === "tv" ? (
              <>
                <BadgerLibraryControls
                  labels={{
                    filter: t("library.filters.title"),
                    clear: t("library.filters.clearShort"),
                    reset: t("library.filters.reset"),
                    apply: t("library.filters.apply"),
                    sort: t("library.sort.button"),
                    sortTitle: t("library.sort.title"),
                    sortBy: t("library.sort.by"),
                    sortDirection: t("library.sort.direction"),
                    directionText: t(`library.sort.${sortDirection}`),
                    done: t("library.sort.done"),
                    close: t("common.close"),
                    genres: {
                      title: t("library.filters.genres.title"),
                      placeholder: t("library.filters.genres.placeholder"),
                      search: t("library.filters.genres.search"),
                      empty: t("library.filters.genres.empty"),
                    },
                    actors: {
                      title: t("library.filters.actors.title"),
                      placeholder: t("library.filters.actors.placeholder"),
                      search: t("library.filters.actors.search"),
                      empty: t("library.filters.actors.empty"),
                    },
                    nextView: (view) => t("library.view.next", { view }),
                  }}
                  genreOptions={genreSelectOptions}
                  actorOptions={actorSelectOptions}
                  genres={selectedGenres}
                  actors={selectedActors}
                  facetSections={facetSections}
                  facets={selectedFacets}
                  onFiltersChange={(genres, actors, facets) => {
                    setSelectedGenres(genres);
                    setSelectedActors(actors);
                    setSelectedFacets(facets);
                  }}
                  onFilterOpenChange={setFilterModalOpen}
                  sortOptions={LIBRARY_SORT_KEYS.map((key) => ({ value: key, label: t(`library.sort.${key}`) }))}
                  sortBy={sortBy}
                  onSortByChange={(value) => updateTabPrefs({ sortBy: value })}
                  sortDirection={sortDirection}
                  onToggleSortDirection={() => updateTabPrefs({ sortDirection: sortDirection === "asc" ? "desc" : "asc" })}
                  viewOptions={LIBRARY_VIEW_MODES.map((mode) => {
                    const Icon = VIEW_MODE_ICONS[mode];
                    return { id: mode, label: t(`library.view.${mode}`), icon: <Icon /> };
                  })}
                  view={view}
                  onViewChange={(mode) => updateTabPrefs({ view: mode })}
                  disabled={tab === null}
                />
              </>
            ) : null
          }
        />

            {libraryState === "loading" ? (
              // UX-WAIT-02: the hovering badger above the unchanged loading text while the library opens.
              <div className="flex w-fit flex-col items-center gap-4">
                <MascotLoader app="badger" src={mascotUrl} size={120} />
                <div className="text-sm text-[#8b949e]">{t("library.loading")}</div>
              </div>
            ) : empty && tab === "movie" ? (
              movieEmptyState
            ) : empty && tab === "tv" ? (
              tvEmptyState
            ) : empty ? (
              <div className="space-y-8">
                <section className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.2em] text-[#8b949e]">
                      <Film className="h-5 w-5 text-[#ffaa54]" />
                      {t("library.sections.movies")}
                    </div>
                    <div className="text-sm text-[#8b949e]">
                      {t("library.sections.count", { count: 0 })}
                    </div>
                  </div>
                  {movieEmptyState}
                </section>
                <section className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.2em] text-[#8b949e]">
                      <Tv className="h-5 w-5 text-[#ffaa54]" />
                      {t("library.sections.tv")}
                    </div>
                    <div className="text-sm text-[#8b949e]">
                      {t("library.sections.count", { count: 0 })}
                    </div>
                  </div>
                  {tvEmptyState}
                </section>
              </div>
            ) : tab === "movie" ? (
              !hasMovieItems
                ? movieEmptyState
                : renderGridSection(movieGridItems, movieSentinelRef, hasMoreMovies)
            ) : tab === "tv" ? (
              !hasTvItems
                ? tvEmptyState
                : renderGridSection(tvGridItems, tvSentinelRef, hasMoreTv)
            ) : (
              <div className="space-y-8">
                <section className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.2em] text-[#8b949e]">
                      <Film className="h-5 w-5 text-[#ffaa54]" />
                      {t("library.sections.movies")}
                    </div>
                    <div className="text-sm text-[#8b949e]">
                      {t("library.sections.count", { count: visibleMovies.length })}
                    </div>
                  </div>
                  {!hasMovieItems ? movieEmptyState : renderGridSection(movieGridItems, movieSentinelRef, hasMoreMovies)}
                </section>
                <section className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.2em] text-[#8b949e]">
                      <Tv className="h-5 w-5 text-[#ffaa54]" />
                      {t("library.sections.tv")}
                    </div>
                    <div className="text-sm text-[#8b949e]">
                      {t("library.sections.count", { count: visibleTv.length })}
                    </div>
                  </div>
                  {!hasTvItems ? tvEmptyState : renderGridSection(tvGridItems, tvSentinelRef, hasMoreTv)}
                </section>
              </div>
            )}

        {selectedId ? <Navigate replace to={mediaDetailPath(selectedId, searchParams)} /> : null}
        {playbackMount}

        {deleteTarget ? (
          <Suspense fallback={null}>
            <LibraryDeleteDialog
              deleteTarget={deleteTarget}
              isDeleting={isDeleting}
              onClose={() => setDeleteTarget(null)}
              onConfirm={confirmDelete}
            />
          </Suspense>
        ) : null}
      </main>
    </div>
  );
}

// Phase 4: minimum-dwell window for status text on library tiles. Same
// floor as LabStatusBadge so the visible "Uploading"/"Preparing" text
// holds long enough to register. The terminal sentinel is "" (the
// statusLabel only exists while processing — once it goes nullish the
// parent unmounts this component).
const TILE_STAGE_LABEL_DWELL_MS = 600;

function GhostStatusLabel({ statusLabel }: { statusLabel: string }) {
  // Ghost items only exist for in-flight ingests; there is no terminal
  // state at this layer — the parent unmounts the ghost once the matched
  // media row appears. So no isTerminal predicate is needed.
  const stable = useStableStageLabel<string>(statusLabel, {
    minDwellMs: TILE_STAGE_LABEL_DWELL_MS,
  });
  return <div className="text-[10px] text-[#8b949e]">{stable}</div>;
}

function ProcessingStatusLabel({
  statusLabel,
  uploadSpeedLabel,
  isFinishing,
}: {
  statusLabel: string;
  uploadSpeedLabel: string | null;
  isFinishing: boolean;
}) {
  // The "finishing" branch is the closest thing to a terminal state on
  // the in-tile overlay (the parent removes the overlay entirely once
  // processing settles). We treat finishing as terminal so the user
  // sees it land immediately even if the prior label was still inside
  // its dwell window.
  type State = { label: string; speed: string | null; finishing: boolean };
  const stable = useStableStageLabel<State>(
    { label: statusLabel, speed: uploadSpeedLabel, finishing: isFinishing },
    {
      minDwellMs: TILE_STAGE_LABEL_DWELL_MS,
      isTerminal: (s) => s.finishing,
      equals: (a, b) =>
        a.label === b.label && a.speed === b.speed && a.finishing === b.finishing,
    },
  );
  return (
    <div className="text-xs font-semibold truncate">
      {stable.label}
      {stable.speed ? ` · ${stable.speed}` : ""}
    </div>
  );
}
