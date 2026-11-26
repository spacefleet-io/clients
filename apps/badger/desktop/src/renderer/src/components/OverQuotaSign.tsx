/**
 * Over storage (ACCT-OVER-01/04), a small lasting chip in the top bar's status slot beside the unpaid sign
 * (UX-NOTICE-08), never a strip that pushes the page down. While `user.access.overQuota` runs, the chip's accessible
 * label and tooltip say the phase and its date (grace until, frozen until the deletion, deletion running); a click
 * opens the titles the deletion would remove, each with a download button, and the upgrade (`OverQuotaTitlesDialog`),
 * or the plan screen (Settings → Account) when there is no title to name. Once the server removed titles the chip
 * says so, opens the removed titles, and carries a dismiss. Auto-scale (ACCT-SCALE-01) is not built, so it is not
 * offered. `GET /account/over-quota` is read when the timeline changes and once per session.
 */
import { Suspense, lazy, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { DesktopStatusChip } from "@space/desktop-shell/components";
import { formatAccessDate } from "@space/shared/effectiveAccess";
import { formatLocalizedStorage } from "@space/shared/format";
import { useAuth } from "@/auth";
import { getAccountOverQuotaTitles, type AccountOverQuotaTitles } from "@/api";
import { rendererLogger } from "@/logger";

const OverQuotaTitlesDialog = lazy(() => import("@/components/OverQuotaTitlesDialog"));

const log = rendererLogger.child({ scope: "over-quota" });
/** Newest `deletedAt` the user dismissed, so the removed-titles notice shows again only for a later removal. */
export const REMOVED_SEEN_KEY = "sf_over_quota_removed_seen";

export function OverQuotaSign() {
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
  const hasTitles = titles !== null && (titles.atRisk.length > 0 || titles.removed.length > 0);

  return (
    <>
      <DesktopStatusChip
        testId="over-quota-sign"
        data={{ "data-phase": overQuota ? (overQuota.deleting ? "deleting" : overQuota.phase) : "removed" }}
        sign={t(overQuota ? "account.overQuota.sign" : "account.overQuota.removedSign")}
        message={message}
        onClick={() => (hasTitles ? setDialogOpen(true) : navigate("/settings?section=account"))}
        trailing={
          showRemoved ? (
            <button
              type="button"
              aria-label={t("account.overQuota.dismiss")}
              title={t("account.overQuota.dismiss")}
              className="inline-flex h-7 w-7 items-center justify-center rounded-full text-amber-200 hover:bg-amber-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
              onClick={() => {
                window.localStorage.setItem(REMOVED_SEEN_KEY, newestRemoved);
                setRemovedSeen(newestRemoved);
              }}
              data-testid="over-quota-dismiss"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          ) : null
        }
      />
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
    </>
  );
}

export default OverQuotaSign;
