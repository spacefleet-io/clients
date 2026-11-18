import type { LabJob } from "@/lib/labJobs";
import type { MediaRow } from "@/lib/libraryDb";

export type LibraryActiveJobState = {
  total: number;
  progressSum: number;
  hasBlocking: boolean;
  hasFallbackOnly: boolean;
  hasUploading: boolean;
  uploadSpeedSum: number;
  uploadSpeedCount: number;
};

export const buildActiveJobsByMediaId = (jobs: LabJob[]) => {
  const map = new Map<string, LibraryActiveJobState>();
  jobs.forEach((job) => {
    if (!job.matchedMediaId) return;
    if (job.status === "done" || job.status === "failed" || job.status === "cancelled") return;
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

const normalizeIdentityPart = (value: string | number | null | undefined) => String(value ?? "").trim().toLowerCase();

const buildLibraryGridIdentity = (item: {
  title?: string | null;
  year?: string | number | null;
  type?: "movie" | "tv" | null;
}) => {
  const title = normalizeIdentityPart(item.title);
  const type = item.type ?? null;
  if (!title || !type) return null;
  return `${type}:${title}:${normalizeIdentityPart(item.year)}`;
};

export const mergeLibraryGridItems = <
  GhostItem extends {
    id: string;
    title: string;
    year?: string | null;
    type?: "movie" | "tv";
  },
>(
  ghosts: GhostItem[],
  items: MediaRow[]
) => {
  const merged: Array<MediaRow | (GhostItem & { __ghost: true })> = [];
  const seen = new Set<string>();

  items.forEach((item) => {
    const identity = buildLibraryGridIdentity(item) ?? `media:${item.id}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    merged.push(item);
  });

  ghosts.forEach((item) => {
    const identity = buildLibraryGridIdentity(item) ?? `ghost:${item.id}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    merged.push(item as GhostItem & { __ghost: true });
  });

  return merged;
};
