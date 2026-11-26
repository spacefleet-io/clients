/**
 * Keeping a device's history up to date with the account's news (UX-NOTICE-05): read `GET /account/notices` now,
 * every minute, and whenever the app comes back to the front, and merge what comes into the history. Each app gives
 * its own fetch (its api client and token) and calls `refresh` from its own "came to the front" event.
 */
import { accountNewsEntries, type NoticeHistory } from "./history";

export const ACCOUNT_NEWS_POLL_MS = 60_000;

export type AccountNewsSync = {
  /** Read the news now (the app came to the front); a read already running is not doubled. */
  refresh: () => Promise<void>;
  stop: () => void;
};

export const startAccountNewsSync = ({
  history,
  fetchNews,
  intervalMs = ACCOUNT_NEWS_POLL_MS,
  log,
}: {
  history: NoticeHistory;
  /** The JSON body of `GET /account/notices`. */
  fetchNews: () => Promise<unknown>;
  intervalMs?: number;
  log?: (message: string, error: unknown) => void;
}): AccountNewsSync => {
  let stopped = false;
  let running: Promise<void> | null = null;
  const refresh = () => {
    if (stopped) return Promise.resolve();
    running ??= fetchNews()
      .then((payload) => {
        if (!stopped) history.mergeAccountNews(accountNewsEntries(payload));
      })
      // No news this time (offline, signed out): the next poll tries again; the history keeps what it has.
      .catch((error: unknown) => log?.("account news could not be read", error))
      .finally(() => {
        running = null;
      });
    return running;
  };
  void refresh();
  const timer = setInterval(() => void refresh(), intervalMs);
  return {
    refresh,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
};
