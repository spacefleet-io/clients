/**
 * @req RT-CMD-05
 * @bugfix desktop-rotate-export-bytes
 * @why `badger.db.call exportBytes` answered through `c.json`, so the library image reached Badger desktop as an
 *      index-keyed object and every key rotation failed. The route now decodes tagged bytes in the payload and tags
 *      bytes in the result, the remembered (idempotent) answer included.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import { decodeWireBytes } from "@space/runtime-contracts/wireBytes";
import { createApp } from "../src/app";
import { ownerLoginGate, runtimeState } from "../src/runtime";
import { resetModulesForTests, setBadgerModuleForTests } from "../src/modules";
import type { BadgerModule } from "../src/modules/badger";

const SUITE = "runtime-wire-bytes";
const IMAGE = [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0, 255];

const login = async (app: Hono) => {
  const res = await app.request("/runtime/session/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-runtime-owner": ownerLoginGate.secret },
    body: JSON.stringify({ backendToken: "api_token", apps: ["badger"] }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
};

describe("runtime command route carries bytes [runtime-wire-bytes] @req RT-CMD-05", () => {
  beforeEach(() => {
    runtimeState.resetForTests();
    resetModulesForTests();
  });

  it("a tagged payload reaches the module as a Uint8Array and a byte result goes back tagged, resend included", async () => {
    const seen: unknown[] = [];
    const execute = vi.fn(async (req: { requestId: string; payload: { args: unknown[] } }) => {
      seen.push(req.payload.args[0]);
      return { response: { requestId: req.requestId, ok: true, result: new Uint8Array(IMAGE), error: null } };
    });
    setBadgerModuleForTests({
      execute,
      shutdown: vi.fn(),
      setEventPublisher: vi.fn(),
      getStateSummary: vi.fn(() => null),
    } as unknown as BadgerModule);
    const app = createApp();
    const token = await login(app);
    const body = JSON.stringify({
      requestId: "req-bytes",
      module: "badger",
      command: "badger.db.call",
      payload: { method: "exportBytes", args: [{ __sfWireBytes: Buffer.from([1, 2, 3]).toString("base64") }] },
    });
    const post = () =>
      app.request("/modules/badger/commands", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body,
      });

    const first = await post();
    const firstBody = (await first.json()) as { ok: boolean; result: unknown };
    const second = (await (await post()).json()) as { result: unknown };
    console.info(
      `[${SUITE}:roundtrip] status=${first.status} arg=${Object.prototype.toString.call(seen[0])} result=${JSON.stringify(firstBody.result)} executes=${execute.mock.calls.length}`
    );

    expect(first.status).toBe(200);
    expect(seen[0]).toBeInstanceOf(Uint8Array);
    expect(Array.from(seen[0] as Uint8Array)).toEqual([1, 2, 3]);
    expect(firstBody.result).toEqual({ __sfWireBytes: Buffer.from(IMAGE).toString("base64") });
    expect(Array.from(decodeWireBytes(firstBody.result) as Uint8Array)).toEqual(IMAGE);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(second.result).toEqual(firstBody.result);
  });
});
