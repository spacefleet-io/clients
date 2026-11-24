/**
 * The three lines under a failed import in the Jobs panel (UX-JOBS-03): what happened, what it means, and the ONE
 * action that fits what is still on this computer. The runtime picks the action (`useFailedJobActions`); this only
 * words it. Remove stays on the row's bin, so "remove only" and "already in the library" draw no button here.
 */
import { useTranslation } from "react-i18next";
import { DesktopFailedJobDetail } from "@space/desktop-shell/components";
import type { FailedJobAction, FailedJobAvailability, FailedJobReason } from "@space/runtime-contracts/runtime/jobs";

const MEANING_KEY: Record<FailedJobReason, string> = {
  kept_outputs: "nav.jobs.failed.meaningKeptOutputs",
  source_unchanged: "nav.jobs.failed.meaningSourceUnchanged",
  kept_removed_low_disk: "nav.jobs.failed.meaningKeptRemovedLowDisk",
  kept_removed_expired: "nav.jobs.failed.meaningKeptRemovedExpired",
  source_changed: "nav.jobs.failed.meaningSourceChanged",
  source_missing: "nav.jobs.failed.meaningSourceMissing",
  picked_mismatch: "nav.jobs.failed.meaningPickedMismatch",
  source_deleted: "nav.jobs.failed.meaningSourceDeleted",
  no_source_path: "nav.jobs.failed.meaningNoSourcePath",
  reimported: "nav.jobs.failed.meaningReimported",
  upload_quota: "nav.jobs.failed.meaningPlanFull",
  disk_full: "nav.jobs.failed.meaningDiskFull",
  parent_failed: "nav.jobs.failed.meaningParentFailed",
  not_retryable: "nav.jobs.failed.meaningNotRetryable",
};

const ACTION_LABEL_KEY: Partial<Record<FailedJobAction, string>> = {
  upload_again: "nav.jobs.failed.actionUploadAgain",
  process_again: "nav.jobs.failed.actionProcessAgain",
  find_file: "nav.jobs.failed.actionFindFile",
  upgrade_plan: "nav.jobs.failed.actionUpgradePlan",
};

export default function FailedImportDetail({
  availability,
  planHasRoom,
  busy,
  onRun,
  onUpgradePlan,
}: {
  availability: FailedJobAvailability;
  /** The account has room again (QuotaUploadsNotice): a full-plan failure offers its next action instead. */
  planHasRoom: boolean;
  busy: boolean;
  onRun: (jobId: string) => void;
  onUpgradePlan: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { jobId, reason, keptBytes, keptUntil } = availability;
  const roomAgain = availability.action === "upgrade_plan" && planHasRoom;
  const action = roomAgain ? availability.nextAction : availability.action;

  const what =
    reason === "upload_quota"
      ? t("nav.jobs.failed.whatPlanFull")
      : reason === "disk_full"
        ? t("nav.jobs.failed.whatDiskFull")
        : keptBytes !== null
          ? t("nav.jobs.failed.whatUploadStopped")
          : t("nav.jobs.failed.whatImportStopped");
  const date = keptUntil
    ? new Intl.DateTimeFormat(i18n.language, { day: "numeric", month: "long" }).format(new Date(keptUntil))
    : "";
  const meaning = roomAgain ? t("nav.jobs.failed.meaningPlanHasRoom") : t(MEANING_KEY[reason], { date });
  const labelKey = action ? ACTION_LABEL_KEY[action] : undefined;

  return (
    <DesktopFailedJobDetail
      testId={`failed-job-detail-${jobId}`}
      what={what}
      meaning={meaning}
      action={
        labelKey
          ? {
              label: t(labelKey),
              busy,
              testId: `failed-job-action-${jobId}`,
              onClick: () => (action === "upgrade_plan" ? onUpgradePlan() : onRun(jobId)),
            }
          : undefined
      }
    />
  );
}
