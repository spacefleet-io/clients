import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import http from "node:http";

const downloadToSinkMock = vi.hoisted(() => vi.fn());

vi.mock("../src/main/api", () => ({
  downloadStorageObjectViaTunnelToSink: (...args: unknown[]) => downloadToSinkMock(...args),
}));

import { PlaybackServer } from "../src/main/playbackServer";
import { setActivePlaybackProfileId } from "../src/main/activePlaybackProfile";

// On assertion failure, dump the server + mock state so an integration failure
// is diagnosable from CI alone (per "Tests log generously"). try/catch so a
// dump failure can't mask the real assertion.
const dumpPlaybackServerSnapshot = (
  label: string,
  ctx: {
    server?: PlaybackServer | null;
    startError?: unknown;
    onSignedUrlRequest?: ReturnType<typeof vi.fn>;
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [playback-server-integration:${label}] snapshot ===`);
    console.error(
      `startError=${ctx.startError ? JSON.stringify({ code: (ctx.startError as { code?: string }).code, message: (ctx.startError as Error)?.message }) : "null"}`,
    );
    let baseUrl: string | null = null;
    let metrics: unknown = null;
    try {
      baseUrl = ctx.server?.getBaseUrl() ?? null;
      metrics = ctx.server?.getSignedUrlMetrics() ?? null;
    } catch (err) {
      baseUrl = `(getBaseUrl/metrics failed: ${err instanceof Error ? err.message : String(err)})`;
    }
    console.error(`baseUrl=${JSON.stringify(baseUrl)} signedUrlMetrics=${JSON.stringify(metrics)}`);
    console.error(
      `downloadToSink.calls=${downloadToSinkMock.mock.calls.length} onSignedUrlRequest.calls=${ctx.onSignedUrlRequest?.mock.calls.length ?? "n/a"}`,
    );
    if (ctx.extra) console.error(`extra=${JSON.stringify(ctx.extra)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("playbackServer integration", () => {
  let server: PlaybackServer;
  let startError: unknown = null;
  let onSignedUrlRequest: Mock<(increment: number) => void>;

  beforeEach(async () => {

    // STOR-BW-11: every playback names the picked profile.

    setActivePlaybackProfileId("00000000-0000-4000-8000-000000000001");
    downloadToSinkMock.mockReset();
    onSignedUrlRequest = vi.fn();
    startError = null;
    server = new PlaybackServer({
      onSignedUrlRequest,
    });
    try {
      await server.start();
      console.info(`[playback-server-integration:setup] server started baseUrl=${server.getBaseUrl()}`);
    } catch (error) {
      startError = error;
      console.info(
        `[playback-server-integration:setup] server.start() failed code=${(error as { code?: string }).code} (EPERM-tolerant sandbox path)`,
      );
    }
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
  });

  /**
   * @test-id DESKTOP-PLAYBACK-001
   * @level integration
   * @why Ensure transient tunnel/object fetch errors are retried so playback startup does not fail on first segment blips.
   */
  it("retries object fetch and serves payload", async () => {
    if (startError) {
      expect((startError as { code?: string }).code).toBe("EPERM");
      return;
    }
    server.setToken("test-token");
    const bytes = new TextEncoder().encode("hello-playback");
    downloadToSinkMock
      .mockRejectedValueOnce(new Error("transient_download_error"))
      .mockImplementationOnce(
        async (
          _token: string,
          _key: string,
          sink: (chunk: Uint8Array) => void | Promise<void>
        ) => {
          await sink(bytes);
        }
      );

    const base = server.getBaseUrl();
    expect(base).toBeTruthy();
    console.info(`[playback-server-integration:retry] GET ${base}/playback/object/test-object (1st download rejects, 2nd succeeds)`);
    const res = await fetch(`${base}/playback/object/test-object`);
    const body = new Uint8Array(await res.arrayBuffer());
    console.info(
      `[playback-server-integration:retry] status=${res.status} bodyLen=${body.byteLength} downloadCalls=${downloadToSinkMock.mock.calls.length}`,
    );
    if (
      res.status !== 200 ||
      downloadToSinkMock.mock.calls.length !== 2 ||
      server.getSignedUrlMetrics().requests !== 2
    ) {
      dumpPlaybackServerSnapshot("retry-serve-payload", {
        server,
        startError,
        onSignedUrlRequest,
        extra: { status: res.status, bodyLen: body.byteLength },
      });
    }
    expect(res.status).toBe(200);
    expect(Array.from(body)).toEqual(Array.from(bytes));
    expect(downloadToSinkMock).toHaveBeenCalledTimes(2);
    expect(server.getSignedUrlMetrics().requests).toBe(2);
    expect(onSignedUrlRequest).toHaveBeenCalledTimes(2);
  });

  /**
   * @test-id DESKTOP-PLAYBACK-002
   * @level integration
   * @why Prevent unauthenticated playback-object reads when no token is configured.
   */
  it("rejects object request without token", async () => {
    if (startError) {
      expect((startError as { code?: string }).code).toBe("EPERM");
      return;
    }
    server.setToken(null);
    const base = server.getBaseUrl();
    expect(base).toBeTruthy();
    console.info(`[playback-server-integration:no-token] GET ${base}/playback/object/test-object with token=null (expect 401)`);
    const res = await fetch(`${base}/playback/object/test-object`);
    console.info(
      `[playback-server-integration:no-token] status=${res.status} downloadCalls=${downloadToSinkMock.mock.calls.length}`,
    );
    if (res.status !== 401 || downloadToSinkMock.mock.calls.length !== 0) {
      dumpPlaybackServerSnapshot("no-token-reject", {
        server,
        startError,
        onSignedUrlRequest,
        extra: { status: res.status },
      });
    }
    expect(res.status).toBe(401);
    expect(downloadToSinkMock).not.toHaveBeenCalled();
  });

  it("accepts explicit stream id and rejects duplicate ids", async () => {
    if (startError) {
      expect((startError as { code?: string }).code).toBe("EPERM");
      return;
    }
    console.info(`[playback-server-integration:stream-id] creating explicit-stream-1, then asserting duplicate rejects`);
    const created = server.createStream({
      id: "explicit-stream-1",
      initKey: "init-key",
      initSize: 8,
      chunks: [{ key: "chunk-1", sizeBytes: 16 }],
      contentType: "video/mp4",
    });
    console.info(`[playback-server-integration:stream-id] created id=${created.id} totalSize=${created.totalSize}`);
    if (created.id !== "explicit-stream-1" || created.totalSize !== 24) {
      dumpPlaybackServerSnapshot("explicit-stream-id", {
        server,
        startError,
        onSignedUrlRequest,
        extra: { createdId: created.id, totalSize: created.totalSize },
      });
    }
    expect(created.id).toBe("explicit-stream-1");
    expect(created.totalSize).toBe(24);
    expect(() =>
      server.createStream({
        id: "explicit-stream-1",
        initKey: "init-key",
        initSize: 8,
        chunks: [{ key: "chunk-1", sizeBytes: 16 }],
        contentType: "video/mp4",
      })
    ).toThrow("playback_stream_exists");
  });

  /**
   * @test-id DESKTOP-PLAYBACK-003
   * @level integration
   * @bugfix
   * @regression-proof
   * @why Ensure client disconnects during playback-object delivery do not poison subsequent requests or force partial-response failures server-side.
   */
  it("tolerates an aborted object response and still serves the next request", async () => {
    if (startError) {
      expect((startError as { code?: string }).code).toBe("EPERM");
      return;
    }
    server.setToken("test-token");
    const bytes = Buffer.alloc(512 * 1024, 7);
    downloadToSinkMock.mockImplementation(
      async (
        _token: string,
        _key: string,
        sink: (chunk: Uint8Array) => void | Promise<void>
      ) => {
        await sink(bytes);
      }
    );

    const base = server.getBaseUrl();
    expect(base).toBeTruthy();

    const abortStartedAt = Date.now();
    console.info(`[playback-server-integration:abort] opening request then destroying mid-stream after first data chunk`);
    await new Promise<void>((resolve, reject) => {
      const req = http.get(`${base}/playback/object/test-object`);
      req.on("response", (res) => {
        res.once("data", () => {
          console.info(
            `[playback-server-integration:abort] first chunk received after ${Date.now() - abortStartedAt}ms, destroying client request`,
          );
          req.destroy();
          resolve();
        });
      });
      req.on("error", (err) => {
        console.info(
          `[playback-server-integration:abort] client request errored after ${Date.now() - abortStartedAt}ms: ${err instanceof Error ? err.message : String(err)}`,
        );
        resolve();
      });
      req.setTimeout(2_000, () => {
        console.error(
          `[playback-server-integration:abort] client abort timed out after ${Date.now() - abortStartedAt}ms (no first chunk within 2s)`,
        );
        reject(new Error("client_abort_timeout"));
      });
    });

    console.info(`[playback-server-integration:abort] issuing follow-up GET to verify server not poisoned`);
    const res = await fetch(`${base}/playback/object/test-object`);
    const body = new Uint8Array(await res.arrayBuffer());
    console.info(
      `[playback-server-integration:abort] follow-up status=${res.status} bodyLen=${body.byteLength} expected=${bytes.length}`,
    );
    if (res.status !== 200 || body.byteLength !== bytes.length) {
      dumpPlaybackServerSnapshot("aborted-then-next-request", {
        server,
        startError,
        onSignedUrlRequest,
        extra: { followUpStatus: res.status, followUpBodyLen: body.byteLength, expectedLen: bytes.length },
      });
    }
    expect(res.status).toBe(200);
    expect(body.byteLength).toBe(bytes.length);
  });
});
