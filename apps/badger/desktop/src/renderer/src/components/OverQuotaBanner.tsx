/**
 * Over-quota banner (ACCT-OVER-01/04), shown under the top nav. While `user.access.overQuota` runs it says the phase
 * and its date (grace until, frozen until the deletion, deletion running) and offers the ways out: a one-click upgrade
 * (Settings → Account, the plan screen) and the titles the deletion would remove, each with a download button
 * (`OverQuotaTitlesDialog`). Once the server removed titles it says so until dismissed. Auto-scale (ACCT-SCALE-01) is
 * not built, so it is not offered. `GET /account/over-quota` is read when the timeline changes and once per session.
 */
import { Suspense, lazy, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { formatAccessDate } from "@space/shared/effectiveAccess";
import { formatLocalizedStorage } from "@space/shared/format";
import { useAuth } from "@/auth";
import { getAccountOverQuotaTitles, type AccountOverQuotaTitles } from "@/api";
import { rendererLogger } from "@/logger";

const OverQuotaTitlesDialog = lazy(() => import("@/components/OverQuotaTitlesDialog"));

const log = rendererLogger.child({ scope: "over-quota" });
/** Newest `deletedAt` the user dismissed, so the removed-titles notice shows again only for a later removal. */
export const REMOVED_SEEN_KEY = "sf_over_quota_removed_seen";

export function OverQuotaBanner() {
  const { user, token } = useAuth();
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const overQuota = user?.access?.overQuota ?? null;
  const [titles, setTitles] = useState<AccountOverQuotaTitles | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [removedSeen, setRemovedSeen] = useState(() => window.localStorage.getItem(REMOVED_SEEN_KEY));

  const timelineKey = overQuota ? `${overQuota.phase}|${overQuota.deletionAt}|${overQuota.deleting}` : "none";
  useEffect(() => {
    if (!token || !user) return;
    let cancelled = false;
    void (async () => {
      try {
        const next = await getAccountOverQuotaTitles(token);
        log.info({ atRisk: next.atRisk.length, removed: next.removed.length, excessBytes: next.excessBytes }, "over-quota titles");
        if (!cancelled) setTitles(next);
      } catch (error) {
        log.warn({ error: error instanceof Error ? error.message : String(error) }, "over-quota titles unavailable");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, user?.id, timelineKey]);

  const newestRemoved = titles?.removed[0]?.deletedAt ?? null;
  const showRemoved = !overQuota && newestRemoved !== null && newestRemoved !== removedSeen;
  if (!overQuota && !showRemoved) return null;

  const excess = formatLocalizedStorage(titles?.excessBytes ?? 0, i18n.language);
  const message = !overQuota
    ? t("account.overQuota.removedBanner", { count: titles?.removed.length ?? 0 })
    : overQuota.deleting
      ? t("account.overQuota.deletingBanner")
      : overQuota.phase === "grace"
        ? t("account.overQuota.graceBanner", { date: formatAccessDate(overQuota.graceUntil, i18n.language), excess })
        : t("account.overQuota.frozenBanner", { date: formatAccessDate(overQuota.deletionAt, i18n.language), excess });

  return (
    <div
      role="status"
      data-testid="over-quota-banner"
      data-phase={overQuota ? (overQuota.deleting ? "deleting" : overQuota.phase) : "removed"}
      className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-amber-500 px-3 py-1.5 text-xs font-medium text-black"
    >
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span data-testid="over-quota-message">{message}</span>
      {overQuota && (
        <button type="button" className="underline" onClick={() => navigate("/settings?section=account")} data-testid="over-quota-upgrade">
          {t("account.overQuota.upgrade")}
        </button>
      )}
      {titles && (titles.atRisk.length > 0 || titles.removed.length > 0) && (
        <button type="button" className="underline" onClick={() => setDialogOpen(true)} data-testid="over-quota-see-titles">
          {t("account.overQuota.seeTitles")}
        </button>
      )}
      {showRemoved && (
        <button
          type="button"
          className="underline opacity-80"
          onClick={() => {
            window.localStorage.setItem(REMOVED_SEEN_KEY, newestRemoved);
            setRemovedSeen(newestRemoved);
          }}
          data-testid="over-quota-dismiss"
        >
          {t("account.overQuota.dismiss")}
        </button>
      )}
      {dialogOpen && titles && (
        <Suspense fallback={null}>
          <OverQuotaTitlesDialog
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            titles={titles}
            deletionAt={overQuota?.deletionAt ?? null}
            onUpgrade={() => {
              setDialogOpen(false);
              navigate("/settings?section=account");
            }}
          />
        </Suspense>
      )}
    </div>
  );
}

export default OverQuotaBanner;
