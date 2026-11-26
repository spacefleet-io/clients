import type { IpcMain } from "electron";
import { createDesktopFeedbackSender, type DesktopFeedbackBody } from "@space/error-report/desktop-feedback";
import type { ErrorLog } from "@space/error-report/error-log";
import { RECENT_FAILED_REQUEST_IDS_MAX, recentFailedRequestIds } from "@space/shared/apiFailure";

export const FEEDBACK_SEND_CHANNEL = "sf-feedback-send";

/**
 * What Settings > Help & feedback asks main to send: the form's message and tick, plus the request ids of the
 * window's own last failed API calls (Badger's window calls the API itself, so main's list alone would miss them).
 */
export type FeedbackIpcInput = { message: string; attachLog: boolean; requestIds?: string[] };

/** UX-SUP-07: the window's ids then main's, each once (its latest place), at most the newest {@link RECENT_FAILED_REQUEST_IDS_MAX}. */
export const mergeRequestIds = (windowIds: readonly string[], mainIds: readonly string[]): string[] => {
  const out: string[] = [];
  for (const id of [...windowIds, ...mainIds]) {
    const known = out.indexOf(id);
    if (known !== -1) out.splice(known, 1);
    out.push(id);
  }
  return out.slice(-RECENT_FAILED_REQUEST_IDS_MAX);
};

/**
 * A warning or error the window printed, recorded into the error log a feedback message can carry (UX-SUP-05); the
 * log scrubs it as it records it (REL-LOG-06). Other levels are not kept.
 */
export const recordRendererConsole = (errorLog: ErrorLog, level: string, message: string): void => {
  if (level !== "error" && level !== "warning") return;
  errorLog.record(level === "error" ? "error" : "warn", "renderer", message);
};

/**
 * "Send feedback" for Badger desktop (UX-SUP-05): main holds the session the window signed in with and sends the
 * message to `POST /feedback` through the sender Parrot desktop uses too (`@space/error-report`, REL-FAM-03), with the
 * error log only when the user ticked it (UX-SUP-02) and the request ids of the last failed calls (UX-SUP-07).
 */
export const registerFeedbackIpc = (
  ipc: Pick<IpcMain, "handle">,
  deps: {
    errorLog: ErrorLog;
    appVersion: string;
    /** "linux 6.8.0"; the API keeps 32 characters. */
    platform: string;
    send: (token: string, body: DesktopFeedbackBody) => Promise<unknown>;
    log: (line: string) => void;
    /** Main's own failed calls; `recentFailedRequestIds` of `@space/shared/apiFailure` by default. */
    mainRequestIds?: () => string[];
  },
) => {
  let token: string | null = null;
  let windowRequestIds: string[] = [];
  const mainRequestIds = deps.mainRequestIds ?? recentFailedRequestIds;
  const send = createDesktopFeedbackSender({
    app: "badger-desktop",
    token: () => token,
    errorLog: deps.errorLog,
    appVersion: deps.appVersion,
    platform: deps.platform,
    requestIds: () => mergeRequestIds(windowRequestIds, mainRequestIds()),
    send: deps.send,
    log: deps.log,
    fail: (line) => {
      deps.log(line);
      deps.errorLog.record("error", "main", line);
    },
  });
  ipc.handle(FEEDBACK_SEND_CHANNEL, (_event, input: unknown) => {
    const value = (input && typeof input === "object" ? input : {}) as Partial<FeedbackIpcInput>;
    windowRequestIds = Array.isArray(value.requestIds)
      ? value.requestIds.filter((id): id is string => typeof id === "string").slice(-RECENT_FAILED_REQUEST_IDS_MAX)
      : [];
    return send({ message: typeof value.message === "string" ? value.message : "", attachLog: value.attachLog === true });
  });
  return {
    /** The session the window last pushed to main (`sf-auth-set-token`); null when signed out. */
    setToken: (next: string | null) => {
      token = next;
    },
  };
};
