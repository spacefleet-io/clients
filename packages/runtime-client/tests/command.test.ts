import { describe, it, expect, vi, type Mock } from "vitest";
import type { RuntimeFetch } from "../src/fetch";
import { z } from "zod";
import { createRuntimeCommandClient } from "../src/command";
import { createRuntimeSession } from "../src/session";
import { RuntimeCommandFailedError } from "../src/errors";
import { defineCommand } from "@space/runtime-contracts/helpers";

const SUITE = "runtime-client-command";
const BASE_URL = "http://127.0.0.1:3020";

const testContract = defineCommand({
  name: "test.echo",
  module: "badger",
  payloadSchema: z.object({ value: z.string() }),
  resultSchema: z.object({ echoed: z.string() }),
});

const fakeLoginResponse = (token = "rt-token") =>
  new Response(
    JSON.stringify({
      ok: true,
      token,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      capabilities: { apps: ["badger"] },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const fakeCommandResponse = (result: Record<string, unknown>) =>
  new Response(
    JSON.stringify({ requestId: "r1", ok: true, result, error: null }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const fakeErrorResponse = (code: string, message: string, status = 400) =>
  new Response(
    JSON.stringify({
      requestId: "r1",
      ok: false,
      result: null,
      error: { code, message, retryable: false, details: {} },
    }),
    { status, headers: { "content-type": "application/json" } },
  );

const summarizeFetchTrace = (fetchMock: ReturnType<typeof vi.fn>) => {
  try {
    return fetchMock.mock.calls.map((call, idx) => {
      const [url, init] = call as [unknown, unknown];
      const initRecord = (init && typeof init === "object" ? init : {}) as {
        method?: unknown;
        headers?: unknown;
        body?: unknown;
      };
      let parsedBody: unknown = initRecord.body ?? null;
      if (typeof parsedBody === "string" && parsedBody.length > 0) {
        try {
          parsedBody = JSON.parse(parsedBody);
        } catch {
          // leave as string
        }
      }
      let summary: Record<string, unknown> = {
        idx,
        url,
        method: initRecord.method ?? "GET",
      };
      if (parsedBody && typeof parsedBody === "object") {
        const body = parsedBody as Record<string, unknown>;
        if ("module" in body || "command" in body || "requestId" in body) {
          summary = {
            ...summary,
            requestId: body.requestId,
            module: body.module,
            command: body.command,
            payloadKeys:
              body.payload && typeof body.payload === "object"
                ? Object.keys(body.payload as object)
                : null,
          };
        } else {
          summary.body = parsedBody;
        }
      }
      return summary;
    });
  } catch (err) {
    return `(fetch-trace failed: ${err instanceof Error ? err.message : String(err)})`;
  }
};

const dumpCommandSnapshot = (
  label: string,
  ctx: {
    fetchMock: ReturnType<typeof vi.fn>;
    contract?: { name: string; module: string };
    request?: unknown;
    result?: unknown;
    error?: unknown;
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    if (ctx.contract) {
      console.error(
        `contract: name=${ctx.contract.name} module=${ctx.contract.module}`,
      );
    }
    if (ctx.request !== undefined) {
      console.error(`request payload:\n${JSON.stringify(ctx.request, null, 2)}`);
    }
    if (ctx.result !== undefined) {
      console.error(`result envelope:\n${JSON.stringify(ctx.result, null, 2)}`);
    }
    if (ctx.error) {
      const err = ctx.error as { code?: unknown; message?: unknown; name?: unknown };
      console.error(
        `thrown error: name=${err.name} code=${err.code} message=${err.message}`,
      );
    }
    console.error(`fetch call count: ${ctx.fetchMock.mock.calls.length}`);
    console.error(
      `fetch trace:\n${JSON.stringify(summarizeFetchTrace(ctx.fetchMock), null, 2)}`,
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

const makeClient = (fetchMock: Mock<RuntimeFetch>) => {
  const session = createRuntimeSession({
    runtimeBaseUrl: BASE_URL,
    backendToken: "backend-abc",
    apps: ["badger"],
    fetchImpl: fetchMock,
  });
  return createRuntimeCommandClient({
    session,
    runtimeBaseUrl: BASE_URL,
    fetchImpl: fetchMock,
    requestIdPrefix: "test",
  });
};

describe("createRuntimeCommandClient", () => {
  console.info(
    `[${SUITE}:setup] BASE_URL=${BASE_URL} contract=${testContract.name} module=${testContract.module}`,
  );

  it("sends a command and returns the validated result", async () => {
    console.info(`[${SUITE}:send] preparing happy-path login + command response`);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fakeLoginResponse())
      .mockResolvedValueOnce(fakeCommandResponse({ echoed: "hello" }));
    const client = makeClient(fetchMock);

    let result: unknown;
    try {
      result = await client.sendCommand(testContract, { value: "hello" });
      expect(result).toEqual({ echoed: "hello" });

      // Verify the command request
      const commandCall = fetchMock.mock.calls[1];
      expect(commandCall[0]).toBe(`${BASE_URL}/modules/badger/commands`);
      const body = JSON.parse(commandCall[1].body);
      expect(body.module).toBe("badger");
      expect(body.command).toBe("test.echo");
      expect(body.payload).toEqual({ value: "hello" });
      expect(body.requestId).toMatch(/^test-test\.echo-/);
      console.info(
        `[${SUITE}:send] OK requestId=${body.requestId} command=${body.command}`,
      );
    } catch (err) {
      dumpCommandSnapshot("send-happy-path-failure", {
        fetchMock,
        contract: { name: testContract.name, module: testContract.module },
        request: { value: "hello" },
        result,
      });
      throw err;
    }
  });

  it("throws RuntimeCommandFailedError on invalid payload", async () => {
    console.info(`[${SUITE}:invalid-payload] sending payload with wrong type`);
    const fetchMock = vi.fn().mockResolvedValueOnce(fakeLoginResponse());
    const client = makeClient(fetchMock);

    try {
      await expect(
        client.sendCommand(testContract, { value: 123 } as any),
      ).rejects.toThrow(RuntimeCommandFailedError);

      // Only login call, no command call — payload validation happens client-side
      expect(fetchMock).toHaveBeenCalledTimes(0);
      console.info(`[${SUITE}:invalid-payload] OK no network call made`);
    } catch (err) {
      dumpCommandSnapshot("invalid-payload-leaked-network-call", {
        fetchMock,
        contract: { name: testContract.name, module: testContract.module },
        request: { value: 123 },
      });
      throw err;
    }
  });

  it("throws RuntimeCommandFailedError on server error response", async () => {
    console.info(
      `[${SUITE}:server-error] preparing error envelope { code: invalid_payload }`,
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fakeLoginResponse())
      .mockResolvedValueOnce(fakeErrorResponse("invalid_payload", "bad input"));
    const client = makeClient(fetchMock);

    let captured: unknown;
    try {
      await client.sendCommand(testContract, { value: "hello" });
      expect.unreachable("should have thrown");
    } catch (error) {
      captured = error;
      try {
        expect(error).toBeInstanceOf(RuntimeCommandFailedError);
        const e = error as RuntimeCommandFailedError;
        expect(e.code).toBe("invalid_payload");
        expect(e.message).toBe("bad input");
        console.info(
          `[${SUITE}:server-error] OK code=${e.code} message="${e.message}"`,
        );
      } catch (assertionErr) {
        dumpCommandSnapshot("server-error-shape-mismatch", {
          fetchMock,
          contract: { name: testContract.name, module: testContract.module },
          request: { value: "hello" },
          error: captured,
        });
        throw assertionErr;
      }
    }
  });

  it("retries once on 401", async () => {
    console.info(
      `[${SUITE}:retry-401] sequence: login, command→401, re-login, command→200`,
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fakeLoginResponse("token-1"))
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      // re-login
      .mockResolvedValueOnce(fakeLoginResponse("token-2"))
      // retry command
      .mockResolvedValueOnce(fakeCommandResponse({ echoed: "retry" }));
    const client = makeClient(fetchMock);

    let result: unknown;
    try {
      result = await client.sendCommand(testContract, { value: "retry" });
      expect(result).toEqual({ echoed: "retry" });
      expect(fetchMock).toHaveBeenCalledTimes(4); // login + 401 + re-login + success
      console.info(
        `[${SUITE}:retry-401] OK fetchCalls=${fetchMock.mock.calls.length}`,
      );
    } catch (err) {
      dumpCommandSnapshot("retry-401-flow-broken", {
        fetchMock,
        contract: { name: testContract.name, module: testContract.module },
        request: { value: "retry" },
        result,
      });
      throw err;
    }
  });

  it("throws on result schema mismatch", async () => {
    console.info(
      `[${SUITE}:schema-mismatch] returning { wrong_field: 42 } where { echoed: string } is required`,
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fakeLoginResponse())
      .mockResolvedValueOnce(fakeCommandResponse({ wrong_field: 42 }));
    const client = makeClient(fetchMock);

    let captured: unknown;
    try {
      await client.sendCommand(testContract, { value: "hello" });
      expect.unreachable("should have thrown");
    } catch (error) {
      captured = error;
      try {
        expect(error).toBeInstanceOf(RuntimeCommandFailedError);
        const e = error as RuntimeCommandFailedError;
        expect(e.code).toBe("invalid_result_schema");
        expect(e.message).toContain("test.echo");
        console.info(
          `[${SUITE}:schema-mismatch] OK code=${e.code} message contains command name`,
        );
      } catch (assertionErr) {
        dumpCommandSnapshot("schema-mismatch-not-detected", {
          fetchMock,
          contract: { name: testContract.name, module: testContract.module },
          request: { value: "hello" },
          error: captured,
        });
        throw assertionErr;
      }
    }
  });

  it("strips unknown fields from result (Zod default)", async () => {
    console.info(
      `[${SUITE}:strip-extra] returning { echoed: "hi", extraField: true } expect extra dropped`,
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fakeLoginResponse())
      .mockResolvedValueOnce(
        fakeCommandResponse({ echoed: "hi", extraField: true }),
      );
    const client = makeClient(fetchMock);

    let result: unknown;
    try {
      result = await client.sendCommand(testContract, { value: "hi" });
      expect(result).toEqual({ echoed: "hi" });
      expect((result as any).extraField).toBeUndefined();
      console.info(`[${SUITE}:strip-extra] OK keys=${Object.keys(result as object)}`);
    } catch (err) {
      dumpCommandSnapshot("strip-extra-fields-leaked", {
        fetchMock,
        contract: { name: testContract.name, module: testContract.module },
        request: { value: "hi" },
        result,
      });
      throw err;
    }
  });

  it("throws on invalid response envelope", async () => {
    console.info(
      `[${SUITE}:invalid-envelope] returning { garbage: true } as command response`,
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fakeLoginResponse())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ garbage: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const client = makeClient(fetchMock);

    let captured: unknown;
    try {
      await client.sendCommand(testContract, { value: "hello" });
      expect.unreachable("should have thrown");
    } catch (error) {
      captured = error;
      try {
        expect(error).toBeInstanceOf(RuntimeCommandFailedError);
        expect((error as RuntimeCommandFailedError).code).toBe(
          "invalid_response_envelope",
        );
        console.info(`[${SUITE}:invalid-envelope] OK code=invalid_response_envelope`);
      } catch (assertionErr) {
        dumpCommandSnapshot("invalid-envelope-not-detected", {
          fetchMock,
          contract: { name: testContract.name, module: testContract.module },
          request: { value: "hello" },
          error: captured,
        });
        throw assertionErr;
      }
    }
  });
});
