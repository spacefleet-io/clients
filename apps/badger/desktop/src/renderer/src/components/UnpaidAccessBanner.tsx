/**
 * Banner shown in TopNav while the account is unpaid (#145 step 5): the
 * subscription ended, files can still be downloaded until the wipe date, and
 * they're deleted after. Renders nothing for free/paid accounts. No polling —
 * `user.access` is refreshed by the existing /auth/me call.
 */
import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/auth";
import { getUnpaidAccessInfo, unpaidMessage } from "@/lib/unpaidAccess";

export function UnpaidAccessBanner() {
  const { user } = useAuth();
  const { t, i18n } = useTranslation();
  const { unpaid, wipeAt } = getUnpaidAccessInfo(user?.access);
  if (!unpaid) return null;
  return (
    <div
      role="status"
      data-testid="unpaid-access-banner"
      data-wipe-at={wipeAt ?? ""}
      className="flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 bg-amber-500 px-3 py-1.5 text-xs font-medium text-black"
    >
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{unpaidMessage(t, "unpaidBanner", wipeAt, i18n.language)}</span>
      <span className="opacity-80">{t("account.access.unpaidBannerHint")}</span>
    </div>
  );
}

export default UnpaidAccessBanner;
