import { useEffect, useState } from "react";
import {
  DesktopCompletedJobRow,
  DesktopFailedJobDetail,
  DesktopJobActionButton,
  DesktopJobBucketHeader,
  DesktopJobFailureGroups,
  DesktopJobGroupCard,
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
  type DesktopJobFailureGroup,
  type DesktopJobFilter,
  type DesktopJobTone,
} from "@space/desktop-shell/components";
import { formatLocalizedStorage } from "@space/shared/format";
import {
  IMPORT_INTERRUPTED,
  importJobRetryable,
  type ParrotBackgroundWork,
  type ParrotImportJob,
  type ParrotImportRetry,
  type ParrotImportRow,
  type ParrotImportSong,
  type ParrotImportStatus,
  type ParrotLanguage,
} from "../../shared/ipc";
import { countText, pluralForm, type ParrotStringKey, type Translate } from "./i18n";
import { ExportJobList, exportJobMatches, useExportJobs } from "./ExportJobs";
import { useAppBusyMark } from "@space/ui/app-busy-mark";

/**
 * Why a file or an import failed, as a class the user can read (UX-JOBS-03). The importer stores the error as it came
 * (`ENOENT: no such file or directory, open '/home/…'`, a fetch error, "not an audio file Parrot imports: …"); the card
 * never shows that text, a path or a stack, only the sentence of its class.
 */
export type ImportFailureReason = "missing" | "unsupported" | "unreadable" | "network" | "conflict" | "other";

export function importFailureReason(error: string): ImportFailureReason {
  if (/version_conflict|library_db_conflict/.test(error)) return "conflict";
  if (/\bENOENT\b|no such file|ENOTDIR/i.test(error)) return "missing";
  if (/not an audio file|no audio format/i.test(error)) return "unsupported";
  if (/\b(EACCES|EPERM|EISDIR|EIO|EBUSY)\b|unreadable|permission denied/i.test(error)) return "unreadable";
  if (/fetch failed|network|socket|\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|ENETUNREACH)\b|timed? ?out|HTTP 5\d\d/i.test(error)) return "network";
  return "other";
}

/**
 * Why a whole import stopped, as the user reads it, in the Jobs panel and the bell: closing Parrot, a publish other
 * saves kept beating (the server's 409 `version_conflict`, PAR-UP-03), or the sentence of the error's class.
 */
export const importErrorPart = (error: string): { key: ParrotStringKey } => {
  if (error === IMPORT_INTERRUPTED) return { key: "jobs.interrupted" };
  const reason = importFailureReason(error);
  return { key: reason === "conflict" ? "import.conflict" : `jobs.failed.what.${reason}` };
};

/** UX-JOBS-03: the first line of a card that stopped or left files out: what happened, in plain words. */
const failedWhat = (t: Translate, job: ParrotImportJob): string => {
  if (job.status.phase !== "failed") return t("jobs.failed.whatSomeFiles");
  const error = job.status.error ?? "";
  if (error === IMPORT_INTERRUPTED) return t("jobs.failed.whatInterrupted");
  const reason = importFailureReason(error);
  return t(reason === "conflict" ? "jobs.failed.whatConflict" : `jobs.failed.what.${reason}`);
};

const REASON_ORDER: ImportFailureReason[] = ["missing", "unsupported", "unreadable", "network", "conflict", "other"];

/** The files an import left out, one group per reason ("13 files not found: …"), each with its files' names only. */
export function importFailureGroups(t: Translate, language: ParrotLanguage, failures: ParrotImportJob["failures"]): DesktopJobFailureGroup[] {
  const byReason = new Map<ImportFailureReason, string[]>();
  for (const failure of failures) {
    const reason = importFailureReason(failure.error);
    const files = byReason.get(reason);
    if (files) files.push(fileName(failure.file));
    else byReason.set(reason, [fileName(failure.file)]);
  }
  return REASON_ORDER.filter((reason) => byReason.has(reason)).map((reason) => {
    const files = byReason.get(reason)!;
    return { key: reason, label: t(`jobs.reason.${reason}.${pluralForm(language, files.length)}`, { n: files.length }), files };
  });
}

