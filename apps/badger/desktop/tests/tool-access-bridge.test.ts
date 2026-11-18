/**
 * DEV-LIB-01: the desktop's tool access bridge ends every grant when the user signs out, using the runtime session
 * it held while signed in (the tools were approved for that user only).
 */
import { describe, expect, it, vi } from "vitest";
import { ToolAccessRuntimeBridge } from "../src/main/toolAccessIpc";

const fakeSession = () => ({
  getToken: async () => "app-session-token",
  invalidate: () => undefined,
  reset: () => undefined,
  setBackendToken: () => undefined,
  getBackendToken: () => "backend",
});
const fakeStream = () => ({ subscribe: () => () => undefined, start: async () => undefined, stop: () => undefined });

const settle = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

describe("tool access bridge on sign-out", () => {
  it("revokes every grant with the session it had, and never calls when there was no session", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, revoked: 1 }), { status: 200 }));
    const bridge = new ToolAccessRuntimeBridge({
      getWindow: () => null,
      runtimeBaseUrl: "http://127.0.0.1:3020",
      fetchImpl,
      createSession: fakeSession,
      createStream: fakeStream,
    });

    bridge.setAuthToken(null);
    await settle();
    expect(fetchImpl).not.toHaveBeenCalled();

    bridge.setAuthToken("backend-token");
    bridge.setAuthToken(null);
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:3020/runtime/access/grants",
      expect.objectContaining({ method: "DELETE", headers: { authorization: "Bearer app-session-token" } }),
    );
  });
});
