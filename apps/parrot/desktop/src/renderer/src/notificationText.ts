// Notifications stay in the tray across language changes (UX-I18N-01): each one keeps the string keys it was made from
// in `meta.text`, and the tray translates them when it shows them. `title`/`message` hold the text in the language of
// the moment, for a notification saved by an older version or a key this version no longer has.
import type { ShellNotification } from "@space/desktop-shell/services/notifications";
import type { ParrotStringKey, Translate } from "./i18n";

type Vars = Record<string, string | number>;
/** A string key and its values, or text shown as it is (a file name, a server's error). */
export type NotificationPart = { key: ParrotStringKey; vars?: Vars } | string;
type NotificationText = { title: NotificationPart; message: NotificationPart };

const partText = (t: Translate, part: NotificationPart) => (typeof part === "string" ? part : t(part.key, part.vars));

const isPart = (value: unknown): value is NotificationPart =>
  typeof value === "string" || (typeof value === "object" && value !== null && "key" in value && typeof value.key === "string");

/** What `notifications.push` takes for a notification whose words follow the language. */
export const keyedNotification = (t: Translate, level: ShellNotification["level"], title: NotificationPart, message: NotificationPart = "") => ({
  level,
  title: partText(t, title),
  message: partText(t, message),
  meta: { text: { title, message } satisfies NotificationText },
});

/** The notification in the current language (`meta` comes back from localStorage, so it is checked). */
export const shownNotification = (t: Translate, notification: ShellNotification): ShellNotification => {
  const text = notification.meta?.text;
  if (typeof text !== "object" || text === null || !("title" in text) || !("message" in text)) return notification;
  const { title, message } = text;
  if (!isPart(title) || !isPart(message)) return notification;
  return { ...notification, title: partText(t, title), message: partText(t, message) };
};
