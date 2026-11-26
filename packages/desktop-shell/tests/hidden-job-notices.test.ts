// @req UX-NOTICE-06[badger-desktop,parrot]
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createHiddenJobNotices,
  createOpenJobsRequest,
  hiddenJobNoticeText,
  systemNoticeShower,
  type NotificationClass,
} from "../src/main-shell/hiddenJobNotices";
import { createHiddenJobNoticesBridge, HIDDEN_JOB_NOTICE_CHANNELS } from "../src/main-shell/hiddenJobNoticesBridge";

const tmpFile = () => join(mkdtempSync(join(tmpdir(), "hidden-jobs-")), "system-notifications.json");

const setup = (hidden: boolean, file = tmpFile()) => {
  const show = vi.fn();
  const openJobs = vi.fn();
  const notices = createHiddenJobNotices({ file, isWindowHidden: () => hidden, language: () => "en", show, openJobs });
  return { notices, show, openJobs, file };
};

describe("hidden-job system notifications (UX-NOTICE-06)", () => {
  it("shows one system notification when a job ends while the window is hidden; the click opens Jobs", () => {
    const { notices, show, openJobs } = setup(true);
    expect(notices.jobEnded({ kind: "import", outcome: "done", name: "Holiday.mkv" })).toBe(true);
    expect(show).toHaveBeenCalledTimes(1);
    const shown = show.mock.calls[0]![0];
    expect(shown).toMatchObject({ title: "Import finished", body: "Holiday.mkv" });
    shown.onClick();
    expect(openJobs).toHaveBeenCalledTimes(1);
  });

  it("shows nothing while the window is visible (the in-app notice tells)", () => {
    const { notices, show } = setup(false);
    expect(notices.jobEnded({ kind: "download", outcome: "failed" })).toBe(false);
    expect(show).not.toHaveBeenCalled();
  });

  it("is on by default; the setting turns it off and is kept on this computer", () => {
    const { notices, show, file } = setup(true);
    expect(notices.enabled()).toBe(true);
    notices.setEnabled(false);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ hiddenJobs: false });
    expect(notices.jobEnded({ kind: "export", outcome: "done" })).toBe(false);
    expect(show).not.toHaveBeenCalled();
    expect(setup(true, file).notices.enabled()).toBe(false);
  });

  it("an unreadable settings file means on", () => {
    const file = tmpFile();
    writeFileSync(file, "{not json");
    expect(setup(true, file).notices.enabled()).toBe(true);
  });

  it("names what ended in the shared texts, in each app language", () => {
    expect(hiddenJobNoticeText("en", { kind: "download", outcome: "done", name: "Film (2020)" })).toEqual({ title: "Download ready", body: "Film (2020)" });
    expect(hiddenJobNoticeText("en", { kind: "export", outcome: "failed" })).toEqual({ title: "Job failed", body: "" });
    expect(hiddenJobNoticeText("fr", { kind: "import", outcome: "done" }).title).toBe("Import terminé");
    expect(hiddenJobNoticeText("de", { kind: "import", outcome: "done" }).title).toBe("Import abgeschlossen");
    for (const language of ["nl", "es"] as const) {
      expect(hiddenJobNoticeText(language, { kind: "import", outcome: "failed" }).title).not.toBe("Import failed");
    }
  });

  it("the system notification keeps its click handler; the test sink writes one JSON line instead", () => {
    const clicks: Array<() => void> = [];
    const shown = vi.fn();
    class FakeNotification {
      constructor(readonly options: { title: string; body: string }) {}
      on(event: "click" | "close", listener: () => void) {
        if (event === "click") clicks.push(listener);
        return this;
      }
      show() {
        shown(this.options);
      }
    }
    const onClick = vi.fn();
    systemNoticeShower(FakeNotification as unknown as NotificationClass, "")({ title: "Import finished", body: "a", onClick });
    expect(shown).toHaveBeenCalledWith({ title: "Import finished", body: "a" });
    clicks[0]!();
    expect(onClick).toHaveBeenCalledTimes(1);

    const sink = tmpFile();
    systemNoticeShower(FakeNotification as unknown as NotificationClass, sink)({ title: "Download failed", body: "b", onClick });
    expect(JSON.parse(readFileSync(sink, "utf8").trim())).toEqual({ title: "Download failed", body: "b", source: "hidden-job" });
  });

  it("a Jobs request waits for the renderer that takes it, once (a window recreated by the click too)", async () => {
    const send = vi.fn();
    const request = createOpenJobsRequest(send);
    expect(request.take()).toBe(false);
    request.request();
    expect(send).toHaveBeenCalledTimes(1);

    const listeners = new Map<string, () => void>();
    const bridge = createHiddenJobNoticesBridge({
      invoke: async (channel) => (channel === HIDDEN_JOB_NOTICE_CHANNELS.takeOpenJobs ? request.take() : null),
      on: (channel, listener) => listeners.set(channel, listener),
      removeListener: (channel) => listeners.delete(channel),
    });
    const open = vi.fn();
    const stop = bridge.onOpenJobs(open);
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    request.request();
    listeners.get(HIDDEN_JOB_NOTICE_CHANNELS.openJobs)!();
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    stop();
    expect(listeners.has(HIDDEN_JOB_NOTICE_CHANNELS.openJobs)).toBe(false);
  });
});
