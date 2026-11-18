// @req ACCT-PAY-01 @req ACCT-PLAN-07 @req ACCT-PLAN-08
/**
 * The shared plan change (ACCT-PAY-01, ACCT-PLAN-07/08) that the website and the desktop apps (Badger,
 * Parrot) use: which path a plan takes for each billing provider, what the server's plan change answers
 * (applied, booked, booking dropped, refused with the bytes to remove, checkout required), and the hosted
 * payment wait (open the page, check the result until settled, stop, time out, check at once, open again).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PlanChangeRefusal,
  createPlanChangeController,
  isStancerPaymentUrl,
  paymentPageLang,
  paymentsNotOpen,
  planChangeMessage,
  resolvePlanAction,
  type BillingStatus,
  type PaymentOutcome,
  type PlanChangeApi,
  type PlanChangeController,
  type PlanChangeState,
  type SubscriptionChangeAnswer,
} from "../src/billingCheckout";

const SUITE = "billing-checkout";

// Every fixture is a state `GET /billing/status` can answer: `checkoutAllowed` is the server's own
// checkout rule (no running paid period, no renewal being charged), never derived from `live`.
const CARD = { brand: "visa", last4: "4242", expMonth: 12, expYear: 2030 };
/** The fields every fixture leaves at their plain value: no renew-now offer, no prelaunch deadline, not a founder. */
const PLAIN = { renewNow: null, paymentDeadline: null, founder: false } as const;
const STANDIN: BillingStatus = { ...PLAIN, provider: "standin", checkoutAllowed: false, checkoutBlockedReason: "billing_provider_standin", subscription: null };
const PRELAUNCH: BillingStatus = { ...PLAIN, provider: "prelaunch", checkoutAllowed: false, checkoutBlockedReason: "billing_provider_standin", subscription: null };
/** Free account that never paid. */
const STANCER_NONE: BillingStatus = { ...PLAIN, provider: "stancer", checkoutAllowed: true, checkoutBlockedReason: null, subscription: null };
/** The paid period ended and was not renewed: free again, a new checkout is allowed. */
const STANCER_LAPSED: BillingStatus = {
  ...PLAIN,
  provider: "stancer",
  checkoutAllowed: true,
  checkoutBlockedReason: null,
  subscription: { cancelAtPeriodEnd: false, live: false, card: CARD },
};
/** A paid period runs and renews. */
const STANCER_LIVE: BillingStatus = {
  ...PLAIN,
  provider: "stancer",
  checkoutAllowed: false,
  checkoutBlockedReason: "paid_period_running",
  subscription: { cancelAtPeriodEnd: false, live: true, card: CARD },
};
/** A paid period still runs but ends after "back to free": not live, yet no checkout. */
const STANCER_ENDING: BillingStatus = {
  ...PLAIN,
  provider: "stancer",
  checkoutAllowed: false,
  checkoutBlockedReason: "paid_period_running",
  subscription: { cancelAtPeriodEnd: true, live: false, card: CARD },
};
/** A granted paid period (no card): not live, yet no checkout. */
const STANCER_GRANTED: BillingStatus = { ...PLAIN, provider: "stancer", checkoutAllowed: false, checkoutBlockedReason: "paid_period_running", subscription: null };
/** The period ended and the worker is charging the renewal. */
const STANCER_RENEWAL: BillingStatus = {
  ...PLAIN,
  provider: "stancer",
  checkoutAllowed: false,
  checkoutBlockedReason: "renewal_pending",
  subscription: { cancelAtPeriodEnd: false, live: false, card: CARD },
};
/** An API from before `checkoutAllowed`: it cannot say, so nothing payable is offered. */
const STANCER_OLD_SERVER = { provider: "stancer", subscription: null } as unknown as BillingStatus;

const REQUEST = { plan: "tier2", billingPeriod: "monthly" as const, addonCount: 0, lang: "en" };

type Harness = {
  controller: PlanChangeController;
  api: { [K in keyof PlanChangeApi]: ReturnType<typeof vi.fn> };
  openUrl: ReturnType<typeof vi.fn>;
  states: PlanChangeState[];
  logs: string[];
};

let harness: Harness | null = null;

