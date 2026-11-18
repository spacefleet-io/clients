import type { TFunction } from "i18next";
import type { LabJob } from "@/lib/labJobs";

export type EpisodeBucket = {
  id: string;
  title: string;
  jobs: LabJob[];
};

export type LabJobGroup = {
  id: string;
  title: string;
  posterPath?: string | null;
  type?: "movie" | "tv";
  jobs: LabJob[];
  progress: number;
  status: LabJob["status"];
  stageLabel?: string;
  /** Earliest place in line among the group's waiting jobs (#2499). */
  queuePosition?: number;
  uploadSpeedMbps: number;
};

export const buildEpisodeBuckets = (
  jobs: LabJob[],
  params: {
    t: TFunction;
    resolveEpisodeName: (season: number, episode: number) => string | null;
  }
): EpisodeBucket[] => {
  const { t, resolveEpisodeName } = params;
  const groups = new Map<string, EpisodeBucket>();
  jobs.forEach((job) => {
    const season = job.detectedSeason ?? job.manualSeason;
    const episode = job.detectedEpisode ?? job.manualEpisode;
    const hasEpisode = typeof season === "number" && typeof episode === "number";
    const key = hasEpisode ? `s${season}e${episode}` : `other-${job.id}`;
    const existing = groups.get(key);
    const code = hasEpisode
      ? `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`
      : t("lab.queue.episode");
    const episodeTitle = hasEpisode ? resolveEpisodeName(season, episode) : null;
    const title = episodeTitle ? `${code} · ${episodeTitle}` : code;
    if (existing) {
      existing.jobs.push(job);
      return;
    }
    groups.set(key, { id: key, title, jobs: [job] });
  });
  return Array.from(groups.values()).sort((a, b) => a.title.localeCompare(b.title));
};

export type FileBucket = {
  id: string;
  title: string;
  jobs: LabJob[];
};

// Strip directory and extension from a source filename so it can stand in as
// an episode-bucket title when no season/episode metadata is available.
// Filenames look like `Brooklyn Nine-Nine - S01E01 - Pilot [1080p].mkv`.
const cleanBasename = (filename: string): string => {
  const base = filename.split(/[/\\]/).pop() ?? filename;
  return base.replace(/\.[^.]+$/, "");
};

// Group a show's jobs into per-episode buckets keyed by `job.filename`.
//
// Why filename, not season/episode: only the `jobType === "source"` job
// carries detected/manual season+episode — the format/transcode jobs do not.
// But every job (source + transcode) for one episode shares the same
// `filename`, so keying on filename keeps an episode's source + transcode
// jobs together. (`buildEpisodeBuckets` keys on season/episode and would
// scatter the transcode jobs into separate "other-<id>" buckets.)
//
// Bucket title: prefer the source job's zero-padded `S01E01` code; fall back
// to a cleaned basename of the filename when no episode metadata is present.
export const buildFileBuckets = (jobs: LabJob[]): FileBucket[] => {
  const buckets = new Map<string, FileBucket>();
  jobs.forEach((job) => {
    const key = job.filename;
    const existing = buckets.get(key);
    if (existing) {
      existing.jobs.push(job);
      return;
    }
    buckets.set(key, { id: key, title: cleanBasename(key), jobs: [job] });
  });
  // Title pass: a bucket's title comes from its source job's season/episode
  // when available. Done after grouping so the source job is found regardless
  // of job order within the bucket.
  for (const bucket of buckets.values()) {
    const sourceJob = bucket.jobs.find((j) => j.jobType === "source");
    if (!sourceJob) continue;
    const season = sourceJob.detectedSeason ?? sourceJob.manualSeason;
    const episode = sourceJob.detectedEpisode ?? sourceJob.manualEpisode;
    if (typeof season === "number" && typeof episode === "number") {
      bucket.title = `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
    }
  }
  return Array.from(buckets.values()).sort((a, b) => a.title.localeCompare(b.title));
};

// Mirrors pickMostActiveJob in runtimeIngestJobs.ts. Inlined here to keep the
// V1 group builder self-contained (the V2 builder imports LabJobGroup from
// this module, so importing the picker the other way would invert the graph).
const pickMostActiveLabJob = (jobs: LabJob[]): LabJob | null => {
  if (jobs.length === 0) return null;
  const active = jobs.find(
    (j) => j.status === "transcoding" || j.status === "uploading"
  );
  if (active) return active;
  const nonTerminal = jobs.find(
    (j) => j.status !== "done" && j.status !== "cancelled" && j.status !== "failed"
  );
  if (nonTerminal) return nonTerminal;
  return jobs[0] ?? null;
};

export const buildLabJobGroups = (jobs: LabJob[]): LabJobGroup[] => {
  const groups = new Map<string, LabJobGroup>();
  jobs.forEach((job) => {
    const key = job.matchedMediaId ?? job.pendingKey ?? job.groupId ?? job.id;
    const existing = groups.get(key);
    const display = job.matchedTo ?? existing?.jobs.find((item) => item.matchedTo)?.matchedTo;
    const title = display?.title ?? job.detectedTitle ?? job.filename;
    const posterPath = display?.posterPath ?? existing?.posterPath ?? null;
    const type = display?.type ?? existing?.type;
    const nextJobs = existing ? [...existing.jobs, job] : [job];
    const hasUploading = nextJobs.some((item) => item.status === "uploading");
    const hasTranscoding = nextJobs.some((item) => item.status === "transcoding");
    const hasFailed = nextJobs.some((item) => item.status === "failed");
    const status = hasUploading
      ? "uploading"
      : hasTranscoding
      ? "transcoding"
      : hasFailed
      ? "failed"
      : nextJobs.some((item) => item.status === "needs_match")
      ? "needs_match"
      : nextJobs[0]?.status ?? "waiting";
    const stageLabel = pickMostActiveLabJob(nextJobs)?.stageLabel;
    const progress =
      nextJobs.length === 0
        ? 0
        : Math.round(
            nextJobs.reduce((sum, item) => sum + (Number.isFinite(item.progress) ? item.progress : 0), 0) /
              nextJobs.length
          );
    const uploadSpeeds = nextJobs
      .filter((item) => item.status === "uploading")
      .map((item) => (Number.isFinite(item.uploadSpeedMbps) ? Number(item.uploadSpeedMbps) : 0))
      .filter((value) => value > 0);
    const uploadSpeedMbps =
      uploadSpeeds.length > 0 ? uploadSpeeds.reduce((sum, value) => sum + value, 0) / uploadSpeeds.length : 0;
    groups.set(key, { id: key, title, posterPath, type, jobs: nextJobs, progress, status, stageLabel, uploadSpeedMbps });
  });
  return Array.from(groups.values());
};
