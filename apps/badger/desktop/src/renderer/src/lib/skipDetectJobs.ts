/**
 * MPV-PREV-07 (Chris 2026-11-24, via Main): the skip-detection catch-up as a job type in the Jobs queue. Each video
 * the catch-up counts is one "Finding intro and credits" job, grouped per title like an import (one card per show or
 * film, one episode heading per episode). The jobs are not runtime ingest records: they are read from the catch-up
 * status (`badger.previews.get_catch_up`) and mapped here.
 */
import type { TFunction } from "i18next";
import type { MediaRow } from "@space/shared/libraryTypes";
import type { LabJobGroup } from "@/components/labQueueGroups";
import type { LabJob } from "@/lib/labJobs";
import { episodeCode, isSkipCatchUpShown, type SkipCatchUpStatus, type SkipCatchUpVideo } from "@/lib/skipCatchUp";

export const SKIP_DETECT_JOB_PREFIX = "skip-detect:";

/** The catch-up video a skip job stands for, or null for any other job id. */
export const skipDetectFormatId = (jobId: string): string | null =>
  jobId.startsWith(SKIP_DETECT_JOB_PREFIX) ? jobId.slice(SKIP_DETECT_JOB_PREFIX.length) : null;

export const isSkipDetectJob = (job: Pick<LabJob, "jobType">): boolean => job.jobType === "skip-detect";

export type SkipDetectGroups = {
  groups: LabJobGroup[];
  /** Each skip job's catch-up video, for its failed/cancelled lines and its done result. */
  videos: Map<string, SkipCatchUpVideo>;
};

const MB = 1_000_000;

/** The running video's step, as its row and badge read it. */
const runningStage = (status: SkipCatchUpStatus, t: TFunction): string => {
  const current = status.current;
  switch (current?.phase) {
    case "download":
      return t("nav.jobs.skipCatchUp.list.step.download", {
        done: Math.round(current.downloadedBytes / MB),
        total: Math.round(current.totalBytes / MB),
      });
    case "pictures":
      return t("nav.jobs.skipCatchUp.list.step.pictures");
    case "sound":
      return t("nav.jobs.skipCatchUp.list.step.sound");
    default:
      return t("nav.jobs.skipCatchUp.list.step.waiting");
  }
};

/** The title card's badge: the step in one word, so the title keeps its room. */
const runningStageShort = (status: SkipCatchUpStatus, t: TFunction): string =>
  t(`nav.jobs.skipCatchUp.list.stepShort.${status.current?.phase ?? "waiting"}`);

const STATUS: Record<SkipCatchUpVideo["status"], LabJob["status"]> = {
  running: "transcoding",
  queued: "waiting",
  retry_waiting: "waiting",
  failed: "failed",
  cancelled: "cancelled",
  done: "done",
};

/**
 * Running first, then the failed ones, the queue, the done ones, and the cancelled ones last: cancelling a title moves
 * it to the bottom and leaves the rest of the stack where it was (Chris 2026-11-24).
 */
const groupRank = (status: LabJob["status"]): number =>
  status === "transcoding" ? 0 : status === "failed" ? 1 : status === "waiting" ? 2 : status === "cancelled" ? 4 : 3;

/** "Trying again at 15:06" for a video waiting out its hour after a failed try (MPV-PREV-07). */
export const retryWaitLabel = (retryAt: string | null, t: TFunction, locale: string): string =>
  t("nav.jobs.skipCatchUp.list.retryAt", { time: formatRetryTime(retryAt, locale) });

/** The hour and minute a held video runs again, in the user's language ("15:06"). */
export const formatRetryTime = (retryAt: string | null, locale: string): string =>
  retryAt ? new Date(retryAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }) : "";

/**
 * One group per title, in the catch-up's order. Empty while the catch-up is hidden (nothing to do, or done for more
 * than a day). A video waiting out its hour is a waiting job that says when it runs again, with no place in line.
 */
