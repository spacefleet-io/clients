/**
 * Choosing a plan (ACCT-PAY-01), the part every app that takes payment shares: the website and the
 * desktop apps (Badger, Parrot). No UI and no framework here; the desktop React hook lives in
 * `@space/desktop-shell/hooks` (`usePlanChange`); `planChangeMessage` says which message a result shows
 * and each app translates it with its own strings.
 *
 * What a plan choice does depends on the server's billing provider (`GET /billing/status`):
 * - `stancer` with no paid period running (`checkoutAllowed`): a paid plan is paid on Stancer's hosted page.
 *   The app opens that page (only an https page on stancer.com; the desktop apps in the system browser), then
 *   asks the API for the payment's result (`POST /billing/payments/{id}/complete`, safe to repeat) until it is
 *   settled: Stancer sends the browser back to the website with no payment details, so the app never waits on
 *   that return.
 * - otherwise (`standin`, `prelaunch`, a running Stancer period, or `free`): `PATCH /account/subscription` decides
 *   (ACCT-PLAN-06/07/08/11/12). It applies the plan, books a move down or a period switch for the next payment,
 *   drops a booking when the current plan is chosen again, refuses a plan the library does not fit
 *   (409 `library_too_large` with `excessBytes`), or answers 409 `checkout_required` for a move up, which is then
 *   paid prorated on the hosted page like a first payment.
 *
 * `prelaunch` (ACCT-PAY-07): payments are not open yet; any plan applies at once, nothing is charged, and the apps
 * say so (`paymentsNotOpen`).
 */
import type { GetBillingStatusResponse, UpdateSubscriptionResponse } from "@space/sdk";
import type { BillingPeriod } from "./accountAccess";

export type PlanId = "free" | "tier1" | "tier2" | "tier3";
export type PaidPlanId = Exclude<PlanId, "free">;

/** `GET /billing/status`: the billing provider, and with Stancer the account's subscription. */
export type BillingStatus = GetBillingStatusResponse;

/** Launch without payments (ACCT-PAY-07): the apps say a paid plan is free until payments open, then an email follows. */
export const paymentsNotOpen = (billing: Pick<BillingStatus, "provider"> | null | undefined): boolean => billing?.provider === "prelaunch";

export type PaymentOutcome = "paid" | "refused" | "canceled" | "pending";

/** What `PATCH /account/subscription` did with the choice. */
export type SubscriptionChangeOutcome = UpdateSubscriptionResponse["outcome"];

/** Why a plan cannot be chosen right now; the app greys the choice out and says why. */
export type PlanUnavailableReason =
  /** The billing status could not be read (old server, network), so nothing that may need payment is offered. */
  | "billing_unknown"
  /** The renewal of the paid period is being charged right now. */
  | "renewal_pending";

export type PlanAction =
  /** Stancer, no paid period running: the plan is paid on the hosted page (a first payment, or an unpaid account's renewal). */
  | { kind: "checkout" }
  /** `PATCH /account/subscription` decides: applies, books for the next payment, drops a booking, or asks for a checkout. */
  | { kind: "change" }
  | { kind: "unavailable"; reason: PlanUnavailableReason };

/**
 * What choosing `plan` does under `billing` (null = the status could not be read). Whether a first
 * payment is possible is the server's `checkoutAllowed`, computed by the rule the checkout itself
 * enforces, so the apps never open a payment the server would refuse.
 */
export const resolvePlanAction = (plan: string, billing: BillingStatus | null | undefined): PlanAction => {
  if (!billing) return { kind: "unavailable", reason: "billing_unknown" };
  if (billing.provider !== "stancer" || plan === "free") return { kind: "change" };
  if (billing.checkoutAllowed) return { kind: "checkout" };
  if (billing.checkoutBlockedReason === "renewal_pending") return { kind: "unavailable", reason: "renewal_pending" };
  // A running paid period: the server books a move down or a switch, and asks for a prorated checkout on a move up.
  if (billing.checkoutBlockedReason === "paid_period_running") return { kind: "change" };
  // A server without `checkoutAllowed` (older API): it cannot say, so nothing that needs payment is offered.
  return { kind: "unavailable", reason: "billing_unknown" };
};

