/**
 * Top-nav jobs sidebar content. Native runtime-engine V2 — pulls jobs
 * directly from `useRuntimeIngestJobs()` and routes trash actions to
 * `cancelJob` (active) / `dismissJob` (terminal).
 *
 * Plan reference: video-ingestion-is-buggy-effervescent-teapot.md Round 3.
 */
import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  DesktopCompletedJobRow,
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

type JobFilter = DesktopJobFilter;

const classifyJob = (status: JobStatus): Exclude<JobFilter, "all"> => {
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
  const [filter, setFilter] = useState<JobFilter>("all");
  const [planHasRoom, setPlanHasRoom] = useState(false);
  const failedJobIds = useMemo(
    () => allJobs.filter((job) => job.status === "failed").map((job) => job.jobId),
    [allJobs],
  );
  const failedActions = useFailedJobActions(failedJobIds);
  const renderFailedDetail = (job: LabJob): ReactNode => {
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

  const filteredGroups = useMemo(() => {
    if (filter === "all") return allGroups;
    return allGroups
      .map((g) => ({ ...g, jobs: g.jobs.filter((j) => classifyJob(j.status) === filter) }))
      .filter((g) => g.jobs.length > 0);
  }, [allGroups, filter]);

  // `filteredGroups` arrives already sorted most-recent-first by
  // buildIngestJobGroups; we just slice for display.
  const groups = useMemo(
    () => filteredGroups.slice(0, GROUP_LIMIT),
    [filteredGroups],
  );

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
    setExpandedGroups((prev) => ({ ...prev, [id]: !(prev[id] ?? groupDefaultExpanded(jobs)) }));

  // Episode bucket toggle. The default (when a key is absent) is not always
  // `false`, so flip relative to the active/failed-aware default rather than
  // relative to `prev[key]` — otherwise a default-expanded bucket would need
  // two clicks to collapse.
  const toggleBucket = (bucketKey: string, jobs: LabJob[]) =>
    setExpandedBuckets((prev) => ({
      ...prev,
      [bucketKey]: !(prev[bucketKey] ?? bucketDefaultExpanded(jobs)),
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
          staleOrphanGroupIds.length > 0 ? (
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
          ) : null
        }
      />

      {/* Job groups */}
      {groups.length > 0 ? (
        <div className="space-y-3">
          {groups.map((group) => (
            <GroupCard
              key={group.id}
              group={group}
              expanded={expandedGroups[group.id] ?? groupDefaultExpanded(group.jobs)}
              onToggle={() => toggleGroup(group.id, group.jobs)}
              expandedBuckets={expandedBuckets}
              onToggleBucket={toggleBucket}
              enableCodecSelection={clientConfig.enableCodecSelection}
              renderFailedDetail={renderFailedDetail}
              dismissing={dismissing}
              onCancel={(id) => {
                scheduleDismiss(id, () => {
                  void cancelJob(id);
                });
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
              }}
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
const bucketDefaultExpanded = (jobs: LabJob[]): boolean =>
  jobs.some((j) => j.status !== "done" && j.status !== "cancelled");

// A job group starts open when one of its jobs failed: the failed job's action must be in sight (UX-JOBS-03).
const groupDefaultExpanded = (jobs: LabJob[]): boolean => jobs.some((j) => j.status === "failed");

function GroupCard({
  group,
  expanded,
  onToggle,
  expandedBuckets,
  onToggleBucket,
  enableCodecSelection,
  renderFailedDetail,
  dismissing,
  onCancel,
  onDismiss,
  onBulkCancel,
}: {
  group: LabJobGroup;
  expanded: boolean;
  onToggle: () => void;
  expandedBuckets: Record<string, boolean>;
  onToggleBucket: (bucketKey: string, jobs: LabJob[]) => void;
  enableCodecSelection: boolean;
  /** The failed job's three lines and its one action (UX-JOBS-03); null for any other job. */
  renderFailedDetail: (job: LabJob) => ReactNode;
  dismissing: ReadonlySet<string>;
  onCancel: (id: string) => void;
  onDismiss: (id: string) => void;
  onBulkCancel: (groupId: string) => void;
}) {
  const { t } = useTranslation();
  const isCompleted = group.status === "done" || group.status === "cancelled";
  const isRemoving = dismissing.has(group.id);
  const bulkLabel = isCompleted
    ? t("lab.queue.removeAllFromHistory", "Remove all from history")
    : t("lab.queue.cancelAll", "Cancel all");

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
      isCompleted={isCompleted}
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
      badge={<LabStatusBadge status={group.status} stageLabel={group.stageLabel} queuePosition={group.queuePosition} />}
      action={
        <DesktopJobActionButton
          kind={isCompleted ? "remove" : "cancel"}
          label={bulkLabel}
          disabled={isRemoving}
          onClick={() => onBulkCancel(group.id)}
        />
      }
    >
      {useEpisodeSubGroups ? (
        <div>
          {fileBuckets.map((bucket, index) => {
            const bucketKey = `${group.id}::${bucket.id}`;
            const bucketExpanded = expandedBuckets[bucketKey] ?? bucketDefaultExpanded(bucket.jobs);
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
  enableCodecSelection,
  failedDetail,
  dismissing,
  onCancel,
  onDismiss,
}: {
  job: LabJob;
  isCompleted: boolean;
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
      filename={job.filename}
      badge={
        <LabStatusBadge
          status={job.status}
          error={job.error}
          stageLabel={job.stageLabel}
          queuePosition={job.queuePosition}
        />
      }
      progress={
        job.status === "transcoding" || job.status === "uploading" ? (
          <DesktopJobProgress percent={job.progress} speedLabel={uploadSpeedLabel} />
        ) : null
      }
      extra={failedDetail}
      action={
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
  enableCodecSelection,
  dismissing,
  onDismiss,
}: {
  job: LabJobGroup["jobs"][number];
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
      filename={job.filename}
      meta={diskSpaceMessage ?? completedMeta?.label}
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