const setup = (
  outcomes: Array<PaymentOutcome | Error> = [],
  options: { intervalMs?: number; timeoutMs?: number } = {},
): Harness => {
  const queue = [...outcomes];
  const api = {
    updateSubscription: vi.fn(async (): Promise<SubscriptionChangeAnswer> => ({ outcome: "applied" })),
    startCheckout: vi.fn(async () => ({ url: "https://payment.stancer.com/test/pi_1", paymentId: "pay_1", paid: false })),
    completePayment: vi.fn(async () => {
      const next = queue.shift() ?? "pending";
      if (next instanceof Error) throw next;
      return { outcome: next };
    }),
  };
  const openUrl = vi.fn();
  const logs: string[] = [];
  const controller = createPlanChangeController({
    api,
    openUrl,
    intervalMs: options.intervalMs ?? 1_000,
    timeoutMs: options.timeoutMs ?? 10_000,
    log: {
      info: (message, details) => logs.push(`info ${message} ${JSON.stringify(details ?? {})}`),
      warn: (message, details) => logs.push(`warn ${message} ${JSON.stringify(details ?? {})}`),
    },
  });
  const states: PlanChangeState[] = [];
  controller.subscribe((state) => states.push(state));
  harness = { controller, api, openUrl, states, logs };
  return harness;
};

beforeEach(() => {
  vi.useFakeTimers();
  harness = null;
});

afterEach((context) => {
  if (context.task.result?.state === "fail" && harness) {
    console.error(`[${SUITE}] FAILED ${context.task.name}`);
    console.error(`[${SUITE}] states=${JSON.stringify(harness.states)}`);
    console.error(`[${SUITE}] logs=\n${harness.logs.join("\n")}`);
    console.error(`[${SUITE}] completePayment calls=${JSON.stringify(harness.api.completePayment.mock.calls)}`);
  }
  harness?.controller.dispose();
  vi.useRealTimers();
});

describe("resolvePlanAction", () => {
  // @bugfix
  // @regression-proof
  it("@req ACCT-PLAN-07 offers a checkout only when the server says it would accept one, a change the server decides during a paid period, and says why otherwise", () => {
    const cases: Array<[string, string, BillingStatus | null, string]> = [
      ["tier1", "standin", STANDIN, "change"],
      ["free", "standin", STANDIN, "change"],
      ["tier3", "prelaunch", PRELAUNCH, "change"],
      ["free", "prelaunch", PRELAUNCH, "change"],
      ["tier1", "never paid", STANCER_NONE, "checkout"],
      ["tier3", "lapsed", STANCER_LAPSED, "checkout"],
      ["free", "live", STANCER_LIVE, "change"],
      ["free", "never paid", STANCER_NONE, "change"],
      ["tier2", "live", STANCER_LIVE, "change"],
      ["tier2", "ending after back to free", STANCER_ENDING, "change"],
      ["tier1", "granted", STANCER_GRANTED, "change"],
      ["tier3", "renewal being charged", STANCER_RENEWAL, "unavailable:renewal_pending"],
      ["tier2", "older server", STANCER_OLD_SERVER, "unavailable:billing_unknown"],
      ["tier2", "unknown", null, "unavailable:billing_unknown"],
      ["free", "unknown", null, "unavailable:billing_unknown"],
    ];
    for (const [plan, name, billing, expected] of cases) {
      const action = resolvePlanAction(plan, billing);
      const got = action.kind === "unavailable" ? `unavailable:${action.reason}` : action.kind;
      console.info(
        `[${SUITE}] ${plan} / ${name}: checkoutAllowed=${billing?.checkoutAllowed ?? "-"} reason=${billing?.checkoutBlockedReason ?? "-"} -> ${got}`,
      );
      expect(got, name).toBe(expected);
    }
  });
});

describe("paymentsNotOpen", () => {
  it("@req ACCT-PAY-07 is true only in the launch-without-payments mode", () => {
    const got = [PRELAUNCH, STANDIN, STANCER_NONE, null].map((b) => paymentsNotOpen(b));
    console.info(`[${SUITE}] paymentsNotOpen prelaunch/standin/stancer/null -> ${got.join(",")}`);
    expect(got).toEqual([true, false, false, false]);
  });
});