/** Hosts of Stancer's hosted payment page; the apps open nothing else as a checkout. */
export const isStancerPaymentUrl = (url: string): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "" && (host === "stancer.com" || host.endsWith(".stancer.com"));
};

export type PlanChangeRequest = {
  plan: string;
  billingPeriod: BillingPeriod;
  /** Extra 500 GB blocks, Scale (`tier3`) only. */
  addonCount: number;
  /** `en` | `fr`: the hosted page's language. */
  lang: string;
};

/** What `PATCH /account/subscription` answers: what it did, and for a booking when it takes effect. */
export type SubscriptionChangeAnswer = { outcome: SubscriptionChangeOutcome; effectiveAt?: string | null };

/** The API calls a plan change needs, already bound to the signed-in account. */
export type PlanChangeApi = {
  updateSubscription: (plan: string, options: { billingPeriod: BillingPeriod; addonCount: number }) => Promise<SubscriptionChangeAnswer>;
  startCheckout: (input: {
    plan: PaidPlanId;
    billingPeriod: BillingPeriod;
    addonCount: number;
    lang: string;
  }) => Promise<{ url: string; paymentId: string; paid: boolean }>;
  completePayment: (paymentId: string) => Promise<{ outcome: PaymentOutcome }>;
};

/**
 * An API refusal that crossed a boundary as plain data (Parrot's IPC), shaped like the SDK's `ApiError`
 * (`message` = the error code, `payload.excessBytes` for `library_too_large`), so the plan change reads both alike.
 */
export class PlanChangeRefusal extends Error {
  readonly payload: { error: string; excessBytes?: number };
  constructor(code: string, excessBytes?: number) {
    super(code);
    this.payload = excessBytes === undefined ? { error: code } : { error: code, excessBytes };
  }
}

export type PlanChangeResult =
  /** The plan is applied now (stand-in, a move up there, or a move during the ACCT-PLAN-11 hold). */
  | { kind: "changed" }
  /** Stancer: paid, the plan is applied. */
  | { kind: "paid" }
  /** Stancer: the card was refused; nothing charged. */
  | { kind: "refused" }
  /** Stancer: the payment was cancelled on the hosted page; nothing charged. */
  | { kind: "canceled" }
  /** Back to free recorded; the paid plan runs until `effectiveAt` (null = at once). */
  | { kind: "endsAt"; effectiveAt: string | null }
  /** A move down or a period switch booked for the next payment, `effectiveAt` (ACCT-PLAN-07/12). */
  | { kind: "booked"; effectiveAt: string | null }
  /** The current plan was chosen again: the booked change is dropped. */
  | { kind: "bookingCancelled" }
  /** Nothing to change. */
  | { kind: "unchanged" }
  /** The library does not fit the plan: `excessBytes` must be removed first (ACCT-PLAN-08). */
  | { kind: "tooLarge"; excessBytes: number }
  /** The user stopped waiting. A payment made later is still applied by the server (webhook, website return). */
  | { kind: "stopped" }
  /** No result within the wait; the payment may still settle later. */
  | { kind: "timeout" }
  | { kind: "unavailable"; reason: PlanUnavailableReason }
  /** An API error code (`billing_unavailable`, `subscription_active`, ...) or `request_failed`. */
  | { kind: "error"; code: string };

/**
 * Which message a finished plan change shows; each app translates the id with its own strings. `endsAt` and
 * `booked` carry the date (null = unknown / at once) for the app to format in its language; `tooLarge` carries
 * the bytes to remove (`formatStorageBytes`); `unavailable` carries the reason a plan cannot be chosen.
 */
