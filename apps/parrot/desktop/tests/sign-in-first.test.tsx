// @vitest-environment jsdom
/**
 * @test-id PARROT-DESKTOP-SIGN-IN-FIRST-001
 * @level unit
 * @req UX-SETUP-06 ACCT-PAIR-05
 * @req ACCT-SIGNIN-04[parrot]
 * @why Chris 2026-11-09: "login should come before the setup, not as a step in it", and the setup language "should be
 *   a scrollable list"; Chris 2026-11-12: every client but the TV defaults to the login/password screen "with the
 *   option to use the qr code to log in with an already logged in device". A signed-out Parrot opens on the sign-in
 *   screen (email form first, QR card under it), never on setup; setup has no sign-in step; the language step is a
 *   fixed-height scrolling list.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ParrotBridge, ParrotState } from "../src/shared/ipc";
import { updateRequiredBridgeStub } from "./updateRequiredBridge";
import { generateLibraryKeyWords } from "@space/shared/libraryKeyWords";
import type { RenderBoundary as RealRenderBoundary } from "@space/ui/render-boundary";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@space/ui", async () => {
  const Pass = ({ children, className }: { children?: React.ReactNode; className?: string }) => <div className={className}>{children}</div>;
  // The real crash guard (#1467), so a screen that throws still fails the test instead of hiding behind a stub.
  // vi.mock factories are hoisted above static imports, so the module is loaded through vitest here.
  const { RenderBoundary } = await vi.importActual<{ RenderBoundary: typeof RealRenderBoundary }>("@space/ui/render-boundary");
  return {
    RenderBoundary,
    Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { size?: string; variant?: string }) => {
      const { size: _size, variant: _variant, ...rest } = props;
      return <button {...rest}>{children}</button>;
    },
    Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
    Spinner: () => <span />,
    KeySavedWarningDialog: () => null,
    LanguageMenu: ({ current }: { current: string }) => <div data-testid="language-menu">{current}</div>,
    CloseLabelProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    Card: Pass,
    CardContent: Pass,
    CardDescription: Pass,
    CardHeader: Pass,
    CardTitle: Pass,
    Dialog: () => null,
    DialogContent: Pass,
    DialogFooter: Pass,
    DialogHeader: Pass,
    DialogTitle: Pass,
    Label: Pass,
    useSignOutWithKeyCheck: () => ({ requestSignOut: () => undefined, dialog: null }),
  };
});

import App from "../src/renderer/src/App";

const say = (line: string, extra?: unknown) => console.info(`[PARROT-DESKTOP-SIGN-IN-FIRST-001] ${line}`, extra ?? "");

const baseState = (patch: Partial<ParrotState> = {}): ParrotState => ({
  setup: { step: "language", done: false, language: "en", folders: [], startAtLogin: false, errorReports: false },
  user: null,
  hasLibraryKey: false,
  asksKeySavedBeforeSignOut: false,
  apiBaseUrl: "http://localhost:3000",
  isDevBuild: true,
  musicFolder: null,
  appVersion: "0.0.0",
  ...patch,
});

describe("Parrot desktop: sign-in first, then setup", () => {
  let host: HTMLDivElement;
  let root: Root;
  let state: ParrotState;
  const pairing = {
    start: vi.fn(async () => ({
      ok: true as const,
      requestId: "req-1",
      shortCode: "ABCDEFGH",
      qrPayload: "https://spacefleet.io/pair/parrot?code=ABCDEFGH",
      qrSvg: "<svg xmlns='http://www.w3.org/2000/svg'></svg>",
      expiresAt: new Date(Date.now() + 150_000).toISOString(),
      deviceName: "Linux (chris-pc)",
    })),
    poll: vi.fn(async () => ({ ok: true as const, status: "pending" as const })),
    cancel: vi.fn(async () => undefined),
  };
  const saveSetup = vi.fn(async (patch: Partial<ParrotState["setup"]>) => {
    state = { ...state, setup: { ...state.setup, ...patch } };
    return state;
  });
  const setLibraryKey = vi.fn(async (_key: string) => {
    state = { ...state, hasLibraryKey: true };
    return { ok: true as const };
  });

  const saveAccountLanguage = vi.fn(async () => true);

  const mount = async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(<App />));
    await act(async () => undefined);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (window as unknown as { parrot: Partial<ParrotBridge> }).parrot = {
      ...updateRequiredBridgeStub(),
      getState: async () => state,
      saveSetup,
      setLibraryKey,
      // The account has a key: the shared key step asks for it (UX-KEY-01).
      createLibraryKey: async () => ({ ok: false as const, error: "hasLibrary" as const }),
      saveAccountLanguage,
      pairing,
      // No provider configured: no Google, Apple or Microsoft row (ACCT-SIGNIN-05, tests/provider-sign-in.test.tsx).
      providerSignIn: { list: async () => [], start: vi.fn(), complete: vi.fn(), takeReturn: async () => null, onReturn: () => () => undefined },
    };
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("@req UX-SETUP-08[parrot] a new signed-out computer opens on the language (step 0, no count), never on the sign-in", async () => {
    state = baseState();
    await mount();
    expect(host.querySelector('[data-testid="sign-in"]')).toBeNull();
    expect(host.querySelector('[data-testid="setup-language"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="setup-progress"]')).toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="setup-next"]')?.click());
    expect(saveSetup).toHaveBeenLastCalledWith({ language: "en", step: "libraryKey" });
    expect(host.querySelector('[data-testid="sign-in"]')).not.toBeNull();
  });

  it("opens a signed-out Parrot past the language on the email form, with the QR card under it, never on setup", async () => {
    state = baseState({ setup: { ...baseState().setup, step: "libraryKey" } });
    await mount();
    say("screen", host.querySelector("[data-testid]")?.getAttribute("data-testid"));
    expect(host.querySelector('[data-testid="sign-in"]')).not.toBeNull();
    expect(host.querySelector('[data-testid^="setup-"]')).toBeNull();
    expect(host.querySelector('[data-testid="signin-email"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="pair-with-phone"]')).toBeNull();
    expect(host.querySelector('[data-testid="sign-in-divider"]')?.textContent).toBe("or");
    const card = host.querySelector('[data-testid="phone-sign-in-card"]');
    expect(card?.textContent).toContain("Sign in with another device");
    expect(pairing.start).not.toHaveBeenCalled();
  });

  it("the QR card opens the phone sign-in, and email and password is one click back", async () => {
    state = baseState({ setup: { ...baseState().setup, step: "libraryKey" } });
    await mount();
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="phone-sign-in-card"]')?.click());
    await act(async () => undefined);
    expect(host.querySelector('[data-testid="pair-with-phone"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="pair-short-code"]')?.textContent).toBe("ABCDEFGH");
    expect(pairing.start).toHaveBeenCalledTimes(1);
    const emailLink = [...host.querySelectorAll("button")].find((b) => b.textContent === "Sign in with email and password instead");
    await act(async () => emailLink?.click());
    expect(host.querySelector('[data-testid="signin-email"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="pair-with-phone"]')).toBeNull();
  });

  it("a signed-in computer still at the language sees it, step 0 with no step count", async () => {
    state = baseState({ user: { id: "u1", email: "a@b.c" } });
    await mount();
    expect(host.querySelector('[data-testid="sign-in"]')).toBeNull();
    expect(host.querySelector('[data-testid="setup-language"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="setup-progress"]')).toBeNull();
  });

  it("shows the languages as a fixed-height scrolling list the keyboard moves through", async () => {
    state = baseState({ user: { id: "u1", email: "a@b.c" } });
    await mount();
    const list = host.querySelector<HTMLElement>('[data-testid="setup-language-list"]');
    say("list classes", list?.className);
    expect(list?.getAttribute("role")).toBe("listbox");
    expect(list?.className).toContain("max-h-64");
    expect(list?.className).toContain("overflow-y-auto");
    expect(host.querySelector('[data-testid="setup-language-en"]')?.getAttribute("aria-selected")).toBe("true");
    await act(async () => list?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(saveSetup).toHaveBeenLastCalledWith({ language: "fr" });
    // Setup runs signed in: the pick is the account's language too (UX-I18N-07).
    expect(saveAccountLanguage).toHaveBeenLastCalledWith("fr");
    expect(host.querySelector('[data-testid="setup-language-fr"]')?.getAttribute("aria-selected")).toBe("true");
  });

  it("has no sign-in step left in setup: a signed-in user at the key step sees who is signed in", async () => {
    state = baseState({ user: { id: "u1", email: "a@b.c" }, setup: { ...baseState().setup, step: "libraryKey" } });
    await mount();
    expect(host.querySelector('[data-testid="setup-libraryKey"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="signed-in-as"]')?.textContent).toContain("a@b.c");
    expect(host.querySelector('[data-testid="setup-progress"]')?.textContent).toBe("Step 1 of 4");
  });

  it("@req UX-SETUP-08[parrot] @req UX-KEY-01[parrot] the key step has one main button: Continue uses the typed words' key, then moves on", async () => {
    state = baseState({ user: { id: "u1", email: "a@b.c" }, setup: { ...baseState().setup, step: "libraryKey" } });
    await mount();
    expect(host.querySelector('[data-testid="key-use"]')).toBeNull();
    expect(host.querySelector('[data-testid="setup-next"]')).toBeNull();
    const next = () => host.querySelector<HTMLButtonElement>('[data-testid="library-key-continue"]');
    const key = generateLibraryKeyWords("en", (bytes) => bytes.fill(3));
    /** Types `text` into box `box` of the 12 word boxes (a whole copied key goes into one box, as when pasted). */
    const type = async (text: string, box = 0) => {
      const input = host.querySelectorAll<HTMLInputElement>('[data-testid="library-key-box-input"]')[box];
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      say(`typed ${JSON.stringify(text)} into box ${box + 1}`, {
        next: next()?.disabled ? "disabled" : "enabled",
        message: host.querySelector('[data-testid="library-key-message"]')?.textContent ?? null,
        boxes: Array.from(host.querySelectorAll('[data-testid="library-key-box"]')).map((box) => `${box.getAttribute("data-state")}:${box.querySelector("input")?.value}`),
      });
    };
    expect(next()?.disabled).toBe(true);
    expect(host.querySelectorAll('[data-testid="library-key-box"]')).toHaveLength(12);
    // UX-KEY-01: entering a key is titled for entering, and shows no key word the user did not type.
    say("enter screen", { entering: host.textContent?.includes("Enter your library key"), grid: host.querySelector('[data-testid="library-key-words"]') !== null });
    expect(host.textContent).toContain("Enter your library key");
    expect(host.querySelector('[data-testid="library-key-words"]')).toBeNull();
    await type(key.words[0], 0);
    await type("zzzzq", 1);
    expect(host.querySelectorAll('[data-testid="library-key-box"]')[1].getAttribute("data-state")).toBe("unknown");
    expect(next()?.disabled).toBe(true);
    await type(key.words.slice(0, 11).join(" "));
    expect(next()?.disabled).toBe(true);
    await type([key.words[1], key.words[0], ...key.words.slice(2)].join(" "));
    expect(host.querySelector('[data-testid="library-key-message"]')?.textContent).toBe(
      "These words don’t form a valid key. Check each word against the ones you saved.",
    );
    expect(next()?.disabled).toBe(true);
    await type(key.words.map((word) => word.slice(0, 4).toUpperCase()).join("  "));
    expect(host.querySelector('[data-testid="library-key-message"]')).toBeNull();
    expect(next()?.disabled).toBe(false);
    await act(async () => next()?.click());
    expect(setLibraryKey).toHaveBeenCalledWith(key.keyBase64);
    expect(saveSetup).toHaveBeenLastCalledWith({ step: "folders" });
  });

  it("@req UX-KEY-01[parrot] the key step still takes the old 44-character key", async () => {
    state = baseState({ user: { id: "u1", email: "a@b.c" }, setup: { ...baseState().setup, step: "libraryKey" } });
    await mount();
    const key = generateLibraryKeyWords("en", (bytes) => bytes.fill(3));
    const input = host.querySelector<HTMLInputElement>('[data-testid="library-key-box-input"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, ` ${key.keyBase64}\n`);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const next = host.querySelector<HTMLButtonElement>('[data-testid="library-key-continue"]');
    say("typed base64", { next: next?.disabled ? "disabled" : "enabled" });
    await act(async () => next?.click());
    expect(setLibraryKey).toHaveBeenCalledWith(key.keyBase64);
  });
});
