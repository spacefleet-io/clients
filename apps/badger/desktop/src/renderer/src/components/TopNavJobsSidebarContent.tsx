/**
 * Top-nav jobs sidebar content. Native runtime-engine V2 — pulls jobs
 * directly from `useRuntimeIngestJobs()` and routes trash actions to
 * `cancelJob` (active) / `dismissJob` (terminal).
 *
 * Plan reference: video-ingestion-is-buggy-effervescent-teapot.md Round 3.
 */
import { useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  DesktopCompletedJobRow,
  DesktopFailedJobDetail,
  DesktopJobActionButton,
  DesktopJobBucketHeader,
  DesktopJobGroupCard,
  DesktopJobProgress,
  DesktopJobRow,
  DesktopJobsEmpty,
  DesktopJobsFilterBar,
  DesktopJobsLoadingSkeleton,
  useStaggeredDismiss,
  type DesktopJobFilter,
} from "@space/desktop-shell/components";
import { useClientConfig } from "@/lib/useClientConfig";
import {
  findStaleOrphanGroupIds,
  pickMostActiveJob,
  useRuntimeIngestActions,
  useRuntimeIngestJobs,
} from "@/lib/runtimeIngestJobs";
import { useOptionalLibraryData } from "@/lib/libraryContext";
import { buildFileBuckets, type LabJobGroup } from "@/components/labQueueGroups";
import type { LabJob } from "@/lib/labJobs";
import {
  buildActiveLabJobPresentation,
  buildCompletedLabJobPresentation,
} from "@/components/labJobPresentation";
import { LabStatusBadge } from "@/components/LabStatusBadge";
import IngestUnavailableBanner from "@/components/IngestUnavailableBanner";
import UnpaidUploadsNotice, { isSubscriptionUnpaidJobError } from "@/components/UnpaidUploadsNotice";
import QuotaUploadsNotice, { isUploadQuotaExceededJobError } from "@/components/QuotaUploadsNotice";
import MediaImage from "@/components/MediaImage";
import type { JobStatus } from "../../../shared/labQueueShared";
import { offlineDiskSpaceJobMessage } from "@/lib/offlineDiskSpaceLabel";
import { formatLocalizedStorage } from "@space/shared/format";
import { useFailedJobActions } from "@/lib/failedJobActions";
import FailedImportDetail from "@/components/FailedImportDetail";
import { retrySkipCatchUp, setSkipCatchUpVideo, useSkipCatchUpStatus } from "@/lib/skipCatchUp";
import { buildSkipDetectGroups, formatRetryTime, isSkipDetectJob, skipDetectFormatId } from "@/lib/skipDetectJobs";

type JobFilter = DesktopJobFilter;

const classifyJob = (status: JobStatus, skipDetect = false): Exclude<JobFilter, "all"> => {
  // A cancelled skip job waits for "Try again" (MPV-PREV-07), so it is listed with the failed ones.
  if (skipDetect && status === "cancelled") return "failed";
  if (status === "transcoding" || status === "uploading") return "active";
  if (status === "done" || status === "cancelled") return "completed";
  if (status === "failed") return "failed";
  return "queued";
};

const isActiveJobStatus = (status: JobStatus) =>
  status === "waiting" ||
  status === "identifying" ||
  status === "ready" ||
  status === "transcoding" ||
  status === "uploading" ||
  status === "needs_match";

const GROUP_LIMIT = 30;

// "Upgrade plan" on a failed upload (UX-JOBS-03) leads to the one upgrade offer, QuotaUploadsNotice at the top.
const showQuotaUpgradeOffer = () => {
  const notice = document.querySelector<HTMLElement>('[data-testid="quota-uploads-notice"]');
  notice?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  document.querySelector<HTMLButtonElement>('[data-testid="quota-uploads-notice-upgrade"]')?.focus();
};