export type PlanChangeMessage =
  | { id: "changed" | "paid" | "refused" | "canceled" | "stopped" | "timeout" | "bookingCancelled" | "unchanged" }
  | { id: "endsAt" | "booked"; effectiveAt: string | null }
  | { id: "tooLarge"; excessBytes: number }
  | { id: "unavailable"; reason: PlanUnavailableReason }
  | { id: "paymentsUnavailable" | "checkoutInProgress" | "generic" };

export const planChangeMessage = (result: PlanChangeResult): PlanChangeMessage => {
  switch (result.kind) {
    case "endsAt":
    case "booked":
      return { id: result.kind, effectiveAt: result.effectiveAt };
    case "tooLarge":
      return { id: "tooLarge", excessBytes: result.excessBytes };
    case "unavailable":
      return { id: "unavailable", reason: result.reason };
    case "error":
      if (result.code === "billing_unavailable") return { id: "paymentsUnavailable" };
      if (result.code === "checkout_in_progress") return { id: "checkoutInProgress" };
      return { id: "generic" };
    default:
      return { id: result.kind };
  }
};

/** `fr` | `en`: the language Stancer's hosted payment page is shown in, from the app's language. */
export const paymentPageLang = (language: string | undefined): "fr" | "en" => (language?.toLowerCase().startsWith("fr") ? "fr" : "en");

export type PlanChangeState =
  | { phase: "idle" }
  | { phase: "working"; plan: string }
  /** The hosted page is open in the browser; the app checks the result every `intervalMs`. */
  | { phase: "waiting"; plan: string; paymentId: string; url: string; checks: number }
  | { phase: "done"; plan: string; result: PlanChangeResult };

type Logger = {
  info: (message: string, details?: Record<string, unknown>) => void;
  warn: (message: string, details?: Record<string, unknown>) => void;
};

export type PlanChangeControllerOptions = {
  api: PlanChangeApi;
  /** Opens the hosted payment page outside the app (desktop: the system browser). */
  openUrl: (url: string) => void;
  /** Time between two result checks while waiting. Each check makes the API ask Stancer once. */
  intervalMs?: number;
  /** Give up waiting after this long (the payment may still settle later). */
  timeoutMs?: number;
  now?: () => number;
  log?: Logger;
};

export const DEFAULT_PAYMENT_CHECK_INTERVAL_MS = 5_000;
export const DEFAULT_PAYMENT_WAIT_TIMEOUT_MS = 15 * 60_000;

/** API errors that settle a wait at once instead of being retried on the next check. */
const FINAL_COMPLETE_ERRORS: Record<string, true> = { payment_not_found: true, billing_provider_standin: true };

const errorCode = (error: unknown): string => {
  if (error instanceof Error && /^[a-z][a-z0-9_]*$/.test(error.message)) return error.message;
  return "request_failed";
};

/** `excessBytes` of a `library_too_large` refusal: the SDK's `ApiError` (and `PlanChangeRefusal`) carry it in `payload`. */
const excessBytesOf = (error: unknown): number => {
  if (error === null || typeof error !== "object" || !("payload" in error)) return 0;
  const { payload } = error;
  if (payload === null || typeof payload !== "object" || !("excessBytes" in payload)) return 0;
  const bytes = Number(payload.excessBytes);
  return Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
};

/** What `PATCH /account/subscription` answered, as a result. A booked move to Free is the paid period ending. */
const changeResult = (plan: string, res: SubscriptionChangeAnswer): PlanChangeResult => {
  switch (res.outcome) {
    case "booked":
      return plan === "free" ? { kind: "endsAt", effectiveAt: res.effectiveAt ?? null } : { kind: "booked", effectiveAt: res.effectiveAt ?? null };
    case "booking_cancelled":
      return { kind: "bookingCancelled" };
    case "unchanged":
      return { kind: "unchanged" };
    case "applied":
      return { kind: "changed" };
  }
};

const consoleLog: Logger = {
  info: (message, details) => console.info(`[plan-change] ${message}`, details ?? {}),
  warn: (message, details) => console.warn(`[plan-change] ${message}`, details ?? {}),
};

