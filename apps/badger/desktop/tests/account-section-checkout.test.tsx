// @vitest-environment jsdom
// @req ACCT-PAY-01 @req ACCT-PLAN-08 @req ACCT-PLAN-11 (also covers ACCT-PLAN-07/12, whose applies list does not hold badger-desktop)
/**
 * Settings → Account takes payment through the API and Stancer's hosted page (ACCT-PAY-01): a paid
 * plan opens the hosted page in the system browser (the main process turns `window.open` into
 * `shell.openExternal`), the screen waits for the payment's result and refreshes the plan without a
 * restart; a refused or cancelled payment says so; back to free shows when the paid plan ends. During a
 * paid period the server decides (ACCT-PLAN-07/08/12): a move down or a period switch is booked and shown
 * with its date, a move up pays the prorated difference on the hosted page, a plan the library does not
 * fit is refused with the amount to remove, and choosing the current plan again drops the booking; a
 * held renewal is announced with its charge date (ACCT-PLAN-11). Every billing status below is one the
 * API can answer. The real shared plan change (`@space/shared/billingCheckout`, `usePlanChange`) runs;
 * only `@/api` is faked.
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "account-section-checkout";

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
  // The dialog renders its content only while open, like the real one; no portal in jsdom.
  Dialog: ({ open, children }: { open?: boolean; children?: React.ReactNode }) => (open ? <div role="dialog">{children}</div> : null),
  DialogContent: ({ children, ...props }: { children?: React.ReactNode }) => <div {...props}>{children}</div>,
  DialogHeader: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children?: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children, ...props }: { children?: React.ReactNode }) => <p {...props}>{children}</p>,
}));
vi.mock("@space/desktop-shell/components", () => ({ AccountStorageCard: () => <div /> }));
vi.mock("../src/renderer/src/components/settings/kit", () => ({
  SettingHint: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  SettingPanel: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  SettingRow: ({ title, control }: { title?: React.ReactNode; control?: React.ReactNode }) => <div>{title}{control}</div>,
}));

import AccountSection from "../src/renderer/src/components/settings/sections/AccountSection";
import { formatLocalizedStorage } from "@space/shared/format";
import { formatAccessDate } from "@space/shared/effectiveAccess";

const HOSTED_URL = "https://payment.stancer.com/ptest_1/pi_desktop";
const PAID_ACCESS = {
  state: "paid",
  paidUntil: "2026-12-07T00:00:00.000Z",
  billingPeriod: "monthly",
  wipeAt: null,
  qosTier: "paid",
};
const FREE_ACCESS = { state: "free", paidUntil: null, billingPeriod: null, wipeAt: null, qosTier: "free" };
const CARD = { brand: "visa", last4: "4242", expMonth: 12, expYear: 2030 };
/** Free account under Stancer: the first payment is allowed. */
const STATUS_FREE = { provider: "stancer", checkoutAllowed: true, checkoutBlockedReason: null, subscription: null };
const STATUS_STANDIN = { provider: "standin", checkoutAllowed: false, checkoutBlockedReason: "billing_provider_standin", subscription: null };
/** A paid period runs and renews. */
const STATUS_RENEWING = {
  provider: "stancer",
  checkoutAllowed: false,
  checkoutBlockedReason: "paid_period_running",
  subscription: { cancelAtPeriodEnd: false, live: true, card: CARD },
};
/** A paid period runs but ends after "back to free": not live, and still no checkout. */
const STATUS_ENDING = {
  provider: "stancer",
  checkoutAllowed: false,
  checkoutBlockedReason: "paid_period_running",
  subscription: { cancelAtPeriodEnd: true, live: false, card: CARD },
};
/** A granted paid period (no card on file): not live, and still no checkout. */
const STATUS_GRANTED = { provider: "stancer", checkoutAllowed: false, checkoutBlockedReason: "paid_period_running", subscription: null };
/** The period ended and its renewal is being charged. */
const STATUS_RENEWAL_PENDING = {
  provider: "stancer",
  checkoutAllowed: false,
  checkoutBlockedReason: "renewal_pending",
  subscription: { cancelAtPeriodEnd: false, live: false, card: CARD },
};
const subscription = (plan: string, access?: typeof PAID_ACCESS) => ({
  plan,
  storageLimitGb: plan === "free" ? 10 : 100,
  storageUsedGb: 1,
  storageAddonCount: 0,
  ...(access ? { access } : {}),
});

