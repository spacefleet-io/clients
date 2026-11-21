import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Select,
  toast,
} from "@space/ui";
import { AlertTriangle, FolderDown } from "lucide-react";
import type { BadgerExportEstimateResult } from "@space/runtime-contracts/badger/export";
import { formatLocalizedStorage } from "@space/shared/format";
import { useClientSettings } from "@/lib/settings/useClientSettings";
import { callExportEstimate, callExportSubmit, isExportIpcError, pickExportFolder } from "@/lib/exportIpc";
import { exportErrorMessage, exportOutcomeFromResult, exportOutcomeToast } from "@/lib/exportFlow";
import { rendererLogger } from "@/logger";
import { SettingPanel, SettingRow } from "../kit";

const exportLog = rendererLogger.child({ scope: "export-everything" });

type PendingExport = { destDir: string; estimate: BadgerExportEstimateResult };

/**
 * Downloads: "Download everything" (ACCT-EXPORT-01) saves the whole library as plain files in a folder the user picks
 * (Movies/… and Shows/<Show>/Season NN/…), at the highest stored quality. The file format (MKV/MP4) is the one advanced
 * option, folded under "More options".
 */
export default function DownloadsSection() {
  const { t, i18n } = useTranslation();
  const { config, updateSetting } = useClientSettings();
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingExport | null>(null);
  const container = config.offlineExportFormat ?? "mkv";

  const startExportEverything = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const destDir = await pickExportFolder();
      exportLog.info({ picked: destDir !== null, container }, "export_everything_folder_picked");
      if (!destDir) return;
      const estimate = await callExportEstimate({ destDir, container });
      if (isExportIpcError(estimate)) {
        toast(exportErrorMessage(t, estimate, i18n.language));
        return;
      }
      exportLog.info(
        { count: estimate.count, totalBytes: estimate.totalBytes, free: estimate.freeBytesAvailable, sufficient: estimate.sufficientSpace },
        "export_everything_estimated",
      );
      if (estimate.count === 0) {
        toast(t("library.export.errors.nothing_to_export"));
        return;
      }
      setPending({ destDir, estimate });
    } catch (err) {
      exportLog.warn({ error: String(err) }, "export_everything_estimate_failed");
      toast(exportErrorMessage(t, { message: err instanceof Error ? err.message : String(err) }, i18n.language));
    } finally {
      setBusy(false);
    }
  };

  const confirmExportEverything = async () => {
    if (!pending || busy) return;
    setBusy(true);
    try {
      const result = await callExportSubmit({ destDir: pending.destDir, container });
      const outcome = exportOutcomeFromResult(t, result, pending.destDir, i18n.language);
      exportLog.info({ outcome: outcome.kind }, "export_everything_submitted");
      toast(exportOutcomeToast(t, outcome));
      if (outcome.kind === "submitted") setPending(null);
    } catch (err) {
      exportLog.warn({ error: String(err) }, "export_everything_submit_failed");
      toast(exportErrorMessage(t, { message: err instanceof Error ? err.message : String(err) }, i18n.language));
    } finally {
      setBusy(false);
    }
  };

  const estimate = pending?.estimate;

  return (
    <div className="space-y-4">
      <SettingPanel>
        <SettingRow
          className="p-0"
          title={t("settings.exportAll.title")}
          description={t("settings.exportAll.help")}
          control={
            <Button
              type="button"
              variant="secondary"
              data-testid="settings-export-everything"
              pending={busy && !pending}
              disabled={busy}
              onClick={() => void startExportEverything()}
            >
              <FolderDown className="mr-2 h-4 w-4" />
              {t("settings.exportAll.button")}
            </Button>
          }
        />
        <details className="mt-4" data-testid="settings-downloads-more-options">
          <summary className="cursor-pointer text-sm text-muted-foreground">{t("settings.exportAll.moreOptions")}</summary>
          <div className="mt-3 space-y-2">
            <label htmlFor="offlineExportFormat" className="text-sm font-semibold">
              {t("settings.offlineExportFormat.label")}
            </label>
            <p className="text-xs text-muted-foreground">{t("settings.offlineExportFormat.help")}</p>
            <Select
              id="offlineExportFormat"
              data-testid="settings-offline-export-format"
              value={config.offlineExportFormat}
              onChange={(e) =>
                updateSetting("offlineExportFormat", (e.target.value === "mp4" ? "mp4" : "mkv") as "mkv" | "mp4")
              }
            >
              <option value="mkv">{t("settings.offlineExportFormat.mkv")}</option>
              <option value="mp4">{t("settings.offlineExportFormat.mp4")}</option>
            </Select>
            {config.offlineExportFormat === "mp4" ? (
              <div className="mt-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                {t("settings.offlineExportFormat.mp4Warning")}
              </div>
            ) : null}
          </div>
        </details>
      </SettingPanel>

      <Dialog open={pending !== null} onOpenChange={(open) => (open ? undefined : setPending(null))}>
        <DialogContent className="max-w-lg" data-testid="export-everything-confirm">
          <DialogHeader>
            <DialogTitle>{t("settings.exportAll.confirmTitle")}</DialogTitle>
            <DialogDescription>
              {estimate
                ? t("settings.exportAll.confirmBody", {
                    count: estimate.count,
                    size: formatLocalizedStorage(estimate.totalBytes, i18n.language),
                    folder: pending?.destDir ?? "",
                  })
                : null}
            </DialogDescription>
          </DialogHeader>
          {estimate && !estimate.sufficientSpace ? (
            <div
              className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
              data-testid="export-everything-disk-warning"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
              {t("library.export.errors.insufficient_disk_space", {
                required: formatLocalizedStorage(estimate.totalBytes, i18n.language),
                free: formatLocalizedStorage(estimate.freeBytesAvailable, i18n.language),
              })}
            </div>
          ) : null}
          <DialogFooter className="gap-2">
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setPending(null)}>
              {t("settings.exportAll.cancel")}
            </Button>
            <Button
              type="button"
              data-testid="export-everything-confirm-button"
              pending={busy}
              disabled={busy || !estimate?.sufficientSpace}
              onClick={() => void confirmExportEverything()}
            >
              {t("settings.exportAll.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
