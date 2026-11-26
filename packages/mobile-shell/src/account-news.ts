/**
 * UX-NOTICE-05 on the phone and TV: the account's news (`GET /account/notices`: another device signed in, a payment,
 * storage over its limit) joins this device's notice history now, every minute while the app runs, and each time the
 * app comes back to the front, so news from any device shows behind the bell (phone) or the Notifications row (TV).
 * Nothing runs while signed out.
 */
import { useEffect, useMemo } from "react";
import { AppState } from "react-native";
import { listAccountNotices } from "@space/shared/api";
import { startAccountNewsSync } from "@space/notify-core/accountNews";
import type { NoticeHistory } from "@space/notify-core/history";
import { scopeLogger } from "./logger";

const log = scopeLogger("notify.accountNews");

export const useAccountNews = (
  history: NoticeHistory | null,
  token: string | null | undefined,
  fetchNotices: (token: string) => Promise<unknown> = listAccountNotices,
) => {
  const fetchNews = useMemo(() => (token ? () => fetchNotices(token) : null), [token, fetchNotices]);
  useEffect(() => {
    if (!history || !fetchNews) return undefined;
    const sync = startAccountNewsSync({
      history,
      fetchNews,
      // Offline or signed out: the history keeps what it has and the next read tries again.
      log: (message, error) => log.warn("read.failed", { message, error: error instanceof Error ? error.message : String(error) }),
    });
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void sync.refresh();
    });
    return () => {
      sync.stop();
      subscription.remove();
    };
  }, [history, fetchNews]);
};
