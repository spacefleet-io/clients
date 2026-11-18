// @vitest-environment jsdom
// @req ACCT-PAY-01[parrot] (also covers ACCT-PLAN-07/08/11/12, whose applies list does not hold parrot)
/**
 * Parrot's plan screen takes payment the way Badger does (ACCT-PAY-01): the same plans and prices
 * (`@space/shared/storagePlans`), paid plans greyed with the server's reason when `checkoutAllowed` is
 * false, Stancer's hosted page opened through the shared plan change, the stand-in applying a plan at once.
 * During a paid period the server decides (ACCT-PLAN-07/08/12): a booking is shown with its date, a plan the
 * library does not fit is refused with the amount to remove, keeping the current plan drops the booking, a
 * move up goes to the hosted page; a held renewal shows its charge date (ACCT-PLAN-11).
 * `window.parrot` (main, which holds the session token) is mocked; everything else is the real code.
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLAN_ORDER, planMonthlyPrice, planYearlyPrice } from "@space/shared/storagePlans";
import { formatAccessDate } from "@space/shared/effectiveAccess";
import { formatLocalizedStorage } from "@space/shared/format";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "parrot-plans-checkout";

vi.mock("@space/ui", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { size?: string; variant?: string }) => {
    const { size: _size, variant: _variant, ...rest } = props;
    return <button {...rest}>{children}</button>;
  },
  Spinner: () => <span />,
}));

import Plans from "../src/renderer/src/Plans";
import { translator } from "../src/renderer/src/i18n";

const t = translator("en");
const HOSTED_URL = "https://payment.stancer.com/ptest_1/pi_parrot";
const ok = <T,>(value: T) => ({ ok: true as const, value });

const STATUS_FREE = { provider: "stancer", checkoutAllowed: true, checkoutBlockedReason: null, subscription: null };
const STATUS_STANDIN = { provider: "standin", checkoutAllowed: false, checkoutBlockedReason: "billing_provider_standin", subscription: null };
const STATUS_RUNNING = {
  provider: "stancer",
  checkoutAllowed: false,
  checkoutBlockedReason: "paid_period_running",
  subscription: { cancelAtPeriodEnd: false, live: true, card: null },
};
const STATUS_RENEWAL = { provider: "stancer", checkoutAllowed: false, checkoutBlockedReason: "renewal_pending", subscription: null };

const subscription = (plan: string, extra: Record<string, unknown> = {}) =>
  ok({
    plan,
    storageLimitGb: plan === "free" ? 20 : 100,
    storageUsedGb: 1,
    storageAddonCount: 0,
    paidUntil: plan === "free" ? null : "2027-11-07T00:00:00.000Z",
    billingPeriod: plan === "free" ? null : "annual",
    scheduledChange: null,
    renewalHold: null,
    ...extra,
  });

const BOOKED = {
  plan: "tier1",
  billingPeriod: "annual",
  addonCount: 0,
  storageLimitGb: 100,
  effectiveAt: "2027-11-07T00:00:00.000Z",
  fits: true,
  excessBytes: 0,
};

const parrot = {
  getSubscription: vi.fn(),
  getBillingStatus: vi.fn(),
  updateSubscription: vi.fn(),
  startCheckout: vi.fn(),
  completePayment: vi.fn(),
  /** ACCT-PAY-05: main forwards the `parrot://payment-return` link; the screen subscribes and gets an unsubscribe back. */
  onPaymentReturn: vi.fn((_listener: (paymentId: string) => void) => () => {}),
};

