/**
 * @test-id NOTIFY-CORE-HISTORY-001
 * @level unit
 * @req UX-NOTICE-04[badger-desktop,badger-mobile,badger-tv,parrot,parrot-tv,badger-web-player,parrot-web-player,web]
 * @req UX-NOTICE-05[badger-desktop,badger-mobile,badger-tv,parrot,parrot-tv,badger-web-player,parrot-web-player,web]
 * @req UX-NOTICE-10[badger-desktop,badger-mobile,badger-tv,parrot,parrot-tv,badger-web-player,parrot-web-player]
 * @req UX-NOTICE-11[badger-desktop,badger-mobile,badger-tv,parrot,parrot-tv,badger-web-player,parrot-web-player]
 * @req UX-NOTICE-12[badger-desktop,badger-mobile,badger-tv,parrot,parrot-tv,badger-web-player,parrot-web-player,web]
 * @why Chris 2026-11-26 (chat, notifications draft questions 2, 3, 8, 9 and 10): every app keeps the notices it showed
 *   behind a bell with an unread number; account news is shared, device messages stay; only failed jobs are kept; a
 *   repeat replaces its earlier entry. The shared history store is where those rules live for every app.
 */
import { describe, expect, it } from "vitest";
import {
  accountNewsEntries,
  asyncStorageHistory,
  badgeLabel,
  createNoticeHistory,
  historyStorageKey,
  type HistoryEntry,
  type HistoryStorage,
  type Notice,
} from "../src/index";

const ID = "NOTIFY-CORE-HISTORY-001";
const log = (event: string, payload: Record<string, unknown>) => console.info(`[${ID}] ${event}`, JSON.stringify(payload));

const memory = (initial: string | null = null) => {
  const box = { raw: initial, writes: 0 };
  const storage: HistoryStorage = {
    read: () => box.raw,
    write: (raw) => {
      box.raw = raw;
      box.writes++;
    },
  };
  return { box, storage };
};

const clock = () => {
  let t = 1_000;
  return () => (t += 1_000);
};

const setup = (initial: string | null = null, max?: number) => {
  const { box, storage } = memory(initial);
  let n = 0;
  const history = createNoticeHistory({ storage, max, now: clock(), newId: () => `id-${++n}`, log });
  return { box, history, keys: () => history.getAll().map((e) => e.key) };
};

const failed: Notice = { key: "job:7", kind: "job", outcome: "failed", level: "error", message: { key: "notify.job.importFailed" }, target: "jobs:7" };

