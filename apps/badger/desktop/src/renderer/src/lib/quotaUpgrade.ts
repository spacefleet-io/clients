/**
 * One-click plan upgrade used by the storage upgrade offers (spec INGS-QUOTA-01,
 * INGS-QUOTA-02): the import window and the "upload refused for lack of space" notice.
 * Same plan change as Settings → Account (ACCT-PAY-01, `@/lib/planChange`): the stand-in
 * provider applies it at once; Stancer opens the hosted payment page in the browser and
 * waits for the payment. Then the fresh storage figures, so the caller can carry on with
 * what the user was doing.
 */
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { AccountStorageSummary } from "@space/shared/api";
import { paymentPageLang, resolvePlanAction, type PlanChangeResult } from "@space/shared/billingCheckout";
import { getAccountStorage, getMe } from "@/api";
import { useAuth } from "@/auth";
import { rendererLogger } from "@/logger";
import type { PlanOffer } from "@/lib/importQuota";
import { planSizeLabel } from "@/lib/sizeLabel";
import {
  planChangeResultMessage,
  planUnavailableMessage,
  useAccountPlanChange,
  useBillingStatus,
} from "@/lib/planChange";
import { planStorageGb, planYearlyPrice } from "@space/shared/storagePlans";

const log = rendererLogger.child({ scope: "quota-upgrade" });

/** The upgrade did not happen (refused, cancelled, stopped, unavailable, failed). */
export class QuotaUpgradeError extends Error {
  result: PlanChangeResult;
  constructor(result: PlanChangeResult) {
    super(result.kind === "error" ? result.code : result.kind);
    this.result = result;
  }
}

export type QuotaUpgrade = {
  /** False while the billing status loads, and when an upgrade cannot be bought right now. */
  available: boolean;
  /** Said in place of the upgrade button when it is not available (null while loading). */
  unavailableMessage: string | null;
  /** Stancer's payment page is open in the browser and the app waits for the payment. */
  waiting: boolean;
  /** Opens the payment page again. */
  reopen: () => void;
  /** Stops waiting: `upgrade` rejects with a `stopped` result. */
  stop: () => void;
  upgrade: (offer: PlanOffer) => Promise<AccountStorageSummary>;
  /** Words for a rejected `upgrade`. */
  failureMessage: (error: unknown) => string;
};

export const useQuotaUpgrade = (source: string): QuotaUpgrade => {
  const { t, i18n } = useTranslation();
  const { token, setUser } = useAuth();
  const { billing, loaded } = useBillingStatus();
  const planChange = useAccountPlanChange();
  const run = planChange.run;
  // Every offer is a paid plan, so one check covers them all.
  const action = loaded ? resolvePlanAction("tier1", billing) : null;
  const unavailableReason = action?.kind === "unavailable" ? action.reason : null;

  const upgrade = useCallback(
    async (offer: PlanOffer): Promise<AccountStorageSummary> => {
      if (!token) throw new Error("AUTH_REQUIRED");
      log.info(
        {
          source,
          plan: offer.plan,
          addonCount: offer.addonCount,
          billingPeriod: offer.billingPeriod,
          provider: billing?.provider ?? null,
        },
        "quota-upgrade.requested",
      );
      const result = await run(
        {
          plan: offer.plan,
          billingPeriod: offer.billingPeriod,
          addonCount: offer.addonCount,
          lang: paymentPageLang(i18n.language),
        },
        billing,
      );
      if (result.kind !== "changed" && result.kind !== "paid") {
        log.warn({ source, plan: offer.plan, result }, "quota-upgrade.failed");
        throw new QuotaUpgradeError(result);
      }
      const [me, storage] = await Promise.all([getMe(token), getAccountStorage(token)]);
      setUser({ ...me.user, access: me.access ?? me.user.access });
      log.info(
        { source, plan: storage.plan, limitBytes: storage.limitBytes, usedBytes: storage.usedBytes, result: result.kind },
        "quota-upgrade.done",
      );
      return storage;
    },
    [billing, i18n.language, run, setUser, source, token],
  );

  const failureMessage = useCallback(
    (error: unknown) => {
      if (!(error instanceof QuotaUpgradeError)) return t("ingestion.quota.upgradeFailed");
      const { result } = error;
      if (result.kind === "error" && result.code !== "billing_unavailable") return t("ingestion.quota.upgradeFailed");
      return planChangeResultMessage(t, result, i18n.language);
    },
    [i18n.language, t],
  );

  return {
    available: loaded && !unavailableReason,
    unavailableMessage: unavailableReason ? planUnavailableMessage(t, unavailableReason) : null,
    waiting: planChange.state.phase === "waiting",
    reopen: planChange.reopen,
    stop: planChange.stop,
    upgrade,
    failureMessage,
  };
};

/** Plan name as "Scale (1500 GB)" (the way Settings → Account names plans) and its price: per month, or the yearly total charged. */
export const usePlanOfferText = () => {
  const { t, i18n } = useTranslation();
  const currency = useMemo(
    () => new Intl.NumberFormat(i18n.language || "en", { style: "currency", currency: "EUR" }),
    [i18n.language],
  );
  return {
    name: (offer: PlanOffer) => `${t(`account.plans.${offer.plan}.title`)} (${planSizeLabel(planStorageGb(offer), i18n.language || "en")})`,
    price: (offer: PlanOffer) =>
      offer.billingPeriod === "annual"
        ? t("ingestion.quota.priceAnnual", { total: currency.format(planYearlyPrice(offer)), price: currency.format(offer.monthlyPrice) })
        : t("ingestion.quota.priceMonthly", { price: currency.format(offer.monthlyPrice) }),
  };
};

