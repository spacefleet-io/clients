// @vitest-environment jsdom
/**
 * Spec INGS-QUOTA-01, last bullet: an upload the server refuses because the account is
 * full is never shown as a bare "Failed". The jobs sidebar explains it in plain words and
 * offers the next plan up with its price, switched in place.
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountStorageSummary } from "@space/shared/api";
import QuotaUploadsNotice, { isUploadQuotaExceededJobError } from "../src/renderer/src/components/QuotaUploadsNotice";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const P = "[quota-uploads-notice]";
const GIB = 1024 ** 3;

vi.mock("@space/ui", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => {
    const { variant: _variant, size: _size, ...rest } = props;
    return <button {...rest}>{children}</button>;
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}${JSON.stringify(vars)}` : key),
    i18n: { language: "en" },
  }),
}));

const setUser = vi.fn();
vi.mock("../src/renderer/src/auth", () => ({
  useAuth: () => ({ token: "token", user: { id: "user-1" }, setUser }),
}));

const updateSubscription = vi.fn();
const getAccountStorage = vi.fn();
const getMe = vi.fn();
const getBillingStatus = vi.fn();
vi.mock("../src/renderer/src/api", () => ({
  updateSubscription: (...args: unknown[]) => updateSubscription(...args),
  getAccountStorage: (...args: unknown[]) => getAccountStorage(...args),
  getMe: (...args: unknown[]) => getMe(...args),
  getBillingStatus: (...args: unknown[]) => getBillingStatus(...args),
  startCheckout: vi.fn(),
  completeStancerPayment: vi.fn(),
}));

const storage = (plan: string, limitGb: number, usedGb: number): AccountStorageSummary => ({
  plan,
  storageAddonCount: 0,
  limitBytes: limitGb * GIB,
  usedBytes: usedGb * GIB,
  reservedBytes: 0,
  usageRatio: usedGb / limitGb,
  warningLevel: usedGb >= limitGb ? "blocked" : "ok",
  apps: [],
  lastReconciledAt: null,
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const byTestId = <T extends HTMLElement = HTMLElement>(id: string) =>
  container?.querySelector<T>(`[data-testid="${id}"]`) ?? null;

const dump = (label: string) => {
  console.error(`=== ${P}:${label} ===`);
  console.error(`getAccountStorage calls=${JSON.stringify(getAccountStorage.mock.calls)}`);
  console.error(`updateSubscription calls=${JSON.stringify(updateSubscription.mock.calls)}`);
  console.error(`getBillingStatus calls=${getBillingStatus.mock.calls.length} getMe calls=${getMe.mock.calls.length}`);
  console.error(`text:\n${container?.textContent ?? "(no container)"}`);
};

const flush = async (rounds = 3) => {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 0);
      await promise;
    });
  }
};

beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  updateSubscription.mockReset();
  getAccountStorage.mockReset();
  getMe.mockReset().mockResolvedValue({ user: { id: "user-1" }, access: null });
  getBillingStatus
    .mockReset()
    .mockResolvedValue({ provider: "standin", checkoutAllowed: false, checkoutBlockedReason: "billing_provider_standin", subscription: null });
  setUser.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  window.localStorage.clear();
});

describe("isUploadQuotaExceededJobError", () => {
  it("@req INGS-QUOTA-01 recognises the storage API's 'account full' refusals and nothing else", () => {
    const cases: Array<[string | null | undefined, boolean]> = [
      ["upload_quota_exceeded", true],
      ["storage API 413: {\"error\":\"upload_quota_exceeded\"}", true],
      ["lab.errors.uploadQuotaExceeded", true],
      ["storage_quota_blocked", true],
      ["lab.errors.storageQuotaBlocked", true],
      ["subscription_unpaid", false],
      ["lab.errors.uploadQuotaUnavailable", false],
      ["lab.errors.processingFailed", false],
      [null, false],
      [undefined, false],
    ];
    const results = cases.map(([error]) => [error, isUploadQuotaExceededJobError(error)]);
    console.info(`${P}:predicate ${JSON.stringify(results)}`);
    expect(results).toEqual(cases);
  });
});

describe("QuotaUploadsNotice", () => {
  it("@req INGS-QUOTA-01 explains the refused upload in plain words and switches to the next plan in place", async () => {
    getAccountStorage.mockResolvedValueOnce(storage("tier1", 100, 100)).mockResolvedValueOnce(storage("tier2", 400, 100));
    updateSubscription.mockResolvedValue({ user: { id: "user-1", plan: "tier2", access: null }, access: { state: "active" }, outcome: "applied" });
    await act(async () => {
      root?.render(<QuotaUploadsNotice />);
    });
    await flush();
    console.info(`${P}:mounted text=${container?.textContent}`);
    try {
      expect(byTestId("quota-uploads-notice")?.textContent).toContain("ingestion.quota.uploadRefused");
      expect(byTestId("quota-uploads-notice-offer")?.textContent).toContain("account.plans.tier2.title (400 GB)");
      expect(byTestId("quota-uploads-notice-offer")?.textContent).toContain("4.99");
    } catch (err) {
      dump("mounted");
      throw err;
    }

    await act(async () => {
      byTestId("quota-uploads-notice-upgrade")?.click();
    });
    await flush();
    console.info(`${P}:after upgrade text=${container?.textContent}`);
    try {
      expect(updateSubscription).toHaveBeenCalledWith("token", "tier2", { billingPeriod: "annual", addonCount: 0 });
      expect(byTestId("quota-uploads-notice")?.textContent).toContain("ingestion.quota.uploadRefusedUpgraded");
      expect(byTestId("quota-uploads-notice-upgrade")).toBeNull();
    } catch (err) {
      dump("after-upgrade");
      throw err;
    }
  });

  it("@req INGS-QUOTA-01 keeps the offer and says so when the upgrade fails", async () => {
    getAccountStorage.mockResolvedValue(storage("free", 20, 20));
    updateSubscription.mockRejectedValue(new Error("network down"));
    await act(async () => {
      root?.render(<QuotaUploadsNotice />);
    });
    await flush();
    await act(async () => {
      byTestId("quota-uploads-notice-upgrade")?.click();
    });
    await flush();
    console.info(`${P}:after failed upgrade text=${container?.textContent}`);
    try {
      expect(updateSubscription).toHaveBeenCalledWith("token", "tier1", { billingPeriod: "annual", addonCount: 0 });
      expect(byTestId("quota-uploads-notice-error")?.textContent).toBe("ingestion.quota.upgradeFailed");
      expect(byTestId("quota-uploads-notice-upgrade")).not.toBeNull();
    } catch (err) {
      dump("failed-upgrade");
      throw err;
    }
  });

  it("@req INGS-QUOTA-01 still explains the refusal when the storage figures cannot be read", async () => {
    getAccountStorage.mockRejectedValue(new Error("offline"));
    await act(async () => {
      root?.render(<QuotaUploadsNotice />);
    });
    await flush();
    console.info(`${P}:offline text=${container?.textContent}`);
    expect(byTestId("quota-uploads-notice")?.textContent).toBe("ingestion.quota.uploadRefused");
    expect(byTestId("quota-uploads-notice-upgrade")).toBeNull();
  });

  it("@req ACCT-PAY-01 offers no upgrade that would fail: an unreadable billing status says why instead", async () => {
    getAccountStorage.mockResolvedValue(storage("free", 20, 20));
    getBillingStatus.mockRejectedValue(new Error("request_failed"));
    await act(async () => {
      root?.render(<QuotaUploadsNotice />);
    });
    await flush();
    console.info(`${P}:billing-unknown text=${container?.textContent}`);
    try {
      expect(byTestId("quota-uploads-notice-upgrade")).toBeNull();
      expect(byTestId("quota-uploads-notice-unavailable")?.textContent).toBe("account.subscription.billingUnknown");
      expect(updateSubscription).not.toHaveBeenCalled();
    } catch (err) {
      dump("billing-unknown");
      throw err;
    }
  });
});