export type PlanChangeController = {
  getState: () => PlanChangeState;
  subscribe: (listener: (state: PlanChangeState) => void) => () => void;
  /** Resolves with the final result; a second run while one is going answers `plan_change_in_progress`. */
  run: (request: PlanChangeRequest, billing: BillingStatus | null | undefined) => Promise<PlanChangeResult>;
  /** Ask for the payment's result now (e.g. the app's window got the focus back). */
  checkNow: () => void;
  /**
   * The payment page came back to this app (ACCT-PAY-05: the app's own return link, `@space/shared/checkoutReturn`):
   * ask for that payment's result at once. A link for another payment than the one awaited is ignored.
   */
  paymentReturned: (paymentId: string) => void;
  /** Open the hosted payment page again (the user closed the browser tab). */
  reopen: () => void;
  /** Stop waiting for the hosted payment. */
  stop: () => void;
  /** Back to idle once the app has shown the result. */
  reset: () => void;
  /** Stops any timer (the screen went away). A pending `run` resolves as stopped. */
  dispose: () => void;
};

/**
 * Runs one plan change at a time and reports its state to subscribers. `run` resolves with the
 * final result; while a hosted payment is open, `checkNow` asks at once (call it when the app's
 * window comes back into focus), `reopen` opens the page again and `stop` ends the wait.
 */
