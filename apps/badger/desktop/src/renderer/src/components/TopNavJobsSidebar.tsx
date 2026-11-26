import { Suspense, lazy, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { DesktopJobsBackgroundLine, DesktopJobsSheet } from "@space/desktop-shell/components";
import { useLabJobsData } from "@/lib/labJobs";
import { useRuntimeIngestJobs } from "@/lib/runtimeIngestJobs";
import HighTrafficDownloadsNotice from "@/components/HighTrafficDownloadsNotice";
import { useCrewBackfillProgress } from "@/lib/crewBackfill";
import { OPEN_JOBS_EVENT, skipCatchUpActiveCount, useSkipCatchUpStatus } from "@/lib/skipCatchUp";

const TopNavJobsSidebarContent = lazy(() => import("./TopNavJobsSidebarContent"));

/** The top bar's Jobs item and panel (UX-JOBS-01), the shared `DesktopJobsSheet` Parrot uses too. */
export default function TopNavJobsSidebar() {
  const { t } = useTranslation();
  const { activeGroups } = useLabJobsData();
  const { jobs } = useRuntimeIngestJobs();
  // LIB-CREW-01: the background crew backfill's one quiet line; no badge, no spinner on the icon.
  const crewBackfill = useCrewBackfillProgress();
  // MPV-PREV-07: the skip-detection catch-up counts as one running job while it works.
  const skipCatchUp = useSkipCatchUpStatus();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const openPanel = () => setOpen(true);
    window.addEventListener(OPEN_JOBS_EVENT, openPanel);
    // UX-NOTICE-06: a click on the system notification of a job that ended while the window was hidden.
    const stopNoticeOpens = window.sf?.hiddenJobNotices?.onOpenJobs(openPanel);
    return () => {
      window.removeEventListener(OPEN_JOBS_EVENT, openPanel);
      stopNoticeOpens?.();
    };
  }, []);

  return (
    <DesktopJobsSheet
      title={t("nav.jobs.title")}
      subtitle={t("nav.jobs.subtitle")}
      activeCount={activeGroups.length + skipCatchUpActiveCount(skipCatchUp)}
      jobCount={jobs.length}
      open={open}
      onOpenChange={setOpen}
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