describe("notice history (UX-NOTICE-04, -05, -10, -11, -12)", () => {
  it("keeps heads-ups, the start of a lasting state and failed jobs; never confirmations, decisions or finished jobs", () => {
    const { history, keys } = setup();
    expect(history.record({ key: "saved", kind: "confirmation", level: "success" })).toBeNull();
    expect(history.record({ key: "delete?", kind: "decision", level: "warning" })).toBeNull();
    expect(history.record({ key: "job:6", kind: "job", outcome: "done", level: "success" })).toBeNull();
    history.record({ key: "device:tv", kind: "headsUp", level: "info", scope: "account" });
    history.record({ key: "unpaid", kind: "lasting", level: "warning", scope: "account" });
    history.record(failed);
    console.info(`[${ID}] kept`, JSON.stringify(history.getAll()));
    expect(keys()).toEqual(["job:7", "unpaid", "device:tv"]);
    expect(history.getAll()[0]).toMatchObject({ target: "jobs:7", scope: "device", read: false });
  });

  it("replaces a repeat: moves it to the top, counts it once and makes it unread again", () => {
    const { history, keys } = setup();
    history.record({ key: "play-failed:42:codec", kind: "headsUp", level: "error", message: "first" });
    history.record({ key: "other", kind: "headsUp", level: "info" });
    history.markAllRead();
    expect(history.unreadCount()).toBe(0);
    console.info(`[${ID}] phase same failure again`);
    history.record({ key: "play-failed:42:codec", kind: "headsUp", level: "error", message: "second" });
    expect(keys()).toEqual(["play-failed:42:codec", "other"]);
    expect(history.getAll()[0]).toMatchObject({ message: "second", read: false });
    expect(history.unreadCount()).toBe(1);
  });

  it("keeps a button's action on the entry so it still works from the history", () => {
    const { history } = setup();
    const action = { label: { key: "app.keepWatching" }, target: "player:keep" };
    history.record({ key: "too-slow", kind: "headsUp", level: "warning", action });
    expect(history.getAll()[0]?.action).toEqual(action);
  });

  it("keeps the last 50, newest first", () => {
    const { history } = setup();
    for (let i = 0; i < 60; i++) history.record({ key: `k${i}`, kind: "headsUp", level: "info" });
    expect(history.getAll()).toHaveLength(50);
    expect(history.getAll()[0]?.key).toBe("k59");
    expect(history.getAll()[49]?.key).toBe("k10");
  });

  it("saves text keys, not words, so the history follows a language change", () => {
    const { history, box } = setup();
    history.record(failed);
    const saved = JSON.parse(box.raw ?? "{}") as { entries: HistoryEntry[] };
    console.info(`[${ID}] saved`, box.raw);
    expect(saved.entries[0]?.message).toEqual({ key: "notify.job.importFailed" });
  });

  it("reads the computers' history from before this package, Parrot's text keys included", () => {
    const legacy = JSON.stringify([
      { id: "a", title: "Error", message: "Upload failed", level: "error", timestamp: 5, read: false },
      {
        id: "b",
        title: "Import done",
        message: "x",
        level: "success",
        timestamp: 4,
        read: true,
        meta: { text: { title: { key: "importDoneTitle" }, message: { key: "importDoneBody", vars: { count: 3 } } } },
      },
      { nonsense: true },
    ]);
    const { history } = setup(legacy);
    console.info(`[${ID}] migrated`, JSON.stringify(history.getAll()));
    expect(history.getAll()).toEqual([
      { id: "a", key: "a", kind: "headsUp", level: "error", scope: "device", title: "Error", message: "Upload failed", timestamp: 5, read: false },
      {
        id: "b",
        key: "b",
        kind: "headsUp",
        level: "success",
        scope: "device",
        title: { key: "importDoneTitle" },
        message: { key: "importDoneBody", vars: { count: 3 } },
        timestamp: 4,
        read: true,
      },
    ]);
  });

  it("does not overwrite slow storage: entries recorded while it loads come first and the saved ones follow", async () => {
    const saved = JSON.stringify([{ id: "old", key: "old", kind: "headsUp", level: "info", scope: "device", timestamp: 10, read: true }]);
    const backing = new Map<string, string>([["sf.notifications.u1", saved]]);
    const writes: string[] = [];
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const storage = asyncStorageHistory(
      {
        getItem: async (key) => {
          await gate;
          return backing.get(key) ?? null;
        },
        setItem: async (key, value) => {
          writes.push(value);
          backing.set(key, value);
        },
      },
      historyStorageKey("u1"),
    );
    const history = createNoticeHistory({ storage, now: () => 20, newId: () => "new", log });
    history.record({ key: "device:phone", kind: "headsUp", level: "info" });
    expect(writes).toEqual([]);
    release();
    await history.ready;
    console.info(`[${ID}] after load`, JSON.stringify(history.getAll()));
    expect(history.getAll().map((e) => e.id)).toEqual(["new", "old"]);
    expect(JSON.parse(backing.get("sf.notifications.u1") ?? "{}").entries).toHaveLength(2);
  });

  it("merges account news from the server beside device messages, keeping what was read here", () => {
    const { history, keys } = setup();
    // This device already merged once (with no news yet), so what comes next is new to it.
    history.mergeAccountNews([]);
    history.record({ key: "device:tv", kind: "headsUp", level: "info", scope: "account" });
    history.record(failed);
    history.markAllRead();
    const news: HistoryEntry[] = [
      { id: "srv-1", key: "device:tv", kind: "headsUp", level: "info", scope: "account", timestamp: 1_500, read: false },
      { id: "srv-2", key: "payment:jan", kind: "headsUp", level: "success", scope: "account", timestamp: 9_000, read: false },
    ];
    history.mergeAccountNews(news);
    console.info(`[${ID}] merged`, JSON.stringify(history.getAll()));
    expect(keys()).toEqual(["payment:jan", "job:7", "device:tv"]);
    expect(history.getAll().find((e) => e.key === "device:tv")).toMatchObject({ id: "srv-1", read: true, scope: "account" });
    expect(history.getAll().find((e) => e.key === "job:7")?.scope).toBe("device");
    expect(history.unreadCount()).toBe(1);
  });

  it("brings account news in read on a device's first merge: it happened before the device was there", () => {
    const { history } = setup();
    history.mergeAccountNews([{ id: "srv-1", key: "payment:jan", kind: "headsUp", level: "success", scope: "account", timestamp: 9_000, read: false }]);
    console.info(`[${ID}] first merge`, JSON.stringify(history.getAll()));
    expect(history.getAll()).toHaveLength(1);
    expect(history.unreadCount()).toBe(0);
  });

  it("never brings back account news removed or cleared here; a repeat the server bumped comes back unread", () => {
    const { history, box } = setup();
    history.mergeAccountNews([]);
    const news: HistoryEntry[] = [
      { id: "srv-1", key: "new-device-s1", kind: "headsUp", level: "info", scope: "account", timestamp: 5_000, read: false },
      { id: "srv-2", key: "payment-p1", kind: "headsUp", level: "success", scope: "account", timestamp: 6_000, read: false },
    ];
    history.mergeAccountNews(news);
    expect(history.unreadCount()).toBe(2);
    history.removeKey("new-device-s1");
    history.clearAll();
    history.mergeAccountNews(news);
    console.info(`[${ID}] after clear and poll`, box.raw);
    expect(history.getAll()).toEqual([]);
    // The same device signed in again: the server's row moved up with a newer time.
    history.mergeAccountNews([{ ...news[0]!, timestamp: 7_000 }, news[1]!]);
    expect(history.getAll().map((e) => [e.key, e.read])).toEqual([["new-device-s1", false]]);
    expect(JSON.parse(box.raw ?? "{}").accountSyncedAt).toBe(7_000);
  });

  it("keeps the merge mark across restarts and wakes nobody when a poll brings nothing new", () => {
    const first = setup();
    first.history.mergeAccountNews([{ id: "srv-1", key: "payment-p1", kind: "headsUp", level: "success", scope: "account", timestamp: 6_000, read: false }]);
    first.history.clearAll();
    const again = setup(first.box.raw);
    let changes = 0;
    again.history.subscribe(() => changes++);
    const writes = again.box.writes;
    again.history.mergeAccountNews([{ id: "srv-1", key: "payment-p1", kind: "headsUp", level: "success", scope: "account", timestamp: 6_000, read: false }]);
    console.info(`[${ID}] restarted`, again.box.raw);
    expect(again.history.getAll()).toEqual([]);
    expect(changes).toBe(0);
    expect(again.box.writes).toBe(writes);
  });

  it("reads the server's account news payload, dropping what it cannot read", () => {
    const entries = accountNewsEntries({
      notices: [
        {
          id: "n1",
          key: "new-device-s1",
          level: "info",
          title: { key: "notify.account.newDevice" },
          message: { key: "notify.account.newDeviceMessage", vars: { name: "Den", type: { key: "notify.account.deviceType.tv" } } },
          action: { label: { key: "notify.account.openDevices" }, target: "devices" },
          createdAt: "2026-11-26T10:00:00.000Z",
        },
        { id: "n2", key: "bad", level: "info", createdAt: "not a date" },
        "junk",
      ],
    });
    console.info(`[${ID}] wire`, JSON.stringify(entries));
    expect(entries).toEqual([
      {
        id: "n1",
        key: "new-device-s1",
        kind: "headsUp",
        level: "info",
        scope: "account",
        title: { key: "notify.account.newDevice" },
        message: { key: "notify.account.newDeviceMessage", vars: { name: "Den", type: { key: "notify.account.deviceType.tv" } } },
        action: { label: { key: "notify.account.openDevices" }, target: "devices" },
        target: "devices",
        timestamp: Date.parse("2026-11-26T10:00:00.000Z"),
        read: false,
      },
    ]);
    expect(accountNewsEntries(null)).toEqual([]);
  });

  it("marks read, removes, takes back by key and clears, notifying once per change", () => {
    const { history } = setup();
    let changes = 0;
    history.subscribe(() => changes++);
    const a = history.record({ key: "a", kind: "headsUp", level: "info" });
    history.record({ key: "b", kind: "headsUp", level: "info" });
    history.markRead(a?.id ?? "");
    expect(history.unreadCount()).toBe(1);
    const before = history.getAll();
    history.markRead(a?.id ?? "");
    expect(history.getAll()).toBe(before);
    history.removeKey("b");
    history.remove(a?.id ?? "");
    history.clearAll();
    expect(history.getAll()).toEqual([]);
    expect(changes).toBe(5);
  });

  it('shows the bell number as a count and "9+" above 9 (UX-NOTICE-12)', () => {
    expect([0, 1, 9, 10, 51].map(badgeLabel)).toEqual([null, "1", "9", "9+", "9+"]);
  });
});
