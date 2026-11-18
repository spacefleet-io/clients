import { UNPAID_WIPE_GRACE_DAYS, type AccountAccess } from "./accountAccess";

/**
 * Client-side view of {@link AccountAccess} (#145 step 5).
 *
 * The API computes `access` when it answers /auth/me, login, GET
 * /account/subscription… The client keeps that object between refreshes (the
 * desktop only calls /auth/me at startup/login), so a paid period can run out
 * while the app is open. `resolveEffectiveAccess` therefore re-evaluates the
 * clock locally — no polling: callers evaluate it at render time and the next
 * /auth/me refresh replaces the stored object.
 */
export type EffectiveAccess = AccountAccess;

const DAY_MS = 24 * 60 * 60 * 1000;

export const resolveEffectiveAccess = (
  access: AccountAccess | null | undefined,
  now: number = Date.now()
): EffectiveAccess | null => {
  if (!access) return null;
  if (access.state !== "paid" || !access.paidUntil) return access;
  const paidUntilMs = Date.parse(access.paidUntil);
  if (Number.isNaN(paidUntilMs) || paidUntilMs > now) return access;
  // A refused renewal being retried (ACCT-PAY-03): still paid until the grace ends.
  const graceMs = access.renewalGraceUntil ? Date.parse(access.renewalGraceUntil) : Number.NaN;
  if (!Number.isNaN(graceMs) && graceMs > now) return access;
  return {
    ...access,
    state: "unpaid",
    qosTier: "free",
    wipeAt: access.wipeAt ?? new Date(paidUntilMs + UNPAID_WIPE_GRACE_DAYS * DAY_MS).toISOString(),
  };
};

/** True when playback/uploads are blocked and only exports (downloads) remain. */
export const isAccessUnpaid = (access: AccountAccess | null | undefined, now: number = Date.now()): boolean =>
  resolveEffectiveAccess(access, now)?.state === "unpaid";

/** Human date ("12 December 2026" / "12 décembre 2026"); falls back to the ISO date part. */
export const formatAccessDate = (iso: string | null | undefined, locale?: string): string => {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
};
