import { formatRating } from "@/lib/localeFormat";
import { lazy, memo, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { mediaDetailPath } from "@/lib/mediaDetailRoute";
import { useTranslation } from "react-i18next";
import {
  ChevronLeft,
  ChevronRight,
  Clock,
  EyeOff,
  Heart,
  ListPlus,
  PlayCircle,
  Plus,
  Repeat,
} from "lucide-react";
import TopNav from "../components/TopNav";
import {
  dedupeMediaByIdentity,
  isOfflineModeFallbackMessage,
  isSyncUnavailableFallbackMessage,
  splitMedia,
  useLibraryActions,
  useLibraryData,
  useLibraryShell,
} from "@/lib/libraryContext";
import {
  buildDashboardActiveJobsByMediaId,
  type DashboardActiveJobState,
  reuseSameIdSet,
  reuseUnchangedActiveJobStates,
  filterDashboardItems,
  pageLibraryContent,
  selectDashboardImportingMedia,
  selectDashboardVisibleMedia,
  sortDashboardItems,
} from "@/lib/dashboardState";
import { useIngestion } from "@/lib/ingestionContext";
import { useLabJobsData } from "@/lib/labJobs";
import { buildGhostLibraryItems, type GhostLibraryItem } from "@/lib/libraryGhosts";
import { Button, RenderBoundary } from "@space/ui";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@space/ui";
import MediaImage from "@/components/MediaImage";
import OfflineBadge from "@/components/OfflineBadge";
import { useOfflineStateByMediaId, type OfflineStateRollUp } from "@/lib/offlineState";
import { useContentStable } from "@/lib/useContentStable";
import { titleUnavailableOffline, useLibraryOnline } from "@/lib/useLibraryOnline";
import { useDragScroll } from "@/lib/useDragScroll";
import { UNAVAILABLE_CLASS } from "@space/ui/unavailable";
import emptyLibraryBg from "../assets/mascot.webp";
import { BadgerRowHead } from "@space/ui/badger";
import { EmptyLibrary } from "@space/ui";
import { DesktopTourHost } from "@space/desktop-shell/tour";
import tourDropVideo from "../assets/tour-drop.webm";
import DashboardContinueHero from "@/components/DashboardContinueHero";
import { continueWatchingTitles } from "@space/shared/continueWatching";
import { MediaRow, PlaylistRow } from "@/lib/libraryDb";
import type { DashboardSectionConfig, LibraryScope, SectionType } from "@/lib/dashboardLayoutTypes";
import { getGenreName, getGenreOptions } from "@/lib/genres";
import { genreIcon } from "@space/ui/badger/genre-icons";
import { getProgressBand, getVisibleProgressPct } from "@space/shared/progressBand";
import { ShellErrorCard } from "@space/desktop-shell/components";
import { useInlinePlayback } from "@/lib/useInlinePlayback";
import PlayPosterOverlay from "@/components/PlayPosterOverlay";
import { LibraryLoading } from "@/components/LoadingScreen";

const MAX_SECTION_ITEMS = 10;
const DASHBOARD_LAYOUT_KEY = "dashboard_layout_v1";
const DashboardEditLayout = lazy(() => import("@/components/DashboardEditLayout"));
const DashboardAddSectionDialog = lazy(() => import("./DashboardAddSectionDialog"));

type CarouselRowProps = {
  items: MediaRow[];
  // UX-HOME-03: imports that have no library title yet ("Queued…"), drawn first as greyed posters.
  importing?: GhostLibraryItem[];
  onSelect: (id: string) => void;
  showProgress?: boolean;
  renderActions?: (item: MediaRow) => ReactNode;
  activeJobsByMediaId?: Map<string, DashboardActiveJobState>;
};

// The dark veil, import status and progress bar over a poster that is still importing (UX-HOME-03).
const ImportProgressOverlay = ({
  label,
  progress,
  playable,
  testId,
}: {
  label: string;
  progress: number;
  playable: boolean;
  testId: string;
}) => (
  <div className="absolute inset-0 z-10 flex flex-col justify-end bg-[#0d1117]/70 p-3" data-testid={testId}>
    <div className="space-y-2 text-white">
      <div className="text-xs font-semibold truncate">{label}</div>
      <div className="h-1.5 w-full rounded-full bg-white/10 overflow-hidden">
        <div
          className={["h-full", playable ? "bg-[#7ee787]" : "bg-[#ffaa54]"].join(" ")}
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  </div>
);

const hashSeed = (seed: string) => {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const seededShuffle = <T,>(items: T[], seed: string) => {
  const result = [...items];
  let state = hashSeed(seed) || 1;
  for (let i = result.length - 1; i > 0; i -= 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const idx = Math.abs(state) % (i + 1);
    [result[i], result[idx]] = [result[idx], result[i]];
  }
  return result;
};

const pickRandom = <T,>(items: T[], count: number, seed: string) =>
  seededShuffle(items, seed).slice(0, count);

const ensureLibraries = (libraries: unknown): LibraryScope[] => {
  const values = Array.isArray(libraries) ? libraries : [];
  const filtered = values.filter((value): value is LibraryScope => value === "movies" || value === "tv");
  return filtered.length ? filtered : ["movies", "tv"];
};

const createSection = (type: SectionType, playlistId?: string | null, fixedId?: string): DashboardSectionConfig => ({
  id: fixedId ?? (playlistId ? `section-playlist-${playlistId}` : `section-${type}`),
  type,
  playlistId: playlistId ?? null,
  genreId: null,
  genreType: null,
  libraries: ["movies", "tv"],
  styleId: 0,
});

const createGenreSection = (genreType: "movie" | "tv", genreId: number): DashboardSectionConfig => ({
  id: `section-genre-${genreType}-${genreId}`,
  type: "genre",
  playlistId: null,
  genreId,
  genreType,
  libraries: [genreType === "tv" ? "tv" : "movies"],
  styleId: 0,
});

const buildDefaultLayout = (playlists: PlaylistRow[]): DashboardSectionConfig[] => {
  const watchlistId = playlists.find((playlist) => playlist.slug === "watchlist")?.id ?? null;
  const base: DashboardSectionConfig[] = [
    createSection("continue"),
    createSection("recent"),
    createSection("unwatched"),
    createSection("favorites"),
  ];
  if (watchlistId) {
    base.push(createSection("playlist", watchlistId));
  }
  return base;
};

const parseLayout = (raw: string | null | undefined, playlists: PlaylistRow[]): DashboardSectionConfig[] => {
  const fallback = buildDefaultLayout(playlists);
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as { sections?: DashboardSectionConfig[] };
    if (!parsed?.sections || !Array.isArray(parsed.sections)) return fallback;
    const playlistIds = new Set(playlists.map((playlist) => playlist.id));
    const watchlistId = playlists.find((playlist) => playlist.slug === "watchlist")?.id ?? null;
    const sections = parsed.sections
      .filter((section) => section && typeof section === "object")
      .map((section) => {
        const rawType = String(section.type ?? "");
        const normalizedType = rawType === "watchlist" ? "playlist" : rawType;
        const playlistId =
          normalizedType === "playlist"
            ? rawType === "watchlist"
              ? watchlistId
              : section.playlistId ?? null
            : null;
        return {
        id: typeof section.id === "string" ? section.id : crypto.randomUUID(),
        type: normalizedType as DashboardSectionConfig["type"],
        playlistId,
        genreId: Number.isFinite(Number(section.genreId)) ? Number(section.genreId) : null,
        genreType: section.genreType === "tv" ? "tv" : section.genreType === "movie" ? "movie" : null,
        libraries:
          normalizedType === "genre"
            ? [section.genreType === "tv" ? "tv" : "movies"]
            : ensureLibraries(section.libraries),
        styleId: Number.isFinite(Number(section.styleId)) ? Number(section.styleId) : 0,
        } as DashboardSectionConfig;
      })
      .filter((section) => {
        if (section.type === "playlist") return section.playlistId && playlistIds.has(section.playlistId);
        if (section.type === "genre") return section.genreId !== null && section.genreType !== null;
        return ["continue", "recent", "unwatched", "rewatch", "favorites"].includes(section.type);
      });
    return sections.length ? sections : fallback;
  } catch {
    return fallback;
  }
};

type DashboardCardProps = {
  item: MediaRow;
  activeState: DashboardActiveJobState | undefined;
  offlineState: OfflineStateRollUp | undefined;
  libraryOnline: boolean;
  showProgress?: boolean;
  isDragging: boolean;
  wasDrag: () => boolean;
  onSelect: (id: string) => void;
  renderActions?: (item: MediaRow) => ReactNode;
};

// @bugfix #2461 @regression-proof: one Home poster, memoised. Runtime job progress re-renders the Home page
// several times a second during an ingest; before, every carousel re-ran every card's body (rating format,
// translations, overlays) on each tick (frame p95 50 ms in perf-during-ingest.e2e.test.ts against 33 ms). Now a
// card re-renders only when its own title, import state, offline state or the play action state changes; the
// Dashboard keeps those props referentially stable (reuseSameIdSet / reuseUnchangedActiveJobStates).
const DashboardCard = memo(function DashboardCard({
  item,
  activeState,
  offlineState,
  libraryOnline,
  showProgress,
  isDragging,
  wasDrag,
  onSelect,
  renderActions,
}: DashboardCardProps) {
  const { t } = useTranslation();
  const disabled = !item.hasFiles;
  // OFFL-PLAY-03: offline, a title with nothing on this computer is greyed and neither opens nor plays.
  const unavailable = titleUnavailableOffline(libraryOnline, offlineState);
  const progress = showProgress ? getVisibleProgressPct(item.progressPct || 0) : 0;
  const isProcessing = Boolean(activeState);
  const processingProgress =
    activeState && activeState.total > 0 ? Math.round(activeState.progressSum / activeState.total) : 0;
  const processingStatusLabel = isProcessing
    ? activeState?.hasBlocking
      ? activeState?.hasUploading
        ? t("library.processing.uploading")
        : t("library.processing.preparing")
      : t("library.processing.finishing")
    : null;
  return (
    <div
      data-testid={`dashboard-card-${item.id}`}
      data-media-id={item.id}
      data-importing={(disabled && isProcessing) || undefined}
      data-unavailable={unavailable || undefined}
      aria-disabled={unavailable || undefined}
      // UX-HOME-01: a freestanding poster on the sky (no card box), seven to a row like the shared poster grid.
      className={[
        "group relative min-w-[140px] w-[calc((100%-132px)/7)] shrink-0 text-left",
        unavailable ? `cursor-default ${UNAVAILABLE_CLASS}` : "cursor-pointer",
        disabled && !unavailable ? "opacity-60 grayscale" : "",
        isDragging ? "pointer-events-none" : ""
      ].join(" ")}
      onClick={(e) => {
        if (unavailable) return;
        if ((e.target as HTMLElement).closest("button")) return;
        if (wasDrag()) return;
        onSelect(item.id);
      }}
    >
      <div className="relative aspect-[2/3] rounded-xl bg-muted pointer-events-none shadow-[0_12px_28px_rgba(0,0,0,0.4)]">
        <div className="absolute inset-0 overflow-hidden rounded-xl ring-1 ring-white/10 transition group-hover:ring-[#ffaa54]/60">
          <MediaImage
            path={item.posterPath}
            alt={item.title}
            className="h-full w-full object-cover transition group-hover:scale-[1.03]"
          />
          {item.rating ? (
            <span className="absolute right-2 top-2 rounded-full bg-[#ffaa54] px-2 py-0.5 text-[11px] font-semibold text-[#0d1117]">
              {formatRating(item.rating)}
            </span>
          ) : null}
          {/* Stamp ONLY when fully offline (matches the movie treatment) — partial coverage shows no stamp. */}
          {offlineState === "full" ? (
            <div className="absolute left-2 top-2 z-10 pointer-events-none">
              <OfflineBadge state="full" size="sm" inline />
            </div>
          ) : null}
          {isProcessing && processingStatusLabel ? (
            <ImportProgressOverlay
              label={processingStatusLabel}
              progress={processingProgress}
              playable={Boolean(item.hasFiles)}
              testId={`dashboard-card-processing-${item.id}`}
            />
          ) : null}
        </div>
        {/* UX-HOME-03: a title that cannot be played yet has no Play button. */}
        {renderActions && !unavailable && !disabled ? (
          <div className="absolute inset-0 z-20 pointer-events-auto">
            {renderActions(item)}
          </div>
        ) : null}
      </div>
      <div className="mt-2.5 min-w-0 pointer-events-none">
        <div className="truncate text-sm font-semibold">{item.title}</div>
        <div className="mt-0.5 truncate text-[12.5px] text-muted-foreground">
          {[
            item.year ?? "—",
            item.type === "tv" && item.episodeCount > 0
              ? t("library.labels.episodeShort", { count: item.episodeCount })
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </div>
      </div>
      {showProgress ? (
        <div className="mt-2 pointer-events-none">
          <div className="h-1 w-full rounded-full bg-white/10">
            <div className="h-1 rounded-full bg-[#ffaa54]" style={{ width: `${progress}%` }} />
          </div>
        </div>
      ) : null}
    </div>
  );
});

const CarouselRow = ({ items, importing, onSelect, showProgress, renderActions, activeJobsByMediaId }: CarouselRowProps) => {
  const { scrollerRef, isDragging, wasDrag, handlers: dragHandlers } = useDragScroll<HTMLDivElement>();
  // Per-row offline-state hydration. The hook acquires the shared store
  // once and rolls per-fileId entries up to per-media. Empty store → empty
  // map → no badges, which is the safe default.
  const offlineStateByMediaId = useOfflineStateByMediaId(items);
  const libraryOnline = useLibraryOnline();
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const useCarousel = true;

  const checkScroll = () => {
    if (!useCarousel) return;
    if (!scrollerRef.current) return;
    const { scrollLeft, scrollWidth, clientWidth } = scrollerRef.current;
    setCanScrollLeft(scrollLeft > 0);
    setCanScrollRight(scrollLeft < scrollWidth - clientWidth - 10);
  };

  useEffect(() => {
    if (!useCarousel) {
      setCanScrollLeft(false);
      setCanScrollRight(false);
      return;
    }
    checkScroll();
    const el = scrollerRef.current;
    if (el) {
      el.addEventListener("scroll", checkScroll);
      window.addEventListener("resize", checkScroll);
      return () => {
        el.removeEventListener("scroll", checkScroll);
        window.removeEventListener("resize", checkScroll);
      };
    }
  }, [items, useCarousel]);

  return (
    <div className="relative min-w-0 space-y-3 group/carousel">
      {/* The chevrons only bounce while hovered (when they are visible): an infinite animation on an
          opacity-0 element still costs style + compositor work every frame on every carousel (#928). */}
      {useCarousel && canScrollLeft && (
        <div className="absolute left-2 top-1/2 -translate-y-1/2 z-20 pointer-events-none opacity-0 transition-opacity duration-300 group-hover/carousel:opacity-100">
          <ChevronLeft className="h-8 w-8 text-[#ffaa54] group-hover/carousel:animate-bounce-x-left" />
        </div>
      )}
      
      {useCarousel && canScrollRight && (
        <div className="absolute right-2 top-1/2 -translate-y-1/2 z-20 pointer-events-none opacity-0 transition-opacity duration-300 group-hover/carousel:opacity-100">
          <ChevronRight className="h-8 w-8 text-[#ffaa54] group-hover/carousel:animate-bounce-x-right" />
        </div>
      )}

      <div
        ref={scrollerRef}
        className={`no-scrollbar flex w-full max-w-full gap-[22px] overflow-x-auto pb-2 select-none ${isDragging ? "cursor-grabbing" : "cursor-grab"}`}
        {...dragHandlers}
      >
        {(importing ?? []).map((ghost) => (
          // UX-HOME-03: an import with no library title yet, greyed with its status; it does not open until it is a title.
          <div
            key={`ghost-${ghost.id}`}
            data-testid={`dashboard-importing-${ghost.id}`}
            data-importing="true"
            aria-disabled="true"
            className="relative min-w-[140px] w-[calc((100%-132px)/7)] shrink-0 cursor-default text-left opacity-60 grayscale"
          >
            <div className="relative aspect-[2/3] rounded-xl bg-muted pointer-events-none shadow-[0_12px_28px_rgba(0,0,0,0.4)]">
              <div className="absolute inset-0 overflow-hidden rounded-xl ring-1 ring-white/10">
                <MediaImage path={ghost.posterPath ?? null} alt={ghost.title} className="h-full w-full object-cover" />
                <ImportProgressOverlay
                  label={ghost.statusLabel}
                  progress={ghost.progress}
                  playable={false}
                  testId={`dashboard-importing-processing-${ghost.id}`}
                />
              </div>
            </div>
            <div className="mt-2.5 min-w-0 pointer-events-none">
              <div className="truncate text-sm font-semibold">{ghost.title}</div>
              <div className="mt-0.5 truncate text-[12.5px] text-muted-foreground">{ghost.year ?? "—"}</div>
            </div>
          </div>
        ))}
        {items.map((item) => (
          // UX-CRASH-01: a card that throws shows a placeholder in its place; the rest of the row stays.
          <RenderBoundary key={item.id} name={`home-card:${item.id}`} variant="item" className="min-w-[140px] w-[calc((100%-132px)/7)] shrink-0 aspect-[2/3]">
          {() => (
            <DashboardCard
              item={item}
              activeState={activeJobsByMediaId?.get(item.id)}
              offlineState={offlineStateByMediaId.get(item.id)}
              libraryOnline={libraryOnline}
              showProgress={showProgress}
              isDragging={useCarousel && isDragging}
              wasDrag={wasDrag}
              onSelect={onSelect}
              renderActions={renderActions}
            />
          )}
          </RenderBoundary>
        ))}
      </div>
    </div>
  );
};

export default function Dashboard() {
  const { t, i18n } = useTranslation();
  const { loading, error } = useLibraryShell();
  const { media, playlists } = useLibraryData();
  const {
    listPlaylistItems,
    getSystemPlaylistId,
    getSharedSetting,
    setSharedSetting,
  } = useLibraryActions();
  const { activeJobs, completedJobs } = useLabJobsData();
  const deferredActiveJobs = useDeferredValue(activeJobs);
  const syncUnavailableWarning = isSyncUnavailableFallbackMessage(error);
  const deferredCompletedJobs = useDeferredValue(completedJobs);
  const deferredMedia = useDeferredValue(media);
  // OFFL-PLAY-03: offline, every carousel keeps all its titles; the cards grey out
  // what has nothing on this computer (CarouselRow). @offline-mode
  const offlineMode = isOfflineModeFallbackMessage(error);
  const libraryOnline = useLibraryOnline();
  const dashboardOfflineState = useOfflineStateByMediaId(deferredMedia);
  const deferredPlaylists = useDeferredValue(playlists);
  // @bugfix #2461: every job progress tick rebuilds the jobs lists; the id Sets and per-title import states below
  // keep their identity while their contents do not change, so the media memos and the memoised cards that depend
  // on them do not redo their work several times a second during an ingest.
  const completedSourceMediaIds = useContentStable(
    useMemo(() => {
      const ids = new Set<string>();
      deferredCompletedJobs.forEach((job) => {
        if (job.matchedMediaId && job.includeSource) {
          ids.add(job.matchedMediaId);
        }
      });
      return ids;
    }, [deferredCompletedJobs]),
    reuseSameIdSet
  );

  const activeMediaIds = useContentStable(
    useMemo(() => {
      const ids = new Set<string>();
      deferredActiveJobs.forEach((job) => {
        if (job.matchedMediaId) ids.add(job.matchedMediaId);
      });
      return ids;
    }, [deferredActiveJobs]),
    reuseSameIdSet
  );

  const visibleMedia = useMemo(() => {
    if (!deferredMedia.length) return deferredMedia;
    return selectDashboardVisibleMedia(deferredMedia, activeMediaIds, completedSourceMediaIds);
  }, [activeMediaIds, completedSourceMediaIds, deferredMedia]);

  const activeJobsByMediaId = useContentStable(
    useMemo(() => buildDashboardActiveJobsByMediaId(deferredActiveJobs), [deferredActiveJobs]),
    reuseUnchangedActiveJobStates
  );

  const dedupedMedia = useMemo(() => dedupeMediaByIdentity(visibleMedia), [visibleMedia]);
  const dedupedAllMedia = useMemo(() => dedupeMediaByIdentity(deferredMedia), [deferredMedia]);
  const playableMedia = useMemo(() => dedupedMedia.filter((item) => item.hasFiles), [dedupedMedia]);
  // UX-HOME-03: importing titles (no files yet) and imports with no title yet show greyed in "Recently added".
  const importingMedia = useMemo(
    () => selectDashboardImportingMedia(dedupedAllMedia, activeMediaIds),
    [activeMediaIds, dedupedAllMedia]
  );
  const importingGhosts = useMemo(
    () => buildGhostLibraryItems(deferredActiveJobs, deferredMedia, t),
    [deferredActiveJobs, deferredMedia, t]
  );
  const importingCount = importingMedia.length + importingGhosts.length;
  const { movies, tv } = useMemo(() => splitMedia(playableMedia), [playableMedia]);
  const { openIngestion } = useIngestion();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = searchParams.get("media");
  const editRequested = searchParams.get("edit") === "1";
  const returnToSettings = searchParams.get("returnTo") === "settings";
  const [editMode, setEditMode] = useState(false);
  const [draftLayout, setDraftLayout] = useState<DashboardSectionConfig[]>([]);
  const [layout, setLayout] = useState<DashboardSectionConfig[]>(() => buildDefaultLayout([]));
  const [savingLayout, setSavingLayout] = useState(false);
  const [addSectionOpen, setAddSectionOpen] = useState(false);
  const [addAtIndex, setAddAtIndex] = useState<number | null>(null);
  const [sectionQuery, setSectionQuery] = useState("");
  const [editingSectionId, setEditingSectionId] = useState<string | null>(null);
  const editActionsRef = useRef<HTMLDivElement | null>(null);
  const [showEditActionsFloating, setShowEditActionsFloating] = useState(false);
  // Shared inline-playback plumbing (hover Play button → launch). Same
  // implementation backs the Media library + Playlists poster grids.
  const { handlePlayMedia, pendingPlayId, playPending, playSpinnerVisible, playbackMount } =
    useInlinePlayback();

  // UX-WAIT-04: the empty library only once the load says empty; until then the hovering badger above "Loading
  // library...". `deferredMedia === media`: the listed copy has caught up with the provider's list.
  const libraryState = pageLibraryContent({
    loading,
    listed: deferredMedia === media,
    itemCount: playableMedia.length + importingCount,
  });
  const showErrorCard = Boolean(error) && !syncUnavailableWarning && !offlineMode;

  const setMediaParam = useCallback((id: string | null) => {
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
  }, [searchParams, setSearchParams]);

  const clearMediaOverlayParams = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("media");
    next.delete("mediaTab");
    next.delete("player");
    next.delete("episode");
    next.delete("trailer");
    setSearchParams(next, { replace: true });
  };

  const openIngestionFromDashboard = () => {
    if (selectedId) {
      clearMediaOverlayParams();
    }
    openIngestion();
  };
  // UX-EMPTY-01: "Add a folder" opens the native folder picker, then the add-media flow with what was picked; the tour's
  // "or pick files" (UX-TOUR-01) does the same with files. Resolves whether anything was picked.
  const pickIngestion = async (kind: "openFile" | "openDirectory"): Promise<boolean> => {
    if (!window.sf?.openFileDialog) {
      openIngestionFromDashboard();
      return true;
    }
    const paths = await window.sf.openFileDialog({ properties: [kind, "multiSelections"] });
    if (paths.length === 0) return false;
    if (selectedId) clearMediaOverlayParams();
    openIngestion(paths);
    return true;
  };
  // UX-HOME-01: every Badger app's Continue watching pick (started, under 95%, watched last first), playable titles only.
  // OFFL-PLAY-03: offline, the hero only picks a title that is on this computer.
  const continueHeroItem = useMemo(
    () =>
      continueWatchingTitles(
        libraryOnline
          ? playableMedia
          : playableMedia.filter((item) => !titleUnavailableOffline(false, dashboardOfflineState.get(item.id))),
      )[0] ?? null,
    [dashboardOfflineState, libraryOnline, playableMedia],
  );

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

  const layoutSetting = getSharedSetting(DASHBOARD_LAYOUT_KEY);
  const parsedLayout = useMemo(
    () => parseLayout(layoutSetting?.value, deferredPlaylists),
    [layoutSetting?.value, deferredPlaylists]
  );

  useEffect(() => {
    if (!editMode) setLayout(parsedLayout);
  }, [parsedLayout, editMode]);

  useEffect(() => {
    if (!editRequested || editMode) {
      return;
    }
    setDraftLayout(layout);
    setEditMode(true);
    setEditingSectionId(null);
  }, [editMode, editRequested, layout]);

  useEffect(() => {
    if (!editMode) {
      setShowEditActionsFloating(false);
      return;
    }
    const target = editActionsRef.current;
    if (!target) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        setShowEditActionsFloating(!entry.isIntersecting);
      },
      { root: null, threshold: 0.2 }
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [editMode]);

  const clearEditParams = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("edit");
    next.delete("returnTo");
    setSearchParams(next, { replace: true });
  };

  const exitEditMode = () => {
    setEditMode(false);
    setDraftLayout([]);
    setEditingSectionId(null);
    if (returnToSettings) {
      navigate("/settings");
      return;
    }
    clearEditParams();
  };

  const favoritesId = getSystemPlaylistId("favorites");
  const favoritesSet = useMemo(
    () => new Set(favoritesId ? listPlaylistItems(favoritesId) : []),
    [listPlaylistItems, favoritesId]
  );

  const playlistLookup = useMemo(
    () => new Map(deferredPlaylists.map((playlist) => [playlist.id, playlist])),
    [deferredPlaylists]
  );
  const playlistItemsById = useMemo(() => {
    const map = new Map<string, Set<string>>();
    deferredPlaylists.forEach((playlist) => {
      map.set(playlist.id, new Set(listPlaylistItems(playlist.id)));
    });
    return map;
  }, [deferredPlaylists, listPlaylistItems]);

  const mediaVersion = useMemo(() => {
    let latest = "";
    playableMedia.forEach((item) => {
      if (item.updatedAt && item.updatedAt > latest) {
        latest = item.updatedAt;
      }
    });
    return `${playableMedia.length}:${latest}`;
  }, [playableMedia]);

  const sectionItemsById = useMemo(() => {
    const map = new Map<string, { movies: MediaRow[]; tv: MediaRow[] }>();
    parsedLayout.forEach((section) => {
      const buildForLibrary = (library: LibraryScope) => {
        const source = (library === "movies" ? movies : tv).filter((item) => item.hasFiles);
        const seedBase = `${section.id}:${section.type}:${library}:${mediaVersion}:${section.genreId ?? ""}`;
        switch (section.type) {
          case "continue":
            return filterDashboardItems(source.filter((item) => getProgressBand(item.progressPct) === "in-progress"), "").slice(0, MAX_SECTION_ITEMS);
          case "recent":
            return sortDashboardItems(source, "added", "desc").slice(0, MAX_SECTION_ITEMS);
          case "unwatched":
            return pickRandom(
              source.filter((item) => getProgressBand(item.progressPct) === "not-started"),
              MAX_SECTION_ITEMS,
              seedBase
            );
          case "rewatch":
            return pickRandom(
              source.filter((item) => getProgressBand(item.progressPct) === "watched"),
              MAX_SECTION_ITEMS,
              seedBase
            );
          case "favorites":
            return filterDashboardItems(source.filter((item) => favoritesSet.has(item.id)), "").slice(0, MAX_SECTION_ITEMS);
          case "playlist": {
            if (!section.playlistId) return [];
            const set = playlistItemsById.get(section.playlistId) ?? new Set();
            return filterDashboardItems(source.filter((item) => set.has(item.id)), "").slice(0, MAX_SECTION_ITEMS);
          }
          case "genre": {
            if (section.genreId === null || section.genreId === undefined || !section.genreType) return [];
            const genreId = section.genreId;
            if (section.genreType === "tv" && library !== "tv") return [];
            if (section.genreType === "movie" && library !== "movies") return [];
            return pickRandom(
              source.filter((item) => (item.genres ?? []).includes(genreId)),
              MAX_SECTION_ITEMS,
              seedBase
            );
          }
          default:
            return [];
        }
      };
      map.set(section.id, { movies: buildForLibrary("movies"), tv: buildForLibrary("tv") });
    });
    return map;
  }, [parsedLayout, movies, tv, favoritesSet, listPlaylistItems, mediaVersion]);

  const sectionLabel = (section: DashboardSectionConfig): string => {
    if (section.type === "playlist") {
      const playlist = section.playlistId ? playlistLookup.get(section.playlistId) : null;
      return playlist ? playlist.name : t("dashboard.sections.playlist");
    }
    if (section.type === "genre" && section.genreId && section.genreType) {
      return (
        getGenreName(section.genreType, section.genreId, i18n.language) ??
        t("dashboard.sections.genre")
      );
    }
    return t(`dashboard.sections.${section.type}`);
  };

  const sectionIcon = (section: DashboardSectionConfig) => {
    switch (section.type) {
      case "continue":
        return <PlayCircle className="h-4 w-4 text-primary" />;
      case "recent":
        return <Clock className="h-4 w-4 text-primary" />;
      case "unwatched":
        return <EyeOff className="h-4 w-4 text-primary" />;
      case "rewatch":
        return <Repeat className="h-4 w-4 text-primary" />;
      case "favorites":
        return <Heart className="h-4 w-4 text-primary" />;
      case "playlist":
      case "genre":
        if (section.genreId && section.genreType) {
          const Icon = genreIcon(section.genreType, section.genreId);
          return <Icon className="h-4 w-4 text-primary" />;
        }
        return <ListPlus className="h-4 w-4 text-primary" />;
      default:
        return <ListPlus className="h-4 w-4 text-primary" />;
    }
  };

  const handleToggleLibrary = (section: DashboardSectionConfig, library: LibraryScope) => {
    const nextLibraries = section.libraries.includes(library)
      ? section.libraries.filter((entry) => entry !== library)
      : [...section.libraries, library];
    const normalized = ensureLibraries(nextLibraries);
    setDraftLayout((prev) =>
      prev.map((entry) => (entry.id === section.id ? { ...entry, libraries: normalized } : entry))
    );
  };

  const styleOptions = [
    { id: 0, label: t("dashboard.styles.default") },
    { id: 1, label: t("dashboard.styles.ember") },
    { id: 2, label: t("dashboard.styles.mist") },
    { id: 3, label: t("dashboard.styles.forest") },
    { id: 4, label: t("dashboard.styles.bloom") },
    { id: 5, label: t("dashboard.styles.dusk") },
  ];

  const movieGenreOptions = useMemo(() => getGenreOptions("movie", i18n.language), [i18n.language]);
  const tvGenreOptions = useMemo(() => getGenreOptions("tv", i18n.language), [i18n.language]);
  const query = sectionQuery.trim().toLowerCase();
  const matchesQuery = (label: string) => (query ? label.toLowerCase().includes(query) : true);

  const handleRemoveSection = (id: string) => {
    setDraftLayout((prev) => prev.filter((section) => section.id !== id));
  };

  const handleSetStyle = (section: DashboardSectionConfig, styleId: number) => {
    setDraftLayout((prev) =>
      prev.map((entry) => (entry.id === section.id ? { ...entry, styleId } : entry))
    );
  };

  const handleAddSection = (type: SectionType, playlistId?: string | null) => {
    const newSection = createSection(type, playlistId);
    setDraftLayout((prev) => {
      const next = [...prev];
      const insertionIndex = addAtIndex === null ? next.length : Math.max(0, Math.min(addAtIndex, next.length));
      next.splice(insertionIndex, 0, newSection);
      return next;
    });
    setEditingSectionId(newSection.id);
    setAddSectionOpen(false);
    setAddAtIndex(null);
  };

  const handleAddGenreSection = (genreType: "movie" | "tv", genreId: number) => {
    const newSection = createGenreSection(genreType, genreId);
    setDraftLayout((prev) => {
      const next = [...prev];
      const insertionIndex = addAtIndex === null ? next.length : Math.max(0, Math.min(addAtIndex, next.length));
      next.splice(insertionIndex, 0, newSection);
      return next;
    });
    setEditingSectionId(newSection.id);
    setAddSectionOpen(false);
    setAddAtIndex(null);
  };

  const handleSaveLayout = async () => {
    setSavingLayout(true);
    try {
      const payload = JSON.stringify({ updatedAt: new Date().toISOString(), sections: draftLayout });
      await setSharedSetting(DASHBOARD_LAYOUT_KEY, payload);
      setLayout(draftLayout);
      exitEditMode();
    } finally {
      setSavingLayout(false);
    }
  };

  const renderActions = useCallback(
    (item: MediaRow) => {
      const isPendingThis = pendingPlayId === item.id && playPending;
      return (
        <PlayPosterOverlay
          mediaId={item.id}
          pending={isPendingThis}
          spinnerVisible={isPendingThis && playSpinnerVisible}
          onPlay={handlePlayMedia}
        />
      );
    },
    [handlePlayMedia, pendingPlayId, playPending, playSpinnerVisible]
  );

  const sectionsToRender = editMode ? draftLayout : layout;
  const sectionHasContent = (section: DashboardSectionConfig) => {
    if (section.type === "genre") {
      const library = section.genreType === "tv" ? "tv" : "movies";
      const items = sectionItemsById.get(section.id)?.[library] ?? [];
      return {
        movieItems: library === "movies" ? items : [],
        tvItems: library === "tv" ? items : [],
        ghosts: [],
        hasAny: items.length > 0,
      };
    }
    const cached = sectionItemsById.get(section.id);
    const wantsMovies = section.libraries.includes("movies");
    const wantsTv = section.libraries.includes("tv");
    // UX-HOME-03: "Recently added" also lists what is importing, greyed, so a first import shows on the normal Home.
    const recent = section.type === "recent";
    const movieItems = wantsMovies
      ? [...(recent ? importingMedia.filter((item) => item.type !== "tv") : []), ...(cached?.movies ?? [])]
      : [];
    const tvItems = wantsTv
      ? [...(recent ? importingMedia.filter((item) => item.type === "tv") : []), ...(cached?.tv ?? [])]
      : [];
    const ghosts = recent ? importingGhosts.filter((ghost) => (ghost.type === "tv" ? wantsTv : wantsMovies)) : [];
    return { movieItems, tvItems, ghosts, hasAny: movieItems.length > 0 || tvItems.length > 0 || ghosts.length > 0 };
  };

  const renderSectionRows = (section: DashboardSectionConfig) => {
    const { movieItems, tvItems, ghosts, hasAny } = sectionHasContent(section);
    if (!hasAny) {
      return <div className="text-sm text-muted-foreground">{t("dashboard.sectionEmpty")}</div>;
    }
    if (section.type === "genre") {
      const items = section.genreType === "tv" ? tvItems : movieItems;
      return (
        <CarouselRow
          items={items}
          onSelect={setMediaParam}
          renderActions={renderActions}
          activeJobsByMediaId={activeJobsByMediaId}
        />
      );
    }
    const showProgress = section.type === "continue";
    // Every multi-library section renders movies + TV interleaved in a single
    // carousel row (matching "Continue watching"). "unwatched" is seeded-shuffled
    // rather than sorted so the merged row preserves its random-discovery intent
    // (the per-library pickRandom already chose the candidates).
    const merged = [...movieItems, ...tvItems];
    const ordered =
      section.type === "unwatched"
        ? seededShuffle(merged, `${section.id}:${section.type}:merged:${mediaVersion}`)
        : merged.sort((a, b) => {
            if (section.type === "recent") {
              return b.addedAt.localeCompare(a.addedAt);
            }
            if (section.type === "continue") {
              return (b.lastWatchedAt ?? b.updatedAt).localeCompare(a.lastWatchedAt ?? a.updatedAt);
            }
            return b.updatedAt.localeCompare(a.updatedAt);
          });
    return (
      <CarouselRow
        items={ordered.slice(0, Math.max(0, MAX_SECTION_ITEMS - ghosts.length))}
        importing={ghosts}
        onSelect={setMediaParam}
        showProgress={showProgress}
        renderActions={renderActions}
        activeJobsByMediaId={activeJobsByMediaId}
      />
    );
  };

  const openAddSection = (index: number) => {
    setAddAtIndex(index);
    setAddSectionOpen(true);
  };

  return (
    <div className="relative min-h-screen overflow-x-hidden text-foreground" data-testid="dashboard-root">
      <TopNav />
      <main className="relative container max-w-full space-y-8 py-10">
        {editMode ? (
          <div ref={editActionsRef} className="flex flex-wrap items-center justify-end gap-2">
            <Button
              type="button"
              onClick={() => void handleSaveLayout()}
              disabled={savingLayout}
              className="bg-[#ffaa54] text-[#0d1117] hover:bg-[#ff9b30]"
            >
              {savingLayout ? t("dashboard.edit.saving") : t("dashboard.edit.save")}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={exitEditMode}
              disabled={savingLayout}
            >
              {t("dashboard.edit.cancel")}
            </Button>
          </div>
        ) : null}

        {editMode ? (
          showEditActionsFloating ? (
            <div className="pointer-events-none fixed bottom-6 right-6 z-30 flex items-center gap-2">
              <Button
                type="button"
                onClick={() => void handleSaveLayout()}
                disabled={savingLayout}
                className="pointer-events-auto bg-[#ffaa54] text-[#0d1117] shadow-lg hover:bg-[#ff9b30]"
              >
                {savingLayout ? t("dashboard.edit.saving") : t("dashboard.edit.save")}
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={exitEditMode}
                disabled={savingLayout}
                className="pointer-events-auto border border-[#30363d] bg-[#161b22] text-white shadow-lg hover:border-[#ffaa54]/60 hover:bg-[#1a212a]"
              >
                {t("dashboard.edit.cancel")}
              </Button>
            </div>
          ) : null
        ) : null}

        {showErrorCard ? (
          <ShellErrorCard
            title={t("dashboard.errors.title")}
            message={error}
            actions={
              <Button asChild variant="secondary" className="border border-[#30363d] bg-[#0f141b] text-white">
                <Link to="/media-library">{t("dashboard.errors.cta")}</Link>
              </Button>
            }
          />
        ) : null}

        {libraryState === "loading" && !showErrorCard ? <LibraryLoading label={t("library.loading")} /> : null}

        {libraryState === "empty" ? (
          <EmptyLibrary
            mascotSrc={emptyLibraryBg}
            mascotAlt={t("brand.mascotAlt")}
            eyebrow={t("dashboard.empty.eyebrow")}
            title={t("dashboard.empty.title")}
            subtitle={t("dashboard.empty.subtitle")}
            primary={{ label: t("dashboard.empty.addMedia"), onClick: openIngestionFromDashboard, testId: "empty-library-add-media" }}
            secondary={{
              label: t("dashboard.empty.addFolder"),
              onClick: () => void pickIngestion("openDirectory"),
              testId: "empty-library-add-folder",
            }}
            steps={[
              { title: t("dashboard.empty.step1Title"), body: t("dashboard.empty.step1Body") },
              { title: t("dashboard.empty.step2Title"), body: t("dashboard.empty.step2Body") },
              { title: t("dashboard.empty.step3Title"), body: t("dashboard.empty.step3Body") },
            ]}
          />
        ) : null}

        {continueHeroItem && !editMode ? (
          <DashboardContinueHero
            item={continueHeroItem}
            onResume={handlePlayMedia}
            onDetails={(id) => navigate(mediaDetailPath(id, searchParams))}
          />
        ) : null}

        {playableMedia.length === 0 && importingCount === 0 && !editMode ? null : sectionsToRender.length === 0 ? (
          editMode ? (
            <Card
              className="dashboard-section space-panel text-white"
              data-style={0}
            >
              <CardHeader>
                <CardTitle>{t("dashboard.edit.emptyTitle")}</CardTitle>
                <CardDescription className="text-[#8b949e]">{t("dashboard.edit.emptySubtitle")}</CardDescription>
              </CardHeader>
              <CardContent className="flex items-center gap-3">
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  className="h-10 w-10 rounded-full border-dashed border-[#30363d] bg-[#0f141b] text-white hover:border-[#ffaa54]/60"
                  onClick={() => openAddSection(0)}
                >
                  <Plus className="h-5 w-5" />
                </Button>
                <span className="text-sm text-[#8b949e]">{t("dashboard.edit.addSectionHint")}</span>
              </CardContent>
            </Card>
          ) : (
            <Card
              className="dashboard-section space-panel text-white"
              data-style={0}
            >
              <CardHeader>
                <CardTitle>{t("dashboard.edit.emptyTitle")}</CardTitle>
                <CardDescription className="text-[#8b949e]">{t("dashboard.edit.emptySubtitle")}</CardDescription>
              </CardHeader>
              <CardContent>
                <Button type="button" onClick={() => setEditMode(true)} className="bg-[#ffaa54] text-[#0d1117] hover:bg-[#ff9b30]">
                  <Plus className="mr-2 h-4 w-4" />
                  {t("dashboard.edit.addSection")}
                </Button>
              </CardContent>
            </Card>
          )
        ) : editMode ? (
          <Suspense fallback={<div className="h-36" />}>
            <DashboardEditLayout
              sections={sectionsToRender}
              editingSectionId={editingSectionId}
              moviesLabel={t("dashboard.sections.movies")}
              tvLabel={t("dashboard.sections.tv")}
              styleOptions={styleOptions}
              openAddSection={openAddSection}
              onRemoveSection={handleRemoveSection}
              onToggleLibrary={handleToggleLibrary}
              onSetStyle={handleSetStyle}
              onToggleEditingSection={(id) => setEditingSectionId((prev) => (prev === id ? null : id))}
              onReorderSections={(updater) => setDraftLayout(updater)}
              sectionLabel={sectionLabel}
              sectionIcon={sectionIcon}
              renderSectionRows={renderSectionRows}
            />
          </Suspense>
        ) : (
          <div className="space-y-9">
            {sectionsToRender.map((section) => {
              const { hasAny } = sectionHasContent(section);
              if (!hasAny) return null;

              // UX-HOME-01: rows sit on the sky, a heading and its posters with no box around them.
              return (
                <section key={section.id} className="text-white" data-testid={`dashboard-section-${section.type}`}>
                  <BadgerRowHead
                    title={sectionLabel(section)}
                    seeAll={{ label: t("dashboard.hero.seeAll"), onClick: () => navigate("/media-library") }}
                  />
                  {/* UX-CRASH-01: a crashing row blanks only itself. */}
                  <RenderBoundary name={`home-row:${section.type}`}>{renderSectionRows(section)}</RenderBoundary>
                </section>
              );
            })}
          </div>
        )}

        {selectedId ? <Navigate replace to={mediaDetailPath(selectedId, searchParams)} /> : null}
        {playbackMount}
        {addSectionOpen ? (
          <Suspense fallback={null}>
            <DashboardAddSectionDialog
              open={addSectionOpen}
              onOpenChange={(open) => {
                setAddSectionOpen(open);
                if (!open) setAddAtIndex(null);
                if (!open) setSectionQuery("");
              }}
              query={sectionQuery}
              onQueryChange={setSectionQuery}
              matchesQuery={matchesQuery}
              onAddSystemSection={(type) => handleAddSection(type as SectionType)}
              movieGenreOptions={movieGenreOptions}
              tvGenreOptions={tvGenreOptions}
              onAddGenreSection={handleAddGenreSection}
              playlists={deferredPlaylists.filter((playlist) => !playlist.isSystem)}
              onAddPlaylistSection={(playlistId) => handleAddSection("playlist", playlistId)}
            />
          </Suspense>
        ) : null}
      </main>
      {/* UX-TOUR-01/02: step 1 once per computer the first time Home shows after setup, steps 2 and 3 on the first import;
          Settings > About replays it (UX-TOUR-04). */}
      <DesktopTourHost
        app="badger"
        language={i18n.language || "en"}
        ready={!loading}
        suppressed={window.sf?.firstTourOff === true}
        videoSrc={tourDropVideo}
        onPickFiles={() => pickIngestion("openFile")}
      />
    </div>
  );
}
