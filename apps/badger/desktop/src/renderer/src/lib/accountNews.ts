import { useMemo } from "react";
import { useAccountNews as useSharedAccountNews } from "@space/desktop-shell/hooks";
import type { NoticeHistory } from "@space/notify-core/history";
import { listAccountNotices } from "@/api";
import { subscribeAppWindowVisibility } from "@/lib/appWindowVisibility";
import { rendererLogger } from "@/logger";

const log = rendererLogger.child({ scope: "account-news" });

/** Where each neutral target of the account news (UX-NOTICE-05) leads in this app: its Settings sections. */
const ACCOUNT_NEWS_PATHS: Record<string, string> = {
  devices: "/settings?section=devices",
  billing: "/settings?section=account",
  storage: "/settings?section=account",
};

/** The route a notice's target opens: an account news target becomes its Settings section, a route stays as it is. */
export const noticeTargetPath = (target: string) => ACCOUNT_NEWS_PATHS[target] ?? target;

const subscribeShown = (onShown: () => void) =>
  subscribeAppWindowVisibility(({ hidden }) => {
    if (!hidden) onShown();
  });

const onError = (message: string, error: unknown) => log.warn({ err: error }, message);

/**
 * UX-NOTICE-05: the account's news joins the bell's history now, every minute and when the window comes back (also
 * from the tray), so a device signed in, a payment or storage over its limit shows here whichever device it happened on.
 */
export function useAccountNews(history: NoticeHistory | null, token: string | null) {
  const fetchNews = useMemo(() => (token ? () => listAccountNotices(token) : null), [token]);
  useSharedAccountNews({ history, fetchNews, subscribeShown, onError });
}
