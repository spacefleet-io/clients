/**
 * The history behind the phone's bell (UX-NOTICE-04): the shared store from `@space/notify-core/history`, saved in
 * AsyncStorage under one key per signed-in user. The app passes its AsyncStorage in (this package only peers it). The
 * entries keep their text keys, so the list follows a change of language (UX-NOTICE-13).
 */
import { useMemo, useSyncExternalStore } from "react";
import { asyncStorageHistory, createNoticeHistory, type HistoryEntry, type NoticeHistory } from "@space/notify-core/history";

export type { HistoryEntry, NoticeHistory } from "@space/notify-core/history";

/** AsyncStorage, or anything with its `getItem` / `setItem`. */
export type NoticeHistoryStorage = Parameters<typeof asyncStorageHistory>[0];

const log = (event: string, payload: Record<string, unknown>) => console.info(`notify.history.${event}`, JSON.stringify(payload));

/** One history per storage key; `null` (signed out) gives none. A new key (another user) starts a new store. */
export const useAccountNoticeHistory = (storageKey: string | null, storage: NoticeHistoryStorage): NoticeHistory | null =>
  useMemo(
    () => (storageKey ? createNoticeHistory({ storage: asyncStorageHistory(storage, storageKey), log }) : null),
    [storageKey, storage],
  );

const EMPTY: readonly HistoryEntry[] = [];
const NOOP_UNSUBSCRIBE = () => {};
const NOOP_SUBSCRIBE = () => NOOP_UNSUBSCRIBE;
const EMPTY_SNAPSHOT = () => EMPTY;

/** The entries, newest first; the same array until the history changes. */
export const useNoticeHistory = (history: NoticeHistory | null): readonly HistoryEntry[] =>
  useSyncExternalStore(history ? history.subscribe : NOOP_SUBSCRIBE, history ? history.getAll : EMPTY_SNAPSHOT);

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** An entry's time as the history shows it: the hour today, else the day and the hour, in the app's language. */
export const noticeEntryTime = (timestamp: number, language: string): string => {
  const date = new Date(timestamp);
  return sameDay(date, new Date())
    ? date.toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleString(language, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
};
