import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Spinner } from "@space/ui";
import { usePlanChange } from "@space/desktop-shell/hooks";
import {
  PlanChangeRefusal,
  isStancerPaymentUrl,
  paymentPageLang,
  paymentsNotOpen,
  planChangeMessage,
  resolvePlanAction,
  type BillingStatus,
  type PlanChangeApi,
  type PlanChangeResult,
  type PlanUnavailableReason,
} from "@space/shared/billingCheckout";
import { formatAccessDate } from "@space/shared/effectiveAccess";
import { formatLocalizedStorage, formatLocalizedStorageUsage, planGbToBytes, storageUnitName } from "@space/shared/format";
import {
  FOUNDER_DISCOUNT_PERCENT,
  PLAN_CONFIG,
  PLAN_ORDER,
  loadBillingPeriod,
  persistBillingPeriod,
  planMonthlyPrice,
  planStorageGb,
  planYearlyPrice,
  type BillingPeriod,
  type PlanChoice,
  type PlanId,
} from "@space/shared/storagePlans";
import type { ParrotBillingResult, ParrotLanguage, ParrotSubscription } from "../../shared/ipc";
import type { ParrotStringKey, Translate } from "./i18n";

/**
 * Parrot's plan screen (ACCT-PAY-01, ACCT-PLAN-01..04, 07/08/11/12): the same four plans at the same prices as
 * Badger (`@space/shared/storagePlans`, checked against the API's catalog), chosen through the shared plan
 * change (`usePlanChange`). Under Stancer a paid plan (a first payment, or a move up paid prorated) opens
 * Stancer's hosted payment page in the system browser and the screen waits for the payment's result; a move
 * down or a period switch is booked for the next payment and shown with its date, choosing the current plan
 * again drops the booking, and a plan the library does not fit is refused with the amount to remove. The
 * session token stays in main: every call goes through `window.parrot`.
 */
type Props = { t: Translate; language: ParrotLanguage; onClose: () => void };

const log = {
  info: (message: string, details?: Record<string, unknown>) => console.info(`[plan-change] ${message}`, details ?? {}),
  warn: (message: string, details?: Record<string, unknown>) => console.warn(`[plan-change] ${message}`, details ?? {}),
};

/** A main-process billing result as the shared plan change expects it: the value, or a refusal carrying the API code. */
const unwrap = async <T,>(call: Promise<ParrotBillingResult<T>>): Promise<T> => {
  const result = await call;
  if (!result.ok) throw new PlanChangeRefusal(result.code, result.excessBytes);
  return result.value;
};

const api: PlanChangeApi = {
  updateSubscription: (plan, options) => unwrap(window.parrot.updateSubscription(plan, options)),
  startCheckout: (input) => unwrap(window.parrot.startCheckout(input)),
  completePayment: (paymentId) => unwrap(window.parrot.completePayment(paymentId)),
};

/** `window.open` goes to the system browser (main's window-open handler); only Stancer's page is opened as a checkout. */
const openPaymentPage = (url: string) => {
  if (!isStancerPaymentUrl(url)) {
    log.warn("open-hosted-page-refused", { host: URL.canParse(url) ? new URL(url).host : null });
    return;
  }
  log.info("open-hosted-page", { host: new URL(url).host });
  window.open(url, "_blank", "noopener,noreferrer");
};

/** ACCT-PAY-05: main hands over `parrot://billing/return` links; the plan change then checks that payment at once. */
const subscribePaymentReturn = (listener: (paymentId: string) => void) => window.parrot.onPaymentReturn(listener);

const UNAVAILABLE_KEYS: Record<PlanUnavailableReason, ParrotStringKey> = {
  billing_unknown: "plan.unavailable.billingUnknown",
  renewal_pending: "plan.unavailable.renewalPending",
};

