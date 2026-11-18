import { afterEach, describe, expect, it, vi } from "vitest";
import { createUserStorageTunnelClient } from "../src/storageTunnel";

/**
 * A gateway copy restarts (SIGTERM, drain, start) while the client holds a cached placement that still names it:
 * the next session open reaches the proxy in front of the copy and gets a 502/503 or a refused connection. The
 * client asks the API for a fresh placement (the API no longer lists a draining copy) and opens the session on the
 * other copy instead of failing the transfer.
 *
 * @req STOR-GATEWAY-01
 */

const API = "http://api.test:3000";
const GW_A = "http://gw-a:3010";
const GW_B = "http://gw-b:3010";
/** STOR-BW-11: every Badger client carries the active profile; playback sessions require it. */
const PROFILE_ID = "6f1c2d3e-4b5a-4c6d-8e7f-90a1b2c3d4e5";

const fetchMock = vi.fn();

afterEach(() => fetchMock.mockReset());

const policyFor = (url: string) => ({
  policy: {
    policy: "rendezvous-v1",
    epoch: 1,
    seed: "s",
    replicaCount: 1,
    shards: [{ id: "silo1", gatewayUrl: url, weight: 1, status: "active" }],
  },
});

/** The API names `placements[i]` on its i-th placement call (the last one afterwards); `sessionAnswer` answers a session open per gateway. */
const install = (placements: string[], sessionAnswer: (gateway: string, attempt: number) => Response | Error) => {
  let placementCalls = 0;
  const opens: string[] = [];
  fetchMock.mockImplementation(async (url: string) => {
    if (url === `${API}/storage/placement`) {
      const gateway = placements[Math.min(placementCalls, placements.length - 1)];
      placementCalls += 1;
      return Response.json(policyFor(gateway));
    }
    if (url.endsWith("/storage/tunnel/session")) {
      const gateway = url.slice(0, -"/storage/tunnel/session".length);
      opens.push(gateway);
      const answer = sessionAnswer(gateway, opens.length);
      if (answer instanceof Error) throw answer;
      return answer;
    }
    return new Response("unexpected", { status: 500 });
  });
  return { opens, placementCalls: () => placementCalls };
};

const newClient = () =>
  createUserStorageTunnelClient({
    getApiBaseUrl: () => API,
    getProfileId: () => PROFILE_ID,
    fetchImpl: fetchMock as unknown as typeof fetch,
    preferWebSocket: false,
    sessionOpenRetryDelaysMs: [1, 1, 1],
  });

const ok = () => Response.json({ sessionId: "silo1-b.s1", protocolVersion: 1, createdAt: 1, expiresAt: 2 });

describe("session open on a copy that went away @req STOR-GATEWAY-01", () => {
  it("re-resolves the placement and opens the session on the other copy after a proxy 502", async () => {
    const backend = install([GW_A, GW_B], (gw) => (gw === GW_A ? new Response("Bad Gateway", { status: 502 }) : ok()));
    const session = await newClient().createSession("token-1", "speed-test/a.bin");
    expect(session.sessionId).toBe("silo1-b.s1");
    expect(backend.opens).toEqual([GW_A, GW_B]);
    expect(backend.placementCalls()).toBe(2);
  });

  it("does the same after a refused connection", async () => {
    const backend = install([GW_A, GW_B], (gw) =>
      gw === GW_A ? Object.assign(new Error("Unable to connect"), { code: "ConnectionRefused" }) : ok()
    );
    await newClient().createSession("token-1", "speed-test/a.bin");
    expect(backend.opens).toEqual([GW_A, GW_B]);
  });

  it("gives up after a few attempts when every copy stays down", async () => {
    const backend = install([GW_A], () => new Response("Service Unavailable", { status: 503 }));
    await expect(newClient().createSession("token-1", "speed-test/a.bin")).rejects.toMatchObject({ status: 503 });
    expect(backend.opens).toHaveLength(4);
  });

  it("never retries a permanent refusal", async () => {
    const backend = install([GW_A, GW_B], () => Response.json({ error: "subscription_unpaid" }, { status: 402 }));
    await expect(newClient().createSession("token-1", "speed-test/a.bin")).rejects.toMatchObject({ status: 402 });
    expect(backend.opens).toEqual([GW_A]);
  });
});
