import { FEEDBACK_LOG_MAX_BYTES } from "@space/shared/feedback";
import { scrubText } from "./scrub";

/**
 * The app's error log (UX-SUP-02, UX-SUP-05), shared by every SpaceFleet app that offers "Send feedback" (Badger and
 * Parrot, phone and desktop): the newest warning and error lines, kept in memory only and sent solely with feedback
 * the user chose to attach it to. Each line goes through the REL-LOG-06 scrubber as it is recorded, so the log never
 * carries an address, a path, a file name, a title or an account, whatever the caller passed in.
 */
export interface ErrorLog {
  /** Records one line, timestamped and scrubbed. `level` is the line's severity as the app's logger names it. */
  record(level: "warn" | "error", scope: string, text: string): void;
  /** The kept lines, oldest first, one per line. */
  read(): string;
}

export const ERROR_LOG_LINES = 500;

export function createErrorLog(options: { maxLines?: number; now?: () => Date } = {}): ErrorLog {
  const maxLines = options.maxLines ?? ERROR_LOG_LINES;
  const now = options.now ?? (() => new Date());
  const lines: string[] = [];
  return {
    record(level, scope, text) {
      lines.push(`${now().toISOString()} [${level.toUpperCase()}] [${scope}] ${scrubText(text)}`);
      if (lines.length > maxLines) lines.splice(0, lines.length - maxLines);
    },
    read: () => lines.join("\n"),
  };
}

/** The newest part of the log that fits the API's limit (`FEEDBACK_LOG_MAX_BYTES`, 200 KB). */
export const clampLog = (log: string): string => {
  if (log.length <= FEEDBACK_LOG_MAX_BYTES / 2) return log;
  let out = log;
  while (new TextEncoder().encode(out).length > FEEDBACK_LOG_MAX_BYTES) out = out.slice(Math.ceil(out.length / 10));
  return out;
};