export default function TopNavJobsSidebarContent() {
  const { t, i18n } = useTranslation();
  const libraryData = useOptionalLibraryData();
  const media = libraryData?.media;
  const { jobs: allJobs, groups: allGroups, loading, runtimeError } = useRuntimeIngestJobs({ media });
  const { cancelJob, cancelByGroup, dismissJob } = useRuntimeIngestActions();
  const clientConfig = useClientConfig();
  // Single dismiss scheduler for both group-level (bulk cancel/dismiss) and
  // individual job-row actions. group.id and job.id share the same string
  // namespace from the runtime, so a single set is enough.
  const { dismissing, scheduleDismiss } = useStaggeredDismiss();
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  // Nested per-episode collapse state, keyed `${group.id}::${bucketId}`.
  // Kept separate from `expandedGroups` so an explicit episode toggle never
  // collides with a same-named group key. Absent keys fall back to the
  // active/failed-aware default in `bucketDefaultExpanded`.
  const [expandedBuckets, setExpandedBuckets] = useState<Record<string, boolean>>({});
  // A card or an episode opens or folds as it first appears; a later status change (running to done, a failure) leaves
  // it as it is, and only a click or a cancel changes it (Chris 2026-11-24). Keyed `group:<id>` / `bucket:<key>`.
  const firstLook = useRef(new Map<string, boolean>());
  const settledDefault = (key: string, open: boolean): boolean => {
    const first = firstLook.current.get(key);
    if (first !== undefined) return first;
    firstLook.current.set(key, open);
    return open;
  };
  /**
   * A cancelled job's card folds, open or not before (Chris 2026-11-24): its episode, and its title card once nothing
   * in it runs or waits any more.
   */
  const foldCancelled = (jobId: string) => {
    const group = groups.find((g) => g.jobs.some((j) => j.id === jobId));
    if (!group) return;
    const job = group.jobs.find((j) => j.id === jobId)!;
    const bucket = group.type === "tv" ? buildFileBuckets(group.jobs).find((b) => b.jobs.includes(job)) : undefined;
    if (bucket) setExpandedBuckets((prev) => ({ ...prev, [`${group.id}::${bucket.id}`]: false }));
    const stillOpen = group.jobs.some((j) => j.id !== jobId && isActiveJobStatus(j.status));
    if (!stillOpen) setExpandedGroups((prev) => ({ ...prev, [group.id]: false }));
  };
  const foldCancelledGroup = (groupId: string) => setExpandedGroups((prev) => ({ ...prev, [groupId]: false }));
  const groupExpanded = (id: string, jobs: LabJob[]) => expandedGroups[id] ?? settledDefault(`group:${id}`, groupDefaultExpanded(jobs));
  const bucketExpanded = (bucketKey: string, jobs: LabJob[]) =>
    expandedBuckets[bucketKey] ?? settledDefault(`bucket:${bucketKey}`, bucketDefaultExpanded(jobs));
  const [filter, setFilter] = useState<JobFilter>("all");
  const [planHasRoom, setPlanHasRoom] = useState(false);
  const failedJobIds = useMemo(
    () => allJobs.filter((job) => job.status === "failed").map((job) => job.jobId),
    [allJobs],
  );
  const failedActions = useFailedJobActions(failedJobIds);
  // MPV-PREV-07: the skip-detection catch-up's videos, one "Finding intro and credits" job each, grouped per title.
  const skipStatus = useSkipCatchUpStatus();
  const skip = useMemo(
    () => buildSkipDetectGroups(skipStatus, media, t, Date.now(), i18n.language),
    [skipStatus, media, t, i18n.language],
  );
  const [skipRetrying, setSkipRetrying] = useState<string | null>(null);
  /** "Try again" on a failed or cancelled skip job, "Try again now" on one waiting out its hour (MPV-PREV-07). */
  const skipRetryAction = (job: LabJob, formatId: string, label: string) => ({
    label,
    busy: skipRetrying === job.id,
    testId: `failed-job-action-${job.id}`,
    onClick: () => {
      setSkipRetrying(job.id);
      void retrySkipCatchUp(formatId).finally(() => setSkipRetrying(null));
    },
  });
  const renderSkipDetail = (job: LabJob): ReactNode => {
    const video = skip.videos.get(job.id);
    if (!video) return null;
    if (video.status === "retry_waiting") {
      return (
        <DesktopFailedJobDetail
          testId={`failed-job-detail-${job.id}`}
          what={t(`nav.jobs.skipCatchUp.list.failedStep.${video.failedStep ?? "read"}`)}
          meaning={t("nav.jobs.skipDetect.meaningRetryWait", { time: formatRetryTime(video.retryAt, i18n.language) })}
          action={skipRetryAction(job, video.formatId, t("nav.jobs.skipCatchUp.list.tryAgainNow"))}
        />
      );
    }
    if (job.status !== "failed" && job.status !== "cancelled") return null;
    const what =
      job.status === "cancelled"
        ? t("nav.jobs.skipDetect.whatCancelled")
        : t(`nav.jobs.skipCatchUp.list.failedStep.${video.failedStep ?? "read"}`);
    return (
      <DesktopFailedJobDetail
        testId={`failed-job-detail-${job.id}`}
        what={what}
        meaning={t(
          job.status === "cancelled"
            ? "nav.jobs.skipDetect.meaningCancelled"
            : video.season === null && video.episode === null
              ? "nav.jobs.skipDetect.meaningFailedFilm"
              : "nav.jobs.skipDetect.meaningFailed"
        )}
        action={skipRetryAction(job, video.formatId, t("nav.jobs.skipCatchUp.list.tryAgain"))}
      />
    );
  };
  const describeSkipResult = (job: LabJob): string | undefined => {
    const result = skip.videos.get(job.id)?.result;
    return result ? t(`nav.jobs.skipCatchUp.list.result.${result}`) : undefined;
  };
  const renderFailedDetail = (job: LabJob): ReactNode => {
    if (isSkipDetectJob(job)) return renderSkipDetail(job);
    const availability = failedActions.byJobId.get(job.id);
    if (job.status !== "failed" || !availability) return null;
    return (
      <FailedImportDetail
        availability={availability}
        planHasRoom={planHasRoom}
        busy={failedActions.busyJobId === job.id}
        onRun={(jobId) => void failedActions.run(jobId)}
        onUpgradePlan={showQuotaUpgradeOffer}
      />
    );
  };

  const filterGroups = (list: LabJobGroup[]) =>
    filter === "all"
      ? list
      : list
          .map((g) => ({ ...g, jobs: g.jobs.filter((j) => classifyJob(j.status, isSkipDetectJob(j)) === filter) }))
          .filter((g) => g.jobs.length > 0);
  const filteredGroups = useMemo(() => filterGroups(allGroups), [allGroups, filter]);
  const filteredSkipGroups = useMemo(() => filterGroups(skip.groups), [skip.groups, filter]);

  // `filteredGroups` arrives already sorted most-recent-first by
  // buildIngestJobGroups; we just slice for display. The skip-detection titles follow the imports, in their own
  // order (running, failed, the queue, the done ones, the cancelled ones last).
  const groups = useMemo(
    () => [...filteredGroups.slice(0, GROUP_LIMIT), ...filteredSkipGroups.slice(0, GROUP_LIMIT)],
    [filteredGroups, filteredSkipGroups],
  );
  const skipPausedKey =
    skip.groups.length > 0 && skipStatus && skipStatus.state !== "running" && skipStatus.state !== "done"
      ? skipStatus.state
      : null;

  // A skip job's buttons (MPV-PREV-07) go to the catch-up, not the ingest store. A cancelled one stays, with "Try
  // again", so nothing animates out on Cancel.
  const skipHandlers = {
    onCancel: (id: string) => {
      foldCancelled(id);
      void setSkipCatchUpVideo(skipDetectFormatId(id)!, "cancel");
    },
    onDismiss: (id: string) =>
      scheduleDismiss(id, () => {
        void setSkipCatchUpVideo(skipDetectFormatId(id)!, "dismiss");
      }),
    onBulkCancel: (groupId: string) => cancelSkipGroup(groupId),
  };
  const cancelSkipGroup = (groupId: string) => {
    const group = skip.groups.find((g) => g.id === groupId);
    if (!group) return;
    const open = group.jobs.filter((j) => j.status === "waiting" || j.status === "transcoding");
    if (open.length > 0) {
      foldCancelledGroup(groupId);
      for (const job of open) void setSkipCatchUpVideo(skipDetectFormatId(job.id)!, "cancel");
      return;
    }
    // Nothing runs or waits: "Remove all from history" removes every episode, the failed and cancelled ones too (they
    // stay left out, with their "Try again" on the title's details, PLAY-SKIP-09).
    scheduleDismiss(groupId, () => {
      for (const job of group.jobs) void setSkipCatchUpVideo(skipDetectFormatId(job.id)!, "dismiss");
    });
  };

  // "Clear finished" (MPV-PREV-07, Chris 2026-11-24): removes every finished job from the history in one go, the
  // imports' and the skip detection's (done, failed, cancelled); what runs or waits stays. A card goes as one when all
  // of it is finished, else its finished rows go one by one.
  const isFinishedJob = (job: LabJob) => job.status === "done" || job.status === "failed" || job.status === "cancelled";
  const finishedGroups = [...allGroups, ...skip.groups].filter((g) => g.jobs.some(isFinishedJob));
  const clearFinished = () => {
    for (const group of finishedGroups) {
      const isSkip = skipDetectFormatId(group.id) !== null;
      const remove = (job: LabJob) =>
        isSkip ? void setSkipCatchUpVideo(skipDetectFormatId(job.id)!, "dismiss") : void dismissJob(job.id);
      const finished = group.jobs.filter(isFinishedJob);
      if (finished.length === group.jobs.length) {
        scheduleDismiss(group.id, () => finished.forEach(remove));
        continue;
      }
      for (const job of finished) scheduleDismiss(job.id, () => remove(job));
    }
  };

  // Stale orphan groups (no media row + all terminal jobs) are filtered out
  // of `allGroups` by buildIngestJobGroups so the sidebar doesn't render
  // un-actionable cards. We still compute their groupIds from the raw job
  // snapshot so the user can sweep them with one click.
  const staleOrphanGroupIds = useMemo(
    () => findStaleOrphanGroupIds(allJobs, media),
    [allJobs, media],
  );

  // A group holding a failed job opens by default, so its "what happened / what it means / one action" lines show
  // without a click (UX-JOBS-03); flip relative to that default, as the bucket toggle does.
  const toggleGroup = (id: string, jobs: LabJob[]) =>
    setExpandedGroups((prev) => ({ ...prev, [id]: !(prev[id] ?? settledDefault(`group:${id}`, groupDefaultExpanded(jobs))) }));

  // Episode bucket toggle. The default (when a key is absent) is not always
  // `false`, so flip relative to the active/failed-aware default rather than
  // relative to `prev[key]` — otherwise a default-expanded bucket would need
  // two clicks to collapse.
  const toggleBucket = (bucketKey: string, jobs: LabJob[]) =>
    setExpandedBuckets((prev) => ({
      ...prev,
      [bucketKey]: !(prev[bucketKey] ?? settledDefault(`bucket:${bucketKey}`, bucketDefaultExpanded(jobs))),
    }));

  const handleDismissStaleJobs = () => {
    for (const groupId of staleOrphanGroupIds) {
      void cancelByGroup(groupId, "stale-orphan-cleanup");
    }
  };

  return (
    <div className="space-y-4 pt-2">
      <IngestUnavailableBanner runtimeError={runtimeError} />
      {allJobs.some((job) => isSubscriptionUnpaidJobError(job.errorMessage)) ? <UnpaidUploadsNotice /> : null}
      {allJobs.some(
        (job) => job.status === "failed" && (isUploadQuotaExceededJobError(job.errorMessage) || isUploadQuotaExceededJobError(job.errorCode)),
      ) ? (
        <QuotaUploadsNotice onRoomChange={setPlanHasRoom} />
      ) : null}
      {failedActions.keptBytesTotal > 0 ? (
        <p className="text-[11px] text-muted-foreground" data-testid="failed-jobs-kept-copies">
          {t("nav.jobs.failed.keptCopies", { size: formatLocalizedStorage(failedActions.keptBytesTotal, i18n.language) })}
        </p>
      ) : null}
      <DesktopJobsFilterBar
        value={filter}
        onChange={setFilter}
        labels={{
          all: t("nav.jobs.filterAll"),
          active: t("nav.jobs.filterActive"),
          queued: t("nav.jobs.filterQueued"),
          completed: t("nav.jobs.filterCompleted"),
          failed: t("nav.jobs.filterFailed"),
        }}
        trailing={
          <>
          {finishedGroups.length > 0 ? (
            <button
              type="button"
              onClick={clearFinished}
              data-testid="jobs-clear-finished"
              className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition"
            >
              {t("nav.jobs.clearFinished")}
            </button>
          ) : null}
          {staleOrphanGroupIds.length > 0 ? (
            <button
              type="button"
              onClick={handleDismissStaleJobs}
              className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-destructive transition"
              aria-label={t("nav.jobs.dismissStaleJobs", "Dismiss stale jobs")}
              title={t("nav.jobs.dismissStaleJobsTooltip", {
                count: staleOrphanGroupIds.length,
                defaultValue: "{{count}} stale orphan groups — click to sweep",
              })}
            >
              {t("nav.jobs.dismissStaleJobs", "Dismiss stale jobs")}
            </button>
          ) : null}
          </>
        }
      />

      {skipPausedKey ? (
        <p className="text-[11px] text-muted-foreground" data-testid="skip-detect-paused">
          {skipPausedKey === "retry_wait"
            ? t("nav.jobs.skipCatchUp.state.retry_wait", { time: formatRetryTime(skipStatus!.retryAt, i18n.language) })
            : t(`nav.jobs.skipCatchUp.state.${skipPausedKey}`)}
          {skipPausedKey === "offline" ? ` · ${t("nav.jobs.skipCatchUp.offlineHint")}` : null}
        </p>
      ) : null}
      {/* Job groups */}
      {groups.length > 0 ? (
        <div className="space-y-3">
          {groups.map((group) => (
            <GroupCard
              key={group.id}
              group={group}
              expanded={groupExpanded(group.id, group.jobs)}
              onToggle={() => toggleGroup(group.id, group.jobs)}
              isBucketExpanded={bucketExpanded}
              onToggleBucket={toggleBucket}
              enableCodecSelection={clientConfig.enableCodecSelection}
              renderFailedDetail={renderFailedDetail}
              describeSkipResult={describeSkipResult}
              dismissing={dismissing}
              onCancel={(id) => {
                scheduleDismiss(id, () => {
                  void cancelJob(id);
                });
                foldCancelled(id);
              }}
              onDismiss={(id) => {
                scheduleDismiss(id, () => {
                  void dismissJob(id);
                });
              }}
              onBulkCancel={(id) => {
                scheduleDismiss(id, () => {
                  void cancelByGroup(id, "group-bulk-action");
                });
                if (group.jobs.some((j) => isActiveJobStatus(j.status))) foldCancelledGroup(id);
              }}
              {...(skipDetectFormatId(group.id) ? skipHandlers : {})}
            />
          ))}
        </div>
      ) : loading ? (
        <DesktopJobsLoadingSkeleton testId="sidebar-loading-skeleton" />
      ) : (
        <DesktopJobsEmpty title={t("lab.empty.title")} subtitle={t("lab.empty.subtitle")} />
      )}
    </div>
  );
}

