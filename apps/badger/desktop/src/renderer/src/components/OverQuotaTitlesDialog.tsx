/**
 * The titles an over-quota account would lose (ACCT-OVER-01) and those already removed (ACCT-OVER-04), named from the
 * library (`nameOverQuotaPlacements`). Each title at risk has a download button: the app's own "Save offline"
 * (`OfflineDownloadConfirmDialog`), which keeps a copy on this computer. Deleting titles in the library is the other
 * way out; the upgrade goes to the plan screen.
 */
import { Suspense, lazy, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@space/ui";
import { Download } from "lucide-react";
import { formatAccessDate } from "@space/shared/effectiveAccess";
import { formatLocalizedStorage } from "@space/shared/format";
import type { AccountOverQuotaTitles } from "@/api";
import { useLibraryActions, useLibraryData } from "@/lib/libraryContext";
import { useClientConfig } from "@/lib/useClientConfig";
import type { OfflineScope } from "@/lib/offlineEstimator";
import { nameOverQuotaPlacements, type OverQuotaTitle } from "@space/shared/overQuotaTitles";
import type { MediaDetails } from "@/lib/libraryDb";

const OfflineDownloadConfirmDialog = lazy(() => import("@/components/OfflineDownloadConfirmDialog"));

type AtRisk = AccountOverQuotaTitles["atRisk"][number];
type Removed = AccountOverQuotaTitles["removed"][number];

export type OverQuotaTitlesDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  titles: AccountOverQuotaTitles;
  /** When the server deletes the titles at risk; null once no timeline runs. */
  deletionAt: string | null;
  onUpgrade: () => void;
};

export default function OverQuotaTitlesDialog({ open, onOpenChange, titles, deletionAt, onUpgrade }: OverQuotaTitlesDialogProps) {
  const { t, i18n } = useTranslation();
  const { media } = useLibraryData();
  const { fetchMediaDetails } = useLibraryActions();
  const clientConfig = useClientConfig();
  const [atRisk, setAtRisk] = useState<Array<OverQuotaTitle<AtRisk>> | null>(null);
  const [removed, setRemoved] = useState<Array<OverQuotaTitle<Removed>> | null>(null);
  const [download, setDownload] = useState<{ details: MediaDetails; scope: OfflineScope } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const mediaIds = media.map((row) => row.id);
    void (async () => {
      const [named, gone] = await Promise.all([
        nameOverQuotaPlacements(titles.atRisk, mediaIds, fetchMediaDetails),
        nameOverQuotaPlacements(titles.removed, mediaIds, fetchMediaDetails),
      ]);
      if (cancelled) return;
      setAtRisk(named);
      setRemoved(gone);
    })();
    return () => {
      cancelled = true;
    };
  }, [titles, media, fetchMediaDetails]);

  const label = (item: OverQuotaTitle) => {
    if (!item.details) return t("account.overQuota.unknownTitle");
    if (!item.episode) return item.details.title;
    return t("account.overQuota.episodeLabel", {
      title: item.details.title,
      season: item.episode.seasonNumber,
      episode: item.episode.episodeNumber,
    });
  };
  const scopeOf = (item: OverQuotaTitle): OfflineScope =>
    item.episode
      ? { kind: "episode", episodeId: item.episode.id, seasonNumber: item.episode.seasonNumber, episodeNumber: item.episode.episodeNumber }
      : { kind: "movie" };
  const deletionDate = formatAccessDate(deletionAt, i18n.language);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg" data-testid="over-quota-dialog">
          <DialogHeader>
            <DialogTitle>{t("account.overQuota.dialogTitle")}</DialogTitle>
            <DialogDescription>{t("account.overQuota.options")}</DialogDescription>
          </DialogHeader>
          {titles.atRisk.length > 0 && (
            <Button size="sm" onClick={onUpgrade} data-testid="over-quota-dialog-upgrade">
              {t("account.overQuota.upgrade")}
            </Button>
          )}
          {!atRisk || !removed ? (
            <p className="text-sm text-muted-foreground" data-testid="over-quota-loading">
              {t("account.overQuota.loading")}
            </p>
          ) : (
            <div className="space-y-4 text-sm">
              {atRisk.length > 0 && (
                <section className="space-y-2" data-testid="over-quota-at-risk">
                  <h3 className="font-medium">
                    {deletionDate ? t("account.overQuota.atRiskTitle", { date: deletionDate }) : t("account.overQuota.atRiskTitleNoDate")}
                  </h3>
                  <p className="text-xs text-muted-foreground">{t("account.overQuota.atRiskHint")}</p>
                  <ul className="space-y-1">
                    {atRisk.map((item) => (
                      <li key={item.placementId} className="flex items-center gap-2" data-testid={`over-quota-at-risk-${item.placementId}`}>
                        <span className="min-w-0 flex-1 truncate">{label(item)}</span>
                        <span className="text-xs text-muted-foreground">{formatLocalizedStorage(item.bytes, i18n.language)}</span>
                        {item.details && (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => setDownload({ details: item.details!, scope: scopeOf(item) })}
                            data-testid={`over-quota-download-${item.placementId}`}
                          >
                            <Download className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                            {t("account.overQuota.download")}
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                  {titles.remainingOverBytes > 0 && (
                    <p className="text-xs text-muted-foreground" data-testid="over-quota-remaining">
                      {t("account.overQuota.remainingOver", { excess: formatLocalizedStorage(titles.remainingOverBytes, i18n.language) })}
                    </p>
                  )}
                </section>
              )}
              {removed.length > 0 && (
                <section className="space-y-2" data-testid="over-quota-removed">
                  <h3 className="font-medium">{t("account.overQuota.removedTitle")}</h3>
                  <ul className="space-y-1">
                    {removed.map((item) => (
                      <li key={item.placementId} className="flex items-center gap-2" data-testid={`over-quota-removed-${item.placementId}`}>
                        <span className="min-w-0 flex-1 truncate">{label(item)}</span>
                        <span className="text-xs text-muted-foreground">
                          {t("account.overQuota.removedOn", { date: formatAccessDate(item.deletedAt, i18n.language) })}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
      {download && (
        <Suspense fallback={null}>
          <OfflineDownloadConfirmDialog
            open
            onOpenChange={(next) => !next && setDownload(null)}
            scope={download.scope}
            details={download.details}
            clientConfig={clientConfig}
          />
        </Suspense>
      )}
    </>
  );
}
