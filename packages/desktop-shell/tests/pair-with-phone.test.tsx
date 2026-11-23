// @vitest-environment jsdom
/**
 * ACCT-PAIR-01: the "Sign in with another device" screen: QR code, short code, countdown, new code, and
 * hand-over of an approved pairing.
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@space/ui", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
}));
vi.mock("../src/components/notice-surface", () => ({
  NoticeSurface: ({ children }: { children?: React.ReactNode }) => <div role="alert">{children}</div>,
}));

import PairWithPhone from "../src/components/pair-with-phone";
import { pairWithPhoneStrings } from "../src/components/pair-with-phone-strings";

// Diagnostic log lines carry the test's id so a failing run reads back in order.
const log = {
  info: (m: string, x?: unknown) => console.info(`[pair-with-phone.test] ${m}`, x ?? ""),
  warn: (m: string, x?: unknown) => console.warn(`[pair-with-phone.test] ${m}`, x ?? ""),
  error: (m: string, x?: unknown) => console.error(`[pair-with-phone.test] ${m}`, x ?? ""),
};

type StartResult = Record<string, unknown>;

const request = (expiresInMs: number, requestId = "req-1"): StartResult => ({
  ok: true,
  requestId,
  shortCode: "ABCDEFGH",
  qrPayload: "https://spacefleet.io/pair/badger",
  qrSvg: "<svg xmlns='http://www.w3.org/2000/svg'></svg>",
  expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
  deviceName: "Linux (chris-pc)",
});

describe("PairWithPhone", () => {
  let container: HTMLDivElement;
  let root: Root;
  const pairing = { start: vi.fn(), poll: vi.fn(), cancel: vi.fn(async () => undefined) };
  const onApproved = vi.fn();
  const onBack = vi.fn();

  const flush = async (ms = 0) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };
  const text = () => container.textContent ?? "";
  const buttonByText = (label: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement | undefined;

  const mount = async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<PairWithPhone language="en" actions={pairing} onApproved={onApproved} onBack={onBack} log={log} />);
    });
    await flush();
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("@req ACCT-PAIR-05 speaks the picked language and names both phone apps", async () => {
    pairing.start.mockResolvedValue(request(150_000));
    pairing.poll.mockResolvedValue({ ok: true, status: "pending" });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<PairWithPhone language="fr" actions={pairing} onApproved={onApproved} log={log} />);
    });
    await flush();
    expect(text()).toContain("Se connecter avec un autre appareil");
    expect(text()).toContain("Badger ou Parrot");
    expect(buttonByText("Se connecter avec l’email et le mot de passe")).toBeUndefined();
  });

  it("@req ACCT-PAIR-01 shows the QR code, the short code and a countdown", async () => {
    pairing.start.mockResolvedValue(request(150_000));
    pairing.poll.mockResolvedValue({ ok: true, status: "pending" });
    await mount();

    const qr = container.querySelector<HTMLImageElement>('[data-testid="pair-qr"]');
    expect(qr?.src).toContain("data:image/svg+xml");
    // Chris 2026-11-18 (ACCT-PAIR-01): two groups of 4 with a gap, never a dash; copying it gives the plain 8 characters.
    expect(container.querySelector('[data-testid="pair-short-code"]')?.textContent).toBe("ABCDEFGH");
    expect([...container.querySelectorAll('[data-testid="pair-short-code"] > span')].map((group) => group.textContent)).toEqual(["ABCD", "EFGH"]);
    expect(container.querySelector('[data-testid="pair-countdown"]')?.textContent).toBe("This code expires in 2:30");

    await flush(10_000);
    expect(container.querySelector('[data-testid="pair-countdown"]')?.textContent).toBe("This code expires in 2:20");
  });

  it("@req ACCT-PAIR-01 offers a new code once the code has expired, and stops asking the API", async () => {
    pairing.start.mockResolvedValueOnce(request(3_000)).mockResolvedValueOnce(request(150_000, "req-2"));
    pairing.poll.mockResolvedValue({ ok: true, status: "pending" });
    await mount();

    await flush(4_000);
    expect(text()).toContain("This code has expired.");
    expect(container.querySelector('[data-testid="pair-qr"]')).toBeNull();
    const pollsWhenExpired = pairing.poll.mock.calls.length;
    await flush(10_000);
    expect(pairing.poll.mock.calls.length).toBe(pollsWhenExpired);

    await act(async () => buttonByText("Get a new code")?.click());
    await flush();
    expect(pairing.start).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-testid="pair-qr"]')).not.toBeNull();
  });

  it("@req ACCT-PAIR-01 hands an approved pairing to the sign-in, and reports a key that does not match the library", async () => {
    const approved = { ok: true, status: "approved", token: "tok", user: { id: "u1", email: "a@b.c" }, libraryKey: "KEY" };
    pairing.start.mockResolvedValue(request(150_000));
    pairing.poll.mockResolvedValueOnce({ ok: true, status: "pending" }).mockResolvedValueOnce(approved);
    onApproved.mockResolvedValue("mismatch");
    await mount();

    await flush(2_000);
    expect(onApproved).not.toHaveBeenCalled();
    await flush(2_000);
    expect(onApproved).toHaveBeenCalledTimes(1);
    expect(onApproved.mock.calls[0]?.[0]).toMatchObject({ token: "tok", libraryKey: "KEY" });
    expect(text()).toContain("doesn't match this account's library");
    expect(buttonByText("Get a new code")).toBeDefined();
  });

  it("@req ACCT-PAIR-01 says so when the phone declines this device", async () => {
    pairing.start.mockResolvedValue(request(150_000));
    pairing.poll.mockResolvedValue({ ok: true, status: "denied" });
    await mount();
    await flush(2_000);
    expect(text()).toContain("Your other device declined this device.");
  });

  it("@req PRIV-PAIR-01 shows the six-digit code to compare once the other device connected, and keeps it while waiting", async () => {
    console.info("[pair-with-phone-check] start");
    pairing.start.mockResolvedValue(request(150_000));
    pairing.poll
      .mockResolvedValueOnce({ ok: true, status: "pending" })
      .mockResolvedValueOnce({ ok: true, status: "pending", checkCode: "067383" })
      .mockResolvedValue({ ok: true, status: "pending" });
    await mount();
    await flush(2_000);
    expect(container.querySelector("[data-testid='pair-check']")).toBeNull();
    await flush(2_000);
    console.info("[pair-with-phone-check] code shown", container.querySelector("[data-testid='pair-check-code']")?.textContent);
    expect(container.querySelector("[data-testid='pair-check-code']")?.textContent).toBe("067 383");
    expect(text()).toContain(pairWithPhoneStrings.en.checkHint);
    await flush(2_000);
    expect(container.querySelector("[data-testid='pair-check-code']")?.textContent).toBe("067 383");
  });

  it("@req ACCT-PAIR-01 keeps the email and password sign-in one click away", async () => {
    pairing.start.mockResolvedValue(request(150_000));
    pairing.poll.mockResolvedValue({ ok: true, status: "pending" });
    await mount();
    await act(async () => buttonByText("Sign in with email and password instead")?.click());
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("@req ACCT-PAIR-01 in key mode asks main for a key-only code, says where to scan, and goes back to typing the key", async () => {
    pairing.start.mockResolvedValue(request(150_000));
    pairing.poll.mockResolvedValue({ ok: true, status: "pending" });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<PairWithPhone language="en" mode="key" actions={pairing} onApproved={onApproved} onBack={onBack} log={log} />);
    });
    await flush();
    console.info("[pair-with-phone.test:key] start calls", pairing.start.mock.calls, "text", text());
    expect(pairing.start).toHaveBeenCalledWith({ mode: "key" });
    expect(text()).toContain("Get your library key from another device");
    expect(text()).toContain("already signed in to this account, open Badger or Parrot");
    expect(text()).toContain("Waiting for your other device…");
    expect(container.querySelector('[data-testid="pair-short-code"]')?.textContent).toBe("ABCDEFGH");
    expect(buttonByText("Sign in with email and password instead")).toBeUndefined();
    await act(async () => buttonByText("Type the key instead")?.click());
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("@req ACCT-PAIR-01 in key mode hands the approval to onApproved like a sign-in", async () => {
    const approved = { ok: true, status: "approved", token: "own-session", user: { id: "u1", email: "a@b.c" }, libraryKey: "k" };
    pairing.start.mockResolvedValue(request(150_000));
    pairing.poll.mockResolvedValue(approved);
    onApproved.mockResolvedValue("verified");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<PairWithPhone language="en" mode="key" actions={pairing} onApproved={onApproved} log={log} />);
    });
    await flush();
    await flush(2_000);
    console.info("[pair-with-phone.test:key-approved] onApproved calls", onApproved.mock.calls);
    expect(onApproved).toHaveBeenCalledWith(approved);
  });

  it("@req ACCT-PAIR-01 shows a plain message when no code could be created, and forgets the request when closed", async () => {
    pairing.start.mockResolvedValue({ ok: false, error: "unreachable" });
    await mount();
    console.info("[pair-with-phone.test:start-failed] text", text());
    expect(text()).toContain(pairWithPhoneStrings.en.unreachable);
    await act(async () => root.unmount());
    expect(pairing.cancel).toHaveBeenCalled();
    root = createRoot(container);
  });

  it("@req ACCT-AUTH-11 a 429 says when to try again, in the window's language, and offers a new code", async () => {
    pairing.start.mockResolvedValue({ ok: false, error: "rate_limited", retryAfterMinutes: 4 });
    await mount();
    console.info("[pair-with-phone.test:429] en", text());
    expect(text()).toContain("Too many attempts. Try again in 4 minutes.");
    expect(text()).not.toMatch(/wait a minute/i);
    expect(text()).toContain(pairWithPhoneStrings.en.newCode);
    await act(async () => root.unmount());
    root = createRoot(container);

    pairing.start.mockResolvedValue({ ok: false, error: "rate_limited", retryAfterMinutes: 1 });
    await act(async () => {
      root.render(<PairWithPhone language="fr" actions={pairing} onApproved={vi.fn()} log={log} />);
    });
    await flush();
    console.info("[pair-with-phone.test:429] fr, one minute", text());
    expect(text()).toContain("Trop de tentatives. Réessayez dans 1 minute.");
  });
});
