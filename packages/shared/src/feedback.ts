/**
 * "Send feedback" (UX-SUP-05) limits, one copy for the API that enforces them and every app's form (REL-FAM-05):
 * the phones' form (`@space/mobile-shell`) and the desktop form (`@space/desktop-shell`) stop the message here, so a
 * user never writes text the API refuses, and the apps' error log (`clampLog` in `@space/error-report/error-log`) keeps
 * only the newest part that fits the log limit.
 */

/** The longest message, in characters after trimming. */
export const FEEDBACK_MESSAGE_MAX = 4000;

/** The longest opt-in error log, in bytes of UTF-8. */
export const FEEDBACK_LOG_MAX_BYTES = 200 * 1024;
