import { useTranslation } from "react-i18next";
import { Download, DownloadCloud, Slash } from "lucide-react";

/**
 * "Remove from local storage" glyph — a download icon with a diagonal slash
 * over it ("un-download"). Deliberately NOT a trash/bin: removing the offline
 * copy keeps the title in the library (local + cloud), and a bin icon wrongly
 * implies a full delete. Sized by the parent via `className` (e.g. "h-4 w-4").
 */
export function RemoveOfflineIcon({ className }: { className?: string }) {
  return (
    <span
      className={["relative inline-flex shrink-0", className].filter(Boolean).join(" ")}
      aria-hidden="true"
    >
      <Download className="h-full w-full" />
      <Slash className="absolute inset-0 h-full w-full" />
    </span>
  );
}

/**
 * Offline-availability indicator. Used in two places:
 *  - The media modal header (and per-episode rows) to show "Saved offline"
 *    or "X / Y episodes saved offline".
 *  - Dashboard / library tile corner overlays to surface the local state
 *    at a glance.
 *
 * Phase 3 of the offline-mode feature (renderer UI). The badge is presentation
 * only — the count math + state resolution live in `lib/offlineEstimator.ts`
 * and the IPC plumbing lives in `lib/offlineIpc.ts`.
 */
export type OfflineBadgeProps = {
  /**
   * "full" — every applicable item is saved offline (movie or all episodes).
   * "partial" — at least one but not all items are saved (only meaningful for
   * shows / seasons / TV mediaIds).
   */
  state: "full" | "partial";
  /** "sm" for tile overlays, "md" for the modal header. Default "sm". */
  size?: "sm" | "md";
  /**
   * Optional N / total label. Useful for "12 / 40 episodes offline" — when
   * supplied the badge renders the count text next to the icon. Omitted for
   * tile overlays where we just want a glance-readable dot.
   */
  count?: { local: number; total: number };
  /**
   * When true, the badge renders as a single tiny icon-only chip suitable for
   * stacking next to other inline labels (e.g. inside an episode row). Default
   * false (renders as a pill with text when count is supplied).
   */
  inline?: boolean;
};

export default function OfflineBadge({ state, size = "sm", count, inline = false }: OfflineBadgeProps) {
  const { t } = useTranslation();
  const Icon = state === "full" ? Download : DownloadCloud;
  const sizeClasses =
    size === "md"
      ? "h-3.5 w-3.5"
      : "h-3 w-3";
  const padding =
    size === "md"
      ? "px-2.5 py-1 text-[11px]"
      : "px-2 py-0.5 text-[10px]";
  // Full = solid primary; partial = primary outline. Same color family so
  // they read as "the offline feature" wherever they appear.
  const colorClasses =
    state === "full"
      ? "bg-primary text-primary-foreground"
      : "border border-primary/60 bg-primary/10 text-primary";

  // Inline mode = icon-only tiny chip for episode rows.
  if (inline) {
    return (
      <span
        className={[
          "inline-flex items-center gap-1 rounded-full",
          padding,
          colorClasses,
        ].join(" ")}
        aria-label={state === "full"
          ? t("library.offline.badge.savedOffline")
          : t("library.offline.badge.partialOffline")}
        title={state === "full"
          ? t("library.offline.badge.savedOffline")
          : t("library.offline.badge.partialOffline")}
        data-testid="offline-badge"
        data-state={state}
      >
        <Icon className={sizeClasses} aria-hidden="true" />
      </span>
    );
  }

  const label = count
    ? t("library.offline.badge.headerLocalShowSummary", {
        local: count.local,
        total: count.total,
      })
    : state === "full"
      ? t("library.offline.badge.savedOffline")
      : t("library.offline.badge.partialOffline");

  return (
    <span
      className={[
        "inline-flex items-center gap-1.5 rounded-full font-semibold",
        padding,
        colorClasses,
      ].join(" ")}
      data-testid="offline-badge"
      data-state={state}
    >
      <Icon className={sizeClasses} aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}
