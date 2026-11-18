import { useSyncExternalStore } from "react";

export type NotificationLevel = "info" | "success" | "warning" | "error";

export type ShellNotification = {
  id: string;
  title: string;
  message: string;
  level: NotificationLevel;
  timestamp: number;
  read: boolean;
  meta?: Record<string, unknown>;
};

export type NotificationStoreConfig = {
  storageKey: string;
  maxNotifications?: number;
};

export type NotificationStore = {
  getAll: () => ShellNotification[];
  push: (entry: Omit<ShellNotification, "id" | "timestamp" | "read">) => ShellNotification;
  merge: (notification: ShellNotification) => void;
  markAllRead: () => void;
  remove: (id: string) => void;
  clearAll: () => void;
  countUnread: () => number;
  subscribe: (listener: () => void) => () => void;
};

const DEFAULT_MAX = 50;

const isValid = (item: unknown): item is ShellNotification => {
  if (!item || typeof item !== "object") return false;
  const n = item as Record<string, unknown>;
  return (
    typeof n.id === "string" &&
    typeof n.title === "string" &&
    typeof n.message === "string" &&
    typeof n.timestamp === "number" &&
    typeof n.read === "boolean"
  );
};

export function createNotificationStore(config: NotificationStoreConfig): NotificationStore {
  const { storageKey, maxNotifications = DEFAULT_MAX } = config;
  const listeners = new Set<() => void>();
  let cached: ShellNotification[] | null = null;

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const load = (): ShellNotification[] => {
    if (cached) return cached;
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) {
        cached = [];
        return cached;
      }
      const parsed = JSON.parse(raw) as unknown[];
      if (!Array.isArray(parsed)) {
        cached = [];
        return cached;
      }
      cached = parsed.filter(isValid).slice(0, maxNotifications);
      return cached;
    } catch {
      cached = [];
      return cached;
    }
  };

  const persist = (next: ShellNotification[]) => {
    cached = next.slice(0, maxNotifications);
    localStorage.setItem(storageKey, JSON.stringify(cached));
    notify();
  };

  const getAll = () => load();

  const push = (entry: Omit<ShellNotification, "id" | "timestamp" | "read">): ShellNotification => {
    const notification: ShellNotification = {
      ...entry,
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      read: false,
    };
    const current = load().filter((item) => item.id !== notification.id);
    persist([notification, ...current]);
    return notification;
  };

  const merge = (notification: ShellNotification) => {
    const current = load().filter((item) => item.id !== notification.id);
    persist([notification, ...current]);
  };

  const markAllRead = () => {
    const current = load();
    if (current.every((item) => item.read)) return;
    persist(current.map((item) => (item.read ? item : { ...item, read: true })));
  };

  const remove = (id: string) => {
    const current = load();
    const next = current.filter((item) => item.id !== id);
    if (next.length === current.length) return;
    persist(next);
  };

  const clearAll = () => persist([]);

  const countUnread = () => load().filter((item) => !item.read).length;

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  return { getAll, push, merge, markAllRead, remove, clearAll, countUnread, subscribe };
}

const EMPTY_NOTIFICATIONS: ShellNotification[] = [];
const NOOP_UNSUBSCRIBE = () => {};
const NOOP_SUBSCRIBE = () => NOOP_UNSUBSCRIBE;

export function useNotificationStore(store: NotificationStore | null): ShellNotification[] {
  const snapshot = store ? store.getAll : () => EMPTY_NOTIFICATIONS;
  // The same snapshot server-side, so a page that renders the tray on a server (the web player's tests) works too.
  return useSyncExternalStore(store ? store.subscribe : NOOP_SUBSCRIBE, snapshot, snapshot);
}
