/**
 * Choosing a plan from the desktop app (ACCT-PAY-01, ACCT-PLAN-07/08/11/12): Settings → Account and the
 * storage upgrade offers (INGS-QUOTA-01/02) both go through the shared plan change
 * (`@space/shared/billingCheckout`, `usePlanChange` in `@space/desktop-shell/hooks`). Under Stancer a paid
 * plan (a first payment, or a move up paid prorated) opens Stancer's hosted payment page in the system
 * browser and the app checks the payment's result until it is settled; a move down or a period switch is
 * booked for the next payment, and a plan the library does not fit is refused with the amount to remove.
 * This file binds that to the signed-in account and words the results.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { TFunction } from "i18next";
import {
  isStancerPaymentUrl,
  planChangeMessage,
  type BillingStatus,
  type PlanChangeApi,
  type PlanChangeResult,
  type PlanUnavailableReason,
} from "@space/shared/billingCheckout";
import { formatAccessDate } from "@space/shared/effectiveAccess";
import { formatLocalizedStorage } from "@space/shared/format";
import { usePlanChange, type UsePlanChangeResult } from "@space/desktop-shell/hooks";
import { completeStancerPayment, getBillingStatus, startCheckout, updateSubscription } from "@/api";
import { useAuth } from "@/auth";
import { rendererLogger } from "@/logger";

const log = rendererLogger.child({ scope: "plan-change" });

/**
 * The renderer's `window.open` is turned into the system browser by the main process
 * (`setWindowOpenHandler` → `shell.openExternal`, https and mailto only), so the card is typed in the
 * user's own browser. The shared plan change already refuses any page that is not Stancer's; this
 * check keeps that true for any other caller.
 */
const openInSystemBrowser = (url: string) => {
  if (!isStancerPaymentUrl(url)) {
    log.warn({ url }, "plan-change.open-hosted-page-refused");
    return;
  }
  log.info({ host: new URL(url).host }, "plan-change.open-hosted-page");
  window.open(url, "_blank", "noopener,noreferrer");
};

/** ACCT-PAY-05: main hands over `badger://billing/return` links (absent outside Electron: nothing to listen to). */
const subscribePaymentReturn = (listener: (paymentId: string) => void) => window.sf?.billing?.onPaymentReturn(listener) ?? (() => {});

/** The plan change for the signed-in account. */
export const useAccountPlanChange = (): UsePlanChangeResult => {
  const { token } = useAuth();
  const api = useMemo<PlanChangeApi>(
    () => ({
      updateSubscription: (plan, options) => {
        if (!token) return Promise.reject(new Error("auth_required"));
        return updateSubscription(token, plan, options);
      },
      startCheckout: (input) => {
        if (!token) return Promise.reject(new Error("auth_required"));
        // ACCT-PAY-05: the payment page comes back to Badger (`badger://billing/return`), not to the website.
        return startCheckout(token, { ...input, returnApp: "badger" });
      },
      completePayment: (paymentId) => {
        if (!token) return Promise.reject(new Error("auth_required"));
        return completeStancerPayment(token, paymentId);
      },
    }),
    [token],
  );
  return usePlanChange({
    api,
    openUrl: openInSystemBrowser,
    onPaymentReturn: subscribePaymentReturn,
    log: {
      info: (message, details) => log.info(details ?? {}, `plan-change.${message}`),
      warn: (message, details) => log.warn(details ?? {}, `plan-change.${message}`),
    },
  });
};

export type BillingStatusState = {
  /** null when it could not be read: nothing that may need payment is offered then. */
  billing: BillingStatus | null;
  loaded: boolean;
  refresh: () => Promise<BillingStatus | null>;
};

/** `GET /billing/status` for the signed-in account: the billing provider, and the Stancer subscription. */
export const useBillingStatus = (): BillingStatusState => {
  const { token } = useAuth();
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    if (!token) return null;
    const next = await getBillingStatus(token).catch((err: unknown) => {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "plan-change.billing-status-failed");
      return null;
    });
    log.info(
      {
        provider: next?.provider ?? null,
        checkoutAllowed: next?.checkoutAllowed ?? null,
        checkoutBlockedReason: next?.checkoutBlockedReason ?? null,
        live: next?.subscription?.live ?? null,
        cancelAtPeriodEnd: next?.subscription?.cancelAtPeriodEnd ?? null,
      },
      "plan-change.billing-status",
    );
    setBilling(next);
    setLoaded(true);
    return next;
  }, [token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { billing, loaded, refresh };
};

/** Why a plan cannot be chosen, in words. */
export const planUnavailableMessage = (t: TFunction, reason: PlanUnavailableReason): string => {
  switch (reason) {
    case "renewal_pending":
      return t("account.subscription.renewalPending");
    case "billing_unknown":
      return t("account.subscription.billingUnknown");
  }
};

/** What happened, in words, for a finished plan change (which message: the shared `planChangeMessage`). */
export const planChangeResultMessage = (t: TFunction, result: PlanChangeResult, language: string | undefined): string => {
  const message = planChangeMessage(result);
  switch (message.id) {
    case "changed":
      return t("account.subscription.updated");
    case "paid":
      return t("account.subscription.paymentSuccess");
    case "refused":
      return t("account.subscription.paymentRefused");
    case "canceled":
      return t("account.subscription.paymentCancelled");
    case "endsAt": {
      const date = formatAccessDate(message.effectiveAt, language);
      return date ? t("account.subscription.endsOn", { date }) : t("account.subscription.updated");
    }
    case "booked": {
      const date = formatAccessDate(message.effectiveAt, language);
      return date ? t("account.subscription.booked", { date }) : t("account.subscription.updated");
    }
    case "bookingCancelled":
      return t("account.subscription.bookingCancelled");
    case "unchanged":
      return t("account.subscription.unchanged");
    case "tooLarge":
      return t("account.subscription.tooLarge", { excess: formatLocalizedStorage(message.excessBytes, language || "en") });
    case "stopped":
      return t("account.subscription.paymentStopped");
    case "timeout":
      return t("account.subscription.paymentPending");
    case "unavailable":
      return planUnavailableMessage(t, message.reason);
    case "paymentsUnavailable":
      return t("account.subscription.paymentsUnavailable");
    case "checkoutInProgress":
      return t("account.subscription.checkoutInProgress");
    case "generic":
      return t("account.errors.generic");
  }
};
