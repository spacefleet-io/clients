/**
 * The history behind the bell (UX-NOTICE-04, UX-NOTICE-05, UX-NOTICE-10, UX-NOTICE-11, UX-NOTICE-12): the last 50
 * kept notices of one signed-in user, newest first, with an unread count. Entries keep their words as text keys
 * (`NoticePart`), so the history follows a language change. A repeat of the same notice (same key) replaces its
 * earlier entry: it moves to the top, counts once and is unread again. Account news from the server (`mergeAccountNews`)
 * sits beside this device's own messages; only the account news is ever shared.
 *
 * Storage is an adapter: `localStorage` on the computers and web (synchronous), AsyncStorage on the phone and TV. It
 * holds `{ entries, accountSyncedAt }`; a bare array (the history before account news) is still read.
 */
import { keptInHistory, type Notice, type NoticeAction, type NoticeKind, type NoticeLevel, type NoticePart, type NoticeScope } from "./kinds";

export const HISTORY_MAX = 50;

export type HistoryEntry = {
  id: string;
  key: string;
  kind: NoticeKind;
  level: NoticeLevel;
  scope: NoticeScope;
  title?: NoticePart;
  message?: NoticePart;
  action?: NoticeAction;
  target?: string;
  timestamp: number;
  read: boolean;
};

/** Where the history is saved: text in, text out, synchronous (localStorage) or not (AsyncStorage). */
export type HistoryStorage = {
  read: () => string | null | Promise<string | null>;
  write: (raw: string) => void | Promise<void>;
};

export type HistoryOptions = {
  storage: HistoryStorage;
  max?: number;
  now?: () => number;
  newId?: () => string;
  log?: (event: string, payload: Record<string, unknown>) => void;
};

export type NoticeHistory = {
  /** Newest first. A new array only when the history changed, so it can feed `useSyncExternalStore`. */
  getAll: () => readonly HistoryEntry[];
  /** Saved when it finished reading storage (at once for localStorage). */
  ready: Promise<void>;
  /** Keeps the notice if its kind is kept (`keptInHistory`); returns the entry, or `null` when it is not kept. */
  record: (notice: Notice) => HistoryEntry | null;
  /**
   * The account's news as the server lists it (UX-NOTICE-05): each replaces this device's entry with the same id or
   * key; one already read here stays read unless the server's copy is newer. News no newer than the last merge and
   * missing here was removed or cleared on this device and stays gone. On the device's first merge every item comes in
   * read: it happened before this device was there to see it. Waits for `ready`.
   */
  mergeAccountNews: (entries: readonly HistoryEntry[]) => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
  remove: (id: string) => void;
  /** Takes back the entry with this key (an account message the server withdrew). */
  removeKey: (key: string) => void;
  clearAll: () => void;
  unreadCount: () => number;
  subscribe: (listener: () => void) => () => void;
};

const LEVELS: readonly string[] = ["info", "success", "warning", "error"];
const KINDS: readonly string[] = ["confirmation", "headsUp", "lasting", "decision", "job"];

const isPart = (value: unknown): value is NoticePart =>
  typeof value === "string" || (typeof value === "object" && value !== null && "key" in value && typeof value.key === "string");

const isAction = (value: unknown): value is NoticeAction =>
  typeof value === "object" && value !== null && "label" in value && isPart(value.label) && "target" in value && typeof value.target === "string";

/** Parrot's computer history kept its text keys in `meta.text` before this package. */
const legacyText = (meta: unknown): { title?: unknown; message?: unknown } =>
  typeof meta === "object" && meta !== null && "text" in meta && typeof meta.text === "object" && meta.text !== null ? meta.text : {};

/**
 * One saved entry, or `null` when it cannot be read. Also reads the computers' history from before this package (an
 * id, a title and message in the language of the day, `meta.text` with Parrot's text keys), so nobody loses it.
 */
export const readEntry = (value: unknown): HistoryEntry | null => {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || typeof v.timestamp !== "number" || typeof v.read !== "boolean") return null;
  const legacy = legacyText(v.meta);
  const title = "title" in legacy && isPart(legacy.title) ? legacy.title : isPart(v.title) ? v.title : undefined;
  const message = "message" in legacy && isPart(legacy.message) ? legacy.message : isPart(v.message) ? v.message : undefined;
  const level = typeof v.level === "string" && LEVELS.includes(v.level) ? (v.level as NoticeLevel) : "info";
  const entry: HistoryEntry = {
    id: v.id,
    key: typeof v.key === "string" ? v.key : v.id,
    kind: typeof v.kind === "string" && KINDS.includes(v.kind) ? (v.kind as NoticeKind) : "headsUp",
    level,
    scope: v.scope === "account" ? "account" : "device",
    timestamp: v.timestamp,
    read: v.read,
  };
  if (title !== undefined && title !== "") entry.title = title;
  if (message !== undefined && message !== "") entry.message = message;
  if (isAction(v.action)) entry.action = v.action;
  if (typeof v.target === "string") entry.target = v.target;
  return entry;
};

