// @vitest-environment jsdom
// @req ACCT-PLAN-14
/**
 * Settings → Account for an admin account (ACCT-PLAN-14): the API answers a `null` storage limit. The section
 * shows "Admin: unlimited storage" in place of the plan and "used of limit", and offers no plan, price, billing
 * period, upgrade or checkout. A limited account keeps its plans and its "used / limit" line.
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setStorageUnitBase } from "@space/shared/format";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "account-section-admin-unlimited";

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
const cardProps = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));

vi.mock("@/api", () => api);
vi.mock("@/auth", () => ({
  useAuth: () => ({ token: "tok-1", user: { id: "u1", preferences: {} }, setUser: vi.fn() }),
}));
// `t` and `i18n` must be referentially stable: the section re-fetches whenever `t` changes.
const i18n = vi.hoisted(() => ({
  t: (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key),
  i18n: { language: "en" },
}));
vi.mock("react-i18next", () => ({ useTranslation: () => i18n }));
vi.mock("@space/ui", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { size?: string; variant?: string }) => {
    const { size: _size, variant: _variant, ...rest } = props;
    return <button {...rest}>{children}</button>;
  },
  Switch: () => <span />,
  Dialog: ({ open, children }: { open?: boolean; children?: React.ReactNode }) => (open ? <div role="dialog">{children}</div> : null),
  DialogContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children?: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children?: React.ReactNode }) => <p>{children}</p>,
}));
// The card records what the section hands it (its own unlimited rendering is tested in @space/desktop-shell).
vi.mock("@space/desktop-shell/components", () => ({
  AccountStorageCard: (props: Record<string, unknown>) => {
    cardProps.last = props;
    return <div data-testid="storage-card" />;
  },
}));
vi.mock("../src/renderer/src/components/settings/kit", () => ({
  SettingHint: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  SettingPanel: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  SettingRow: ({ title, control }: { title?: React.ReactNode; control?: React.ReactNode }) => <div>{title}{control}</div>,
}));

import AccountSection from "../src/renderer/src/components/settings/sections/AccountSection";

const GIB = 1024 ** 3;
/** Billing that would show the "plans unavailable" notice and the prelaunch notice to a limited account. */
const STATUS_STANDIN = { provider: "standin", checkoutAllowed: false, checkoutBlockedReason: "billing_provider_standin", subscription: null };
const STATUS_FREE = { provider: "stancer", checkoutAllowed: true, checkoutBlockedReason: null, subscription: null };

const adminSubscription = { plan: "free", storageLimitGb: null, storageUsedGb: 12, storageAddonCount: 0 };
const adminStorage = {
  plan: "free",
  storageAddonCount: 0,
  limitBytes: null,
  usedBytes: 12 * GIB,
  reservedBytes: 0,
  usageRatio: 0,
  warningLevel: "ok",
  apps: [],
  lastReconciledAt: null,
};

describe("AccountSection for an unlimited (admin) account (ACCT-PLAN-14)", () => {
  let container: HTMLDivElement;
  let root: Root;

  const flush = async () => {
    for (let i = 0; i < 6; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  };
  const mount = async (label: string) => {
    console.info(`[${SUITE}:${label}] mount`, {
      subscription: await api.getSubscription.getMockImplementation()?.(),
      billing: await api.getBillingStatus.getMockImplementation()?.(),
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<AccountSection />);
    });
    await flush();
  };
  const planButtons = () => Array.from(container.querySelectorAll<HTMLElement>("[data-testid^='account-plan-button-']"));
  const dump = (label: string) => {
    console.info(`[${SUITE}:${label}] text=${container.textContent}`);
    console.info(
      `[${SUITE}:${label}] testids`,
      Array.from(container.querySelectorAll<HTMLElement>("[data-testid]")).map((el) => el.dataset.testid),
    );
    console.info(`[${SUITE}:${label}] storage card props`, cardProps.last ? { ...cardProps.last, recompute: undefined } : null);
  };

  beforeEach(() => {
    Object.values(api).forEach((fn) => fn.mockReset());
    cardProps.last = null;
    api.getSponsorships.mockResolvedValue({ sponsorCode: null, sponsorships: [] });
    api.getSettings.mockResolvedValue({ preferences: {} });
    api.getBillingStatus.mockImplementation(async () => STATUS_STANDIN);
    // Plan sizes are GiB, so on a 1024-based computer (Windows, KDE) 12 GB used reads "12.0 GB" (STOR-UNIT-01).
    setStorageUnitBase(1024);
  });
  afterEach((context) => {
    if (context.task.result?.state === "fail") dump("failure");
    act(() => root.unmount());
    container.remove();
    setStorageUnitBase(1000);
  });

  it("[ACCT-PLAN-14-DESK-01] shows the admin unlimited label and offers no plan, price, period, upgrade or checkout", async () => {
    api.getSubscription.mockImplementation(async () => adminSubscription);
    api.getAccountStorage.mockResolvedValue(null);
    await mount("admin-no-storage");
    dump("admin-no-storage");
    const text = container.textContent ?? "";
    expect(text).toContain("account.subscription.adminUnlimited");
    expect(container.querySelector("[data-testid='account-storage-used-unlimited']")?.textContent).toBe(
      'account.subscription.usedUnlimited {"used":"12.0 GB"}',
    );
    expect(planButtons()).toEqual([]);
    expect(text).not.toContain("account.subscription.billingPeriod");
    expect(container.querySelector("[data-testid='account-plans-unavailable']")).toBeNull();
    expect(container.querySelector("[data-testid='account-payments-not-open']")).toBeNull();
    expect(text).not.toContain("account.plans.free.title");
    expect(text).not.toContain("account.subscription.used {");
    expect(api.startCheckout).not.toHaveBeenCalled();
  });

  it("[ACCT-PLAN-14-DESK-02] hands the storage card the unlimited label when the storage limit is null", async () => {
    api.getSubscription.mockImplementation(async () => adminSubscription);
    api.getAccountStorage.mockResolvedValue(adminStorage);
    await mount("admin-with-storage");
    dump("admin-with-storage");
    expect(cardProps.last?.unlimitedLabel).toBe("account.subscription.adminUnlimited");
    expect((cardProps.last?.data as { limitBytes: unknown }).limitBytes).toBeNull();
    expect(planButtons()).toEqual([]);
  });

  it("[ACCT-PLAN-14-DESK-03] a limited account still sees its plan, the plans and 'used / limit'", async () => {
    api.getSubscription.mockImplementation(async () => ({ plan: "free", storageLimitGb: 10, storageUsedGb: 1, storageAddonCount: 0 }));
    api.getBillingStatus.mockImplementation(async () => STATUS_FREE);
    api.getAccountStorage.mockResolvedValue(null);
    await mount("limited");
    dump("limited");
    const text = container.textContent ?? "";
    expect(text).not.toContain("account.subscription.adminUnlimited");
    expect(text).toContain("account.plans.free.title (10 GB)");
    expect(text).toContain('account.subscription.used {"used":"1.0 GB","limit":"10.0 GB"}');
    expect(planButtons().map((b) => b.dataset.testid)).toEqual([
      "account-plan-button-free",
      "account-plan-button-tier1",
      "account-plan-button-tier2",
      "account-plan-button-tier3",
    ]);
  });
});
