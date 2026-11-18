// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BROWSER_LOG_LEVELS, createBrowserLogger } from "../src/browser";

const LOCAL_STORAGE_KEY = "sf:log-level";

// NOTE: this suite spies on console.debug/info/warn/error (mocked to swallow
// output) and asserts on their call counts. Diagnostic logging MUST therefore
// use console.log — which is intentionally NOT spied — so dumps never pollute
// the very call-count assertions they exist to diagnose. Snapshot blocks are
// bracketed `=== [logger-browser:...] ===` for CI grep extraction.
describe("createBrowserLogger", () => {
  let debugSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  // Dump every console spy's call count + the recorded argument vectors plus
  // the persisted log level from localStorage. Body is wrapped in try/catch so
  // a dump failure can never mask the real assertion failure it precedes.
  const dumpBrowserLoggerSnapshot = (label: string) => {
    try {
      const summarize = (spy: ReturnType<typeof vi.spyOn> | undefined) => {
        if (!spy) return { calls: "(spy-undefined)" };
        return {
          callCount: spy.mock.calls.length,
          calls: spy.mock.calls,
        };
      };
      console.log(`=== [logger-browser:${label}] snapshot ===`);
      console.log(`debugSpy: ${JSON.stringify(summarize(debugSpy))}`);
      console.log(`infoSpy: ${JSON.stringify(summarize(infoSpy))}`);
      console.log(`warnSpy: ${JSON.stringify(summarize(warnSpy))}`);
      console.log(`errorSpy: ${JSON.stringify(summarize(errorSpy))}`);
      console.log(
        `localStorage[${LOCAL_STORAGE_KEY}]=${JSON.stringify(localStorage.getItem(LOCAL_STORAGE_KEY))}`,
      );
    } catch (err) {
      console.log(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
    }
  };

  beforeEach(() => {
    console.log(`[logger-browser:setup] clearing localStorage + installing console spies`);
    localStorage.clear();
    debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    console.log(`[logger-browser:setup] spies installed (debug/info/warn/error)`);
  });

  afterEach(() => {
    console.log(`[logger-browser:teardown] restoring console spies + clearing localStorage`);
    debugSpy.mockRestore();
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    localStorage.clear();
  });

  it("exposes the six pino-compatible levels", () => {
    expect(BROWSER_LOG_LEVELS).toEqual(["trace", "debug", "info", "warn", "error", "fatal"]);
  });

  it("defaults to debug level (import.meta.env.DEV is true under vitest) so debug emits but trace is silenced", () => {
    console.log(`[logger-browser:default-level] creating logger service=test-svc`);
    const log = createBrowserLogger({ service: "test-svc" });
    console.log(`[logger-browser:default-level] resolved level=${log.level}`);
    if (log.level !== "debug") dumpBrowserLoggerSnapshot("default-level-unexpected-level");
    expect(log.level).toBe("debug");

    log.trace({ x: 1 }, "silenced trace");
    if (debugSpy.mock.calls.length !== 0) dumpBrowserLoggerSnapshot("default-level-trace-leaked");
    expect(debugSpy).not.toHaveBeenCalled();

    log.debug({ x: 1 }, "emitted debug");
    log.info({ y: 2 }, "emitted info");
    if (debugSpy.mock.calls.length !== 1 || infoSpy.mock.calls.length !== 1) {
      dumpBrowserLoggerSnapshot("default-level-emit-mismatch");
    }
    expect(debugSpy).toHaveBeenCalledOnce();
    expect(infoSpy).toHaveBeenCalledOnce();
  });

  it("silences debug below the configured level when level bumped to info", () => {
    console.log(`[logger-browser:bump-info] creating logger + bumping level to info`);
    const log = createBrowserLogger({ service: "test-svc" });
    log.setLevel("info");
    console.log(`[logger-browser:bump-info] level after setLevel=${log.level}`);
    debugSpy.mockClear();
    log.debug({ x: 1 }, "silenced");
    if (debugSpy.mock.calls.length !== 0) dumpBrowserLoggerSnapshot("bump-info-debug-leaked");
    expect(debugSpy).not.toHaveBeenCalled();
    log.info({ y: 2 }, "loud");
    if (infoSpy.mock.calls.length !== 1) dumpBrowserLoggerSnapshot("bump-info-info-mismatch");
    expect(infoSpy).toHaveBeenCalledOnce();
  });

  it("emits warn to console.warn and error to console.error", () => {
    console.log(`[logger-browser:warn-error-routing] emitting warn/error/fatal`);
    const log = createBrowserLogger({ service: "test-svc" });
    log.warn({ a: 1 }, "warn message");
    log.error({ b: 2 }, "error message");
    log.fatal({ c: 3 }, "fatal message");
    console.log(
      `[logger-browser:warn-error-routing] warnSpy=${warnSpy.mock.calls.length} errorSpy=${errorSpy.mock.calls.length} (expect 1 / 2)`,
    );
    if (warnSpy.mock.calls.length !== 1 || errorSpy.mock.calls.length !== 2) {
      dumpBrowserLoggerSnapshot("warn-error-routing-mismatch");
    }
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledTimes(2); // error + fatal
  });

  it("includes service name and scope bindings in the structured payload", () => {
    console.log(`[logger-browser:structured-payload] emitting info with userId binding`);
    const log = createBrowserLogger({ service: "renderer" });
    log.info({ userId: "u1" }, "user ping");
    const args = infoSpy.mock.calls[0];
    try {
      expect(args[0]).toBe("[renderer]");
      expect(args[1]).toBe("user ping");
      const payload = args[2] as Record<string, unknown>;
      expect(payload.service).toBe("renderer");
      expect(payload.level).toBe("info");
      expect(payload.userId).toBe("u1");
    } catch (err) {
      console.log(`[logger-browser:structured-payload] captured args=${JSON.stringify(args)}`);
      dumpBrowserLoggerSnapshot("structured-payload-mismatch");
      throw err;
    }
  });

  it("child logger merges bindings without mutating parent", () => {
    console.log(`[logger-browser:child-bindings] creating root + scoped child logger`);
    const root = createBrowserLogger({ service: "renderer" });
    const scoped = root.child({ scope: "play-trace" });
    scoped.info({ step: "click" }, "clicked");
    const args = infoSpy.mock.calls[0];
    const payload = args[2] as Record<string, unknown>;
    try {
      expect(payload.scope).toBe("play-trace");
      expect(payload.step).toBe("click");
    } catch (err) {
      console.log(`[logger-browser:child-bindings] child payload=${JSON.stringify(payload)}`);
      dumpBrowserLoggerSnapshot("child-bindings-child-mismatch");
      throw err;
    }

    // Parent unaffected.
    console.log(`[logger-browser:child-bindings] verifying parent logger unaffected by child scope`);
    infoSpy.mockClear();
    root.info({}, "plain");
    const parentArgs = infoSpy.mock.calls[0];
    const parentPayload = parentArgs[2] as Record<string, unknown>;
    if (parentPayload.scope !== undefined) {
      console.log(`[logger-browser:child-bindings] parent payload leaked scope=${JSON.stringify(parentPayload)}`);
      dumpBrowserLoggerSnapshot("child-bindings-parent-mutated");
    }
    expect(parentPayload.scope).toBeUndefined();
  });

  it("setLevel persists to localStorage and takes effect immediately", () => {
    console.log(`[logger-browser:setlevel-persist] creating logger + setLevel(info)`);
    const log = createBrowserLogger({ service: "renderer" });
    log.setLevel("info");
    debugSpy.mockClear();
    log.debug({}, "silenced after bump"); // info level silences debug
    if (debugSpy.mock.calls.length !== 0) dumpBrowserLoggerSnapshot("setlevel-persist-debug-leaked");
    expect(debugSpy).not.toHaveBeenCalled();

    log.setLevel("trace");
    const persisted = localStorage.getItem(LOCAL_STORAGE_KEY);
    console.log(`[logger-browser:setlevel-persist] persisted level=${JSON.stringify(persisted)} (expect "trace")`);
    if (persisted !== "trace") dumpBrowserLoggerSnapshot("setlevel-persist-not-saved");
    expect(persisted).toBe("trace");

    log.trace({ x: 1 }, "loud");
    log.debug({ y: 2 }, "also loud");
    if (debugSpy.mock.calls.length !== 2) dumpBrowserLoggerSnapshot("setlevel-persist-emit-count");
    expect(debugSpy).toHaveBeenCalledTimes(2);
  });

  it("localStorage override wins over the default", () => {
    console.log(`[logger-browser:ls-override] seeding localStorage[${LOCAL_STORAGE_KEY}]=trace before logger creation`);
    localStorage.setItem(LOCAL_STORAGE_KEY, "trace");
    const log = createBrowserLogger({ service: "renderer" });
    console.log(`[logger-browser:ls-override] resolved level=${log.level} (expect "trace")`);
    if (log.level !== "trace") dumpBrowserLoggerSnapshot("ls-override-wrong-level");
    expect(log.level).toBe("trace");
    log.trace({}, "loud");
    if (debugSpy.mock.calls.length !== 1) dumpBrowserLoggerSnapshot("ls-override-trace-not-emitted");
    expect(debugSpy).toHaveBeenCalledOnce();
  });

  it("ignores invalid setLevel input silently", () => {
    console.log(`[logger-browser:invalid-setlevel] creating logger then calling setLevel("garbage")`);
    const log = createBrowserLogger({ service: "renderer" });
    const initialLevel = log.level;
    log.setLevel("garbage" as unknown as Parameters<typeof log.setLevel>[0]);
    console.log(
      `[logger-browser:invalid-setlevel] level before=${initialLevel} after=${log.level} ls=${JSON.stringify(localStorage.getItem(LOCAL_STORAGE_KEY))}`,
    );
    if (log.level !== initialLevel || localStorage.getItem(LOCAL_STORAGE_KEY) !== null) {
      dumpBrowserLoggerSnapshot("invalid-setlevel-mutated-state");
    }
    expect(log.level).toBe(initialLevel);
    expect(localStorage.getItem(LOCAL_STORAGE_KEY)).toBeNull();
  });

  it("accepts string-only call signature with no bindings", () => {
    console.log(`[logger-browser:string-only-sig] emitting info with a bare string argument`);
    const log = createBrowserLogger({ service: "renderer" });
    log.info("string-only message");
    const args = infoSpy.mock.calls[0];
    try {
      expect(args[0]).toBe("[renderer]");
      expect(args[1]).toBe("string-only message");
      const payload = args[2] as Record<string, unknown>;
      expect(payload.service).toBe("renderer");
    } catch (err) {
      console.log(`[logger-browser:string-only-sig] captured args=${JSON.stringify(args)}`);
      dumpBrowserLoggerSnapshot("string-only-sig-mismatch");
      throw err;
    }
  });

  it("nested child preserves chain of bindings", () => {
    console.log(`[logger-browser:nested-child] root -> child(scope:a) -> child(stage:submit)`);
    const root = createBrowserLogger({ service: "renderer" });
    const a = root.child({ scope: "a" });
    const b = a.child({ stage: "submit" });
    b.info({}, "deep");
    const payload = infoSpy.mock.calls[0][2] as Record<string, unknown>;
    try {
      expect(payload.scope).toBe("a");
      expect(payload.stage).toBe("submit");
    } catch (err) {
      console.log(`[logger-browser:nested-child] deep payload=${JSON.stringify(payload)}`);
      dumpBrowserLoggerSnapshot("nested-child-chain-mismatch");
      throw err;
    }
  });
});