type Saved = { entries: HistoryEntry[]; accountSyncedAt: number };

const parse = (raw: string | null, max: number): Saved => {
  const empty = { entries: [], accountSyncedAt: 0 };
  if (!raw) return empty;
  try {
    const parsed: unknown = JSON.parse(raw);
    // A bare array: the history saved before account news.
    const list: unknown = Array.isArray(parsed) ? parsed : typeof parsed === "object" && parsed !== null && "entries" in parsed ? parsed.entries : null;
    if (!Array.isArray(list)) return empty;
    const syncedAt = typeof parsed === "object" && parsed !== null && "accountSyncedAt" in parsed ? parsed.accountSyncedAt : 0;
    return {
      entries: list
        .map(readEntry)
        .filter((entry): entry is HistoryEntry => entry !== null)
        .slice(0, max),
      accountSyncedAt: typeof syncedAt === "number" && Number.isFinite(syncedAt) ? syncedAt : 0,
    };
  } catch {
    return empty;
  }
};

/**
 * The account's news as `GET /account/notices` sends it (UX-NOTICE-05), as history entries: unread, account-wide,
 * opening the action's target. Items that cannot be read are dropped.
 */
export const accountNewsEntries = (payload: unknown): HistoryEntry[] => {
  const list: unknown = typeof payload === "object" && payload !== null && "notices" in payload ? payload.notices : null;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item: unknown) => {
    if (typeof item !== "object" || item === null) return [];
    const timestamp = "createdAt" in item && typeof item.createdAt === "string" ? Date.parse(item.createdAt) : Number.NaN;
    if (Number.isNaN(timestamp)) return [];
    const target = "action" in item && isAction(item.action) ? item.action.target : undefined;
    const entry = readEntry({ ...item, kind: "headsUp", scope: "account", timestamp, read: false, target });
    return entry ? [entry] : [];
  });
};

const randomId = () =>
  typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** Entries with one key at most (the first, newest, wins), newest first, cut to `max`. */
const tidy = (entries: HistoryEntry[], max: number) => {
  const seen = new Set<string>();
  return entries
    .filter((entry) => {
      if (seen.has(entry.key)) return false;
      seen.add(entry.key);
      return true;
    })
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, max);
};

