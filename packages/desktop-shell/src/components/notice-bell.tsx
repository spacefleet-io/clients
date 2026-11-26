import { useEffect, useState } from "react";
import { Bell } from "lucide-react";
import { badgeLabel, type NoticeHistory } from "@space/notify-core/history";
import type { Translate } from "@space/notify-core/texts";
import { useNoticeHistory } from "../services/notifications";
import { DesktopNotificationTray } from "./desktop-notification-tray";
import { NotificationTrayContent } from "./desktop-notification-tray-content";
import { DesktopTopNavIconAction } from "./desktop-top-nav-actions";
import { desktopTopNavIconActionClassName } from "./desktop-top-nav-styles";

export type NoticeBellProps = {
  /** `null` before sign-in: the bell shows an empty history. */
  history: NoticeHistory | null;
  /** The shared `notify.*` texts and the app's own keys an entry was saved with, in the language of the moment (UX-NOTICE-13). */
  t: Translate;
  /** Follows an entry's button or target; the tray closes first. */
  onOpenTarget?: (target: string) => void;
  /** Told apart from a second copy of the bell (the narrow bar's row ends its ids in `-mobile`). */
  testIdSuffix?: string;
  /** A z-index class for the tray above the page's own fixed header (the website's top bar). */
  trayLayerClassName?: string;
};

/**
 * The bell in the top bar of the computer apps and the web players (UX-NOTICE-04): the number of unread entries on it,
 * "9+" above 9, none when all are seen (UX-NOTICE-12); it opens the history in the right-side tray, which marks every
 * entry seen, and so does an entry arriving while it is open.
 */
export function NoticeBell({ history, t, onOpenTarget, testIdSuffix = "", trayLayerClassName }: NoticeBellProps) {
  const [open, setOpen] = useState(false);
  const entries = useNoticeHistory(history);
  useEffect(() => {
    if (open) history?.markAllRead();
  }, [open, history, entries]);
  const badge = badgeLabel(entries.filter((entry) => !entry.read).length);
  return (
    <DesktopNotificationTray
      open={open}
      onOpenChange={setOpen}
      title={t("notify.title")}
      subtitle={t("notify.recent", { count: entries.length })}
      emptyMessage={t("notify.empty")}
      layerClassName={trayLayerClassName}
      trigger={
        <DesktopTopNavIconAction title={t("notify.bell")} testId={`nav-notifications${testIdSuffix}`} className={desktopTopNavIconActionClassName}>
          <Bell className="size-4" aria-hidden />
          {badge ? (
            <span
              className="absolute -right-1 -top-1 inline-flex min-h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-black text-primary-foreground"
              data-testid={`nav-notifications-count${testIdSuffix}`}
            >
              {badge}
            </span>
          ) : null}
        </DesktopTopNavIconAction>
      }
    >
      {history && entries.length > 0 ? (
        <NotificationTrayContent
          entries={entries}
          t={t}
          onRemove={history.remove}
          onClearAll={history.clearAll}
          onOpenTarget={
            onOpenTarget
              ? (target) => {
                  setOpen(false);
                  onOpenTarget(target);
                }
              : undefined
          }
        />
      ) : null}
    </DesktopNotificationTray>
  );
}
