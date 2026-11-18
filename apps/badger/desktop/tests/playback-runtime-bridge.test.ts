import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlaybackRuntimeBridge } from "../src/main/playbackRuntimeBridge";

const fetchMock = vi.hoisted(() => vi.fn());
const warnMock = vi.hoisted(() => vi.fn());

const loginResponse = (token: string) =>
  new Response(
    JSON.stringify({
      ok: true,
      token,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      capabilities: { apps: ["badger"] },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const commandResponse = (result: Record<string, unknown>) =>
  new Response(
    JSON.stringify({ requestId: "r", ok: true, result, error: null }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

// On assertion failure, dump the fetch-mock call shape so the runtime
// command envelope sequence is visible offline (no manual repro).
const dumpRuntimeBridgeSnapshot = (label: string) => {
  try {
    const calls = fetchMock.mock.calls.map((call, i) => {
      const url = String(call[0]);
      let body: unknown = null;
      try {
        body = JSON.parse(String((call[1] as { body?: unknown } | undefined)?.body ?? "null"));
      } catch {
        body = String((call[1] as { body?: unknown } | undefined)?.body ?? "");
      }
      return { i, url, body };
    });
    console.error(`=== [playback-runtime-bridge-integration:${label}] snapshot ===`);
    console.error(`fetch calls (count=${fetchMock.mock.calls.length}):\n${JSON.stringify(calls, null, 2)}`);
    console.error(`warn calls (count=${warnMock.mock.calls.length}):\n${JSON.stringify(warnMock.mock.calls, null, 2)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("playback runtime bridge", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    warnMock.mockReset();
  });

  /**
   * @test-id DESKTOP-PLAYBACK-RUNTIME-001
   * @level integration
   * @bugfix
   * @why Ensure playback create/release mirrors through runtime command contract and reuses runtime session.
   * @regression-proof Asserts login once + prepare/release command envelopes.
   */
  it("mirrors prepare/release commands with one runtime login", async () => {
    const bridge = new PlaybackRuntimeBridge(
      fetchMock as unknown as typeof fetch,
      "http://127.0.0.1:3020",
      { warn: warnMock }
    );
    bridge.setBackendToken("backend-token");

    const prepareResult = {
      sessionId: "stream-1", kind: "stream",
      url: "http://127.0.0.1:4444/playback/stream/stream-1",
      contentType: "video/mp4", totalSize: 1024,
      mode: null, videoTrackCount: null, audioTrackCount: null,
      metadata: null, createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z", releasedAt: null,
    };
    const releaseResult = { released: true, sessionId: "stream-1", releasedAt: "2026-01-01T00:00:01.000Z" };

    fetchMock.mockResolvedValueOnce(loginResponse("runtime-token"));
    fetchMock.mockResolvedValueOnce(commandResponse(prepareResult));
    fetchMock.mockResolvedValueOnce(commandResponse(releaseResult));

    console.info(`[playback-runtime-bridge-integration:mirror] mirrorPrepare + mirrorRelease for stream-1`);
    await bridge.mirrorPrepare({
      sessionId: "stream-1",
      kind: "stream",
      totalSize: 1024,
      url: "http://127.0.0.1:4444/playback/stream/stream-1",
      contentType: "video/mp4",
    });
    await bridge.mirrorRelease({ sessionId: "stream-1" });
    console.info(`[playback-runtime-bridge-integration:mirror] complete; fetch call count=${fetchMock.mock.calls.length}`);

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    const commandBodies = fetchMock.mock.calls
      .filter((call) => String(call[0]).endsWith("/modules/badger/commands"))
      .map((call) =>
        JSON.parse(String((call[1] as { body?: unknown } | undefined)?.body ?? "{}")) as {
          command?: string;
          payload?: { sessionId?: string };
        }
      );
    try {
      expect(urls.filter((url) => url.endsWith("/runtime/session/login")).length).toBe(1);
      expect(urls.filter((url) => url.endsWith("/modules/badger/commands")).length).toBe(2);
      expect(commandBodies[0]?.command).toBe("badger.playback.prepare_stream");
      expect(commandBodies[0]?.payload?.sessionId).toBe("stream-1");
      expect(commandBodies[1]?.command).toBe("badger.playback.release_stream");
      expect(commandBodies[1]?.payload?.sessionId).toBe("stream-1");
      expect(warnMock).not.toHaveBeenCalled();
    } catch (err) {
      dumpRuntimeBridgeSnapshot("mirror-prepare-release-assert");
      throw err;
    }
  });

  it("skips runtime calls when backend token is missing", async () => {
    const bridge = new PlaybackRuntimeBridge(
      fetchMock as unknown as typeof fetch,
      "http://127.0.0.1:3020",
      { warn: warnMock }
    );
    bridge.setBackendToken(null);
    console.info(`[playback-runtime-bridge-integration:no-token] mirrorPrepare with null backend token (should skip runtime)`);
    await bridge.mirrorPrepare({ sessionId: "s-1", kind: "stream" });
    try {
      expect(fetchMock).not.toHaveBeenCalled();
      expect(warnMock).not.toHaveBeenCalled();
    } catch (err) {
      dumpRuntimeBridgeSnapshot("no-token-skip-assert");
      throw err;
    }
  });

  it("returns runtime-generated session id from prepareSession", async () => {
    const bridge = new PlaybackRuntimeBridge(
      fetchMock as unknown as typeof fetch,
      "http://127.0.0.1:3020",
      { warn: warnMock }
    );
    bridge.setBackendToken("backend-token");

    fetchMock.mockResolvedValueOnce(loginResponse("runtime-token"));
    fetchMock.mockResolvedValueOnce(
      commandResponse({
        sessionId: "runtime-session-1", kind: "stream",
        url: null, contentType: null, totalSize: null, mode: null,
        videoTrackCount: null, audioTrackCount: null, metadata: null,
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
        releasedAt: null,
      })
    );

    console.info(`[playback-runtime-bridge-integration:prepare-session] prepareSession kind=stream (expect runtime-generated id)`);
    const prepared = await bridge.prepareSession({ kind: "stream" });
    console.info(`[playback-runtime-bridge-integration:prepare-session] prepared.sessionId=${prepared?.sessionId}`);
    try {
      expect(prepared?.sessionId).toBe("runtime-session-1");
      expect(warnMock).not.toHaveBeenCalled();
    } catch (err) {
      dumpRuntimeBridgeSnapshot("prepare-session-assert");
      throw err;
    }
  });

  it("supports runtime signed-url metrics commands", async () => {
    const bridge = new PlaybackRuntimeBridge(
      fetchMock as unknown as typeof fetch,
      "http://127.0.0.1:3020",
      { warn: warnMock }
    );
    bridge.setBackendToken("backend-token");

    fetchMock.mockResolvedValueOnce(
      loginResponse("runtime-token")
    );
    fetchMock.mockResolvedValueOnce(
      commandResponse({ requests: 8, resetAt: "2026-02-01T00:00:00.000Z" })
    );
    fetchMock.mockResolvedValueOnce(
      commandResponse({ requests: 0, resetAt: "2026-02-01T00:00:01.000Z" })
    );
    fetchMock.mockResolvedValueOnce(
      commandResponse({ requests: 1, resetAt: "2026-02-01T00:00:01.000Z" })
    );

    console.info(`[playback-runtime-bridge-integration:metrics] get/reset/record signed-url metrics`);
    const metrics = await bridge.getSignedUrlMetrics();
    const reset = await bridge.resetSignedUrlMetrics();
    void bridge.recordSignedUrlRequest(1);
    await bridge.flushSignedUrlRequests();
    const commandBodies = fetchMock.mock.calls
      .filter((call) => String(call[0]).endsWith("/modules/badger/commands"))
      .map((call) => JSON.parse(String((call[1] as { body?: unknown } | undefined)?.body ?? "{}")) as { command?: string });
    console.info(`[playback-runtime-bridge-integration:metrics] command sequence=${JSON.stringify(commandBodies.map((e) => e.command))}`);
    try {
      expect(metrics).toEqual({ requests: 8, resetAt: "2026-02-01T00:00:00.000Z" });
      expect(reset).toEqual({ requests: 0, resetAt: "2026-02-01T00:00:01.000Z" });
      expect(commandBodies.map((entry) => entry.command)).toEqual([
        "badger.playback.get_signed_url_metrics",
        "badger.playback.reset_signed_url_metrics",
        "badger.playback.record_signed_url_request",
      ]);
      expect(warnMock).not.toHaveBeenCalled();
    } catch (err) {
      dumpRuntimeBridgeSnapshot("signed-url-metrics-assert");
      throw err;
    }
  });

  /**
   * @test-id DESKTOP-PLAYBACK-RUNTIME-SIGNED-URL-BATCH-001
   * @level integration
   * @bugfix
   * @why Issue #25: every object fetch POSTed record_signed_url_request to the runtime (publish + ring persist + WS fan-out each), costing CPU during playback. Requests must be coalesced.
   * @regression-proof 50 recorded requests produce one record command carrying increment=50; readers see every request.
   */
  describe("@bugfix @regression-proof signed-url request batching", () => {
    type CommandBody = { command?: string; payload?: { increment?: number } };

    const installRuntimeFetch = () => {
      fetchMock.mockImplementation(async (url: unknown, init?: { body?: unknown }) => {
        if (String(url).endsWith("/runtime/session/login")) return loginResponse("runtime-token");
        const body = JSON.parse(String(init?.body ?? "{}")) as CommandBody;
        if (body.command === "badger.playback.record_signed_url_request") {
          return commandResponse({ requests: body.payload?.increment ?? 1, resetAt: "2026-02-01T00:00:00.000Z" });
        }
        return commandResponse({ requests: 50, resetAt: "2026-02-01T00:00:00.000Z" });
      });
    };

    const commandBodies = () =>
      fetchMock.mock.calls.flatMap((call) => {
        // fetchMock is an untyped vi.fn(); every call here is (url, RequestInit) from the runtime client.
        const [url, init] = call as [string, RequestInit | undefined];
        if (!String(url).endsWith("/modules/badger/commands")) return [];
        const body: CommandBody = JSON.parse(String(init?.body ?? "{}"));
        return [body];
      });

    const makeBridge = () => {
      const bridge = new PlaybackRuntimeBridge(
        fetchMock as unknown as typeof fetch,
        "http://127.0.0.1:3020",
        { warn: warnMock }
      );
      bridge.setBackendToken("backend-token");
      return bridge;
    };

    it("coalesces a burst of 50 requests into one record command on the flush timer", async () => {
      vi.useFakeTimers();
      try {
        installRuntimeFetch();
        const bridge = makeBridge();
        for (let i = 0; i < 50; i += 1) void bridge.recordSignedUrlRequest(1);
        await vi.advanceTimersByTimeAsync(10_000);
        const recorded = commandBodies().filter((body) => body.command === "badger.playback.record_signed_url_request");
        console.info(
          `[playback-runtime-bridge-integration:signed-url-batch] record POSTs=${recorded.length} increments=${JSON.stringify(recorded.map((b) => b.payload?.increment))}`
        );
        try {
          expect(recorded.length).toBe(1);
          expect(recorded[0]?.payload?.increment).toBe(50);
          expect(warnMock).not.toHaveBeenCalled();
        } catch (err) {
          dumpRuntimeBridgeSnapshot("signed-url-batch-burst");
          throw err;
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it("flushes pending requests before the stats read so readers see every request", async () => {
      vi.useFakeTimers();
      try {
        installRuntimeFetch();
        const bridge = makeBridge();
        for (let i = 0; i < 3; i += 1) void bridge.recordSignedUrlRequest(1);
        const metrics = await bridge.getSignedUrlMetrics();
        const sequence = commandBodies().map((body) => `${body.command}:${body.payload?.increment ?? ""}`);
        console.info(`[playback-runtime-bridge-integration:signed-url-batch] sequence=${JSON.stringify(sequence)}`);
        try {
          expect(sequence).toEqual([
            "badger.playback.record_signed_url_request:3",
            "badger.playback.get_signed_url_metrics:",
          ]);
          expect(metrics?.requests).toBe(50);
        } catch (err) {
          dumpRuntimeBridgeSnapshot("signed-url-batch-read-flush");
          throw err;
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it("flushes pending requests when the backend token is cleared", async () => {
      vi.useFakeTimers();
      try {
        installRuntimeFetch();
        const bridge = makeBridge();
        for (let i = 0; i < 4; i += 1) void bridge.recordSignedUrlRequest(1);
        bridge.setBackendToken(null);
        await bridge.flushSignedUrlRequests();
        await vi.advanceTimersByTimeAsync(10_000);
        const recorded = commandBodies().filter((body) => body.command === "badger.playback.record_signed_url_request");
        console.info(
          `[playback-runtime-bridge-integration:signed-url-batch] token-cleared record increments=${JSON.stringify(recorded.map((b) => b.payload?.increment))}`
        );
        try {
          expect(recorded.map((body) => body.payload?.increment)).toEqual([4]);
        } catch (err) {
          dumpRuntimeBridgeSnapshot("signed-url-batch-token-clear");
          throw err;
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it("sends nothing when the backend token is missing", async () => {
      vi.useFakeTimers();
      try {
        installRuntimeFetch();
        const bridge = new PlaybackRuntimeBridge(
          fetchMock as unknown as typeof fetch,
          "http://127.0.0.1:3020",
          { warn: warnMock }
        );
        for (let i = 0; i < 5; i += 1) void bridge.recordSignedUrlRequest(1);
        await vi.advanceTimersByTimeAsync(10_000);
        await bridge.flushSignedUrlRequests();
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  /**
   * @test-id DESKTOP-PLAYBACK-RUNTIME-002
   * @level integration
   * @bugfix
   * @why Runtime restarts invalidate cached runtime session tokens; playback commands must relogin on 401 instead of silently breaking playback launch.
   * @regression-proof Simulates stale token rejection and asserts a second login before the command succeeds.
   */
  it("@bugfix @regression-proof re-logins once when a cached playback runtime session returns 401", async () => {
    const bridge = new PlaybackRuntimeBridge(
      fetchMock as unknown as typeof fetch,
      "http://127.0.0.1:3020",
      { warn: warnMock }
    );
    bridge.setBackendToken("backend-token");

    fetchMock.mockResolvedValueOnce(loginResponse("stale-runtime-token"));
    fetchMock.mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));
    fetchMock.mockResolvedValueOnce(loginResponse("fresh-runtime-token"));
    fetchMock.mockResolvedValueOnce(
      commandResponse({
        sessionId: "stream-2", kind: "stream",
        url: null, contentType: null, totalSize: null, mode: null,
        videoTrackCount: null, audioTrackCount: null, metadata: null,
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
        releasedAt: null,
      })
    );

    console.info(`[playback-runtime-bridge-integration:relogin-401] mirrorPrepare with a stale token that 401s (expect 2 logins)`);
    await bridge.mirrorPrepare({ sessionId: "stream-2", kind: "stream" });

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    const loginCount = urls.filter((url) => url.endsWith("/runtime/session/login")).length;
    const commandCount = urls.filter((url) => url.endsWith("/modules/badger/commands")).length;
    console.info(`[playback-runtime-bridge-integration:relogin-401] loginCount=${loginCount} commandCount=${commandCount}`);
    try {
      expect(loginCount).toBe(2);
      expect(commandCount).toBe(2);
      expect(warnMock).not.toHaveBeenCalled();
    } catch (err) {
      dumpRuntimeBridgeSnapshot("relogin-401-assert");
      throw err;
    }
  });
});
