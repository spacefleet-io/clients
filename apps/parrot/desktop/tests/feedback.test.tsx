// @vitest-environment jsdom
/**
 * Parrot desktop's "Send feedback" (UX-SUP-05) matches Badger: an "Attach the app's error log" tick, unticked by
 * default, and the log goes along only when ticked, scrubbed (REL-LOG-06) and clamped to the API's 200 KiB.
 * Main's sender runs with the real shared error log; only the API call is recorded. The form is the real component
 * with `window.parrot` mocked.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createErrorLog, FEEDBACK_LOG_MAX_BYTES } from "@space/error-report/error-log";
import type { FeedbackInput } from "@space/shared/api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "[parrot-feedback]";

vi.mock("@space/ui", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { size?: string; variant?: string }) => {
    const { size: _size, variant: _variant, ...rest } = props;
    return <button {...rest}>{children}</button>;
  },
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Spinner: () => <span />,
}));

import { createDesktopFeedbackSender } from "@space/error-report/desktop-feedback";
import { Feedback } from "../src/renderer/src/Library";
import { translator } from "../src/renderer/src/i18n";

const SECRET_EMAIL = "alice.secret@example.com";
const SECRET_PATH = "/home/alice/Music/Private Album/03 Hidden Track.flac";

const REQUEST_ID = "3f2c9a1e-7b4d-4e8f-9a0b-1c2d3e4f5a6b";

const makeSender = (log = createErrorLog(), requestIds: string[] = []) => {
  const sent: Array<{ token: string; body: FeedbackInput }> = [];
  const lines: string[] = [];
  const sender = createDesktopFeedbackSender({
    app: "parrot-desktop",
    token: () => "session-token",
    errorLog: log,
    appVersion: "1.2.3",
    platform: "linux 7.3.1-1-cachyos-with-a-very-long-kernel-name",
    requestIds: () => requestIds,
    send: async (token, body) => {
      sent.push({ token, body });
      return { id: "fb_1" };
    },
    log: (line) => lines.push(line),
    fail: (line) => lines.push(`FAIL ${line}`),
  });
  const dump = (phase: string) => console.info(`${SUITE} ${phase}: sent=${JSON.stringify(sent)} lines=${JSON.stringify(lines)}`);
  return { sender, sent, lines, dump, log };
};

describe("@req UX-SUP-05[parrot] @req UX-SUP-02[parrot] @req REL-LOG-06[parrot] feedback with the cleaned error log", () => {
  it("unticked: the message goes without any log", async () => {
    const { sender, sent, dump, log } = makeSender();
    log.record("error", "main", `[import] failed: ${SECRET_PATH}: unreadable`);
    const result = await sender({ message: "Love it", attachLog: false });
    dump("unticked");
    expect(result).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    // The API keeps 32 characters of the platform.
    expect(sent[0]!.body).toEqual({ message: "Love it", app: "parrot-desktop", appVersion: "1.2.3", platform: "linux 7.3.1-1-cachyos-with-a-ver", log: null, requestIds: [] });
  });

  /** @req UX-SUP-07[parrot] */
  it("carries the request ids of the last failed API calls, ticked or not, and says how many it sent", async () => {
    const { sender, sent, lines, dump } = makeSender(createErrorLog(), [REQUEST_ID]);
    await sender({ message: "Sync broke", attachLog: false });
    dump("request ids");
    expect(sent[0]!.body.requestIds).toEqual([REQUEST_ID]);
    expect(sent[0]!.body.log).toBeNull();
    expect(lines).toContain("[feedback] sent (log not attached, 1 request ids)");
  });

  it("ticked: the scrubbed log goes along, without the email or the file path", async () => {
    const { sender, sent, dump, log } = makeSender();
    log.record("error", "main", `[import] failed: ${SECRET_PATH}: unreadable`);
    log.record("warn", "renderer", `sign-in for ${SECRET_EMAIL} took long`);
    console.info(`${SUITE} raw log as kept:\n${log.read()}`);
    await sender({ message: "Import broke", attachLog: true });
    dump("ticked");
    const body = sent[0]!.body;
    expect(body.log).toBeTypeOf("string");
    expect(body.log).toContain("[ERROR] [main] [import] failed:");
    expect(body.log).toContain("[WARN] [renderer]");
    expect(body.log).not.toContain(SECRET_EMAIL);
    expect(body.log).not.toContain("alice");
    expect(body.log).not.toContain("Hidden Track");
    expect(body.log).not.toContain("/home/");
  });

  it("ticked with an empty log sends log null", async () => {
    const { sender, sent, dump } = makeSender();
    await sender({ message: "Nothing broke", attachLog: true });
    dump("empty log");
    expect(sent[0]!.body.log).toBeNull();
  });

  it("clamps a long log to the API's 200 KiB, keeping the newest lines", async () => {
    const { sender, sent, dump, log } = makeSender(createErrorLog({ maxLines: 5000 }));
    for (let i = 0; i < 4000; i++) log.record("error", "main", `[billing] failure ${"x".repeat(80)}`);
    log.record("error", "main", "[billing] newest-line-marker");
    await sender({ message: "Lots of errors", attachLog: true });
    const attached = sent[0]!.body.log!;
    console.info(`${SUITE} clamp: raw=${new TextEncoder().encode(log.read()).length}B attached=${new TextEncoder().encode(attached).length}B`);
    console.info(`${SUITE} clamp: attached head=${JSON.stringify(attached.slice(0, 160))} tail=${JSON.stringify(attached.slice(-160))}`);
    expect(new TextEncoder().encode(attached).length).toBeLessThanOrEqual(FEEDBACK_LOG_MAX_BYTES);
    expect(attached.endsWith("[billing] newest-line-marker")).toBe(true);
    expect(attached.length).toBeLessThan(log.read().length);
  });

  it("not signed in: nothing is sent", async () => {
    const sendSpy = vi.fn();
    const sender = createDesktopFeedbackSender({
    app: "parrot-desktop",
      token: () => null,
      errorLog: createErrorLog(),
      appVersion: "1.2.3",
      platform: "linux",
      requestIds: () => [],
      send: sendSpy,
      log: () => undefined,
      fail: () => undefined,
    });
    expect(await sender({ message: "hi", attachLog: true })).toEqual({ ok: false, error: "not signed in" });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("a failed send is reported and lands in the error log", async () => {
    const log = createErrorLog();
    const lines: string[] = [];
    const sender = createDesktopFeedbackSender({
    app: "parrot-desktop",
      token: () => "t",
      errorLog: log,
      appVersion: "1.2.3",
      platform: "linux",
      requestIds: () => [],
      send: async () => Promise.reject(new Error("offline")),
      log: (line) => lines.push(line),
      fail: (line) => lines.push(`FAIL ${line}`),
    });
    const result = await sender({ message: "hi", attachLog: false });
    console.info(`${SUITE} failed send: ${JSON.stringify(result)} lines=${JSON.stringify(lines)}`);
    expect(result).toEqual({ ok: false, error: "offline" });
    expect(lines).toContain("FAIL [feedback] not sent: offline");
  });
});

