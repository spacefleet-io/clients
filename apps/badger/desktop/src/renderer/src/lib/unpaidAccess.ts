/**
 * Unpaid-account presentation (#145 step 5). Once the paid period ended the
 * account is "unpaid": playback and uploads are refused (402
 * `subscription_unpaid`), downloads stay open until the wipe date.
 *
 * No polling: the access object comes from the existing /auth/me refresh and is
 * re-evaluated against the clock at render time (`resolveEffectiveAccess`).
 */
import type { TFunction } from "i18next";
import { formatAccessDate, resolveEffectiveAccess } from "@space/shared/effectiveAccess";
import type { AccountAccess } from "@space/shared/accountAccess";

export type UnpaidMessageKind = "unpaidBanner" | "playbackBlocked" | "uploadBlocked";

export type UnpaidAccessInfo = { unpaid: boolean; wipeAt: string | null };

export const getUnpaidAccessInfo = (
  access: AccountAccess | null | undefined,
  now: number = Date.now()
): UnpaidAccessInfo => {
  const effective = resolveEffectiveAccess(access, now);
  return effective?.state === "unpaid"
    ? { unpaid: true, wipeAt: effective.wipeAt }
    : { unpaid: false, wipeAt: null };
};

/** Plain-language message with the wipe date when known ("until 12 December 2026"). */
export const unpaidMessage = (
  t: TFunction,
  kind: UnpaidMessageKind,
  wipeAt: string | null | undefined,
  locale?: string
): string => {
  const date = formatAccessDate(wipeAt, locale);
  return date ? t(`account.access.${kind}`, { date }) : t(`account.access.${kind}NoDate`);
};
