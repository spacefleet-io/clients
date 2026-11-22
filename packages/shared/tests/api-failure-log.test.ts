/**
 * @test-id SHARED-API-FAILURE-001
 * @level unit
 *
 * @why REL-LOG-31: every failed API call (SDK call or hand-written fetch alike) gives the app one local log line with
 *   the status, the error code and the server's request id (REL-LOG-28), so the server's line about the same call is
 *   found by one search. Only a server-made UUID is read as a request id; a code that is not a code reads `other`.
 *   LIB-SYNC-16: a library refusal's fields are numbers and codes only, never the answer's state hash.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiRequest, getMe, putLibraryDbBinary, setApiBaseUrl } from "../src/api";
import {
  RECENT_FAILED_REQUEST_IDS_MAX,
  apiErrorCode,
  clearRecentFailedRequestIds,
  libraryRefusalFields,
  logFailedApiCalls,
  recentFailedRequestIds,
  type ApiFailureFields,
} from "../src/apiFailure";

const SUITE = "api-failure-log";
const log = (testId: string, phase: string, data?: unknown) =>
  console.info(`[${SUITE}] ${testId} ${phase}`, data === undefined ? "" : JSON.stringify(data));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const REQUEST_ID = "3F2C9A1E-7B4D-4E8F-9A0B-1C2D3E4F5A6B";

const answer = (status: number, body: unknown, requestId: string | null = REQUEST_ID) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...(requestId === null ? {} : { "x-request-id": requestId }) },
  });

const captured: ApiFailureFields[] = [];
let stop: (() => void) | null = null;
const startCapture = () => {
  captured.length = 0;
  stop = logFailedApiCalls((fields) => captured.push(fields));
};

afterEach(() => {
  stop?.();
  stop = null;
  fetchMock.mockReset();
});

describe("a failed API call carries the server's request id onto the app's local log line", () => {
  /** @req REL-LOG-31[badger-desktop,badger-mobile,badger-tv,parrot,parrot-tv] */
  it("SDK call: the ApiError and the log line hold status, code and the request id (lower-cased)", async () => {
    const testId = "SHARED-API-FAILURE-001a";
    setApiBaseUrl("https://api.example.test");
    startCapture();
    fetchMock.mockResolvedValueOnce(answer(401, { error: "unauthorized" }));
    const error = await getMe("token").catch((caught: unknown) => caught);
    log(testId, "caught", { isApiError: error instanceof ApiError, requestId: (error as ApiError).requestId, captured });
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).requestId).toBe(REQUEST_ID.toLowerCase());
    expect(captured).toEqual([{ status: 401, code: "unauthorized", requestId: REQUEST_ID.toLowerCase() }]);
  });

  /** @req REL-LOG-31[badger-desktop,badger-mobile,badger-tv,parrot,parrot-tv] */
  it("hand-written fetch (apiRequest): same fields; a free-text error reads `other`", async () => {
    const testId = "SHARED-API-FAILURE-001b";
    setApiBaseUrl("https://api.example.test");
    startCapture();
    fetchMock.mockResolvedValueOnce(answer(500, { error: "Bad Thing happened at /library/abc" }));
    const error = await apiRequest("/admin/stats", { token: "t" }).catch((caught: unknown) => caught);
    log(testId, "caught", { requestId: (error as ApiError).requestId, captured });
    expect((error as ApiError).requestId).toBe(REQUEST_ID.toLowerCase());
    expect(captured).toEqual([{ status: 500, code: "other", requestId: REQUEST_ID.toLowerCase() }]);
  });

  /** @req REL-LOG-31[badger-desktop,badger-mobile,badger-tv,parrot,parrot-tv] */
  it("binary library upload: a 409 refusal holds the request id; a non-UUID header is not read as one", async () => {
    const testId = "SHARED-API-FAILURE-001c";
    setApiBaseUrl("https://api.example.test");
    startCapture();
    fetchMock.mockResolvedValueOnce(answer(409, { error: "version_conflict", version: 15 }));
    const refused = await putLibraryDbBinary("t", 12, new Uint8Array([1, 2, 3]), "snap", 1024).catch((caught: unknown) => caught);
    fetchMock.mockResolvedValueOnce(answer(502, {}, "portal-junk-<script>"));
    const junk = await apiRequest("/admin/stats", { token: "t" }).catch((caught: unknown) => caught);
    log(testId, "caught", { refused: (refused as ApiError).requestId, junk: (junk as ApiError).requestId, captured });
    expect((refused as ApiError).requestId).toBe(REQUEST_ID.toLowerCase());
    expect((junk as ApiError).requestId).toBeNull();
    expect(captured).toEqual([
      { status: 409, code: "version_conflict", requestId: REQUEST_ID.toLowerCase() },
      { status: 502, code: null, requestId: null },
    ]);
  });

  /** @req REL-LOG-31[badger-desktop,badger-mobile,badger-tv,parrot,parrot-tv] */
  it("apiErrorCode follows the server's code rule", () => {
    const testId = "SHARED-API-FAILURE-001d";
    const cases = [
      ["version_conflict", "version_conflict"],
      ["Bad Thing", "other"],
      [42, "other"],
      [undefined, null],
      [null, null],
    ] as const;
    for (const [input, expected] of cases) {
      log(testId, "case", { input: String(input), got: apiErrorCode(input) });
      expect(apiErrorCode(input)).toBe(expected);
    }
  });
});

