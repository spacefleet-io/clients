/**
 * "Send feedback" (UX-SUP-05) for a desktop app's main process, which holds the session token: Badger and Parrot
 * share it (REL-FAM-03). Kept out of the apps' `index.ts`, which needs a running Electron, so tests drive it.
 */
import { clampLog, type ErrorLog } from "./errorLog";

/** What the renderer asks main to send. */
export type DesktopFeedbackInput = { message: string; attachLog: boolean };

/** The `POST /feedback` body (`FeedbackInput` of `@space/shared/api`), restated so this package needs no app code. */
export type DesktopFeedbackBody = {
  message: string;
  app: "badger-desktop" | "parrot-desktop";
  appVersion: string;
  platform: string;
  log: string | null;
  /** UX-SUP-07: the server's request ids of the app's last failed API calls. */
  requestIds: string[];
};

/**
 * The message, plus the scrubbed error log (REL-LOG-06) only when the user ticked "Attach the app's error log", and
 * always the request ids of the app's last failed API calls (UX-SUP-07).
 */
export const createDesktopFeedbackSender = (deps: {
  app: DesktopFeedbackBody["app"];
  token: () => string | null;
  errorLog: ErrorLog;
  appVersion: string;
  /** "linux 6.8.0"; the API keeps 32 characters. */
  platform: string;
  /** UX-SUP-07: `recentFailedRequestIds` of `@space/shared/apiFailure`, read when the message is sent. */
  requestIds: () => string[];
  send: (token: string, body: DesktopFeedbackBody) => Promise<unknown>;
  log: (line: string) => void;
  fail: (line: string) => void;
}) => async (input: DesktopFeedbackInput): Promise<{ ok: boolean; error?: string }> => {
  const token = deps.token();
  if (!token) return { ok: false, error: "not signed in" };
  const body: DesktopFeedbackBody = {
    message: String(input.message),
    app: deps.app,
    appVersion: deps.appVersion,
    platform: deps.platform.slice(0, 32),
    log: input.attachLog === true ? clampLog(deps.errorLog.read()) || null : null,
    requestIds: deps.requestIds(),
  };
  try {
    await deps.send(token, body);
    deps.log(`[feedback] sent (log ${body.log ? `${body.log.length} chars` : "not attached"}, ${body.requestIds.length} request ids)`);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.fail(`[feedback] not sent: ${message}`);
    return { ok: false, error: message };
  }
};
