import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import { createLogger } from "../src";

class CaptureStream extends Writable {
  private chunks: string[] = [];

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    callback();
  }

  lines() {
    return this.chunks
      .join("")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  raw() {
    return this.chunks.join("");
  }
}

// On assertion failure, dump the captured stream + parsed payload so a failing
// log-shape assertion can be diagnosed offline without re-running. Body wrapped
// in try/catch so a dump failure can never mask the original assertion failure.
const dumpLoggerSnapshot = (label: string, stream: CaptureStream) => {
  try {
    const lines = stream.lines();
    let parsed: unknown = null;
    try {
      parsed = lines.length > 0 ? JSON.parse(lines[0]) : null;
    } catch (parseErr) {
      parsed = `(parse-failed: ${parseErr instanceof Error ? parseErr.message : String(parseErr)})`;
    }
    console.error(`=== [logger:${label}] snapshot ===`);
    console.error(`line count=${lines.length}`);
    console.error(`raw bytes=${JSON.stringify(stream.raw())}`);
    console.error(`lines:\n${JSON.stringify(lines, null, 2)}`);
    console.error(`parsed first line:\n${JSON.stringify(parsed, null, 2)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("createLogger", () => {
  it("writes structured logs with service metadata", () => {
    console.info(`[logger:setup] creating logger service=logger-test pretty=false`);
    const stream = new CaptureStream();
    const logger = createLogger({
      service: "logger-test",
      pretty: false,
      destination: stream,
    });
    console.info(`[logger:emit] writing info log scope=test event=hello msg=log_message`);
    logger.info({ scope: "test", event: "hello" }, "log_message");
    const lines = stream.lines();
    console.info(`[logger:assert] captured ${lines.length} line(s), expecting exactly 1`);
    if (lines.length !== 1) dumpLoggerSnapshot("structured-metadata-line-count", stream);
    expect(lines.length).toBe(1);
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(lines[0]) as Record<string, unknown>;
    } catch (err) {
      dumpLoggerSnapshot("structured-metadata-parse-error", stream);
      throw err;
    }
    console.info(
      `[logger:assert] payload service=${String(payload.service)} scope=${String(payload.scope)} event=${String(payload.event)} msg=${String(payload.msg)} level=${String(payload.level)}`,
    );
    try {
      expect(payload.service).toBe("logger-test");
      expect(payload.scope).toBe("test");
      expect(payload.event).toBe("hello");
      expect(payload.msg).toBe("log_message");
      expect(payload.level).toBe(30);
    } catch (err) {
      dumpLoggerSnapshot("structured-metadata-assert", stream);
      throw err;
    }
  });

  it("redacts sensitive fields by default", () => {
    console.info(`[logger:setup] creating logger service=logger-test pretty=false (redaction case)`);
    const stream = new CaptureStream();
    const logger = createLogger({
      service: "logger-test",
      pretty: false,
      destination: stream,
    });
    console.info(`[logger:emit] writing info log with token + nested.password (expect redaction)`);
    logger.info({
      token: "abc",
      nested: {
        password: "secret",
      },
    });
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(stream.lines()[0]) as Record<string, unknown>;
    } catch (err) {
      dumpLoggerSnapshot("redaction-parse-error", stream);
      throw err;
    }
    console.info(
      `[logger:assert] post-redaction token=${JSON.stringify(payload.token)} nested=${JSON.stringify(payload.nested)}`,
    );
    try {
      expect(payload.token).toBeUndefined();
      expect(payload.nested).toEqual({});
    } catch (err) {
      dumpLoggerSnapshot("redaction-assert", stream);
      throw err;
    }
  });

  it("drops email fields at the top level and one level down by default", () => {
    const stream = new CaptureStream();
    const logger = createLogger({ service: "logger-test", pretty: false, destination: stream });
    logger.error({ email: "pilot@spacefleet.io", user: { id: 7, email: "pilot@spacefleet.io" } }, "send failed");
    const line = stream.lines()[0];
    console.info(`[logger:assert] email redaction line=${line}`);
    const payload = JSON.parse(line) as Record<string, unknown>;
    expect(payload.email).toBeUndefined();
    expect(payload.user).toEqual({ id: 7 });
    expect(line).not.toContain("pilot@spacefleet.io");
  });
});
