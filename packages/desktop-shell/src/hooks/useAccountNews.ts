import { useEffect } from "react";
import { startAccountNewsSync } from "@space/notify-core/accountNews";
import type { NoticeHistory } from "@space/notify-core/history";

/**
 * UX-NOTICE-05, for the computer apps, the web players and the website: the account's news (`GET /account/notices`)
 * joins this history now, every minute, and whenever the window or tab comes back (focus, the tab shown again, or
 * the app's own "window shown" event), so news from any device shows in this bell. Nothing runs without a history
 * and a fetch (signed out).
 */
export function useAccountNews({
  history,
  fetchNews,
  subscribeShown,
  onError,
}: {
  history: NoticeHistory | null;
  /** The body of `GET /account/notices` for the signed-in account; `null` when signed out. */
  fetchNews: (() => Promise<unknown>) | null;
  /** The app's own "window shown again" event (an Electron window back from the tray), if it has one. */
  subscribeShown?: (onShown: () => void) => () => void;
  onError?: (message: string, error: unknown) => void;
}) {
  useEffect(() => {
    if (!history || !fetchNews) return;
    const sync = startAccountNewsSync({ history, fetchNews, log: onError });
    const refresh = () => void sync.refresh();
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);
    const stopShown = subscribeShown?.(refresh);
    return () => {
      sync.stop();
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
      stopShown?.();
    };
    // `fetchNews` is expected stable per account (memoized on the token); `onError` and `subscribeShown` are read once.
  }, [history, fetchNews]);
}
