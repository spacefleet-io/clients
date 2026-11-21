import { useEffect, useState } from "react";
import {
  DesktopCompletedJobRow,
  DesktopJobActionButton,
  DesktopJobProgress,
  DesktopJobRow,
  DesktopJobStatusPill,
  DesktopJobsBackgroundLine,
  DesktopJobsEmpty,
  DesktopJobsFilterBar,
  DesktopJobsLoadingSkeleton,
  DesktopJobsSheet,
  desktopTopNavIconActionClassName,
  useStaggeredDismiss,
  type DesktopJobFilter,
  type DesktopJobTone,
} from "@space/desktop-shell/components";
import { formatLocalizedStorage } from "@space/shared/format";
import { IMPORT_INTERRUPTED, type ParrotBackgroundWork, type ParrotImportJob, type ParrotImportStatus, type ParrotLanguage } from "../../shared/ipc";
import type { ParrotStringKey, Translate } from "./i18n";
import type { NotificationPart } from "./notificationText";
import { ExportJobList, exportJobMatches, useExportJobs } from "./ExportJobs";

/**
 * Why an import or a file failed, as the user reads it: a publish other saves kept beating (the server's 409
 * `version_conflict`, PAR-UP-03) and an import cut short by closing Parrot are said in words; any other reason is shown
 * as it came (a file system or network error).
 */
export const importErrorPart = (error: string): NotificationPart =>
  error === IMPORT_INTERRUPTED ? { key: "jobs.interrupted" } : /version_conflict|library_db_conflict/.test(error) ? { key: "import.conflict" } : error;

const importErrorText = (t: Translate, error: string) => {
  const part = importErrorPart(error);
  return typeof part === "string" ? part : t(part.key);
};

/** One line for where an import stands (PAR-UP-04): reading, waiting for the review, uploading, adding, done, failed or stopped. */
export function importLine(t: Translate, language: ParrotLanguage, status: ParrotImportStatus): string | null {
  switch (status.phase) {
    case "idle":
      return null;
    case "scanning":
      return status.total > 0 ? t("import.scanningCount", { done: status.done, total: status.total }) : t("import.scanning");
    case "review":
      return t("import.review");
    case "uploading":
      return t("import.uploading", {
        done: status.done,
        total: status.total,
        doneSize: formatLocalizedStorage(status.bytesDone, language),
        totalSize: formatLocalizedStorage(status.bytesTotal, language),
      });
    case "publishing":
      return t("import.publishing");
    case "done":
      return t("import.done", { imported: status.imported, skipped: status.skipped, failed: status.failed });
    case "failed":
      return t("import.failed", { error: importErrorText(t, status.error ?? "") });
    case "cancelled":
      return t("jobs.status.cancelled");
  }
}

const fileName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** Which filter chips list a job: a running import is active, one ready to review is queued (UX-JOBS-01). */
export function importJobMatches(job: ParrotImportJob, filter: DesktopJobFilter): boolean {
  const { phase, running, failed } = job.status;
  switch (filter) {
    case "all":
      return true;
    case "active":
      return running;
    case "queued":
      return phase === "review";
    case "completed":
      return phase === "done" || phase === "cancelled";
    case "failed":
      return phase === "failed" || failed > 0;
  }
}

/** The ended phases: the row gets the bin instead of the X. */
const importJobEnded = (status: ParrotImportStatus) => !status.running && (status.phase === "done" || status.phase === "failed" || status.phase === "cancelled");

/** UX-JOBS-02: an import's pill, in the same words and colours as Badger's job pills. Still running (the library
 * reloads after the last song), it reads Uploading, never Done. */
const importPill = (status: ParrotImportStatus): { key: ParrotStringKey; tone: DesktopJobTone } => {
  if (status.running && status.phase !== "scanning") return { key: "jobs.status.uploading", tone: "cyan" };
  switch (status.phase) {
    case "scanning":
      return { key: "jobs.status.scanning", tone: "blue" };
    case "review":
      return { key: "jobs.status.review", tone: "amber" };
    case "done":
      return { key: "jobs.status.done", tone: "emerald" };
    case "failed":
      return { key: "jobs.status.failed", tone: "destructive" };
    case "cancelled":
      return { key: "jobs.status.cancelled", tone: "neutral" };
    default:
      return { key: "jobs.status.uploading", tone: "cyan" };
  }
};

