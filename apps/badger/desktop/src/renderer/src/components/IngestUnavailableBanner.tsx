/**
 * Inline banner shown whenever the runtime engine v2 (ingest backend)
 * is not ready — disabled, boot-failed, IPC missing, or WS closed.
 *
 * The banner is dismissable but persistent across re-renders until the
 * caller's runtimeError clears (the hook's 5s health probe will clear
 * runtimeError automatically once /runtime/jobs/v2/list returns 200).
 *
 * Plan reference: video-ingestion-is-buggy-effervescent-teapot.md task #7
 * (loud-fail rule).
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, X } from "lucide-react";
import type { RuntimeIngestError } from "@/lib/runtimeIngestJobs";

const FALLBACK_MESSAGE =
  "Ingest unavailable — runtime engine v2 not ready. Restart the desktop, or run 'bun run dev:core:full' to bring up a fresh stack.";

const ENGINE_DOWN_CODES = new Set([
  "engine_v2_disabled",
  "engine_v2_boot_failed",
  "engine_v2_not_ready",
  "not_enabled",
  "runtime_jobs_ipc_unavailable",
  "runtime_jobs_unreachable",
  "runtime_jobs_ws_closed",
]);

const formatMessage = (err: RuntimeIngestError): string => {
  if (ENGINE_DOWN_CODES.has(err.errorCode)) return FALLBACK_MESSAGE;
  if (err.message && err.message.length > 0) return err.message;
  return FALLBACK_MESSAGE;
};

export type IngestUnavailableBannerProps = {
  runtimeError: RuntimeIngestError | null;
  className?: string;
};

export default function IngestUnavailableBanner({
  runtimeError,
  className,
}: IngestUnavailableBannerProps) {
  const { t } = useTranslation();
  // Dismissal is keyed to the specific error signature (code+status) so a
  // dismissed banner re-appears if a *different* error occurs, but stays
  // dismissed for the same one until health is restored.
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const lastErrorKeyRef = useRef<string | null>(null);

  const errorKey = runtimeError
    ? `${runtimeError.errorCode}:${runtimeError.status}`
    : null;

  useEffect(() => {
    // When runtimeError clears (health restored), reset dismissal so a
    // future failure shows the banner again.
    if (!runtimeError) {
      setDismissedKey(null);
      lastErrorKeyRef.current = null;
      return;
    }
    lastErrorKeyRef.current = errorKey;
  }, [runtimeError, errorKey]);

  if (!runtimeError) return null;
  if (dismissedKey && dismissedKey === errorKey) return null;

  return (
    <div
      role="alert"
      data-testid="ingest-unavailable-banner"
      className={
        "flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive" +
        (className ? ` ${className}` : "")
      }
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="flex-1 leading-snug">
        <div className="font-medium">{t("ingestion.ui.unavailableTitle")}</div>
        <div className="text-xs opacity-90">{formatMessage(runtimeError)}</div>
        {runtimeError.errorCode &&
          !ENGINE_DOWN_CODES.has(runtimeError.errorCode) && (
            <div className="mt-1 font-mono text-[10px] opacity-70">
              {t("ingestion.ui.unavailableCode", { code: runtimeError.errorCode })}
              {runtimeError.status ? ` (HTTP ${runtimeError.status})` : ""}
            </div>
          )}
      </div>
      <button
        type="button"
        aria-label={t("ingestion.ui.unavailableDismiss")}
        data-testid="ingest-unavailable-banner-dismiss"
        onClick={() => setDismissedKey(errorKey)}
        className="shrink-0 rounded p-0.5 opacity-70 transition-opacity hover:opacity-100"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
