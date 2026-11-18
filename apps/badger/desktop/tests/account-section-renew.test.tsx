// @vitest-environment jsdom
/**
 * #145 step 5: an unpaid account must be able to renew the plan it is already on. With the stand-in
 * billing provider that re-submits the plan to the plan change endpoint (Stancer pays it through the
 * hosted page instead: account-section-checkout.test.tsx). The "Current plan" button used to be
 * inert, so an unpaid user on tier1 had no way to re-pay without switching to another tier.
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "account-section-renew";

const api = vi.hoisted(() => ({
  getSubscription: vi.fn(),
  getAccountStorage: vi.fn(),
  getSponsorships: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  updateSubscription: vi.fn(),
  getMe: vi.fn(),
  getBillingStatus: vi.fn(),
  startCheckout: vi.fn(),
  completeStancerPayment: vi.fn(),
}));
const auth = vi.hoisted(() => ({ setUser: vi.fn() }));

vi.mock("@/api", () => api);
vi.mock("@/auth", () => ({
  useAuth: () => ({ token: "tok-1", user: { id: "u1", preferences: {} }, setUser: auth.setUser }),
}));
// `t` and `i18n` must be referentially stable: the section re-fetches whenever `t` changes.
const i18n = vi.hoisted(() => ({ t: (key: string) => key, i18n: { language: "en" } }));
vi.mock("react-i18next", () => ({ useTranslation: () => i18n }));
vi.mock("@space/ui", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
  // A Switch stand-in that can be clicked, for the News switch (ACCT-NEWS-01).
  Switch: ({ checked, disabled, onCheckedChange, ...props }: { checked?: boolean; disabled?: boolean; onCheckedChange?: (on: boolean) => void; "data-testid"?: string }) => (
    <button type="button" role="switch" aria-checked={checked === true} disabled={disabled} data-testid={props["data-testid"]} onClick={() => onCheckedChange?.(!checked)} />
  ),
  // The prelaunch confirmation (ACCT-PAY-07) stays closed here; content only while open, no portal in jsdom.
  Dialog: ({ open, children }: { open?: boolean; children?: React.ReactNode }) => (open ? <div role="dialog">{children}</div> : null),
  DialogContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children?: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children?: React.ReactNode }) => <p>{children}</p>,
}));
vi.mock("@space/desktop-shell/components", () => ({ AccountStorageCard: () => <div /> }));
vi.mock("../src/renderer/src/components/settings/kit", () => ({
  SettingHint: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  SettingPanel: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  SettingRow: ({ title, control }: { title?: React.ReactNode; control?: React.ReactNode }) => <div>{title}{control}</div>,
}));

import AccountSection from "../src/renderer/src/components/settings/sections/AccountSection";

const subscription = (state: "paid" | "unpaid") => ({
  plan: "tier1",
  storageLimitGb: 100,
  storageUsedGb: 1,
  storageAddonCount: 0,
  access: {
    state,
    paidUntil: "2099-01-01T00:00:00.000Z",
    billingPeriod: "monthly",
    wipeAt: state === "unpaid" ? "2099-03-01T00:00:00.000Z" : null,
    qosTier: state === "paid" ? "paid" : "free",
  },
});

describe("AccountSection renew (#145)", () => {
  let container: HTMLDivElement;
  let root: Root;

  const mount = async (state: "paid" | "unpaid") => {
    api.getSubscription.mockResolvedValue(subscription(state));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<AccountSection />);
      await Promise.resolve();
    });
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  };
  const planButton = (plan: string) =>
    container.querySelector<HTMLButtonElement>(`[data-testid="account-plan-button-${plan}"]`);
  const dump = (label: string) =>
    console.info(
      `[${SUITE}:${label}] buttons`,
      Array.from(container.querySelectorAll("button")).map((b) => `${b.dataset.testid ?? "?"}=${b.textContent}${b.disabled ? " (disabled)" : ""}`),
    );

  beforeEach(() => {
    window.localStorage.setItem("sf_billing_period", "monthly");
    Object.values(api).forEach((fn) => fn.mockReset());
    auth.setUser.mockReset();
    api.getAccountStorage.mockResolvedValue(null);
    api.getSponsorships.mockResolvedValue({ sponsorCode: null, sponsorships: [] });
    api.getSettings.mockResolvedValue({ preferences: {} });
    api.updateSubscription.mockResolvedValue({ user: { id: "u1" }, access: undefined, outcome: "applied" });
    api.getMe.mockResolvedValue({ user: { id: "u1" } });
    api.getBillingStatus.mockResolvedValue({ provider: "standin", checkoutAllowed: false, checkoutBlockedReason: "billing_provider_standin", subscription: null });
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("an unpaid account can re-submit its current plan (renew button enabled, same plan + period)", async () => {
    await mount("unpaid");
    dump("unpaid");
    const button = planButton("tier1");
    expect(button?.textContent).toBe("account.subscription.renew");
    expect(button?.disabled).toBe(false);
    await act(async () => void button!.click());
    expect(api.updateSubscription).toHaveBeenCalledWith("tok-1", "tier1", { billingPeriod: "monthly", addonCount: 0 });
  });

  it("a paid account's current plan stays inert", async () => {
    await mount("paid");
    dump("paid");
    const button = planButton("tier1");
    expect(button?.textContent).toBe("account.subscription.currentPlan");
    expect(button?.disabled).toBe(true);
  });
});

describe("AccountSection News switch (ACCT-NEWS-01)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.values(api).forEach((fn) => fn.mockReset());
    auth.setUser.mockReset();
    api.getSubscription.mockResolvedValue(subscription("paid"));
    api.getAccountStorage.mockResolvedValue(null);
    api.getSponsorships.mockResolvedValue({ sponsorCode: null, sponsorships: [] });
    api.getSettings.mockResolvedValue({ preferences: {} });
    api.getMe.mockResolvedValue({ user: { id: "u1" } });
    api.getBillingStatus.mockResolvedValue({ provider: "standin", checkoutAllowed: false, checkoutBlockedReason: "billing_provider_standin", subscription: null });
    api.updateSettings.mockResolvedValue({ user: { id: "u1", preferences: {}, newsOptIn: true } });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  // @req ACCT-NEWS-01[badger-desktop]
  it("shows News off for an account that never opted in, and saves the switch on the account", async () => {
    await act(async () => {
      root.render(<AccountSection />);
      await Promise.resolve();
    });
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="account-news-switch"]');
    console.info(`[${SUITE}:news] switch=${toggle?.getAttribute("aria-checked")} disabled=${toggle?.disabled}`);
    expect(toggle?.getAttribute("aria-checked")).toBe("false");
    await act(async () => {
      toggle!.click();
      await Promise.resolve();
    });
    expect(api.updateSettings).toHaveBeenCalledWith("tok-1", { newsOptIn: true });
    expect(auth.setUser).toHaveBeenCalledWith({ id: "u1", preferences: {}, newsOptIn: true });
  });
});