/**
 * This account's imports, live: null until the first answer (the panel shows the loading cards meanwhile). Shared by
 * the Jobs panel and an album's Jobs tab.
 */
export function useImportJobs(): ParrotImportJob[] | null {
  const [jobs, setJobs] = useState<ParrotImportJob[] | null>(null);
  useEffect(() => {
    let live = true;
    void window.parrot.getImportJobs().then((list) => {
      if (live) setJobs(list);
    });
    const off = window.parrot.onImportJobs(setJobs);
    return () => {
      live = false;
      off();
    };
  }, []);
  return jobs;
}

/** The lookups running on their own (lyrics, artist photos), for the panel's quiet line (UX-JOBS-02). */
function useBackgroundWork(): ParrotBackgroundWork[] {
  const [work, setWork] = useState<ParrotBackgroundWork[]>([]);
  useEffect(() => {
    let live = true;
    void window.parrot.getBackgroundWork().then((list) => {
      if (live) setWork(list);
    });
    const off = window.parrot.onBackgroundWork(setWork);
    return () => {
      live = false;
      off();
    };
  }, []);
  return work;
}

const BACKGROUND_KEY: Record<ParrotBackgroundWork["kind"], ParrotStringKey> = {
  lyrics: "jobs.background.lyrics",
  artistPhotos: "jobs.background.artistPhotos",
  covers: "jobs.background.covers",
};

/**
 * UX-JOBS-01 / UX-JOBS-02 / PAR-UP-04: the top bar's Jobs item in Parrot, the same flask, side panel and job cards as
 * Badger's, listing this account's imports (running, ready to review, finished, stopped, failed) with what each added,
 * found already there, or could not import and why. A running import has the X (it stops the uploads left; songs
 * already in stay), an ended one the bin; one ready to review opens the review on a click.
 */
export function ImportJobs({ t, language, onReview }: { t: Translate; language: ParrotLanguage; onReview: () => void }) {
  const jobs = useImportJobs();
  const background = useBackgroundWork();
  const [filter, setFilter] = useState<DesktopJobFilter>("all");

  const list = jobs ?? [];
  const shown = list.filter((job) => importJobMatches(job, filter));
  const exports = useExportJobs() ?? [];
  const shownExports = exports.filter((job) => exportJobMatches(job, filter));
  const activeCount = list.filter((job) => job.status.running).length + exports.filter((job) => job.phase === "running").length;

  return (
    <DesktopJobsSheet title={t("jobs.title")} subtitle={t("jobs.subtitle")} activeCount={activeCount} jobCount={list.length + exports.length} triggerClassName={desktopTopNavIconActionClassName} testId="nav-jobs">
      <div className="flex flex-col gap-4 p-4" data-testid="import-jobs">
        {background.map((work) => (
          <DesktopJobsBackgroundLine key={work.kind} testId={`import-background-${work.kind}`}>
            {t(BACKGROUND_KEY[work.kind], { done: work.done, total: work.total })}
          </DesktopJobsBackgroundLine>
        ))}
        <DesktopJobsFilterBar
          value={filter}
          onChange={setFilter}
          labels={{
            all: t("jobs.filterAll"),
            active: t("jobs.filterActive"),
            queued: t("jobs.filterQueued"),
            completed: t("jobs.filterCompleted"),
            failed: t("jobs.filterFailed"),
          }}
        />
        {jobs === null ? (
          <DesktopJobsLoadingSkeleton testId="import-jobs-loading" />
        ) : shown.length === 0 && shownExports.length === 0 ? (
          <DesktopJobsEmpty title={t("jobs.emptyTitle")} subtitle={t("jobs.emptySubtitle")} />
        ) : (
          <>
            {shownExports.length > 0 && <ExportJobList t={t} language={language} jobs={shownExports} />}
            {shown.length > 0 && <ImportJobList t={t} language={language} jobs={shown} onReview={onReview} />}
          </>
        )}
      </div>
    </DesktopJobsSheet>
  );
}

