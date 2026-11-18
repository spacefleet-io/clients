import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Sponsorship,
  getAccountStorage,
  getMe,
  getSettings,
  getSponsorships,
  getSubscription,
  updateSettings,
} from "@/api";
import type { AccountStorageSummary, SubscriptionSummary } from "@space/shared/api";
import { formatAccessDate, resolveEffectiveAccess } from "@space/shared/effectiveAccess";
import { paymentPageLang, paymentsNotOpen, resolvePlanAction, type PlanUnavailableReason } from "@space/shared/billingCheckout";
import { bucketRelativeTime, formatLocalizedStorage, formatLocalizedStorageUsage, planGbToBytes } from "@space/shared/format";
import { planSizeLabel } from "@/lib/sizeLabel";
import { useAuth } from "@/auth";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Switch,
} from "@space/ui";
import { AccountStorageCard } from "@space/desktop-shell/components";
import { newsOptInText } from "@space/legal";
import SettingListDialog from "../SettingListDialog";
import { SettingHint, SettingPanel, SettingRow } from "../kit";
import { FounderSettingsBadge } from "@/components/FounderNotice";
import { rendererLogger } from "@/logger";
import { getDesktopArtworkHealer } from "@/lib/artworkHeal";
import {
  FOUNDER_DISCOUNT_PERCENT,
  PLAN_CONFIG,
  loadBillingPeriod,
  persistBillingPeriod,
  planMonthlyPrice,
  planYearlyPrice,
  type BillingPeriod,
} from "@space/shared/storagePlans";
import {
  planChangeResultMessage,
  planUnavailableMessage,
  useAccountPlanChange,
  useBillingStatus,
} from "@/lib/planChange";

/** The plan, its storage and period, a booked change and a held renewal (ACCT-PLAN-07/08/11). */
type SubscriptionState = SubscriptionSummary;