// An episode bucket is collapsed by default only when every job in it is
// terminal-and-quiet (done / cancelled). Buckets with an active or failed job
// default to expanded so the user lands on the work that still needs them.
// A skip-detection episode (MPV-PREV-07) opens only while it runs or needs the user: a show's queued and done
// episodes stay one line each.
const bucketDefaultExpanded = (jobs: LabJob[]): boolean =>
  jobs.some((j) =>
    isSkipDetectJob(j)
      ? j.status === "transcoding" || j.status === "failed" || j.status === "cancelled"
      : j.status !== "done" && j.status !== "cancelled",
  );

// A job group starts open when one of its jobs failed: the failed job's action must be in sight (UX-JOBS-03). So does
// a cancelled skip job, whose "Try again" must be in sight too; otherwise a title's hundreds of episodes stay folded.
const groupDefaultExpanded = (jobs: LabJob[]): boolean =>
  jobs.some((j) => j.status === "failed" || (isSkipDetectJob(j) && j.status === "cancelled"));

function GroupCard({
  group,
  expanded,
  onToggle,
  isBucketExpanded,
  onToggleBucket,
  enableCodecSelection,
  renderFailedDetail,
  describeSkipResult,
  dismissing,
  onCancel,
  onDismiss,
  onBulkCancel,
}: {
  group: LabJobGroup;
  expanded: boolean;
  onToggle: () => void;
  /** Whether an episode is open: the user's toggle, else its default, which a status change never opens. */
  isBucketExpanded: (bucketKey: string, jobs: LabJob[]) => boolean;
  onToggleBucket: (bucketKey: string, jobs: LabJob[]) => void;
  enableCodecSelection: boolean;
  /** The failed job's three lines and its one action (UX-JOBS-03); null for any other job. */
  renderFailedDetail: (job: LabJob) => ReactNode;
  /** What a done skip-detection job found ("Intro and credits found"). */
  describeSkipResult: (job: LabJob) => string | undefined;
  dismissing: ReadonlySet<string>;
  onCancel: (id: string) => void;
  onDismiss: (id: string) => void;
  onBulkCancel: (groupId: string) => void;
}) {
  const { t } = useTranslation();
  const isSkip = group.jobs.some(isSkipDetectJob);
  // A skip title is "completed" only when every episode is done: a cancelled one keeps its "Try again".
  const isCompleted = isSkip
    ? group.jobs.every((j) => j.status === "done")
    : group.status === "done" || group.status === "cancelled";
  const isRemoving = dismissing.has(group.id);
  const bulkLabel = isCompleted
    ? t("lab.queue.removeAllFromHistory", "Remove all from history")
    : t("lab.queue.cancelAll", "Cancel all");
  // A skip title with nothing left to cancel removes all its episodes from the history.
  const skipBulkKind = !isSkip
    ? null
    : group.jobs.some((j) => j.status === "waiting" || j.status === "transcoding")
      ? "cancel"
      : "remove";

  // Episode sub-grouping: only for TV shows whose jobs span >= 2 distinct
  // source files (episodes). Movies, non-tv groups, and single-episode TV
  // groups keep the existing flat job list.
  const fileBuckets = useMemo(
    () => (group.type === "tv" ? buildFileBuckets(group.jobs) : []),
    [group.type, group.jobs],
  );
  const useEpisodeSubGroups = fileBuckets.length >= 2;
  const renderRow = (job: LabJob) => (
    <SidebarJobRow
      key={job.id}
      job={job}
      isCompleted={isCompleted || (isSkipDetectJob(job) && job.status === "done")}
      completedMeta={isSkipDetectJob(job) ? describeSkipResult(job) : undefined}
      enableCodecSelection={enableCodecSelection}
      failedDetail={renderFailedDetail(job)}
      dismissing={dismissing}
      onCancel={onCancel}
      onDismiss={onDismiss}
    />
  );

  return (
    <DesktopJobGroupCard
      removing={isRemoving}
      expanded={expanded}
      onToggle={onToggle}
      artwork={<MediaImage path={group.posterPath ?? null} alt={group.title} className="h-full w-full object-cover" />}
      title={group.title}
      kindLabel={
        group.type === "tv" ? t("lab.queue.typeTv") : group.type === "movie" ? t("lab.queue.typeMovie") : undefined
      }
      countLabel={t("lab.queue.jobCount", { count: group.jobs.length })}
      badge={
        <LabStatusBadge
          status={group.status}
          stageLabel={group.stageLabel}
          queuePosition={group.queuePosition}
          waitingLabel={isSkip ? group.stageLabel : undefined}
        />
      }
      action={
        <DesktopJobActionButton
          kind={skipBulkKind ?? (isCompleted ? "remove" : "cancel")}
          label={
            skipBulkKind === "remove"
              ? t("lab.queue.removeAllFromHistory", "Remove all from history")
              : skipBulkKind === "cancel"
                ? t("lab.queue.cancelAll", "Cancel all")
                : bulkLabel
          }
          disabled={isRemoving}
          onClick={() => onBulkCancel(group.id)}
        />
      }
    >
      {useEpisodeSubGroups ? (
        <div>
          {fileBuckets.map((bucket, index) => {
            const bucketKey = `${group.id}::${bucket.id}`;
            const bucketExpanded = isBucketExpanded(bucketKey, bucket.jobs);
            const badgeJob = pickMostActiveJob(bucket.jobs);
            return (
              <div key={bucket.id} className={index > 0 ? "border-t border-border/50" : undefined}>
                <DesktopJobBucketHeader
                  expanded={bucketExpanded}
                  onToggle={() => onToggleBucket(bucketKey, bucket.jobs)}
                  title={bucket.title}
                  countLabel={t("lab.queue.jobCount", { count: bucket.jobs.length })}
                  badge={
                    badgeJob ? (
                      <LabStatusBadge
                        status={badgeJob.status}
                        stageLabel={badgeJob.stageLabel}
                        queuePosition={badgeJob.queuePosition}
                        waitingLabel={isSkipDetectJob(badgeJob) ? badgeJob.stageLabel : undefined}
                      />
                    ) : null
                  }
                />
                {bucketExpanded ? <div className="pl-5 pb-2 space-y-3">{bucket.jobs.map(renderRow)}</div> : null}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="space-y-3">{group.jobs.map(renderRow)}</div>
      )}
    </DesktopJobGroupCard>
  );
}

// One job row inside an expanded group / episode sub-group. Branches on the
// owning group's completed state exactly as the prior inline map did:
// completed groups render `CompletedJobRow`, otherwise the active-job block.
function SidebarJobRow({
  job,
  isCompleted,
  completedMeta,
  enableCodecSelection,
  failedDetail,
  dismissing,
  onCancel,
  onDismiss,
}: {
  job: LabJob;
  isCompleted: boolean;
  /** Replaces a completed row's meta line (a skip job's result). */
  completedMeta?: string;
  enableCodecSelection: boolean;
  failedDetail: ReactNode;
  dismissing: ReadonlySet<string>;
  onCancel: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  const { t } = useTranslation();
  if (isCompleted) {
    return (
      <CompletedJobRow
        job={job}
        meta={completedMeta}
        enableCodecSelection={enableCodecSelection}
        dismissing={dismissing}
        onDismiss={onDismiss}
      />
    );
  }
  const { outputLabel, episodeLabel, uploadSpeedLabel } =
    buildActiveLabJobPresentation(job, enableCodecSelection, t);
  const active = isActiveJobStatus(job.status);
  const isRemoving = dismissing.has(job.id);
  return (
    <DesktopJobRow
      removing={isRemoving}
      title={outputLabel}
      detail={episodeLabel}
      // A skip job's "filename" is its bucket key (the episode code or the title), already shown above it.
      filename={isSkipDetectJob(job) ? undefined : job.filename}
      badge={
        <LabStatusBadge
          status={job.status}
          error={job.error}
          stageLabel={job.stageLabel}
          queuePosition={job.queuePosition}
          waitingLabel={isSkipDetectJob(job) ? job.stageLabel : undefined}
        />
      }
      progress={
        job.status === "transcoding" || job.status === "uploading" ? (
          <DesktopJobProgress percent={job.progress} speedLabel={uploadSpeedLabel} />
        ) : null
      }
      extra={failedDetail}
      action={
        // A failed or cancelled skip job also has its "Try again"; removed, it stays left out and its title's details
        // keep the "Try again" (MPV-PREV-07, PLAY-SKIP-09).
        <DesktopJobActionButton
          kind={active ? "cancel" : "remove"}
          label={active ? t("lab.queue.cancel", "Cancel") : t("lab.queue.removeFromHistory", "Remove from history")}
          disabled={isRemoving}
          onClick={() => (active ? onCancel(job.id) : onDismiss(job.id))}
        />
      }
    />
  );
}

function CompletedJobRow({
  job,
  meta,
  enableCodecSelection,
  dismissing,
  onDismiss,
}: {
  job: LabJobGroup["jobs"][number];
  meta?: string;
  enableCodecSelection: boolean;
  dismissing: ReadonlySet<string>;
  onDismiss: (id: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const { outputSummary, completedMeta } = buildCompletedLabJobPresentation(
    job,
    enableCodecSelection,
    t,
  );
  const isRemoving = dismissing.has(job.id);
  // An offline save refused for lack of disk space says why, as the download prompt does (OFFL-SAFE-02).
  const diskSpaceMessage = offlineDiskSpaceJobMessage(job.error, t, () => i18n.language);

  return (
    <DesktopCompletedJobRow
      removing={isRemoving}
      title={outputSummary || t("lab.queue.job")}
      filename={isSkipDetectJob(job) ? undefined : job.filename}
      meta={meta ?? diskSpaceMessage ?? completedMeta?.label}
      badge={<LabStatusBadge status={job.status} error={job.error} />}
      action={
        <DesktopJobActionButton
          kind="remove"
          label={t("lab.queue.removeFromHistory", "Remove from history")}
          disabled={isRemoving}
          onClick={() => onDismiss(job.id)}
        />
      }
    />
  );
}
