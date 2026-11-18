// UX-HOME-03: Home has no hero of its own while titles import; the empty library shows only when nothing is
// playable and nothing is importing.
export type DashboardHeroState = "empty" | null;

type DashboardMediaLike = { id: string };
type DashboardFilterableMedia = DashboardMediaLike & {
  title: string;
  addedAt: string;
  year?: string | number | null;
};
type DashboardActiveJobLike = {
  matchedMediaId?: string | null;
  progress: number;
  status: string;
  uploadSpeedMbps?: number | null;
  includeFallback?: boolean;
  includeSource?: boolean;
  includeAudio?: boolean;
  includeSubtitles?: boolean;
  includeChapters?: boolean;
};

export const shouldHoldEmptyCardDuringRefresh = ({
  loading,
  playableCount,
  importingCount,
}: {
  loading: boolean;
  playableCount: number;
  importingCount: number;
}) => {
  if (loading) return false;
  if (playableCount > 0) return false;
  if (importingCount > 0) return false;
  return true;
};

export const getDashboardHeroState = ({
  loading,
  holdEmptyCardDuringRefresh,
  playableCount,
  importingCount,
}: {
  loading: boolean;
  holdEmptyCardDuringRefresh: boolean;
  playableCount: number;
  importingCount: number;
}): DashboardHeroState => {
  if (playableCount > 0) return null;
  if (importingCount > 0) return null;
  if (!loading || holdEmptyCardDuringRefresh) return "empty";
  return null;
};

export const selectDashboardProcessingMedia = <T extends DashboardMediaLike>(
  media: T[],
  activeMediaIds: Set<string>
) => media.filter((item) => activeMediaIds.has(item.id));

/**
 * UX-HOME-03: titles that are importing and cannot be played yet. Home shows them as greyed posters with their
 * import status in the "Recently added" row, next to (or, on a first import, instead of) the playable titles.
 */
export const selectDashboardImportingMedia = <T extends DashboardMediaLike & { hasFiles?: boolean }>(
  media: T[],
  activeMediaIds: Set<string>
) => selectDashboardProcessingMedia(media, activeMediaIds).filter((item) => !item.hasFiles);

/**
 * Compute the dashboard's visible media list.
 *
 * @bugfix dashboard-hides-playable-media-with-active-format-jobs
 * @regression-proof
 *
 * Previously the dashboard hid any media in `activeMediaIds` unless its
 * source job was recorded in `completedSourceMediaIds`. That worked under
 * V1 (where `includeSource` flagged source jobs) but breaks under V2: the
 * V2 → LabJob adapter does not set `includeSource`, so
 * `completedSourceMediaIds` is always empty. Result: any media with a
 * still-active format job (e.g. a 360p transcode lingering after the
 * source committed and `hasFiles=true` flipped) was filtered out of
 * `playableMedia` even though it was watchable.
 *
 * New rule: `hasFiles=true` is the source of truth for "watchable now".
 * Media with `hasFiles=true` always pass through, regardless of active
 * jobs. The dark-overlay + progress-bar treatment that the Library gallery
 * already applies (via `buildDashboardActiveJobsByMediaId`) is then
 * rendered on top of the playable tile so users can see ingest progress
 * for higher-quality variants. Media without `hasFiles` retain the legacy
 * fallback (visible only if their source job is recorded as completed).
 */
export const selectDashboardVisibleMedia = <T extends DashboardMediaLike & { hasFiles?: boolean }>(
  media: T[],
  activeMediaIds: Set<string>,
  completedSourceMediaIds: Set<string>
) =>
  media.filter((item) => {
    if (item.hasFiles) return true;
    if (!activeMediaIds.has(item.id)) return true;
    return completedSourceMediaIds.has(item.id);
  });

/** One title's import state on Home: its active jobs rolled up into one overlay (UX-HOME-03). */
export type DashboardActiveJobState = {
  total: number;
  progressSum: number;
  hasBlocking: boolean;
  hasFallbackOnly: boolean;
  hasUploading: boolean;
  uploadSpeedSum: number;
  uploadSpeedCount: number;
};

