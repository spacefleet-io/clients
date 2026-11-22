/**
 * @test-id MOBILE-SHELL-API-FAILURE-001
 * @level unit
 *
 * @why REL-LOG-31: the phone apps write one device log line per failed API call with the status, code and the
 *   server's request id; the error log "Send feedback" can attach keeps the line but never the request id (the
 *   REL-LOG-06 scrubber redacts the line's fields), so the id never leaves the device.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@space/shared/api";
import { logApiFailuresOnDevice } from "../src/apiFailureLog";
import { readErrorLog } from "../src/logger";

const SUITE = "mobile-api-failure-log";
const log = (testId: string, phase: string, data?: unknown) =>
  console.info(`[${SUITE}] ${testId} ${phase}`, data === undefined ? "" : JSON.stringify(data));

const REQUEST_ID = "3f2c9a1e-7b4d-4e8f-9a0b-1c2d3e4f5a6b";

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
  vi.restoreAllMocks();
});

describe("phone: a failed API call's local line", () => {
  /** @req REL-LOG-31[badger-mobile,badger-tv,parrot,parrot-tv] */
  it("goes to the device log with the request id, and to the feedback error log without it", () => {
    const testId = "MOBILE-SHELL-API-FAILURE-001a";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    stop = logApiFailuresOnDevice();
    void new ApiError(409, { error: "version_conflict", version: 15 }, REQUEST_ID);
    const deviceLines = warn.mock.calls.map((call) => call.map(String).join(" "));
    const feedbackLog = readErrorLog();
    log(testId, "lines", { deviceLines, feedbackLog });
    expect(deviceLines).toContain(
      `[WARN] [api] call.failed {"status":409,"code":"version_conflict","requestId":"${REQUEST_ID}"}`
    );
    expect(feedbackLog).toContain("[WARN] [api] call.failed");
    expect(feedbackLog).not.toContain(REQUEST_ID);
  });
});