/** The import rows, with the shared removal animation; the panel and an album's Jobs tab both list them. */
export function ImportJobList({ t, language, jobs, onReview }: { t: Translate; language: ParrotLanguage; jobs: ParrotImportJob[]; onReview: () => void }) {
  const { dismissing, scheduleDismiss } = useStaggeredDismiss();
  return (
    <ul className="flex flex-col gap-2">
      {jobs.map((job) => (
        <ImportJobItem
          key={job.id}
          t={t}
          language={language}
          job={job}
          removing={dismissing.has(job.id)}
          onReview={onReview}
          onDismiss={() => scheduleDismiss(job.id, () => void window.parrot.dismissImportJob(job.id))}
        />
      ))}
    </ul>
  );
}

function ImportJobItem({
  t,
  language,
  job,
  removing,
  onReview,
  onDismiss,
}: {
  t: Translate;
  language: ParrotLanguage;
  job: ParrotImportJob;
  removing: boolean;
  onReview: () => void;
  onDismiss: () => void;
}) {
  const { status } = job;
  const ended = importJobEnded(status);
  const first = job.sources[0] ? fileName(job.sources[0]) : "";
  const name = job.sources.length > 1 ? t("jobs.more", { name: first, n: job.sources.length - 1 }) : first;
  const started = new Date(job.startedAt).toLocaleString();
  const pill = importPill(status);
  const badge =
    status.phase === "review" && !status.running ? (
      <button type="button" className="rounded-full" onClick={onReview} data-testid="import-job-review">
        <DesktopJobStatusPill tone={pill.tone} testId="import-job-status">
          {t(pill.key)}
        </DesktopJobStatusPill>
      </button>
    ) : (
      <DesktopJobStatusPill tone={pill.tone} testId="import-job-status">
        {t(pill.key)}
      </DesktopJobStatusPill>
    );
  // Uploading, the counts are the file's; once it ended, what it added, found already there and could not import.
  const counted = ended && (status.imported > 0 || status.skipped > 0 || status.failed > 0);
  const line = ended ? null : importLine(t, language, status);
  const error = status.phase === "failed" ? (status.error === IMPORT_INTERRUPTED ? t("jobs.interrupted") : t("import.failed", { error: importErrorText(t, status.error ?? "") })) : null;
  const extra = (
    <>
      {line ? (
        <p className="mt-2 truncate text-xs text-muted-foreground" data-testid="import-job-progress">
          {line}
        </p>
      ) : null}
      {counted ? (
        <p className="mt-2 text-xs" data-testid="import-job-counts">
          {t("jobs.counts", { imported: status.imported, skipped: status.skipped, failed: status.failed })}
        </p>
      ) : null}
      {error ? (
        <p className="mt-2 text-xs text-destructive" data-testid="import-job-error">
          {error}
        </p>
      ) : null}
      {job.failures.length > 0 ? (
        <div className="mt-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{t("jobs.failedFiles")}</p>
          <ul className="mt-1 max-h-40 overflow-y-auto text-xs" data-testid="import-job-failures">
            {job.failures.map((failure) => (
              <li key={failure.file} className="py-0.5" title={failure.file}>
                <span className="font-medium">{fileName(failure.file)}</span>
                <span className="text-muted-foreground"> · {importErrorText(t, failure.error)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );

  return (
    <li data-testid="import-job" data-phase={status.phase} title={job.sources.join("\n")}>
      {ended ? (
        <DesktopCompletedJobRow
          removing={removing}
          title={name}
          meta={started}
          badge={badge}
          extra={extra}
          action={<DesktopJobActionButton kind="remove" label={t("jobs.remove")} onClick={onDismiss} disabled={removing} testId="import-job-remove" />}
        />
      ) : (
        <DesktopJobRow
          title={name}
          filename={started}
          badge={badge}
          progress={
            status.phase === "uploading" && status.bytesTotal > 0 ? (
              <DesktopJobProgress percent={Math.min(100, (status.bytesDone / status.bytesTotal) * 100)} testId="import-job-bar" />
            ) : null
          }
          extra={extra}
          action={<DesktopJobActionButton kind="cancel" label={t("jobs.cancel")} onClick={() => void window.parrot.cancelImport()} testId="import-job-cancel" />}
        />
      )}
    </li>
  );
}
