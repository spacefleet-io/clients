/**
 * @test-id badger-desktop-notice-history
 * @level integration
 * @req UX-NOTICE-04[badger-desktop] @req UX-NOTICE-12[badger-desktop]
 * @why Badger's bell reads the signed-in user's history under `sf.notifications.<user>`, the key older versions saved
 * it under: a different key or an unreadable old entry would empty everyone's bell on update.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDesktopNoticeHistory, type NoticeHistory } from "@space/desktop-shell/services/notifications";
import { badgeLabel, historyStorageKey } from "@space/notify-core/history";

const dump = (label: string, history: NoticeHistory) =>
  console.info(`[badger-desktop-notice-history:${label}]`, JSON.stringify({ unread: history.unreadCount(), entries: history.getAll() }));

describe("badger notice history", () => {
  beforeEach(() => {
    const backing = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => void backing.set(key, value),
      removeItem: (key: string) => void backing.delete(key),
      clear: () => backing.clear(),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("@req UX-NOTICE-04 keeps the key older versions used and reads their entries", () => {
    expect(historyStorageKey("user1")).toBe("sf.notifications.user1");
    localStorage.setItem(
      "sf.notifications.user1",
      JSON.stringify([
        { id: "1", title: "Title", message: "Message", timestamp: 1, level: "info", read: false, meta: { transport: "p2p" } },
        { bad: true },
      ]),
    );
    const history = createDesktopNoticeHistory(historyStorageKey("user1"));
    dump("legacy", history);
    expect(history.getAll()).toHaveLength(1);
    expect(history.getAll()[0]).toMatchObject({ id: "1", key: "1", title: "Title", message: "Message", read: false });
  });

  it("@req UX-NOTICE-12 the bell counts unread entries, 9+ above nine, and opening it reads them all", () => {
    const history = createDesktopNoticeHistory(historyStorageKey("user1"));
    for (let i = 0; i < 10; i += 1) history.record({ key: `k${i}`, kind: "headsUp", level: "warning", message: `m${i}` });
    dump("count", history);
    expect(badgeLabel(history.unreadCount())).toBe("9+");
    history.markAllRead();
    expect(badgeLabel(history.unreadCount())).toBeNull();
    // Saved, so the next start shows the same bell.
    expect(createDesktopNoticeHistory(historyStorageKey("user1")).getAll()).toHaveLength(10);
  });
});
