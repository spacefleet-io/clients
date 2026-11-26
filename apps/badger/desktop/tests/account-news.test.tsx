// @vitest-environment jsdom
/**
 * @test-id BADGER-DESKTOP-ACCOUNT-NEWS-001
 * @level unit
 * @req UX-NOTICE-05[badger-desktop]
 * @why Chris 2026-11-26 (chat, notifications draft question 3): account news (a device signed in, a payment, storage
 *   over its limit) shows in every device's bell, whichever device it happened on. The computer app reads it from the
 *   api when it starts, every minute and when its window comes back, and its button opens the matching Settings section.
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDesktopNoticeHistory, type NoticeHistory } from "@space/desktop-shell/services/notifications";

const ID = "BADGER-DESKTOP-ACCOUNT-NEWS-001";

const h = vi.hoisted(() => ({
  calls: [] as string[],
  visibility: null as ((state: { hidden: boolean }) => void) | null,
}));

vi.mock("@/api", () => ({
  listAccountNotices: async (token: string) => {
    h.calls.push(token);
    return {
      notices: [
        {
          id: "session:s-tv",
          key: "new-device-s-tv",
          level: "info",
          title: { key: "notify.account.newDevice" },
          message: { key: "notify.account.newDeviceMessage", vars: { name: "Salon", type: { key: "notify.account.deviceType.tv" } } },
          action: { label: { key: "notify.account.openDevices" }, target: "devices" },
          createdAt: "2026-11-26T10:00:00.000Z",
        },
      ],
    };
  },
}));
vi.mock("@/lib/appWindowVisibility", () => ({
  subscribeAppWindowVisibility: (listener: (state: { hidden: boolean }) => void) => {
    h.visibility = listener;
    return () => {
      h.visibility = null;
    };
  },
}));
vi.mock("@/logger", () => {
  const logger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined, child: () => logger };
  return { rendererLogger: logger };
});

import { noticeTargetPath, useAccountNews } from "../src/renderer/src/lib/accountNews";

function Probe({ history, token }: { history: NoticeHistory; token: string | null }) {
  useAccountNews(history, token);
  return null;
}

describe(`[${ID}] account news in the computer app's bell`, () => {
  let root: Root;
  let host: HTMLDivElement;
  beforeEach(() => {
    window.localStorage.clear();
    h.calls = [];
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("merges the account's news on start, on focus and when the window shows again; stops when signed out", async () => {
    const history = createDesktopNoticeHistory("sf.notifications.u1");
    // Not this computer's first read: news that comes is new here.
    history.mergeAccountNews([]);
    await act(async () => root.render(<Probe history={history} token="tok" />));
    console.info(`[${ID}] after start`, JSON.stringify(history.getAll()));
    expect(h.calls).toEqual(["tok"]);
    expect(history.getAll()).toMatchObject([{ key: "new-device-s-tv", scope: "account", target: "devices", read: false }]);
    expect(history.unreadCount()).toBe(1);

    await act(async () => window.dispatchEvent(new Event("focus")));
    await act(async () => h.visibility?.({ hidden: false }));
    await act(async () => h.visibility?.({ hidden: true }));
    console.info(`[${ID}] calls`, h.calls);
    expect(h.calls).toEqual(["tok", "tok", "tok"]);
    // The same news again changes nothing: one entry, still unread.
    expect(history.getAll()).toHaveLength(1);

    await act(async () => root.render(<Probe history={history} token={null} />));
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(h.calls).toHaveLength(3);
  });

  it("opens the Settings section of each account target and leaves app routes as they are", () => {
    const paths = ["devices", "billing", "storage", "/library"].map(noticeTargetPath);
    console.info(`[${ID}] paths`, paths);
    expect(paths).toEqual(["/settings?section=devices", "/settings?section=account", "/settings?section=account", "/library"]);
  });
});
