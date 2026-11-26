/**
 * UX-NOTICE-06: a job that ends while the app is hidden (minimised, closed to the tray) shows one system
 * notification; clicking it brings the window back with Jobs open. On by default; a setting turns it off.
 * Electron-free: each app hands in its window state, its language and the system notification.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { notifyTexts, type NotifyLanguage } from "@space/notify-core/texts";
import { HIDDEN_JOB_NOTICE_CHANNELS } from "./hiddenJobNoticesBridge";

export { HIDDEN_JOB_NOTICE_CHANNELS };

export type HiddenJobKind = "import" | "download" | "export" | "job";
export type HiddenJobEnd = { kind: HiddenJobKind; outcome: "done" | "failed"; name?: string | null };
export type SystemNotice = { title: string; body: string };

/** The notification's words, from the shared notice texts (title: what ended; body: the job's file or title). */
export const hiddenJobNoticeText = (language: NotifyLanguage, end: HiddenJobEnd): SystemNotice => {
  const job = notifyTexts[language].job;
  const failed = end.outcome === "failed";
  const title =
    end.kind === "import"
      ? failed ? job.importFailed : job.importDone
      : end.kind === "download"
        ? failed ? job.downloadFailed : job.downloadDone
        : failed ? job.jobFailed : job.jobDone;
  return { title, body: end.name?.trim() ?? "" };
};

const readEnabled = (file: string): boolean => {
  try {
    const stored = JSON.parse(readFileSync(file, "utf8")) as { hiddenJobs?: unknown };
    return stored.hiddenJobs !== false;
  } catch {
    return true;
  }
};

export type HiddenJobNoticesDeps = {
  /** userData/system-notifications.json */
  file: string;
  /** True when nobody sees the window: none, destroyed, hidden in the tray or minimised (and nothing plays over it). */
  isWindowHidden: () => boolean;
  language: () => NotifyLanguage;
  /** Shows the system notification; `onClick` runs when the user clicks it. */
  show: (notice: SystemNotice & { onClick: () => void }) => void;
  /** Brings the window back and opens Jobs. */
  openJobs: () => void;
  log?: (line: string) => void;
};

export type HiddenJobNotices = {
  enabled: () => boolean;
  setEnabled: (value: boolean) => boolean;
  /** Returns true when a system notification was shown. */
  jobEnded: (end: HiddenJobEnd) => boolean;
};

export const createHiddenJobNotices = (deps: HiddenJobNoticesDeps): HiddenJobNotices => {
  let enabled = readEnabled(deps.file);
  return {
    enabled: () => enabled,
    setEnabled: (value) => {
      enabled = value;
      try {
        writeFileSync(deps.file, JSON.stringify({ hiddenJobs: value }));
      } catch (error) {
        deps.log?.(`[notify] hidden-job setting not saved: ${error instanceof Error ? error.message : String(error)}`);
      }
      return enabled;
    },
    jobEnded: (end) => {
      if (!enabled || !deps.isWindowHidden()) return false;
      const notice = hiddenJobNoticeText(deps.language(), end);
      deps.log?.(`[notify] ${end.kind} ${end.outcome} while hidden: system notification shown`);
      deps.show({ ...notice, onClick: deps.openJobs });
      return true;
    },
  };
};

/** The Electron `Notification` class, as far as this module needs it. */
export type NotificationClass = new (options: { title: string; body: string }) => {
  on(event: "click", listener: () => void): unknown;
  on(event: "close", listener: () => void): unknown;
  show: () => void;
};

/**
 * The real system notification; with `SF_TEST_NOTIFICATION_SINK` set (a file path) each notice is appended there
 * as one JSON line instead, so e2e runs can see it. Shown notifications are held until clicked or closed: a
 * collected one loses its click handler.
 */
export const systemNoticeShower = (Notification: NotificationClass, sinkPath = process.env.SF_TEST_NOTIFICATION_SINK) => {
  const live = new Set<object>();
  return (notice: SystemNotice & { onClick: () => void }): void => {
    if (sinkPath) {
      appendFileSync(sinkPath, `${JSON.stringify({ title: notice.title, body: notice.body, source: "hidden-job" })}\n`);
      return;
    }
    const shown = new Notification({ title: notice.title, body: notice.body });
    live.add(shown);
    shown.on("click", () => {
      live.delete(shown);
      notice.onClick();
    });
    shown.on("close", () => live.delete(shown));
    shown.show();
  };
};

/**
 * Opening Jobs from a click: the window may be recreated by the click (Badger destroys it in the tray), so main
 * keeps the request until a renderer takes it, on mount or when told by `HIDDEN_JOB_NOTICE_CHANNELS.openJobs`.
 */
export const createOpenJobsRequest = (send: () => void) => {
  let pending = false;
  return {
    request: () => {
      pending = true;
      send();
    },
    take: (): boolean => {
      const was = pending;
      pending = false;
      return was;
    },
  };
};

export type HiddenJobNoticesIpc = {
  handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => void;
};

export const registerHiddenJobNoticesIpc = (
  ipc: HiddenJobNoticesIpc,
  notices: HiddenJobNotices,
  openJobs: { take: () => boolean },
): void => {
  ipc.handle(HIDDEN_JOB_NOTICE_CHANNELS.getSetting, () => notices.enabled());
  ipc.handle(HIDDEN_JOB_NOTICE_CHANNELS.setSetting, (_event, value) => notices.setEnabled(value !== false));
  ipc.handle(HIDDEN_JOB_NOTICE_CHANNELS.takeOpenJobs, () => openJobs.take());
};
