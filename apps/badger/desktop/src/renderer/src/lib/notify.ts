import { createNotify, type NotifyBundle } from "@space/desktop-shell/services/notify";
import type { NotificationStore } from "@space/desktop-shell/services/notifications";

let bundle: NotifyBundle | null = null;

export function bindNotificationStore(store: NotificationStore) {
  bundle = createNotify(store);
}

export const notify: NotifyBundle["notify"] = (opts) => {
  if (!bundle) return undefined;
  return bundle.notify(opts);
};

export const notifyError: NotifyBundle["notifyError"] = (message, title, meta) => {
  bundle?.notifyError(message, title, meta);
};

export const notifyWarning: NotifyBundle["notifyWarning"] = (message, title, meta) => {
  bundle?.notifyWarning(message, title, meta);
};

export const notifySuccess: NotifyBundle["notifySuccess"] = (message, title, meta) => {
  bundle?.notifySuccess(message, title, meta);
};
