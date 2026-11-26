/**
 * "Send feedback" (UX-SUP-05), shared by the phone apps (Badger, Parrot): builds the `POST /feedback` body and maps the
 * API's answer to what the form shows. The error log goes along only when the user ticked the box (UX-SUP-02); the log
 * (`@space/error-report/error-log`) scrubs each line with the REL-LOG-06 scrubber as it is recorded. The body always
 * carries the server's request ids of the app's last failed API calls (UX-SUP-07): ids only, so an admin finds the
 * server's lines about what went wrong.
 */
import { clampLog } from "@space/error-report/error-log";
import { ApiError, type FeedbackInput } from "@space/shared/api";
import { recentFailedRequestIds } from "@space/shared/apiFailure";
import { FEEDBACK_MESSAGE_MAX } from "@space/shared/feedback";

export type FeedbackDevice = {
  app: FeedbackInput["app"];
  appVersion: string | null;
  /** "android 15" */
  platform: string | null;
  /** "Google Pixel 8" */
  deviceModel: string | null;
};

export type FeedbackDraft = { message: string; attachLog: boolean };

/** The request body, or null when the message is empty after trimming. */
export const buildFeedback = (
  draft: FeedbackDraft,
  device: FeedbackDevice,
  readLog: () => string,
  requestIds: () => string[] = recentFailedRequestIds
): FeedbackInput | null => {
  const message = draft.message.trim().slice(0, FEEDBACK_MESSAGE_MAX);
  if (!message) return null;
  const log = draft.attachLog ? clampLog(readLog()) : null;
  return { message, ...device, log: log || null, requestIds: requestIds() };
};

export type FeedbackFailure = "rate_limited" | "invalid" | "offline" | "failed";

/** What the form says when sending failed. */
export const feedbackFailure = (error: unknown): FeedbackFailure => {
  if (error instanceof ApiError) {
    if (error.status === 429) return "rate_limited";
    if (error.status === 400) return "invalid";
    return "failed";
  }
  return error instanceof TypeError ? "offline" : "failed";
};
