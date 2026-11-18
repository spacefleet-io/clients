import { afterEach, describe, expect, it, vi } from "vitest";
import { createUserStorageTunnelClient, StorageTunnelError } from "@space/shared/storageTunnel";
import { Buffer } from "buffer";
import { createHash } from "node:crypto";

/**
 * @test-id MOBILE-TUNNEL-001
 * @level integration
 * @why The mobile app downloads library snapshots and media chunks via the storage tunnel.
 *   Several bugs were found: Uint8Array JSON serialization produces numeric-key objects that
 *   lose bytes, base64 ciphertext must be correctly parsed, and checksum verification must
 *   match between gateway and client.
 */

const SUITE_ID = "mobile-storage-tunnel-integration";
// A playback session names its profile (STOR-BW-11); the client refuses one without it before any request.
const PLAYBACK_PROFILE_ID = "profile-1";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

afterEach(() => {
  console.info(
    `[${SUITE_ID}:teardown] resetting fetchMock (calls=${fetchMock.mock.calls.length})`,
  );
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

const sha256Hex = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

const makeChunk = (size: number) => {
  const data = new Uint8Array(size);
  for (let i = 0; i < size; i++) data[i] = i & 0xff;
  return data;
};

/**
 * State dumper: snapshots the full fetchMock call sequence + ciphertext-shape ctx so a
 * failing tunnel assertion logs exactly how the gateway-style frames were threaded.
 */
const dumpTunnelSnapshot = (
  label: string,
  ctx: {
    expectedBytes?: number;
    actualBytes?: number;
    expectedHash?: string;
    actualHash?: string;
    ciphertextShape?: string;
    note?: string;
    sessionId?: string;
  } = {},
) => {
  try {
    const calls = fetchMock.mock.calls.map((call, idx) => {
      const [url, init] = call as [unknown, RequestInit | undefined];
      let parsedBody: unknown = null;
      try {
        parsedBody = init?.body ? JSON.parse(init.body as string) : null;
      } catch {
        parsedBody = `(unparseable: ${String(init?.body).slice(0, 200)})`;
      }
      return {
        idx,
        url: String(url),
        method: init?.method ?? "GET",
        bodyKind:
          parsedBody && typeof parsedBody === "object" && "frame" in parsedBody
            ? `frame.kind=${(parsedBody as { frame?: { kind?: string } }).frame?.kind ?? "?"}`
            : "(no frame)",
      };
    });
    const results = fetchMock.mock.results.map((r, idx) => ({
      idx,
      type: r.type,
      summary:
        r.type === "return" && r.value instanceof Response
          ? `Response(status=${(r.value as Response).status})`
          : String(r.value).slice(0, 200),
    }));
    console.error(`=== [${SUITE_ID}:${label}] snapshot ===`);
    console.error(`ctx: ${JSON.stringify(ctx, null, 2)}`);
    console.error(`fetch call count=${fetchMock.mock.calls.length}`);
    console.error(`fetch calls:\n${JSON.stringify(calls, null, 2)}`);
    console.error(`fetch results:\n${JSON.stringify(results, null, 2)}`);
  } catch (err) {
    console.error(
      `(${SUITE_ID}:${label} snapshot failed: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
};

describe("storage tunnel ciphertext parsing", () => {
  it("base64 ciphertext is correctly parsed and checksum matches", async () => {
    console.info(`[${SUITE_ID}:base64] building chunk (192 KiB) and base64 payload`);
    const chunk = makeChunk(192 * 1024);
    const checksum = `sha256:${sha256Hex(chunk)}`;
    const ciphertextBase64 = Buffer.from(chunk).toString("base64");
    console.info(
      `[${SUITE_ID}:base64] chunk bytes=${chunk.byteLength} checksum=${checksum.slice(0, 24)} base64Len=${ciphertextBase64.length}`,
    );

    const client = createUserStorageTunnelClient({
      getApiBaseUrl: () => "http://api.test:3000",
      getProfileId: () => PLAYBACK_PROFILE_ID,
      tunnelMode: "waterfall",
      // These frames travel over HTTP (fetchMock). Node 22+ ships a global WebSocket, which would
      // otherwise try a real socket to the placement address and hang to the test timeout.
      preferWebSocket: false,
      placementCacheTtlMs: 0,
    });

    console.info(`[${SUITE_ID}:base64] queueing fetchMock (placement/session/ack/data/complete/ended)`);
    fetchMock
      // placement
      .mockResolvedValueOnce(placementResponse(["http://10.0.0.1:3010"]))
      // session
      .mockResolvedValueOnce(sessionResponse())
      // session.start ack
      .mockResolvedValueOnce(Response.json({ frame: { kind: "session.ack" } }))
      // download.open -> download.data with base64 ciphertext
      .mockResolvedValueOnce(
        Response.json({
          frame: {
            kind: "download.data",
            downloadId: "dl-1",
            seq: 0,
            checksum,
            ciphertext: ciphertextBase64,
          },
        })
      )
      // download.ack -> download.complete
      .mockResolvedValueOnce(
        Response.json({ frame: { kind: "download.complete", downloadId: "dl-1" } })
      )
      // session.end
      .mockResolvedValueOnce(Response.json({ frame: { kind: "session.ended" } }));

    console.info(`[${SUITE_ID}:base64] invoking client.downloadObject(library/chunks/test-chunk)`);
    const result = await client.downloadObject("token-1", "library/chunks/test-chunk");
    const resultHash = sha256Hex(result);
    console.info(
      `[${SUITE_ID}:base64] downloaded bytes=${result.byteLength} hash=${resultHash.slice(0, 16)}`,
    );
    try {
      expect(result.byteLength).toBe(chunk.byteLength);
      expect(resultHash).toBe(sha256Hex(chunk));
    } catch (err) {
      dumpTunnelSnapshot("base64", {
        expectedBytes: chunk.byteLength,
        actualBytes: result.byteLength,
        expectedHash: sha256Hex(chunk),
        actualHash: resultHash,
        ciphertextShape: "base64-string",
      });
      throw err;
    }
  });

  it("numeric-key object ciphertext preserves exact byte count", async () => {
    console.info(`[${SUITE_ID}:numeric-key] building chunk (10 bytes) and numeric-key payload`);
    // This is the format Bun produces when JSON.stringify(Uint8Array)
    const chunk = makeChunk(10);
    const asObject: Record<string, number> = {};
    for (let i = 0; i < chunk.length; i++) asObject[String(i)] = chunk[i];

    const checksum = `sha256:${sha256Hex(chunk)}`;
    console.info(
      `[${SUITE_ID}:numeric-key] chunk bytes=${chunk.byteLength} objectKeys=${Object.keys(asObject).length}`,
    );

    const client = createUserStorageTunnelClient({
      getApiBaseUrl: () => "http://api.test:3000",
      getProfileId: () => PLAYBACK_PROFILE_ID,
      tunnelMode: "waterfall",
      // These frames travel over HTTP (fetchMock). Node 22+ ships a global WebSocket, which would
      // otherwise try a real socket to the placement address and hang to the test timeout.
      preferWebSocket: false,
      placementCacheTtlMs: 0,
    });

    console.info(`[${SUITE_ID}:numeric-key] queueing fetchMock`);
    fetchMock
      .mockResolvedValueOnce(placementResponse(["http://10.0.0.1:3010"]))
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(Response.json({ frame: { kind: "session.ack" } }))
      .mockResolvedValueOnce(
        Response.json({
          frame: {
            kind: "download.data",
            downloadId: "dl-1",
            seq: 0,
            checksum,
            ciphertext: asObject,
          },
        })
      )
      .mockResolvedValueOnce(
        Response.json({ frame: { kind: "download.complete", downloadId: "dl-1" } })
      )
      .mockResolvedValueOnce(Response.json({ frame: { kind: "session.ended" } }));

    console.info(`[${SUITE_ID}:numeric-key] invoking client.downloadObject`);
    const result = await client.downloadObject("token-1", "library/chunks/test-chunk");
    const resultHash = sha256Hex(result);
    console.info(
      `[${SUITE_ID}:numeric-key] downloaded bytes=${result.byteLength} hash=${resultHash.slice(0, 16)}`,
    );
    try {
      expect(result.byteLength).toBe(chunk.byteLength);
      expect(resultHash).toBe(sha256Hex(chunk));
    } catch (err) {
      dumpTunnelSnapshot("numeric-key", {
        expectedBytes: chunk.byteLength,
        actualBytes: result.byteLength,
        expectedHash: sha256Hex(chunk),
        actualHash: resultHash,
        ciphertextShape: "numeric-keyed-object",
      });
      throw err;
    }
  });

  it("Buffer.toJSON format ({type:'Buffer',data:[...]}) is correctly parsed", async () => {
    console.info(`[${SUITE_ID}:buffer-json] building chunk (10 bytes) as Buffer.toJSON shape`);
    const chunk = makeChunk(10);
    const bufferJson = { type: "Buffer", data: Array.from(chunk) };
    const checksum = `sha256:${sha256Hex(chunk)}`;

    const client = createUserStorageTunnelClient({
      getApiBaseUrl: () => "http://api.test:3000",
      getProfileId: () => PLAYBACK_PROFILE_ID,
      tunnelMode: "waterfall",
      // These frames travel over HTTP (fetchMock). Node 22+ ships a global WebSocket, which would
      // otherwise try a real socket to the placement address and hang to the test timeout.
      preferWebSocket: false,
      placementCacheTtlMs: 0,
    });

    console.info(`[${SUITE_ID}:buffer-json] queueing fetchMock`);
    fetchMock
      .mockResolvedValueOnce(placementResponse(["http://10.0.0.1:3010"]))
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(Response.json({ frame: { kind: "session.ack" } }))
      .mockResolvedValueOnce(
        Response.json({
          frame: {
            kind: "download.data",
            downloadId: "dl-1",
            seq: 0,
            checksum,
            ciphertext: bufferJson,
          },
        })
      )
      .mockResolvedValueOnce(
        Response.json({ frame: { kind: "download.complete", downloadId: "dl-1" } })
      )
      .mockResolvedValueOnce(Response.json({ frame: { kind: "session.ended" } }));

    console.info(`[${SUITE_ID}:buffer-json] invoking client.downloadObject`);
    const result = await client.downloadObject("token-1", "library/chunks/test-chunk");
    const resultHash = sha256Hex(result);
    console.info(
      `[${SUITE_ID}:buffer-json] downloaded bytes=${result.byteLength} hash=${resultHash.slice(0, 16)}`,
    );
    try {
      expect(result.byteLength).toBe(chunk.byteLength);
      expect(resultHash).toBe(sha256Hex(chunk));
    } catch (err) {
      dumpTunnelSnapshot("buffer-json", {
        expectedBytes: chunk.byteLength,
        actualBytes: result.byteLength,
        expectedHash: sha256Hex(chunk),
        actualHash: resultHash,
        ciphertextShape: "{type:Buffer,data:[]}",
      });
      throw err;
    }
  });
});

describe("storage tunnel waterfall connectivity", () => {
  it("tries LAN address first when STUN fails", async () => {
    console.info(`[${SUITE_ID}:waterfall-lan] arranging public-then-LAN address sequence`);
    const client = createUserStorageTunnelClient({
      getApiBaseUrl: () => "http://api.test:3000",
      getProfileId: () => PLAYBACK_PROFILE_ID,
      tunnelMode: "waterfall",
      // These frames travel over HTTP (fetchMock). Node 22+ ships a global WebSocket, which would
      // otherwise try a real socket to the placement address and hang to the test timeout.
      preferWebSocket: false,
      placementCacheTtlMs: 0,
    });

    fetchMock
      .mockResolvedValueOnce(
        placementResponse(["http://203.0.113.45:3010", "http://192.168.0.50:3010"])
      )
      // STUN public IP fails
      .mockRejectedValueOnce(new Error("timeout"))
      // LAN IP succeeds
      .mockResolvedValueOnce(sessionResponse("sess-lan"));

    console.info(`[${SUITE_ID}:waterfall-lan] invoking client.createSession`);
    const session = await client.createSession("token-1", "test-object");
    console.info(
      `[${SUITE_ID}:waterfall-lan] session.sessionId=${session.sessionId} fetchCalls=${fetchMock.mock.calls.length}`,
    );
    try {
      expect(session.sessionId).toBe("sess-lan");
      console.info(
        `[${SUITE_ID}:waterfall-lan] third call URL=${String(fetchMock.mock.calls[2][0])}`,
      );
      expect(fetchMock.mock.calls[2][0]).toContain("http://192.168.0.50:3010");
    } catch (err) {
      dumpTunnelSnapshot("waterfall-lan", {
        sessionId: session.sessionId,
        note: "expected LAN-address fallback after public IP timeout",
      });
      throw err;
    }
  });

  // @req STOR-GATEWAY-15[badger-mobile,badger-tv]
  it("throws the last direct error when every address fails, never falling back to the API", async () => {
    console.info(`[${SUITE_ID}:waterfall-all-fail] arranging silo address + gatewayUrl both failing`);
    const client = createUserStorageTunnelClient({
      getApiBaseUrl: () => "http://api.test:3000",
      getProfileId: () => PLAYBACK_PROFILE_ID,
      tunnelMode: "waterfall",
      // These frames travel over HTTP (fetchMock). Node 22+ ships a global WebSocket, which would
      // otherwise try a real socket to the placement address and hang to the test timeout.
      preferWebSocket: false,
      placementCacheTtlMs: 0,
      // One waterfall pass only: the retry wrapper would otherwise run it again on this transient error.
      sessionOpenRetryDelaysMs: [],
    });

    fetchMock
      .mockResolvedValueOnce(placementResponse(["http://10.0.0.1:3010"]))
      .mockRejectedValueOnce(new Error("timeout silo address"))
      .mockRejectedValueOnce(new Error("timeout gatewayUrl"));

    console.info(`[${SUITE_ID}:waterfall-all-fail] invoking client.createSession`);
    const failure = await client.createSession("token-1", "test-object").catch((error: unknown) => error);
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    console.info(
      `[${SUITE_ID}:waterfall-all-fail] error=${String((failure as Error)?.message)} fetchCalls=${urls.length} urls=${JSON.stringify(urls)}`,
    );
    try {
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe("timeout gatewayUrl");
      expect(urls).toHaveLength(3);
      expect(urls[1]).toContain("http://10.0.0.1:3010");
      expect(urls[2]).toContain("http://localhost:3010");
      expect(urls).not.toContain("http://api.test:3000/storage/tunnel/session");
    } catch (err) {
      dumpTunnelSnapshot("waterfall-all-fail", {
        note: `expected the gatewayUrl error and no API tunnel session; got error=${String((failure as Error)?.message)} urls=${JSON.stringify(urls)}`,
      });
      throw err;
    }
  });
});
