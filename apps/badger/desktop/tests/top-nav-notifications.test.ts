import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNotificationStore } from "@space/desktop-shell/services/notifications";

// Dump-on-failure: surface the full store contents (ids, read flags, meta) so a
// merge/dedupe/ordering mismatch is diagnosable without rerunning. Wrapped in
// try/catch so a dump failure can never mask the real assertion.
const dumpNotificationStoreSnapshot = (
  label: string,
  store: ReturnType<typeof createNotificationStore>,
) => {
  try {
    const all = store.getAll();
    console.error(`=== [top-nav-notifications-integration:${label}] snapshot ===`);
    console.error(`count=${all.length} unread=${store.countUnread()}`);
    console.error(`items:\n${JSON.stringify(all, null, 2)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("badger notification store integration", () => {
  beforeEach(() => {
    console.info(`[top-nav-notifications-integration:setup] stubbing in-memory localStorage`);
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
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads only valid stored notifications", () => {
    console.info(`[top-nav-notifications-integration:load] seeding 1 valid + 1 malformed entry`);
    localStorage.setItem(
      "sf.notifications.user1",
      JSON.stringify([
        { id: "1", title: "Title", message: "Message", timestamp: 1, level: "info", read: false, meta: { transport: "p2p" } },
        { bad: true },
      ])
    );
    const store = createNotificationStore({ storageKey: "sf.notifications.user1" });
    console.info(
      `[top-nav-notifications-integration:load] loaded count=${store.getAll().length} firstId=${String(store.getAll()[0]?.id)}`,
    );
    if (store.getAll().length !== 1 || store.getAll()[0]?.id !== "1") {
      dumpNotificationStoreSnapshot("load", store);
    }
    expect(store.getAll()).toHaveLength(1);
    expect(store.getAll()[0]?.id).toBe("1");
  });

  it("merges incoming notifications by id and keeps newest first", () => {
    console.info(`[top-nav-notifications-integration:merge] merging 3 notifications (1 dup id)`);
    const store = createNotificationStore({ storageKey: "sf.notifications.user1" });
    store.merge({ id: "1", title: "Old", message: "Old", timestamp: 1, level: "info", read: true, meta: { transport: "p2p" } });
    store.merge({ id: "2", title: "Other", message: "Other", timestamp: 2, level: "info", read: false, meta: { transport: "p2p" } });
    store.merge({ id: "1", title: "New", message: "New", timestamp: 3, level: "success", read: false, meta: { transport: "relay" } });

    const all = store.getAll();
    console.info(
      `[top-nav-notifications-integration:merge] resulting ids=${JSON.stringify(all.map((item) => item.id))} head=${JSON.stringify(all[0])}`,
    );
    if (JSON.stringify(all.map((item) => item.id)) !== JSON.stringify(["1", "2"])) {
      dumpNotificationStoreSnapshot("merge", store);
    }
    expect(all.map((item) => item.id)).toEqual(["1", "2"]);
    expect(all[0]).toMatchObject({ title: "New", meta: { transport: "relay" }, read: false });
  });

  it("marks all as read and counts unread correctly", () => {
    console.info(`[top-nav-notifications-integration:mark-read] merging 1 unread then markAllRead`);
    const store = createNotificationStore({ storageKey: "sf.notifications.user1" });
    store.merge({ id: "1", title: "A", message: "A", timestamp: 1, level: "info", read: false });

    const unreadBefore = store.countUnread();
    if (unreadBefore !== 1) {
      dumpNotificationStoreSnapshot("mark-read-before", store);
    }
    expect(store.countUnread()).toBe(1);
    store.markAllRead();
    console.info(
      `[top-nav-notifications-integration:mark-read] unreadBefore=${unreadBefore} unreadAfter=${store.countUnread()} headRead=${String(store.getAll()[0]?.read)}`,
    );
    if (store.countUnread() !== 0 || store.getAll()[0]?.read !== true) {
      dumpNotificationStoreSnapshot("mark-read-after", store);
    }
    expect(store.countUnread()).toBe(0);
    expect(store.getAll()[0]?.read).toBe(true);
  });
});