describe("Parrot plan screen (ACCT-PAY-01)", () => {
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
  const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const dump = (label: string) => {
    console.info(
      `[${SUITE}:${label}] buttons`,
      Array.from(container.querySelectorAll("button")).map((b) => `${b.dataset.testid ?? "?"}=${b.textContent}${b.disabled ? " (disabled)" : ""}`),
    );
    console.info(`[${SUITE}:${label}] message=${byTestId("plan-message")?.textContent ?? "-"}`);
    console.info(`[${SUITE}:${label}] unavailable=${byTestId("plan-unavailable")?.dataset.reason ?? "-"}`);
    console.info(`[${SUITE}:${label}] calls`, Object.fromEntries(Object.entries(parrot).map(([k, fn]) => [k, fn.mock.calls])));
  };
  const click = async (id: string) => {
    const element = byTestId(id);
    if (!element) {
      dump(`missing:${id}`);
      throw new Error(`[${SUITE}] nothing to click: ${id}`);
    }
    console.info(`[${SUITE}] click ${id}`);
    await act(async () => element.click());
    await flush();
  };
  const mount = async (language: "en" | "fr" = "en") => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<Plans t={language === "en" ? t : translator(language)} language={language} onClose={() => {}} />);
    });
    await flush();
  };
  const choose = async (plan: string) => {
    await click(`plan-choose-${plan}`);
    await click("plan-confirm");
  };

  beforeEach(() => {
    window.localStorage.setItem("sf_billing_period", "annual");
    Object.values(parrot).forEach((fn) => fn.mockReset());
    (window as unknown as { parrot: typeof parrot }).parrot = parrot;
    openSpy = vi.fn(() => null);
    window.open = openSpy as unknown as typeof window.open;
    parrot.getSubscription.mockResolvedValue(subscription("free"));
    parrot.getBillingStatus.mockResolvedValue(ok(STATUS_FREE));
    parrot.startCheckout.mockResolvedValue(ok({ url: HOSTED_URL, paymentId: "pay_1" }));
    parrot.completePayment.mockResolvedValue(ok({ outcome: "pending" }));
    parrot.updateSubscription.mockResolvedValue(ok({ outcome: "applied" }));
  });
  afterEach((context) => {
    if (context.task.result?.state === "fail") dump("failure");
    act(() => root.unmount());
    container.remove();
  });

  it("shows Badger's plans at the catalog's prices, in both billing periods", async () => {
    await mount();
    const money = new Intl.NumberFormat("en", { style: "currency", currency: "EUR" });
    for (const plan of PLAN_ORDER) {
      const yearly = byTestId(`plan-price-${plan}`)?.textContent;
      console.info(`[${SUITE}] ${plan} yearly=${yearly} billed=${byTestId(`plan-billed-${plan}`)?.textContent ?? "-"}`);
      expect(yearly).toBe(`${money.format(planMonthlyPrice({ plan, addonCount: 0 }, "annual"))} / month`);
      if (plan !== "free") {
        expect(byTestId(`plan-billed-${plan}`)?.textContent).toBe(`Billed yearly (${money.format(planYearlyPrice({ plan, addonCount: 0 }))} / year)`);
      }
    }
    expect(byTestId("plan-billed-tier1")?.textContent).toBe("Billed yearly (€29.90 / year)");
    await click("plan-period-monthly");
    expect(byTestId("plan-price-tier1")?.textContent).toBe("€2.99 / month");
    expect(byTestId("plan-price-tier3")?.textContent).toBe("€13.99 / month");
    expect(window.localStorage.getItem("sf_billing_period")).toBe("monthly");
  });

  it("opens Stancer's hosted page in the browser, waits, and shows the paid plan", async () => {
    await mount();
    await choose("tier2");
    dump("waiting");
    expect(parrot.startCheckout).toHaveBeenCalledWith({ plan: "tier2", billingPeriod: "annual", addonCount: 0, lang: "en" });
    expect(parrot.updateSubscription).not.toHaveBeenCalled();
    expect(openSpy).toHaveBeenCalledWith(HOSTED_URL, "_blank", "noopener,noreferrer");
    expect(byTestId("plan-waiting")).not.toBeNull();
    expect((byTestId("plan-choose-tier1") as HTMLButtonElement).disabled).toBe(true);

    parrot.completePayment.mockResolvedValue(ok({ outcome: "paid" }));
    parrot.getSubscription.mockResolvedValue(subscription("tier2"));
    parrot.getBillingStatus.mockResolvedValue(ok(STATUS_RUNNING));
    await click("plan-check-now");
    dump("paid");
    expect(parrot.completePayment).toHaveBeenCalledWith("pay_1");
    expect(byTestId("plan-waiting")).toBeNull();
    expect(byTestId("plan-message")?.textContent).toBe("Payment received. Your plan is now active.");
    expect(byTestId("plan-current")?.textContent).toContain("Current plan: Standard");
  });

  it("says a refused card was not charged when the window gets the focus back", async () => {
    await mount();
    await choose("tier1");
    parrot.completePayment.mockResolvedValue(ok({ outcome: "refused" }));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await flush();
    expect(byTestId("plan-message")?.textContent).toBe("Your card was refused. Nothing was charged; try another card.");
    expect(byTestId("plan-current")?.textContent).toContain("Current plan: Free");
  });

  it("never opens a checkout page that is not Stancer's", async () => {
    parrot.startCheckout.mockResolvedValue(ok({ url: "https://evil.example/pay", paymentId: "pay_x" }));
    await mount();
    await choose("tier1");
    expect(openSpy).not.toHaveBeenCalled();
    expect(byTestId("plan-message")?.textContent).toBe("Something went wrong. Please try again.");
  });

  it("greys the paid plans with the server's reason when it refuses a checkout", async () => {
    parrot.getSubscription.mockResolvedValue(subscription("tier1"));
    parrot.getBillingStatus.mockResolvedValue(ok(STATUS_RENEWAL));
    await mount();
    dump("renewal_pending");
    expect(byTestId("plan-unavailable")?.dataset.reason).toBe("renewal_pending");
    expect(byTestId("plan-unavailable")?.textContent).toBe(t("plan.unavailable.renewalPending"));
    for (const plan of ["tier2", "tier3"]) {
      expect(byTestId(`plan-card-${plan}`)?.dataset.greyed).toBe("true");
      expect((byTestId(`plan-choose-${plan}`) as HTMLButtonElement).disabled).toBe(true);
    }
    expect(byTestId("plan-card-free")?.dataset.greyed).toBe("false");
  });

  it("ACCT-PLAN-07: offers every plan during a paid period; a move down is booked, shown with its date, and dropped by keeping the current plan", async () => {
    parrot.getSubscription.mockResolvedValue(subscription("tier2"));
    parrot.getBillingStatus.mockResolvedValue(ok(STATUS_RUNNING));
    parrot.updateSubscription.mockResolvedValueOnce(ok({ outcome: "booked", effectiveAt: BOOKED.effectiveAt }));
    await mount();
    expect(byTestId("plan-unavailable")).toBeNull();
    for (const plan of ["tier1", "tier3"]) expect((byTestId(`plan-choose-${plan}`) as HTMLButtonElement).disabled, plan).toBe(false);
    const date = formatAccessDate(BOOKED.effectiveAt, "en");

    parrot.getSubscription.mockResolvedValue(subscription("tier2", { scheduledChange: BOOKED }));
    await choose("tier1");
    dump("booked");
    expect(parrot.updateSubscription).toHaveBeenCalledWith("tier1", { billingPeriod: "annual", addonCount: 0 });
    expect(parrot.startCheckout).not.toHaveBeenCalled();
    expect(byTestId("plan-message")?.textContent).toBe(t("plan.booked", { date: date! }));
    expect(byTestId("plan-scheduled-change")?.dataset.fits).toBe("true");
    expect(byTestId("plan-scheduled-change")?.textContent).toContain(t("plan.scheduledChange", { plan: "Starter", date: date! }));
    expect(byTestId("plan-scheduled-too-large")).toBeNull();

    parrot.updateSubscription.mockResolvedValueOnce(ok({ outcome: "booking_cancelled" }));
    parrot.getSubscription.mockResolvedValue(subscription("tier2"));
    await click("plan-cancel-booking");
    expect(parrot.updateSubscription).toHaveBeenLastCalledWith("tier2", { billingPeriod: "annual", addonCount: 0 });
    expect(byTestId("plan-message")?.textContent).toBe(t("plan.bookingCancelled"));
    expect(byTestId("plan-scheduled-change")).toBeNull();
  });

  it("ACCT-PLAN-08: refuses a plan the library does not fit, with the amount to remove", async () => {
    parrot.getSubscription.mockResolvedValue(subscription("tier2"));
    parrot.getBillingStatus.mockResolvedValue(ok(STATUS_RUNNING));
    parrot.updateSubscription.mockResolvedValue({ ok: false, code: "library_too_large", excessBytes: 5_000_000_000 });
    await mount();
    await choose("tier1");
    dump("too-large");
    expect(byTestId("plan-message")?.textContent).toBe(t("plan.tooLarge", { excess: formatLocalizedStorage(5_000_000_000, "en") }));
    expect(parrot.startCheckout).not.toHaveBeenCalled();
    expect(byTestId("plan-current")?.textContent).toContain("Current plan: Standard");
  });

  it("ACCT-PLAN-08, ACCT-PLAN-11: warns that a booked plan does not fit, and shows a held renewal's charge date", async () => {
    parrot.getSubscription.mockResolvedValue(
      subscription("tier2", {
        scheduledChange: { ...BOOKED, fits: false, excessBytes: 2_000_000_000 },
        renewalHold: { chargeAt: "2027-11-10T00:00:00.000Z" },
      }),
    );
    parrot.getBillingStatus.mockResolvedValue(ok(STATUS_RUNNING));
    await mount();
    dump("hold");
    const date = formatAccessDate(BOOKED.effectiveAt, "en")!;
    expect(byTestId("plan-scheduled-change")?.dataset.fits).toBe("false");
    expect(byTestId("plan-scheduled-too-large")?.textContent).toBe(
      t("plan.scheduledTooLarge", { excess: formatLocalizedStorage(2_000_000_000, "en"), date }),
    );
    expect(byTestId("plan-renewal-hold")?.textContent).toBe(t("plan.renewalHold", { date: formatAccessDate("2027-11-10T00:00:00.000Z", "en")! }));
  });

  it("ACCT-PLAN-07: a move up during a paid period pays the difference on Stancer's hosted page", async () => {
    parrot.getSubscription.mockResolvedValue(subscription("tier1"));
    parrot.getBillingStatus.mockResolvedValue(ok(STATUS_RUNNING));
    parrot.updateSubscription.mockResolvedValue({ ok: false, code: "checkout_required" });
    await mount();
    await choose("tier3");
    dump("move-up");
    expect(parrot.updateSubscription).toHaveBeenCalledWith("tier3", { billingPeriod: "annual", addonCount: 0 });
    expect(parrot.startCheckout).toHaveBeenCalledWith({ plan: "tier3", billingPeriod: "annual", addonCount: 0, lang: "en" });
    expect(openSpy).toHaveBeenCalledWith(HOSTED_URL, "_blank", "noopener,noreferrer");
    expect(byTestId("plan-waiting")).not.toBeNull();
  });

  it("ACCT-PLAN-12: the current plan on the other billing period is a switch the server books", async () => {
    parrot.getSubscription.mockResolvedValue(subscription("tier2"));
    parrot.getBillingStatus.mockResolvedValue(ok(STATUS_RUNNING));
    parrot.updateSubscription.mockResolvedValue(ok({ outcome: "booked", effectiveAt: BOOKED.effectiveAt }));
    await mount();
    expect(byTestId("plan-choose-tier2")).toBeNull();
    await click("plan-period-monthly");
    expect((byTestId("plan-choose-tier2") as HTMLButtonElement).disabled).toBe(false);
    await choose("tier2");
    expect(parrot.updateSubscription).toHaveBeenCalledWith("tier2", { billingPeriod: "monthly", addonCount: 0 });
    expect(byTestId("plan-message")?.textContent).toBe(t("plan.booked", { date: formatAccessDate(BOOKED.effectiveAt, "en")! }));
  });

  it("greys every plan when the billing status cannot be read", async () => {
    parrot.getBillingStatus.mockResolvedValue({ ok: false, code: "request_failed" });
    await mount();
    expect(byTestId("plan-unavailable")?.dataset.reason).toBe("billing_unknown");
    for (const plan of ["tier1", "tier2", "tier3"]) expect((byTestId(`plan-choose-${plan}`) as HTMLButtonElement).disabled).toBe(true);
  });

  it("applies the plan at once with the stand-in, and says nothing is charged", async () => {
    parrot.getBillingStatus.mockResolvedValue(ok(STATUS_STANDIN));
    await mount();
    expect(byTestId("plan-standin")?.textContent).toBe(t("plan.standin"));
    expect(byTestId("plan-unavailable")).toBeNull();
    parrot.getSubscription.mockResolvedValue(subscription("tier1"));
    await choose("tier1");
    expect(parrot.updateSubscription).toHaveBeenCalledWith("tier1", { billingPeriod: "annual", addonCount: 0 });
    expect(parrot.startCheckout).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
    expect(byTestId("plan-message")?.textContent).toBe("Plan updated.");
    expect(byTestId("plan-current")?.textContent).toContain("Current plan: Starter");
  });

  const STATUS_PRELAUNCH = { ...STATUS_STANDIN, provider: "prelaunch", renewNow: null, paymentDeadline: null, founder: false };

  // @req ACCT-PAY-07
  it("before payments open: says so, asks first for a paid plan, then applies it at once with no checkout", async () => {
    parrot.getBillingStatus.mockResolvedValue(ok(STATUS_PRELAUNCH));
    await mount();
    expect(byTestId("plan-prelaunch")?.textContent).toBe(t("plan.prelaunch"));
    expect(byTestId("plan-standin")).toBeNull();
    await choose("tier2");
    const dialog = byTestId("plan-prelaunch-confirm");
    console.info("[plans-checkout:prelaunch] dialog", dialog?.textContent);
    expect(dialog?.getAttribute("role")).toBe("dialog");
    expect(dialog?.textContent).toContain("Free until payments open");
    expect(byTestId("plan-prelaunch-confirm-free")?.textContent).toBe(
      "Payments aren't open on SpaceFleet yet, so your Standard plan is free for now, with everything included.",
    );
    expect(byTestId("plan-prelaunch-confirm-email")?.textContent).toBe(t("plan.prelaunchConfirm.emailYear"));
    expect(byTestId("plan-prelaunch-confirm-start")?.textContent).toBe("Start my free Standard plan");
    expect(parrot.updateSubscription).not.toHaveBeenCalled();
    parrot.getSubscription.mockResolvedValue(subscription("tier2"));
    await click("plan-prelaunch-confirm-start");
    console.info("[plans-checkout:prelaunch] update", parrot.updateSubscription.mock.calls[0]);
    expect(byTestId("plan-prelaunch-confirm")).toBeNull();
    expect(parrot.updateSubscription).toHaveBeenCalledWith("tier2", { billingPeriod: "annual", addonCount: 0 });
    expect(parrot.startCheckout).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
  });

  // @req ACCT-PAY-07
  it("before payments open: \"Choose another plan\" applies nothing, and the founders sentence shows only for a founder", async () => {
    parrot.getBillingStatus.mockResolvedValue(ok({ ...STATUS_PRELAUNCH, founder: true }));
    await mount();
    await click("plan-period-monthly");
    await choose("tier1");
    console.info("[plans-checkout:prelaunch] founder dialog", byTestId("plan-prelaunch-confirm-email")?.textContent);
    expect(byTestId("plan-prelaunch-confirm-email")?.textContent).toBe(
      `${t("plan.prelaunchConfirm.emailMonth")} ${t("plan.prelaunchConfirm.founder")}`,
    );
    await click("plan-prelaunch-confirm-cancel");
    expect(byTestId("plan-prelaunch-confirm")).toBeNull();
    expect(byTestId("plan-confirm")).toBeNull();
    expect(parrot.updateSubscription).not.toHaveBeenCalled();
    expect(parrot.startCheckout).not.toHaveBeenCalled();
    act(() => root.unmount());
    container.remove();

    parrot.getBillingStatus.mockResolvedValue(ok({ ...STATUS_PRELAUNCH, founder: null }));
    await mount();
    await choose("tier1");
    console.info("[plans-checkout:prelaunch] unknown-founder dialog", byTestId("plan-prelaunch-confirm-email")?.textContent);
    expect(byTestId("plan-prelaunch-confirm-email")?.textContent).toBe(t("plan.prelaunchConfirm.emailMonth"));
  });

  // @req ACCT-PAY-07
  it("before payments open: a paid plan reads the three-line note, never paid until, and moving to Free applies at once", async () => {
    parrot.getBillingStatus.mockResolvedValue(ok(STATUS_PRELAUNCH));
    parrot.getSubscription.mockResolvedValue(subscription("tier2", { paidUntil: null }));
    await mount();
    const note = byTestId("plan-prelaunch");
    console.info("[plans-checkout:prelaunch] paid note", note?.outerHTML);
    expect(Array.from(note!.querySelectorAll("p")).map((p) => p.textContent)).toEqual([
      "Payments aren't open yet: your Standard plan is free for now, with everything included.",
      t("plan.prelaunchNote.emailYear"),
      t("plan.prelaunchNote.unpaid"),
    ]);
    expect(byTestId("plan-paid-until")).toBeNull();
    await choose("free");
    expect(byTestId("plan-prelaunch-confirm")).toBeNull();
    expect(parrot.updateSubscription).toHaveBeenCalledWith("free", { billingPeriod: "annual", addonCount: 0 });
  });

  // @req ACCT-PAY-07
  it("before payments open in French: the confirmation reads in French with the offer's name", async () => {
    parrot.getBillingStatus.mockResolvedValue(ok(STATUS_PRELAUNCH));
    await mount("fr");
    await choose("tier2");
    const dialog = byTestId("plan-prelaunch-confirm")?.textContent ?? "";
    console.info("[plans-checkout:prelaunch] fr dialog", dialog);
    expect(dialog).toContain("Gratuit jusqu’à l’ouverture des paiements");
    expect(dialog).toContain("votre offre Standard est donc gratuite");
    expect(byTestId("plan-prelaunch-confirm-start")?.textContent).toBe("Commencer mon offre Standard gratuite");
    expect(byTestId("plan-prelaunch-confirm-cancel")?.textContent).toBe("Choisir une autre offre");
    expect(dialog).not.toMatch(/formule/i);
  });

  // @req ACCT-PAY-07
  it("payments open with a deadline: says the plan is free until the deadline, never paid until", async () => {
    const DEADLINE = "2026-11-26T10:00:00.000Z";
    parrot.getBillingStatus.mockResolvedValue(
      ok({ ...STATUS_FREE, renewNow: { reason: "payments_open", cardExpired: false }, paymentDeadline: DEADLINE, founder: null }),
    );
    parrot.getSubscription.mockResolvedValue(subscription("tier1", { paidUntil: DEADLINE, billingPeriod: "monthly" }));
    await mount();
    const notice = byTestId("plan-payment-deadline")?.textContent;
    console.info("[plans-checkout:grace] notice", notice);
    expect(notice).toBe(
      `Free until ${formatAccessDate(DEADLINE, "en")}. Pay now to keep your Starter plan; your first paid month starts the day you pay.`,
    );
    expect(byTestId("plan-paid-until")).toBeNull();
    expect(byTestId("plan-current")?.textContent).not.toMatch(/paid until|ends on/i);
  });

  // @req ACCT-PAY-07
  it("payments open with a deadline: Pay now starts a checkout of the current plan on its own period", async () => {
    const DEADLINE = "2026-11-26T10:00:00.000Z";
    parrot.getBillingStatus.mockResolvedValue(
      ok({ ...STATUS_FREE, renewNow: { reason: "payments_open", cardExpired: false }, paymentDeadline: DEADLINE, founder: null }),
    );
    parrot.getSubscription.mockResolvedValue(subscription("tier1", { paidUntil: DEADLINE, billingPeriod: "monthly" }));
    await mount();
    const button = byTestId("plan-pay-now") as HTMLButtonElement | null;
    console.info("[plans-checkout:grace-pay] button", button?.textContent, "disabled", button?.disabled);
    expect(button?.textContent).toBe("Pay now");
    await click("plan-pay-now");
    dump("grace-pay");
    expect(parrot.startCheckout).toHaveBeenCalledWith({ plan: "tier1", billingPeriod: "monthly", addonCount: 0, lang: "en" });
    expect(parrot.updateSubscription).not.toHaveBeenCalled();
    expect(openSpy).toHaveBeenCalledWith(HOSTED_URL, "_blank", "noopener,noreferrer");
  });

  // @req ACCT-PAY-07
  it("offers no Pay now outside the payments-open window", async () => {
    parrot.getSubscription.mockResolvedValue(subscription("tier1", { billingPeriod: "monthly" }));
    await mount();
    console.info("[plans-checkout:no-pay-now]", byTestId("plan-current")?.textContent);
    expect(byTestId("plan-pay-now")).toBeNull();
  });

  it("words API errors the way Badger does", async () => {
    parrot.startCheckout.mockResolvedValue({ ok: false, code: "billing_unavailable" });
    await mount();
    await choose("tier1");
    expect(byTestId("plan-message")?.textContent).toBe(t("plan.error.paymentsUnavailable"));
  });

  // @req WAIT-FOUND-01
  // @req ACCT-PLAN-15 (Free shows its price alone: nothing struck through, no billed-yearly line)
  it("a founder sees the founder price on every paid plan: the plan −30%, extra Scale blocks at full price", async () => {
    parrot.getBillingStatus.mockResolvedValue(ok({ ...STATUS_FREE, founder: true }));
    await mount();
    const snapshot = () =>
      PLAN_ORDER.map((plan) => ({
        plan,
        list: byTestId(`plan-list-price-${plan}`)?.textContent ?? null,
        price: byTestId(`plan-price-${plan}`)?.textContent ?? null,
        billed: byTestId(`plan-billed-${plan}`)?.textContent ?? null,
        label: byTestId(`plan-founder-${plan}`)?.textContent ?? null,
      }));
    console.info(`[${SUITE}:founder] annual`, JSON.stringify(snapshot()));
    // Standard yearly: list €4.99 a month; founder 59.90 − 17.97 = €41.93 a year, €3.49 a month.
    expect(byTestId("plan-list-price-tier2")?.textContent).toBe("€4.99");
    expect(byTestId("plan-list-price-tier2")?.className).toContain("line-through");
    expect(byTestId("plan-price-tier2")?.textContent).toBe("€4.99€3.49 / month");
    expect(byTestId("plan-billed-tier2")?.textContent).toBe("Billed yearly (€41.93 / year)");
    expect(byTestId("plan-founder-tier2")?.textContent).toBe("Founder price, −30% for life");
    expect(byTestId("plan-founder-free")).toBeNull();
    expect(byTestId("plan-list-price-free")).toBeNull();
    expect(byTestId("plan-billed-free")).toBeNull();
    // Scale with 2 extra blocks: only the plan is discounted (131.88 − 39.56), the blocks stay at full price.
    await act(async () => {
      const blocks = byTestId("plan-scale-blocks") as HTMLInputElement;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(blocks, "2");
      blocks.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();
    const money = new Intl.NumberFormat("en", { style: "currency", currency: "EUR" });
    const listYearly = planYearlyPrice({ plan: "tier3", addonCount: 2 });
    console.info(`[${SUITE}:founder] scale + 2 blocks`, listYearly, byTestId("plan-billed-tier3")?.textContent);
    expect(byTestId("plan-billed-tier3")?.textContent).toBe(`Billed yearly (${money.format(Math.round(listYearly * 100 - 3956) / 100)} / year)`);
    await click("plan-period-monthly");
    console.info(`[${SUITE}:founder] monthly`, JSON.stringify(snapshot()));
    expect(byTestId("plan-price-tier1")?.textContent).toBe("€2.99€2.09 / month");
    expect(byTestId("plan-price-tier2")?.textContent).toBe("€5.99€4.19 / month");
  });

  // @req WAIT-FOUND-01
  it("a non-founder sees the list price, with no founder line", async () => {
    parrot.getBillingStatus.mockResolvedValue(ok({ ...STATUS_FREE, founder: false }));
    await mount();
    console.info(`[${SUITE}:non-founder]`, byTestId("plan-price-tier2")?.textContent, byTestId("plan-billed-tier2")?.textContent);
    expect(byTestId("plan-price-tier2")?.textContent).toBe("€4.99 / month");
    expect(byTestId("plan-billed-tier2")?.textContent).toBe("Billed yearly (€59.90 / year)");
    expect(byTestId("plan-list-price-tier2")).toBeNull();
    expect(byTestId("plan-founder-tier2")).toBeNull();
  });
});
