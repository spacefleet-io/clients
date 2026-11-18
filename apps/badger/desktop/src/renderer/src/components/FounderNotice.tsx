/**
 * WAIT-FOUND-04 in Badger: the founder status read with the session token (at start, after a sign-in, when the window
 * comes back), the one-time "Founder ticket recognised" banner under the top bar, and the account settings badge.
 */
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { getFounderStatus, markFounderNoticeSeen } from "@space/shared/api";
import { FounderBadge, FounderBanner, useFounderStatus, type FounderStatusState } from "@space/ui/founder";
import { useAuth } from "@/auth";

export function useBadgerFounderStatus(): FounderStatusState {
  const { token, user } = useAuth();
  const userId = user?.id ?? null;
  const source = useMemo(
    () =>
      token && userId
        ? {
            key: token,
            getStatus: () => getFounderStatus(token),
            markSeen: async () => {
              await markFounderNoticeSeen(token);
            },
          }
        : null,
    [token, userId],
  );
  return useFounderStatus(source);
}

export function FounderNotice() {
  const { i18n } = useTranslation();
  const founder = useBadgerFounderStatus();
  return <FounderBanner language={i18n.language} status={founder.status} onDismiss={founder.dismiss} className="mx-4 mt-3" />;
}

export function FounderSettingsBadge() {
  const { i18n } = useTranslation();
  const founder = useBadgerFounderStatus();
  return <FounderBadge language={i18n.language} status={founder.status} />;
}
