import { toast, type ExternalToast } from "@space/ui";
import type { NotificationLevel, NotificationStore, ShellNotification } from "./notifications";

type NotifyOptions = {
  title: string;
  message: string;
  level?: NotificationLevel;
  meta?: Record<string, unknown>;
  /** If true, show toast but do NOT persist to store. Default: false */
  ephemeral?: boolean;
  /** Sonner toast options passthrough (action buttons, duration, etc.) */
  toastOptions?: ExternalToast;
};

export type NotifyBundle = {
  notify: (opts: NotifyOptions) => ShellNotification | undefined;
  notifyError: (message: string, title?: string, meta?: Record<string, unknown>) => void;
  notifyWarning: (message: string, title?: string, meta?: Record<string, unknown>) => void;
  notifySuccess: (message: string, title?: string, meta?: Record<string, unknown>) => void;
};

function showToast(message: string, level: NotificationLevel, opts?: ExternalToast) {
  if (level === "error") toast.error(message, opts);
  else if (level === "warning") toast.warning(message, opts);
  else if (level === "success") toast.success(message, opts);
  else toast(message, opts);
}

export function createNotify(store: NotificationStore): NotifyBundle {
  const notify: NotifyBundle["notify"] = ({ title, message, level = "info", meta, ephemeral, toastOptions }) => {
    let notification: ShellNotification | undefined;
    if (!ephemeral) {
      notification = store.push({ title, message, level, meta });
    }
    showToast(message, level, toastOptions);
    return notification;
  };

  const notifyError: NotifyBundle["notifyError"] = (message, title = "Error", meta) =>
    notify({ title, message, level: "error", meta });

  const notifyWarning: NotifyBundle["notifyWarning"] = (message, title = "Warning", meta) =>
    notify({ title, message, level: "warning", meta });

  const notifySuccess: NotifyBundle["notifySuccess"] = (message, title = "Success", meta) =>
    notify({ title, message, level: "success", meta });

  return { notify, notifyError, notifyWarning, notifySuccess };
}
