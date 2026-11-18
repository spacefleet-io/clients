/**
 * Account access state (#145 step 5), computed once by the API
 * (`computeAccountAccess`) and consumed by every client and the storage
 * gateway.
 *
 * - `free`: the free plan (20 GB, no end date). Never "unpaid"; deleted only
 *   after 60 days without any signed-in activity (`FREE_INACTIVITY_DELETE_DAYS`,
 *   enforced by the server).
 * - `paid`: a non-free plan whose paid period has not ended yet.
 * - `unpaid`: a non-free plan whose period ended without renewal. No playback,
 *   no uploads; own files stay downloadable (export) at free QoS until `wipeAt`.
 */
export type AccessState = "free" | "paid" | "unpaid";

export type BillingPeriod = "monthly" | "annual";

export type AccountAccess = {
  state: AccessState;
  /** End of the current paid period (ISO 8601); null on the free plan. */
  paidUntil: string | null;
  billingPeriod: BillingPeriod | null;
  /** When the account area is destroyed (ISO 8601); only set while `unpaid`. */
  wipeAt: string | null;
  /**
   * Only present while a refused renewal is retried (ACCT-PAY-03): the account stays `paid` after `paidUntil`
   * until this instant (ISO 8601). Clients must not flip it to unpaid before then.
   */
  renewalGraceUntil?: string | null;
  /** Quality of service every transfer of this account gets. */
  qosTier: "free" | "paid";
  /**
   * A running over-quota timeline (ACCT-OVER-01..03), null or absent when the account fits its storage.
   * `grace`: everything works until `graceUntil`. `frozen`: no playback, no uploads (downloads and the ways out stay
   * open) until `deletionAt`, when the server deletes only the excess, most recently added titles first.
   */
  overQuota?: AccountOverQuota | null;
};

export type AccountOverQuota = {
  phase: "grace" | "frozen";
  /** Start of the grace month (ISO 8601). */
  since: string;
  /** End of the grace month = start of the freeze (ISO 8601). */
  graceUntil: string;
  /** When the excess is deleted (ISO 8601). */
  deletionAt: string;
  /** The server's deletion of the excess is queued or running. */
  deleting: boolean;
};

/** Days between the end of the paid period and the irreversible wipe. */
export const UNPAID_WIPE_GRACE_DAYS = 60;
