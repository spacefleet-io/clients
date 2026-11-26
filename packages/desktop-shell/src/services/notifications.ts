import { useSyncExternalStore } from "react";
import { createNoticeHistory, localStorageHistory, type HistoryEntry, type NoticeHistory } from "@space/notify-core/history";

export type { HistoryEntry, NoticeHistory } from "@space/notify-core/history";
export type { NoticeLevel } from "@space/notify-core/kinds";

/**
 * The history behind a computer app's bell (UX-NOTICE-04), saved in localStorage under `storageKey` (one per signed-in
 * user). The history of an older version under the same key is read as it is (`readEntry`), so nobody loses it.
 */
export const createDesktopNoticeHistory = (storageKey: string): NoticeHistory =>
  createNoticeHistory({ storage: localStorageHistory(storageKey) });

const EMPTY: readonly HistoryEntry[] = [];
const NOOP_UNSUBSCRIBE = () => {};
const NOOP_SUBSCRIBE = () => NOOP_UNSUBSCRIBE;
const EMPTY_SNAPSHOT = () => EMPTY;

/** The entries, newest first; the same array until the history changes. */
export function useNoticeHistory(history: NoticeHistory | null): readonly HistoryEntry[] {
  const snapshot = history ? history.getAll : EMPTY_SNAPSHOT;
  // The same snapshot server-side, so a page that renders the tray on a server (the web player's tests) works too.
  return useSyncExternalStore(history ? history.subscribe : NOOP_SUBSCRIBE, snapshot, snapshot);
}