describe("isStancerPaymentUrl", () => {
  // @bugfix
  it("accepts only Stancer's own https pages", () => {
    const cases: Array<[string, boolean]> = [
      ["https://payment.stancer.com/pi_1", true],
      ["https://stancer.com/pay", true],
      ["https://PAYMENT.Stancer.com/pi_1", true],
      ["http://payment.stancer.com/pi_1", false],
      ["https://payment.stancer.test/pi_1", false],
      ["https://evilstancer.com/pi_1", false],
      ["https://stancer.com.evil.com/pi_1", false],
      ["https://user:pw@payment.stancer.com/pi_1", false],
      ["https://payment.stancer.com@evil.com/pi_1", false],
      ["javascript:alert(1)//stancer.com", false],
      ["file:///etc/passwd", false],
      ["not a url", false],
    ];
    for (const [url, expected] of cases) {
      console.info(`[${SUITE}] isStancerPaymentUrl ${url} -> ${isStancerPaymentUrl(url)}`);
      expect(isStancerPaymentUrl(url), url).toBe(expected);
    }
  });
});

describe("planChangeMessage", () => {
  it("names one message per result, so every app words a result the same way", () => {
    expect(planChangeMessage({ kind: "changed" })).toEqual({ id: "changed" });
    expect(planChangeMessage({ kind: "timeout" })).toEqual({ id: "timeout" });
    expect(planChangeMessage({ kind: "endsAt", effectiveAt: "2027-01-01T00:00:00Z" })).toEqual({ id: "endsAt", effectiveAt: "2027-01-01T00:00:00Z" });
    expect(planChangeMessage({ kind: "unavailable", reason: "renewal_pending" })).toEqual({ id: "unavailable", reason: "renewal_pending" });
    expect(planChangeMessage({ kind: "error", code: "billing_unavailable" })).toEqual({ id: "paymentsUnavailable" });
    expect(planChangeMessage({ kind: "error", code: "subscription_active" })).toEqual({ id: "generic" });
    expect(planChangeMessage({ kind: "error", code: "checkout_required" })).toEqual({ id: "generic" });
    expect(planChangeMessage({ kind: "booked", effectiveAt: "2027-01-01T00:00:00Z" })).toEqual({ id: "booked", effectiveAt: "2027-01-01T00:00:00Z" });
    expect(planChangeMessage({ kind: "bookingCancelled" })).toEqual({ id: "bookingCancelled" });
    expect(planChangeMessage({ kind: "unchanged" })).toEqual({ id: "unchanged" });
    expect(planChangeMessage({ kind: "tooLarge", excessBytes: 5e9 })).toEqual({ id: "tooLarge", excessBytes: 5e9 });
    expect(planChangeMessage({ kind: "error", code: "checkout_in_progress" })).toEqual({ id: "checkoutInProgress" });
    expect(planChangeMessage({ kind: "error", code: "request_failed" })).toEqual({ id: "generic" });
  });
});

describe("paymentPageLang", () => {
  it("shows Stancer's page in French for French and in English otherwise", () => {
    expect(paymentPageLang("fr")).toBe("fr");
    expect(paymentPageLang("fr-BE")).toBe("fr");
    expect(paymentPageLang("nl")).toBe("en");
    expect(paymentPageLang(undefined)).toBe("en");
  });
});

