import type { MediaRow } from "@/lib/libraryDb";

const mediaIdentityKey = (item: MediaRow) => {
  if (Number.isFinite(Number(item.catalogId))) {
    return `${item.type}:catalog:${Number(item.catalogId)}`;
  }
  const normalize = (value: string | null | undefined) => (value ?? "").trim().toLowerCase();
  return `${item.type}:local:${normalize(item.title)}:${normalize(item.originalTitle)}:${item.year ?? ""}`;
};

const pickPreferredMedia = (current: MediaRow, next: MediaRow) => {
  if (next.hasFiles && !current.hasFiles) return next;
  if (!next.hasFiles && current.hasFiles) return current;
  const currentHasCatalog = Number.isFinite(Number(current.catalogId));
  const nextHasCatalog = Number.isFinite(Number(next.catalogId));
  if (nextHasCatalog && !currentHasCatalog) return next;
  if (!nextHasCatalog && currentHasCatalog) return current;
  return next.updatedAt > current.updatedAt ? next : current;
};

type MediaAggregate = {
  preferred: MediaRow;
  hasFiles: boolean;
  progressSum: number;
  progressCount: number;
  addedAt: string;
  updatedAt: string;
  lastWatchedAt: string | null;
  totalEpisodes: number | null;
  episodeCount: number;
};

const createAggregate = (item: MediaRow): MediaAggregate => {
  const progressPct = Number.isFinite(Number(item.progressPct)) ? Number(item.progressPct) : 0;
  const totalEpisodes = Number.isFinite(Number(item.totalEpisodes)) ? Number(item.totalEpisodes) : null;
  const episodeCount = Number.isFinite(Number(item.episodeCount)) ? Number(item.episodeCount) : 0;
  return {
    preferred: item,
    hasFiles: Boolean(item.hasFiles),
    progressSum: progressPct,
    progressCount: progressPct >= 0 ? 1 : 0,
    addedAt: item.addedAt,
    updatedAt: item.updatedAt,
    lastWatchedAt: item.lastWatchedAt ?? null,
    totalEpisodes,
    episodeCount,
  };
};

const mergeAggregate = (aggregate: MediaAggregate, item: MediaRow) => {
  aggregate.preferred = pickPreferredMedia(aggregate.preferred, item);
  aggregate.hasFiles = aggregate.hasFiles || Boolean(item.hasFiles);
  const progressPct = Number.isFinite(Number(item.progressPct)) ? Number(item.progressPct) : Number.NaN;
  if (Number.isFinite(progressPct) && progressPct >= 0) {
    aggregate.progressSum += progressPct;
    aggregate.progressCount += 1;
  }
  if (item.addedAt < aggregate.addedAt) aggregate.addedAt = item.addedAt;
  if (item.updatedAt > aggregate.updatedAt) aggregate.updatedAt = item.updatedAt;
  if (item.lastWatchedAt && (!aggregate.lastWatchedAt || item.lastWatchedAt > aggregate.lastWatchedAt)) {
    aggregate.lastWatchedAt = item.lastWatchedAt;
  }
  const totalEpisodes = Number.isFinite(Number(item.totalEpisodes)) ? Number(item.totalEpisodes) : null;
  if (totalEpisodes !== null) {
    aggregate.totalEpisodes = aggregate.totalEpisodes === null ? totalEpisodes : Math.max(aggregate.totalEpisodes, totalEpisodes);
  }
  const episodeCount = Number.isFinite(Number(item.episodeCount)) ? Number(item.episodeCount) : 0;
  if (episodeCount > aggregate.episodeCount) aggregate.episodeCount = episodeCount;
};

export const dedupeMediaByIdentity = (items: MediaRow[]) => {
  const aggregates = new Map<string, MediaAggregate>();
  items.forEach((item) => {
    const key = mediaIdentityKey(item);
    const existing = aggregates.get(key);
    if (!existing) {
      aggregates.set(key, createAggregate(item));
      return;
    }
    mergeAggregate(existing, item);
  });

  return Array.from(aggregates.values())
    .map((aggregate) => {
      const { preferred } = aggregate;
      const mergedProgress =
        preferred.type === "tv" && aggregate.progressCount > 0
          ? aggregate.progressSum / aggregate.progressCount
          : preferred.progressPct;
      return {
        ...preferred,
        hasFiles: aggregate.hasFiles,
        progressPct: Math.max(0, Math.min(100, mergedProgress)),
        addedAt: aggregate.addedAt,
        updatedAt: aggregate.updatedAt,
        lastWatchedAt: aggregate.lastWatchedAt,
        totalEpisodes: aggregate.totalEpisodes,
        episodeCount: aggregate.episodeCount,
      };
    })
    .sort((a, b) => b.addedAt.localeCompare(a.addedAt));
};
