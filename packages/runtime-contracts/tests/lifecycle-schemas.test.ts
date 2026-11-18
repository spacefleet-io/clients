import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  runtimeConnectRequestSchema,
  runtimeConnectResponseSchema,
  runtimeDisconnectRequestSchema,
  runtimeDisconnectResponseSchema,
  runtimeLoginRequestSchema,
  lifecycleAppConnectedPayloadSchema,
  lifecycleAppDisconnectedPayloadSchema,
} from "../src/lifecycle";

const SUITE = "lifecycle-schemas";

const SUPPORTED_LIFECYCLE_EVENTS = [
  "app_connected",
  "app_disconnected",
] as const;

const dumpLifecycleSnapshot = (
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
      `lifecycle event shape:\n${JSON.stringify(
        {
          keys:
            ctx.input && typeof ctx.input === "object"
              ? Object.keys(ctx.input as object)
              : undefined,
          raw: ctx.input,
        },
        null,
        2,
      )}`,
    );
    console.error(
      `parse result:\n${JSON.stringify(
        {
          success: ctx.safeParse.success,
          data: ctx.safeParse.success ? ctx.safeParse.data : undefined,
          issues: ctx.safeParse.success ? null : ctx.safeParse.error.issues,
        },
        null,
        2,
      )}`,
    );
    console.error(
      `supported lifecycle events: ${JSON.stringify(SUPPORTED_LIFECYCLE_EVENTS)}`,
    );
    if (ctx.extra) {
      console.error(`extra:\n${JSON.stringify(ctx.extra, null, 2)}`);
    }
  } catch (err) {
    console.error(
      `(snapshot failed: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
};

describe("lifecycle schemas", () => {
  console.info(
    `[${SUITE}:setup] supportedEvents=${JSON.stringify(SUPPORTED_LIFECYCLE_EVENTS)}`,
  );

  describe("runtimeConnectRequest", () => {
    it("accepts valid connect request", () => {
      const input = { appName: "badger", pid: 12345 };
      const result = runtimeConnectRequestSchema.safeParse(input);
      try {
        expect(result.success).toBe(true);
      } catch (err) {
        dumpLifecycleSnapshot("connect-request-valid-rejected", {
          schemaName: "runtimeConnectRequestSchema",
          input,
          safeParse: result,
        });
        throw err;
      }
    });

    it("rejects empty appName", () => {
      const input = { appName: "", pid: 12345 };
      const result = runtimeConnectRequestSchema.safeParse(input);
      try {
        expect(result.success).toBe(false);
      } catch (err) {
        dumpLifecycleSnapshot("connect-request-empty-app-accepted", {
          schemaName: "runtimeConnectRequestSchema",
          input,
          safeParse: result,
          note: "appName has min(1)",
        });
        throw err;
      }
    });

    it("rejects missing pid", () => {
      const input = { appName: "badger" };
      const result = runtimeConnectRequestSchema.safeParse(input);
      try {
        expect(result.success).toBe(false);
      } catch (err) {
        dumpLifecycleSnapshot("connect-request-missing-pid-accepted", {
          schemaName: "runtimeConnectRequestSchema",
          input,
          safeParse: result,
        });
        throw err;
      }
    });

    it("rejects negative pid", () => {
      const input = { appName: "badger", pid: -1 };
      const result = runtimeConnectRequestSchema.safeParse(input);
      try {
        expect(result.success).toBe(false);
      } catch (err) {
        dumpLifecycleSnapshot("connect-request-negative-pid-accepted", {
          schemaName: "runtimeConnectRequestSchema",
          input,
          safeParse: result,
          note: "pid must be a positive integer",
        });
        throw err;
      }
    });
  });

  describe("runtimeConnectResponse", () => {
    it("accepts valid response", () => {
      const input = {
        connectionId: "conn_abc",
        connectedApps: [
          {
            connectionId: "conn_abc",
            appName: "badger",
            connectedAt: "2026-03-28T00:00:00Z",
          },
        ],
      };
      const result = runtimeConnectResponseSchema.safeParse(input);
      try {
        expect(result.success).toBe(true);
      } catch (err) {
        dumpLifecycleSnapshot("connect-response-rejected", {
          schemaName: "runtimeConnectResponseSchema",
          input,
          safeParse: result,
        });
        throw err;
      }
    });
  });

  describe("runtimeDisconnectRequest", () => {
    it("accepts valid disconnect request", () => {
      const input = { connectionId: "conn_abc" };
      const result = runtimeDisconnectRequestSchema.safeParse(input);
      try {
        expect(result.success).toBe(true);
      } catch (err) {
        dumpLifecycleSnapshot("disconnect-request-rejected", {
          schemaName: "runtimeDisconnectRequestSchema",
          input,
          safeParse: result,
        });
        throw err;
      }
    });

    it("rejects empty connectionId", () => {
      const input = { connectionId: "" };
      const result = runtimeDisconnectRequestSchema.safeParse(input);
      try {
        expect(result.success).toBe(false);
      } catch (err) {
        dumpLifecycleSnapshot("disconnect-request-empty-conn-accepted", {
          schemaName: "runtimeDisconnectRequestSchema",
          input,
          safeParse: result,
          note: "connectionId has min(1)",
        });
        throw err;
      }
    });
  });

  describe("runtimeDisconnectResponse", () => {
    it("accepts valid response", () => {
      const input = { ok: true, remaining: 0 };
      const result = runtimeDisconnectResponseSchema.safeParse(input);
      try {
        expect(result.success).toBe(true);
      } catch (err) {
        dumpLifecycleSnapshot("disconnect-response-rejected", {
          schemaName: "runtimeDisconnectResponseSchema",
          input,
          safeParse: result,
        });
        throw err;
      }
    });

    it("rejects negative remaining", () => {
      const input = { ok: true, remaining: -1 };
      const result = runtimeDisconnectResponseSchema.safeParse(input);
      try {
        expect(result.success).toBe(false);
      } catch (err) {
        dumpLifecycleSnapshot("disconnect-response-negative-remaining-accepted", {
          schemaName: "runtimeDisconnectResponseSchema",
          input,
          safeParse: result,
          note: "remaining must be a non-negative integer",
        });
        throw err;
      }
    });
  });

  describe("runtimeLoginRequest", () => {
    it("accepts valid login", () => {
      const input = { backendToken: "tok_123" };
      const result = runtimeLoginRequestSchema.safeParse(input);
      try {
        expect(result.success).toBe(true);
      } catch (err) {
        dumpLifecycleSnapshot("login-valid-rejected", {
          schemaName: "runtimeLoginRequestSchema",
          input,
          safeParse: result,
        });
        throw err;
      }
    });

    it("accepts login with apps", () => {
      const input = { backendToken: "tok_123", apps: ["badger", "parrot"] };
      const result = runtimeLoginRequestSchema.safeParse(input);
      try {
        expect(result.success).toBe(true);
      } catch (err) {
        dumpLifecycleSnapshot("login-with-apps-rejected", {
          schemaName: "runtimeLoginRequestSchema",
          input,
          safeParse: result,
        });
        throw err;
      }
    });

    it("rejects empty backendToken", () => {
      const input = { backendToken: "" };
      const result = runtimeLoginRequestSchema.safeParse(input);
      try {
        expect(result.success).toBe(false);
      } catch (err) {
        dumpLifecycleSnapshot("login-empty-token-accepted", {
          schemaName: "runtimeLoginRequestSchema",
          input,
          safeParse: result,
        });
        throw err;
      }
    });

    it("rejects missing backendToken", () => {
      const input = {};
      const result = runtimeLoginRequestSchema.safeParse(input);
      try {
        expect(result.success).toBe(false);
      } catch (err) {
        dumpLifecycleSnapshot("login-missing-token-accepted", {
          schemaName: "runtimeLoginRequestSchema",
          input,
          safeParse: result,
        });
        throw err;
      }
    });
  });

  describe("lifecycle event payloads", () => {
    it("validates app_connected payload", () => {
      const input = { appName: "badger", connectionId: "conn_abc" };
      const result = lifecycleAppConnectedPayloadSchema.safeParse(input);
      try {
        expect(result.success).toBe(true);
      } catch (err) {
        dumpLifecycleSnapshot("app-connected-rejected", {
          schemaName: "lifecycleAppConnectedPayloadSchema",
          input,
          safeParse: result,
        });
        throw err;
      }
    });

    it("validates app_disconnected payload", () => {
      const input = {
        appName: "parrot",
        connectionId: "conn_def",
        remainingCount: 1,
      };
      const result = lifecycleAppDisconnectedPayloadSchema.safeParse(input);
      try {
        expect(result.success).toBe(true);
      } catch (err) {
        dumpLifecycleSnapshot("app-disconnected-rejected", {
          schemaName: "lifecycleAppDisconnectedPayloadSchema",
          input,
          safeParse: result,
        });
        throw err;
      }
    });
  });
});
