/**
 * @test-id MOBILE-SHELL-ACCOUNT-NEWS-001
 * @level unit
 * @req UX-NOTICE-05[badger-mobile,badger-tv]
 * @why Chris 2026-11-26 (notifications draft, question 3): account news shows on every device. The phone and TV shells
 *   read `GET /account/notices` with the signed-in token as soon as they have a history, every minute, and each time
 *   the app comes back to the front; signed out (no token) they read nothing, and leaving the shell stops the reads.
 */
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNoticeHistory, type HistoryStorage, type NoticeHistory } from "@space/notify-core/history";
import { useAccountNews } from "../src/account-news";

const appStateListeners = vi.hoisted(() => new Set<(state: string) => void>());
vi.mock("react-native", () => ({
  AppState: {
    addEventListener: (_type: string, listener: (state: string) => void) => {
      appStateListeners.add(listener);
      return { remove: () => appStateListeners.delete(listener) };
    },
  },
}));
vi.mock("@space/shared/api", () => ({ listAccountNotices: vi.fn() }));
const warnings = vi.hoisted(() => [] as unknown[]);
vi.mock("../src/logger", () => ({ scopeLogger: () => ({ warn: (...args: unknown[]) => warnings.push(args), info: () => undefined }) }));

const ID = "MOBILE-SHELL-ACCOUNT-NEWS-001";
const log = (...args: unknown[]) => console.info(`[${ID}]`, ...args);
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

const storage = (): HistoryStorage => {
  let raw: string | null = null;
  return { read: () => raw, write: (next) => void (raw = next) };
};

const news = (sessionId: string, createdAt: string) => ({
  notices: [
    {
      id: `session:${sessionId}`,
      key: `new-device-${sessionId}`,
      level: "info",
      title: { key: "notify.account.newDevice" },
      message: { key: "notify.account.newDeviceMessage", vars: { name: "Salon", type: { key: "notify.account.deviceType.tv" } } },
      action: { label: { key: "notify.account.openDevices" }, target: "devices" },
      createdAt,
    },
  ],
});

const Shell = ({ history, token, fetchNotices }: { history: NoticeHistory; token: string | null; fetchNotices: (token: string) => Promise<unknown> }) => {
  useAccountNews(history, token, fetchNotices);
  return null;
};

describe(`[${ID}] the phone and TV read the account's news`, () => {
  let tree: ReactTestRenderer | null = null;
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    act(() => tree?.unmount());
    tree = null;
    appStateListeners.clear();
    warnings.length = 0;
    vi.useRealTimers();
  });

  it("reads at once with the token, every minute and on return to the front, then stops when the shell leaves", async () => {
    const history = createNoticeHistory({ storage: storage() });
    // Not this device's first merge: news that comes is new to it.
    history.mergeAccountNews([]);
    const fetchNotices = vi.fn(async (_token: string) => news("s-salon", "2026-11-26T10:00:00.000Z"));
    act(() => {
      tree = create(<Shell history={history} token="tok-1" fetchNotices={fetchNotices} />);
    });
    await advance(0);
    log("after first read", JSON.stringify(history.getAll().map((e) => ({ key: e.key, read: e.read, message: e.message }))));
    expect(fetchNotices).toHaveBeenCalledWith("tok-1");
    expect(history.getAll().map((e) => [e.key, e.read])).toEqual([["new-device-s-salon", false]]);
    expect(history.unreadCount()).toBe(1);

    await advance(60_000);
    expect(fetchNotices).toHaveBeenCalledTimes(2);
    await act(async () => {
      for (const listener of appStateListeners) listener("background");
      for (const listener of appStateListeners) listener("active");
      await vi.advanceTimersByTimeAsync(0);
    });
    log("reads after the app came back", fetchNotices.mock.calls.length);
    expect(fetchNotices).toHaveBeenCalledTimes(3);

    act(() => tree?.unmount());
    tree = null;
    expect(appStateListeners.size).toBe(0);
    await advance(180_000);
    expect(fetchNotices).toHaveBeenCalledTimes(3);
  });

  it("reads nothing signed out, and a failed read keeps the history and is logged", async () => {
    const history = createNoticeHistory({ storage: storage() });
    history.mergeAccountNews([]);
    const fetchNotices = vi.fn<(token: string) => Promise<unknown>>().mockRejectedValueOnce(new Error("offline"));
    act(() => {
      tree = create(<Shell history={history} token={null} fetchNotices={fetchNotices} />);
    });
    await advance(60_000);
    expect(fetchNotices).not.toHaveBeenCalled();

    act(() => tree?.update(<Shell history={history} token="tok-2" fetchNotices={fetchNotices} />));
    await advance(0);
    log("after a failed read", JSON.stringify(warnings), history.getAll().length);
    expect(fetchNotices).toHaveBeenCalledWith("tok-2");
    expect(history.getAll()).toEqual([]);
    expect(warnings).toHaveLength(1);
  });
});