/**
 * UX-JOBS-03: what a stopped card offers and why it was last refused. `refused` is the answer of the last try
 * ("missing" until main's next list says so too), cleared when the job comes back from main changed.
 */
function useImportRetry(job: ParrotImportJob) {
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<"busy" | "missing" | null>(null);
  useEffect(() => setRefused(null), [job]);
  const missing = refused === "missing" || job.sourcesMissing === true;
  const run = async () => {
    setBusy(true);
    try {
      const answer: ParrotImportRetry | { cancelled: true } = missing
        ? await window.parrot.findImportJobFolder(job.id)
        : await window.parrot.retryImportJob(job.id);
      console.info(`[parrot-jobs] ${missing ? "find folder" : "import again"} for ${job.id}: ${JSON.stringify(answer)}`);
      if ("started" in answer && !answer.started && answer.reason !== "gone") setRefused(answer.reason);
    } catch (error) {
      console.warn(`[parrot-jobs] trying ${job.id} again failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };
  return { busy, missing, refused, run };
}

/** What an ended import added, found already there and could not import, each count in its own plural form. */
export const importCountsText = (t: Translate, language: ParrotLanguage, status: ParrotImportStatus): string =>
  [
    t(`jobs.counts.added.${pluralForm(language, status.imported)}`, { n: status.imported }),
    t(`jobs.counts.skipped.${pluralForm(language, status.skipped)}`, { n: status.skipped }),
    t(`jobs.counts.failed.${pluralForm(language, status.failed)}`, { n: status.failed }),
  ].join(" · ");

/** The import's first source, then "and 2 more" for the others. */
export const importNameText = (t: Translate, language: ParrotLanguage, first: string, others: number): string =>
  others > 0 ? t(`jobs.more.${pluralForm(language, others)}`, { name: first, n: others }) : first;

/** One line for where an import stands (PAR-UP-04): reading, waiting for the review, uploading, adding, done, failed or stopped. */
export function importLine(t: Translate, language: ParrotLanguage, status: ParrotImportStatus): string | null {
  switch (status.phase) {
    case "idle":
      return null;
    case "scanning":
      return status.total > 0
        ? t(`import.scanningCount.${pluralForm(language, status.total)}`, { done: status.done, total: status.total })
        : t("import.scanning");
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
      return t(importErrorPart(status.error ?? "").key);
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

/** The album an import touched, as its card shows it: the title and the small cover. */
export type ImportJobAlbum = { title: string; cover: string | null };

/**
 * UX-JOBS-01 / UX-JOBS-02 / PAR-UP-04: the top bar's Jobs item in Parrot, the same flask, side panel and job cards as
 * Badger's, listing this account's imports (running, ready to review, finished, stopped, failed) with what each added,
 * found already there, or could not import and why. Each import is a group card like a Badger title (cover, title,
 * count, pill, X or bin, chevron) opening onto its row. A running import has the X (it stops the uploads left; songs
 * already in stay), an ended one the bin; one ready to review opens the review on a click. `open` lets a failed job's
 * notice lead here (UX-NOTICE-10).
 */
export function ImportJobs({
  t,
  language,
  onReview,
  albumFor,
  open,
  onOpenChange,
}: {
  t: Translate;
  language: ParrotLanguage;
  onReview: () => void;
  albumFor: (albumId: string) => ImportJobAlbum | undefined;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const jobs = useImportJobs();
  const background = useBackgroundWork();
  const [filter, setFilter] = useState<DesktopJobFilter>("all");

  const list = jobs ?? [];
  const shown = list.filter((job) => importJobMatches(job, filter));
  const exports = useExportJobs() ?? [];
  const shownExports = exports.filter((job) => exportJobMatches(job, filter));
  const activeCount = list.filter((job) => job.status.running).length + exports.filter((job) => job.phase === "running").length;
  // REL-UPD-08: the update modal waits while an import or an export runs (a restart would cut it).
  useAppBusyMark(activeCount > 0);

  return (
    <DesktopJobsSheet
      title={t("jobs.title")}
      subtitle={t("jobs.subtitle")}
      activeCount={activeCount}
      jobCount={list.length + exports.length}
      triggerClassName={desktopTopNavIconActionClassName}
      testId="nav-jobs"
      open={open}
      onOpenChange={onOpenChange}
    >
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
            {shown.length > 0 && <ImportJobList t={t} language={language} jobs={shown} onReview={onReview} variant="card" albumFor={albumFor} />}
          </>
        )}
      </div>
    </DesktopJobsSheet>
  );
}

/**
 * The imports, with the shared removal animation. The panel draws each as a group card (`card`, like a Badger title);
 * an album's Jobs tab draws the rows alone (`row`, like a Badger title's Jobs tab).
 */
export function ImportJobList({
  t,
  language,
  jobs,
  onReview,
  variant,
  albumFor,
}: {
  t: Translate;
  language: ParrotLanguage;
  jobs: ParrotImportJob[];
  onReview: () => void;
  variant: "card" | "row";
  albumFor?: (albumId: string) => ImportJobAlbum | undefined;
}) {
  const { dismissing, scheduleDismiss } = useStaggeredDismiss();
  return (
    <ul className={variant === "card" ? "flex flex-col gap-3" : "flex flex-col gap-2"}>
      {jobs.map((job) => (
        <ImportJobItem
          key={job.id}
          t={t}
          language={language}
          job={job}
          removing={dismissing.has(job.id)}
          onReview={onReview}
          onDismiss={() => scheduleDismiss(job.id, () => void window.parrot.dismissImportJob(job.id))}
          variant={variant}
          album={variant === "card" && job.albumIds?.length === 1 ? albumFor?.(job.albumIds[0]) : undefined}
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
  variant,
  album,
}: {
  t: Translate;
  language: ParrotLanguage;
  job: ParrotImportJob;
  removing: boolean;
  onReview: () => void;
  onDismiss: () => void;
  variant: "card" | "row";
  album: ImportJobAlbum | undefined;
}) {
  const { status } = job;
  const ended = importJobEnded(status);
  const first = job.sources[0] ? fileName(job.sources[0]) : "";
  const name = importNameText(t, language, first, Math.max(0, job.sources.length - 1));
  const started = new Date(job.startedAt).toLocaleString(language);
  const pill = importPill(status);
  const pillNode = (
    <DesktopJobStatusPill tone={pill.tone} testId="import-job-status">
      {t(pill.key)}
    </DesktopJobStatusPill>
  );
  const badge =
    status.phase === "review" && !status.running ? (
      <button
        type="button"
        className="rounded-full"
        onClick={(event) => {
          // The card's header opens and closes on a click; the pill opens the review instead.
          event.stopPropagation();
          onReview();
        }}
        data-testid="import-job-review"
      >
        {pillNode}
      </button>
    ) : (
      pillNode
    );
  // Uploading, the counts are the file's; once it ended, what it added, found already there and could not import.
  const counted = ended && (status.imported > 0 || status.skipped > 0 || status.failed > 0);
  const counts = counted ? importCountsText(t, language, status) : null;
  const line = ended ? null : importLine(t, language, status);
  const retryable = importJobRetryable(job);
  const retry = useImportRetry(job);
  // UX-JOBS-03: a card with something to do is open without a click, as a Badger title with a failed job is; so is a
  // running one, whose progress is the point. The chevron still closes it.
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? (retryable || !ended);
  const action = ended ? (
    <DesktopJobActionButton kind="remove" label={t("jobs.remove")} onClick={onDismiss} disabled={removing} testId="import-job-remove" />
  ) : (
    <DesktopJobActionButton kind="cancel" label={t("jobs.cancel")} onClick={() => void window.parrot.cancelImport()} testId="import-job-cancel" />
  );
  const progress =
    status.phase === "uploading" && status.bytesTotal > 0 ? (
      <DesktopJobProgress percent={Math.min(100, (status.bytesDone / status.bytesTotal) * 100)} testId="import-job-bar" />
    ) : null;
  const extra = (
    <>
      {line ? (
        <p className="mt-2 truncate text-xs text-muted-foreground" data-testid="import-job-progress">
          {line}
        </p>
      ) : null}
      {counts && variant === "row" ? (
        <p className="mt-2 text-xs" data-testid="import-job-counts">
          {counts}
        </p>
      ) : null}
      {retryable ? (
        <DesktopFailedJobDetail
          testId="import-job-failed"
          what={status.phase === "failed" ? <span data-testid="import-job-error">{failedWhat(t, job)}</span> : failedWhat(t, job)}
          meaning={t(retry.refused === "busy" ? "jobs.failed.meaningBusy" : retry.missing ? "jobs.failed.meaningMissing" : "jobs.failed.meaningRetry")}
          action={{
            label: t(retry.missing ? "jobs.failed.actionFindFolder" : "jobs.failed.actionImportAgain"),
            onClick: () => void retry.run(),
            busy: retry.busy,
            testId: "import-job-retry",
          }}
        />
      ) : null}
      <DesktopJobFailureGroups groups={importFailureGroups(t, language, job.failures)} filesLabel={t("jobs.reason.files")} testId="import-job-failures" />
    </>
  );

  if (variant === "row") {
    return (
      <li data-testid="import-job" data-phase={status.phase}>
        {ended ? (
          <DesktopCompletedJobRow removing={removing} title={name} meta={started} badge={badge} extra={extra} action={action} />
        ) : (
          <DesktopJobRow title={name} filename={started} badge={badge} progress={progress} extra={extra} action={action} />
        )}
      </li>
    );
  }
  return (
    <li data-testid="import-job" data-phase={status.phase}>
      <DesktopJobGroupCard
        removing={removing}
        expanded={expanded}
        onToggle={() => setOpen(!expanded)}
        artwork={album?.cover ? <img src={album.cover} alt="" className="h-full w-full object-cover" /> : null}
        title={album?.title ?? name}
        countLabel={counts ?? (status.total > 0 ? countText(language, t, "song", status.total) : started)}
        badge={badge}
        action={action}
        testId="import-job-card"
      >
        {ended ? (
          <DesktopCompletedJobRow title={started} filename={name} badge={null} extra={extra} action={null} />
        ) : (
          <DesktopJobRow title={started} filename={name} badge={null} progress={progress} extra={extra} action={null} />
        )}
        {job.songs && job.songs.length > 0 ? <ImportSongBuckets t={t} language={language} songs={job.songs} running={status.running} /> : null}
      </DesktopJobGroupCard>
    </li>
  );
}

/** The steps a song's jobs go through (PAR-UP-13), each with its words and its pill colour. */
const SONG_STAGES: Record<string, { key: ParrotStringKey; tone: DesktopJobTone }> = {
  probe: { key: "jobs.stage.probe", tone: "blue" },
  identify: { key: "jobs.stage.identify", tone: "blue" },
  extract: { key: "jobs.stage.extract", tone: "blue" },
  transcode: { key: "jobs.stage.transcode", tone: "purple" },
  upload: { key: "jobs.stage.upload", tone: "cyan" },
  commit: { key: "jobs.stage.commit", tone: "cyan" },
};

/** A row still to run or running: its X stops it. An interrupted row runs again once the import resumes. */
const songRowLive = (row: ParrotImportRow) => row.status === "queued" || row.status === "running" || row.status === "interrupted";

/** UX-JOBS-02: a song row's pill, in Badger's words: waiting with its place in line, the step it is at, or how it ended. */
const songRowPill = (t: Translate, row: ParrotImportRow): { text: string; tone: DesktopJobTone } => {
  switch (row.status) {
    case "running": {
      const stage = SONG_STAGES[row.stage];
      return stage ? { text: t(stage.key), tone: stage.tone } : { text: t("jobs.status.uploading"), tone: "cyan" };
    }
    case "succeeded":
      return { text: t("jobs.status.done"), tone: "emerald" };
    case "failed":
      return { text: t("jobs.status.failed"), tone: "destructive" };
    case "cancelled":
      return { text: t("jobs.status.cancelled"), tone: "neutral" };
    default:
      return { text: row.placeInLine !== null ? t("jobs.song.waitingInLine", { n: row.placeInLine }) : t("jobs.status.queued"), tone: "neutral" };
  }
};

/** Which row speaks for its song on the bucket's pill: the one at work, then a failure, then the one waiting. */
const SONG_ROW_WEIGHT: Record<ParrotImportRow["status"], number> = { running: 5, failed: 4, interrupted: 3, queued: 3, cancelled: 2, succeeded: 1 };

const songRows = (song: ParrotImportSong): { kind: "source" | "light"; row: ParrotImportRow }[] =>
  song.light ? [{ kind: "source", row: song.source }, { kind: "light", row: song.light }] : [{ kind: "source", row: song.source }];

/**
 * UX-JOBS-02 / PAR-UP-13: a running import's songs, one bucket each (Badger's episode sub-group) holding the song's
 * own job and its light copy, each with its pill, progress, X and "Try again". A song at work or that failed is open;
 * one done or still waiting stays closed, its pill on the bucket. "Try again" and the X act only while the import runs.
 */
function ImportSongBuckets({ t, language, songs, running }: { t: Translate; language: ParrotLanguage; songs: ParrotImportSong[]; running: boolean }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  return (
    <div className="mt-2" data-testid="import-songs">
      {songs.map((song, index) => {
        const rows = songRows(song);
        const lead = rows.reduce((best, entry) => (SONG_ROW_WEIGHT[entry.row.status] > SONG_ROW_WEIGHT[best.row.status] ? entry : best));
        const leadPill = songRowPill(t, lead.row);
        const expanded = open[song.file] ?? rows.some(({ row }) => row.status === "running" || row.status === "failed");
        return (
          <div key={song.file} className={index > 0 ? "border-t border-border/50" : undefined} data-testid="import-song">
            <DesktopJobBucketHeader
              expanded={expanded}
              onToggle={() => setOpen((current) => ({ ...current, [song.file]: !expanded }))}
              title={fileName(song.file)}
              countLabel={t(`jobs.song.jobs.${pluralForm(language, rows.length)}`, { n: rows.length })}
              badge={
                <DesktopJobStatusPill tone={leadPill.tone} testId="import-song-badge">
                  {leadPill.text}
                </DesktopJobStatusPill>
              }
            />
            {expanded ? (
              <div className="space-y-3 pb-2 pl-5">
                {rows.map(({ kind, row }) => (
                  <ImportSongRow key={row.jobId} t={t} kind={kind} row={row} running={running} />
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function ImportSongRow({ t, kind, row, running }: { t: Translate; kind: "source" | "light"; row: ParrotImportRow; running: boolean }) {
  const [busy, setBusy] = useState(false);
  const pill = songRowPill(t, row);
  const act = async (what: "retry" | "cancel") => {
    setBusy(true);
    try {
      const done = what === "retry" ? await window.parrot.retryImportSong(row.jobId) : await window.parrot.cancelImportSong(row.jobId);
      console.info(`[parrot-jobs] ${what} song job ${row.jobId}: ${done}`);
    } catch (error) {
      console.warn(`[parrot-jobs] ${what} song job ${row.jobId} failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };
  const ended = row.status === "failed" || row.status === "cancelled";
  const detail =
    ended && (row.status === "failed" || running) ? (
      <DesktopFailedJobDetail
        testId="import-song-failed"
        what={row.status === "failed" ? t(`jobs.reason.${importFailureReason(row.error ?? "")}.one`, { n: 1 }) : t("jobs.status.cancelled")}
        meaning={running ? t("jobs.song.retryMeaning") : t("jobs.failed.meaningRetry")}
        action={running ? { label: t("jobs.song.retry"), onClick: () => void act("retry"), busy, testId: "import-song-retry" } : undefined}
      />
    ) : null;
  return (
    <div data-testid="import-song-row" data-kind={kind} data-status={row.status}>
      <DesktopJobRow
        title={t(kind === "source" ? "jobs.song.source" : "jobs.song.light")}
        badge={
          <DesktopJobStatusPill tone={pill.tone} testId="import-song-status">
            {pill.text}
          </DesktopJobStatusPill>
        }
        progress={row.status === "running" && row.progressPct > 0 ? <DesktopJobProgress percent={row.progressPct} testId="import-song-bar" /> : null}
        extra={detail}
        action={
          running && songRowLive(row) ? (
            <DesktopJobActionButton kind="cancel" label={t("jobs.song.cancel")} onClick={() => void act("cancel")} disabled={busy} testId="import-song-cancel" />
          ) : null
        }
      />
    </div>
  );
}
