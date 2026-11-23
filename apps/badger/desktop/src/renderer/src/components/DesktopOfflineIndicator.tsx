/**
 * Offline on the computer (UX-NOTICE-02, OFFL-PLAY-02): a normal state, said in two small ways and never with a bar.
 *
 * - `DesktopOfflineIndicator`: a compact chip in the top bar, beside the Badger name. It shows while the OS reports no
 *   network, while the library runs on downloaded titles because the server is unreachable, and while sync is paused
 *   on local data. One word on screen; the full meaning is in its accessible label. In the two library cases it is a
 *   button that retries.
 * - `DesktopOfflineNotice`: mounted once at the app level (the top bar remounts on every page change). It says the
 *   state once in a toast from the shared Toaster, which floats over the page and leaves after the standard toast
 *   time, and takes it back when the connection returns. The "when" is the shared `offlineNoticeEdge` rule the phone
 *   uses too.
 *
 * Desktop sibling of packages/mobile-shell/src/components/mobile-offline-indicator.tsx (React Native).
 */
import { useEffect, useRef, useState } from "react";
import { CloudOff, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useOnline } from "@space/desktop-shell/hooks";
import { offlineNoticeEdge } from "@space/shared/offlineNotice";
import { toast } from "@space/ui";
import {
  isOfflineModeFallbackMessage,
  isSyncUnavailableFallbackMessage,
  useLibraryActions,
  useLibraryShell,
} from "@/lib/libraryContext";
import { rendererLogger } from "@/logger";

const offlineLog = rendererLogger.child({ scope: "desktop-offline-notice" });

export type DesktopOfflineSource = "network" | "library" | "sync";

export const OFFLINE_TOAST_ID = "badger-offline";

// The library cases come first: they hold even when the OS thinks it is online (wifi up, server down). @offline-mode
const useOfflineSource = (): { source: DesktopOfflineSource | null; error: string | null } => {
  const online = useOnline();
  const { error } = useLibraryShell();
  if (isOfflineModeFallbackMessage(error)) return { source: "library", error };
  if (isSyncUnavailableFallbackMessage(error)) return { source: "sync", error };
  return { source: online ? null : "network", error };
};

const CHIP_CLASS =
  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 text-xs font-medium text-amber-200";

export function DesktopOfflineIndicator() {
  const { source, error } = useOfflineSource();
  const { reload } = useLibraryActions();
  const { t } = useTranslation();
  // A click flips the chip to "Reconnecting…"; it resets the instant `error` changes (success unmounts the chip, a
  // re-fail renders it idle), so it can never get stuck.
  const [reconnectRequested, setReconnectRequested] = useState(false);
  useEffect(() => {
    setReconnectRequested(false);
  }, [error]);

  if (!source) return null;

  if (source === "network") {
    return (
      <span
        role="status"
        data-testid="desktop-offline-indicator"
        data-offline-source="network"
        aria-label={t("library.offline.indicatorLabel")}
        title={t("library.offline.indicatorLabel")}
        className={CHIP_CLASS}
      >
        <CloudOff className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span aria-hidden="true">{t("library.offline.indicator")}</span>
      </span>
    );
  }

  const label =
    source === "sync"
      ? t("library.offline.syncIndicatorRetryLabel")
      : t("library.offline.indicatorRetryLabel");
  const text =
    source === "sync"
      ? t("library.offline.syncIndicator")
      : t(reconnectRequested ? "library.offline.reconnecting" : "library.offline.indicator");
  const Icon = source === "sync" ? RefreshCw : CloudOff;
  return (
    <button
      type="button"
      data-testid="desktop-offline-indicator"
      data-offline-source={source}
      aria-label={label}
      title={label}
      onClick={() => {
        setReconnectRequested(true);
        reload();
      }}
      className={`${CHIP_CLASS} hover:bg-amber-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span aria-hidden="true">{text}</span>
    </button>
  );
}

const TOAST_KEYS: Record<DesktopOfflineSource, { title: string; body: string }> = {
  network: { title: "library.offline.toastTitle", body: "library.offline.toastBody" },
  library: { title: "library.offline.toastTitle", body: "library.offline.toastBody" },
  sync: { title: "library.offline.syncToastTitle", body: "library.offline.syncToastBody" },
};

export function DesktopOfflineNotice() {
  const { source } = useOfflineSource();
  const { t } = useTranslation();
  // OS-offline and library-offline are one state for the person: switching between them says nothing new.
  const variant = source === "sync" ? "sync" : source ? "offline" : null;
  const lastVariant = useRef<typeof variant>(null);
  const lastSource = useRef<DesktopOfflineSource | null>(null);
  if (source) lastSource.current = source;

  useEffect(() => {
    const edge = offlineNoticeEdge(lastVariant.current, variant);
    lastVariant.current = variant;
    if (!edge) return;
    offlineLog.info(`[desktop-offline-notice] ${edge.kind}${edge.kind === "show" ? ` source=${lastSource.current}` : ""}`);
    toast.dismiss(OFFLINE_TOAST_ID);
    if (edge.kind === "withdraw" || !lastSource.current) return;
    const keys = TOAST_KEYS[lastSource.current];
    toast.warning(t(keys.title), { id: OFFLINE_TOAST_ID, description: t(keys.body) });
  }, [variant, t]);

  return null;
}

export default DesktopOfflineIndicator;
