/**
 * Unpaid on the computer (UX-NOTICE-08, ACCT-UNPAID-05): a lasting account state, said in two small ways and never
 * with a strip that pushes the page down.
 *
 * - `UnpaidAccessSign`: a compact chip in the top bar's status slot, beside the offline chip (UX-NOTICE-02), on every
 *   route since every route draws the top bar. One word on screen; its accessible label and tooltip carry the whole
 *   notice (downloads open until the wipe date, deleted after). It opens Settings → Account, where the plan panel
 *   explains the state and how to renew: the computer may point to renewing (ACCT-PAY-02 limits the phone and TV).
 * - `useUnpaidHeadsUp`: one heads-up entry in the bell's history (UX-NOTICE-04) per unpaid period, so a person who
 *   missed the chip finds it there. A period is keyed by its `paidUntil`, so dismissing the entry keeps it gone and
 *   a later unpaid period adds a new one.
 *
 * `user.access` comes from the existing `/auth/me` refresh and is re-evaluated against the clock at render; no polling.
 */
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { DesktopStatusChip } from "@space/desktop-shell/components";
import type { NoticeHistory } from "@space/desktop-shell/services/notifications";
import { useAuth } from "@/auth";
import { getUnpaidAccessInfo, unpaidMessage } from "@/lib/unpaidAccess";

export const UNPAID_ACCOUNT_SETTINGS = "/settings?section=account";

/** localStorage key holding the `paidUntil` of the unpaid period whose heads-up entry was already added. */
export const unpaidHeadsUpKey = (userId: string) => `sf.notifications.${userId}.unpaid-heads-up`;

export function UnpaidAccessSign() {
  const { user } = useAuth();
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { unpaid, wipeAt } = getUnpaidAccessInfo(user?.access);
  if (!unpaid) return null;
  return (
    <DesktopStatusChip
      testId="unpaid-access-sign"
      data={{ "data-wipe-at": wipeAt ?? "" }}
      sign={t("account.access.unpaidSign")}
      message={unpaidMessage(t, "unpaidBanner", wipeAt, i18n.language)}
      onClick={() => navigate(UNPAID_ACCOUNT_SETTINGS)}
    />
  );
}

/** Adds the unpaid heads-up to the bell's history once per unpaid period (UX-NOTICE-08). */
export function useUnpaidHeadsUp(history: NoticeHistory | null, userId: string | null) {
  const { user } = useAuth();
  const { t, i18n } = useTranslation();
  const { unpaid, wipeAt } = getUnpaidAccessInfo(user?.access);
  const period = user?.access?.paidUntil ?? "unknown";
  useEffect(() => {
    if (!history || !userId || !unpaid) return;
    const key = unpaidHeadsUpKey(userId);
    if (window.localStorage.getItem(key) === period) return;
    // A lasting state, so the entry is kept; one key per period, so a repeat replaces it (UX-NOTICE-11).
    history.record({
      key: `account-unpaid:${period}`,
      kind: "lasting",
      level: "warning",
      scope: "account",
      title: { key: "account.access.unpaidHeadsUpTitle" },
      message: `${unpaidMessage(t, "unpaidBanner", wipeAt, i18n.language)} ${t("account.access.unpaidBannerHint")}`,
      target: UNPAID_ACCOUNT_SETTINGS,
    });
    window.localStorage.setItem(key, period);
  }, [history, userId, unpaid, period, wipeAt, t, i18n.language]);
}

export default UnpaidAccessSign;