export const buildDashboardActiveJobsByMediaId = (jobs: DashboardActiveJobLike[]) => {
  const map = new Map<string, DashboardActiveJobState>();
  jobs.forEach((job) => {
    if (!job.matchedMediaId) return;
    const isFallbackOnly =
      Boolean(job.includeFallback) &&
      !job.includeSource &&
      !job.includeAudio &&
      !job.includeSubtitles &&
      !job.includeChapters;
    const current = map.get(job.matchedMediaId) ?? {
      total: 0,
      progressSum: 0,
      hasBlocking: false,
      hasFallbackOnly: false,
      hasUploading: false,
      uploadSpeedSum: 0,
      uploadSpeedCount: 0,
    };
    current.total += 1;
    current.progressSum += Number.isFinite(job.progress) ? job.progress : 0;
    current.hasBlocking = current.hasBlocking || !isFallbackOnly;
    current.hasFallbackOnly = current.hasFallbackOnly || isFallbackOnly;
    current.hasUploading = current.hasUploading || job.status === "uploading";
    if (job.status === "uploading" && Number.isFinite(job.uploadSpeedMbps) && Number(job.uploadSpeedMbps) > 0) {
      current.uploadSpeedSum += Number(job.uploadSpeedMbps);
      current.uploadSpeedCount += 1;
    }
    map.set(job.matchedMediaId, current);
  });
  return map;
};

/**
 * @bugfix #2461 @regression-proof
 *
 * `prev` when `next` holds the same ids, else `next`. Every runtime job progress event builds a new jobs list, so
 * the id Sets derived from it were new objects on every tick even when no title started or finished importing. Every
 * memo keyed on them (visible media, the movie / TV split, every section's rows) then recomputed, and every poster
 * card on Home re-rendered several times a second during an ingest (frame p95 50 ms against the 33 ms budget of
 * `perf-during-ingest.e2e.test.ts`). Keeping the old Set when its members did not change stops that cascade.
 */
export const reuseSameIdSet = (prev: Set<string> | null | undefined, next: Set<string>): Set<string> => {
  if (!prev || prev.size !== next.size) return next;
  for (const id of next) {
    if (!prev.has(id)) return next;
  }
  return prev;
};

/**
 * @bugfix #2461 @regression-proof
 *
 * `next` with each title's entry replaced by its `prev` entry when that title's import state did not change, and
 * `prev` itself when no entry changed. A progress tick of one title then gives a new object only for that title, so
 * the memoised poster cards of every other title skip their re-render.
 */
export const reuseUnchangedActiveJobStates = (
  prev: Map<string, DashboardActiveJobState> | null | undefined,
  next: Map<string, DashboardActiveJobState>
): Map<string, DashboardActiveJobState> => {
  if (!prev) return next;
  let changed = prev.size !== next.size;
  const merged = new Map<string, DashboardActiveJobState>();
  for (const [mediaId, state] of next) {
    const before = prev.get(mediaId);
    const same =
      before !== undefined &&
      (Object.keys(state) as (keyof DashboardActiveJobState)[]).every((key) => before[key] === state[key]);
    if (same) {
      merged.set(mediaId, before);
    } else {
      merged.set(mediaId, state);
      changed = true;
    }
  }
  return changed ? merged : prev;
};

export const filterDashboardItems = <T extends DashboardFilterableMedia>(items: T[], query: string) => {
  if (!query) return items;
  return items.filter((item) => item.title.toLowerCase().includes(query));
};

export const sortDashboardItems = <T extends DashboardFilterableMedia>(
  items: T[],
  sortBy: "name" | "added" | "release",
  sortDirection: "asc" | "desc"
) => {
  const direction = sortDirection === "asc" ? 1 : -1;
  const sorted = [...items];
  sorted.sort((a, b) => {
    if (sortBy === "name") {
      return a.title.localeCompare(b.title) * direction;
    }
    if (sortBy === "release") {
      const yearA = Number(a.year ?? 0);
      const yearB = Number(b.year ?? 0);
      return (yearA - yearB) * direction;
    }
    return a.addedAt.localeCompare(b.addedAt) * direction;
  });
  return sorted;
};
