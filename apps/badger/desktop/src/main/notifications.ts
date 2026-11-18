/**
 * Indirection over `electron.Notification` so tests can capture notifications
 * via a JSON log sink instead of the OS notification UI.
 *
 * - When `process.env.SF_TEST_NOTIFICATION_SINK` is set (a file path),
 *   each call appends `JSON.stringify(input) + "\n"` to that file via
 *   `fs.appendFileSync`. No OS notification is shown.
 * - Otherwise, falls back to `new Notification({title, body}).show()`.
 *
 * Renderer code should NOT import this directly — it must go through the
 * `sf-notify-job-complete` IPC channel registered in `index.ts`.
 */

import { Notification } from "electron";
import { appendFileSync } from "node:fs";

export type NotifyInput = {
  title: string;
  body: string;
  mediaId?: string;
  variant?: "success" | "error";
};

export const sendNotification = (input: NotifyInput): void => {
  const sinkPath = process.env.SF_TEST_NOTIFICATION_SINK;
  if (sinkPath) {
    appendFileSync(sinkPath, JSON.stringify(input) + "\n");
    return;
  }
  new Notification({ title: input.title, body: input.body }).show();
};
