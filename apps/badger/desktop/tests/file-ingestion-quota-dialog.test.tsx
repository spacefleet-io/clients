// @vitest-environment jsdom
/**
 * The import's storage window (spec INGS-QUOTA-01, INGS-QUOTA-02): one video that does not
 * fit (upgrade or cancel), several that do not fit (upgrade, or tick what fits), and an
 * import that fits but leaves the account more than 90% full (upgrade or carry on).
 * Upgrading switches the plan in place, then the import carries on by itself.
 * Figures follow the device's file manager (STOR-UNIT-01): plan GB are 1024³ bytes, shown in 1000-based GB on a
 * Mac, a phone or a non-KDE Linux desktop and in 1024-based GB on Windows; a plan's name keeps its round number.
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountStorageSummary } from "@space/shared/api";
import { setStorageUnitBase } from "@space/shared/format";
import FileIngestionQuotaDialog, { type QuotaDialogItem } from "../src/renderer/src/components/FileIngestionQuotaDialog";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const P = "[file-ingestion-quota-dialog]";
const GIB = 1024 ** 3;

vi.mock("@space/ui", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => {
    const { variant: _variant, size: _size, ...rest } = props;
    return <button {...rest}>{children}</button>;
  },
  Checkbox: ({
    checked,
    onCheckedChange,
    ...props
  }: Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange" | "type"> & {
    onCheckedChange?: (checked: boolean) => void;
  }) => <input type="checkbox" checked={checked} onChange={(e) => onCheckedChange?.(e.target.checked)} {...props} />,
  Dialog: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  DialogDescription: ({ children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => <p {...props}>{children}</p>,
  DialogFooter: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

/** Keys plus their variables, so the tests can read what the user is told. */
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
const startCheckout = vi.fn();
const completeStancerPayment = vi.fn();
vi.mock("../src/renderer/src/api", () => ({
  updateSubscription: (...args: unknown[]) => updateSubscription(...args),
  getAccountStorage: (...args: unknown[]) => getAccountStorage(...args),
  getMe: (...args: unknown[]) => getMe(...args),
  getBillingStatus: (...args: unknown[]) => getBillingStatus(...args),
  startCheckout: (...args: unknown[]) => startCheckout(...args),
  completeStancerPayment: (...args: unknown[]) => completeStancerPayment(...args),
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const storage = (plan: string, limitGb: number, usedGb: number): AccountStorageSummary => ({
  plan,
  storageAddonCount: 0,
  limitBytes: limitGb * GIB,
  usedBytes: usedGb * GIB,
  reservedBytes: 0,
  usageRatio: usedGb / limitGb,
  warningLevel: "ok" as const,
  apps: [],
  lastReconciledAt: null,
});

// `GET /billing/status` answers the API can give: `checkoutAllowed` is the server's own checkout rule.
const CARD = { brand: "visa", last4: "4242", expMonth: 12, expYear: 2030 };
const STATUS_STANDIN = { provider: "standin", checkoutAllowed: false, checkoutBlockedReason: "billing_provider_standin", subscription: null };
const STATUS_FREE = { provider: "stancer", checkoutAllowed: true, checkoutBlockedReason: null, subscription: null };
const STATUS_LAPSED = {
  provider: "stancer",
  checkoutAllowed: true,
  checkoutBlockedReason: null,
  subscription: { cancelAtPeriodEnd: false, live: false, card: CARD },
};
const STATUS_RENEWING = {
  provider: "stancer",
  checkoutAllowed: false,
  checkoutBlockedReason: "paid_period_running",
  subscription: { cancelAtPeriodEnd: false, live: true, card: CARD },
};

const byTestId = <T extends HTMLElement = HTMLElement>(id: string) =>
  container?.querySelector<T>(`[data-testid="${id}"]`) ?? null;
const allByTestId = <T extends HTMLElement = HTMLElement>(id: string) =>
  Array.from(container?.querySelectorAll<T>(`[data-testid="${id}"]`) ?? []);

const dump = (label: string) => {
  console.error(`=== ${P}:${label} ===`);
  console.error(`mode=${byTestId("import-quota-dialog")?.getAttribute("data-mode") ?? "(no dialog)"}`);
  console.error(`updateSubscription calls=${JSON.stringify(updateSubscription.mock.calls)}`);
  console.error(`getAccountStorage calls=${JSON.stringify(getAccountStorage.mock.calls)}`);
  console.error(`getBillingStatus calls=${getBillingStatus.mock.calls.length} startCheckout calls=${JSON.stringify(startCheckout.mock.calls)}`);
  console.error(`completeStancerPayment calls=${JSON.stringify(completeStancerPayment.mock.calls)}`);
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

const click = async (el: HTMLElement | null, label: string) => {
  if (!el) {
    dump(`missing-${label}`);
    throw new Error(`${P}: nothing to click for ${label}`);
  }
  console.info(`${P}:click ${label} disabled=${(el as HTMLButtonElement).disabled ?? false}`);
  await act(async () => {
    el.click();
  });
  await flush();
};

const render = async (props: {
  items: QuotaDialogItem[];
  storage: AccountStorageSummary;
  pendingLocalBytes?: number;
  billingPeriod?: "annual" | "monthly";
}) => {
  const onContinue = vi.fn();
  const onCancel = vi.fn();
  console.info(`${P}:render ${JSON.stringify({ ...props, items: props.items.map((i) => `${i.id}=${i.bytes}`) })}`);
  await act(async () => {
    root?.render(
      <FileIngestionQuotaDialog
        items={props.items}
        storage={props.storage}
        pendingLocalBytes={props.pendingLocalBytes ?? 0}
        billingPeriod={props.billingPeriod ?? "annual"}
        onContinue={onContinue}
        onCancel={onCancel}
      />,
    );
  });
  // The billing status loads before the upgrade is offered.
  await flush();
  console.info(`${P}:rendered mode=${byTestId("import-quota-dialog")?.getAttribute("data-mode")} text=${container?.textContent}`);
  return { onContinue, onCancel };
};

beforeEach(() => {
  // A Mac, a phone or a GNOME desktop: 1000-based units. The Windows case sets 1024 itself.
  setStorageUnitBase(1000);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  updateSubscription.mockReset();
  getAccountStorage.mockReset();
  getMe.mockReset();
  startCheckout.mockReset();
  completeStancerPayment.mockReset();
  getBillingStatus.mockReset().mockResolvedValue(STATUS_STANDIN);
  setUser.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

describe("FileIngestionQuotaDialog", () => {
  it("@req INGS-QUOTA-01 @req STOR-UNIT-01 one movie that does not fit: needed vs left, the smallest plan with its price, upgrade or cancel", async () => {
    const { onCancel, onContinue } = await render({
      items: [{ id: "movie", label: "Lantern Harbor", bytes: 30 * GIB }],
      storage: storage("free", 20, 15),
    });
    try {
      expect(byTestId("import-quota-dialog")?.getAttribute("data-mode")).toBe("single");
      const summary = byTestId("import-quota-summary")?.textContent ?? "";
      expect(summary).toContain("ingestion.quota.bodyDoesNotFit");
      // 30 GiB = 32.21e9 bytes and 20 − 15 = 5 GiB = 5.37e9 bytes, in 1000-based GB.
      expect(summary).toContain('"needed":"32.2 GB"');
      expect(summary).toContain('"left":"5.4 GB"');
      const offer = byTestId("import-quota-offer")?.textContent ?? "";
      expect(offer).toContain("ingestion.quota.offerFits");
      // The plan's name keeps its round number whatever the device's unit.
      expect(offer).toContain("account.plans.tier1.title (100 GB)");
      expect(offer).toContain("ingestion.quota.priceAnnual");
      // The yearly offer names what is charged at once (12 × 2.49 = 29.90), not only the monthly equivalent.
      expect(offer).toContain("29.90");
      expect(offer).toContain("2.49");
      expect(allByTestId("import-quota-item")).toHaveLength(0);
      expect(byTestId("import-quota-import-selected")).toBeNull();
      expect(byTestId("import-quota-continue")).toBeNull();
      expect(byTestId("import-quota-upgrade")?.textContent).toContain("account.plans.tier1.title");
      // Never offers deleting media.
      expect((container?.textContent ?? "").toLowerCase()).not.toContain("delete");
    } catch (err) {
      dump("single");
      throw err;
    }
    await click(byTestId("import-quota-cancel"), "cancel");
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onContinue).not.toHaveBeenCalled();
  });

  it("@req STOR-UNIT-01 on Windows the same import reads in 1024-based GB, the plan name unchanged", async () => {
    setStorageUnitBase(1024);
    await render({
      items: [{ id: "movie", label: "Lantern Harbor", bytes: 30 * GIB }],
      storage: storage("free", 20, 15),
    });
    try {
      const summary = byTestId("import-quota-summary")?.textContent ?? "";
      expect(summary).toContain('"needed":"30.0 GB"');
      expect(summary).toContain('"left":"5.0 GB"');
      expect(byTestId("import-quota-offer")?.textContent ?? "").toContain("account.plans.tier1.title (100 GB)");
    } catch (err) {
      dump("windows-units");
      throw err;
    }
  });

  it("@req INGS-QUOTA-01 @req STOR-UNIT-01 several videos: Import selected stays off until the ticked ones fit, then imports only those", async () => {
    const { onContinue } = await render({
      items: [
        { id: "e1", label: "Fringe – S01E01", bytes: 3 * GIB },
        { id: "e2", label: "Fringe – S01E02", bytes: 3 * GIB },
        { id: "e3", label: "Fringe – S01E03", bytes: 3 * GIB },
      ],
      storage: storage("free", 20, 14),
    });
    const importSelected = () => byTestId<HTMLButtonElement>("import-quota-import-selected");
    const checkbox = (id: string) =>
      container?.querySelector<HTMLInputElement>(`[data-testid="import-quota-item"][data-item-id="${id}"]`) ?? null;
    try {
      expect(byTestId("import-quota-dialog")?.getAttribute("data-mode")).toBe("batch");
      expect(allByTestId("import-quota-item")).toHaveLength(3);
      expect(importSelected()?.disabled).toBe(true);
      expect(byTestId("import-quota-upgrade")).not.toBeNull();
    } catch (err) {
      dump("batch-initial");
      throw err;
    }

    await click(checkbox("e1"), "tick e1");
    console.info(`${P}:after e1 total=${byTestId("import-quota-selection-total")?.textContent}`);
    expect(importSelected()?.disabled).toBe(false);

    await click(checkbox("e2"), "tick e2");
    console.info(`${P}:after e2 total=${byTestId("import-quota-selection-total")?.textContent}`);
    if (importSelected()?.disabled !== false) dump("e1+e2");
    // 6 GB of 6 GB left: fits exactly.
    expect(importSelected()?.disabled).toBe(false);

    await click(checkbox("e3"), "tick e3");
    console.info(`${P}:after e3 total=${byTestId("import-quota-selection-total")?.textContent}`);
    if (importSelected()?.disabled !== true) dump("e1+e2+e3");
    expect(importSelected()?.disabled).toBe(true);
    // 9 GiB = 9.66e9 bytes, in 1000-based GB.
    expect(byTestId("import-quota-selection-total")?.textContent).toContain('"selected":"9.7 GB"');

    await click(checkbox("e3"), "untick e3");
    await click(importSelected(), "import selected");
    expect(onContinue).toHaveBeenCalledWith(["e1", "e2"], "selection");
    expect(updateSubscription).not.toHaveBeenCalled();
  });

  it("@req INGS-QUOTA-01 upgrading switches the plan in place, then the whole import carries on", async () => {
    const after = storage("tier3", 2500, 390);
    updateSubscription.mockResolvedValue({ user: { id: "user-1", plan: "tier3", access: null }, access: { state: "active" }, outcome: "applied" });
    getMe.mockResolvedValue({ user: { id: "user-1", plan: "tier3", access: null }, access: { state: "active" } });
    getAccountStorage.mockResolvedValue(after);
    const { onContinue } = await render({
      items: [
        { id: "s1", label: "Show – S01E01", bytes: 1000 * GIB },
        { id: "s2", label: "Show – S01E02", bytes: 1000 * GIB },
      ],
      storage: storage("tier2", 400, 390),
      billingPeriod: "monthly",
    });
    await click(byTestId("import-quota-upgrade"), "upgrade");
    await vi.waitFor(() => expect(onContinue).toHaveBeenCalled(), { timeout: 2_000 }).catch((err) => {
      dump("upgrade");
      throw err;
    });
    console.info(`${P}:upgrade calls=${JSON.stringify(updateSubscription.mock.calls)}`);
    expect(updateSubscription).toHaveBeenCalledWith("token", "tier3", { billingPeriod: "monthly", addonCount: 3 });
    expect(setUser).toHaveBeenCalledWith({ id: "user-1", plan: "tier3", access: { state: "active" } });
    expect(getAccountStorage).toHaveBeenCalledWith("token");
    expect(onContinue).toHaveBeenCalledWith(["s1", "s2"], "upgraded", after);
  });

  it("@req INGS-QUOTA-01 a failed upgrade says so and keeps the window open", async () => {
    updateSubscription.mockRejectedValue(new Error("payment_declined"));
    const { onContinue, onCancel } = await render({
      items: [{ id: "movie", label: "Lantern Harbor", bytes: 30 * GIB }],
      storage: storage("free", 20, 15),
    });
    await click(byTestId("import-quota-upgrade"), "upgrade");
    await vi.waitFor(() => expect(byTestId("import-quota-error")).not.toBeNull(), { timeout: 2_000 }).catch((err) => {
      dump("upgrade-failed");
      throw err;
    });
    expect(byTestId("import-quota-error")?.textContent).toBe("ingestion.quota.upgradeFailed");
    expect(byTestId("import-quota-dialog")).not.toBeNull();
    expect(byTestId<HTMLButtonElement>("import-quota-upgrade")?.disabled).toBe(false);
    expect(onContinue).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(getAccountStorage).not.toHaveBeenCalled();
  });

  // Scale grows by 500 GB blocks without limit (ACCT-PLAN-03, #1312), so some plan always fits: 12 000 GB on top of
  // 10 GB used is Scale (1000 GB) + 23 blocks = 12 500 GB, never the old "even the largest plan is too small".
  it("@req INGS-QUOTA-01 offers Scale with enough storage blocks when no base plan is big enough", async () => {
    await render({
      items: [{ id: "archive", label: "Everything", bytes: 12_000 * GIB }],
      storage: storage("tier1", 100, 10),
    });
    try {
      const offer = byTestId("import-quota-offer")?.textContent ?? "";
      expect(offer).toContain("ingestion.quota.offerFits");
      expect(offer).toContain("account.plans.tier3.title (12500 GB)");
      expect(byTestId("import-quota-no-plan")).toBeNull();
      expect(byTestId("import-quota-upgrade")).not.toBeNull();
      expect(byTestId("import-quota-cancel")).not.toBeNull();
    } catch (err) {
      dump("scale-blocks");
      throw err;
    }
  });

  it("@req INGS-QUOTA-02 @req STOR-UNIT-01 fits but over 90%: space left after, next plan with price, or carry on with the current plan", async () => {
    const { onContinue } = await render({
      items: [{ id: "movie", label: "Quiet Orchard", bytes: 8 * GIB }],
      storage: storage("tier1", 100, 85),
      billingPeriod: "monthly",
    });
    try {
      expect(byTestId("import-quota-dialog")?.getAttribute("data-mode")).toBe("high-usage");
      const summary = byTestId("import-quota-summary")?.textContent ?? "";
      expect(summary).toContain("ingestion.quota.bodyHighUsage");
      // 100 − 85 − 8 = 7 GiB = 7.52e9 bytes, in 1000-based GB.
      expect(summary).toContain('"left":"7.5 GB"');
      expect(summary).toContain('"percent":93');
      const offer = byTestId("import-quota-offer")?.textContent ?? "";
      expect(offer).toContain("ingestion.quota.offerNext");
      expect(offer).toContain("account.plans.tier2.title (400 GB)");
      expect(offer).toContain("ingestion.quota.priceMonthly");
      expect(offer).toContain("5.99");
      expect(byTestId("import-quota-cancel")).toBeNull();
      expect(allByTestId("import-quota-item")).toHaveLength(0);
    } catch (err) {
      dump("high-usage");
      throw err;
    }
    await click(byTestId("import-quota-continue"), "continue on current plan");
    expect(onContinue).toHaveBeenCalledWith(["movie"], "current-plan");
    expect(updateSubscription).not.toHaveBeenCalled();
  });
  it("@req ACCT-PAY-01 with Stancer, upgrading opens the hosted payment page and carries on once paid", async () => {
    const after = storage("tier3", 2500, 390);
    // A Standard period that ended unrenewed: no paid period runs, so the server allows a new checkout.
    getBillingStatus.mockResolvedValue(STATUS_LAPSED);
    startCheckout.mockResolvedValue({ url: "https://payment.stancer.com/ptest_1/pi_quota", paymentId: "pay_q" });
    completeStancerPayment.mockResolvedValue({ outcome: "pending" });
    getMe.mockResolvedValue({ user: { id: "user-1", plan: "tier3" }, access: { state: "paid" } });
    getAccountStorage.mockResolvedValue(after);
    const openSpy = vi.fn(() => null);
    window.open = openSpy as unknown as typeof window.open;
    const { onContinue } = await render({
      items: [{ id: "s1", label: "Show – S01E01", bytes: 1000 * GIB }],
      storage: storage("tier2", 400, 390),
      billingPeriod: "monthly",
    });
    await click(byTestId("import-quota-upgrade"), "upgrade");
    try {
      expect(startCheckout).toHaveBeenCalledWith("token", { plan: "tier3", billingPeriod: "monthly", addonCount: 1, lang: "en", returnApp: "badger" });
      expect(openSpy).toHaveBeenCalledWith("https://payment.stancer.com/ptest_1/pi_quota", "_blank", "noopener,noreferrer");
      expect(byTestId("import-quota-payment-waiting")).not.toBeNull();
      expect(updateSubscription).not.toHaveBeenCalled();
    } catch (err) {
      dump("stancer-waiting");
      throw err;
    }
    completeStancerPayment.mockResolvedValue({ outcome: "paid" });
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await vi.waitFor(() => expect(onContinue).toHaveBeenCalled(), { timeout: 2_000 }).catch((err) => {
      dump("stancer-paid");
      throw err;
    });
    expect(completeStancerPayment).toHaveBeenCalledWith("token", "pay_q");
    expect(setUser).toHaveBeenCalledWith({ id: "user-1", plan: "tier3", access: { state: "paid" } });
    expect(onContinue).toHaveBeenCalledWith(["s1"], "upgraded", after);
  });

  it("@req ACCT-PAY-01 a refused card says nothing was charged and keeps the window open", async () => {
    getBillingStatus.mockResolvedValue(STATUS_FREE);
    startCheckout.mockResolvedValue({ url: "https://payment.stancer.com/ptest_1/pi_quota", paymentId: "pay_q" });
    completeStancerPayment.mockResolvedValue({ outcome: "refused" });
    window.open = vi.fn(() => null) as unknown as typeof window.open;
    const { onContinue } = await render({
      items: [{ id: "movie", label: "Lantern Harbor", bytes: 30 * GIB }],
      storage: storage("free", 20, 15),
    });
    await click(byTestId("import-quota-upgrade"), "upgrade");
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await vi.waitFor(() => expect(byTestId("import-quota-error")).not.toBeNull(), { timeout: 2_000 }).catch((err) => {
      dump("stancer-refused");
      throw err;
    });
    expect(byTestId("import-quota-error")?.textContent).toBe("account.subscription.paymentRefused");
    expect(byTestId("import-quota-dialog")).not.toBeNull();
    expect(onContinue).not.toHaveBeenCalled();
  });

  it("ACCT-PLAN-07: a live subscription still moves up: the server asks for the prorated checkout and the hosted page opens", async () => {
    getBillingStatus.mockResolvedValue(STATUS_RENEWING);
    updateSubscription.mockRejectedValue(new Error("checkout_required"));
    startCheckout.mockResolvedValue({ url: "https://payment.stancer.com/ptest_1/pi_up", paymentId: "pay_up" });
    completeStancerPayment.mockResolvedValue({ outcome: "pending" });
    window.open = vi.fn(() => null) as unknown as typeof window.open;
    await render({
      items: [{ id: "movie", label: "Lantern Harbor", bytes: 30 * GIB }],
      storage: storage("tier1", 100, 95),
    });
    try {
      expect(byTestId("import-quota-upgrade-unavailable")).toBeNull();
      await click(byTestId("import-quota-upgrade"), "upgrade");
      await vi.waitFor(() => expect(window.open).toHaveBeenCalled(), { timeout: 2_000 });
      expect(updateSubscription).toHaveBeenCalledTimes(1);
      expect(startCheckout.mock.calls[0]?.[1]).toMatchObject({ plan: "tier2" });
      expect(window.open).toHaveBeenCalledWith("https://payment.stancer.com/ptest_1/pi_up", "_blank", "noopener,noreferrer");
    } catch (err) {
      dump("stancer-live");
      throw err;
    }
  });
});
