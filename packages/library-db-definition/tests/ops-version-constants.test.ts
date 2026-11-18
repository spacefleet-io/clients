/**
 * @test-id LIB-DB-OPS-VERSION-001
 * @level unit
 * @why `ops.ts` now exports `OP_STREAM_VERSION`, `MIN_SUPPORTED_OP_STREAM_VERSION`,
 *   and `UnknownOpTypeError` as part of the Surface #2 versioning effort (Part B
 *   foundation). These constants gate op-stream compatibility checks in the
 *   Part D funnel; the error class is thrown by `buildOpStatements` when an
 *   unknown op type is encountered past the version gate. If the constants
 *   drift from 1 unexpectedly, the compatibility gate silently accepts or
 *   rejects valid streams. If `UnknownOpTypeError` has the wrong shape, the
 *   UI error handler cannot distinguish it from an unrelated crash.
 *
 *   Part B landed: `buildOpStatements` now throws `UnknownOpTypeError` on an
 *   unknown type instead of silently returning `{}`. Tests for that behaviour
 *   live in ops.test.ts (the `describe("unknown op")` block), and
 *   buildOpStatements integration with known types is covered below.
 */
import { describe, expect, it } from "vitest";
import type { LibraryOp } from "@space/shared/libraryOps";
import {
  OP_STREAM_VERSION,
  MIN_SUPPORTED_OP_STREAM_VERSION,
  UnknownOpTypeError,
  buildOpStatements,
  type IdGenerator,
} from "../src/ops";

const SUITE = "ops-version-constants";

const fixedIds = (prefix = "id"): IdGenerator => {
  let n = 0;
  return () => `${prefix}-${++n}`;
};

