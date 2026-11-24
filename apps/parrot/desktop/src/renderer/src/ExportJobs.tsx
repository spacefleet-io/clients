// "Download everything" in the window (OFFL-FILE-01, ACCT-EXPORT-01, Chris 2026-11-21): Settings' row that starts it,
// its rows in the Jobs panel, and the tray line once it ends. The files land as plain music files in a folder the user
// picks; Parrot does not track them afterwards. It is the only export: each song, album or playlist has one offline
// action, "Save offline", and no "Download file".
import { useEffect, useRef, useState } from "react";
import { HardDriveDownload } from "lucide-react";
import { Button } from "@space/ui";
import { ParrotSettingsRow as Row } from "@space/ui/parrot/screens";
import {
  DesktopCompletedJobRow,
  DesktopJobActionButton,
  DesktopJobProgress,
  DesktopJobRow,
  DesktopJobStatusPill,
  useStaggeredDismiss,
  type DesktopJobFilter,
  type DesktopJobTone,
} from "@space/desktop-shell/components";
import { formatLocalizedStorage } from "@space/shared/format";
import { EXPORT_FOLDER_MISSING, EXPORT_NO_SPACE, type ParrotExportJob, type ParrotLanguage } from "../../shared/ipc";
import { countText, pluralForm, translator, type ParrotStringKey, type Translate } from "./i18n";
import type { NotificationPart } from "./notificationText";

/** Puts a line in the tray (Library binds it to its notification store). */
export type ExportNotify = (level: "info" | "success" | "error", title: NotificationPart, message: NotificationPart) => void;

const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

export const exportJobEnded = (job: ParrotExportJob) => job.phase === "done" || job.phase === "failed" || job.phase === "cancelled";

/** Why an export stopped, as the user reads it: a full disk and a folder gone are said in words. */
export const exportErrorPart = (error: string | null): NotificationPart =>
  error === EXPORT_NO_SPACE ? { key: "export.job.noSpace" } : error === EXPORT_FOLDER_MISSING ? { key: "export.job.folderMissing" } : { key: "export.job.failed", vars: { error: error ?? "" } };

const partText = (t: Translate, part: NotificationPart) => (typeof part === "string" ? part : t(part.key, part.vars));

/** Which filter chips list an export (UX-JOBS-01). */
export function exportJobMatches(job: ParrotExportJob, filter: DesktopJobFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "active":
      return job.phase === "running";
    case "queued":
      return job.phase === "queued";
    case "completed":
      return job.phase === "done" || job.phase === "cancelled";
    case "failed":
      return job.phase === "failed" || job.failures.length > 0;
  }
}

/** This account's exports, live; null until the first answer. */
export function useExportJobs(): ParrotExportJob[] | null {
  const [jobs, setJobs] = useState<ParrotExportJob[] | null>(null);
  useEffect(() => {
    let live = true;
    void window.parrot.getExportJobs().then((list) => {
      if (live) setJobs(list);
    });
    const off = window.parrot.onExportJobs(setJobs);
    return () => {
      live = false;
      off();
    };
  }, []);
  return jobs;
}

/** "1 song saved in Music", "2 songs saved in Music": the language's own plural form (the tray and the Jobs row). */
const doneText = (language: ParrotLanguage, job: ParrotExportJob): NotificationPart => ({
  key: "export.job.done",
  vars: { songs: countText(language, translator(language), "song", job.doneSongs), folder: folderName(job.dest) },
});

/** One tray line when an export ends: saved, stopped by a full disk, or failed (UX-JOBS-01). */
export function useExportNotifications(language: ParrotLanguage, notify: ExportNotify): void {
  const phases = useRef<Map<string, ParrotExportJob["phase"]> | null>(null);
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const languageRef = useRef(language);
  languageRef.current = language;
  useEffect(() => {
    const seen = (jobs: ParrotExportJob[]) => {
      const before = phases.current;
      phases.current = new Map(jobs.map((job) => [job.id, job.phase]));
      if (!before) return;
      for (const job of jobs) {
        const was = before.get(job.id);
        if (!was || exportJobEnded({ ...job, phase: was }) || !exportJobEnded(job)) continue;
        if (job.phase === "done") {
          notifyRef.current("success", { key: "export.notify.done" }, doneText(languageRef.current, job));
        } else if (job.phase === "failed") {
          notifyRef.current("error", { key: "export.notify.failed" }, exportErrorPart(job.error));
        }
      }
    };
    let live = true;
    void window.parrot.getExportJobs().then((list) => {
      if (live && !phases.current) seen(list);
    });
    const off = window.parrot.onExportJobs(seen);
    return () => {
      live = false;
      off();
    };
  }, []);
}

const exportPill = (job: ParrotExportJob): { key: ParrotStringKey; tone: DesktopJobTone } => {
  switch (job.phase) {
    case "queued":
      return { key: "jobs.status.queued", tone: "amber" };
    case "running":
      return { key: "jobs.status.downloading", tone: "cyan" };
    case "done":
      return { key: "jobs.status.done", tone: "emerald" };
    case "failed":
      return { key: "jobs.status.failed", tone: "destructive" };
    case "cancelled":
      return { key: "jobs.status.cancelled", tone: "neutral" };
  }
};