describe("a library refusal's log fields", () => {
  /** @req LIB-SYNC-16[badger-desktop,badger-mobile,badger-tv] */
  it("hold status, code, request id, base and server version and the streak; never the state hash", () => {
    const testId = "SHARED-API-FAILURE-001e";
    const conflict = new ApiError(409, { error: "version_conflict", version: 15 }, REQUEST_ID.toLowerCase());
    const lineage = new ApiError(409, { error: "lineage_conflict", currentStateHash: "deadbeef".repeat(8) }, null);
    const conflictFields = libraryRefusalFields(conflict, { baseVersion: 12, consecutive409: 5 });
    const lineageFields = libraryRefusalFields(lineage, { baseVersion: 12, consecutive409: 1 });
    log(testId, "fields", { conflictFields, lineageFields });
    expect(conflictFields).toEqual({
      status: 409,
      code: "version_conflict",
      requestId: REQUEST_ID.toLowerCase(),
      baseVersion: 12,
      serverVersion: 15,
      consecutive409: 5,
    });
    expect(JSON.stringify(lineageFields)).not.toContain("deadbeef");
    expect(libraryRefusalFields(new Error("offline"), { baseVersion: 3, consecutive409: 0 })).toEqual({
      status: null,
      code: null,
      requestId: null,
      baseVersion: 3,
      serverVersion: null,
      consecutive409: 0,
    });
  });
});

describe("the request ids a feedback message carries (UX-SUP-07)", () => {
  /** @req UX-SUP-07[badger-mobile,parrot] */
  it("keeps the ids of the last failed answers, newest last, at most 5, never an answer without a server-made id", async () => {
    const testId = "SHARED-API-FAILURE-003";
    setApiBaseUrl("https://api.example.test");
    clearRecentFailedRequestIds();
    startCapture();
    const ids = Array.from({ length: RECENT_FAILED_REQUEST_IDS_MAX + 2 }, (_, i) => `00000000-0000-4000-8000-00000000000${i}`);
    for (const id of ids) {
      fetchMock.mockResolvedValueOnce(answer(404, { error: "not_found" }, id));
      await getMe("token").catch(() => undefined);
    }
    fetchMock.mockResolvedValueOnce(answer(401, { error: "unauthorized" }, null));
    await getMe("token").catch(() => undefined);
    fetchMock.mockResolvedValueOnce(answer(400, { error: "bad" }, "not-a-server-id"));
    await getMe("token").catch(() => undefined);
    const kept = recentFailedRequestIds();
    log(testId, "kept", { kept, captured: captured.length });
    expect(kept).toEqual(ids.slice(-RECENT_FAILED_REQUEST_IDS_MAX));
    // A copy: changing it changes nothing kept.
    kept.length = 0;
    expect(recentFailedRequestIds()).toHaveLength(RECENT_FAILED_REQUEST_IDS_MAX);
    clearRecentFailedRequestIds();
  });
});