export default function AccountSection() {
  const { t, i18n } = useTranslation();
  const locale = i18n?.language || "en";
  const { token, user, setUser } = useAuth();

  const [billingPeriod, setBillingPeriod] = useState<BillingPeriod>(() => loadBillingPeriod());
  // ACCT-NEWS-01: the News switch shows the account's saved opt-in; a save in flight blocks a second one.
  const [newsSaving, setNewsSaving] = useState(false);
  const newsText = newsOptInText(i18n?.language);
  const saveNews = (newsOptIn: boolean) => {
    if (!token || newsSaving) return;
    setNewsSaving(true);
    updateSettings(token, { newsOptIn })
      .then((result) => {
        setUser(result.user);
        rendererLogger.info({ newsOptIn }, "[account] news opt-in saved");
      })
      .catch((error: unknown) => rendererLogger.warn({ error: String(error) }, "[account] news opt-in save failed"))
      .finally(() => setNewsSaving(false));
  };
  const [subscription, setSubscription] = useState<SubscriptionState | null>(null);
  const [accountStorage, setAccountStorage] = useState<AccountStorageSummary | null>(null);
  const [sponsorCode, setSponsorCode] = useState<string | null>(null);
  const [sponsorships, setSponsorships] = useState<Sponsorship[]>([]);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);

  const [pendingPlan, setPendingPlan] = useState<string | null>(null);
  const [pendingAddonCount, setPendingAddonCount] = useState<number>(0);
  const [planMessage, setPlanMessage] = useState<string | null>(null);
  /** Launch without payments (ACCT-PAY-07): the paid plan waiting for the "free until payments open" confirmation. */
  const [prelaunchPlan, setPrelaunchPlan] = useState<string | null>(null);
  const { billing, loaded: billingLoaded, refresh: refreshBilling } = useBillingStatus();
  const planChange = useAccountPlanChange();
  const planBusy = planChange.state.phase === "working" || planChange.state.phase === "waiting";
  const waitingPayment = planChange.state.phase === "waiting" ? planChange.state : null;
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const [sponsorshipsOpen, setSponsorshipsOpen] = useState(false);

  useEffect(() => {
    if (!token) return;
    let mounted = true;
    setLoading(true);
    setPageError(null);
    Promise.all([getSubscription(token), getSponsorships(token), getSettings(token), getAccountStorage(token)])
      .then(([sub, sponsor, settings, storage]) => {
        if (!mounted) return;
        setSubscription(sub);
        setAccountStorage(storage);
        setPendingAddonCount(sub.storageAddonCount ?? 0);
        setSponsorCode(sponsor.sponsorCode);
        setSponsorships(sponsor.sponsorships);
        if (settings.preferences?.billingPeriod === "annual" || settings.preferences?.billingPeriod === "monthly") {
          setBillingPeriod(settings.preferences.billingPeriod);
          persistBillingPeriod(settings.preferences.billingPeriod);
        }
      })
      .catch(() => {
        if (mounted) setPageError(t("account.loadError"));
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [t, token]);

  useEffect(() => {
    persistBillingPeriod(billingPeriod);
  }, [billingPeriod]);

  /** ACCT-PLAN-14: an admin account has no plan and unlimited storage: no plans, prices, billing or upgrade. */
  const unlimited = subscription?.storageLimitGb === null || accountStorage?.limitBytes === null;

  const planLabel = useMemo(() => {
    if (!subscription) return "";
    if (subscription.storageLimitGb === null) return t("account.subscription.adminUnlimited");
    const details = PLAN_CONFIG[subscription.plan as keyof typeof PLAN_CONFIG];
    return details
      ? `${t(`account.plans.${subscription.plan}.title`)} (${planSizeLabel(subscription.storageLimitGb, locale)})`
      : subscription.plan;
  }, [locale, subscription, t]);

  // Paid-until / unpaid state (#145). Evaluated at render, never polled.
  const effectiveAccess = resolveEffectiveAccess(subscription?.access ?? user?.access);
  const accessNotice = useMemo(() => {
    if (!effectiveAccess) return null;
    const lang = i18n?.language;
    if (effectiveAccess.state === "unpaid") {
      const date = formatAccessDate(effectiveAccess.wipeAt, lang);
      return date ? t("account.subscription.unpaidNotice", { date }) : t("account.subscription.unpaidNoticeNoDate");
    }
    // Payments just opened (ACCT-PAY-07): the plan is free until the deadline, never "paid until".
    const deadline = formatAccessDate(billing?.paymentDeadline ?? null, lang);
    if (deadline && subscription) {
      const year = (subscription.billingPeriod ?? effectiveAccess.billingPeriod) === "annual";
      return t(year ? "account.subscription.freeUntilYear" : "account.subscription.freeUntilMonth", {
        date: deadline,
        plan: t(`account.plans.${subscription.plan}.title`),
      });
    }
    const paidUntil = formatAccessDate(effectiveAccess.paidUntil, lang);
    if (effectiveAccess.state !== "paid" || !paidUntil) return null;
    // Back to free recorded under Stancer: the paid plan runs to the end of the period, then stops.
    return billing?.subscription?.cancelAtPeriodEnd
      ? t("account.subscription.endsOn", { date: paidUntil })
      : t("account.subscription.paidUntil", { date: paidUntil });
  }, [billing?.paymentDeadline, billing?.subscription?.cancelAtPeriodEnd, effectiveAccess, i18n?.language, subscription, t]);

  /** Why choosing a plan is not offered right now, if it is not (shown once, above the plans). */
  const plansUnavailableReason = useMemo((): PlanUnavailableReason | null => {
    if (!billingLoaded) return null;
    const action = resolvePlanAction("tier1", billing);
    return action.kind === "unavailable" ? action.reason : null;
  }, [billing, billingLoaded]);

  const currencyFormatter = useMemo(
    () => new Intl.NumberFormat(locale, { style: "currency", currency: "EUR" }),
    [locale]
  );
  const formatEuro = (value: number) => currencyFormatter.format(value);
  const isAnnual = billingPeriod === "annual";
  // A founder (WAIT-FOUND-01) sees the founder price on every paid plan: the plan price −30% for life, blocks at full price.
  const founder = billing?.founder === true;
  const addonMonthlyPrice = PLAN_CONFIG.tier3.addon.monthly;
  const addonAnnualPricePerStep = PLAN_CONFIG.tier3.addon.annualPerStep;
  const savingsPerYear = useMemo(() => {
    if (!subscription) return 0;
    const active = PLAN_CONFIG[subscription.plan as keyof typeof PLAN_CONFIG];
    if (!active) return 0;
    const monthlyReference =
      active.monthly + (subscription.plan === "tier3" ? subscription.storageAddonCount * addonMonthlyPrice : 0);
    const annualReference =
      active.annualPerMonth +
      (subscription.plan === "tier3" ? subscription.storageAddonCount * (addonAnnualPricePerStep / 12) : 0);
    return Math.max(0, monthlyReference * 12 - annualReference * 12);
  }, [subscription, addonMonthlyPrice, addonAnnualPricePerStep]);

  const formatRelativeBucket = (iso: string | null | undefined): string | null => {
    const bucket = bucketRelativeTime(iso);
    if (!bucket) return null;
    switch (bucket.unit) {
      case "just_now":
        return t("account.storage.relativeJustNow");
      case "seconds":
        return t("account.storage.relativeSeconds", { value: bucket.value });
      case "minutes":
        return t("account.storage.relativeMinutes", { value: bucket.value });
      case "hours":
        return t("account.storage.relativeHours", { value: bucket.value });
      case "days":
        return t("account.storage.relativeDays", { value: bucket.value });
    }
  };

  const refreshAccountStorage = async () => {
    if (!token) return;
    const next = await getAccountStorage(token).catch(() => null);
    if (next) setAccountStorage(next);
  };

  const recomputeStrings = useMemo(
    () => ({
      buttonLabel: t("account.storage.recompute"),
      buttonRunning: t("account.storage.recomputeRunning"),
      lastVerifiedLabel: (relative: string) => t("account.storage.lastVerified", { relative }),
      reclaimableHint: (bytes: string) => t("account.storage.reclaimableHint", { bytes }),
      confirmTitle: (count: number, bytes: string) => t("account.storage.confirmTitle", { count, bytes }),
      confirmAccept: t("account.storage.confirmAccept"),
      confirmCancel: t("account.storage.confirmCancel"),
      resultReclaimed: (bytes: string) => t("account.storage.resultReclaimed", { bytes }),
      resultAlreadyInSync: t("account.storage.resultAlreadyInSync"),
      resultFailed: t("account.storage.resultFailed"),
    }),
    [t]
  );

  const storageGcRun = window.sf?.storageGc?.run;
  const recomputeProps = useMemo(() => {
    if (!storageGcRun) return undefined;
    return {
      onDryRun: async () => {
        const result = await storageGcRun({ dryRun: true });
        return { orphanedKeys: result.orphanedKeys, reclaimedBytes: result.reclaimedBytes };
      },
      onConfirm: async () => {
        const result = await storageGcRun({ dryRun: false });
        return { reclaimedBytes: result.reclaimedBytes, deletedKeys: result.deletedKeys };
      },
      onComplete: () => {
        void refreshAccountStorage();
        // STOR-PLACE-09: after a clean-up, artwork a title still uses is checked and fetched back if gone.
        void getDesktopArtworkHealer()?.sweep();
      },
      relativeLastVerified: formatRelativeBucket(accountStorage?.lastReconciledAt),
      strings: recomputeStrings,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageGcRun, accountStorage?.lastReconciledAt, recomputeStrings, token]);

  /** Reloads what a plan change touches (plan, storage, billing, access), so no restart is needed. */
  const refreshAfterPlanChange = async () => {
    if (!token) return;
    const [nextSub, nextStorage, me] = await Promise.all([
      getSubscription(token),
      getAccountStorage(token),
      getMe(token),
      refreshBilling(),
    ]);
    setUser({ ...me.user, access: me.access ?? me.user.access });
    setSubscription(nextSub);
    setAccountStorage(nextStorage);
    setPendingPlan(null);
    setPendingAddonCount(nextSub.storageAddonCount ?? 0);
  };

  /**
   * Sends one plan change through the shared plan change (ACCT-PAY-01, ACCT-PLAN-07/08): the stand-in
   * provider applies it; under Stancer a first payment or a move up opens the hosted payment page and this
   * screen waits for the payment's result, a move down or a period switch is booked for the next payment,
   * and a plan the library does not fit is refused with the amount to remove.
   */
  const runPlanChange = async (request: { plan: string; billingPeriod: BillingPeriod; addonCount: number }, reason: string) => {
    if (!token || !subscription) return;
    setPlanMessage(null);
    rendererLogger.info(
      { scope: "account-section", ...request, reason, provider: billing?.provider ?? null },
      "plan-change.requested"
    );
    const result = await planChange.run({ ...request, lang: paymentPageLang(i18n?.language) }, billing);
    rendererLogger.info({ scope: "account-section", plan: request.plan, result }, "plan-change.result");
    // Applied, booked, or a booking dropped: reload the account's figures and the booked change.
    if (
      result.kind === "changed" ||
      result.kind === "paid" ||
      result.kind === "endsAt" ||
      result.kind === "booked" ||
      result.kind === "bookingCancelled"
    ) {
      try {
        await refreshAfterPlanChange();
      } catch (err) {
        rendererLogger.warn(
          { scope: "account-section", err: err instanceof Error ? err.message : String(err) },
          "plan-change.refresh-failed"
        );
      }
    }
    setPlanMessage(planChangeResultMessage(t, result, i18n?.language));
  };

  /** Applies `planOverride` (the unpaid renew of the current plan) or the pending plan. */
  const confirmPlanChange = async (planOverride?: string) => {
    const plan = planOverride ?? pendingPlan;
    if (!plan) return;
    const addonCount = plan === "tier3" ? pendingAddonCount : 0;
    await runPlanChange({ plan, billingPeriod, addonCount }, planOverride ? "renew" : "select");
  };

  /** Drops the booked change: the current plan chosen again (the server answers `booking_cancelled`). */
  const keepCurrentPlan = async () => {
    if (!subscription) return;
    await runPlanChange(
      {
        plan: subscription.plan,
        billingPeriod: subscription.billingPeriod ?? billingPeriod,
        addonCount: subscription.plan === "tier3" ? subscription.storageAddonCount : 0,
      },
      "keep-current"
    );
  };

  const scheduledChange = subscription?.scheduledChange ?? null;
  const scheduledDate = scheduledChange ? formatAccessDate(scheduledChange.effectiveAt, i18n?.language) : null;
  const renewalHoldDate = subscription?.renewalHold ? formatAccessDate(subscription.renewalHold.chargeAt, i18n?.language) : null;

  /** The current paid plan on the other billing period (ACCT-PLAN-12): a switch, booked for the next payment. */
  const isPeriodSwitch = (plan: string): boolean =>
    Boolean(subscription && plan === subscription.plan && plan !== "free" && subscription.billingPeriod && subscription.billingPeriod !== billingPeriod);

  const onSelectPlan = (plan: string) => {
    if (!subscription) return;
    if (plan === subscription.plan && !isPeriodSwitch(plan)) {
      setPendingPlan(null);
      return;
    }
    setPendingPlan(plan);
    setPendingAddonCount(plan !== "tier3" ? 0 : subscription.storageAddonCount ?? 0);
  };

  const onAddonChange = (value: number) => {
    if (!subscription) return;
    setPendingAddonCount(value);
    if (subscription.plan === "tier3" && value !== subscription.storageAddonCount) {
      setPendingPlan("tier3");
    }
  };

  const copyCode = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopyMessage(t("account.twoFactor.messages.copySuccess"));
    } catch {
      setCopyMessage(t("account.twoFactor.messages.copyFail"));
    }
  };

  return (
    <div className="space-y-4">
      {pageError ? (
        <SettingPanel tone="danger">
          <div className="font-semibold text-destructive">{t("account.loadErrorTitle")}</div>
          <SettingHint>{pageError}</SettingHint>
        </SettingPanel>
      ) : null}

      {/* Subscription */}
      <SettingPanel>
        <div className="space-y-1">
          <div className="font-semibold">{t("account.subscription.title")}</div>
          <SettingHint>{t("account.subscription.subtitle")}</SettingHint>
          {/* WAIT-FOUND-04: "Founder 🎫 · since the waitlist, {date}" for a founder. */}
          <FounderSettingsBadge />
        </div>

        {plansUnavailableReason && !unlimited ? (
          <div
            data-testid="account-plans-unavailable"
            data-reason={plansUnavailableReason}
            className="mt-3 rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground"
          >
            {planUnavailableMessage(t, plansUnavailableReason)}
          </div>
        ) : null}

        {/* Launch without payments (ACCT-PAY-07): any plan is active at once and free until payments open. */}
        {paymentsNotOpen(billing) && !unlimited ? (
          subscription && subscription.plan !== "free" ? (
            <div
              data-testid="account-payments-not-open"
              className="mt-3 space-y-1 rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground"
            >
              <p>{t("account.subscription.prelaunchNote.free", { plan: t(`account.plans.${subscription.plan}.title`) })}</p>
              <p>
                {t(
                  (subscription.billingPeriod ?? billingPeriod) === "annual"
                    ? "account.subscription.prelaunchNote.emailYear"
                    : "account.subscription.prelaunchNote.emailMonth"
                )}
              </p>
              <p>{t("account.subscription.prelaunchNote.unpaid")}</p>
            </div>
          ) : (
            <div
              data-testid="account-payments-not-open"
              className="mt-3 rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground"
            >
              {t("account.subscription.paymentsNotOpen")}
            </div>
          )
        ) : null}

        {waitingPayment ? (
          <div
            data-testid="account-payment-waiting"
            className="mt-3 space-y-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-3 text-sm"
          >
            <div>{t("account.subscription.paymentWaiting")}</div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="secondary" data-testid="account-payment-reopen" onClick={planChange.reopen}>
                {t("account.subscription.paymentReopen")}
              </Button>
              <Button type="button" size="sm" variant="secondary" data-testid="account-payment-check" onClick={planChange.checkNow}>
                {t("account.subscription.paymentCheckNow")}
              </Button>
              <Button type="button" size="sm" variant="outline" data-testid="account-payment-stop" onClick={planChange.stop}>
                {t("account.subscription.paymentStop")}
              </Button>
            </div>
          </div>
        ) : null}

        {loading || !subscription ? (
          <div className="mt-4 text-sm text-muted-foreground">{t("account.subscription.loading")}</div>
        ) : (
          <div className="mt-4 space-y-6">
            {unlimited ? null : (
            <>
            <div className="flex flex-col gap-3 rounded-xl border border-border bg-muted/20 p-4 md:flex-row md:items-center md:justify-between">
              <div className="space-y-1">
                <div className="font-semibold">{t("account.subscription.billingPeriod")}</div>
                <SettingHint>
                  {isAnnual
                    ? t("account.subscription.annualBilling", { amount: formatEuro(savingsPerYear) })
                    : t("account.subscription.monthlyBilling")}
                </SettingHint>
              </div>
              <div className="flex items-center gap-3">
                <Switch
                  checked={isAnnual}
                  onCheckedChange={(checked) => {
                    const next = checked ? "annual" : "monthly";
                    setBillingPeriod(next);
                    if (token) {
                      updateSettings(token, {
                        preferences: { ...(user?.preferences ?? {}), billingPeriod: next },
                      })
                        .then((result) => setUser(result.user))
                        .catch(() => undefined);
                    }
                  }}
                  aria-label={t("account.subscription.toggleAnnual")}
                />
                <span className="text-sm font-medium">
                  {isAnnual ? t("account.subscription.annual") : t("account.subscription.monthly")}
                </span>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              {(["free", "tier1", "tier2", "tier3"] as const).map((plan) => {
                const details = PLAN_CONFIG[plan];
                const asFounder = founder && plan !== "free";
                const choice = { plan, addonCount: 0 };
                const founderMonthly = planMonthlyPrice(choice, "monthly", true);
                const founderAnnualPerMonth = planMonthlyPrice(choice, "annual", true);
                const founderYearly = planYearlyPrice(choice, true);
                // Yearly billing strikes the monthly (or founder list) price only when it is above the shown price, and
                // shows the yearly total and the saving only when they are above zero: Free shows its price alone.
                const annualListPerMonth = asFounder ? details.annualPerMonth : details.monthly;
                const annualShownPerMonth = asFounder ? founderAnnualPerMonth : details.annualPerMonth;
                const annualYearly = asFounder ? founderYearly : details.annualPerMonth * 12;
                const annualSaving = asFounder
                  ? Math.max(0, founderMonthly * 12 - founderYearly)
                  : Math.max(0, details.monthly * 12 - details.annualPerMonth * 12);
                const isCurrent = subscription.plan === plan;
                const isPending = pendingPlan === plan;
                // An unpaid account re-pays by re-submitting its current plan; otherwise the current plan is inert.
                // Payments just opened (ACCT-PAY-07): the current paid plan, on its own period, is paid the same way
                // (no paid period runs yet, so the API takes a plain checkout of it).
                const isWindowPay =
                  isCurrent && !isPending && plan !== "free" && Boolean(billing?.paymentDeadline) && !isPeriodSwitch(plan);
                const isRenewal = (isCurrent && !isPending && effectiveAccess?.state === "unpaid") || isWindowPay;
                const periodSwitch = !isRenewal && isPeriodSwitch(plan);
                // Not offered while the billing status loads, or when choosing it would fail (ACCT-PAY-01).
                const action = billingLoaded ? resolvePlanAction(plan, billing) : null;
                const unavailable = !action || action.kind === "unavailable";
                const buttonLabel = isWindowPay
                  ? t("account.subscription.payNow")
                  : isRenewal
                    ? t("account.subscription.renew")
                    : isPending
                      ? t("account.subscription.confirmPlanChange")
                      : isCurrent && !periodSwitch
                        ? t("account.subscription.currentPlan")
                        : t("account.subscription.switch");
                return (
                  <div
                    key={plan}
                    className={[
                      "flex h-full flex-col rounded-xl border border-border bg-card p-5 transition",
                      isCurrent ? "border-primary/40" : isPending ? "border-primary/30" : "hover:border-primary/20",
                    ].join(" ")}
                  >
                    <div className="space-y-2">
                      <div className="text-lg font-semibold">{t(`account.plans.${plan}.title`)}</div>
                      {isAnnual ? (
                        <div className="space-y-1">
                          <div className="flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between">
                            <div className="flex items-baseline gap-2">
                              {annualListPerMonth > annualShownPerMonth && (
                                <span className="text-sm font-bold text-muted-foreground/90 line-through" data-testid={`account-plan-list-price-${plan}`}>
                                  {formatEuro(annualListPerMonth)}
                                </span>
                              )}
                              <span className="text-lg font-bold text-primary" data-testid={`account-plan-price-${plan}`}>
                                {formatEuro(annualShownPerMonth)}
                              </span>
                              <span className="text-[10px] font-semibold text-muted-foreground">
                                {t("account.subscription.perMonth")}
                              </span>
                            </div>
                            <div className="text-lg font-bold text-primary">{details.storageGb}GB</div>
                          </div>
                          {annualYearly > 0 && (
                            <SettingHint>{t("account.subscription.billedYearly", { amount: formatEuro(annualYearly) })}</SettingHint>
                          )}
                          {annualSaving > 0 && (
                            <div className="text-xs text-primary" data-testid={`account-plan-saving-${plan}`}>
                              {t("account.subscription.savePerYear", { amount: formatEuro(annualSaving) })}
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="space-y-1">
                          <div className="flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between">
                            <div className="flex items-baseline gap-2">
                              {asFounder ? (
                                <>
                                  <span className="text-sm font-bold text-muted-foreground/90 line-through" data-testid={`account-plan-list-price-${plan}`}>
                                    {formatEuro(details.monthly)}
                                  </span>
                                  <span className="text-sm font-semibold text-primary" data-testid={`account-plan-price-${plan}`}>
                                    {formatEuro(founderMonthly)}
                                  </span>
                                </>
                              ) : (
                                <span className="text-sm font-semibold text-muted-foreground" data-testid={`account-plan-price-${plan}`}>
                                  {formatEuro(details.monthly)}
                                </span>
                              )}
                              <span className="text-[10px] font-semibold text-muted-foreground">
                                {t("account.subscription.perMonth")}
                              </span>
                            </div>
                            <div className="text-lg font-bold text-primary">{details.storageGb}GB</div>
                          </div>
                          <SettingHint>{t("account.subscription.billedMonthly")}</SettingHint>
                        </div>
                      )}
                      {asFounder && (
                        <div className="text-xs font-semibold text-primary" data-testid={`account-plan-founder-${plan}`}>
                          {t("account.subscription.founderPrice", { percent: FOUNDER_DISCOUNT_PERCENT })}
                        </div>
                      )}
                    </div>

                    {plan === "tier3" && (isCurrent || isPending) ? (
                      <div className="mt-4 space-y-2">
                        <div className="text-sm font-semibold">{t("account.subscription.extraStorage")}</div>
                        <SettingHint>
                          {isAnnual
                            ? t("account.subscription.extraStorageAnnual", {
                                size: planSizeLabel(PLAN_CONFIG.tier3.addon.stepGb, locale),
                                amount: formatEuro(PLAN_CONFIG.tier3.addon.annualPerStep),
                              })
                            : t("account.subscription.extraStorageMonthly", {
                                size: planSizeLabel(PLAN_CONFIG.tier3.addon.stepGb, locale),
                                amount: formatEuro(PLAN_CONFIG.tier3.addon.monthly),
                              })}
                        </SettingHint>
                        <input
                          type="number"
                          min={0}
                          step={1}
                          value={isPending ? pendingAddonCount : subscription.storageAddonCount}
                          onChange={(e) => onAddonChange(Math.max(0, Math.trunc(Number(e.target.value) || 0)))}
                          className="w-24 rounded border border-border bg-background px-2 py-1 text-sm"
                          data-testid="account-addon-count"
                        />
                        <div className="text-xs text-muted-foreground">
                          {t("account.subscription.total")}{" "}
                          {planSizeLabel(
                            PLAN_CONFIG.tier3.storageGb +
                              (isPending ? pendingAddonCount : subscription.storageAddonCount) * PLAN_CONFIG.tier3.addon.stepGb,
                            locale
                          )}
                        </div>
                      </div>
                    ) : null}

                    <div className="mt-auto pt-5">
                      <Button
                        type="button"
                        variant={isCurrent || isPending ? "default" : "secondary"}
                        className={isCurrent ? "w-full bg-primary text-primary-foreground" : "w-full"}
                        data-testid={`account-plan-button-${plan}`}
                        disabled={planBusy || unavailable || (isCurrent && !isPending && !isRenewal && !periodSwitch)}
                        onClick={() => {
                          if (isRenewal) {
                            void confirmPlanChange(plan);
                            return;
                          }
                          if (isPending) {
                            // Before payments open a paid plan asks first; Free applies at once (ACCT-PAY-07).
                            if (plan !== "free" && paymentsNotOpen(billing)) {
                              rendererLogger.info({ scope: "account-section", plan, billingPeriod }, "prelaunch-confirm.open");
                              setPrelaunchPlan(plan);
                              return;
                            }
                            void confirmPlanChange();
                            return;
                          }
                          onSelectPlan(plan);
                        }}
                      >
                        {planBusy && (isPending || isRenewal) ? t("account.subscription.updating") : buttonLabel}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
            </>
            )}

            <div className="rounded-xl border border-border bg-muted/10 p-4">
              <div className="text-sm font-semibold">{t("account.subscription.currentPlan")}</div>
              <SettingHint>{unlimited ? t("account.subscription.adminUnlimited") : planLabel}</SettingHint>
              {accessNotice && !unlimited ? (
                <div
                  data-testid="account-access-notice"
                  data-access-state={effectiveAccess?.state}
                  className={
                    effectiveAccess?.state === "unpaid"
                      ? "mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200"
                      : "mt-2 text-xs text-muted-foreground"
                  }
                >
                  {accessNotice}
                </div>
              ) : null}
              {scheduledChange && scheduledDate && !unlimited ? (
                <div
                  data-testid="account-scheduled-change"
                  data-fits={scheduledChange.fits ? "true" : "false"}
                  className="mt-2 space-y-2 rounded-md border border-border bg-muted/20 px-3 py-2 text-xs"
                >
                  <div>
                    {t("account.subscription.scheduledChange", {
                      plan: t(`account.plans.${scheduledChange.plan}.title`),
                      date: scheduledDate,
                    })}
                  </div>
                  {!scheduledChange.fits ? (
                    <div data-testid="account-scheduled-too-large" className="text-amber-200">
                      {t("account.subscription.scheduledTooLarge", {
                        excess: formatLocalizedStorage(scheduledChange.excessBytes, locale),
                        date: scheduledDate,
                      })}
                    </div>
                  ) : null}
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    data-testid="account-cancel-booking"
                    disabled={planBusy}
                    onClick={() => void keepCurrentPlan()}
                  >
                    {t("account.subscription.keepCurrentPlan")}
                  </Button>
                </div>
              ) : null}
              {renewalHoldDate && !unlimited ? (
                <div
                  data-testid="account-renewal-hold"
                  className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200"
                >
                  {t("account.subscription.renewalHold", { date: renewalHoldDate })}
                </div>
              ) : null}
              <div className="mt-3">
                {accountStorage ? (
                  <AccountStorageCard
                    data={accountStorage}
                    locale={locale}
                    upgradeLabel={t("lab.errors.upgradePlan")}
                    unlimitedLabel={t("account.subscription.adminUnlimited")}
                    recompute={recomputeProps}
                  />
                ) : subscription.storageLimitGb === null ? (
                  <div className="text-xs text-muted-foreground" data-testid="account-storage-used-unlimited">
                    {t("account.subscription.usedUnlimited", { used: formatLocalizedStorage(planGbToBytes(subscription.storageUsedGb), locale) })}
                  </div>
                ) : (
                  <>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full bg-primary"
                        style={{
                          width: `${Math.min(
                            100,
                            subscription.storageLimitGb === 0
                              ? 0
                              : (subscription.storageUsedGb / subscription.storageLimitGb) * 100
                          )}%`,
                        }}
                      />
                    </div>
                    <div className="mt-2 text-xs text-muted-foreground">
                      {t(
                        "account.subscription.used",
                        formatLocalizedStorageUsage(planGbToBytes(subscription.storageUsedGb), planGbToBytes(subscription.storageLimitGb), locale),
                      )}
                    </div>
                  </>
                )}
              </div>
              {planMessage ? (
                <div data-testid="account-plan-message" className="mt-3 text-sm text-muted-foreground">
                  {planMessage}
                </div>
              ) : null}
            </div>
          </div>
        )}

        {/* Launch without payments (ACCT-PAY-07): a paid plan is free until payments open; say so before applying it. */}
        <Dialog
          open={prelaunchPlan !== null}
          onOpenChange={(open) => {
            if (open) return;
            rendererLogger.info({ scope: "account-section", plan: prelaunchPlan }, "prelaunch-confirm.cancel");
            setPrelaunchPlan(null);
          }}
        >
          {prelaunchPlan ? (
            <DialogContent data-testid="account-prelaunch-confirm">
              <DialogHeader>
                <DialogTitle>{t("account.subscription.prelaunchConfirm.title")}</DialogTitle>
                <DialogDescription data-testid="account-prelaunch-confirm-free">
                  {t("account.subscription.prelaunchConfirm.free", { plan: t(`account.plans.${prelaunchPlan}.title`) })}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p data-testid="account-prelaunch-confirm-email">
                  {t(isAnnual ? "account.subscription.prelaunchConfirm.emailYear" : "account.subscription.prelaunchConfirm.emailMonth")}
                  {billing?.founder === true ? ` ${t("account.subscription.prelaunchConfirm.founder")}` : null}
                </p>
                <p data-testid="account-prelaunch-confirm-unpaid">{t("account.subscription.prelaunchConfirm.unpaid")}</p>
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="secondary"
                  data-testid="account-prelaunch-confirm-cancel"
                  onClick={() => {
                    rendererLogger.info({ scope: "account-section", plan: prelaunchPlan }, "prelaunch-confirm.cancel");
                    setPrelaunchPlan(null);
                  }}
                >
                  {t("account.subscription.prelaunchConfirm.cancel")}
                </Button>
                <Button
                  type="button"
                  data-testid="account-prelaunch-confirm-start"
                  onClick={() => {
                    rendererLogger.info({ scope: "account-section", plan: prelaunchPlan, billingPeriod }, "prelaunch-confirm.start");
                    setPrelaunchPlan(null);
                    void confirmPlanChange();
                  }}
                >
                  {t("account.subscription.prelaunchConfirm.confirm", { plan: t(`account.plans.${prelaunchPlan}.title`) })}
                </Button>
              </DialogFooter>
            </DialogContent>
          ) : null}
        </Dialog>
      </SettingPanel>

      {/* News emails (ACCT-NEWS-01) */}
      <SettingPanel className="p-0">
        <SettingRow
          title={newsText.news}
          description={newsText.newsHint}
          control={
            <Switch
              aria-label={newsText.news}
              data-testid="account-news-switch"
              checked={user?.newsOptIn === true}
              disabled={!token || newsSaving}
              onCheckedChange={saveNews}
            />
          }
        />
      </SettingPanel>

      {/* Sponsorships */}
      <SettingPanel>
        <div className="space-y-1">
          <div className="font-semibold">{t("account.sponsorships.title")}</div>
          <SettingHint>{t("account.sponsorships.subtitle")}</SettingHint>
        </div>
        {loading ? (
          <div className="mt-4 text-sm text-muted-foreground">{t("account.sponsorships.loading")}</div>
        ) : (
          <div className="mt-4 space-y-4">
            <div className="flex flex-col gap-3 rounded-xl border border-border bg-muted/10 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="text-sm font-semibold">{t("account.sponsorships.yourCode")}</div>
                <div className="text-sm text-muted-foreground">{sponsorCode ?? "—"}</div>
              </div>
              <Button type="button" variant="secondary" onClick={() => void copyCode(sponsorCode ?? "")} disabled={!sponsorCode}>
                {t("account.common.copy")}
              </Button>
            </div>
            {copyMessage ? <SettingHint>{copyMessage}</SettingHint> : null}
            {sponsorships.length === 0 ? (
              <div className="text-sm text-muted-foreground">{t("account.sponsorships.empty")}</div>
            ) : (
              <>
                <SettingRow
                  className="p-0"
                  title={t("account.sponsorships.summary", {
                    count: sponsorships.length,
                    validated: sponsorships.filter((entry) => entry.status === "validated").length,
                  })}
                  control={
                    <Button type="button" variant="secondary" size="sm" onClick={() => setSponsorshipsOpen(true)}>
                      {t("account.sponsorships.viewAll")}
                    </Button>
                  }
                />
                <SettingListDialog
                  open={sponsorshipsOpen}
                  onOpenChange={setSponsorshipsOpen}
                  title={t("account.sponsorships.title")}
                  description={t("account.sponsorships.subtitle")}
                  testId="sponsorships-dialog"
                >
                  {sponsorships.map((s) => (
                    <div key={s.id} className="rounded-xl border border-border bg-card p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="font-semibold">{s.referredEmailMasked}</div>
                          <div className="text-xs text-muted-foreground">
                            {t("account.sponsorships.eligibleAt", { date: new Date(s.eligibleAt).toLocaleDateString(i18n?.language) })}
                          </div>
                        </div>
                        <span
                          className={[
                            "rounded-full px-3 py-1 text-xs",
                            s.status === "validated" ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground",
                          ].join(" ")}
                        >
                          {s.status === "validated"
                            ? t("account.sponsorships.validated")
                            : t("account.sponsorships.pending", { days: s.daysRemaining })}
                        </span>
                      </div>
                    </div>
                  ))}
                </SettingListDialog>
              </>
            )}
          </div>
        )}
      </SettingPanel>

      {/* Billing */}
      <SettingPanel>
        <div className="space-y-1">
          <div className="font-semibold">{t("account.billing.title")}</div>
          <SettingHint>{t("account.billing.subtitle")}</SettingHint>
        </div>
        <div className="mt-3 text-sm text-muted-foreground">{t("account.billing.empty")}</div>
      </SettingPanel>
    </div>
  );
}
