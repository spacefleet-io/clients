/**
 * @test-id MOBILE-SHELL-FEEDBACK-001
 * @level unit
 * @req UX-SUP-05
 * @req UX-SUP-02
 * @why "Send feedback" on the phone apps builds the `POST /feedback` body here: an empty message sends nothing, the
 *   error log goes along only when the user ticked the box, and the log carries no address or file path.
 */
import { describe, expect, it } from "vitest";
import { ApiError } from "@space/shared/api";
import { FEEDBACK_LOG_MAX_BYTES, clampLog } from "@space/error-report/error-log";
import {
  FEEDBACK_MESSAGE_MAX,
  buildFeedback,
  feedbackFailure,
  type FeedbackDevice,
} from "../src/feedback";

const device: FeedbackDevice = { app: "badger-mobile", appVersion: "1.2.3", platform: "android 15", deviceModel: "Google Pixel 8" };

describe("send feedback (UX-SUP-05)", () => {
  it("sends nothing for an empty message", () => {
    const body = buildFeedback({ message: "   \n ", attachLog: true }, device, () => "log");
    console.info("feedback.empty", body);
    expect(body).toBeNull();
  });

  it("sends the trimmed message with the app, version and device, and no log when the box is not ticked", () => {
    let logRead = false;
    const body = buildFeedback({ message: "  Play froze  ", attachLog: false }, device, () => {
      logRead = true;
      return "secret";
    });
    console.info("feedback.no-log", body);
    expect(body).toEqual({ message: "Play froze", ...device, log: null });
    expect(logRead).toBe(false);
  });

  it("attaches the error log only when the box is ticked (UX-SUP-02)", () => {
    const body = buildFeedback({ message: "Crash", attachLog: true }, device, () => "line one\nline two");
    console.info("feedback.with-log", body);
    expect(body?.log).toBe("line one\nline two");
  });

  it("caps the message at the API's limit", () => {
    const body = buildFeedback({ message: "x".repeat(FEEDBACK_MESSAGE_MAX + 50), attachLog: false }, device, () => "");
    expect(body?.message.length).toBe(FEEDBACK_MESSAGE_MAX);
  });

  it("keeps the newest part of a log that is over 200 KB", () => {
    const log = `${"old ".repeat(60_000)}NEWEST`;
    const clamped = clampLog(log);
    console.info("feedback.clamp", { from: log.length, to: clamped.length });
    expect(new TextEncoder().encode(clamped).length).toBeLessThanOrEqual(FEEDBACK_LOG_MAX_BYTES);
    expect(clamped.endsWith("NEWEST")).toBe(true);
  });

  it("maps the API's answers to what the form says", () => {
    expect(feedbackFailure(new ApiError(429, { error: "rate_limited" }))).toBe("rate_limited");
    expect(feedbackFailure(new ApiError(400, { error: "invalid_feedback" }))).toBe("invalid");
    expect(feedbackFailure(new ApiError(500, { error: "x" }))).toBe("failed");
    expect(feedbackFailure(new TypeError("Network request failed"))).toBe("offline");
    expect(feedbackFailure(new Error("?"))).toBe("failed");
  });
});
