import { ApiError, onApiError } from "@space/sdk";

/**
 * REL-LOG-31: what an app writes on its own local log line about a failed API call. `requestId` is the server's
 * `x-request-id` of that answer (REL-LOG-28), so the server's line about the same call is found by one search;
 * `code` follows the server's rule: the JSON `error` when it is a code, `other` for any other value, null when the
 * answer has none. Nothing here is ever put into an error report: the request id would tie an anonymous report to the
 * account the server's line names.
 */
export type ApiFailureFields = {
  /** The HTTP status; 0 when no answer came (timeout, offline). */
  status: number;
  code: string | null;
  requestId: string | null;
};

/** The same pattern the server's request logger applies to the code it writes. */
export const API_ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** The JSON `error` of an answer as a loggable code: itself when it reads as a code, `other` otherwise, null when absent. */
export const apiErrorCode = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  return typeof value === "string" && API_ERROR_CODE_PATTERN.test(value) ? value : "other";
};

/** The loggable fields of a failed call, or null when `error` is not an API answer (a crash, an abort). */
export const apiFailureFields = (error: unknown): ApiFailureFields | null => {
  if (!(error instanceof ApiError)) return null;
  return { status: error.status, code: apiErrorCode(error.payload?.error), requestId: error.requestId ?? null };
};

/** UX-SUP-07: how many request ids of the last failed API calls the process keeps for a feedback message. */
export const RECENT_FAILED_REQUEST_IDS_MAX = 5;

const failedRequestIds: string[] = [];

/** Keeps the request id of an answer of 400 or more, newest last, at most {@link RECENT_FAILED_REQUEST_IDS_MAX}. */
const rememberFailedRequestId = (fields: ApiFailureFields): void => {
  if (fields.status < 400 || !fields.requestId) return;
  const known = failedRequestIds.indexOf(fields.requestId);
  if (known !== -1) failedRequestIds.splice(known, 1);
  failedRequestIds.push(fields.requestId);
  if (failedRequestIds.length > RECENT_FAILED_REQUEST_IDS_MAX) failedRequestIds.shift();
};

/**
 * UX-SUP-07: the server's request ids of this process's last failed API calls (answers of 400 or more), oldest
 * first, for the `requestIds` of a "Send feedback" message. That message already names the account, and the server's
 * line for each id names it too (REL-LOG-28), so the ids add no personal data; they only let an admin find those
 * lines. Ids only: never the call's path, body or answer. Filled by {@link logFailedApiCalls}; kept in memory only.
 */
export const recentFailedRequestIds = (): string[] => [...failedRequestIds];

/** Test seam: forgets the remembered request ids. */
export const clearRecentFailedRequestIds = (): void => {
  failedRequestIds.length = 0;
};

/**
 * Calls `write` once for every failed API call of this process (SDK and hand-written fetch alike: every `ApiError`),
 * and remembers its request id for a feedback message (UX-SUP-07). Each app wires it to its own local logger at
 * start-up; the web app does not. Returns the unsubscribe function.
 */
export const logFailedApiCalls = (write: (fields: ApiFailureFields) => void): (() => void) =>
  onApiError((error) => {
    const fields = apiFailureFields(error);
    if (!fields) return;
    rememberFailedRequestId(fields);
    write(fields);
  });

/**
 * LIB-SYNC-16: after this many 409 refusals in a row of the same library upload (each followed by a sync from the
 * server), the device is stuck behind the server rather than racing another device: it says so once at warn level.
 * LIB-SYNC-17: from then on the phone retries only every {@link LIBRARY_SYNC_STUCK_RETRY_MS} (desktop pending).
 */
export const LIBRARY_SYNC_STUCK_AFTER_409S = 5;

/** LIB-SYNC-17: how long a stuck library upload waits between tries once it got {@link LIBRARY_SYNC_STUCK_AFTER_409S} 409s. */
export const LIBRARY_SYNC_STUCK_RETRY_MS = 5 * 60_000;

export type LibraryRefusalFields = {
  status: number | null;
  code: string | null;
  requestId: string | null;
  /** The library version the refused upload was based on. */
  baseVersion: number | null;
  /** The server's current version a `version_conflict` names; null for any other refusal. */
  serverVersion: number | null;
  /** How many uploads in a row the server refused with 409, this one included (0 when this was not a 409). */
  consecutive409: number;
};

/**
 * LIB-SYNC-16: the fields of a library sync refusal's local log line. Only numbers and codes: never the answer body
 * itself (a `lineage_conflict` carries a state hash), an op or snapshot id, or anything from the library.
 */
export const libraryRefusalFields = (
  error: unknown,
  context: { baseVersion: number | null; consecutive409: number }
): LibraryRefusalFields => {
  const fields = apiFailureFields(error);
  const version = error instanceof ApiError ? error.payload?.version : undefined;
  return {
    status: fields?.status ?? null,
    code: fields?.code ?? null,
    requestId: fields?.requestId ?? null,
    baseVersion: context.baseVersion,
    serverVersion: typeof version === "number" && Number.isFinite(version) ? version : null,
    consecutive409: context.consecutive409,
  };
};
