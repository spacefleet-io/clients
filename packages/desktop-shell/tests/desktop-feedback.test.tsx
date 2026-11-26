/**
 * @test-id DESKTOP-SHELL-FEEDBACK-001
 * @level component
 * @req UX-SUP-05[badger-desktop,parrot]
 * @req UX-SUP-02[badger-desktop,parrot]
 * @why #3830 review (Q-shared-desktop-feedback-form): Parrot desktop kept its own "Send feedback" form and Badger
 *   desktop had none. One form now serves both apps (REL-FAM-05), with the error log unticked by default, in the
 *   five client languages.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { CLIENT_UI_LANGUAGES, type ClientUiLanguage } from "@space/shared/i18n";
import { FEEDBACK_MESSAGE_MAX } from "@space/shared/feedback";
import { DesktopFeedbackDialog, type DesktopFeedbackInput } from "../src/components/desktop-feedback";
import { desktopFeedbackStrings } from "../src/components/desktop-feedback-strings";
import { render } from "./utils/render";

const log = (message: string) => console.info(`[desktop-feedback] ${message}`);

const open = (send: (input: DesktopFeedbackInput) => Promise<{ ok: boolean }>, language: ClientUiLanguage = "en") => {
  const onClose = vi.fn();
  const view = render(<DesktopFeedbackDialog language={language} send={send} onClose={onClose} />);
  const message = view.getByTestId("feedback-message") as HTMLTextAreaElement;
  const attach = view.getByTestId("feedback-attach-log") as HTMLInputElement;
  const sendButton = view.getByTestId("feedback-send") as HTMLButtonElement;
  return { view, message, attach, sendButton, onClose };
};

describe("DesktopFeedbackDialog", () => {
  afterEach(cleanup);

  it("keeps Send off until there is a message, and leaves the error log unticked", () => {
    const send = vi.fn(async () => ({ ok: true }));
    const { message, attach, sendButton } = open(send);
    log(`empty: send disabled=${sendButton.disabled}, attach=${attach.checked}`);
    expect(attach.checked).toBe(false);
    expect(sendButton.disabled).toBe(true);
    fireEvent.change(message, { target: { value: "   " } });
    expect(sendButton.disabled).toBe(true);
    fireEvent.change(message, { target: { value: "hello" } });
    expect(sendButton.disabled).toBe(false);
  });

  it("sends the trimmed message without the log, then thanks the user and clears the box", async () => {
    const send = vi.fn(async (_input: DesktopFeedbackInput) => ({ ok: true }));
    const { view, message, sendButton } = open(send);
    fireEvent.change(message, { target: { value: "  the queue skipped  " } });
    fireEvent.click(sendButton);
    await waitFor(() => expect(view.getByText(desktopFeedbackStrings.en.sent)).toBeTruthy());
    log(`sent: ${JSON.stringify(send.mock.calls[0]?.[0])}`);
    expect(send).toHaveBeenCalledWith({ message: "the queue skipped", attachLog: false });
    expect(message.value).toBe("");
  });

  it("sends the error log only once the box is ticked", async () => {
    const send = vi.fn(async (_input: DesktopFeedbackInput) => ({ ok: true }));
    const { view, message, attach, sendButton } = open(send);
    fireEvent.click(attach);
    fireEvent.change(message, { target: { value: "crash on play" } });
    fireEvent.click(sendButton);
    await waitFor(() => expect(view.getByText(desktopFeedbackStrings.en.sent)).toBeTruthy());
    log(`ticked: ${JSON.stringify(send.mock.calls[0]?.[0])}`);
    expect(send).toHaveBeenCalledWith({ message: "crash on play", attachLog: true });
  });

  it("takes several lines: the box is a 5-row textarea and the line breaks reach the send call intact", async () => {
    const send = vi.fn(async (_input: DesktopFeedbackInput) => ({ ok: true }));
    const { view, message, sendButton } = open(send);
    expect(message.tagName).toBe("TEXTAREA");
    expect(message.rows).toBe(5);
    const text = "Playback stopped.\nIt happened twice.\n\nOn the second episode.";
    fireEvent.change(message, { target: { value: text } });
    fireEvent.click(sendButton);
    await waitFor(() => expect(view.getByText(desktopFeedbackStrings.en.sent)).toBeTruthy());
    log(`multi-line: ${JSON.stringify(send.mock.calls[0]?.[0])}`);
    expect(send).toHaveBeenCalledWith({ message: text, attachLog: false });
  });

  it("stops at the API's limit like the phones' form: a message at the limit goes out whole, one over it never leaves the app", async () => {
    const send = vi.fn(async (_input: DesktopFeedbackInput) => ({ ok: true }));
    const { view, message, sendButton } = open(send);
    expect(message.maxLength).toBe(FEEDBACK_MESSAGE_MAX);
    const atLimit = `${"a".repeat(FEEDBACK_MESSAGE_MAX - 1)}z`;
    fireEvent.change(message, { target: { value: `  ${atLimit}\n` } });
    fireEvent.click(sendButton);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(view.getByText(desktopFeedbackStrings.en.sent)).toBeTruthy());
    expect(send.mock.calls[0]?.[0]).toEqual({ message: atLimit, attachLog: false });
    // A value the box let through (set from code, as here) is cut before sending, as the phones' `buildFeedback` does.
    fireEvent.change(message, { target: { value: "b".repeat(FEEDBACK_MESSAGE_MAX + 50) } });
    fireEvent.click(sendButton);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    const over = send.mock.calls[1]?.[0];
    log(`at limit: ${send.mock.calls[0]?.[0]?.message.length} chars; over limit sent as ${over?.message.length} chars`);
    expect(over).toEqual({ message: "b".repeat(FEEDBACK_MESSAGE_MAX), attachLog: false });
  });

  it("says the message did not go, and keeps it, when the send fails or throws", async () => {
    for (const send of [vi.fn(async () => ({ ok: false })), vi.fn(async () => Promise.reject(new Error("ipc gone")))]) {
      const { view, message, sendButton } = open(send);
      fireEvent.change(message, { target: { value: "keep me" } });
      fireEvent.click(sendButton);
      await waitFor(() => expect(view.getByText(desktopFeedbackStrings.en.error)).toBeTruthy());
      log(`failed send kept message=${JSON.stringify(message.value)}`);
      expect(message.value).toBe("keep me");
      cleanup();
    }
  });

  it("closes on Cancel without sending", () => {
    const send = vi.fn(async () => ({ ok: true }));
    const { view, onClose } = open(send);
    fireEvent.click(view.getByText(desktopFeedbackStrings.en.cancel));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  it.each(CLIENT_UI_LANGUAGES.map((option) => option.code))("@req UX-I18N-01 shows every sentence in %s", (language) => {
    const strings = desktopFeedbackStrings[language];
    const { view } = open(vi.fn(async () => ({ ok: true })), language);
    const text = view.getByTestId("feedback-dialog").textContent ?? "";
    log(`${language}: ${strings.title} / ${strings.attachLog}`);
    for (const key of ["title", "attachLog", "attachLogHint", "cancel", "send"] as const) {
      expect(strings[key].trim().length).toBeGreaterThan(0);
      expect(text).toContain(strings[key]);
    }
    for (const key of ["sent", "error"] as const) expect(strings[key].trim().length).toBeGreaterThan(0);
    if (language !== "en") expect(strings.attachLog).not.toBe(desktopFeedbackStrings.en.attachLog);
  });
});
