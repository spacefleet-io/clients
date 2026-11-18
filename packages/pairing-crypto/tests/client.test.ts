/**
 * @level unit
 * The new-device client names the app asking to sign in: every call carries `x-space-app: <appId>`, so the API stores
 * it, the approver reads "<App> on <device> wants to sign in" and the session becomes `<appId>-<deviceType>`.
 */
import { describe, expect, it } from "vitest";
import { createPairingClientCore } from "../src";

/** @req ACCT-PAIR-05 */
describe("[pairing-client] x-space-app", () => {
  const run = async (appId: "parrot" | "badger") => {
    const seen: Array<{ method: string; path: string; app: string | null }> = [];
    const fetchImpl = (async (request: Request) => {
      const path = new URL(request.url).pathname;
      seen.push({ method: request.method, path, app: request.headers.get("x-space-app") });
      if (request.method === "POST") {
        return Response.json(
          { requestId: "req-1", pollSecret: "s", shortCode: "ABCD-EFGH", qrPayload: "https://spacefleet.io/pair/badger?code=ABCDEFGH", expiresAt: "2099-01-01T00:00:00.000Z" },
          { status: 201 },
        );
      }
      return Response.json({ status: "pending" });
    }) as unknown as typeof fetch;
    const core = createPairingClientCore({
      appId,
      getApiBaseUrl: () => "http://api.test",
      deviceType: "desktop",
      deviceName: () => "Studio laptop",
      fallbackDeviceName: "Computer",
      fetchImpl,
    });
    const created = await core.start();
    const polled = await core.poll(created.requestId);
    console.info(`[pairing-client-${appId}]`, { seen, polled: polled.status });
    return { seen, polled };
  };

  it("[pairing-client-1] a Parrot client sends x-space-app: parrot on the request and the poll", async () => {
    const { seen, polled } = await run("parrot");
    expect(polled.status).toBe("pending");
    expect(seen.map((call) => [call.method, call.path, call.app])).toEqual([
      ["POST", "/pairing/requests", "parrot"],
      ["GET", "/pairing/requests/req-1", "parrot"],
    ]);
  });

  it("[pairing-client-2] a Badger client sends x-space-app: badger", async () => {
    const { seen } = await run("badger");
    expect(seen.every((call) => call.app === "badger")).toBe(true);
  });
});
