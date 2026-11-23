import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  toast,
} from "@space/ui";
import { AlertTriangle, Download, Loader2 } from "lucide-react";
import { formatLocalizedStorage, formatLocalizedStorageUsage } from "@space/shared/format";
import { mediaSizeLabel } from "@/lib/sizeLabel";
import type { ClientConfig } from "@/lib/config";
import type { MediaDetails } from "@/lib/libraryDb";
import {
  callOfflineDownloadSubmit,
  callOfflineEstimate,
  isOfflineIpcError,
  type OfflineEstimateResult,
} from "@/lib/offlineIpc";
import {
  inScopeFileIds,
  resolveScopeMediaIds,
  type OfflineScope,
} from "@/lib/offlineEstimator";
import { rendererLogger } from "@/logger";

const offlineLog = rendererLogger.child({ scope: "offline-confirm" });

export type OfflineDownloadConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: OfflineScope;
  details: MediaDetails;
  clientConfig: ClientConfig;
  /** Optional callback when submission succeeds. The parent can refresh the
   *  offline-state hydration here. */
  onSubmitted?: (result: { submittedJobIds: string[] }) => void;
};

/**
 * The space a download needs against the space free, ordered as the bytes are (STOR-UNIT-01) and written in the
 * interface language (STOR-UNIT-02); an unknown side is "?".
 */
const neededAndFree = (requiredBytes: number | null | undefined, freeBytes: number | null | undefined, locale: string) => {
  if (requiredBytes == null || freeBytes == null) {
    return {
      required: requiredBytes == null ? "?" : formatLocalizedStorage(requiredBytes, locale),
      free: freeBytes == null ? "?" : formatLocalizedStorage(freeBytes, locale),
    };
  }
  const { used, limit } = formatLocalizedStorageUsage(requiredBytes, freeBytes, locale);
  return { required: used, free: limit };
};

const scopeSubtitleKey = (scope: OfflineScope): string => {
  switch (scope.kind) {
    case "movie":
      return "library.offline.scope.movie";
    case "show":
      return "library.offline.scope.show";
    case "season":
      return "library.offline.scope.season";
    case "episode":
      return "library.offline.scope.episode";
  }
};

const scopeSubtitleValues = (scope: OfflineScope, details: MediaDetails) => {
  if (scope.kind === "movie") return { title: details.title };
  if (scope.kind === "show") return { title: details.title };
  if (scope.kind === "season") {
    return { title: details.title, season: scope.seasonNumber };
  }
  // episode
  const episode = details.episodes.find((ep) => ep.id === scope.episodeId);
  return {
    title: details.title,
    season: scope.seasonNumber,
    episode: scope.episodeNumber,
    episodeTitle: episode?.name ?? "",
  };
};

