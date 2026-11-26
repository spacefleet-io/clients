/**
 * @test-id NOTIFY-CORE-ACCOUNT-NEWS-001
 * @level unit
 * @req UX-NOTICE-05[badger-desktop,badger-mobile,badger-tv,parrot,parrot-tv,badger-web-player,parrot-web-player,web]
 * @why Chris 2026-11-26 (chat, notifications draft question 3): account news shows on every device. Every app reads
 *   it the same way (now, every minute, when it comes back to the front) through this one poller, so a failed read
 *   keeps the history as it is and a slow one is never doubled.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNoticeHistory, startAccountNewsSync, type HistoryStorage } from "../src/index";

const ID = "NOTIFY-CORE-ACCOUNT-NEWS-001";

const storage = (): HistoryStorage => {
  let raw: string | null = null;
  return { read: () => raw, write: (next) => void (raw = next) };
};

const payload = (createdAt: string) => ({
  notices: [{ id: "n1", key: "new-device-s1", level: "info", title: { key: "notify.account.newDevice" }, createdAt }],
});

describe(`[${ID}] account news sync`, () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reads now, every minute and on refresh, merging into the history; stops when asked", async () => {
    const history = createNoticeHistory({ storage: storage() });
    // Not the device's first merge: news that comes is new to it.
    history.mergeAccountNews([]);
    const fetchNews = vi.fn(async () => payload("2026-11-26T10:00:00.000Z"));
    const sync = startAccountNewsSync({ history, fetchNews });
    await vi.advanceTimersByTimeAsync(0);
    console.info(`[${ID}] after start`, JSON.stringify(history.getAll()));
    expect(fetchNews).toHaveBeenCalledTimes(1);
    expect(history.getAll().map((e) => [e.key, e.read])).toEqual([["new-device-s1", false]]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchNews).toHaveBeenCalledTimes(2);
    await sync.refresh();
    expect(fetchNews).toHaveBeenCalledTimes(3);
    sync.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchNews).toHaveBeenCalledTimes(3);
  });

  it("keeps the history when a read fails and never runs two reads at once", async () => {
    // The local job fails at 10:30Z, before the 11:00Z news, so the news lists first whatever the real clock says.
    const history = createNoticeHistory({ storage: storage(), now: () => Date.parse("2026-11-26T10:30:00.000Z") });
    history.record({ key: "job:1", kind: "job", outcome: "failed", level: "error", scope: "device" });
    const errors: string[] = [];
    let release: (value: unknown) => void = () => {};
    const fetchNews = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementation(() => new Promise((resolve) => (release = resolve)));
    const sync = startAccountNewsSync({ history, fetchNews, log: (message) => errors.push(message) });
    await vi.advanceTimersByTimeAsync(0);
    console.info(`[${ID}] after failure`, errors, JSON.stringify(history.getAll()));
    expect(errors).toEqual(["account news could not be read"]);
    expect(history.getAll().map((e) => e.key)).toEqual(["job:1"]);
    const first = sync.refresh();
    const second = sync.refresh();
    expect(fetchNews).toHaveBeenCalledTimes(2);
    release(payload("2026-11-26T11:00:00.000Z"));
    await Promise.all([first, second]);
    expect(history.getAll().map((e) => e.key)).toEqual(["new-device-s1", "job:1"]);
    sync.stop();
  });
});
