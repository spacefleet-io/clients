import { describe, expect, it, vi } from "vitest";
import { RUNTIME_OWNER_HEADER } from "@space/runtime-contracts/lifecycle";
import { ToolAccessError, requestToolAccess } from "../src/client";
import type { RuntimeFetch } from "../src/fetch";

const SUITE = "runtime-client-tool-access";
const BASE = "http://127.0.0.1:3020";
const GRANT_EXPIRES = "2030-01-01T08:00:00.000Z";

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const created = (expiresAt = "2030-01-01T00:02:00.000Z") =>
  reply(200, { requestId: "ar_1", pollSecret: "secret-secret", verificationCode: "042731", expiresAt });
const approved = () =>
  reply(200, {
    token: "rt_tool",
    expiresAt: GRANT_EXPIRES,
    grantId: "gr_1",
    mode: "read",
    allowedOps: ["listMedia"],
  });

/** A runtime double that answers the calls in order and records them. */
const runtimeDouble = (answers: Array<() => Response>) => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl: RuntimeFetch = async (url, init) => {
    calls.push({ url, init });
    const next = answers.shift();
    if (!next) throw new Error(`unexpected call to ${url}`);
    return next();
  };
  return { fetchImpl, calls };
};

const fastOptions = (fetchImpl: RuntimeFetch) => ({
  baseUrl: BASE,
  toolName: "my-cli",
  mode: "read" as const,
  fetchImpl,
  pollIntervalMs: 1,
  clock: () => Date.parse("2030-01-01T00:00:00.000Z"),
});

describe("requestToolAccess (DEV-LIB-01)", () => {
  it("shows the verification code, polls while pending, and returns a token provider", async () => {
    const { fetchImpl, calls } = runtimeDouble([created, () => reply(202, { status: "pending" }), () => reply(202, { status: "pending" }), approved]);
    const onVerificationCode = vi.fn();
    const provider = await requestToolAccess({ ...fastOptions(fetchImpl), reason: "sync", onVerificationCode });
    console.info(`[${SUITE}:ok] ${calls.length} calls`);
    expect(onVerificationCode).toHaveBeenCalledExactlyOnceWith("042731");
    expect(await provider.getToken()).toBe("rt_tool");
    expect(provider).toMatchObject({ grantId: "gr_1", mode: "read", allowedOps: ["listMedia"] });
    expect(calls.map((call) => call.url)).toEqual([
      `${BASE}/runtime/access/request`,
      `${BASE}/runtime/access/requests/ar_1/token`,
      `${BASE}/runtime/access/requests/ar_1/token`,
      `${BASE}/runtime/access/requests/ar_1/token`,
    ]);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ toolName: "my-cli", mode: "read", reason: "sync" });
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ pollSecret: "secret-secret" });
  });

  it("never sends the owner secret, a session token or an Origin", async () => {
    const { fetchImpl, calls } = runtimeDouble([created, approved]);
    await requestToolAccess({ ...fastOptions(fetchImpl), onVerificationCode: () => undefined });
    for (const call of calls) {
      const headers = new Headers(call.init?.headers);
      expect(headers.has(RUNTIME_OWNER_HEADER)).toBe(false);
      expect(headers.has("authorization")).toBe(false);
      expect(headers.has("origin")).toBe(false);
    }
  });

  it("rejects with `denied` when the user denies", async () => {
    const { fetchImpl } = runtimeDouble([created, () => reply(403, { error: "denied", message: "The user denied this request." })]);
    const failure = await requestToolAccess({ ...fastOptions(fetchImpl), onVerificationCode: () => undefined }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ToolAccessError);
    expect(failure).toMatchObject({ code: "denied", httpStatus: 403 });
  });

  it("rejects with `no_app_connected` and a message that says to open SpaceFleet", async () => {
    const { fetchImpl } = runtimeDouble([
      () => reply(409, { error: "no_app_connected", message: "Open SpaceFleet, then try again." }),
    ]);
    const onVerificationCode = vi.fn();
    const failure = await requestToolAccess({ ...fastOptions(fetchImpl), onVerificationCode }).catch((e: unknown) => e);
    expect(failure).toMatchObject({ code: "no_app_connected", message: expect.stringMatching(/open spacefleet/i) });
    expect(onVerificationCode).not.toHaveBeenCalled();
  });

  it("rejects with `expired` when the runtime says 410, or the request ran out while polling", async () => {
    const gone = runtimeDouble([created, () => reply(410, { error: "expired", message: "This request expired." })]);
    expect(await requestToolAccess({ ...fastOptions(gone.fetchImpl), onVerificationCode: () => undefined }).catch((e: unknown) => e)).toMatchObject({
      code: "expired",
    });

    let now = Date.parse("2030-01-01T00:00:00.000Z");
    const slow = runtimeDouble([() => created(), ...[1, 2, 3].map(() => () => reply(202, { status: "pending" }))]);
    const failure = await requestToolAccess({
      ...fastOptions(slow.fetchImpl),
      clock: () => {
        const at = now;
        now += 90_000;
        return at;
      },
      onVerificationCode: () => undefined,
    }).catch((e: unknown) => e);
    expect(failure).toMatchObject({ code: "expired" });
  });

  it("maps an unknown failure to `request_failed` without leaking the poll secret", async () => {
    const { fetchImpl } = runtimeDouble([() => reply(500, "boom")]);
    const failure = await requestToolAccess({ ...fastOptions(fetchImpl), onVerificationCode: () => undefined }).catch((e: unknown) => e);
    expect(failure).toMatchObject({ code: "request_failed", httpStatus: 500 });
    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof Error ? failure.message : "").not.toContain("secret-secret");
  });

  it("reports an unreachable runtime", async () => {
    const fetchImpl: RuntimeFetch = async () => {
      throw new TypeError("connect ECONNREFUSED");
    };
    const failure = await requestToolAccess({ ...fastOptions(fetchImpl), onVerificationCode: () => undefined }).catch((e: unknown) => e);
    expect(failure).toMatchObject({ code: "request_failed" });
  });

  it("stops polling when the caller aborts", async () => {
    const controller = new AbortController();
    const { fetchImpl, calls } = runtimeDouble([created, () => reply(202, { status: "pending" })]);
    const pending = requestToolAccess({
      ...fastOptions(fetchImpl),
      pollIntervalMs: 60_000,
      signal: controller.signal,
      onVerificationCode: () => controller.abort(),
    });
    expect(await pending.catch((e: unknown) => e)).toMatchObject({ code: "aborted" });
    expect(calls.length).toBeLessThanOrEqual(2);
  });

  it("hands out the token only until the grant expires", async () => {
    let now = Date.parse("2030-01-01T00:00:00.000Z");
    const { fetchImpl } = runtimeDouble([created, approved]);
    const provider = await requestToolAccess({ ...fastOptions(fetchImpl), clock: () => now, onVerificationCode: () => undefined });
    expect(await provider.getToken()).toBe("rt_tool");
    now = Date.parse(GRANT_EXPIRES) + 1;
    await expect(provider.getToken()).rejects.toMatchObject({ code: "expired" });
  });
});
