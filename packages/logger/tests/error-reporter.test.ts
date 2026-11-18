/**
 * @test-id logger-error-reporter
 * @level unit
 *
 * Error and fatal log lines go to the error reporter (the service's Bugsink project); the Error handed
 * with `reportedError` reaches the reporter but never the log line.
 */
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { childLogger, createLogger, notReported, reportedError, setErrorReporter, type ErrorReporter } from "../src";

class CaptureStream extends Writable {
  chunks: string[] = [];
  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    callback();
  }
  raw() {
    return this.chunks.join("");
  }
}

const recordingReporter = () => {
  const calls: Array<{ kind: "exception" | "message"; error?: Error; message: string }> = [];
  const reporter: ErrorReporter = {
    exception: (error, message) => calls.push({ kind: "exception", error, message }),
    message: (message) => calls.push({ kind: "message", message }),
  };
  return { calls, reporter };
};

const makeLogger = () => {
  const stream = new CaptureStream();
  const logger = createLogger({ service: "reporter-test", pretty: false, destination: stream });
  return { stream, logger };
};

afterEach(() => setErrorReporter(null));

describe("error reporter hook", () => {
  it("@req REL-LOG-11 reports the attached Error of an error line without writing it to the log", () => {
    const { calls, reporter } = recordingReporter();
    setErrorReporter(reporter);
    const { stream, logger } = makeLogger();
    const error = new TypeError("cannot read 'Blade Runner 2049'");

    childLogger(logger, { scope: "x" }).error({ errorName: error.name, [reportedError]: error }, "unhandled request error");

    console.info("[reporter-test] log:", stream.raw(), "calls:", calls.map((c) => `${c.kind}:${c.message}`));
    expect(calls).toEqual([{ kind: "exception", error, message: "unhandled request error" }]);
    expect(stream.raw()).toContain('"errorName":"TypeError"');
    expect(stream.raw()).not.toContain("Blade Runner");
  });

  it("@req REL-LOG-11 reports a line without an Error by its message only, and skips info, warn and notReported lines", () => {
    const { calls, reporter } = recordingReporter();
    setErrorReporter(reporter);
    const { stream, logger } = makeLogger();

    logger.info("fine");
    logger.warn({ event: "slow" }, "slow");
    logger.error({ status: 500, [notReported]: true }, "request failed");
    logger.error({ event: "db", error: "connection refused for chris@example.com" }, "database unavailable");
    logger.fatal("boot failed");

    console.info("[reporter-test] calls:", calls);
    expect(calls).toEqual([
      { kind: "message", message: "database unavailable" },
      { kind: "message", message: "boot failed" },
    ]);
    expect(stream.raw()).not.toContain("notReported");
  });

  it("@req REL-LOG-11 keeps logging when no reporter is set or the reporter throws", () => {
    const { stream, logger } = makeLogger();
    logger.error({ err: new Error("x") }, "no reporter");
    setErrorReporter({
      exception: () => {
        throw new Error("reporter down");
      },
      message: () => {
        throw new Error("reporter down");
      },
    });
    logger.error({ err: new Error("y") }, "reporter throws");
    expect(stream.raw()).toContain("no reporter");
    expect(stream.raw()).toContain("reporter throws");
  });
});
