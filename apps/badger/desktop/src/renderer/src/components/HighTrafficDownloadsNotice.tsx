/**
 * Jobs-sidebar notice explaining why offline downloads are not at full speed. Two cases, keyed on the job `stageCode`
 * the runtime sets:
 * - `held_saturated` (STOR-BW-09): the object's storage silo is saturated, the gateway gives the download zero bytes
 *   and it resumes by itself when the silo lifts;
 * - `slowed_high_traffic` (STOR-BW-01): some silo is in the high-traffic state, the download is de-prioritised but
 *   never stopped.
 * The held notice wins when both kinds of job exist. The notice disappears with the stage. Takes the job list so the
 * sidebar chunk (size-budgeted) only carries one element.
 */
import { useTranslation } from "react-i18next";
import { HELD_SATURATED_STAGE_CODE, SLOWED_HIGH_TRAFFIC_STAGE_CODE } from "@space/shared/storageTrafficStage";
import AmberNotice from "@/components/AmberNotice";

type JobLike = { status: string; stageCode?: string | null };

const isLiveInStage = (job: JobLike, stageCode: string): boolean =>
  (job.status === "running" || job.status === "queued") && job.stageCode === stageCode;

export const isHeldForSaturation = (job: JobLike): boolean => isLiveInStage(job, HELD_SATURATED_STAGE_CODE);

export const isSlowedForHighTraffic = (job: JobLike): boolean => isLiveInStage(job, SLOWED_HIGH_TRAFFIC_STAGE_CODE);

export default function HighTrafficDownloadsNotice({ jobs }: { jobs: readonly JobLike[] }) {
  const { t } = useTranslation();
  if (jobs.some(isHeldForSaturation)) {
    return <AmberNotice testId="downloads-held-notice">{t("nav.jobs.downloadsHeld")}</AmberNotice>;
  }
  if (jobs.some(isSlowedForHighTraffic)) {
    return <AmberNotice testId="downloads-slowed-notice">{t("nav.jobs.downloadsSlowed")}</AmberNotice>;
  }
  return null;
}
