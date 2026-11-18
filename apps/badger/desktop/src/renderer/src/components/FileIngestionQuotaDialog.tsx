import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Checkbox, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@space/ui";
import { HardDrive } from "lucide-react";
import type { AccountStorageSummary } from "@space/shared/api";
import { formatLocalizedStorage, formatLocalizedStorageUsage, storageUsedPercent } from "@space/shared/format";
import { evaluateImportQuota, type ImportQuotaInput } from "@/lib/importQuota";
import { usePlanOfferText, useQuotaUpgrade } from "@/lib/quotaUpgrade";
import { rendererLogger } from "@/logger";

const log = rendererLogger.child({ scope: "ingest" });

export type QuotaDialogItem = {
  id: string;
  /** "Movie title" or "Show – S01E02", as the user recognises it. */
  label: string;
  bytes: number;
};

type FileIngestionQuotaDialogProps = {
  items: QuotaDialogItem[];
  storage: ImportQuotaInput["storage"];
  pendingLocalBytes: number;
  billingPeriod: ImportQuotaInput["billingPeriod"];
  /** Import these items now (all of them, or the ticked ones of a batch). */
  onContinue: (itemIds: string[], reason: "upgraded" | "current-plan" | "selection", storage?: AccountStorageSummary) => void;
  /** Close without importing anything. */
  onCancel: () => void;
};

/**
 * The import's storage check (spec INGS-QUOTA-01, INGS-QUOTA-02), shown instead of
 * starting an import that would not fit or would leave the account more than 90% full.
 * Three cases: one video that does not fit (upgrade or cancel), several that do not fit
 * (upgrade, or tick the ones to import until they fit), or an import that fits but fills
 * the account (upgrade or carry on). It never offers deleting media.
 */