const dumpVersionSnapshot = (
  label: string,
  ctx: {
    expectedCurrent?: number;
    expectedMin?: number;
    note?: string;
    extra?: Record<string, unknown>;
  } = {},
) => {
  try {
    const constants = {
      OP_STREAM_VERSION,
      MIN_SUPPORTED_OP_STREAM_VERSION,
      delta: OP_STREAM_VERSION - MIN_SUPPORTED_OP_STREAM_VERSION,
      minLeqCurrent: MIN_SUPPORTED_OP_STREAM_VERSION <= OP_STREAM_VERSION,
    };
    const driftSignals = {
      currentMismatch:
        ctx.expectedCurrent !== undefined && ctx.expectedCurrent !== OP_STREAM_VERSION,
      minMismatch:
        ctx.expectedMin !== undefined && ctx.expectedMin !== MIN_SUPPORTED_OP_STREAM_VERSION,
      invariantBroken: MIN_SUPPORTED_OP_STREAM_VERSION > OP_STREAM_VERSION,
    };
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    if (ctx.note) console.error(`note: ${ctx.note}`);
    console.error(`version constants:\n${JSON.stringify(constants, null, 2)}`);
    console.error(`drift signals:\n${JSON.stringify(driftSignals, null, 2)}`);
    if (ctx.extra) console.error(`extra:\n${JSON.stringify(ctx.extra, null, 2)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

const dumpUnknownOpErrorSnapshot = (
  label: string,
  ctx: { input: string; err: UnknownOpTypeError | Error | unknown },
) => {
  try {
    const e = ctx.err as Error & { opType?: string };
    console.error(`=== [${SUITE}:${label}] UnknownOpTypeError snapshot ===`);
    console.error(`input opType: ${JSON.stringify(ctx.input)}`);
    console.error(
      `error shape:\n${JSON.stringify(
        {
          isError: e instanceof Error,
          name: e?.name,
          message: e?.message,
          opType: e?.opType,
          constructor: e?.constructor?.name,
        },
        null,
        2,
      )}`,
    );
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("op-stream version constants", () => {
  console.info(
    `[${SUITE}:setup] OP_STREAM_VERSION=${OP_STREAM_VERSION} MIN_SUPPORTED=${MIN_SUPPORTED_OP_STREAM_VERSION}`,
  );

  it("OP_STREAM_VERSION is 3 (bumped for the neutral catalog id keys, META-SRC-09)", () => {
    try {
      expect(OP_STREAM_VERSION).toBe(3);
    } catch (err) {
      dumpVersionSnapshot("op-stream-version-drift", {
        expectedCurrent: 3,
        note: "Surface #2 (op-stream) version drift — verify bump matches builder shape",
      });
      throw err;
    }
  });

  it("MIN_SUPPORTED_OP_STREAM_VERSION is 1 (still accepts pre-is_source streams)", () => {
    // v1 streams omit the is_source column; consumers fall back to DEFAULT 0
    // and the next source-job commit re-derives it. Raising this lower bound
    // would refuse legitimate v1 libraries — only do so after a deprecation
    // window long enough that no v1 publisher is in the field.
    try {
      expect(MIN_SUPPORTED_OP_STREAM_VERSION).toBe(1);
    } catch (err) {
      dumpVersionSnapshot("min-supported-drift", {
        expectedMin: 1,
        note: "Raising the floor refuses legitimate v1 libraries — was this intended?",
      });
      throw err;
    }
  });

  it("MIN_SUPPORTED_OP_STREAM_VERSION <= OP_STREAM_VERSION (invariant: min never exceeds current)", () => {
    try {
      expect(MIN_SUPPORTED_OP_STREAM_VERSION).toBeLessThanOrEqual(OP_STREAM_VERSION);
    } catch (err) {
      dumpVersionSnapshot("invariant-broken", {
        note: "INVARIANT VIOLATED: MIN_SUPPORTED > OP_STREAM_VERSION — this means no version is acceptable.",
      });
      throw err;
    }
  });
});

// ---------------------------------------------------------------------------
// UnknownOpTypeError — class contract
// ---------------------------------------------------------------------------

describe("UnknownOpTypeError — class contract", () => {
  it("is an instance of Error", () => {
    const e = new UnknownOpTypeError("foo.bar");
    try {
      expect(e).toBeInstanceOf(Error);
    } catch (err) {
      dumpUnknownOpErrorSnapshot("not-error-subclass", { input: "foo.bar", err: e });
      throw err;
    }
  });

  it("error.name is 'UnknownOpTypeError'", () => {
    const e = new UnknownOpTypeError("foo.bar");
    try {
      expect(e.name).toBe("UnknownOpTypeError");
    } catch (err) {
      dumpUnknownOpErrorSnapshot("name-mismatch", { input: "foo.bar", err: e });
      throw err;
    }
  });

  it("error.opType carries the supplied type string", () => {
    const e = new UnknownOpTypeError("foo.bar");
    try {
      expect(e.opType).toBe("foo.bar");
    } catch (err) {
      dumpUnknownOpErrorSnapshot("optype-mismatch", { input: "foo.bar", err: e });
      throw err;
    }
  });

  it("error.message is 'UNKNOWN_OP_TYPE: foo.bar'", () => {
    const e = new UnknownOpTypeError("foo.bar");
    try {
      expect(e.message).toBe("UNKNOWN_OP_TYPE: foo.bar");
    } catch (err) {
      dumpUnknownOpErrorSnapshot("message-mismatch", { input: "foo.bar", err: e });
      throw err;
    }
  });

  it("opType is preserved verbatim (no truncation or normalisation)", () => {
    const weird = "some.deeply.namespaced.op.type/v2";
    const e = new UnknownOpTypeError(weird);
    try {
      expect(e.opType).toBe(weird);
      expect(e.message).toBe(`UNKNOWN_OP_TYPE: ${weird}`);
    } catch (err) {
      dumpUnknownOpErrorSnapshot("verbatim-violation", { input: weird, err: e });
      throw err;
    }
  });

  it("empty opType string still constructs without throwing", () => {
    const err = new UnknownOpTypeError("");
    try {
      expect(err.opType).toBe("");
      expect(err.message).toBe("UNKNOWN_OP_TYPE: ");
    } catch (assertionErr) {
      dumpUnknownOpErrorSnapshot("empty-string-handling", { input: "", err });
      throw assertionErr;
    }
  });
});

// ---------------------------------------------------------------------------
// buildOpStatements — integration with UnknownOpTypeError (Part B)
// ---------------------------------------------------------------------------

describe("buildOpStatements — unknown op type throws instead of silently skipping", () => {
  it("throws UnknownOpTypeError for an unrecognised op type", () => {
    const unknown = {
      id: "op-x",
      type: "unknown.future",
      createdAt: "2024-01-01T00:00:00.000Z",
      payload: {},
    } as unknown as LibraryOp;
    console.info(`[${SUITE}:exec] expecting UnknownOpTypeError for type=${unknown.type}`);
    let thrown: unknown;
    try {
      buildOpStatements(unknown, fixedIds());
    } catch (e) {
      thrown = e;
    }
    try {
      expect(() => {
        if (thrown) throw thrown;
        else buildOpStatements(unknown, fixedIds());
      }).toThrow(UnknownOpTypeError);
    } catch (err) {
      dumpUnknownOpErrorSnapshot("did-not-throw-or-wrong-class", {
        input: unknown.type,
        err: thrown ?? "(no throw)",
      });
      throw err;
    }
  });

  it("a known op type (setting.set) does NOT throw and returns a non-empty map", () => {
    const known: LibraryOp = {
      id: "op-known",
      createdAt: "2024-01-01T00:00:00.000Z",
      type: "setting.set",
      payload: { key: "ui.theme", value: "dark", updatedAt: "2024-01-01T00:00:00.000Z" },
    };
    console.info(`[${SUITE}:exec] running buildOpStatements for known type=${known.type}`);
    let result: ReturnType<typeof buildOpStatements> | undefined;
    let thrown: unknown;
    try {
      result = buildOpStatements(known, fixedIds());
    } catch (e) {
      thrown = e;
    }
    console.info(
      `[${SUITE}:exec] result-defined=${result !== undefined} group-count=${result ? Object.keys(result).length : "n/a"} threw=${thrown !== undefined}`,
    );
    try {
      expect(thrown).toBeUndefined();
      expect(result).toBeDefined();
      expect(Object.keys(result!).length).toBeGreaterThan(0);
    } catch (err) {
      dumpVersionSnapshot("known-op-unexpectedly-failed", {
        note: `known op type=${known.type} did not behave as expected`,
        extra: {
          threw: thrown instanceof Error ? thrown.message : String(thrown),
          resultKeys: result ? Object.keys(result) : null,
        },
      });
      throw err;
    }
  });
});
