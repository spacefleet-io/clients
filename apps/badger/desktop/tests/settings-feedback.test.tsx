// @vitest-environment jsdom
/**
 * @req UX-SUP-05[badger-desktop]
 * @req UX-SUP-02[badger-desktop]
 * @req UX-SUP-07[badger-desktop]
 * @req REL-FAM-05[ci]
 * @why #3830 review (Q-shared-desktop-feedback-form): Badger desktop had no way to send feedback. Settings > Help &
 *   feedback now opens the desktop form Parrot uses too (`@space/desktop-shell`), and main sends it to `POST /feedback`
 *   through the shared sender (`@space/error-report`), with the window's session, the error log only when ticked and
 *   the request ids of the last failed calls of the window and of main.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createErrorLog } from "@space/error-report/error-log";
import type { DesktopFeedbackBody } from "@space/error-report/desktop-feedback";
import { clearRecentFailedRequestIds } from "@space/shared/apiFailure";
import { desktopFeedbackStrings } from "@space/desktop-shell/components";
import en from "../src/renderer/src/i18n/en.json";
import fr from "../src/renderer/src/i18n/fr.json";
import nl from "../src/renderer/src/i18n/nl.json";
import de from "../src/renderer/src/i18n/de.json";
import es from "../src/renderer/src/i18n/es.json";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const P = "[badger-settings-feedback]";
const LOCALES = { en, fr, nl, de, es } as const;

const i18nState = vi.hoisted(() => ({ language: "en" }));
const lookup = (table: unknown, key: string): unknown =>
  key.split(".").reduce<unknown>((node, part) => (node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined), table);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const value = lookup(LOCALES[i18nState.language as keyof typeof LOCALES], key);
      return typeof value === "string" ? value : key;
    },
    i18n: { language: i18nState.language },
  }),
}));

vi.mock("@space/ui", () => ({
  Button: ({ children, variant: _variant, size: _size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => (
    <button {...props}>{children}</button>
  ),
  Label: ({ children, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) => <label {...props}>{children}</label>,
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

import SupportSection from "../src/renderer/src/components/settings/sections/SupportSection";
import { SETTINGS_GROUPS, getSectionDef } from "../src/renderer/src/components/settings/registry";
import { FEEDBACK_SEND_CHANNEL, mergeRequestIds, recordRendererConsole, registerFeedbackIpc } from "../src/main/feedbackIpc";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const q = (id: string) => container!.querySelector<HTMLElement>(`[data-testid="${id}"]`);

const mount = async () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<SupportSection />));
};

const typeMessage = async (text: string) => {
  const input = q("feedback-message") as HTMLTextAreaElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  i18nState.language = "en";
  Reflect.deleteProperty(window, "sf");
});

describe("Badger desktop Settings > Help & feedback", () => {
  it("sits in the System group, between System and About & updates, as Parrot's Help & feedback does", () => {
    const system = SETTINGS_GROUPS.find((group) => group.id === "system");
    console.info(P, "system group", system?.sections);
    expect(system?.sections).toEqual(["system", "support", "about"]);
    expect(getSectionDef("support").group).toBe("system");
  });

  it.each(Object.keys(LOCALES))("names the section, its line and the button in %s", (language) => {
    const table = LOCALES[language as keyof typeof LOCALES];
    const strings = ["settings.nav.support", "settings.sectionDesc.support", "settings.support.feedback", "settings.support.feedbackBody"].map(
      (key) => [key, lookup(table, key)] as const,
    );
    console.info(P, language, JSON.stringify(strings));
    for (const [, value] of strings) expect(typeof value === "string" && value.trim().length > 0).toBe(true);
  });

  it("opens the shared form, and sends the message with the window's failed request ids through the bridge", async () => {
    const sendFeedback = vi.fn(async (_input: { message: string; attachLog: boolean; requestIds?: string[] }) => ({ ok: true }));
    Object.defineProperty(window, "sf", { configurable: true, value: { sendFeedback } });
    await mount();
    const button = q("settings-feedback") as HTMLButtonElement;
    console.info(P, "row", container!.textContent);
    expect(container!.textContent).toContain("Send feedback");
    expect(container!.textContent).toContain("Tell us what works and what doesn't.");
    expect(q("feedback-dialog")).toBeNull();
    await act(async () => button.click());
    expect(q("feedback-dialog")).not.toBeNull();
    const tick = q("feedback-attach-log") as HTMLInputElement;
    expect(tick.checked).toBe(false);

    await typeMessage("  subtitles drift  ");
    await act(async () => (q("feedback-send") as HTMLButtonElement).click());
    console.info(P, "sent", JSON.stringify(sendFeedback.mock.calls));
    expect(sendFeedback).toHaveBeenLastCalledWith({ message: "subtitles drift", attachLog: false, requestIds: [] });
    expect(q("feedback-dialog")!.textContent).toContain(desktopFeedbackStrings.en.sent);

    await act(async () => tick.click());
    await typeMessage("with the log\nsecond line");
    await act(async () => (q("feedback-send") as HTMLButtonElement).click());
    expect(sendFeedback).toHaveBeenLastCalledWith({ message: "with the log\nsecond line", attachLog: true, requestIds: [] });

    const cancel = [...q("feedback-dialog")!.querySelectorAll("button")].find((b) => b.textContent === desktopFeedbackStrings.en.cancel)!;
    await act(async () => cancel.click());
    expect(q("feedback-dialog")).toBeNull();
  });

  it("shows the form in the app's language", async () => {
    i18nState.language = "fr";
    Object.defineProperty(window, "sf", { configurable: true, value: { sendFeedback: vi.fn(async () => ({ ok: true })) } });
    await mount();
    await act(async () => (q("settings-feedback") as HTMLButtonElement).click());
    console.info(P, "fr form", q("feedback-dialog")!.textContent);
    expect(container!.textContent).toContain("Donner votre avis");
    expect(q("feedback-dialog")!.textContent).toContain(desktopFeedbackStrings.fr.title);
    expect(q("feedback-dialog")!.textContent).toContain(desktopFeedbackStrings.fr.attachLog);
  });

  it("keeps the button off without the bridge (web build, tests)", async () => {
    await mount();
    expect((q("settings-feedback") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Badger desktop main: the feedback sender", () => {
  const REQUEST_ID = "3f2c9a1e-7b4d-4e8f-9a0b-1c2d3e4f5a6b";
  let handler: ((event: unknown, input: unknown) => Promise<{ ok: boolean; error?: string }>) | null;
  let sent: Array<{ token: string; body: DesktopFeedbackBody }>;
  let lines: string[];

  const setUp = (mainIds: string[] = [], send?: (token: string, body: DesktopFeedbackBody) => Promise<unknown>) => {
    const errorLog = createErrorLog();
    const ipc = {
      handle: vi.fn((channel: string, listener: typeof handler) => {
        expect(channel).toBe(FEEDBACK_SEND_CHANNEL);
        handler = listener;
      }),
    };
    const feedback = registerFeedbackIpc(ipc as never, {
      errorLog,
      appVersion: "9.9.9",
      platform: "linux 6.8.0-1-generic-a-very-long-kernel-name",
      send:
        send ??
        (async (token, body) => {
          sent.push({ token, body });
          return { id: "fb-1" };
        }),
      log: (line) => lines.push(line),
      mainRequestIds: () => mainIds,
    });
    return { feedback, errorLog };
  };

  beforeEach(() => {
    handler = null;
    sent = [];
    lines = [];
    clearRecentFailedRequestIds();
  });

  it("sends nothing before the window pushed its session", async () => {
    setUp();
    const result = await handler!(null, { message: "hi", attachLog: false });
    console.info(P, "signed out", JSON.stringify(result));
    expect(result).toEqual({ ok: false, error: "not signed in" });
    expect(sent).toHaveLength(0);
  });

  it("sends as badger-desktop with the window's session; the log only when ticked, scrubbed", async () => {
    const { feedback, errorLog } = setUp();
    feedback.setToken("tok-1");
    recordRendererConsole(errorLog, "error", "fetch failed for /home/alice/Videos/Secret Film (2024).mkv");
    recordRendererConsole(errorLog, "info", "not kept");
    expect(await handler!(null, { message: "no log", attachLog: false })).toEqual({ ok: true });
    expect(await handler!(null, { message: "with log", attachLog: true })).toEqual({ ok: true });
    console.info(P, "sent", JSON.stringify(sent), "lines", JSON.stringify(lines));
    expect(sent[0]).toMatchObject({ token: "tok-1", body: { message: "no log", app: "badger-desktop", appVersion: "9.9.9", log: null } });
    expect(sent[0]!.body.platform).toHaveLength(32);
    expect(sent[1]!.body.log).toContain("[renderer]");
    expect(sent[1]!.body.log).not.toContain("Secret Film");
    expect(sent[1]!.body.log).not.toContain("not kept");
  });

  it("carries the window's and main's failed request ids, each once, the newest five", async () => {
    const { feedback } = setUp(["main-1", REQUEST_ID]);
    feedback.setToken("tok-1");
    await handler!(null, { message: "ids", attachLog: false, requestIds: ["w-1", "w-2", REQUEST_ID, 42] });
    console.info(P, "ids", JSON.stringify(sent[0]!.body.requestIds));
    expect(sent[0]!.body.requestIds).toEqual(["w-1", "w-2", "main-1", REQUEST_ID]);
    expect(mergeRequestIds(["a", "b", "c", "d"], ["e", "f"])).toEqual(["b", "c", "d", "e", "f"]);
  });

  it("a failed send says so and lands in the error log", async () => {
    const { feedback, errorLog } = setUp([], async () => {
      throw new Error("offline");
    });
    feedback.setToken("tok-1");
    const result = await handler!(null, { message: "x", attachLog: false });
    console.info(P, "failed", JSON.stringify(result), errorLog.read());
    expect(result).toEqual({ ok: false, error: "offline" });
    expect(lines).toContain("[feedback] not sent: offline");
    expect(errorLog.read()).toContain("[feedback] not sent: offline");
  });
});
