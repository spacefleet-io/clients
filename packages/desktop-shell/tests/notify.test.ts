/**
 * @test-id desktop-shell-notify
 * @level unit
 * @req UX-NOTICE-04[badger-desktop,parrot,parrot-web-player] @req UX-NOTICE-10[badger-desktop,parrot,parrot-web-player]
 * @req UX-NOTICE-11[badger-desktop,parrot,parrot-web-player] @req UX-NOTICE-12[badger-desktop,parrot,parrot-web-player]
 * @req UX-NOTICE-13[badger-desktop,parrot,parrot-web-player]
 * @why The computer apps and the Parrot web player say every notice through `createNotify`: it decides what the bell keeps,
 * gives a repeat the same key so it replaces itself on screen and in the bell, and reads the history saved by older
 * versions. A wrong rule here floods the bell, or loses it, on every computer at once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { badgeLabel } from "@space/notify-core/history";
import { notifyTranslator, titleText } from "@space/notify-core/texts";

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn(), dismiss: vi.fn() }),
);
vi.mock("@space/ui", () => ({ toast }));

import { createNotify, noticeKey } from "../src/services/notify";
import { createDesktopNoticeHistory, type NoticeHistory } from "../src/services/notifications";

const KEY = "test.notifications.user1";
const t = notifyTranslator("en");

const dump = (label: string, history: NoticeHistory) =>
  console.info(`[desktop-shell-notify:${label}]`, JSON.stringify({ unread: history.unreadCount(), entries: history.getAll(), stored: localStorage.getItem(KEY) }));

describe("createNotify", () => {
  beforeEach(() => {
    const backing = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => void backing.set(key, value),
      removeItem: (key: string) => void backing.delete(key),
      clear: () => backing.clear(),
    });
    for (const fn of [toast, toast.success, toast.info, toast.warning, toast.error]) fn.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("@req UX-NOTICE-10 a confirmation and a finished job only pass; a heads-up, a warning and a failed job stay in the bell", () => {
    const history = createDesktopNoticeHistory(KEY);
    const { notify, notifySuccess, notifyError, notifyWarning } = createNotify({ history, t });

    expect(notifySuccess("Saved")).toBeNull();
    expect(notify({ message: "Import finished", outcome: "done" })).toBeNull();
    expect(notify({ message: "Copied", level: "error", ephemeral: true })).toBeNull();
    const failedJob = notify({ message: { key: "notify.job.importFailed" }, outcome: "failed", key: "import-failed" });
    const warning = notifyWarning("Disk almost full");
    const heads = notify({ message: "New device" });
    const error = notifyError("Playback failed");
    dump("kept", history);

    expect(toast.success).toHaveBeenCalledWith("Saved", expect.objectContaining({ kind: "confirmation" }));
    expect(toast).toHaveBeenCalledWith("Import finished", expect.objectContaining({ kind: "job", outcome: "done" }));
    expect(toast.error).toHaveBeenCalledWith("Import failed", expect.objectContaining({ id: "import-failed", kind: "job", outcome: "failed" }));
    expect([failedJob, warning, heads, error].every(Boolean)).toBe(true);
    expect(history.getAll().map((entry) => entry.key)).toEqual(
      expect.arrayContaining(["import-failed", noticeKey("warning", undefined, "Disk almost full"), noticeKey("error", undefined, "Playback failed")]),
    );
    expect(history.getAll()).toHaveLength(4);
    expect(history.unreadCount()).toBe(4);
  });

  it("@req UX-NOTICE-11 the same notice said again replaces itself on screen and in the bell, counted once and back on top", () => {
    let clock = 1_000;
    const history = createDesktopNoticeHistory(KEY);
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const { notifyError, notifyWarning } = createNotify({ history, t });

    notifyError("Playback failed", undefined, { key: "playback-failed:stream" });
    clock += 10;
    notifyWarning("Other");
    history.markAllRead();
    clock += 10;
    notifyError("Playback failed", undefined, { key: "playback-failed:stream" });
    dump("replace", history);

    expect(toast.error).toHaveBeenCalledTimes(2);
    expect(toast.error.mock.calls.map((call) => call[1].id)).toEqual(["playback-failed:stream", "playback-failed:stream"]);
    expect(history.getAll().map((entry) => entry.key)).toEqual(["playback-failed:stream", noticeKey("warning", undefined, "Other")]);
    expect(history.unreadCount()).toBe(1);
  });

  it("@req UX-NOTICE-11 a button that leads somewhere works from the toast and is kept on the bell entry; a code button wins on screen", () => {
    const history = createDesktopNoticeHistory(KEY);
    const openTarget = vi.fn();
    const { notify } = createNotify({ history, t, openTarget });

    const entry = notify({ message: "New device", key: "new-device-1", scope: "account", action: { label: { key: "notify.open" }, target: "/settings?section=devices" } });
    const options = toast.mock.calls[0][1];
    console.info("[desktop-shell-notify:action]", JSON.stringify({ entry, label: options.action.label }));
    expect(options.action.label).toBe("Open");
    options.action.onClick();
    expect(openTarget).toHaveBeenCalledWith("/settings?section=devices");
    expect(entry).toMatchObject({ scope: "account", action: { target: "/settings?section=devices" } });

    const own = vi.fn();
    notify({ message: "Too slow", key: "abr-too-weak", action: { label: "Open", target: "/x" }, toastOptions: { action: { label: "Keep watching", onClick: own } } });
    expect(toast.mock.calls[1][1].action.label).toBe("Keep watching");
  });

  it("@req UX-NOTICE-13 the bell keeps text keys, so an entry and its default title follow a language change", () => {
    const history = createDesktopNoticeHistory(KEY);
    const { notifyError } = createNotify({ history, t });
    const entry = notifyError({ key: "notify.job.importFailed" });
    dump("language", history);
    expect(entry?.message).toEqual({ key: "notify.job.importFailed" });
    if (!entry) throw new Error("not kept");
    const fr = notifyTranslator("fr");
    console.info("[desktop-shell-notify:language]", titleText(t, entry), "->", titleText(fr, entry));
    expect(titleText(t, entry)).toBe("Error");
    expect(titleText(fr, entry)).toBe("Erreur");
  });

  it("reads the history an older version saved (Badger's plain texts, Parrot's `meta.text` keys), dropping broken entries", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([
        { id: "1", title: "Title", message: "Message", timestamp: 2, level: "info", read: false, meta: { transport: "p2p" } },
        { id: "2", title: "Import failed", message: "x", timestamp: 1, level: "error", read: true, meta: { text: { title: { key: "notifications.importFailed" } } } },
        { bad: true },
      ]),
    );
    const history = createDesktopNoticeHistory(KEY);
    dump("legacy", history);
    expect(history.getAll().map((entry) => entry.id)).toEqual(["1", "2"]);
    expect(history.getAll()[1]?.title).toEqual({ key: "notifications.importFailed" });
    expect(history.unreadCount()).toBe(1);
  });

  it("@req UX-NOTICE-12 the bell shows the unread count, 9+ above nine", () => {
    const history = createDesktopNoticeHistory(KEY);
    const { notifyError } = createNotify({ history, t });
    for (let i = 0; i < 12; i += 1) notifyError(`Failure ${i}`);
    console.info("[desktop-shell-notify:badge]", history.unreadCount(), badgeLabel(history.unreadCount()));
    expect(history.unreadCount()).toBe(12);
    expect(badgeLabel(history.unreadCount())).toBe("9+");
    expect(badgeLabel(3)).toBe("3");
    expect(badgeLabel(0)).toBeNull();
  });
});