export default function OfflineDownloadConfirmDialog({
  open,
  onOpenChange,
  scope,
  details,
  clientConfig,
  onSubmitted,
}: OfflineDownloadConfirmDialogProps) {
  const { t, i18n } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [estimate, setEstimate] = useState<OfflineEstimateResult | null>(null);
  const [estimateError, setEstimateError] = useState<string | null>(null);
  // Quality picked in the prompt (OFFL-QUAL-01). Null until the user picks;
  // there is no default download quality. The first estimate (no quality)
  // lists the choices; a pick re-runs it so items, size and the disk check
  // match the picked quality.
  const [quality, setQuality] = useState<string | null>(null);

  // Cache the most recently resolved container so the modal re-renders the
  // skipped-subs warning immediately after the user flips it in Settings
  // (the modal stays open between renders).
  const container = clientConfig.offlineExportFormat ?? "mkv";
  const mediaIds = useMemo(
    () => (open ? resolveScopeMediaIds(details, scope) : []),
    [open, details, scope],
  );
  // For narrow scopes (episode, season) resolve the precise fileIds from the
  // MediaDetails so the runtime restricts the operation to that subset. For
  // parent scopes (movie, show) the mediaIds alone are enough — pass
  // undefined so the runtime keeps its existing all-files behaviour. See the
  // contract precedence note in
  // packages/runtime-contracts/src/badger/offline.ts.
  const fileIds = useMemo<string[] | undefined>(() => {
    if (!open) return undefined;
    if (scope.kind === "episode" || scope.kind === "season") {
      const ids = Array.from(inScopeFileIds(details, scope));
      return ids.length > 0 ? ids : undefined;
    }
    return undefined;
  }, [open, details, scope]);

  // On open: dispatch the estimate command. Cancellation-safe via the
  // `cancelled` flag — if the dialog closes mid-fetch we discard the result.
  useEffect(() => {
    if (!open) {
      setEstimate(null);
      setEstimateError(null);
      setQuality(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setEstimateError(null);
    offlineLog.info(
      {
        scope: scope.kind,
        mediaIds: mediaIds.length,
        fileIds: fileIds?.length ?? null,
        quality,
        container,
      },
      "estimate_dispatch",
    );
    void callOfflineEstimate({
      mediaIds,
      ...(quality ? { quality } : {}),
      container,
      ...(fileIds ? { fileIds } : {}),
    })
      .then((result) => {
        if (cancelled) return;
        if (isOfflineIpcError(result)) {
          setEstimateError(result.message ?? result.errorCode ?? "runtime_unavailable");
          offlineLog.warn(
            { errorCode: result.errorCode, status: result.status, message: result.message },
            "estimate_failed",
          );
          return;
        }
        setEstimate(result);
        offlineLog.info(
          {
            items: result.items.length,
            skipped: result.skipped.length,
            totalBytes: result.totalBytes,
            sufficientSpace: result.sufficientSpace,
            qualityChoices: result.qualityChoices.map((c) => `${c.quality}=${c.totalBytes}`),
            prompt: result.prompt,
          },
          "estimate_ok",
        );
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setEstimateError(message);
        offlineLog.warn({ error: message }, "estimate_threw");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, mediaIds, fileIds, quality, container, scope.kind]);

  const handleClose = (next: boolean) => {
    if (submitting) return;
    onOpenChange(next);
  };

  const submit = async () => {
    if (!estimate || submitting || (estimate.prompt && !quality)) return;
    setSubmitting(true);
    try {
      offlineLog.info(
        {
          scope: scope.kind,
          mediaIds: mediaIds.length,
          fileIds: fileIds?.length ?? null,
          quality,
          container,
        },
        "download_submit_dispatch",
      );
      const result = await callOfflineDownloadSubmit({
        mediaIds,
        ...(quality ? { quality } : {}),
        container,
        skipAlreadyLocal: true,
        ...(fileIds ? { fileIds } : {}),
      });
      if (isOfflineIpcError(result)) {
        toast(
          t("library.offline.modal.submitFailedToast", {
            reason: result.message ?? result.errorCode ?? "",
          }),
        );
        offlineLog.warn(
          { errorCode: result.errorCode, status: result.status },
          "download_submit_ipc_failed",
        );
        return;
      }
      if ("errorCode" in result) {
        // Typed error codes from the runtime.
        const reason =
          result.errorCode === "insufficient_disk_space"
            ? t("library.offline.modal.errors.insufficient_disk_space", neededAndFree(result.requiredBytes, result.freeBytes, i18n.language))
            : result.errorCode === "library_db_not_open"
              ? t("library.offline.modal.errors.library_db_not_open")
              : result.errorCode === "not_authenticated"
                ? t("library.offline.modal.errors.not_authenticated")
                : result.errorCode;
        toast(t("library.offline.modal.submitFailedToast", { reason }));
        offlineLog.warn({ errorCode: result.errorCode }, "download_submit_runtime_error");
        return;
      }
      toast(
        t("library.offline.modal.submittedToast", { count: result.submitted.length }),
      );
      offlineLog.info(
        { submitted: result.submitted.length, skipped: result.skipped.length },
        "download_submit_ok",
      );
      onSubmitted?.({
        submittedJobIds: result.submitted.map((j) => j.jobId),
      });
      onOpenChange(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast(t("library.offline.modal.submitFailedToast", { reason: message }));
      offlineLog.warn({ error: message }, "download_submit_threw");
    } finally {
      setSubmitting(false);
    }
  };

  // Derive display state from the estimate.
  const qualityChoices = estimate?.qualityChoices ?? [];
  const askQuality = estimate?.prompt === true;
  const selectedQuality = estimate?.items[0]?.selectedQuality ?? null;
  const expectedFilenames = useMemo(() => {
    if (!estimate) return [] as string[];
    return estimate.items.map((item) => item.expectedFilename);
  }, [estimate]);
  // The runtime returns the per-item list; we surface the first one and the
  // count of additional ones (since 12 movie episodes would crowd the modal).
  const primaryFilename = expectedFilenames[0] ?? null;
  const extraFilenames = expectedFilenames.length > 1 ? expectedFilenames.length - 1 : 0;

  // Aggregate skipped-subs warning across all items (MP4 mode only).
  const skippedSubsTracks = useMemo(() => {
    if (!estimate) return [] as string[];
    const seen = new Set<string>();
    estimate.items.forEach((item) => {
      item.skippedSubsForContainer.forEach((label) => {
        if (!seen.has(label)) seen.add(label);
      });
    });
    return Array.from(seen);
  }, [estimate]);

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg" data-testid="offline-confirm-dialog">
        <DialogHeader>
          <DialogTitle>{t("library.offline.modal.confirmTitle")}</DialogTitle>
          <DialogDescription>
            {t(scopeSubtitleKey(scope), scopeSubtitleValues(scope, details))}
          </DialogDescription>
        </DialogHeader>

        {!estimate && loading ? (
          <div className="flex items-center gap-2 rounded-md border border-border bg-muted/10 px-3 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("library.offline.modal.estimating")}
          </div>
        ) : estimateError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm" data-testid="offline-confirm-error">
            {t("library.offline.modal.estimateFailedToast", { reason: estimateError })}
          </div>
        ) : estimate ? (
          <div className="space-y-3 text-sm">
            {askQuality ? (
              // Quality prompt (OFFL-QUAL-01): every quality with its size;
              // for a batch, which episodes get another quality.
              <div className="space-y-2" role="radiogroup" aria-label={t("library.offline.modal.qualityPrompt")} data-testid="offline-confirm-quality-choices">
                <div className="text-muted-foreground">{t("library.offline.modal.qualityPrompt")}</div>
                {qualityChoices.map((choice) => (
                  <button
                    key={choice.quality}
                    type="button"
                    role="radio"
                    aria-checked={quality === choice.quality}
                    disabled={submitting}
                    onClick={() => {
                      offlineLog.info({ quality: choice.quality }, "quality_picked");
                      setQuality(choice.quality);
                    }}
                    className={`w-full rounded-lg border px-3 py-2 text-left ${
                      quality === choice.quality ? "border-primary bg-primary/10" : "border-border bg-muted/10 hover:bg-muted/20"
                    }`}
                    data-testid={`offline-confirm-quality-${choice.quality}`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-semibold">{choice.quality}</span>
                      <span className="text-muted-foreground">{mediaSizeLabel(choice.totalBytes, i18n.language)}</span>
                    </div>
                    {choice.fallbacks.map((fallback) => (
                      <div key={fallback.quality} className="text-xs text-muted-foreground">
                        {t("library.offline.modal.qualityFallback", {
                          count: fallback.count,
                          chosen: choice.quality,
                          quality: fallback.quality,
                        })}
                      </div>
                    ))}
                  </button>
                ))}
              </div>
            ) : (
              <div className="flex items-center justify-between rounded-lg border border-border bg-muted/10 px-3 py-2">
                <span className="text-muted-foreground">{t("library.offline.modal.quality")}</span>
                <span className="font-semibold" data-testid="offline-confirm-quality">
                  {selectedQuality ?? "—"}
                </span>
              </div>
            )}
            {!askQuality || quality ? (
              <div className="flex items-center justify-between rounded-lg border border-border bg-muted/10 px-3 py-2">
                <span className="text-muted-foreground">{t("library.offline.modal.size")}</span>
                <span className="font-semibold" data-testid="offline-confirm-size">
                  {mediaSizeLabel(estimate.totalBytes, i18n.language)}
                </span>
              </div>
            ) : null}

            {/* Includes-audio-subs note */}
            <p className="text-xs text-muted-foreground">
              {t("library.offline.modal.includesAudioSubs")}
            </p>

            {/* Filename preview */}
            {primaryFilename ? (
              <div className="rounded-lg border border-border bg-muted/10 px-3 py-2 text-xs">
                <div className="text-muted-foreground">{t("library.offline.modal.expectedFilename")}</div>
                <div className="mt-1 break-all font-mono" data-testid="offline-confirm-filename">
                  {primaryFilename}
                  {extraFilenames > 0 ? (
                    <span className="ml-2 text-muted-foreground">
                      {t("library.offline.modal.expectedFilenamePlusN", { count: extraFilenames })}
                    </span>
                  ) : null}
                </div>
              </div>
            ) : null}

            {/* MP4 skipped-subs warning */}
            {skippedSubsTracks.length > 0 ? (
              <div
                className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs"
                data-testid="offline-confirm-skipped-subs"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                <div>
                  <div className="font-semibold text-amber-200">
                    {t("library.offline.modal.skippedSubsWarning", {
                      tracks: skippedSubsTracks.join(", "),
                    })}
                  </div>
                </div>
              </div>
            ) : null}

            {/* Disk-space warning */}
            {!estimate.sufficientSpace && (!askQuality || quality) ? (
              <div
                className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs"
                data-testid="offline-confirm-disk-warning"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <div className="space-y-0.5">
                  <div className="font-semibold">{t("library.offline.modal.diskWarning")}</div>
                  <div className="text-muted-foreground">
                    {t("library.offline.modal.diskWarningDetail", neededAndFree(estimate.totalBytes, estimate.freeBytesAvailable, i18n.language))}
                  </div>
                </div>
              </div>
            ) : null}

            {/* Skipped items (no compatible quality or no file). */}
            {estimate.skipped.length > 0 ? (
              <div
                className="rounded-md border border-border bg-muted/10 px-3 py-2 text-xs text-muted-foreground"
                data-testid="offline-confirm-skipped-items"
              >
                {t("library.offline.modal.skippedItems", { count: estimate.skipped.length })}
              </div>
            ) : null}
          </div>
        ) : null}

        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => handleClose(false)}
            disabled={submitting}
          >
            {t("library.offline.modal.cancel")}
          </Button>
          <Button
            type="button"
            onClick={() => void submit()}
            disabled={
              !estimate ||
              submitting ||
              loading ||
              estimate.items.length === 0 ||
              (askQuality && !quality) ||
              !estimate.sufficientSpace
            }
            data-testid="offline-confirm-submit"
          >
            {submitting ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t("library.offline.modal.confirm")}
              </span>
            ) : (
              <span className="inline-flex items-center gap-2">
                <Download className="h-4 w-4" />
                {t("library.offline.modal.confirm")}
              </span>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
