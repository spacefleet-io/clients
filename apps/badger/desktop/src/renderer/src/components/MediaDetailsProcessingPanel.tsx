/**
 * Media-details processing panel. Native runtime-engine V2 — pulls jobs
 * scoped to a single media via `useRuntimeIngestJobs({ mediaId })`.
 *
 * Behavioural rules:
 *   - Trash on an active job → cancelJob(id) only (row remains as cancelled).
 *   - Trash on a terminal job → dismissJob(id) only (row disappears).
 *   - No optimistic state — render exactly what the runtime says.
 *
 * V2 jobs are personal (not shared with peers), so the V1 "Shared
 * processing jobs" banner is intentionally not rendered here.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  DesktopCompletedJobRow,
  DesktopJobActionButton,
  DesktopJobProgress,
  DesktopJobRow,
  DesktopJobsLoadingSkeleton,
  DesktopJobsTabEmpty,
} from "@space/desktop-shell/components";
import { notifyError } from "@/lib/notify";
import { useClientConfig } from "@/lib/useClientConfig";
import { useLibraryData } from "@/lib/libraryContext";
import {
  pickMostActiveJob,
  useRuntimeIngestActions,
  useRuntimeIngestJobs,
} from "@/lib/runtimeIngestJobs";
import { buildFileBuckets } from "@/components/labQueueGroups";
import { LabStatusBadge } from "@/components/LabStatusBadge";
import IngestUnavailableBanner from "@/components/IngestUnavailableBanner";
import {
  buildActiveLabJobPresentation,
  buildCompletedLabJobPresentation,
} from "@/components/labJobPresentation";
import type { LabJob } from "../../../shared/labQueueShared";
import { formatUploadSpeedLabel } from "@/lib/uploadSpeed";

type MediaDetailsProcessingPanelProps = {
  mediaId: string;
};

const isTerminalLabStatus = (status: LabJob["status"]) =>
  status === "done" || status === "failed" || status === "cancelled";

export default function MediaDetailsProcessingPanel({
  mediaId,
}: MediaDetailsProcessingPanelProps) {
  const { t } = useTranslation();
  const { media } = useLibraryData();
  // Pass `media` so the orphan-sweep filter in buildIngestJobGroups can see
  // that this mediaId DOES have a media row. Without it, every group with
  // only terminal jobs (succeeded/failed/cancelled/interrupted) is treated
  // as a stale orphan and dropped — which made the Processes tab render
  // empty for any media whose jobs had all settled. The orphan sweep is a
  // sidebar concern; the per-media panel is opened against a known media,
  // so by definition the row exists.
  const { groups, loading, runtimeError } = useRuntimeIngestJobs({ mediaId, media });
  const { cancelJob, dismissJob } = useRuntimeIngestActions();
  const clientConfig = useClientConfig();
  const enableCodecSelection = Boolean(clientConfig.enableCodecSelection);

  const labJobs: LabJob[] = groups.flatMap((group) => group.jobs);
  // For TV shows with 2+ distinct source files (i.e. multiple episodes
  // ingested), group jobs into per-episode collapsible buckets — same
  // filename-keyed grouping the top-nav jobs sidebar uses (see
  // TopNavJobsSidebarContent + labQueueGroups.buildFileBuckets). Movies and
  // single-episode shows fall through to the flat list unchanged.
  const isTv = groups.some((g) => g.type === "tv");
  const fileBuckets = isTv ? buildFileBuckets(labJobs) : [];
  const useEpisodeSubGroups = isTv && fileBuckets.length >= 2;
  const [expandedBuckets, setExpandedBuckets] = useState<Record<string, boolean>>({});
  const isBucketActive = (jobs: LabJob[]) =>
    jobs.some((j) => j.status !== "done" && j.status !== "cancelled");
  const isBucketExpanded = (bucket: { id: string; jobs: LabJob[] }) =>
    expandedBuckets[bucket.id] ?? isBucketActive(bucket.jobs);
  const toggleBucket = (bucket: { id: string; jobs: LabJob[] }) =>
    setExpandedBuckets((prev) => ({
      ...prev,
      [bucket.id]: !(prev[bucket.id] ?? isBucketActive(bucket.jobs)),
    }));

  // The Jobs tab is always present (Round 5 UX change). Render rules:
  //   - loading + zero jobs → skeleton (snapshot fetch in flight)
  //   - !loading + zero jobs + no error → friendly empty-state
  //   - any jobs OR runtimeError → fall through to the row render below
  if (labJobs.length === 0 && !runtimeError) {
    if (loading) return <DesktopJobsLoadingSkeleton variant="row" testId="processing-panel-loading-skeleton" />;
    return <ProcessingPanelEmptyState />;
  }

  const handleCancel = (jobId: string) => {
    void cancelJob(jobId).catch(() =>
      notifyError(t("library.processingStatus.remoteActionFailed", "Could not send command.")),
    );
  };
  const handleDismiss = (jobId: string) => {
    void dismissJob(jobId).catch(() =>
      notifyError(t("library.processingStatus.remoteActionFailed", "Could not send command.")),
    );
  };

  const renderJob = (job: LabJob) =>
    isTerminalLabStatus(job.status) ? (
      <CompletedJobRow
        key={job.id}
        job={job}
        enableCodecSelection={enableCodecSelection}
        onDismiss={handleDismiss}
      />
    ) : (
      <ActiveJobRow
        key={job.id}
        job={job}
        enableCodecSelection={enableCodecSelection}
        onCancel={handleCancel}
      />
    );

  return (
    <div className="space-y-2">
      <IngestUnavailableBanner runtimeError={runtimeError} />
      {useEpisodeSubGroups
        ? fileBuckets.map((bucket) => {
            const expanded = isBucketExpanded(bucket);
            const headerJob = pickMostActiveJob(bucket.jobs);
            return (
              <div
                key={bucket.id}
                className="border-t border-border/50 first:border-t-0"
              >
                <button
                  type="button"
                  className="flex w-full items-center gap-2 py-2 text-left"
                  onClick={() => toggleBucket(bucket)}
                >
                  {expanded ? (
                    <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                  ) : (
                    <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                  )}
                  <span className="text-sm font-semibold flex-1 truncate">
                    {bucket.title}
                  </span>
                  <span className="text-[11px] text-muted-foreground shrink-0">
                    {t("lab.queue.jobCount", { count: bucket.jobs.length })}
                  </span>
                  {headerJob ? (
                    <LabStatusBadge
                      status={headerJob.status}
                      stageLabel={headerJob.stageLabel}
                      queuePosition={headerJob.queuePosition}
                    />
                  ) : null}
                </button>
                {expanded ? (
                  <div className="pl-5 space-y-2 pb-2">
                    {bucket.jobs.map(renderJob)}
                  </div>
                ) : null}
              </div>
            );
          })
        : labJobs.map(renderJob)}
    </div>
  );
}

function ActiveJobRow({
  job,
  enableCodecSelection,
  onCancel,
}: {
  job: LabJob;
  enableCodecSelection: boolean;
  onCancel: (id: string) => void;
}) {
  const { t } = useTranslation();
  const { outputLabel, episodeLabel, uploadSpeedLabel } = buildActiveLabJobPresentation(
    job,
    enableCodecSelection,
    t,
  );
  const speedLabel =
    uploadSpeedLabel ||
    (job.status === "uploading" && (job.uploadSpeedMbps ?? 0) > 0
      ? formatUploadSpeedLabel(t, job.uploadSpeedMbps ?? 0)
      : null);

  return (
    <DesktopJobRow
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
          <DesktopJobProgress percent={job.progress} speedLabel={speedLabel} />
        ) : null
      }
      action={<DesktopJobActionButton kind="cancel" label={t("lab.queue.cancel", "Cancel")} onClick={() => onCancel(job.id)} />}
    />
  );
}

function CompletedJobRow({
  job,
  enableCodecSelection,
  onDismiss,
}: {
  job: LabJob;
  enableCodecSelection: boolean;
  onDismiss: (id: string) => void;
}) {
  const { t } = useTranslation();
  const { outputSummary, completedMeta } = buildCompletedLabJobPresentation(
    job,
    enableCodecSelection,
    t,
  );

  return (
    <DesktopCompletedJobRow
      title={outputSummary || t("lab.queue.job")}
      filename={job.filename}
      meta={completedMeta?.label}
      badge={<LabStatusBadge status={job.status} error={job.error} />}
      action={
        <DesktopJobActionButton
          kind="remove"
          label={t("lab.queue.removeFromHistory", "Remove from history")}
          onClick={() => onDismiss(job.id)}
        />
      }
    />
  );
}

// Friendly empty-state when the panel has no jobs (post-load, no error).
// The Jobs tab is always visible per round-5 UX, so an empty media needs
// a message rather than just rendering nothing.
function ProcessingPanelEmptyState() {
  const { t } = useTranslation();
  return (
    <DesktopJobsTabEmpty
      title={t("library.jobs.emptyTitle", "All caught up")}
      subtitle={t("library.jobs.emptySubtitle", "No active or recent jobs for this media.")}
      testId="processing-panel-empty-state"
    />
  );
}
