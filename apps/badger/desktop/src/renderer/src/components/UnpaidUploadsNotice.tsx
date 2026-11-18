/**
 * Jobs-sidebar notice explaining why an upload failed once the account is
 * unpaid (#145 step 5): the storage API answers 402 `subscription_unpaid` to
 * every upload. Only mounted when a job failed with that code, so the sidebar
 * stays auth-free otherwise.
 */
import { useTranslation } from "react-i18next";
import { SUBSCRIPTION_UNPAID_CODE } from "@space/shared/subscriptionUnpaid";
import { useAuth } from "@/auth";
import AmberNotice from "@/components/AmberNotice";
import { getUnpaidAccessInfo, unpaidMessage } from "@/lib/unpaidAccess";

/** Runtime job errors carry the tunnel error code somewhere inside their message. */
export const isSubscriptionUnpaidJobError = (error: string | null | undefined): boolean =>
  typeof error === "string" && error.includes(SUBSCRIPTION_UNPAID_CODE);

export default function UnpaidUploadsNotice() {
  const { user } = useAuth();
  const { t, i18n } = useTranslation();
  // The user's stored access may predate the 402; the date is shown when known, never invented.
  const { wipeAt } = getUnpaidAccessInfo(user?.access);
  return <AmberNotice testId="unpaid-uploads-notice">{unpaidMessage(t, "uploadBlocked", wipeAt, i18n.language)}</AmberNotice>;
}
