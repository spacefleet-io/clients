import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNotificationStore } from "../src/services/notifications";

type NotificationStore = ReturnType<typeof createNotificationStore>;

const dumpNotificationStoreSnapshot = (
  label: string,
  ctx: { storageKey?: string; store?: NotificationStore }
) => {
  try {
    const rawLocal: Record<string, string> = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k !== null) rawLocal[k] = localStorage.getItem(k) ?? "";
      }
    } catch (innerErr) {
      console.error(
        `(localStorage iteration failed: ${innerErr instanceof Error ? innerErr.message : String(innerErr)})`
      );
    }
    const all = ctx.store ? ctx.store.getAll() : "(no store handle)";
    const unread = ctx.store ? ctx.store.countUnread() : "(no store handle)";
    console.error(`=== [notification-store:${label}] snapshot ===`);
    console.error(`storageKey=${ctx.storageKey ?? "(unknown)"}`);
    console.error(`store.countUnread()=${JSON.stringify(unread)}`);
    console.error(`store.getAll()=${JSON.stringify(all, null, 2)}`);
    console.error(`localStorage contents=${JSON.stringify(rawLocal, null, 2)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

const STORAGE_KEY = "test.notifications";

describe("notification store", () => {
  console.info("[notification-store:suite] starting notification store tests");

  beforeEach(() => {
    console.info("[notification-store:setup] stubbing localStorage and crypto.randomUUID");
    const backing = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => {
        backing.set(key, value);
      },
      removeItem: (key: string) => {
        backing.delete(key);
      },
      clear: () => backing.clear(),
      get length() {
        return backing.size;
      },
      key: (index: number) => Array.from(backing.keys())[index] ?? null,
    });
    // length + key added solely so dump-helpers can iterate localStorage on failure;
    // production reads/writes use only get/setItem so behavior is unchanged.
    vi.stubGlobal("crypto", { randomUUID: () => "test-uuid-1" });
  });

  afterEach(() => {
    console.info("[notification-store:teardown] unstubbing globals");
    vi.unstubAllGlobals();
  });

  it("starts empty", () => {
    console.info("[notification-store:test] starts-empty — creating store");
    const store = createNotificationStore({ storageKey: STORAGE_KEY });
    const all = store.getAll();
    const unread = store.countUnread();
    console.info(`[notification-store:test] starts-empty — getAll=${JSON.stringify(all)} unread=${unread}`);

    try {
      expect(all).toEqual([]);
      expect(unread).toBe(0);
    } catch (err) {
      dumpNotificationStoreSnapshot("starts-empty-fail", { storageKey: STORAGE_KEY, store });
      throw err;
    }
  });

  it("pushes a notification with auto-generated id and timestamp", () => {
    console.info("[notification-store:test] push — creating store");
    const store = createNotificationStore({ storageKey: STORAGE_KEY });
    const input = { title: "Hello", message: "World", level: "info" as const };
    console.info(`[notification-store:test] push — input=${JSON.stringify(input)}`);
    const result = store.push(input);
    console.info(`[notification-store:test] push — result=${JSON.stringify(result)}`);

    try {
      expect(result.id).toBe("test-uuid-1");
      expect(result.read).toBe(false);
      expect(result.title).toBe("Hello");
      expect(store.getAll()).toHaveLength(1);
      expect(store.countUnread()).toBe(1);
    } catch (err) {
      dumpNotificationStoreSnapshot("push-fail", { storageKey: STORAGE_KEY, store });
      throw err;
    }
  });

  it("merges an externally-created notification", () => {
    console.info("[notification-store:test] merge-external — creating store");
    const store = createNotificationStore({ storageKey: STORAGE_KEY });
    const payload = {
      id: "external-1",
      title: "P2P",
      message: "Arrived",
      level: "success" as const,
      timestamp: 1000,
      read: false,
      meta: { code: "SYNC", transport: "p2p" },
    };
    console.info(`[notification-store:test] merge-external — payload=${JSON.stringify(payload)}`);
    store.merge(payload);

    const all = store.getAll();
    console.info(`[notification-store:test] merge-external — after-merge getAll=${JSON.stringify(all)}`);

    try {
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe("external-1");
      expect(all[0].meta?.code).toBe("SYNC");
    } catch (err) {
      dumpNotificationStoreSnapshot("merge-external-fail", { storageKey: STORAGE_KEY, store });
      throw err;
    }
  });

  it("deduplicates on merge by id", () => {
    console.info("[notification-store:test] dedup-merge — creating store");
    const store = createNotificationStore({ storageKey: STORAGE_KEY });
    console.info("[notification-store:test] dedup-merge — first merge id=dup title=A");
    store.merge({ id: "dup", title: "A", message: "1", level: "info", timestamp: 1, read: false });
    console.info("[notification-store:test] dedup-merge — second merge id=dup title=B");
    store.merge({ id: "dup", title: "B", message: "2", level: "info", timestamp: 2, read: false });

    const all = store.getAll();
    console.info(`[notification-store:test] dedup-merge — after-merges getAll=${JSON.stringify(all)}`);

    try {
      expect(all).toHaveLength(1);
      expect(all[0].title).toBe("B");
    } catch (err) {
      dumpNotificationStoreSnapshot("dedup-merge-fail", { storageKey: STORAGE_KEY, store });
      throw err;
    }
  });

  it("marks all as read", () => {
    console.info("[notification-store:test] mark-all-read — creating store + seeding 2 unread");
    const store = createNotificationStore({ storageKey: STORAGE_KEY });
    store.merge({ id: "a", title: "A", message: "1", level: "info", timestamp: 1, read: false });
    store.merge({ id: "b", title: "B", message: "2", level: "error", timestamp: 2, read: false });

    const unreadBefore = store.countUnread();
    console.info(`[notification-store:test] mark-all-read — unreadBefore=${unreadBefore}`);

    try {
      expect(unreadBefore).toBe(2);
    } catch (err) {
      dumpNotificationStoreSnapshot("mark-all-read-precheck-fail", { storageKey: STORAGE_KEY, store });
      throw err;
    }

    console.info("[notification-store:test] mark-all-read — invoking markAllRead()");
    store.markAllRead();
    const unreadAfter = store.countUnread();
    const all = store.getAll();
    console.info(`[notification-store:test] mark-all-read — unreadAfter=${unreadAfter} all=${JSON.stringify(all)}`);

    try {
      expect(unreadAfter).toBe(0);
      expect(all.every((n) => n.read)).toBe(true);
    } catch (err) {
      dumpNotificationStoreSnapshot("mark-all-read-fail", { storageKey: STORAGE_KEY, store });
      throw err;
    }
  });

  it("removes a notification by id", () => {
    console.info("[notification-store:test] remove-by-id — creating store + seeding 2");
    const store = createNotificationStore({ storageKey: STORAGE_KEY });
    store.merge({ id: "a", title: "A", message: "1", level: "info", timestamp: 1, read: false });
    store.merge({ id: "b", title: "B", message: "2", level: "info", timestamp: 2, read: false });

    console.info("[notification-store:test] remove-by-id — removing id=a");
    store.remove("a");
    const all = store.getAll();
    console.info(`[notification-store:test] remove-by-id — after-remove getAll=${JSON.stringify(all)}`);

    try {
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe("b");
    } catch (err) {
      dumpNotificationStoreSnapshot("remove-by-id-fail", { storageKey: STORAGE_KEY, store });
      throw err;
    }
  });

  it("clears all notifications", () => {
    console.info("[notification-store:test] clear-all — creating store + seeding 1");
    const store = createNotificationStore({ storageKey: STORAGE_KEY });
    store.merge({ id: "a", title: "A", message: "1", level: "info", timestamp: 1, read: false });
    console.info("[notification-store:test] clear-all — invoking clearAll()");
    store.clearAll();
    const all = store.getAll();
    console.info(`[notification-store:test] clear-all — after-clear getAll=${JSON.stringify(all)}`);

    try {
      expect(all).toEqual([]);
    } catch (err) {
      dumpNotificationStoreSnapshot("clear-all-fail", { storageKey: STORAGE_KEY, store });
      throw err;
    }
  });

  it("respects maxNotifications cap", () => {
    const maxNotifications = 3;
    const seedCount = 5;
    console.info(
      `[notification-store:test] cap — creating store with maxNotifications=${maxNotifications}, seeding ${seedCount}`
    );
    const store = createNotificationStore({ storageKey: STORAGE_KEY, maxNotifications });
    for (let i = 0; i < seedCount; i++) {
      store.merge({
        id: `n${i}`,
        title: `T${i}`,
        message: `M${i}`,
        level: "info",
        timestamp: i,
        read: false,
      });
    }
    const all = store.getAll();
    console.info(`[notification-store:test] cap — final length=${all.length} ids=${all.map((n) => n.id).join(",")}`);

    try {
      expect(all).toHaveLength(maxNotifications);
    } catch (err) {
      dumpNotificationStoreSnapshot("cap-fail", { storageKey: STORAGE_KEY, store });
      throw err;
    }
  });

  it("persists to localStorage", () => {
    console.info("[notification-store:test] persist — creating store + merging id=a");
    const store = createNotificationStore({ storageKey: STORAGE_KEY });
    store.merge({ id: "a", title: "A", message: "1", level: "info", timestamp: 1, read: false });

    const raw = localStorage.getItem(STORAGE_KEY);
    console.info(`[notification-store:test] persist — raw localStorage value=${raw}`);

    try {
      expect(raw).toBeTruthy();
      const parsed = JSON.parse(raw!);
      console.info(`[notification-store:test] persist — parsed=${JSON.stringify(parsed)}`);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].id).toBe("a");
    } catch (err) {
      dumpNotificationStoreSnapshot("persist-fail", { storageKey: STORAGE_KEY, store });
      throw err;
    }
  });

  it("loads from existing localStorage data", () => {
    const seed = [{ id: "x", title: "X", message: "msg", level: "warning", timestamp: 999, read: true }];
    console.info(`[notification-store:test] load-existing — seeding localStorage with ${JSON.stringify(seed)}`);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seed));
    const store = createNotificationStore({ storageKey: STORAGE_KEY });
    const all = store.getAll();
    const unread = store.countUnread();
    console.info(
      `[notification-store:test] load-existing — getAll=${JSON.stringify(all)} unread=${unread}`
    );

    try {
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe("x");
      expect(unread).toBe(0);
    } catch (err) {
      dumpNotificationStoreSnapshot("load-existing-fail", { storageKey: STORAGE_KEY, store });
      throw err;
    }
  });

  it("notifies subscribers on changes", () => {
    console.info("[notification-store:test] subscribe — creating store + subscribing");
    const store = createNotificationStore({ storageKey: STORAGE_KEY });
    const listener = vi.fn();
    const unsub = store.subscribe(listener);

    console.info("[notification-store:test] subscribe — merge id=a (expect listener call 1)");
    store.merge({ id: "a", title: "A", message: "1", level: "info", timestamp: 1, read: false });
    console.info(`[notification-store:test] subscribe — listener.mock.calls.length=${listener.mock.calls.length}`);

    try {
      expect(listener).toHaveBeenCalledTimes(1);
    } catch (err) {
      dumpNotificationStoreSnapshot("subscribe-call1-fail", { storageKey: STORAGE_KEY, store });
      throw err;
    }

    console.info("[notification-store:test] subscribe — markAllRead (expect listener call 2)");
    store.markAllRead();
    console.info(`[notification-store:test] subscribe — listener.mock.calls.length=${listener.mock.calls.length}`);

    try {
      expect(listener).toHaveBeenCalledTimes(2);
    } catch (err) {
      dumpNotificationStoreSnapshot("subscribe-call2-fail", { storageKey: STORAGE_KEY, store });
      throw err;
    }

    console.info("[notification-store:test] subscribe — unsubscribing then clearAll (expect no further calls)");
    unsub();
    store.clearAll();
    console.info(`[notification-store:test] subscribe — final listener.mock.calls.length=${listener.mock.calls.length}`);

    try {
      expect(listener).toHaveBeenCalledTimes(2);
    } catch (err) {
      dumpNotificationStoreSnapshot("subscribe-after-unsub-fail", { storageKey: STORAGE_KEY, store });
      throw err;
    }
  });

  it("filters out invalid entries from localStorage", () => {
    const seed = [
      { id: "valid", title: "V", message: "m", level: "info", timestamp: 1, read: false },
      { id: 123, title: "bad" },
      null,
      "garbage",
    ];
    console.info(`[notification-store:test] filter-invalid — seeding ${JSON.stringify(seed)}`);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seed));
    const store = createNotificationStore({ storageKey: STORAGE_KEY });
    const all = store.getAll();
    console.info(`[notification-store:test] filter-invalid — getAll=${JSON.stringify(all)}`);

    try {
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe("valid");
    } catch (err) {
      dumpNotificationStoreSnapshot("filter-invalid-fail", { storageKey: STORAGE_KEY, store });
      throw err;
    }
  });
});
