import { Suspense, lazy } from "react";
import { useTranslation } from "react-i18next";
import { DesktopJobsBackgroundLine, DesktopJobsSheet } from "@space/desktop-shell/components";
import { useLabJobsData } from "@/lib/labJobs";
import { useRuntimeIngestJobs } from "@/lib/runtimeIngestJobs";
import HighTrafficDownloadsNotice from "@/components/HighTrafficDownloadsNotice";
import { useCrewBackfillProgress } from "@/lib/crewBackfill";

const TopNavJobsSidebarContent = lazy(() => import("./TopNavJobsSidebarContent"));

/** The top bar's Jobs item and panel (UX-JOBS-01), the shared `DesktopJobsSheet` Parrot uses too. */
export default function TopNavJobsSidebar() {
  const { t } = useTranslation();
  const { activeGroups } = useLabJobsData();
  const { jobs } = useRuntimeIngestJobs();
  // LIB-CREW-01: the background crew backfill's one quiet line; no badge, no spinner on the icon.
  const crewBackfill = useCrewBackfillProgress();

  return (
    <DesktopJobsSheet
      title={t("nav.jobs.title")}
      subtitle={t("nav.jobs.subtitle")}
      activeCount={activeGroups.length}
      jobCount={jobs.length}
      testId="top-nav-jobs"
    >
      <div className="pt-2 empty:hidden">
        <HighTrafficDownloadsNotice jobs={jobs} />
      </div>
      {crewBackfill ? (
        <DesktopJobsBackgroundLine testId="crew-backfill-status">
          {t("nav.jobs.crewBackfill", { handled: crewBackfill.handled, total: crewBackfill.total })}
        </DesktopJobsBackgroundLine>
      ) : null}
      <Suspense fallback={null}>
        <TopNavJobsSidebarContent />
      </Suspense>
    </DesktopJobsSheet>
  );
}
