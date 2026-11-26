// @vitest-environment jsdom
/**
 * @test-id PARROT-DESKTOP-UNPAID-SIGN-001
 * @level component
 * @req ACCT-UNPAID-05[parrot]
 * @req UX-NOTICE-08[parrot]
 * @why Parrot desktop said nothing when the account's plan had ended: playback and uploads just failed. Its top bar
 *   now carries Badger's chip while main's `/auth/me` access says unpaid, in the app's language, with the whole notice
 *   (files deleted on the wipe date) in its label; clicking it opens the account page where the plan is renewed, and
 *   it is read again when the window comes back so a renewal made elsewhere clears it. Main is replaced; the chip
 *   renders for real.
 * @covers apps/parrot/desktop/src/renderer/src/UnpaidAccessSign.tsx
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountAccess } from "@space/shared/accountAccess";
import { UnpaidAccessSign } from "../src/renderer/src/UnpaidAccessSign";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "[PARROT-DESKTOP-UNPAID-SIGN-001]";
const unpaid: AccountAccess = { state: "unpaid", paidUntil: "2026-11-23T00:00:00Z", billingPeriod: "monthly", wipeAt: "2099-01-22T00:00:00Z", qosTier: "free" };
const paid: AccountAccess = { state: "paid", paidUntil: "2099-12-23T00:00:00Z", billingPeriod: "monthly", wipeAt: null, qosTier: "paid" };

const getAccountAccess = vi.fn();
let host: HTMLDivElement;
let root: Root;
const sign = () => host.querySelector<HTMLElement>('[data-testid="unpaid-access-sign"]');
const flush = () =>
  act(async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 0);
    await promise;
  });

beforeEach(() => {
  getAccountAccess.mockReset();
  (window as unknown as { parrot: unknown }).parrot = { getAccountAccess };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("Parrot desktop's unpaid sign", () => {
  it("shows the chip in the app's language while unpaid, and opens the account page", async () => {
    getAccountAccess.mockResolvedValue({ ok: true, value: unpaid });
    const onOpen = vi.fn();
    await act(async () => root.render(<UnpaidAccessSign language="de" onOpen={onOpen} />));
    await flush();
    console.info(SUITE, "unpaid", host.innerHTML);
    expect(sign()?.tagName).toBe("BUTTON");
    expect(sign()?.textContent).toBe("Tarif abgelaufen");
    expect(sign()?.getAttribute("aria-label")).toContain("Deine Dateien werden am");
    expect(sign()?.getAttribute("data-wipe-at")).toBe(unpaid.wipeAt);
    await act(async () => sign()!.click());
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("shows nothing while paid or when main cannot read the access", async () => {
    getAccountAccess.mockResolvedValueOnce({ ok: true, value: paid });
    await act(async () => root.render(<UnpaidAccessSign language="en" onOpen={vi.fn()} />));
    await flush();
    expect(sign()).toBeNull();
    getAccountAccess.mockResolvedValueOnce({ ok: false, code: "network" });
    await act(async () => window.dispatchEvent(new Event("focus")));
    await flush();
    console.info(SUITE, "paid/unreadable", host.innerHTML);
    expect(getAccountAccess).toHaveBeenCalledTimes(2);
    expect(sign()).toBeNull();
  });

  it("clears when the window comes back after a renewal made elsewhere", async () => {
    getAccountAccess.mockResolvedValueOnce({ ok: true, value: unpaid });
    await act(async () => root.render(<UnpaidAccessSign language="en" onOpen={vi.fn()} />));
    await flush();
    expect(sign()?.textContent).toBe("Plan ended");
    getAccountAccess.mockResolvedValueOnce({ ok: true, value: paid });
    await act(async () => window.dispatchEvent(new Event("focus")));
    await flush();
    console.info(SUITE, "renewed", host.innerHTML);
    expect(sign()).toBeNull();
  });
});