export const buildSkipDetectGroups = (
  status: SkipCatchUpStatus | null,
  media: MediaRow[] | undefined,
  t: TFunction,
  nowMs: number,
  locale: string,
): SkipDetectGroups => {
  const videos = new Map<string, SkipCatchUpVideo>();
  if (!status || !isSkipCatchUpShown(status, nowMs)) return { groups: [], videos };
  const mediaById = new Map((media ?? []).map((row) => [row.id, row]));
  const byMedia = new Map<string, LabJob[]>();
  let queuePosition = 0;
  /** Jobs of videos waiting out their hour: they wait, but hold no place in line. */
  const held = new Set<string>();
  // Imports always go first (MPV-PREV-07): while one runs, the waiting videos say so rather than their place in line.
  const waitingImport = status.state === "paused_import" ? t("nav.jobs.skipCatchUp.list.waitingImport") : undefined;
  for (const video of status.videos) {
    const row = mediaById.get(video.mediaId);
    const jobStatus = STATUS[video.status];
    const running = video.status === "running";
    const id = `${SKIP_DETECT_JOB_PREFIX}${video.formatId}`;
    const job: LabJob = {
      id,
      jobType: "skip-detect",
      groupId: `${SKIP_DETECT_JOB_PREFIX}${video.mediaId}`,
      // The episode heading reads "S01E04"; a film's one job keeps its title.
      filename: episodeCode(video.season, video.episode) || row?.title || video.mediaId,
      detectedSeason: video.season ?? undefined,
      detectedEpisode: video.episode ?? undefined,
      status: jobStatus,
      progress: running ? Math.round((status.current?.progress ?? 0) * 100) : video.status === "done" ? 100 : 0,
      stageLabel: running
        ? runningStage(status, t)
        : video.status === "retry_waiting"
          ? retryWaitLabel(video.retryAt, t, locale)
          : video.status === "queued"
            ? waitingImport
            : undefined,
      queuePosition: video.status === "queued" && !waitingImport ? (queuePosition += 1) : undefined,
      createdAt: "",
      completedAt: undefined,
    };
    videos.set(id, video);
    if (video.status === "retry_waiting") held.add(id);
    const jobs = byMedia.get(video.mediaId) ?? [];
    jobs.push(job);
    byMedia.set(video.mediaId, jobs);
  }
  const groups = [...byMedia.entries()].map(([mediaId, jobs]): LabJobGroup => {
    const row = mediaById.get(mediaId);
    const runningJob = jobs.find((j) => j.status === "transcoding");
    const waiting = jobs.filter((j) => j.status === "waiting");
    // A title whose waiting episodes all wait out their hour reads the first one's "Trying again at …", not a place.
    const inLine = waiting.filter((j) => !held.has(j.id));
    const groupStatus: LabJob["status"] = runningJob
      ? "transcoding"
      : jobs.some((j) => j.status === "failed")
        ? "failed"
        : waiting.length > 0
          ? "waiting"
          : jobs.some((j) => j.status === "cancelled")
            ? "cancelled"
            : "done";
    return {
      id: `${SKIP_DETECT_JOB_PREFIX}${mediaId}`,
      title: row?.title ?? mediaId,
      posterPath: row?.posterPath ?? null,
      type: row?.type,
      jobs,
      progress: Math.round(jobs.reduce((sum, j) => sum + j.progress, 0) / jobs.length),
      status: groupStatus,
      stageLabel: runningJob
        ? runningStageShort(status, t)
        : groupStatus !== "waiting"
          ? undefined
          : inLine.length > 0
            ? waitingImport
            : [...waiting].sort((a, b) => (videos.get(a.id)!.retryAt ?? "").localeCompare(videos.get(b.id)!.retryAt ?? ""))[0]!.stageLabel,
      queuePosition: groupStatus === "waiting" && !waitingImport && inLine.length > 0 ? Math.min(...inLine.map((j) => j.queuePosition!)) : undefined,
      uploadSpeedMbps: 0,
    };
  });
  // Stable sort: titles of the same rank keep the catch-up's order.
  groups.sort((a, b) => groupRank(a.status) - groupRank(b.status));
  return { groups, videos };
};
