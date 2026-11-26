import { toast, type NoticeToastOptions } from "@space/ui";
import { keptInHistory, type JobOutcome, type Notice, type NoticeAction, type NoticeKind, type NoticeLevel, type NoticePart, type NoticeScope } from "@space/notify-core/kinds";
import type { HistoryEntry, NoticeHistory } from "@space/notify-core/history";
import { partText, titleText, type Translate } from "@space/notify-core/texts";

export type NotifyOptions = {
  /** Text, or a text key with its values so the history follows a language change (UX-NOTICE-13). */
  title?: NoticePart;
  message: NoticePart;
  level?: NoticeLevel;
  /**
   * One key per message about one thing (UX-NOTICE-11): a repeat replaces the toast on screen and its history entry.
   * Default: the level, title and message, so the same message said again replaces itself.
   */
  key?: string;
  /** Default: `confirmation` for a success, `headsUp` for the others; `job` when `outcome` is given. */
  kind?: NoticeKind;
  outcome?: JobOutcome;
  scope?: NoticeScope;
  /** A button that leads somewhere (`openTarget` follows it); it still works from the history entry. */
  action?: NoticeAction;
  /** If true, show the toast but never keep it in the history. */
  ephemeral?: boolean;
  /** Sonner options (a button that runs code, a description); the time on screen is the kind's (UX-NOTICE-03). */
  toastOptions?: Omit<NoticeToastOptions, "id" | "kind" | "outcome">;
};

/** Extra options of the level shortcuts (`notifyError(message, title, { key })`). */
export type NotifyLevelOptions = Omit<NotifyOptions, "title" | "message" | "level">;

export type NotifyBundle = {
  /** Shows the toast and keeps the notice in the history when its kind is kept (UX-NOTICE-10); returns that entry. */
  notify: (opts: NotifyOptions) => HistoryEntry | null;
  notifyError: (message: NoticePart, title?: NoticePart, opts?: NotifyLevelOptions) => HistoryEntry | null;
  notifyWarning: (message: NoticePart, title?: NoticePart, opts?: NotifyLevelOptions) => HistoryEntry | null;
  notifySuccess: (message: NoticePart, title?: NoticePart, opts?: NotifyLevelOptions) => HistoryEntry | null;
};

export type NotifyDeps = {
  /** `null` before sign-in: the toast still shows. */
  history: NoticeHistory | null;
  /** Translates `notify.*` and the app's own keys in the language of the moment. */
  t: Translate;
  /** Follows an action's or entry's target (a route). */
  openTarget?: (target: string) => void;
};

const partKey = (part: NoticePart | undefined) => (part === undefined ? "" : typeof part === "string" ? part : `${part.key}${part.vars ? JSON.stringify(part.vars) : ""}`);

/** The default key: the same level, title and message are the same notice. */
export const noticeKey = (level: NoticeLevel, title: NoticePart | undefined, message: NoticePart): string =>
  `${level}:${partKey(title)}:${partKey(message)}`;

const showToast = (level: NoticeLevel, text: string, options: NoticeToastOptions) => {
  if (level === "error") return toast.error(text, options);
  if (level === "warning") return toast.warning(text, options);
  if (level === "success") return toast.success(text, options);
  return toast(text, options);
};

export function createNotify({ history, t, openTarget }: NotifyDeps): NotifyBundle {
  const notify: NotifyBundle["notify"] = ({ title, message, level = "info", key, kind, outcome, scope, action, ephemeral, toastOptions }) => {
    if (outcome === "failed" && level === "info") level = "error";
    const notice: Notice = {
      key: key ?? noticeKey(level, title, message),
      kind: kind ?? (outcome ? "job" : level === "success" ? "confirmation" : "headsUp"),
      level,
    };
    if (title !== undefined) notice.title = title;
    if (message !== "") notice.message = message;
    if (outcome) notice.outcome = outcome;
    if (scope) notice.scope = scope;
    if (action) notice.action = action;
    // The toast says the message (the computers' look Chris likes); a notice without one says its title.
    const text = message === "" ? titleText(t, notice) : partText(t, message);
    const options: NoticeToastOptions = { ...toastOptions, id: notice.key, kind: notice.kind, outcome };
    // A button that runs the caller's code wins on screen; `action` then serves the history entry.
    if (action && openTarget && !toastOptions?.action) options.action = { label: partText(t, action.label), onClick: () => openTarget(action.target) };
    showToast(level, text, options);
    if (ephemeral || !history || !keptInHistory(notice)) return null;
    return history.record(notice);
  };

  return {
    notify,
    notifyError: (message, title, opts) => notify({ ...opts, title, message, level: "error" }),
    notifyWarning: (message, title, opts) => notify({ ...opts, title, message, level: "warning" }),
    notifySuccess: (message, title, opts) => notify({ ...opts, title, message, level: "success" }),
  };
}