export const createPlanChangeController = (options: PlanChangeControllerOptions): PlanChangeController => {
  const intervalMs = options.intervalMs ?? DEFAULT_PAYMENT_CHECK_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PAYMENT_WAIT_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const log = options.log ?? consoleLog;
  const listeners = new Set<(state: PlanChangeState) => void>();
  let state: PlanChangeState = { phase: "idle" };
  let wait: {
    paymentId: string;
    deadline: number;
    timer: ReturnType<typeof setTimeout> | null;
    inFlight: boolean;
    finish: (result: PlanChangeResult) => void;
  } | null = null;

  const setState = (next: PlanChangeState) => {
    state = next;
    for (const listener of listeners) listener(state);
  };

  const finish = (plan: string, result: PlanChangeResult): PlanChangeResult => {
    log.info("finished", { plan, result });
    setState({ phase: "done", plan, result });
    return result;
  };

  const clearWait = () => {
    clearTimeout(wait?.timer ?? undefined);
    wait = null;
  };

  const check = async () => {
    const current = wait;
    if (!current || current.inFlight) return;
    clearTimeout(current.timer ?? undefined);
    current.timer = null;
    if (now() >= current.deadline) {
      log.warn("payment wait timed out", { paymentId: current.paymentId });
      current.finish({ kind: "timeout" });
      return;
    }
    current.inFlight = true;
    let settled: PlanChangeResult | null = null;
    try {
      const { outcome } = await options.api.completePayment(current.paymentId);
      log.info("payment check", { paymentId: current.paymentId, outcome });
      if (outcome !== "pending") settled = { kind: outcome };
    } catch (error) {
      const code = errorCode(error);
      log.warn("payment check failed", { paymentId: current.paymentId, code });
      if (FINAL_COMPLETE_ERRORS[code]) settled = { kind: "error", code };
    } finally {
      current.inFlight = false;
    }
    if (wait !== current) return; // stopped while the check was running
    if (settled) {
      current.finish(settled);
      return;
    }
    if (state.phase === "waiting") setState({ ...state, checks: state.checks + 1 });
    current.timer = setTimeout(() => void check(), intervalMs);
  };

  const waitForPayment = (plan: string, paymentId: string, url: string): Promise<PlanChangeResult> => {
    const { promise, resolve } = Promise.withResolvers<PlanChangeResult>();
    setState({ phase: "waiting", plan, paymentId, url, checks: 0 });
    wait = {
      paymentId,
      deadline: now() + timeoutMs,
      timer: null,
      inFlight: false,
      finish: (result) => {
        clearWait();
        resolve(finish(plan, result));
      },
    };
    wait.timer = setTimeout(() => void check(), intervalMs);
    return promise;
  };

  return {
    getState: () => state,
    subscribe: (listener: (state: PlanChangeState) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    run: async (request, billing) => {
      if (state.phase === "working" || state.phase === "waiting") {
        return { kind: "error", code: "plan_change_in_progress" };
      }
      const { plan } = request;
      const action = resolvePlanAction(plan, billing);
      log.info("start", { plan, billingPeriod: request.billingPeriod, addonCount: request.addonCount, action: action.kind });
      if (action.kind === "unavailable") return finish(plan, { kind: "unavailable", reason: action.reason });
      setState({ phase: "working", plan });
      const addonCount = plan === "tier3" ? request.addonCount : 0;
      const payOnHostedPage = async (): Promise<PlanChangeResult> => {
        const { url, paymentId, paid } = await options.api.startCheckout({
          plan: plan as PaidPlanId,
          billingPeriod: request.billingPeriod,
          addonCount,
          lang: request.lang,
        });
        if (paid) {
          // The account's grants cover the whole charge (ACCT-GRANT-01): the server already gave the plan.
          log.info("checkout paid by grants, no hosted page", { plan, paymentId });
          return finish(plan, { kind: "paid" });
        }
        if (!isStancerPaymentUrl(url)) {
          // Only Stancer's own https page is ever opened; anything else (a compromised or misconfigured API) is not.
          log.warn("checkout url refused", { plan, paymentId, url });
          return finish(plan, { kind: "error", code: "invalid_checkout_url" });
        }
        log.info("hosted payment opened", { plan, paymentId });
        options.openUrl(url);
        return await waitForPayment(plan, paymentId, url);
      };
      try {
        if (action.kind === "checkout") return await payOnHostedPage();
        let res: SubscriptionChangeAnswer;
        try {
          res = await options.api.updateSubscription(plan, { billingPeriod: request.billingPeriod, addonCount });
        } catch (error) {
          // A move up (or a first payment the status did not foresee) is paid on the hosted page (ACCT-PLAN-07).
          if (plan === "free" || errorCode(error) !== "checkout_required") throw error;
          log.info("checkout required", { plan });
          return await payOnHostedPage();
        }
        log.info("change answered", { plan, outcome: res.outcome, effectiveAt: res.effectiveAt ?? null });
        return finish(plan, changeResult(plan, res));
      } catch (error) {
        const code = errorCode(error);
        if (code === "library_too_large") {
          const excessBytes = excessBytesOf(error);
          log.warn("library too large for the plan", { plan, excessBytes });
          return finish(plan, { kind: "tooLarge", excessBytes });
        }
        log.warn("failed", { plan, code });
        return finish(plan, { kind: "error", code });
      }
    },

    checkNow: () => {
      if (wait) void check();
    },

    paymentReturned: (paymentId) => {
      if (!wait || wait.paymentId !== paymentId) {
        log.warn("payment return ignored: not the payment being awaited", { paymentId, awaited: wait?.paymentId ?? null });
        return;
      }
      log.info("payment page returned to the app", { paymentId });
      void check();
    },

    reopen: () => {
      if (state.phase !== "waiting") return;
      if (!isStancerPaymentUrl(state.url)) {
        log.warn("checkout url refused on reopen", { paymentId: state.paymentId, url: state.url });
        wait?.finish({ kind: "error", code: "invalid_checkout_url" });
        return;
      }
      options.openUrl(state.url);
    },

    stop: () => {
      if (wait) {
        log.info("payment wait stopped by the user", { paymentId: wait.paymentId });
        wait.finish({ kind: "stopped" });
      }
    },

    reset: () => {
      if (state.phase === "done") setState({ phase: "idle" });
    },

    dispose: () => {
      wait?.finish({ kind: "stopped" });
    },
  };
};
