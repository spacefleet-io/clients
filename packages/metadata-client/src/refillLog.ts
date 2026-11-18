import type { PinnedTicketKey } from "@space/privacy-pass";
import type { RefillResult } from "./reserve";

/** What an app logs for one ticket refill: counts and the outcome class only, never a ticket or a blinded value. */
export interface RefillLogEntry {
  /** `info` for ok / skipped / stopped, `warn` for every other outcome. */
  level: "info" | "warn";
  detail: {
    status: RefillResult["status"];
    added: number;
    dropped: number;
    count: number;
    retryAfterSeconds?: number;
    /** With `key_mismatch`: the key the API signs with (`?` when it did not say). */
    serverKeyId?: string;
    /** With `key_mismatch`: the keys this build trusts, comma-separated. */
    trustedKeyIds?: string;
  };
}

/**
 * The one classification of a refill outcome every app logs (desktop as a text line, phone/TV and the Jellyfin sidecar
 * as structured data). A `key_mismatch` (META-ANON-07: the API signs with a key this build does not trust, e.g. a
 * release build pointed at a stack that signs with the development key) names the API's key and the trusted ones: the
 * app then holds no ticket. Key ids are public (`GET /metadata/tickets/key`).
 */
export const describeRefill = (result: RefillResult, trustedKeys: readonly PinnedTicketKey[]): RefillLogEntry => {
  const detail: RefillLogEntry["detail"] = { status: result.status, added: result.added, dropped: result.dropped, count: result.count };
  if (result.status === "key_mismatch") {
    detail.serverKeyId = result.serverKeyId ?? "?";
    detail.trustedKeyIds = trustedKeys.map((key) => key.keyId).join(",");
    return { level: "warn", detail };
  }
  if (result.retryAfterSeconds !== undefined) detail.retryAfterSeconds = result.retryAfterSeconds;
  const quiet = result.status === "ok" || result.status === "skipped" || result.status === "stopped";
  return { level: quiet ? "info" : "warn", detail };
};

/**
 * `describeRefill` as one plain text line (desktop logs), without an app prefix. A `key_mismatch` spells out the cause
 * (the two key ids) and the consequence, so a release build pointed at a dev stack is told apart from a ticket store
 * that is simply empty ("no anonymous ticket available" on every lookup).
 */
export const refillLogLine = (result: RefillResult, trustedKeys: readonly PinnedTicketKey[]): { level: RefillLogEntry["level"]; line: string } => {
  const { level, detail } = describeRefill(result, trustedKeys);
  const summary = `refill status=${detail.status} added=${detail.added} dropped=${detail.dropped} held=${detail.count}`;
  if (detail.status === "key_mismatch") {
    return {
      level,
      line: `${summary}: the API signs with key ${detail.serverKeyId} but this build trusts only ${detail.trustedKeyIds}; no tickets, so lookups are unavailable (a release build pointed at a non-production API?)`,
    };
  }
  return { level, line: `${summary}${detail.retryAfterSeconds !== undefined ? ` retryAfter=${detail.retryAfterSeconds}s` : ""}` };
};
