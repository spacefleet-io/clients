/**
 * Jobs-sidebar notice for uploads the server refused because the account is full
 * (spec INGS-QUOTA-01: never a bare "Failed"). Says it in plain words and offers the
 * next plan up with its price, switched in place like the import window does. Only
 * mounted when a job failed with `upload_quota_exceeded`, so the sidebar stays
 * auth-free otherwise.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@space/ui";
import type { AccountStorageSummary } from "@space/shared/api";
import { getAccountStorage } from "@/api";
import { useAuth } from "@/auth";
import AmberNotice from "@/components/AmberNotice";
import { evaluateImportQuota } from "@/lib/importQuota";
import { loadBillingPeriod } from "@space/shared/storagePlans";
import { usePlanOfferText, useQuotaUpgrade } from "@/lib/quotaUpgrade";
import { rendererLogger } from "@/logger";

const log = rendererLogger.child({ scope: "quota-uploads-notice" });

/**
 * The storage API's "account full" refusals, by code or by the i18n key the runtime maps
 * them to, somewhere inside the job's message.
 */
const QUOTA_ERROR_MARKERS = [
  "upload_quota_exceeded",
  "lab.errors.uploadQuotaExceeded",
  "storage_quota_blocked",
  "lab.errors.storageQuotaBlocked",
];

export const isUploadQuotaExceededJobError = (error: string | null | undefined): boolean =>
  typeof error === "string" && QUOTA_ERROR_MARKERS.some((marker) => error.includes(marker));

/**
 * `onRoomChange` tells the Jobs panel whether the account has room again (just upgraded here, or the storage summary
 * is no longer blocked), so a failed upload's one action turns from "Upgrade plan" into "Upload again" (UX-JOBS-03).
 */
export default function QuotaUploadsNotice({ onRoomChange }: { onRoomChange?: (hasRoom: boolean) => void } = {}) {
  const { t } = useTranslation();
  const { token } = useAuth();
  const offerText = usePlanOfferText();
  const quota = useQuotaUpgrade("uploads-notice");
  const [storage, setStorage] = useState<AccountStorageSummary | null>(null);
  const [upgrading, setUpgrading] = useState(false);
  const [upgraded, setUpgraded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    getAccountStorage(token)
      .then((next) => {
        if (!cancelled) setStorage(next);
      })
      .catch((err) => {
        log.warn({ err: err instanceof Error ? err.message : String(err) }, "quota-uploads-notice.storage-fetch-failed");
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const offer = storage
    ? evaluateImportQuota({ items: [], storage, pendingLocalBytes: 0, billingPeriod: loadBillingPeriod() }).nextPlan
    : null;
  const hasRoom = upgraded || (storage !== null && storage.warningLevel !== "blocked");
  useEffect(() => {
    log.info({ hasRoom, upgraded, warningLevel: storage?.warningLevel ?? null }, "quota-uploads-notice.room");
    onRoomChange?.(hasRoom);
  }, [hasRoom, onRoomChange, upgraded, storage?.warningLevel]);

  const handleUpgrade = async () => {
    if (!offer || upgrading) return;
    setUpgrading(true);
    setError(null);
    try {
      setStorage(await quota.upgrade(offer));
      setUpgraded(true);
    } catch (err) {
      setError(quota.failureMessage(err));
    } finally {
      setUpgrading(false);
    }
  };

  return (
    <AmberNotice testId="quota-uploads-notice">
      <span className="block">{t(upgraded ? "ingestion.quota.uploadRefusedUpgraded" : "ingestion.quota.uploadRefused")}</span>
      {!upgraded && offer ? (
        <span className="mt-1 block" data-testid="quota-uploads-notice-offer">
          {t("ingestion.quota.offerNext", { plan: offerText.name(offer), price: offerText.price(offer) })}
        </span>
      ) : null}
      {!upgraded && offer && quota.unavailableMessage ? (
        <span className="mt-1 block" data-testid="quota-uploads-notice-unavailable">
          {quota.unavailableMessage}
        </span>
      ) : null}
      {quota.waiting ? (
        <span className="mt-1 block" data-testid="quota-uploads-notice-payment-waiting">
          {t("account.subscription.paymentWaiting")}{" "}
          <button type="button" className="underline" data-testid="quota-uploads-notice-payment-reopen" onClick={quota.reopen}>
            {t("account.subscription.paymentReopen")}
          </button>{" "}
          <button type="button" className="underline" data-testid="quota-uploads-notice-payment-stop" onClick={quota.stop}>
            {t("account.subscription.paymentStop")}
          </button>
        </span>
      ) : null}
      {error ? (
        <span className="mt-1 block text-destructive" data-testid="quota-uploads-notice-error">
          {error}
        </span>
      ) : null}
      {!upgraded && offer && quota.available ? (
        <Button
          size="sm"
          variant="secondary"
          className="mt-2 h-6 text-[11px]"
          data-testid="quota-uploads-notice-upgrade"
          disabled={upgrading}
          onClick={() => void handleUpgrade()}
        >
          {upgrading ? t("ingestion.quota.upgrading") : t("ingestion.quota.upgrade", { plan: t(`account.plans.${offer.plan}.title`) })}
        </Button>
      ) : null}
    </AmberNotice>
  );
}
