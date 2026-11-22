/**
 * @level unit
 * REL-LOG-29: a log line names a caught error by its class and its code (and those of its cause), never by its message:
 * a driver's message can carry the query's values, an HTTP client's the URL it called.
 */
import { describe, expect, it } from "vitest";
import { createLogger, errorFields } from "../src/index";

const SUITE = "error-fields";

/** The REL-LOG-29 part of the fields (class and code); `errorAt` (REL-LOG-30) is checked on its own below. */
const classAndCode = (error: unknown) => {
  const { errorAt: _errorAt, ...rest } = errorFields(error);
  return rest;
};

function openLibrary(): never {
  throw new Error("cannot open Blade Runner.mkv for alice@example.com");
}

function loadShelf(): never {
  openLibrary();
}

class PostgresError extends Error {
  code = "23505";
}

describe(`[${SUITE}] errorFields`, () => {
  it("@req REL-LOG-29 gives the class of a plain error and nothing of its message", () => {
    const fields = classAndCode(new Error("duplicate key value violates unique constraint: alice@example.com"));
    console.info(`[${SUITE}] plain=${JSON.stringify(fields)}`);
    expect(fields).toEqual({ errorName: "Error" });
  });

  it("@req REL-LOG-29 gives a subclass's own name and a code-shaped code", () => {
    expect(classAndCode(new PostgresError("Key (email)=(alice@example.com) already exists"))).toEqual({ errorName: "PostgresError", errorCode: "23505" });
    const socket = Object.assign(new Error("connect ECONNREFUSED 10.0.0.4:5432"), { code: "ECONNREFUSED" });
    expect(classAndCode(socket)).toEqual({ errorName: "Error", errorCode: "ECONNREFUSED" });
  });

  it("@req REL-LOG-29 gives the cause's class and code (a fetch failure hides the socket error there)", () => {
    const cause = Object.assign(new Error("connect timeout https://silo.example/storage?key=library/chunks/abc"), { code: "UND_ERR_CONNECT_TIMEOUT" });
    const fields = classAndCode(new TypeError("fetch failed", { cause }));
    console.info(`[${SUITE}] fetch=${JSON.stringify(fields)}`);
    expect(fields).toEqual({ errorName: "TypeError", causeName: "Error", causeCode: "UND_ERR_CONNECT_TIMEOUT" });
  });

  it("@req REL-LOG-29 drops a code that is not code-shaped and names a thrown non-error `unknown`", () => {
    expect(classAndCode(Object.assign(new Error("x"), { code: "user alice@example.com not found" }))).toEqual({ errorName: "Error" });
    expect(classAndCode(Object.assign(new Error("x"), { code: 42 }))).toEqual({ errorName: "Error" });
    expect(classAndCode("password=hunter2")).toEqual({ errorName: "unknown" });
    expect(classAndCode({ code: "EPIPE", message: "secret" })).toEqual({ errorName: "unknown", errorCode: "EPIPE" });
    expect(classAndCode(new Error("x", { cause: "raw text cause" }))).toEqual({ errorName: "Error", causeName: "unknown" });
  });

  it("@req REL-LOG-29 a logged line holds the fields and no message text", () => {
    const lines: string[] = [];
    const logger = createLogger({ service: "test", pretty: false, level: "debug", destination: { write: (line: string) => lines.push(line) } });
    const error = new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND secret.example"), { code: "ENOTFOUND" }) });
    logger.warn({ ...errorFields(error) }, "gateway copy unreachable");
    console.info(`[${SUITE}] line=${lines[0]?.trim()}`);
    const line = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(line).toMatchObject({ errorName: "TypeError", causeName: "Error", causeCode: "ENOTFOUND", msg: "gateway copy unreachable" });
    expect(lines[0]).not.toContain("secret.example");
    expect(lines[0]).not.toContain("fetch failed");
  });

  it("@req REL-LOG-30 says where the error was thrown (function, file, line) and nothing of its message", () => {
    let error: unknown;
    try {
      loadShelf();
    } catch (caught) {
      error = caught;
    }
    const fields = errorFields(error);
    console.info(`[${SUITE}] at=${JSON.stringify(fields.errorAt)}`);
    expect(fields.errorAt?.[0]).toMatch(/^openLibrary error-fields\.test\.ts:\d+$/);
    expect(fields.errorAt?.[1]).toMatch(/^loadShelf error-fields\.test\.ts:\d+$/);
    expect(fields.errorAt?.length).toBeLessThanOrEqual(5);
    expect(JSON.stringify(fields)).not.toMatch(/Blade|alice|example\.com|\/home\/|\/app\//);
  });

  it("@req REL-LOG-30 skips a message that spans lines and looks like a frame", () => {
    const error = new Error("bad row\n    at blade runner (/srv/alice.mkv:1:2)\n    at Blade_Runner_1982 (/library/alice/Blade_Runner.mkv:3:4)");
    const fields = errorFields(error);
    console.info(`[${SUITE}] forged=${JSON.stringify(fields.errorAt)}`);
    expect(fields.errorAt?.length).toBeGreaterThan(0);
    expect(JSON.stringify(fields)).not.toMatch(/blade|Blade|alice/);
  });

  it("@req REL-LOG-30 keeps a package path under node_modules, drops frames that are not plain, and has none without a stack", () => {
    const error = new Error("x");
    error.stack = [
      "Error: x",
      "    at query (/app/node_modules/postgres/src/connection.js:790:26)",
      "    at handler (/app/dist/index.js:41234:11)",
      '    at eval (eval at run ("alice@example.com"), <anonymous>:1:1)',
      "    at /app/dist/index.js:900:3",
      "    at native",
    ].join("\n");
    expect(errorFields(error).errorAt).toEqual(["query postgres/src/connection.js:790", "handler index.js:41234", "index.js:900"]);
    const bare = new Error("x");
    bare.stack = undefined;
    expect(errorFields(bare)).toEqual({ errorName: "Error" });
    expect(errorFields({ stack: "Error: x\n    at f (/a.js:1:1)" })).toEqual({ errorName: "unknown" });
  });
});