export const createNoticeHistory = ({ storage, max = HISTORY_MAX, now = Date.now, newId = randomId, log }: HistoryOptions): NoticeHistory => {
  let entries: readonly HistoryEntry[] = [];
  // The newest account news merged so far, in the server's time (0: never merged on this device).
  let accountSyncedAt = 0;
  let loaded = false;
  const listeners = new Set<() => void>();

  const save = (next: HistoryEntry[]) => {
    entries = tidy(next, max);
    for (const listener of listeners) listener();
    // Before the saved history is read, writing would erase it; `ready` writes the merged result.
    if (!loaded) return;
    const written = storage.write(JSON.stringify({ entries, accountSyncedAt }));
    if (written instanceof Promise) written.catch((error: unknown) => log?.("history.write_failed", { error: String(error) }));
  };

  const hydrate = (raw: string | null) => {
    const saved = parse(raw, max);
    loaded = true;
    accountSyncedAt = Math.max(accountSyncedAt, saved.accountSyncedAt);
    log?.("history.loaded", { saved: saved.entries.length, before: entries.length });
    // Entries recorded while storage was being read are newer: they come first and win on the same key.
    save([...entries, ...saved.entries]);
  };

  let ready: Promise<void>;
  try {
    const raw = storage.read();
    if (raw instanceof Promise) {
      ready = raw.then(hydrate, (error: unknown) => {
        log?.("history.read_failed", { error: String(error) });
        hydrate(null);
      });
    } else {
      hydrate(raw);
      ready = Promise.resolve();
    }
  } catch (error) {
    log?.("history.read_failed", { error: String(error) });
    hydrate(null);
    ready = Promise.resolve();
  }

  const record = (notice: Notice): HistoryEntry | null => {
    if (!keptInHistory(notice)) {
      log?.("history.skipped", { key: notice.key, kind: notice.kind, outcome: notice.outcome ?? null });
      return null;
    }
    const entry: HistoryEntry = {
      id: newId(),
      key: notice.key,
      kind: notice.kind,
      level: notice.level,
      scope: notice.scope ?? "device",
      timestamp: now(),
      read: false,
    };
    if (notice.title !== undefined) entry.title = notice.title;
    if (notice.message !== undefined) entry.message = notice.message;
    if (notice.action) entry.action = notice.action;
    if (notice.target !== undefined) entry.target = notice.target;
    const replaced = entries.some((e) => e.key === notice.key);
    log?.("history.recorded", { key: notice.key, replaced });
    save([entry, ...entries.filter((e) => e.key !== notice.key)]);
    return entry;
  };

  const mergeAccountNews = (news: readonly HistoryEntry[]) => {
    if (!loaded) {
      // The last merge's mark is still being read; merging now would bring back what this device cleared.
      void ready.then(() => mergeAccountNews(news));
      return;
    }
    const firstSync = accountSyncedAt === 0;
    const byId = new Map(entries.map((e) => [e.id, e]));
    const byKey = new Map(entries.map((e) => [e.key, e]));
    const merged = news.flatMap((item) => {
      const local = byId.get(item.id) ?? byKey.get(item.key);
      if (!local && item.timestamp <= accountSyncedAt) return [];
      const read = local ? local.read && local.timestamp >= item.timestamp : firstSync;
      return [{ ...item, scope: "account" as const, read }];
    });
    // At least 1 once merged, even with no news yet: the next news is new to this device.
    const syncedAt = news.reduce((latest, item) => Math.max(latest, item.timestamp), Math.max(accountSyncedAt, 1));
    const ids = new Set(merged.map((m) => m.id));
    const keys = new Set(merged.map((m) => m.key));
    const next = tidy([...merged, ...entries.filter((e) => !ids.has(e.id) && !keys.has(e.key))], max);
    // Every poll lists the same news: nothing changed, nothing saved, no listener woken.
    if (syncedAt === accountSyncedAt && JSON.stringify(next) === JSON.stringify(entries)) return;
    accountSyncedAt = syncedAt;
    log?.("history.account_merged", { incoming: news.length, merged: merged.length, firstSync });
    save(next);
  };

  const update = (change: (list: readonly HistoryEntry[]) => HistoryEntry[]) => {
    const next = change(entries);
    if (next.length === entries.length && next.every((entry, i) => entry === entries[i])) return;
    save(next);
  };

  return {
    getAll: () => entries,
    ready,
    record,
    mergeAccountNews,
    markRead: (id) => update((list) => list.map((e) => (e.id === id && !e.read ? { ...e, read: true } : e))),
    markAllRead: () => update((list) => list.map((e) => (e.read ? e : { ...e, read: true }))),
    remove: (id) => update((list) => list.filter((e) => e.id !== id)),
    removeKey: (key) => update((list) => list.filter((e) => e.key !== key)),
    clearAll: () => update(() => []),
    unreadCount: () => entries.filter((e) => !e.read).length,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

/** The bell's number (UX-NOTICE-12): nothing at 0, "9+" above 9. */
export const badgeLabel = (unread: number): string | null => (unread <= 0 ? null : unread > 9 ? "9+" : String(unread));

/** `localStorage` under `key`; an engine without it (tests, a locked-down browser) keeps the history in memory only. */
export const localStorageHistory = (key: string): HistoryStorage => ({
  read: () => (typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage.getItem(key)),
  write: (raw) => {
    if (typeof globalThis.localStorage !== "undefined") globalThis.localStorage.setItem(key, raw);
  },
});

/** AsyncStorage (or anything with its `getItem` / `setItem`) under `key`: the phone and TV. */
export const asyncStorageHistory = (
  storage: { getItem: (key: string) => Promise<string | null>; setItem: (key: string, value: string) => Promise<void> },
  key: string,
): HistoryStorage => ({
  read: () => storage.getItem(key),
  write: (raw) => storage.setItem(key, raw),
});

/** One history per signed-in user and app: the computers' key since before this package (`sf.notifications.<user>`). */
export const historyStorageKey = (userId: string, app?: string) => (app ? `sf.notifications.${app}.${userId}` : `sf.notifications.${userId}`);
