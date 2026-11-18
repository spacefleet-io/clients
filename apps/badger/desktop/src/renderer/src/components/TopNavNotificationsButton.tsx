import { Suspense, lazy, memo, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Bell } from "lucide-react";
import { DesktopNotificationTray, DesktopTopNavIconAction } from "@space/desktop-shell/components";
import { createNotificationStore, useNotificationStore } from "@space/desktop-shell/services/notifications";

const NotificationTrayContent = lazy(() => import("./TopNavNotificationsTrayContent"));

import { bindNotificationStore } from "@/lib/notify";

function TopNavNotificationsButton({
  userId,
}: {
  userId: string | null;
}) {
  const { t } = useTranslation();
  const [notificationPanelOpen, setNotificationPanelOpen] = useState(false);

  const store = useMemo(() => {
    if (!userId) return null;
    const s = createNotificationStore({ storageKey: `sf.notifications.${userId}` });
    bindNotificationStore(s);
    return s;
  }, [userId]);
  const notifications = useNotificationStore(store);

  useEffect(() => {
    if (!notificationPanelOpen) return;
    store?.markAllRead();
  }, [notificationPanelOpen, store]);

  const unreadCount = store?.countUnread() ?? 0;

  return (
    <DesktopNotificationTray
      open={notificationPanelOpen}
      onOpenChange={setNotificationPanelOpen}
      title={t("nav.notifications.title")}
      subtitle={t("nav.notifications.subtitle", { count: notifications.length })}
      emptyMessage={t("nav.notifications.empty")}
      trigger={
        <DesktopTopNavIconAction
          title={t("nav.notifications.title")}
          className="text-[#8b949e] hover:bg-[#161b22] hover:text-white"
        >
          <Bell className="h-4 w-4" />
          {unreadCount > 0 ? (
            <span className="absolute -right-1 -top-1 inline-flex min-h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-black text-primary-foreground">
              {Math.min(unreadCount, 99)}
            </span>
          ) : null}
        </DesktopTopNavIconAction>
      }
    >
      {notifications.length > 0 ? (
        <Suspense fallback={null}>
          <NotificationTrayContent
            notifications={notifications}
            labels={{
              filterAll: t("nav.notifications.filterAll", "All"),
              filterError: t("nav.notifications.filterError", "Error"),
              filterWarning: t("nav.notifications.filterWarning", "Warning"),
              filterInfo: t("nav.notifications.filterInfo", "Info"),
              filterSuccess: t("nav.notifications.filterSuccess", "Success"),
              clearAll: t("nav.notifications.clearAll", "Clear all"),
              dismiss: t("nav.notifications.dismiss", "Dismiss"),
            }}
            onRemove={(id) => store?.remove(id)}
            onClearAll={() => store?.clearAll()}
          />
        </Suspense>
      ) : null}
    </DesktopNotificationTray>
  );
}

export default memo(TopNavNotificationsButton);