/** The export rows of the Jobs panel, with the shared removal animation. */
export function ExportJobList({ t, language, jobs }: { t: Translate; language: ParrotLanguage; jobs: ParrotExportJob[] }) {
  const { dismissing, scheduleDismiss } = useStaggeredDismiss();
  return (
    <ul className="flex flex-col gap-2" data-testid="export-jobs">
      {jobs.map((job) => (
        <ExportJobItem
          key={job.id}
          t={t}
          language={language}
          job={job}
          removing={dismissing.has(job.id)}
          onDismiss={() => scheduleDismiss(job.id, () => void window.parrot.dismissExportJob(job.id))}
        />
      ))}
    </ul>
  );
}

function ExportJobItem({ t, language, job, removing, onDismiss }: { t: Translate; language: ParrotLanguage; job: ParrotExportJob; removing: boolean; onDismiss: () => void }) {
  const pill = exportPill(job);
  const title = t("export.job.title", { name: t("export.job.all") });
  const meta = `${new Date(job.startedAt).toLocaleString()} · ${folderName(job.dest)}`;
  const badge = (
    <DesktopJobStatusPill tone={pill.tone} testId="export-job-status">
      {t(pill.key)}
    </DesktopJobStatusPill>
  );
  const extra = (
    <>
      {job.phase === "running" || job.phase === "queued" ? (
        <p className="mt-2 truncate text-xs text-muted-foreground" data-testid="export-job-progress">
          {t(`export.job.progress.${pluralForm(language, job.totalSongs)}`, {
            done: job.doneSongs,
            total: job.totalSongs,
            doneSize: formatLocalizedStorage(job.doneBytes, language),
            totalSize: formatLocalizedStorage(job.totalBytes, language),
          })}
        </p>
      ) : null}
      {job.phase === "done" ? (
        <p className="mt-2 text-xs" data-testid="export-job-done">
          {partText(t, doneText(language, job))}
        </p>
      ) : null}
      {job.phase === "failed" ? (
        <p className="mt-2 text-xs text-destructive" data-testid="export-job-error">
          {partText(t, exportErrorPart(job.error))}
        </p>
      ) : null}
      {job.failures.length > 0 ? (
        <div className="mt-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{t("export.job.failedSongs")}</p>
          <ul className="mt-1 max-h-40 overflow-y-auto text-xs" data-testid="export-job-failures">
            {job.failures.map((failure, index) => (
              <li key={`${failure.title}-${index}`} className="py-0.5">
                <span className="font-medium">{failure.title}</span>
                <span className="text-muted-foreground"> · {failure.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
  return (
    <li data-testid="export-job" data-phase={job.phase} title={job.dest}>
      {exportJobEnded(job) ? (
        <DesktopCompletedJobRow
          removing={removing}
          title={title}
          meta={meta}
          badge={badge}
          extra={extra}
          action={<DesktopJobActionButton kind="remove" label={t("jobs.remove")} onClick={onDismiss} disabled={removing} testId="export-job-remove" />}
        />
      ) : (
        <DesktopJobRow
          title={title}
          filename={meta}
          badge={badge}
          progress={job.totalBytes > 0 ? <DesktopJobProgress percent={Math.min(100, (job.doneBytes / job.totalBytes) * 100)} testId="export-job-bar" /> : null}
          extra={extra}
          action={<DesktopJobActionButton kind="cancel" label={t("jobs.cancel")} onClick={() => void window.parrot.cancelExport(job.id)} testId="export-job-cancel" />}
        />
      )}
    </li>
  );
}

/**
 * Settings › Account's "Download everything" (ACCT-EXPORT-01): one button; it says how many songs and how much room
 * they take, then asks for the folder. Always the highest stored quality, never a question about it (OFFL-QUAL-01).
 */
export function DownloadEverythingRow({ t, language }: { t: Translate; language: ParrotLanguage }) {
  const [asking, setAsking] = useState<{ songs: number; bytes: number } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ask = async () => {
    setNote(null);
    const preview = await window.parrot.previewExport();
    if (preview.songs === 0) setNote(t("export.everything.empty"));
    else setAsking(preview);
  };
  const confirm = async () => {
    setBusy(true);
    try {
      const result = await window.parrot.exportMusic();
      if (result.ok) {
        setAsking(null);
        setNote(t("export.startedBody"));
      } else if (result.reason === "no-space") {
        setNote(t("export.noSpace", { needed: formatLocalizedStorage(result.neededBytes, language), free: formatLocalizedStorage(result.freeBytes, language) }));
      } else if (result.reason === "empty") {
        setAsking(null);
        setNote(t("export.everything.empty"));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Row
      title={t("export.everything.title")}
      body={
        <>
          {t("export.everything.body")}
          {asking ? (
            <span className="mt-2 block font-medium text-foreground" data-testid="export-everything-confirm">
              {t("export.everything.confirm", { songs: countText(language, t, "song", asking.songs), size: formatLocalizedStorage(asking.bytes, language) })}
            </span>
          ) : null}
          {note ? (
            <span className="mt-2 block" data-testid="export-everything-note">
              {note}
            </span>
          ) : null}
        </>
      }
    >
      {asking ? (
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => setAsking(null)} disabled={busy} data-testid="export-everything-cancel">
            {t("jobs.cancel")}
          </Button>
          <Button onClick={() => void confirm()} disabled={busy} data-testid="export-everything-choose">
            {t("export.everything.choose")}
          </Button>
        </div>
      ) : (
        <Button variant="outline" onClick={() => void ask()} data-testid="export-everything">
          <HardDriveDownload className="mr-2 size-4" aria-hidden />
          {t("export.everything.button")}
        </Button>
      )}
    </Row>
  );
}
