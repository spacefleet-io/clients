/**
 * @level unit
 * REL-LOG-28: the request id rides every line written while a request runs, and nothing else does. pino merges a
 * line's fields into what `mixin` returns; when that was the request's own store, each line's fields stayed on it and
 * reappeared on every later line of the request (a refusal's `code`, an `errorName`, a `userId` on lines that never
 * had them).
 */
import { describe, expect, it } from "vitest";
import { createLogger, runWithRequestId } from "../src";

const SUITE = "request-scope";

describe(`[${SUITE}] request id mixin`, () => {
  it("@req REL-LOG-28 a line's fields never reach the next line of the same request", async () => {
    const lines: string[] = [];
    const logger = createLogger({ service: "t", pretty: false, level: "info", destination: { write: (line: string) => void lines.push(line) } });
    await runWithRequestId("req-1", async () => {
      logger.warn({ userId: "user-1", code: "version_conflict", errorName: "TypeError" }, "first");
      await Promise.resolve();
      logger.info("second");
    });
    const [first, second] = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    console.info(`[${SUITE}] lines=${JSON.stringify(lines.map((line) => line.trim()))}`);
    expect(first).toMatchObject({ requestId: "req-1", userId: "user-1", code: "version_conflict", msg: "first" });
    expect(second).toMatchObject({ requestId: "req-1", msg: "second" });
    expect(second).not.toHaveProperty("userId");
    expect(second).not.toHaveProperty("code");
    expect(second).not.toHaveProperty("errorName");
  });
});
