import { memo, useCallback, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { NoticeBell } from "@space/desktop-shell/components";
import { createDesktopNoticeHistory } from "@space/desktop-shell/services/notifications";
import { historyStorageKey } from "@space/notify-core/history";
import { useTranslation } from "react-i18next";

import { useAuth } from "@/auth";
import { bindNoticeHistory, translate } from "@/lib/notify";
import { noticeTargetPath, useAccountNews } from "@/lib/accountNews";
import { useUnpaidHeadsUp } from "@/components/UnpaidAccessSign";

/**
 * The bell and its history (UX-NOTICE-04): the number of unread notices on it (UX-NOTICE-12), "9+" above 9, and the
 * account's news from the server beside this computer's notices (UX-NOTICE-05).
 */
function TopNavNotificationsButton({
  userId,
}: {
  userId: string | null;
}) {
  // Re-renders on a language change, so the tray follows it (UX-NOTICE-13).
  useTranslation();
  const navigate = useNavigate();
  const { token } = useAuth();

  const history = useMemo(() => (userId ? createDesktopNoticeHistory(historyStorageKey(userId)) : null), [userId]);
  const openTarget = useCallback((target: string) => navigate(noticeTargetPath(target)), [navigate]);
  useEffect(() => {
    bindNoticeHistory(history, openTarget);
    return () => bindNoticeHistory(null);
  }, [history, openTarget]);
  // UX-NOTICE-08: an unpaid account gets one heads-up in this history, beside the sign in the top bar.
  useUnpaidHeadsUp(history, userId);
  useAccountNews(history, token);

  return <NoticeBell history={history} t={translate} onOpenTarget={openTarget} />;
}

export default memo(TopNavNotificationsButton);
