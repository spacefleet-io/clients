import { MetadataUnavailableError, NoTicketError, TicketRejectedError } from "@space/metadata-client";
import { MetadataLookupTimeoutError } from "./metadataRetry";

export interface SearchFailureText {
  /** i18n key of the line shown where the match would be. */
  error: "ingestion.errors.metadataUnavailable" | "ingestion.errors.ticketLimit" | "ingestion.errors.searchFailed" | "ingestion.errors.searchTimedOut";
  /** i18n key of the hint under it. */
  hint:
    | "ingestion.ui.metadataUnavailableHint"
    | "ingestion.ui.metadataNotLookedUpHint"
    | "ingestion.ui.ticketLimitHint"
    | "ingestion.ui.searchFailedHint"
    | "ingestion.ui.searchTimedOutHint";
  /** Values the hint interpolates: `minutes` until the reserve asks for tickets again (ticket limit only). */
  values?: { minutes: number };
  /** The file was never looked up for want of a ticket or a busy service: look it up again when tickets arrive (META-ANON-10). */
  retryOnTickets: boolean;
}

/**
 * What the add-to-library dialog says when a title search throws. No ticket, a refused ticket or a busy metadata
 * service mean title search is unavailable right now (META-ANON-02), which is not "No match found": the file was
 * never looked up. Seen when the app holds no tickets, e.g. a release build pointed at a stack that signs with
 * another key (META-ANON-07, the reserve logs `key_mismatch`). A search that never answered says so (INGS-IDENT-02).
 * INGS-IDENT-03: an empty reserve whose last refill the account's hourly ticket ceiling refused (META-PUB-02) says so,
 * with the minutes until the reserve asks again (META-ANON-15); "could not reach title search" is kept for a refill
 * that never got an answer; any other refusal says only that the file was not looked up yet.
 */
export const searchFailureText = (error: unknown): SearchFailureText => {
  if (error instanceof MetadataLookupTimeoutError) {
    return { error: "ingestion.errors.searchTimedOut", hint: "ingestion.ui.searchTimedOutHint", retryOnTickets: false };
  }
  if (error instanceof NoTicketError) {
    const shortage = error.shortage;
    if (shortage?.status === "rate_limited" && shortage.retryAfterSeconds !== undefined) {
      return {
        error: "ingestion.errors.ticketLimit",
        hint: "ingestion.ui.ticketLimitHint",
        // Whole minutes, at least 1: "in about 0 min" would promise an answer that is not there yet.
        values: { minutes: Math.max(1, Math.ceil(shortage.retryAfterSeconds / 60)) },
        retryOnTickets: true,
      };
    }
    if (shortage?.status === "network_error") {
      return { error: "ingestion.errors.metadataUnavailable", hint: "ingestion.ui.metadataUnavailableHint", retryOnTickets: true };
    }
    return { error: "ingestion.errors.metadataUnavailable", hint: "ingestion.ui.metadataNotLookedUpHint", retryOnTickets: true };
  }
  if (error instanceof TicketRejectedError || error instanceof MetadataUnavailableError) {
    return { error: "ingestion.errors.metadataUnavailable", hint: "ingestion.ui.metadataNotLookedUpHint", retryOnTickets: true };
  }
  return { error: "ingestion.errors.searchFailed", hint: "ingestion.ui.searchFailedHint", retryOnTickets: false };
};
