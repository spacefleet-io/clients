/**
 * Unpaid-account presentation for the phone and TV apps, Badger and Parrot (ACCT-UNPAID-03). Once the paid period
 * ended the account is "unpaid": playback and uploads are refused (gateway 402 `subscription_unpaid`) until the wipe
 * date. One account, one billing rule: both apps say the same thing.
 *
 * The phone and TV only inform (ACCT-PAY-02): no link, button or instruction to pay. Mirrors the desktop helper
 * (`apps/badger/desktop/src/renderer/src/lib/unpaidAccess.ts`). No polling: the access object comes from the app's
 * last `GET /auth/me` answer and is re-evaluated against the clock at render time.
 */
import type { AccountAccess } from "@space/shared/accountAccess";
import { formatAccessDate, resolveEffectiveAccess } from "@space/shared/effectiveAccess";

type Translate = (key: string, options?: Record<string, unknown>) => string;

export type UnpaidMessageKind = "unpaidBanner" | "playbackBlocked";

export type UnpaidAccessInfo = { unpaid: boolean; wipeAt: string | null };

const MESSAGE_KEYS: Record<UnpaidMessageKind, { dated: string; undated: string }> = {
  unpaidBanner: {
    dated: "account.access.unpaidBanner",
    undated: "account.access.unpaidBannerNoDate",
  },
  playbackBlocked: {
    dated: "account.access.playbackBlocked",
    undated: "account.access.playbackBlockedNoDate",
  },
};

export const getUnpaidAccessInfo = (access: AccountAccess | null | undefined, now: number = Date.now()): UnpaidAccessInfo => {
  const effective = resolveEffectiveAccess(access, now);
  return effective?.state === "unpaid" ? { unpaid: true, wipeAt: effective.wipeAt } : { unpaid: false, wipeAt: null };
};

/** Plain-language message with the wipe date when known ("... on 12 December 2026"). */
export const unpaidMessage = (t: Translate, kind: UnpaidMessageKind, wipeAt: string | null | undefined, locale?: string): string => {
  const date = formatAccessDate(wipeAt, locale);
  const keys = MESSAGE_KEYS[kind];
  return date ? t(keys.dated, { date }) : t(keys.undated);
};

/**
 * Player failure codes that only say "something went wrong opening or running the stream". For an unpaid
 * account the gateway refuses every playback request with 402 `subscription_unpaid`, but the native player only
 * reports a generic open failure, so these codes are replaced by the unpaid message. Codes that name another
 * cause (saturated silo, missing key, title gone, no video in the title) keep their own text.
 */
const GENERIC_FAILURE_CODES: Record<string, true> = {
  unavailable: true,
  openFailed: true,
  startTimeout: true,
  stoppedUnexpectedly: true,
  gatewayUnavailable: true,
  startFailed: true,
  loadFailed: true,
};

export const isGenericPlayerFailure = (code: string): boolean => GENERIC_FAILURE_CODES[code] === true;

/**
 * The text the player error overlay shows for failure `code`: the unpaid message when that is the real cause.
 * A downloaded title plays from disk and never reaches the gateway's 402, so it keeps its own cause (ACCT-UNPAID-02).
 */
export const playerFailureMessage = (
  t: Translate,
  code: string,
  access: AccountAccess | null | undefined,
  locale?: string,
  now: number = Date.now(),
  opts: { offline?: boolean } = {},
): string => {
  const info = getUnpaidAccessInfo(access, now);
  if (info.unpaid && !opts.offline && isGenericPlayerFailure(code)) return unpaidMessage(t, "playbackBlocked", info.wipeAt, locale);
  return t(`player.error.${code}`);
};
