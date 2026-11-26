/**
 * @test-id desktop-shell-notice-bell
 * @level component
 * @req UX-NOTICE-04[badger-desktop,parrot,parrot-web-player,badger-web-player] @req UX-NOTICE-12[badger-desktop,parrot,parrot-web-player,badger-web-player]
 * @why Every computer app and both web players draw their bell with `NoticeBell`. A wrong count, a history that never
 * marks itself seen, or an entry's button that leaves the tray open over the page it led to, shows on all of them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { createNoticeHistory, type NoticeHistory } from "@space/notify-core/history";
import { notifyTranslator } from "@space/notify-core/texts";
import { NoticeBell } from "../src/components/notice-bell";
import { render } from "./utils/render";

const t = notifyTranslator("en");

const memoryHistory = (): NoticeHistory => {
  let raw: string | null = null;
  return createNoticeHistory({ storage: { read: () => raw, write: (next) => void (raw = next) } });
};

const failure = (history: NoticeHistory, key: string) =>
  history.record({ key, kind: "job", outcome: "failed", level: "error", title: `Failed ${key}`, action: { label: { key: "notify.openJobs" }, target: "jobs" } });

describe("NoticeBell", () => {
  let history: NoticeHistory;
  beforeEach(() => {
    history = memoryHistory();
  });
  afterEach(cleanup);

  it("shows the unread count, 9+ above 9, and none once the tray was opened", async () => {
    const view = render(<NoticeBell history={history} t={t} />);
    expect(view.queryByTestId("nav-notifications-count")).toBeNull();
    act(() => {
      for (let i = 0; i < 3; i += 1) failure(history, `job-${i}`);
    });
    console.info(`[desktop-shell-notice-bell:count] unread=${history.unreadCount()} badge=${view.getByTestId("nav-notifications-count").textContent}`);
    expect(view.getByTestId("nav-notifications-count").textContent).toBe("3");
    act(() => {
      for (let i = 3; i < 12; i += 1) failure(history, `job-${i}`);
    });
    expect(view.getByTestId("nav-notifications-count").textContent).toBe("9+");
    // The tray's content is only mounted while it is open.
    expect(view.queryByTestId("notice-entry-job-0")).toBeNull();
    fireEvent.click(view.getByTestId("nav-notifications"));
    await waitFor(() => expect(view.getByTestId("notice-entry-job-0")).toBeTruthy());
    await waitFor(() => expect(history.unreadCount()).toBe(0));
    expect(view.queryByTestId("nav-notifications-count")).toBeNull();
    // One arriving while the tray is open is seen at once.
    act(() => void failure(history, "job-late"));
    await waitFor(() => expect(history.unreadCount()).toBe(0));
    console.info(`[desktop-shell-notice-bell:count] after open unread=${history.unreadCount()}`);
  });

  it("closes the tray before following an entry's button", async () => {
    const opened = vi.fn();
    failure(history, "export-1");
    const view = render(<NoticeBell history={history} t={t} onOpenTarget={opened} />);
    fireEvent.click(view.getByTestId("nav-notifications"));
    fireEvent.click(await waitFor(() => view.getByTestId("notice-entry-export-1")));
    const open = view.getByTestId("notice-entry-open-export-1");
    fireEvent.click(open);
    console.info(`[desktop-shell-notice-bell:open-target] calls=${JSON.stringify(opened.mock.calls)}`);
    expect(opened).toHaveBeenCalledWith("jobs");
    await waitFor(() => expect(view.queryByTestId("notice-entry-export-1")).toBeNull());
  });

  it("shows an empty history before sign-in", async () => {
    const view = render(<NoticeBell history={null} t={t} />);
    fireEvent.click(view.getByTestId("nav-notifications"));
    await waitFor(() => expect(document.body.textContent).toContain(t("notify.empty")));
    expect(view.queryByTestId("nav-notifications-count")).toBeNull();
  });
});