export default function FileIngestionQuotaDialog({
  items,
  storage,
  pendingLocalBytes,
  billingPeriod,
  onContinue,
  onCancel,
}: FileIngestionQuotaDialogProps) {
  const { t, i18n } = useTranslation();
  const offerText = usePlanOfferText();
  const quota = useQuotaUpgrade("import-dialog");
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [upgrading, setUpgrading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const all = useMemo(
    () => evaluateImportQuota({ items, storage, pendingLocalBytes, billingPeriod }),
    [items, storage, pendingLocalBytes, billingPeriod],
  );
  const selection = useMemo(
    () =>
      evaluateImportQuota({
        items: items.filter((item) => selected.has(item.id)),
        storage,
        pendingLocalBytes,
        billingPeriod,
      }),
    [items, selected, storage, pendingLocalBytes, billingPeriod],
  );
  const highUsage = all.verdict === "high-usage";
  const batch = !highUsage && items.length > 1;
  const offer = highUsage ? all.nextPlan : all.smallestFittingPlan;
  const selectionFits = selected.size > 0 && selection.verdict !== "does-not-fit";
  const mode = highUsage ? "high-usage" : batch ? "batch" : "single";

  const handleUpgrade = async () => {
    if (!offer || upgrading) return;
    setUpgrading(true);
    setError(null);
    try {
      const next = await quota.upgrade(offer);
      log.info({ mode, plan: offer.plan, addonCount: offer.addonCount, items: items.length }, "import-quota.upgraded");
      onContinue(
        items.map((item) => item.id),
        "upgraded",
        next,
      );
    } catch (err) {
      setError(quota.failureMessage(err));
    } finally {
      setUpgrading(false);
    }
  };

  const toggle = (id: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  // Rounded down: 100% only when the import fills the account exactly or more (STOR-UNIT-01).
  const percentAfter = storageUsedPercent(all.usageRatioAfter, 1);
  // What the import needs against the space left, each as one pair, so a refused import never reads as fitting (STOR-UNIT-01),
  // in the interface language (STOR-UNIT-02).
  const allFigures = formatLocalizedStorageUsage(all.neededBytes, all.spaceLeftBytes, i18n.language);
  const selectionFigures = formatLocalizedStorageUsage(selection.neededBytes, all.spaceLeftBytes, i18n.language);

  return (
    <Dialog open onOpenChange={(open) => !open && !upgrading && onCancel()}>
      <DialogContent data-testid="import-quota-dialog" data-mode={mode} className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HardDrive className="h-5 w-5 shrink-0 text-primary" aria-hidden />
            {t(highUsage ? "ingestion.quota.titleHighUsage" : "ingestion.quota.titleDoesNotFit")}
          </DialogTitle>
          <DialogDescription data-testid="import-quota-summary">
            {highUsage
              ? t("ingestion.quota.bodyHighUsage", {
                  left: formatLocalizedStorage(Math.max(0, all.spaceLeftAfterBytes), i18n.language),
                  percent: percentAfter,
                })
              : t("ingestion.quota.bodyDoesNotFit", { needed: allFigures.used, left: allFigures.limit })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          {offer ? (
            <p data-testid="import-quota-offer">
              {t(highUsage ? "ingestion.quota.offerNext" : "ingestion.quota.offerFits", {
                plan: offerText.name(offer),
                price: offerText.price(offer),
              })}
            </p>
          ) : (
            <p data-testid="import-quota-no-plan" className="text-muted-foreground">
              {t(highUsage ? "ingestion.quota.largestPlan" : "ingestion.quota.noPlanFits")}
            </p>
          )}
          {batch ? (
            <div>
              <div className="mb-1 text-xs font-medium">{t("ingestion.quota.chooseLabel")}</div>
              <ul className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-border bg-muted/10 px-3 py-2 text-xs">
                {items.map((item) => (
                  <li key={item.id} className="flex items-center justify-between gap-3">
                    <label className="flex min-w-0 cursor-pointer items-center gap-2">
                      <Checkbox
                        data-testid="import-quota-item"
                        data-item-id={item.id}
                        checked={selected.has(item.id)}
                        disabled={upgrading}
                        onCheckedChange={(checked) => toggle(item.id, checked)}
                      />
                      <span className="truncate" title={item.label}>
                        {item.label}
                      </span>
                    </label>
                    <span className="shrink-0 tabular-nums text-muted-foreground">{formatLocalizedStorage(item.bytes, i18n.language)}</span>
                  </li>
                ))}
              </ul>
              <div
                data-testid="import-quota-selection-total"
                className={`mt-1 text-xs ${selected.size > 0 && !selectionFits ? "text-destructive" : "text-muted-foreground"}`}
              >
                {t("ingestion.quota.selectionTotal", { selected: selectionFigures.used, left: selectionFigures.limit })}
              </div>
            </div>
          ) : null}
          {offer && quota.unavailableMessage ? (
            <p data-testid="import-quota-upgrade-unavailable" className="text-xs text-muted-foreground">
              {quota.unavailableMessage}
            </p>
          ) : null}
          {quota.waiting ? (
            <div data-testid="import-quota-payment-waiting" className="space-y-2 text-xs">
              <p>{t("account.subscription.paymentWaiting")}</p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" data-testid="import-quota-payment-reopen" onClick={quota.reopen}>
                  {t("account.subscription.paymentReopen")}
                </Button>
                <Button size="sm" variant="outline" data-testid="import-quota-payment-stop" onClick={quota.stop}>
                  {t("account.subscription.paymentStop")}
                </Button>
              </div>
            </div>
          ) : null}
          {error ? (
            <p role="alert" data-testid="import-quota-error" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter className="gap-2 sm:justify-end">
          {highUsage ? (
            <Button
              variant="outline"
              data-testid="import-quota-continue"
              disabled={upgrading}
              onClick={() => onContinue(items.map((item) => item.id), "current-plan")}
            >
              {t("ingestion.quota.continueCurrentPlan")}
            </Button>
          ) : (
            <Button variant="outline" data-testid="import-quota-cancel" disabled={upgrading} onClick={onCancel}>
              {t("ingestion.quota.cancel")}
            </Button>
          )}
          {batch ? (
            <Button
              variant="outline"
              data-testid="import-quota-import-selected"
              disabled={upgrading || !selectionFits}
              onClick={() => onContinue(items.filter((item) => selected.has(item.id)).map((item) => item.id), "selection")}
            >
              {t("ingestion.quota.importSelected", { count: selected.size })}
            </Button>
          ) : null}
          {offer && quota.available ? (
            <Button data-testid="import-quota-upgrade" disabled={upgrading} onClick={() => void handleUpgrade()}>
              {upgrading
                ? t("ingestion.quota.upgrading")
                : t("ingestion.quota.upgrade", { plan: t(`account.plans.${offer.plan}.title`) })}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
