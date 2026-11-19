import { MetadataUnavailableError, NoTicketError, TicketRejectedError } from "@space/metadata-client";
import { MetadataLookupTimeoutError } from "./metadataRetry";

export interface SearchFailureText {
  /** i18n key of the line shown where the match would be. */
  error: "ingestion.errors.metadataUnavailable" | "ingestion.errors.searchFailed" | "ingestion.errors.searchTimedOut";
  /** i18n key of the hint under it. */
  hint: "ingestion.ui.metadataUnavailableHint" | "ingestion.ui.searchFailedHint" | "ingestion.ui.searchTimedOutHint";
}

/**
 * What the add-to-library dialog says when a title search throws. No ticket, a refused ticket or a busy metadata
 * service mean title search is unavailable right now (META-ANON-02), which is not "No match found": the file was
 * never looked up. Seen when the app holds no tickets, e.g. a release build pointed at a stack that signs with
 * another key (META-ANON-07, the reserve logs `key_mismatch`). A search that never answered says so (INGS-IDENT-02).
 */
export const searchFailureText = (error: unknown): SearchFailureText =>
  error instanceof MetadataLookupTimeoutError
    ? { error: "ingestion.errors.searchTimedOut", hint: "ingestion.ui.searchTimedOutHint" }
    : error instanceof NoTicketError || error instanceof TicketRejectedError || error instanceof MetadataUnavailableError
      ? { error: "ingestion.errors.metadataUnavailable", hint: "ingestion.ui.metadataUnavailableHint" }
      : { error: "ingestion.errors.searchFailed", hint: "ingestion.ui.searchFailedHint" };