describe("@req UX-SUP-05[parrot] the feedback form's attach-log tick", () => {
  let container: HTMLDivElement;
  let root: Root;
  let calls: Array<{ message: string; attachLog: boolean }>;

  beforeEach(() => {
    calls = [];
    (window as unknown as { parrot: unknown }).parrot = {
      sendFeedback: async (input: { message: string; attachLog: boolean }) => {
        calls.push(input);
        console.info(`${SUITE} form sent ${JSON.stringify(input)}`);
        return { ok: true };
      },
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const typeMessage = (text: string) => {
    const input = container.querySelector<HTMLInputElement>("input:not([type=checkbox])")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const clickSend = async () => {
    const send = [...container.querySelectorAll("button")].find((b) => b.textContent === "Send")!;
    await act(async () => send.click());
  };

  it("is unticked by default and sends attachLog=false; ticking it sends attachLog=true", async () => {
    act(() => root.render(<Feedback t={translator("en")} onClose={() => undefined} />));
    const tick = container.querySelector<HTMLInputElement>('[data-testid="feedback-attach-log"]')!;
    console.info(`${SUITE} form text: ${container.textContent}`);
    expect(tick.checked).toBe(false);
    expect(container.textContent).toContain("Attach the app's error log");
    expect(container.textContent).toContain("It contains no titles or file names.");

    typeMessage("first");
    await clickSend();
    expect(calls.at(-1)).toEqual({ message: "first", attachLog: false });

    act(() => tick.click());
    expect(tick.checked).toBe(true);
    typeMessage("second");
    await clickSend();
    expect(calls.at(-1)).toEqual({ message: "second", attachLog: true });
  });

  it("every language has the tick and its hint", () => {
    for (const language of ["en", "fr", "nl", "de", "es"] as const) {
      const t = translator(language);
      console.info(`${SUITE} ${language}: ${t("feedback.attachLog")} / ${t("feedback.attachLogHint")}`);
      expect(t("feedback.attachLog")).not.toBe("feedback.attachLog");
      expect(t("feedback.attachLogHint")).not.toBe("feedback.attachLogHint");
    }
  });
});
