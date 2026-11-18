import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  appIdSchema,
  runtimeCommandRequestSchema,
  runtimeCommandResponseSchema,
  runtimeErrorCodeSchema,
  runtimeErrorEnvelopeSchema,
  runtimeEventFrameSchema,
  wsClientFrameSchema,
} from "../src/envelope";

const SUITE = "envelope";

const summarizeRequest = (raw: unknown) => {
  if (!raw || typeof raw !== "object") return { kind: typeof raw, raw };
  const r = raw as Record<string, unknown>;
  return {
    keys: Object.keys(r),
    requestId: r.requestId,
    module: r.module,
    command: r.command,
    payloadKeys:
      r.payload && typeof r.payload === "object"
        ? Object.keys(r.payload as object)
        : null,
  };
};

const dumpEnvelopeSnapshot = (
  label: string,
  ctx: {
    schemaName: string;
    input: unknown;
    safeParse: z.ZodSafeParseResult<unknown>;
    note?: string;
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    if (ctx.note) console.error(`note: ${ctx.note}`);
    console.error(`schema under test: ${ctx.schemaName}`);
    console.error(
      `envelope shape:\n${JSON.stringify(summarizeRequest(ctx.input), null, 2)}`,
    );
    console.error(`raw input:\n${JSON.stringify(ctx.input, null, 2)}`);
    console.error(
      `parse result:\n${JSON.stringify(
        {
          success: ctx.safeParse.success,
          data: ctx.safeParse.success ? ctx.safeParse.data : undefined,
        },
        null,
        2,
      )}`,
    );
    if (!ctx.safeParse.success) {
      console.error(
        `error tree (issues):\n${JSON.stringify(
          ctx.safeParse.error.issues,
          null,
          2,
        )}`,
      );
      console.error(
        `error format:\n${JSON.stringify(ctx.safeParse.error.format(), null, 2)}`,
      );
    }
    if (ctx.extra) {
      console.error(`extra:\n${JSON.stringify(ctx.extra, null, 2)}`);
    }
  } catch (err) {
    console.error(
      `(snapshot failed: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
};

describe("envelope schemas", () => {
  console.info(
    `[${SUITE}:setup] schemas=${JSON.stringify([
      "appIdSchema",
      "runtimeErrorCodeSchema",
      "runtimeCommandRequestSchema",
      "runtimeCommandResponseSchema",
      "wsClientFrameSchema",
      "runtimeEventFrameSchema",
      "runtimeErrorEnvelopeSchema",
    ])}`,
  );

  it("validates app IDs", () => {
    const badger = appIdSchema.safeParse("badger");
    const parrot = appIdSchema.safeParse("parrot");
    const unknown = appIdSchema.safeParse("unknown");
    try {
      expect(badger.success).toBe(true);
      expect(parrot.success).toBe(true);
      expect(unknown.success).toBe(false);
    } catch (err) {
      dumpEnvelopeSnapshot("app-id-validation-drift", {
        schemaName: "appIdSchema",
        input: { badger: "badger", parrot: "parrot", unknown: "unknown" },
        safeParse: unknown,
        extra: {
          badgerOk: badger.success,
          parrotOk: parrot.success,
          unknownOk: unknown.success,
        },
        note: "app-id enum should be exactly {badger, parrot}",
      });
      throw err;
    }
  });

  it("validates error codes", () => {
    const ok = runtimeErrorCodeSchema.safeParse("invalid_payload");
    const bad = runtimeErrorCodeSchema.safeParse("made_up");
    try {
      expect(ok.success).toBe(true);
      expect(bad.success).toBe(false);
    } catch (err) {
      dumpEnvelopeSnapshot("error-code-enum-drift", {
        schemaName: "runtimeErrorCodeSchema",
        input: { valid: "invalid_payload", invalid: "made_up" },
        safeParse: bad,
        extra: { validOk: ok.success, invalidOk: bad.success },
      });
      throw err;
    }
  });

  it("validates a successful command response", () => {
    const input = {
      requestId: "req-1",
      ok: true,
      result: { version: 1 },
      error: null,
    };
    const res = runtimeCommandResponseSchema.safeParse(input);
    try {
      expect(res.success).toBe(true);
    } catch (err) {
      dumpEnvelopeSnapshot("success-response-rejected", {
        schemaName: "runtimeCommandResponseSchema",
        input,
        safeParse: res,
      });
      throw err;
    }
  });

  it("validates an error command response", () => {
    const input = {
      requestId: "req-1",
      ok: false,
      result: null,
      error: {
        code: "invalid_payload",
        message: "token is required",
        retryable: false,
        details: {},
      },
    };
    const res = runtimeCommandResponseSchema.safeParse(input);
    try {
      expect(res.success).toBe(true);
    } catch (err) {
      dumpEnvelopeSnapshot("error-response-rejected", {
        schemaName: "runtimeCommandResponseSchema",
        input,
        safeParse: res,
      });
      throw err;
    }
  });

  it("rejects malformed command response", () => {
    const input = { ok: "yes" };
    const res = runtimeCommandResponseSchema.safeParse(input);
    try {
      expect(res.success).toBe(false);
    } catch (err) {
      dumpEnvelopeSnapshot("malformed-response-accepted", {
        schemaName: "runtimeCommandResponseSchema",
        input,
        safeParse: res,
        note: "ok must be boolean (literal); 'yes' should fail",
      });
      throw err;
    }
  });

  it("validates a command request", () => {
    const input = {
      requestId: "r1",
      module: "badger",
      command: "badger.db.open",
      payload: { token: "abc", keyBase64: "xyz" },
    };
    const req = runtimeCommandRequestSchema.safeParse(input);
    try {
      expect(req.success).toBe(true);
    } catch (err) {
      dumpEnvelopeSnapshot("command-request-rejected", {
        schemaName: "runtimeCommandRequestSchema",
        input,
        safeParse: req,
      });
      throw err;
    }
  });

  it("validates WebSocket subscribe frame", () => {
    const input = {
      type: "subscribe",
      apps: ["badger"],
      channels: ["library"],
    };
    const frame = wsClientFrameSchema.safeParse(input);
    try {
      expect(frame.success).toBe(true);
    } catch (err) {
      dumpEnvelopeSnapshot("ws-subscribe-frame-rejected", {
        schemaName: "wsClientFrameSchema",
        input,
        safeParse: frame,
      });
      throw err;
    }
  });

  it("validates runtime event frame", () => {
    const input = {
      eventId: "evt-1",
      sequence: 1,
      app: "parrot",
      channel: "sync",
      event: "sync.progress",
      ts: "2026-01-01T00:00:00Z",
      payload: { pending: 5 },
    };
    const frame = runtimeEventFrameSchema.safeParse(input);
    try {
      expect(frame.success).toBe(true);
    } catch (err) {
      dumpEnvelopeSnapshot("event-frame-rejected", {
        schemaName: "runtimeEventFrameSchema",
        input,
        safeParse: frame,
      });
      throw err;
    }
  });

  it("validates error envelope", () => {
    const input = {
      code: "internal_error",
      message: "something went wrong",
      retryable: true,
      details: { stack: "..." },
    };
    const env = runtimeErrorEnvelopeSchema.safeParse(input);
    try {
      expect(env.success).toBe(true);
    } catch (err) {
      dumpEnvelopeSnapshot("error-envelope-rejected", {
        schemaName: "runtimeErrorEnvelopeSchema",
        input,
        safeParse: env,
      });
      throw err;
    }
  });
});
