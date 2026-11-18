import { afterEach, describe, expect, it, vi } from "vitest";
import { createUserStorageTunnelClient } from "../src/storageTunnel";

/** STOR-BW-11: every Badger client carries the active profile; playback sessions require it. */
const PROFILE_ID = "6f1c2d3e-4b5a-4c6d-8e7f-90a1b2c3d4e5";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

// On assertion failure, dump the ordered fetch URLs the waterfall actually
// attempted so address-ordering / fallback bugs are diagnosable offline.
const dumpWaterfallSnapshot = (label: string) => {
  try {
    const urls = fetchMock.mock.calls.map(([url], i) => `#${i}: ${String(url)}`);
    console.error(`=== [storage-tunnel-waterfall:${label}] snapshot ===`);
    console.error(`fetch attempts (${fetchMock.mock.calls.length}):\n${urls.join("\n")}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

afterEach(() => {
  console.info(`[storage-tunnel-waterfall:teardown] resetting fetch mock`);
  fetchMock.mockReset();
});

const placementResponse = (addresses?: string[]) =>
  Response.json({
    policy: {
      policy: "rendezvous-v1",
      epoch: 1,
      seed: "test",
      replicaCount: 1,
      shards: [
        {
          id: "gw-1",
          gatewayUrl: "http://localhost:3010",
          weight: 1,
          status: "active",
          ...(addresses ? { addresses } : {}),
        },
      ],
    },
  });

const sessionResponse = (sessionId = "sess-1") =>
  Response.json({
    sessionId,
    protocolVersion: 1,
    createdAt: Date.now(),
    shardId: "gw-1",
    placementEpoch: 1,
    objectKeyPrefix: "shards/gw-1",
  });

describe("storage tunnel waterfall mode", () => {
  it("tries addresses in order and uses the first that succeeds", async () => {
    const client = createUserStorageTunnelClient({
      getApiBaseUrl: () => "http://api.test:3000",
      getProfileId: () => PROFILE_ID,
      tunnelMode: "waterfall",
      placementCacheTtlMs: 0,
    });

    fetchMock
      // 1. GET /storage/placement
      .mockResolvedValueOnce(placementResponse([
        "http://10.0.0.1:3010",
        "http://192.168.0.50:3010",
      ]))
      // 2. POST to first address (10.0.0.1) - fails
      .mockRejectedValueOnce(new Error("connection refused"))
      // 3. POST to second address (192.168.0.50) - succeeds
      .mockResolvedValueOnce(sessionResponse("sess-lan"));

    console.info(`[storage-tunnel-waterfall:order] createSession — addr[0] fails, addr[1] should win`);
    const session = await client.createSession("token-1", "library/test-object");
    try {
      expect(session.sessionId).toBe("sess-lan");

      // Verify the order of calls
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(fetchMock.mock.calls[1][0]).toContain("http://10.0.0.1:3010");
      expect(fetchMock.mock.calls[2][0]).toContain("http://192.168.0.50:3010");
    } catch (err) {
      console.error(`[storage-tunnel-waterfall:order] sessionId=${session.sessionId}`);
      dumpWaterfallSnapshot("tries-addresses-in-order");
      throw err;
    }
  });

  // @req STOR-GATEWAY-15[badger-desktop,badger-jellyfin,badger-web-player,parrot-web-player]
  it("throws the last direct error when all direct addresses and gatewayUrl fail (no API fallback)", async () => {
    const client = createUserStorageTunnelClient({
      getApiBaseUrl: () => "http://api.test:3000",
      getProfileId: () => PROFILE_ID,
      tunnelMode: "waterfall",
      placementCacheTtlMs: 0,
      sessionOpenRetryDelaysMs: [],
    });

    fetchMock
      // 1. GET /storage/placement
      .mockResolvedValueOnce(placementResponse([
        "http://203.0.113.45:3010",
        "http://192.168.0.50:3010",
      ]))
      // 2. First address fails
      .mockRejectedValueOnce(new Error("timeout first"))
      // 3. Second address fails
      .mockRejectedValueOnce(new Error("timeout second"))
      // 4. gatewayUrl (localhost) is also tried and fails: its error is the one the caller sees
      .mockRejectedValueOnce(new Error("timeout gatewayUrl"));

    console.info(
      `[storage-tunnel-waterfall:all-fail] all direct addrs + gatewayUrl fail → expect last direct error, no API call`,
    );
    const error = await client.createSession("token-1", "library/test-object").catch((err: unknown) => err);
    try {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("timeout gatewayUrl");
      expect(fetchMock).toHaveBeenCalledTimes(4);
      const urls = fetchMock.mock.calls.map((call) => String(call[0]));
      expect(urls.some((url) => url === "http://api.test:3000/storage/tunnel/session")).toBe(false);
      expect(urls.slice(1)).toEqual([
        "http://203.0.113.45:3010/storage/tunnel/session",
        "http://192.168.0.50:3010/storage/tunnel/session",
        "http://localhost:3010/storage/tunnel/session",
      ]);
    } catch (err) {
      console.error(`[storage-tunnel-waterfall:all-fail] error=${error instanceof Error ? error.message : String(error)}`);
      dumpWaterfallSnapshot("all-fail-throws-last-error");
      throw err;
    }
  });

  it("uses cached winner for subsequent sessions", async () => {
    const client = createUserStorageTunnelClient({
      getApiBaseUrl: () => "http://api.test:3000",
      getProfileId: () => PROFILE_ID,
      tunnelMode: "waterfall",
      placementCacheTtlMs: 0,
    });

    // First call: waterfall discovers working address
    fetchMock
      .mockResolvedValueOnce(placementResponse(["http://192.168.0.50:3010"]))
      .mockResolvedValueOnce(sessionResponse("sess-1"));

    console.info(`[storage-tunnel-waterfall:cache] first session establishes cached winner`);
    const first = await client.createSession("token-1", "library/obj-1");
    try {
      expect(first.sessionId).toBe("sess-1");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } catch (err) {
      dumpWaterfallSnapshot("cache-first-session");
      throw err;
    }

    fetchMock.mockReset();

    // Second call: should use cached winner, skip waterfall
    fetchMock
      .mockResolvedValueOnce(placementResponse(["http://192.168.0.50:3010"]))
      .mockResolvedValueOnce(sessionResponse("sess-2"));

    console.info(`[storage-tunnel-waterfall:cache] second session should reuse cached winner`);
    const second = await client.createSession("token-1", "library/obj-2");
    try {
      expect(second.sessionId).toBe("sess-2");
      // Only placement + cached address call, no waterfall retries
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1][0]).toContain("http://192.168.0.50:3010");
    } catch (err) {
      console.error(`[storage-tunnel-waterfall:cache] second sessionId=${second.sessionId}`);
      dumpWaterfallSnapshot("cache-second-session-reuse");
      throw err;
    }
  });

  it("falls back to waterfall when cached winner fails", async () => {
    const client = createUserStorageTunnelClient({
      getApiBaseUrl: () => "http://api.test:3000",
      getProfileId: () => PROFILE_ID,
      tunnelMode: "waterfall",
      placementCacheTtlMs: 0,
    });

    // First call: establish cached winner
    fetchMock
      .mockResolvedValueOnce(placementResponse([
        "http://192.168.0.50:3010",
        "http://10.0.0.5:3010",
      ]))
      .mockResolvedValueOnce(sessionResponse("sess-1"));

    await client.createSession("token-1", "library/obj-1");
    fetchMock.mockReset();

    // Second call: cached winner fails, should re-waterfall
    fetchMock
      .mockResolvedValueOnce(placementResponse([
        "http://192.168.0.50:3010",
        "http://10.0.0.5:3010",
      ]))
      // Cached winner (192.168.0.50) fails
      .mockRejectedValueOnce(new Error("connection lost"))
      // Waterfall: first address (192.168.0.50 again) fails
      .mockRejectedValueOnce(new Error("still down"))
      // Waterfall: second address succeeds
      .mockResolvedValueOnce(sessionResponse("sess-fallback"));

    console.info(
      `[storage-tunnel-waterfall:cache-miss] cached winner fails → expect re-waterfall to addr[1]`,
    );
    const session = await client.createSession("token-1", "library/obj-2");
    try {
      expect(session.sessionId).toBe("sess-fallback");
      expect(fetchMock.mock.calls[2][0]).toContain("http://192.168.0.50:3010");
      expect(fetchMock.mock.calls[3][0]).toContain("http://10.0.0.5:3010");
    } catch (err) {
      console.error(`[storage-tunnel-waterfall:cache-miss] sessionId=${session.sessionId}`);
      dumpWaterfallSnapshot("cache-winner-fails-re-waterfall");
      throw err;
    }
  });

  it("deduplicates addresses and gatewayUrl", async () => {
    const client = createUserStorageTunnelClient({
      getApiBaseUrl: () => "http://api.test:3000",
      getProfileId: () => PROFILE_ID,
      tunnelMode: "waterfall",
      placementCacheTtlMs: 0,
    });

    // addresses contains the same URL as gatewayUrl
    fetchMock
      .mockResolvedValueOnce(placementResponse(["http://localhost:3010"]))
      .mockResolvedValueOnce(sessionResponse("sess-dedup"));

    console.info(
      `[storage-tunnel-waterfall:dedup] addresses duplicate gatewayUrl → expect single direct attempt`,
    );
    const session = await client.createSession("token-1", "library/obj-1");
    try {
      expect(session.sessionId).toBe("sess-dedup");
      // placement + one direct attempt (no duplicate localhost)
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } catch (err) {
      console.error(`[storage-tunnel-waterfall:dedup] sessionId=${session.sessionId}`);
      dumpWaterfallSnapshot("deduplicates-addresses-and-gatewayUrl");
      throw err;
    }
  });

  it("works with no addresses (tries gatewayUrl, then throws its error)", async () => {
    const client = createUserStorageTunnelClient({
      getApiBaseUrl: () => "http://api.test:3000",
      getProfileId: () => PROFILE_ID,
      tunnelMode: "waterfall",
      placementCacheTtlMs: 0,
      sessionOpenRetryDelaysMs: [],
    });

    fetchMock
      .mockResolvedValueOnce(placementResponse()) // no addresses
      .mockRejectedValueOnce(new Error("localhost unreachable")); // gatewayUrl fails

    console.info(
      `[storage-tunnel-waterfall:no-addresses] no addresses → gatewayUrl fails → expect its error, no API call`,
    );
    const error = await client.createSession("token-1", "library/obj-1").catch((err: unknown) => err);
    try {
      expect((error as Error).message).toBe("localhost unreachable");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(String(fetchMock.mock.calls[1][0])).toBe("http://localhost:3010/storage/tunnel/session");
    } catch (err) {
      console.error(`[storage-tunnel-waterfall:no-addresses] error=${error instanceof Error ? error.message : String(error)}`);
      dumpWaterfallSnapshot("no-addresses-throws");
      throw err;
    }
  });

  it("direct mode ignores addresses entirely", async () => {
    const client = createUserStorageTunnelClient({
      getApiBaseUrl: () => "http://api.test:3000",
      getProfileId: () => PROFILE_ID,
      tunnelMode: "direct",
      placementCacheTtlMs: 0,
    });

    fetchMock
      .mockResolvedValueOnce(placementResponse([
        "http://192.168.0.50:3010",
        "http://10.0.0.5:3010",
      ]))
      .mockResolvedValueOnce(sessionResponse("sess-direct"));

    console.info(`[storage-tunnel-waterfall:direct-mode] direct mode → expect gatewayUrl, ignore addresses`);
    const session = await client.createSession("token-1", "library/obj-1");
    try {
      expect(session.sessionId).toBe("sess-direct");
      // Should go to gatewayUrl directly, not the addresses
      expect(fetchMock.mock.calls[1][0]).toContain("http://localhost:3010");
    } catch (err) {
      console.error(`[storage-tunnel-waterfall:direct-mode] sessionId=${session.sessionId}`);
      dumpWaterfallSnapshot("direct-mode-ignores-addresses");
      throw err;
    }
  });
});
