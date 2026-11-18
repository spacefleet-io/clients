// @req ACCT-PAY-01 @req ACCT-PLAN-08
/**
 * The desktop's paid upgrade end to end down to HTTP: the shared plan change driving the real
 * `@space/shared/api` calls against a fake API that answers like the API's billing routes with
 * the Stancer provider (`GET /billing/status`, `POST /billing/checkout`, `POST
 * /billing/payments/{id}/complete`, `PATCH` subscription). Checks the routes, methods, bodies and
 * the bearer token the app sends, and that nothing but the hosted page URL leaves the app.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { completeStancerPayment, getBillingStatus, setApiBaseUrl, startCheckout, updateSubscription } from "../src/api";
import { createPlanChangeController, type PlanChangeApi } from "../src/billingCheckout";

const SUITE = "billing-checkout-wire";
const BASE = "https://api.test";
const TOKEN = "tok-wire";

type Call = { method: string; path: string; auth: string | null; body: unknown };

/** `running`: a paid period runs (`paid_period_running`); `PATCH` then books, or refuses a library too large. */
const fakeApi = (provider: "standin" | "stancer", outcomes: string[], running?: { excessBytes: number }) => {
  const calls: Call[] = [];
  const queue = [...outcomes];
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchMock = vi.fn(async (input: Request | string | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    const text = await request.text();
    const call: Call = {
      method: request.method,
      path: url.pathname,
      auth: request.headers.get("authorization"),
      body: text ? JSON.parse(text) : null,
    };
    calls.push(call);
    console.info(`[${SUITE}] ${call.method} ${call.path} body=${text || "-"}`);
    if (call.method === "GET" && call.path === "/billing/status") {
      // As the API answers for a free account: the stand-in never checks out, Stancer allows the first payment.
      if (running) return json(200, { provider, checkoutAllowed: false, checkoutBlockedReason: "paid_period_running", subscription: null });
      return json(
        200,
        provider === "standin"
          ? { provider, checkoutAllowed: false, checkoutBlockedReason: "billing_provider_standin", subscription: null }
          : { provider, checkoutAllowed: true, checkoutBlockedReason: null, subscription: null },
      );
    }
    if (call.method === "POST" && call.path === "/billing/checkout") {
      if (provider === "standin") return json(409, { error: "billing_provider_standin" });
      return json(200, { url: "https://payment.stancer.com/ptest_1/pi_wire", paymentId: "pay_wire", paid: false });
    }
    if (call.method === "POST" && call.path === "/billing/payments/pay_wire/complete") {
      return json(200, { outcome: queue.shift() ?? "pending" });
    }
    if (call.method === "PATCH" && call.path.endsWith("/subscription")) {
      const plan = (call.body as { plan?: string } | null)?.plan;
      if (running && running.excessBytes > 0) return json(409, { error: "library_too_large", excessBytes: running.excessBytes });
      if (running) return json(200, { user: { id: "u1" }, outcome: "booked", effectiveAt: "2026-12-07T00:00:00.000Z" });
      if (provider === "stancer" && plan !== "free") return json(409, { error: "checkout_required" });
      return provider === "stancer"
        ? json(200, { user: { id: "u1" }, outcome: "booked", effectiveAt: "2026-12-07T00:00:00.000Z" })
        : json(200, { user: { id: "u1" }, outcome: "applied" });
    }
    return json(404, { error: "not_found" });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls };
};

const boundApi: PlanChangeApi = {
  updateSubscription: (plan, options) => updateSubscription(TOKEN, plan, options),
  startCheckout: (input) => startCheckout(TOKEN, input),
  completePayment: (paymentId) => completeStancerPayment(TOKEN, paymentId),
};

let lastCalls: Call[] = [];

afterEach((context) => {
  if (context.task.result?.state === "fail") {
    console.error(`[${SUITE}] FAILED ${context.task.name} calls=\n${JSON.stringify(lastCalls, null, 2)}`);
  }
  vi.unstubAllGlobals();
  setApiBaseUrl("/api");
});

describe("plan change over the wire", () => {
  it("Stancer: reads the provider, starts checkout, opens the hosted page, completes until paid", async () => {
    setApiBaseUrl(BASE);
    const { calls } = fakeApi("stancer", ["pending", "paid"]);
    lastCalls = calls;
    const opened: string[] = [];
    const controller = createPlanChangeController({ api: boundApi, openUrl: (url) => opened.push(url), intervalMs: 5 });

    const billing = await getBillingStatus(TOKEN);
    const result = await controller.run({ plan: "tier3", billingPeriod: "annual", addonCount: 2, lang: "fr" }, billing);
    console.info(`[${SUITE}] stancer result=${JSON.stringify(result)} opened=${JSON.stringify(opened)}`);

    expect(result).toEqual({ kind: "paid" });
    expect(opened).toEqual(["https://payment.stancer.com/ptest_1/pi_wire"]);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /billing/status",
      "POST /billing/checkout",
      "POST /billing/payments/pay_wire/complete",
      "POST /billing/payments/pay_wire/complete",
    ]);
    expect(calls[1]!.body).toEqual({ plan: "tier3", billingPeriod: "annual", addonCount: 2, lang: "fr" });
    for (const call of calls) expect(call.auth).toBe(`Bearer ${TOKEN}`);
  });

  it("Stancer: back to free goes through the plan change endpoint and returns the end date", async () => {
    setApiBaseUrl(BASE);
    const { calls } = fakeApi("stancer", []);
    lastCalls = calls;
    const controller = createPlanChangeController({ api: boundApi, openUrl: () => undefined });
    const billing = await getBillingStatus(TOKEN);
    const result = await controller.run({ plan: "free", billingPeriod: "monthly", addonCount: 0, lang: "en" }, billing);
    console.info(`[${SUITE}] back-to-free result=${JSON.stringify(result)}`);
    expect(result).toEqual({ kind: "endsAt", effectiveAt: "2026-12-07T00:00:00.000Z" });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /billing/status", expect.stringMatching(/^PATCH .*\/subscription$/)]);
    expect(calls[1]!.body).toEqual({ plan: "free", billingPeriod: "monthly", addonCount: 0 });
  });

  it("stand-in: applies the plan directly and never starts a checkout", async () => {
    setApiBaseUrl(BASE);
    const { calls } = fakeApi("standin", []);
    lastCalls = calls;
    const opened: string[] = [];
    const controller = createPlanChangeController({ api: boundApi, openUrl: (url) => opened.push(url) });
    const billing = await getBillingStatus(TOKEN);
    const result = await controller.run({ plan: "tier1", billingPeriod: "monthly", addonCount: 0, lang: "en" }, billing);
    console.info(`[${SUITE}] standin result=${JSON.stringify(result)}`);
    expect(result).toEqual({ kind: "changed" });
    expect(opened).toEqual([]);
    expect(calls.some((c) => c.path.startsWith("/billing/checkout"))).toBe(false);
  });

  it("@req ACCT-PLAN-08 Stancer, paid period running: a 409 library_too_large carries the bytes to remove", async () => {
    setApiBaseUrl(BASE);
    const { calls } = fakeApi("stancer", [], { excessBytes: 5_000_000_000 });
    lastCalls = calls;
    const opened: string[] = [];
    const controller = createPlanChangeController({ api: boundApi, openUrl: (url) => opened.push(url) });
    const billing = await getBillingStatus(TOKEN);
    const result = await controller.run({ plan: "tier1", billingPeriod: "monthly", addonCount: 0, lang: "en" }, billing);
    console.info(`[${SUITE}] too-large result=${JSON.stringify(result)}`);
    expect(result).toEqual({ kind: "tooLarge", excessBytes: 5_000_000_000 });
    expect(opened).toEqual([]);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /billing/status", expect.stringMatching(/^PATCH .*\/subscription$/)]);
  });

  it("@req ACCT-PLAN-07 Stancer, paid period running: a move down is booked for the next payment", async () => {
    setApiBaseUrl(BASE);
    const { calls } = fakeApi("stancer", [], { excessBytes: 0 });
    lastCalls = calls;
    const controller = createPlanChangeController({ api: boundApi, openUrl: () => undefined });
    const billing = await getBillingStatus(TOKEN);
    const result = await controller.run({ plan: "tier1", billingPeriod: "monthly", addonCount: 0, lang: "en" }, billing);
    expect(result).toEqual({ kind: "booked", effectiveAt: "2026-12-07T00:00:00.000Z" });
    expect(calls[1]!.body).toEqual({ plan: "tier1", billingPeriod: "monthly", addonCount: 0 });
  });
});