describe("createPlanChangeController", () => {
  it("applies the plan directly with the stand-in provider", async () => {
    const h = setup();
    const result = await h.controller.run({ ...REQUEST, plan: "tier3", addonCount: 2 }, STANDIN);
    console.info(`[${SUITE}] standin result=${JSON.stringify(result)}`);
    expect(result).toEqual({ kind: "changed" });
    expect(h.api.updateSubscription).toHaveBeenCalledWith("tier3", { billingPeriod: "monthly", addonCount: 2 });
    expect(h.api.startCheckout).not.toHaveBeenCalled();
    expect(h.openUrl).not.toHaveBeenCalled();
    expect(h.states.map((s) => s.phase)).toEqual(["working", "done"]);
  });

  it("opens Stancer's hosted page and finishes paid once the payment settles", async () => {
    const h = setup(["pending", "paid"]);
    const done = h.controller.run(REQUEST, STANCER_NONE);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.api.startCheckout).toHaveBeenCalledWith({ plan: "tier2", billingPeriod: "monthly", addonCount: 0, lang: "en" });
    expect(h.openUrl).toHaveBeenCalledWith("https://payment.stancer.com/test/pi_1");
    expect(h.controller.getState()).toMatchObject({ phase: "waiting", paymentId: "pay_1", checks: 0 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.controller.getState()).toMatchObject({ phase: "waiting", checks: 1 });
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await done;
    console.info(`[${SUITE}] checkout result=${JSON.stringify(result)} checks=${h.api.completePayment.mock.calls.length}`);
    expect(result).toEqual({ kind: "paid" });
    expect(h.api.completePayment).toHaveBeenCalledTimes(2);
    expect(h.api.completePayment).toHaveBeenCalledWith("pay_1");
    expect(h.api.updateSubscription).not.toHaveBeenCalled();
    expect(h.controller.getState()).toEqual({ phase: "done", plan: "tier2", result: { kind: "paid" } });
  });

  // @req ACCT-GRANT-01
  it("finishes paid without opening a page when the account's grants paid the checkout", async () => {
    const h = setup();
    h.api.startCheckout.mockResolvedValue({ url: "https://web.test/en/settings?billing=return&payment=pay_free", paymentId: "pay_free", paid: true });
    const result = await h.controller.run(REQUEST, STANCER_NONE);
    console.info(`[${SUITE}] grants-paid result=${JSON.stringify(result)} states=${JSON.stringify(h.states)}`);
    expect(result).toEqual({ kind: "paid" });
    expect(h.openUrl).not.toHaveBeenCalled();
    expect(h.api.completePayment).not.toHaveBeenCalled();
    expect(h.controller.getState()).toEqual({ phase: "done", plan: "tier2", result: { kind: "paid" } });
  });

  it("reports a refused card and a cancelled payment", async () => {
    for (const outcome of ["refused", "canceled"] as const) {
      const h = setup([outcome]);
      const done = h.controller.run(REQUEST, STANCER_LAPSED);
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await done;
      console.info(`[${SUITE}] ${outcome} result=${JSON.stringify(result)}`);
      expect(result).toEqual({ kind: outcome });
      h.controller.dispose();
    }
  });

  it("sends no add-on blocks for a plan other than Scale", async () => {
    const h = setup(["paid"]);
    const done = h.controller.run({ ...REQUEST, plan: "tier1", addonCount: 4 }, STANCER_NONE);
    await vi.advanceTimersByTimeAsync(1_000);
    await done;
    expect(h.api.startCheckout).toHaveBeenCalledWith(expect.objectContaining({ plan: "tier1", addonCount: 0 }));
  });

  it("checks at once when asked (the window came back into focus)", async () => {
    const h = setup(["paid"], { intervalMs: 60_000 });
    const done = h.controller.run(REQUEST, STANCER_NONE);
    await vi.advanceTimersByTimeAsync(0);
    h.controller.checkNow();
    await vi.advanceTimersByTimeAsync(0);
    const result = await done;
    console.info(`[${SUITE}] checkNow result=${JSON.stringify(result)}`);
    expect(result).toEqual({ kind: "paid" });
    expect(h.api.completePayment).toHaveBeenCalledTimes(1);
  });

  // @req ACCT-PAY-05
  it("checks at once when the payment page returned to the app for the awaited payment, ignores any other", async () => {
    const h = setup(["paid"], { intervalMs: 60_000 });
    const done = h.controller.run(REQUEST, STANCER_NONE);
    await vi.advanceTimersByTimeAsync(0);
    console.info(`[${SUITE}] phase=other-payment`);
    h.controller.paymentReturned("pay_other");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.api.completePayment).not.toHaveBeenCalled();
    expect(h.logs.some((line) => line.startsWith("warn payment return ignored"))).toBe(true);
    console.info(`[${SUITE}] phase=awaited-payment`);
    h.controller.paymentReturned("pay_1");
    await vi.advanceTimersByTimeAsync(0);
    const result = await done;
    console.info(`[${SUITE}] paymentReturned result=${JSON.stringify(result)}`);
    expect(result).toEqual({ kind: "paid" });
    expect(h.api.completePayment).toHaveBeenCalledTimes(1);
    expect(h.api.completePayment).toHaveBeenCalledWith("pay_1");
  });

  it("opens the hosted page again on request", async () => {
    const h = setup();
    void h.controller.run(REQUEST, STANCER_NONE);
    await vi.advanceTimersByTimeAsync(0);
    h.controller.reopen();
    expect(h.openUrl).toHaveBeenCalledTimes(2);
    expect(h.openUrl).toHaveBeenLastCalledWith("https://payment.stancer.com/test/pi_1");
  });

  it("stops waiting when the user says so, and checks no more", async () => {
    const h = setup();
    const done = h.controller.run(REQUEST, STANCER_NONE);
    await vi.advanceTimersByTimeAsync(1_000);
    h.controller.stop();
    const result = await done;
    const calls = h.api.completePayment.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    console.info(`[${SUITE}] stop result=${JSON.stringify(result)} calls=${calls}`);
    expect(result).toEqual({ kind: "stopped" });
    expect(h.api.completePayment).toHaveBeenCalledTimes(calls);
  });

  it("gives up after the wait time, the payment may still settle later", async () => {
    const h = setup([], { intervalMs: 1_000, timeoutMs: 3_000 });
    const done = h.controller.run(REQUEST, STANCER_NONE);
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await done;
    console.info(`[${SUITE}] timeout result=${JSON.stringify(result)} calls=${h.api.completePayment.mock.calls.length}`);
    expect(result).toEqual({ kind: "timeout" });
  });

  it("retries a failed check, but ends on a payment the server does not know", async () => {
    const h = setup([new Error("billing_unavailable"), new TypeError("Failed to fetch"), "paid"]);
    const done = h.controller.run(REQUEST, STANCER_NONE);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await done).toEqual({ kind: "paid" });

    const lost = setup([new Error("payment_not_found")]);
    const lostDone = lost.controller.run(REQUEST, STANCER_NONE);
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await lostDone;
    console.info(`[${SUITE}] not-found result=${JSON.stringify(result)}`);
    expect(result).toEqual({ kind: "error", code: "payment_not_found" });
  });

  it("@req ACCT-PLAN-07 ends a Stancer subscription at the end of the paid period on back to free", async () => {
    const h = setup();
    h.api.updateSubscription.mockResolvedValue({ outcome: "booked", effectiveAt: "2026-12-07T00:00:00.000Z" });
    const result = await h.controller.run({ ...REQUEST, plan: "free", addonCount: 3 }, STANCER_LIVE);
    console.info(`[${SUITE}] back-to-free result=${JSON.stringify(result)}`);
    expect(result).toEqual({ kind: "endsAt", effectiveAt: "2026-12-07T00:00:00.000Z" });
    expect(h.api.updateSubscription).toHaveBeenCalledWith("free", { billingPeriod: "monthly", addonCount: 0 });
    expect(h.api.startCheckout).not.toHaveBeenCalled();
  });

  it("@req ACCT-PLAN-07 books a move down during a paid period, and drops the booking when the current plan is chosen again", async () => {
    const h = setup();
    h.api.updateSubscription.mockResolvedValueOnce({ outcome: "booked", effectiveAt: "2026-12-07T00:00:00.000Z" });
    expect(await h.controller.run({ ...REQUEST, plan: "tier1" }, STANCER_LIVE)).toEqual({ kind: "booked", effectiveAt: "2026-12-07T00:00:00.000Z" });
    h.api.updateSubscription.mockResolvedValueOnce({ outcome: "booking_cancelled" });
    expect(await h.controller.run(REQUEST, STANCER_LIVE)).toEqual({ kind: "bookingCancelled" });
    h.api.updateSubscription.mockResolvedValueOnce({ outcome: "unchanged" });
    expect(await h.controller.run(REQUEST, STANCER_LIVE)).toEqual({ kind: "unchanged" });
    expect(h.api.startCheckout).not.toHaveBeenCalled();
    expect(h.openUrl).not.toHaveBeenCalled();
  });

  it("@req ACCT-PLAN-08 a plan the library does not fit is refused with the bytes to remove, from the API's error or an IPC refusal", async () => {
    const h = setup();
    const apiError = Object.assign(new Error("library_too_large"), { payload: { error: "library_too_large", excessBytes: 5_000_000_000 } });
    h.api.updateSubscription.mockRejectedValueOnce(apiError);
    expect(await h.controller.run({ ...REQUEST, plan: "tier1" }, STANCER_LIVE)).toEqual({ kind: "tooLarge", excessBytes: 5_000_000_000 });
    h.api.updateSubscription.mockRejectedValueOnce(new PlanChangeRefusal("library_too_large", 1_500_000_000));
    expect(await h.controller.run({ ...REQUEST, plan: "free" }, STANCER_LIVE)).toEqual({ kind: "tooLarge", excessBytes: 1_500_000_000 });
    // A first payment the library does not fit: the checkout answers the same refusal.
    h.api.startCheckout.mockRejectedValueOnce(new PlanChangeRefusal("library_too_large", 2_000_000_000));
    expect(await h.controller.run({ ...REQUEST, plan: "tier1" }, STANCER_NONE)).toEqual({ kind: "tooLarge", excessBytes: 2_000_000_000 });
    expect(h.openUrl).not.toHaveBeenCalled();
  });

  it("@req ACCT-PLAN-07 a move up during a paid period pays the prorated difference on Stancer's hosted page", async () => {
    const h = setup(["paid"]);
    h.api.updateSubscription.mockRejectedValueOnce(new PlanChangeRefusal("checkout_required"));
    const done = h.controller.run({ ...REQUEST, plan: "tier3", addonCount: 1 }, STANCER_LIVE);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await done).toEqual({ kind: "paid" });
    expect(h.api.startCheckout).toHaveBeenCalledWith({ plan: "tier3", billingPeriod: "monthly", addonCount: 1, lang: "en" });
    expect(h.openUrl).toHaveBeenCalledWith("https://payment.stancer.com/test/pi_1");
  });

  it("calls nothing when the plan cannot be chosen", async () => {
    const h = setup();
    expect(await h.controller.run(REQUEST, STANCER_RENEWAL)).toEqual({ kind: "unavailable", reason: "renewal_pending" });
    expect(await h.controller.run(REQUEST, null)).toEqual({ kind: "unavailable", reason: "billing_unknown" });
    expect(h.api.updateSubscription).not.toHaveBeenCalled();
    expect(h.api.startCheckout).not.toHaveBeenCalled();
  });

  it("reports the API's error code when checkout cannot start", async () => {
    const h = setup();
    h.api.startCheckout.mockRejectedValue(new Error("billing_unavailable"));
    const result = await h.controller.run(REQUEST, STANCER_NONE);
    console.info(`[${SUITE}] checkout error result=${JSON.stringify(result)}`);
    expect(result).toEqual({ kind: "error", code: "billing_unavailable" });
    expect(h.openUrl).not.toHaveBeenCalled();
  });

  // @bugfix
  // @regression-proof
  it("never opens a checkout URL that is not Stancer's https page, and checks nothing for it", async () => {
    for (const url of ["http://payment.stancer.com/pi_1", "https://evil.example/pi_1", "javascript:alert(1)"]) {
      const h = setup(["paid"]);
      h.api.startCheckout.mockResolvedValue({ url, paymentId: "pay_1", paid: false });
      const result = await h.controller.run(REQUEST, STANCER_NONE);
      console.info(`[${SUITE}] bad url ${url} result=${JSON.stringify(result)}`);
      expect(result).toEqual({ kind: "error", code: "invalid_checkout_url" });
      expect(h.openUrl).not.toHaveBeenCalled();
      expect(h.api.completePayment).not.toHaveBeenCalled();
      h.controller.reopen();
      expect(h.openUrl).not.toHaveBeenCalled();
      h.controller.dispose();
    }
  });

  it("asks the server during a paid period that is ending or granted, and calls nothing while a renewal is being charged", async () => {
    const h = setup();
    expect(await h.controller.run(REQUEST, STANCER_ENDING)).toEqual({ kind: "changed" });
    expect(await h.controller.run(REQUEST, STANCER_GRANTED)).toEqual({ kind: "changed" });
    expect(h.api.updateSubscription).toHaveBeenCalledTimes(2);
    expect(await h.controller.run(REQUEST, STANCER_RENEWAL)).toEqual({ kind: "unavailable", reason: "renewal_pending" });
    expect(h.api.updateSubscription).toHaveBeenCalledTimes(2);
    expect(h.api.startCheckout).not.toHaveBeenCalled();
    expect(h.openUrl).not.toHaveBeenCalled();
  });

  it("runs one plan change at a time", async () => {
    const h = setup();
    void h.controller.run(REQUEST, STANCER_NONE);
    await vi.advanceTimersByTimeAsync(0);
    expect(await h.controller.run(REQUEST, STANCER_NONE)).toEqual({ kind: "error", code: "plan_change_in_progress" });
    expect(h.api.startCheckout).toHaveBeenCalledTimes(1);
  });
});