describe("AccountSection checkout (ACCT-PAY-01)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let openSpy: ReturnType<typeof vi.fn>;

  const flush = async () => {
    for (let i = 0; i < 6; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  };
  const mount = async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<AccountSection />);
    });
    await flush();
  };
  const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const planButton = (plan: string) => byTestId(`account-plan-button-${plan}`) as HTMLButtonElement | null;
  const click = async (element: HTMLElement | null, label: string) => {
    if (!element) {
      dump(`missing:${label}`);
      throw new Error(`[${SUITE}] nothing to click: ${label}`);
    }
    console.info(`[${SUITE}] click ${label}`);
    await act(async () => element.click());
    await flush();
  };
  const choosePlan = async (plan: string) => {
    await click(planButton(plan), `${plan} (select)`);
    await click(planButton(plan), `${plan} (confirm)`);
  };
  const dump = (label: string) => {
    console.info(
      `[${SUITE}:${label}] buttons`,
      Array.from(container.querySelectorAll("button")).map(
        (b) => `${b.dataset.testid ?? "?"}=${b.textContent}${b.disabled ? " (disabled)" : ""}`,
      ),
    );
    console.info(`[${SUITE}:${label}] message=${byTestId("account-plan-message")?.textContent ?? "-"}`);
    console.info(`[${SUITE}:${label}] unavailable=${byTestId("account-plans-unavailable")?.textContent ?? "-"}`);
    console.info(`[${SUITE}:${label}] api calls`, Object.fromEntries(Object.entries(api).map(([k, fn]) => [k, fn.mock.calls])));
  };

  beforeEach(() => {
    window.localStorage.setItem("sf_billing_period", "monthly");
    Object.values(api).forEach((fn) => fn.mockReset());
    auth.setUser.mockReset();
    openSpy = vi.fn(() => null);
    window.open = openSpy as unknown as typeof window.open;
    api.getSubscription.mockResolvedValue(subscription("free"));
    api.getAccountStorage.mockResolvedValue(null);
    api.getSponsorships.mockResolvedValue({ sponsorCode: null, sponsorships: [] });
    api.getSettings.mockResolvedValue({ preferences: {} });
    api.getMe.mockResolvedValue({ user: { id: "u1", plan: "free" }, access: FREE_ACCESS });
    api.getBillingStatus.mockResolvedValue(STATUS_FREE);
    api.startCheckout.mockResolvedValue({ url: HOSTED_URL, paymentId: "pay_1" });
    api.completeStancerPayment.mockResolvedValue({ outcome: "pending" });
  });
  afterEach((context) => {
    if (context.task.result?.state === "fail") dump("failure");
    act(() => root.unmount());
    container.remove();
  });

  it("opens Stancer's hosted page, waits, and shows the paid plan without a restart", async () => {
    await mount();
    await choosePlan("tier2");
    dump("waiting");
    expect(api.startCheckout).toHaveBeenCalledWith("tok-1", { plan: "tier2", billingPeriod: "monthly", addonCount: 0, lang: "en", returnApp: "badger" });
    expect(api.updateSubscription).not.toHaveBeenCalled();
    expect(openSpy).toHaveBeenCalledWith(HOSTED_URL, "_blank", "noopener,noreferrer");
    expect(byTestId("account-payment-waiting")).not.toBeNull();
    expect(planButton("tier1")?.disabled).toBe(true);

    // The user pays in the browser and comes back: the payment is paid, the plan is tier2.
    api.completeStancerPayment.mockResolvedValue({ outcome: "paid" });
    api.getSubscription.mockResolvedValue(subscription("tier2", PAID_ACCESS));
    api.getMe.mockResolvedValue({ user: { id: "u1", plan: "tier2" }, access: PAID_ACCESS });
    api.getBillingStatus.mockResolvedValue(STATUS_RENEWING);
    await click(byTestId("account-payment-check"), "check now");
    dump("paid");

    expect(api.completeStancerPayment).toHaveBeenCalledWith("tok-1", "pay_1");
    expect(byTestId("account-payment-waiting")).toBeNull();
    expect(byTestId("account-plan-message")?.textContent).toBe("account.subscription.paymentSuccess");
    expect(auth.setUser).toHaveBeenCalledWith({ id: "u1", plan: "tier2", access: PAID_ACCESS });
    expect(planButton("tier2")?.textContent).toBe("account.subscription.currentPlan");
    expect(container.textContent).toContain("account.plans.tier2.title");
  });

  it("checks the payment when the window gets the focus back, and says a refused card was not charged", async () => {
    await mount();
    await choosePlan("tier1");
    api.completeStancerPayment.mockResolvedValue({ outcome: "refused" });
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await flush();
    dump("refused");
    expect(byTestId("account-plan-message")?.textContent).toBe("account.subscription.paymentRefused");
    expect(api.getMe).not.toHaveBeenCalled();
    expect(planButton("free")?.textContent).toBe("account.subscription.currentPlan");
  });

  it("says a cancelled payment was not charged", async () => {
    await mount();
    await choosePlan("tier1");
    api.completeStancerPayment.mockResolvedValue({ outcome: "canceled" });
    await click(byTestId("account-payment-check"), "check now");
    expect(byTestId("account-plan-message")?.textContent).toBe("account.subscription.paymentCancelled");
  });

  it("opens the payment page again, and stops waiting on request", async () => {
    await mount();
    await choosePlan("tier1");
    await click(byTestId("account-payment-reopen"), "reopen");
    expect(openSpy).toHaveBeenCalledTimes(2);
    await click(byTestId("account-payment-stop"), "stop");
    expect(byTestId("account-payment-waiting")).toBeNull();
    expect(byTestId("account-plan-message")?.textContent).toBe("account.subscription.paymentStopped");
    expect(planButton("tier1")?.disabled).toBe(false);
  });

  it("says payments are unavailable when the API cannot reach Stancer", async () => {
    api.startCheckout.mockRejectedValue(new Error("billing_unavailable"));
    await mount();
    await choosePlan("tier3");
    expect(openSpy).not.toHaveBeenCalled();
    expect(byTestId("account-plan-message")?.textContent).toBe("account.subscription.paymentsUnavailable");
  });

  it("with the stand-in provider, applies the plan directly (nothing charged, no browser)", async () => {
    api.getBillingStatus.mockResolvedValue(STATUS_STANDIN);
    api.updateSubscription.mockResolvedValue({ user: { id: "u1" }, outcome: "applied" });
    await mount();
    await choosePlan("tier1");
    expect(api.updateSubscription).toHaveBeenCalledWith("tok-1", "tier1", { billingPeriod: "monthly", addonCount: 0 });
    expect(api.startCheckout).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
    expect(byTestId("account-plan-message")?.textContent).toBe("account.subscription.updated");
  });

  const STATUS_PRELAUNCH = { ...STATUS_STANDIN, provider: "prelaunch", renewNow: null, paymentDeadline: null, founder: false };

  // @req ACCT-PAY-07
  it("before payments open: says so, asks first for a paid plan, then applies it directly with no checkout", async () => {
    api.getBillingStatus.mockResolvedValue(STATUS_PRELAUNCH);
    api.updateSubscription.mockResolvedValue({ user: { id: "u1" }, outcome: "applied" });
    await mount();
    expect(byTestId("account-payments-not-open")?.textContent).toBe("account.subscription.paymentsNotOpen");
    await choosePlan("tier2");
    const dialog = byTestId("account-prelaunch-confirm");
    console.info("[account-section-checkout:prelaunch] dialog", dialog?.textContent);
    expect(dialog).not.toBeNull();
    expect(byTestId("account-prelaunch-confirm-free")?.textContent).toBe(
      'account.subscription.prelaunchConfirm.free {"plan":"account.plans.tier2.title"}',
    );
    expect(byTestId("account-prelaunch-confirm-email")?.textContent).toBe("account.subscription.prelaunchConfirm.emailMonth");
    expect(api.updateSubscription).not.toHaveBeenCalled();
    await click(byTestId("account-prelaunch-confirm-start"), "prelaunch start");
    console.info("[account-section-checkout:prelaunch] update", api.updateSubscription.mock.calls[0]);
    expect(byTestId("account-prelaunch-confirm")).toBeNull();
    expect(api.updateSubscription).toHaveBeenCalledWith("tok-1", "tier2", { billingPeriod: "monthly", addonCount: 0 });
    expect(api.startCheckout).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
  });

  // @req ACCT-PAY-07
  it("before payments open: \"Choose another plan\" applies nothing, and the founders sentence shows only for a founder", async () => {
    api.getBillingStatus.mockResolvedValue({ ...STATUS_PRELAUNCH, founder: true });
    await mount();
    await choosePlan("tier1");
    console.info("[account-section-checkout:prelaunch] founder dialog", byTestId("account-prelaunch-confirm-email")?.textContent);
    expect(byTestId("account-prelaunch-confirm-email")?.textContent).toBe(
      "account.subscription.prelaunchConfirm.emailMonth account.subscription.prelaunchConfirm.founder",
    );
    await click(byTestId("account-prelaunch-confirm-cancel"), "prelaunch cancel");
    expect(byTestId("account-prelaunch-confirm")).toBeNull();
    expect(api.updateSubscription).not.toHaveBeenCalled();
    expect(api.startCheckout).not.toHaveBeenCalled();
    act(() => root.unmount());
    container.remove();

    api.getBillingStatus.mockResolvedValue({ ...STATUS_PRELAUNCH, founder: null });
    await mount();
    await choosePlan("tier1");
    console.info("[account-section-checkout:prelaunch] unknown-founder dialog", byTestId("account-prelaunch-confirm-email")?.textContent);
    expect(byTestId("account-prelaunch-confirm-email")?.textContent).toBe("account.subscription.prelaunchConfirm.emailMonth");
  });

  // @req ACCT-PAY-07
  it("before payments open: a paid plan reads the three-line note, and moving to Free applies at once without asking", async () => {
    api.getBillingStatus.mockResolvedValue(STATUS_PRELAUNCH);
    api.getSubscription.mockResolvedValue({ ...subscription("tier2"), billingPeriod: "annual" });
    api.updateSubscription.mockResolvedValue({ user: { id: "u1" }, outcome: "applied" });
    await mount();
    const note = byTestId("account-payments-not-open");
    console.info("[account-section-checkout:prelaunch] paid note", note?.outerHTML);
    expect(Array.from(note!.querySelectorAll("p")).map((p) => p.textContent)).toEqual([
      'account.subscription.prelaunchNote.free {"plan":"account.plans.tier2.title"}',
      "account.subscription.prelaunchNote.emailYear",
      "account.subscription.prelaunchNote.unpaid",
    ]);
    await choosePlan("free");
    expect(byTestId("account-prelaunch-confirm")).toBeNull();
    expect(api.updateSubscription).toHaveBeenCalledWith("tok-1", "free", { billingPeriod: "monthly", addonCount: 0 });
  });

  // @req ACCT-PAY-07
  it("payments open with a deadline: says the plan is free until the deadline, never paid until", async () => {
    const DEADLINE = "2026-11-26T10:00:00.000Z";
    api.getBillingStatus.mockResolvedValue({
      ...STATUS_FREE,
      renewNow: { reason: "payments_open", cardExpired: false },
      paymentDeadline: DEADLINE,
      founder: null,
    });
    api.getSubscription.mockResolvedValue({ ...subscription("tier1", { ...PAID_ACCESS, paidUntil: DEADLINE }), billingPeriod: "monthly" });
    await mount();
    const notice = byTestId("account-access-notice");
    console.info("[account-section-checkout:grace] notice", notice?.textContent);
    expect(notice?.textContent).toBe(
      `account.subscription.freeUntilMonth ${JSON.stringify({ date: formatAccessDate(DEADLINE, "en"), plan: "account.plans.tier1.title" })}`,
    );
    expect(container.textContent).not.toContain("account.subscription.paidUntil");
    expect(container.textContent).not.toContain("account.subscription.endsOn");
    expect(byTestId("account-payments-not-open")).toBeNull();
  });

  // @req ACCT-PAY-07
  it("payments open with a deadline: the current plan offers Pay now, which starts a checkout of that plan and period", async () => {
    const DEADLINE = "2026-11-26T10:00:00.000Z";
    api.getBillingStatus.mockResolvedValue({
      ...STATUS_FREE,
      renewNow: { reason: "payments_open", cardExpired: false },
      paymentDeadline: DEADLINE,
      founder: null,
    });
    api.getSubscription.mockResolvedValue({ ...subscription("tier1", { ...PAID_ACCESS, paidUntil: DEADLINE }), billingPeriod: "monthly" });
    await mount();
    const button = planButton("tier1");
    console.info("[account-section-checkout:grace-pay] button", button?.textContent, "disabled", button?.disabled);
    expect(button?.textContent).toBe("account.subscription.payNow");
    expect(button?.disabled).toBe(false);
    await click(button, "tier1-pay-now");
    dump("grace-pay");
    expect(api.startCheckout).toHaveBeenCalledWith("tok-1", { plan: "tier1", billingPeriod: "monthly", addonCount: 0, lang: "en", returnApp: "badger" });
    expect(api.updateSubscription).not.toHaveBeenCalled();
    expect(openSpy).toHaveBeenCalledWith(HOSTED_URL, "_blank", "noopener,noreferrer");
  });

  it("greys out every plan change, with why, when the billing status cannot be read", async () => {
    api.getBillingStatus.mockRejectedValue(new Error("request_failed"));
    await mount();
    dump("billing-unknown");
    expect(byTestId("account-plans-unavailable")?.dataset.reason).toBe("billing_unknown");
    for (const plan of ["tier1", "tier2", "tier3"]) expect(planButton(plan)?.disabled).toBe(true);
    expect(api.startCheckout).not.toHaveBeenCalled();
  });

  it("ACCT-PLAN-07: offers every plan during a paid period, and back to free shows when the paid plan ends", async () => {
    api.getSubscription.mockResolvedValue(subscription("tier1", PAID_ACCESS));
    api.getBillingStatus.mockResolvedValue(STATUS_RENEWING);
    api.updateSubscription.mockResolvedValue({ user: { id: "u1" }, outcome: "booked", effectiveAt: "2026-12-07T00:00:00.000Z" });
    await mount();
    dump("live");
    expect(byTestId("account-plans-unavailable")).toBeNull();
    for (const plan of ["free", "tier2", "tier3"]) expect(planButton(plan)?.disabled, plan).toBe(false);

    api.getBillingStatus.mockResolvedValue(STATUS_ENDING);
    await choosePlan("free");
    dump("back-to-free");
    expect(api.updateSubscription).toHaveBeenCalledWith("tok-1", "free", { billingPeriod: "monthly", addonCount: 0 });
    expect(api.startCheckout).not.toHaveBeenCalled();
    expect(byTestId("account-plan-message")?.textContent).toMatch(/^account\.subscription\.endsOn \{"date":".+"\}$/);
    expect(byTestId("account-access-notice")?.textContent).toMatch(/^account\.subscription\.endsOn/);
  });

  // @bugfix
  // @regression-proof
  it("ACCT-PLAN-07: lets the server decide while a paid period runs that does not renew (live false)", async () => {
    for (const [name, status] of [
      ["ending after back to free", STATUS_ENDING],
      ["granted, no card", STATUS_GRANTED],
    ] as const) {
      api.getSubscription.mockResolvedValue(subscription("tier2", PAID_ACCESS));
      api.getBillingStatus.mockResolvedValue(status);
      await mount();
      dump(`running-not-live:${name}`);
      expect(byTestId("account-plans-unavailable"), name).toBeNull();
      for (const plan of ["tier1", "tier3"]) expect(planButton(plan)?.disabled, `${name} ${plan}`).toBe(false);
      act(() => root.unmount());
      container.remove();
    }
    await mount();
  });

  it("ACCT-PLAN-07: a move down during a paid period is booked, shown with its date, and dropped by keeping the current plan", async () => {
    const booked = {
      plan: "tier1",
      billingPeriod: "monthly",
      addonCount: 0,
      storageLimitGb: 100,
      effectiveAt: "2026-12-07T00:00:00.000Z",
      fits: true,
      excessBytes: 0,
    };
    api.getSubscription.mockResolvedValue({ ...subscription("tier2", PAID_ACCESS), billingPeriod: "monthly" });
    api.getBillingStatus.mockResolvedValue(STATUS_RENEWING);
    api.updateSubscription.mockResolvedValueOnce({ user: { id: "u1" }, outcome: "booked", effectiveAt: booked.effectiveAt });
    await mount();
    api.getSubscription.mockResolvedValue({ ...subscription("tier2", PAID_ACCESS), billingPeriod: "monthly", scheduledChange: booked });
    await choosePlan("tier1");
    dump("booked");
    expect(api.updateSubscription).toHaveBeenCalledWith("tok-1", "tier1", { billingPeriod: "monthly", addonCount: 0 });
    expect(api.startCheckout).not.toHaveBeenCalled();
    expect(byTestId("account-plan-message")?.textContent).toMatch(/^account\.subscription\.booked \{"date":".+"\}$/);
    expect(byTestId("account-scheduled-change")?.dataset.fits).toBe("true");
    expect(byTestId("account-scheduled-change")?.textContent).toContain('account.subscription.scheduledChange {"plan":"account.plans.tier1.title"');
    expect(byTestId("account-scheduled-too-large")).toBeNull();

    // Keep my current plan: the current plan chosen again, the server drops the booking.
    api.updateSubscription.mockResolvedValueOnce({ user: { id: "u1" }, outcome: "booking_cancelled" });
    api.getSubscription.mockResolvedValue({ ...subscription("tier2", PAID_ACCESS), billingPeriod: "monthly", scheduledChange: null });
    await click(byTestId("account-cancel-booking"), "keep current plan");
    expect(api.updateSubscription).toHaveBeenLastCalledWith("tok-1", "tier2", { billingPeriod: "monthly", addonCount: 0 });
    expect(byTestId("account-plan-message")?.textContent).toBe("account.subscription.bookingCancelled");
    expect(byTestId("account-scheduled-change")).toBeNull();
  });

  it("@req ACCT-PLAN-08 a plan the library does not fit is refused with the amount to remove, and nothing changes", async () => {
    api.getSubscription.mockResolvedValue({ ...subscription("tier2", PAID_ACCESS), billingPeriod: "monthly" });
    api.getBillingStatus.mockResolvedValue(STATUS_RENEWING);
    api.updateSubscription.mockRejectedValue(
      Object.assign(new Error("library_too_large"), { status: 409, payload: { error: "library_too_large", excessBytes: 5_000_000_000 } }),
    );
    await mount();
    await choosePlan("tier1");
    dump("too-large");
    expect(byTestId("account-plan-message")?.textContent).toBe(
      `account.subscription.tooLarge ${JSON.stringify({ excess: formatLocalizedStorage(5_000_000_000, "en") })}`,
    );
    expect(api.startCheckout).not.toHaveBeenCalled();
    expect(api.getMe).not.toHaveBeenCalled();
    expect(planButton("tier2")?.textContent).toBe("account.subscription.currentPlan");
  });

  it("@req ACCT-PLAN-08 @req ACCT-PLAN-11 shows a booked plan the library does not fit, and a held renewal with its charge date", async () => {
    api.getSubscription.mockResolvedValue({
      ...subscription("tier2", PAID_ACCESS),
      billingPeriod: "monthly",
      scheduledChange: {
        plan: "tier1",
        billingPeriod: "monthly",
        addonCount: 0,
        storageLimitGb: 100,
        effectiveAt: "2026-12-07T00:00:00.000Z",
        fits: false,
        excessBytes: 2_000_000_000,
      },
      renewalHold: { chargeAt: "2026-12-10T00:00:00.000Z" },
    });
    api.getBillingStatus.mockResolvedValue(STATUS_RENEWING);
    await mount();
    dump("hold");
    expect(byTestId("account-scheduled-change")?.dataset.fits).toBe("false");
    expect(byTestId("account-scheduled-too-large")?.textContent).toContain(
      `account.subscription.scheduledTooLarge {"excess":"${formatLocalizedStorage(2_000_000_000, "en")}"`,
    );
    expect(byTestId("account-renewal-hold")?.textContent).toMatch(/^account\.subscription\.renewalHold \{"date":".+"\}$/);
    expect(byTestId("account-cancel-booking")).not.toBeNull();
  });

  it("ACCT-PLAN-07: a move up during a paid period pays the prorated difference on Stancer's hosted page", async () => {
    api.getSubscription.mockResolvedValue({ ...subscription("tier1", PAID_ACCESS), billingPeriod: "monthly" });
    api.getBillingStatus.mockResolvedValue(STATUS_RENEWING);
    api.updateSubscription.mockRejectedValue(Object.assign(new Error("checkout_required"), { status: 409, payload: { error: "checkout_required" } }));
    await mount();
    await choosePlan("tier3");
    dump("move-up");
    expect(api.updateSubscription).toHaveBeenCalledWith("tok-1", "tier3", { billingPeriod: "monthly", addonCount: 0 });
    expect(api.startCheckout).toHaveBeenCalledWith("tok-1", { plan: "tier3", billingPeriod: "monthly", addonCount: 0, lang: "en", returnApp: "badger" });
    expect(openSpy).toHaveBeenCalledWith(HOSTED_URL, "_blank", "noopener,noreferrer");
    expect(byTestId("account-payment-waiting")).not.toBeNull();
  });

  it("ACCT-PLAN-12: the current plan on the other billing period is a switch the server books", async () => {
    window.localStorage.setItem("sf_billing_period", "annual");
    api.getSubscription.mockResolvedValue({ ...subscription("tier2", PAID_ACCESS), billingPeriod: "monthly" });
    api.getBillingStatus.mockResolvedValue(STATUS_RENEWING);
    api.updateSubscription.mockResolvedValue({ user: { id: "u1" }, outcome: "booked", effectiveAt: "2026-12-07T00:00:00.000Z" });
    await mount();
    expect(planButton("tier2")?.disabled).toBe(false);
    expect(planButton("tier2")?.textContent).toBe("account.subscription.switch");
    await choosePlan("tier2");
    expect(api.updateSubscription).toHaveBeenCalledWith("tok-1", "tier2", { billingPeriod: "annual", addonCount: 0 });
    expect(byTestId("account-plan-message")?.textContent).toMatch(/^account\.subscription\.booked/);
  });

  // @bugfix
  it("greys out paid plans while the renewal is being charged, and says so", async () => {
    api.getSubscription.mockResolvedValue(subscription("tier1", PAID_ACCESS));
    api.getBillingStatus.mockResolvedValue(STATUS_RENEWAL_PENDING);
    await mount();
    dump("renewal-pending");
    expect(byTestId("account-plans-unavailable")?.dataset.reason).toBe("renewal_pending");
    expect(byTestId("account-plans-unavailable")?.textContent).toContain("account.subscription.renewalPending");
    expect(planButton("tier2")?.disabled).toBe(true);
    expect(api.startCheckout).not.toHaveBeenCalled();
  });

  // @bugfix
  it("says a payment is already under way when the server refuses a second hosted page", async () => {
    api.startCheckout.mockRejectedValue(new Error("checkout_in_progress"));
    await mount();
    await choosePlan("tier2");
    expect(openSpy).not.toHaveBeenCalled();
    expect(byTestId("account-plan-message")?.textContent).toBe("account.subscription.checkoutInProgress");
  });

  // @bugfix
  // @regression-proof
  it("opens nothing when the API hands back a page that is not Stancer's", async () => {
    api.startCheckout.mockResolvedValue({ url: "https://evil.example/pay", paymentId: "pay_1" });
    await mount();
    await choosePlan("tier1");
    dump("bad-url");
    expect(openSpy).not.toHaveBeenCalled();
    expect(api.completeStancerPayment).not.toHaveBeenCalled();
    expect(byTestId("account-payment-waiting")).toBeNull();
  });

  // Prices are compared by their digits only: the currency format follows the runtime locale.
  const digits = (id: string) => byTestId(id)?.textContent?.replace(/\D/g, "") ?? null;

  // @req WAIT-FOUND-01
  it("a founder sees the founder price on every paid plan, list price struck through, monthly and yearly", async () => {
    api.getBillingStatus.mockResolvedValue({ ...STATUS_FREE, founder: true });
    await mount();
    const monthly = ["free", "tier1", "tier2", "tier3"].map((p) => ({
      p,
      list: byTestId(`account-plan-list-price-${p}`)?.textContent ?? null,
      price: byTestId(`account-plan-price-${p}`)?.textContent ?? null,
      label: byTestId(`account-plan-founder-${p}`)?.textContent ?? null,
    }));
    console.info(`[${SUITE}:founder] monthly`, JSON.stringify(monthly));
    expect([digits("account-plan-list-price-tier1"), digits("account-plan-price-tier1")]).toEqual(["299", "209"]);
    expect([digits("account-plan-list-price-tier2"), digits("account-plan-price-tier2")]).toEqual(["599", "419"]);
    expect([digits("account-plan-list-price-tier3"), digits("account-plan-price-tier3")]).toEqual(["1399", "979"]);
    expect(byTestId("account-plan-list-price-tier2")?.className).toContain("line-through");
    expect(byTestId("account-plan-founder-tier2")?.textContent).toBe('account.subscription.founderPrice {"percent":30}');
    expect(byTestId("account-plan-founder-free")).toBeNull();
    expect(byTestId("account-plan-list-price-free")).toBeNull();
    act(() => root.unmount());
    container.remove();

    window.localStorage.setItem("sf_billing_period", "annual");
    await mount();
    const text = container.textContent ?? "";
    console.info(`[${SUITE}:founder] annual`, digits("account-plan-list-price-tier2"), digits("account-plan-price-tier2"), text.match(/account\.subscription\.(billedYearly|savePerYear) \{[^}]*\}/g));
    // Standard yearly: list 4.99 a month, founder 59.90 − 17.97 = 41.93 a year (3.49 a month), 4.19 × 12 − 41.93 = 8.35 saved.
    expect([digits("account-plan-list-price-tier2"), digits("account-plan-price-tier2")]).toEqual(["499", "349"]);
    expect(text).toMatch(/account\.subscription\.billedYearly \{"amount":"[^"]*41[.,]93[^"]*"\}/);
    expect(text).toMatch(/account\.subscription\.savePerYear \{"amount":"[^"]*8[.,]35[^"]*"\}/);
  });

  // @req WAIT-FOUND-01
  it("a non-founder sees the list price, with no founder line", async () => {
    api.getBillingStatus.mockResolvedValue({ ...STATUS_FREE, founder: false });
    await mount();
    console.info(`[${SUITE}:non-founder]`, digits("account-plan-price-tier2"), byTestId("account-plan-list-price-tier2")?.textContent ?? "-");
    expect(digits("account-plan-price-tier2")).toBe("599");
    expect(byTestId("account-plan-list-price-tier2")).toBeNull();
    expect(byTestId("account-plan-founder-tier2")).toBeNull();
  });

  // @bugfix
  // @req ACCT-PLAN-15
  it("on yearly billing the Free card shows its price alone: no struck 0,00 €, no billed-yearly or 0,00 € saving line", async () => {
    for (const founder of [false, true]) {
      api.getBillingStatus.mockResolvedValue({ ...STATUS_FREE, founder });
      window.localStorage.setItem("sf_billing_period", "annual");
      await mount();
      const freeCard = byTestId("account-plan-price-free")?.closest(".rounded-xl");
      const text = container.textContent ?? "";
      const yearlyLines = text.match(/account\.subscription\.(billedYearly|savePerYear) \{[^}]*\}/g) ?? [];
      console.info(`[${SUITE}:free-annual] founder=${founder}`, freeCard?.textContent, JSON.stringify(yearlyLines));
      expect(digits("account-plan-price-free")).toBe("000");
      expect(byTestId("account-plan-list-price-free")).toBeNull();
      expect(freeCard?.querySelector(".line-through")).toBeNull();
      expect(byTestId("account-plan-saving-free")).toBeNull();
      expect(freeCard?.textContent).not.toMatch(/billedYearly|savePerYear/);
      // The paid plans keep theirs: Standard strikes its higher price and states a saving above zero.
      expect(byTestId("account-plan-list-price-tier2")?.className).toContain("line-through");
      expect(byTestId("account-plan-saving-tier2")).not.toBeNull();
      expect(yearlyLines).toHaveLength(6);
      // afterEach unmounts the last render.
      if (!founder) {
        act(() => root.unmount());
        container.remove();
      }
    }
  });
});
