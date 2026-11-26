import i18n from "i18next";
import { createNotify, type NotifyBundle, type NotifyDeps } from "@space/desktop-shell/services/notify";
import type { Translate } from "@space/notify-core/texts";

/** Text keys (the app's and the shared `notify.*`) in the language of the moment. */
export const translate: Translate = (key, vars) => i18n.t(key, vars);

// Before sign-in there is no history: the toast still shows.
let bundle: NotifyBundle = createNotify({ history: null, t: translate });

/** Points the notices at the signed-in user's history behind the bell (UX-NOTICE-04), or at none. */
export function bindNoticeHistory(history: NotifyDeps["history"], openTarget?: NotifyDeps["openTarget"]) {
  bundle = createNotify({ history, t: translate, openTarget });
}

export const notify: NotifyBundle["notify"] = (opts) => bundle.notify(opts);
export const notifyError: NotifyBundle["notifyError"] = (message, title, opts) => bundle.notifyError(message, title, opts);
export const notifyWarning: NotifyBundle["notifyWarning"] = (message, title, opts) => bundle.notifyWarning(message, title, opts);
export const notifySuccess: NotifyBundle["notifySuccess"] = (message, title, opts) => bundle.notifySuccess(message, title, opts);