/** What happened, in words, for a finished plan change (which message: the shared `planChangeMessage`). */
export const planResultText = (t: Translate, result: PlanChangeResult, language: ParrotLanguage): string => {
  const message = planChangeMessage(result);
  switch (message.id) {
    case "changed":
      return t("plan.result.changed");
    case "paid":
      return t("plan.result.paid");
    case "refused":
      return t("plan.result.refused");
    case "canceled":
      return t("plan.result.canceled");
    case "endsAt": {
      const date = formatAccessDate(message.effectiveAt, language);
      return date ? t("plan.endsOn", { date }) : t("plan.result.changed");
    }
    case "booked": {
      const date = formatAccessDate(message.effectiveAt, language);
      return date ? t("plan.booked", { date }) : t("plan.result.changed");
    }
    case "bookingCancelled":
      return t("plan.bookingCancelled");
    case "unchanged":
      return t("plan.unchanged");
    case "tooLarge":
      return t("plan.tooLarge", { excess: formatLocalizedStorage(message.excessBytes, language) });
    case "stopped":
      return t("plan.result.stopped");
    case "timeout":
      return t("plan.result.timeout");
    case "unavailable":
      return t(UNAVAILABLE_KEYS[message.reason]);
    case "paymentsUnavailable":
      return t("plan.error.paymentsUnavailable");
    case "checkoutInProgress":
      return t("plan.error.checkoutInProgress");
    case "generic":
      return t("plan.error.generic");
  }
};

/**
 * A plan catalogue size ("100 GB" in a plan name), not a measured figure (STOR-UNIT-01 leaves the number alone),
 * written with the interface language's separator and unit name ("100 Go", "1,5 To" in French, STOR-UNIT-02).
 */
const formatStorage = (gb: number, language: ParrotLanguage) => {
  const [value, unit] = gb >= 1000 ? [gb / 1000, "TB" as const] : [gb, "GB" as const];
  return `${value.toLocaleString(language, { useGrouping: false })} ${storageUnitName(unit, language)}`;
};

