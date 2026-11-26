/**
 * What a notice is, once for every app (UX-NOTICE-03, UX-NOTICE-10, UX-NOTICE-11): its kind decides how long it stays
 * on screen and whether the history behind the bell keeps it; its level sets its colour and how loudly a screen reader
 * announces it; its key makes a repeat replace the earlier copy and lets the app take it back.
 */

/**
 * - `confirmation`: "that worked" (settings saved, import queued). Never kept.
 * - `headsUp`: something the user should know, possibly with one action (new device added, playback failed). Kept.
 * - `lasting`: the moment a lasting state starts (offline, unpaid, over the storage limit). The state itself shows as a
 *   sign in the top bar while true (UX-NOTICE-02, UX-NOTICE-08); this notice is the one heads-up entry that marks it. Kept.
 * - `decision`: the app needs an answer (update ready, delete). Drawn as a window that waits, never as a passing
 *   notice, so it has no time on screen. Never kept.
 * - `job`: an import, download or other job ended. Kept only when it failed (UX-NOTICE-10).
 */
export type NoticeKind = "confirmation" | "headsUp" | "lasting" | "decision" | "job";

export type NoticeLevel = "info" | "success" | "warning" | "error";

/** `account`: news shared through the account to every device (UX-NOTICE-05); `device`: this device's own messages. */
export type NoticeScope = "account" | "device";

/** A device's kind in the account's device list (ACCT-DEV-01); `other` for a session that names none. */
export const DEVICE_KINDS = ["desktop", "mobile", "tv", "kodi", "jellyfin", "web", "other"] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

export type JobOutcome = "done" | "failed";

export type TextVars = Record<string, string | number>;

/**
 * A notice's values: plain, or a text key itself (a device type in the account news), translated in the reader's
 * language when the notice is shown.
 */
export type NoticeVars = Record<string, string | number | { key: string; vars?: TextVars }>;

/**
 * Words of a notice: a text key and its values, turned into the language of the moment when shown (so the history
 * follows a language change), or text shown as it is (a file name, a server's error).
 */
export type NoticePart = string | { key: string; vars?: NoticeVars };

export type NoticeAction = { label: NoticePart; target: string };

export type Notice = {
  /** One key per message about one thing: a repeat replaces it on screen and in the history (UX-NOTICE-11). */
  key: string;
  kind: NoticeKind;
  level: NoticeLevel;
  /** Default `device`. */
  scope?: NoticeScope;
  /** Default: the level's translated default title (`notify.defaultTitle.<level>`, UX-NOTICE-13). */
  title?: NoticePart;
  message?: NoticePart;
  /** The one button (UX-NOTICE-03's "notice with a button"); it still works from the history entry (UX-NOTICE-11). */
  action?: NoticeAction;
  /** What opening the notice leads to (a job in the Jobs panel, a device in Settings). */
  target?: string;
  /** For `job`: how it ended. */
  outcome?: JobOutcome;
  /**
   * The TV's one-time message the user must read (today the founder card, UX-NOTICE-09): no timer, it waits for OK or
   * Back. The only notice that stays until acted on (UX-NOTICE-11).
   */
  oneTime?: boolean;
};

/** How long each kind stays when nobody points at or focuses it (UX-NOTICE-03). */
export const NOTICE_TIMINGS = {
  confirmationMs: 4_000,
  headsUpMs: 8_000,
  /** A notice with a button: 8 seconds with neither pointer nor focus on it (the pause does the "until used" part). */
  actionIdleMs: 8_000,
} as const;

/**
 * Time on screen before the notice leaves on its own, counted while neither the pointer nor the focus is on it; `null`
 * means no timer: only a TV one-time message and a decision window (which is not a passing notice).
 */
export const durationFor = (notice: Pick<Notice, "kind" | "outcome" | "action" | "oneTime">): number | null => {
  if (notice.oneTime || notice.kind === "decision") return null;
  if (notice.action) return NOTICE_TIMINGS.actionIdleMs;
  if (notice.kind === "confirmation") return NOTICE_TIMINGS.confirmationMs;
  if (notice.kind === "job") return notice.outcome === "failed" ? NOTICE_TIMINGS.headsUpMs : NOTICE_TIMINGS.confirmationMs;
  return NOTICE_TIMINGS.headsUpMs;
};

/**
 * Whether the history behind the bell keeps this notice: heads-ups, the start of a lasting state and failed jobs; never
 * a confirmation, a decision or a job that finished (it shows in the Jobs panel, UX-NOTICE-10).
 */
export const keptInHistory = (notice: Pick<Notice, "kind" | "outcome">): boolean => {
  if (notice.kind === "headsUp" || notice.kind === "lasting") return true;
  if (notice.kind === "job") return notice.outcome === "failed";
  return false;
};

/** How many passing notices show at once: a short stack on the computers and web, one card on the phone and TV. */
export const MAX_VISIBLE = { desktop: 3, web: 3, phone: 1, tv: 1 } as const;