export default function Plans({ t, language, onClose }: Props) {
  const [subscription, setSubscription] = useState<ParrotSubscription | null>(null);
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [period, setPeriod] = useState<BillingPeriod>(loadBillingPeriod);
  const [scaleBlocks, setScaleBlocks] = useState(0);
  const [pending, setPending] = useState<PlanChoice | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  /** Launch without payments (ACCT-PAY-07): the "free until payments open" confirmation is showing for `pending`. */
  const [prelaunchAsk, setPrelaunchAsk] = useState(false);
  const planChange = usePlanChange({ api, openUrl: openPaymentPage, onPaymentReturn: subscribePaymentReturn, log });

  const refresh = useCallback(async () => {
    const [sub, status] = await Promise.all([window.parrot.getSubscription(), window.parrot.getBillingStatus()]);
    // A billing status that cannot be read offers nothing that may need payment (`billing_unknown`).
    setBilling(status.ok ? status.value : null);
    if (sub.ok) {
      setSubscription(sub.value);
      setScaleBlocks(sub.value.plan === "tier3" ? sub.value.storageAddonCount : 0);
    }
    setLoadFailed(!sub.ok);
    setLoaded(true);
    log.info("billing-status", {
      provider: status.ok ? status.value.provider : null,
      checkoutAllowed: status.ok ? status.value.checkoutAllowed : null,
      checkoutBlockedReason: status.ok ? status.value.checkoutBlockedReason : null,
    });
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const money = useMemo(() => new Intl.NumberFormat(language, { style: "currency", currency: "EUR" }), [language]);
  const busy = planChange.state.phase === "working" || planChange.state.phase === "waiting";
  /** Why paid plans are greyed, once above them (the server's `checkoutAllowed` / `checkoutBlockedReason`). */
  const paidUnavailable = useMemo((): PlanUnavailableReason | null => {
    if (!loaded) return null;
    const action = resolvePlanAction("tier1", billing);
    return action.kind === "unavailable" ? action.reason : null;
  }, [billing, loaded]);
  const freeUnavailable = loaded ? resolvePlanAction("free", billing).kind === "unavailable" : true;

  const choosePeriod = (next: BillingPeriod) => {
    setPeriod(next);
    persistBillingPeriod(next);
  };

  const runChange = async (request: { plan: PlanId; billingPeriod: BillingPeriod; addonCount: number }, reason: string) => {
    setMessage(null);
    log.info("requested", { ...request, reason, provider: billing?.provider ?? null });
    const result = await planChange.run({ ...request, lang: paymentPageLang(language) }, billing);
    log.info("result", { plan: request.plan, result });
    // Applied, booked, or a booking dropped: reload the plan and the booked change.
    if (
      result.kind === "changed" ||
      result.kind === "paid" ||
      result.kind === "endsAt" ||
      result.kind === "booked" ||
      result.kind === "bookingCancelled"
    ) {
      setPending(null);
      await refresh();
    }
    setMessage(planResultText(t, result, language));
  };

  const confirm = async () => {
    if (!pending) return;
    await runChange({ plan: pending.plan, billingPeriod: period, addonCount: pending.addonCount }, "select");
  };

  /** Drops the booked change: the current plan chosen again (the server answers `booking_cancelled`). */
  const keepCurrent = async () => {
    if (!subscription) return;
    const plan = subscription.plan as PlanId;
    await runChange(
      { plan, billingPeriod: subscription.billingPeriod ?? period, addonCount: plan === "tier3" ? subscription.storageAddonCount : 0 },
      "keep-current",
    );
  };

  /**
   * Payments just opened (ACCT-PAY-07): pays the current plan on its own period. No paid period runs yet,
   * so the API takes a plain checkout of it and the first paid period starts the day of the payment.
   */
  const payNow = async () => {
    if (!subscription || subscription.plan === "free") return;
    const plan = subscription.plan as PlanId;
    await runChange(
      { plan, billingPeriod: subscription.billingPeriod ?? period, addonCount: plan === "tier3" ? subscription.storageAddonCount : 0 },
      "pay-now",
    );
  };

  const paidUntil = subscription && subscription.plan !== "free" ? formatAccessDate(subscription.paidUntil, language) : null;
  // Payments just opened (ACCT-PAY-07): the plan is free until the deadline, never "paid until".
  const deadline = formatAccessDate(billing?.paymentDeadline ?? null, language);
  const currentTitle = subscription ? (PLAN_CONFIG[subscription.plan as PlanId]?.title ?? subscription.plan) : "";
  const currentYearly = (subscription?.billingPeriod ?? period) === "annual";
  const waiting = planChange.state.phase === "waiting";
  const scheduled = subscription?.scheduledChange ?? null;
  const scheduledDate = scheduled ? formatAccessDate(scheduled.effectiveAt, language) : null;
  const holdDate = subscription?.renewalHold ? formatAccessDate(subscription.renewalHold.chargeAt, language) : null;

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/60" data-testid="plan-screen">
      <div className="max-h-[90vh] w-full max-w-4xl space-y-4 overflow-y-auto rounded-xl bg-card p-6">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold">{t("plan.title")}</h2>
          <Button className="ml-auto" variant="ghost" size="sm" onClick={onClose} data-testid="plan-close">
            {t("plan.close")}
          </Button>
        </div>

        {!loaded && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner size="sm" /> {t("plan.loading")}
          </p>
        )}
        {loaded && loadFailed && <p className="text-sm text-destructive">{t("plan.loadError")}</p>}

        {/* ACCT-PLAN-14: an admin account has no plan and unlimited storage: no plans, prices or checkout. */}
        {subscription && subscription.storageLimitGb === null && (
          <div className="space-y-1 text-sm" data-testid="plan-current">
            <p data-testid="plan-unlimited">
              {t("plan.currentUnlimited", { used: formatLocalizedStorage(planGbToBytes(subscription.storageUsedGb), language) })}
            </p>
          </div>
        )}

        {subscription && subscription.storageLimitGb !== null && (
          <div className="space-y-1 text-sm" data-testid="plan-current">
            <p>
              {t("plan.current", {
                plan: PLAN_CONFIG[subscription.plan as PlanId]?.title ?? subscription.plan,
                ...formatLocalizedStorageUsage(planGbToBytes(subscription.storageUsedGb), planGbToBytes(subscription.storageLimitGb), language),
              })}
            </p>
            {deadline ? (
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-muted-foreground" data-testid="plan-payment-deadline">
                  {t(currentYearly ? "plan.freeUntilYear" : "plan.freeUntilMonth", { date: deadline, plan: currentTitle })}
                </p>
                {subscription.plan !== "free" && (
                  <Button size="sm" disabled={busy} onClick={() => void payNow()} data-testid="plan-pay-now">
                    {t("plan.payNow")}
                  </Button>
                )}
              </div>
            ) : (
              paidUntil && (
                <p className="text-muted-foreground" data-testid="plan-paid-until">
                  {billing?.subscription?.cancelAtPeriodEnd ? t("plan.endsOn", { date: paidUntil }) : t("plan.paidUntil", { date: paidUntil })}
                </p>
              )
            )}
            {scheduled && scheduledDate && (
              <div className="space-y-2 rounded-md bg-secondary p-3" data-testid="plan-scheduled-change" data-fits={scheduled.fits ? "true" : "false"}>
                <p>{t("plan.scheduledChange", { plan: PLAN_CONFIG[scheduled.plan as PlanId]?.title ?? scheduled.plan, date: scheduledDate })}</p>
                {!scheduled.fits && (
                  <p className="text-destructive" data-testid="plan-scheduled-too-large">
                    {t("plan.scheduledTooLarge", { excess: formatLocalizedStorage(scheduled.excessBytes, language), date: scheduledDate })}
                  </p>
                )}
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => void keepCurrent()} data-testid="plan-cancel-booking">
                  {t("plan.keepCurrent")}
                </Button>
              </div>
            )}
            {holdDate && (
              <p className="rounded-md bg-secondary p-3 text-destructive" data-testid="plan-renewal-hold">
                {t("plan.renewalHold", { date: holdDate })}
              </p>
            )}
          </div>
        )}

        {subscription && subscription.storageLimitGb !== null && (
          <>
            <div className="flex gap-2" role="radiogroup" aria-label={t("plan.period")}>
              {(["annual", "monthly"] as const).map((value) => (
                <Button
                  key={value}
                  size="sm"
                  variant={period === value ? "default" : "secondary"}
                  role="radio"
                  aria-checked={period === value}
                  onClick={() => choosePeriod(value)}
                  data-testid={`plan-period-${value}`}
                >
                  {t(value === "annual" ? "plan.annual" : "plan.monthly")}
                </Button>
              ))}
            </div>

            {billing?.provider === "standin" && (
              <p className="text-sm text-muted-foreground" data-testid="plan-standin">
                {t("plan.standin")}
              </p>
            )}
            {/* Launch without payments (ACCT-PAY-07): any plan is active at once and free until payments open. */}
            {billing?.provider === "prelaunch" &&
              (subscription.plan !== "free" ? (
                <div className="space-y-1 text-sm text-muted-foreground" data-testid="plan-prelaunch">
                  <p>{t("plan.prelaunchNote.free", { plan: currentTitle })}</p>
                  <p>{t(currentYearly ? "plan.prelaunchNote.emailYear" : "plan.prelaunchNote.emailMonth")}</p>
                  <p>{t("plan.prelaunchNote.unpaid")}</p>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground" data-testid="plan-prelaunch">
                  {t("plan.prelaunch")}
                </p>
              ))}
            {paidUnavailable && (
              <p className="rounded-md bg-secondary p-3 text-sm" data-testid="plan-unavailable" data-reason={paidUnavailable}>
                {t(UNAVAILABLE_KEYS[paidUnavailable])}
              </p>
            )}

            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {PLAN_ORDER.map((plan) => {
                const choice: PlanChoice = { plan, addonCount: plan === "tier3" ? scaleBlocks : 0 };
                // The current paid plan on the other period is a switch (ACCT-PLAN-12), booked for the next payment.
                const samePeriod = plan === "free" || subscription.billingPeriod === null || subscription.billingPeriod === period;
                const current =
                  plan === subscription.plan && samePeriod && (plan !== "tier3" || scaleBlocks === subscription.storageAddonCount);
                const greyed = plan === "free" ? freeUnavailable : paidUnavailable !== null;
                const selected = pending?.plan === plan;
                // A founder (WAIT-FOUND-01): the plan price −30% for life, extra blocks at full price.
                const asFounder = billing?.founder === true && plan !== "free";
                return (
                  <div
                    key={plan}
                    className={`space-y-2 rounded-lg border p-4 ${selected ? "border-primary" : "border-border"} ${greyed ? "opacity-50" : ""}`}
                    data-testid={`plan-card-${plan}`}
                    data-greyed={greyed ? "true" : "false"}
                  >
                    <div className="font-semibold">{PLAN_CONFIG[plan].title}</div>
                    <div className="text-sm text-muted-foreground" data-testid={`plan-storage-${plan}`}>
                      {formatStorage(planStorageGb(choice), language)}
                    </div>
                    <div className="text-lg" data-testid={`plan-price-${plan}`}>
                      {asFounder && (
                        <span className="mr-1 text-sm text-muted-foreground line-through" data-testid={`plan-list-price-${plan}`}>
                          {money.format(planMonthlyPrice(choice, period))}
                        </span>
                      )}
                      {t("plan.perMonth", { price: money.format(planMonthlyPrice(choice, period, asFounder)) })}
                    </div>
                    {asFounder && (
                      <div className="text-xs font-semibold text-primary" data-testid={`plan-founder-${plan}`}>
                        {t("plan.founderPrice", { percent: FOUNDER_DISCOUNT_PERCENT })}
                      </div>
                    )}
                    {plan !== "free" && (
                      <div className="text-xs text-muted-foreground" data-testid={`plan-billed-${plan}`}>
                        {period === "annual"
                          ? t("plan.billedYearly", { amount: money.format(planYearlyPrice(choice, asFounder)) })
                          : t("plan.billedMonthly")}
                      </div>
                    )}
                    {plan === "tier3" && (
                      <label className="block text-xs">
                        {t("plan.extraBlocks")}
                        <input
                          type="number"
                          min={0}
                          step={1}
                          className="ml-2 w-20 rounded bg-secondary px-1"
                          value={scaleBlocks}
                          disabled={busy || greyed}
                          onChange={(event) => {
                            const blocks = Math.max(0, Math.trunc(Number(event.target.value) || 0));
                            setScaleBlocks(blocks);
                            if (pending?.plan === "tier3") setPending({ plan: "tier3", addonCount: blocks });
                          }}
                          data-testid="plan-scale-blocks"
                        />
                        <span className="ml-1">+{scaleBlocks * PLAN_CONFIG.tier3.addon.stepGb} GB</span>
                      </label>
                    )}
                    {current ? (
                      <div className="text-sm font-medium text-primary">{t("plan.currentBadge")}</div>
                    ) : (
                      <Button
                        size="sm"
                        variant={selected ? "default" : "secondary"}
                        disabled={busy || greyed}
                        onClick={() => {
                          setMessage(null);
                          setPrelaunchAsk(false);
                          setPending(choice);
                        }}
                        data-testid={`plan-choose-${plan}`}
                      >
                        {t("plan.choose")}
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>

            {pending && !waiting && !prelaunchAsk && (
              <Button
                disabled={busy}
                onClick={() => {
                  // Before payments open a paid plan asks first; Free applies at once (ACCT-PAY-07).
                  if (pending.plan !== "free" && paymentsNotOpen(billing)) {
                    log.info("prelaunch-confirm.open", { plan: pending.plan, period });
                    setPrelaunchAsk(true);
                    return;
                  }
                  void confirm();
                }}
                data-testid="plan-confirm"
              >
                {busy ? t("plan.working") : t("plan.confirm", { plan: PLAN_CONFIG[pending.plan].title })}
              </Button>
            )}

            {pending && prelaunchAsk && (
              <div role="dialog" aria-modal="true" aria-labelledby="plan-prelaunch-confirm-title" className="space-y-3 rounded-md border border-primary/40 bg-secondary p-4 text-sm" data-testid="plan-prelaunch-confirm">
                <h3 id="plan-prelaunch-confirm-title" className="font-semibold">
                  {t("plan.prelaunchConfirm.title")}
                </h3>
                <p data-testid="plan-prelaunch-confirm-free">{t("plan.prelaunchConfirm.free", { plan: PLAN_CONFIG[pending.plan].title })}</p>
                <p data-testid="plan-prelaunch-confirm-email">
                  {t(period === "annual" ? "plan.prelaunchConfirm.emailYear" : "plan.prelaunchConfirm.emailMonth")}
                  {billing?.founder === true ? ` ${t("plan.prelaunchConfirm.founder")}` : null}
                </p>
                <p data-testid="plan-prelaunch-confirm-unpaid">{t("plan.prelaunchConfirm.unpaid")}</p>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      log.info("prelaunch-confirm.cancel", { plan: pending.plan });
                      setPrelaunchAsk(false);
                      setPending(null);
                    }}
                    data-testid="plan-prelaunch-confirm-cancel"
                  >
                    {t("plan.prelaunchConfirm.cancel")}
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      log.info("prelaunch-confirm.start", { plan: pending.plan, period });
                      setPrelaunchAsk(false);
                      void confirm();
                    }}
                    data-testid="plan-prelaunch-confirm-start"
                  >
                    {t("plan.prelaunchConfirm.confirm", { plan: PLAN_CONFIG[pending.plan].title })}
                  </Button>
                </div>
              </div>
            )}

            {waiting && (
              <div className="space-y-2 rounded-md bg-secondary p-3 text-sm" data-testid="plan-waiting">
                <p>{t("plan.waiting")}</p>
                <div className="flex gap-2">
                  <Button size="sm" variant="secondary" onClick={planChange.reopen} data-testid="plan-reopen">
                    {t("plan.reopen")}
                  </Button>
                  <Button size="sm" variant="secondary" onClick={planChange.checkNow} data-testid="plan-check-now">
                    {t("plan.checkNow")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={planChange.stop} data-testid="plan-stop">
                    {t("plan.stop")}
                  </Button>
                </div>
              </div>
            )}

            {message && (
              <p className="text-sm" data-testid="plan-message">
                {message}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
