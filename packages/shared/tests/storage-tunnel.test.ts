import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createUserStorageTunnelClient,
  StorageTunnelError,
} from "../src/storageTunnel";

/** STOR-BW-11: every client carries the active profile; playback sessions require it. */
const PROFILE_ID = "6f1c2d3e-4b5a-4c6d-8e7f-90a1b2c3d4e5";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

// On assertion failure, dump enough of the fetch-mock + WS interaction history
// to diagnose offline (per "Tests log generously": surface diagnostics, never
// ask the user for a manual repro). Body wrapped in try/catch so a dump failure
// cannot mask the original assertion failure.
const dumpStorageTunnelSnapshot = (
  label: string,
  ctx: {
    extras?: Record<string, unknown>;
    wsInstance?: { creditCount?: number; maxInFlightUploadData?: number } | null;
  } = {},
) => {
  try {
    console.error(`=== [storage-tunnel:${label}] snapshot ===`);
    console.error(`fetchMock.mock.calls.length=${fetchMock.mock.calls.length}`);
    const calls = fetchMock.mock.calls.map(([url, init], idx) => {
      let frameKind: string | null = null;
      try {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        frameKind = body?.frame?.kind ?? null;
      } catch {
        frameKind = "(non-json-body)";
      }
      return {
        idx,
        url: typeof url === "string" ? url : String(url),
        method: (init as RequestInit | undefined)?.method ?? "GET",
        frameKind,
      };
    });
    console.error(`fetch calls (url + frame.kind):\n${JSON.stringify(calls, null, 2)}`);
    if (ctx.wsInstance) {
      console.error(`ws instance state: ${JSON.stringify(ctx.wsInstance)}`);
    }
    if (ctx.extras) {
      console.error(`extras: ${JSON.stringify(ctx.extras, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

afterEach(() => {
  fetchMock.mockReset();
});

describe("storage tunnel client", () => {
  const decodeBinaryWsFrame = (payload: Uint8Array) => {
    if (payload.byteLength < 8) return null;
    if (payload[0] !== 83 || payload[1] !== 70 || payload[2] !== 86 || payload[3] !== 49) return null;
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const metaLength = view.getUint32(4, false);
    const metaStart = 8;
    const metaEnd = metaStart + metaLength;
    if (metaEnd > payload.byteLength) return null;
    const metaText = new TextDecoder().decode(payload.subarray(metaStart, metaEnd));
    const parsed = JSON.parse(metaText) as { frame?: Record<string, unknown> };
    if (!parsed.frame) return null;
    return {
      frame: {
        ...parsed.frame,
        ciphertext: payload.subarray(metaEnd),
      } as Record<string, unknown>,
    };
  };

  it("pipelines websocket upload frames when uploadWindow is greater than one", async () => {
    class MockWs {
      onopen: ((event: unknown) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onclose: ((event: unknown) => void) | null = null;
      inFlightUploadData = 0;
      maxInFlightUploadData = 0;

      constructor(_url: string) {
        setTimeout(() => this.onopen?.({}), 0);
      }

      send(data: string | Uint8Array | ArrayBuffer) {
        const payload =
          typeof data === "string"
            ? (JSON.parse(data) as { frame: Record<string, unknown> })
            : decodeBinaryWsFrame(data instanceof Uint8Array ? data : new Uint8Array(data));
        if (!payload) throw new Error("invalid_ws_payload");
        const frame = payload.frame;
        const kind = String(frame.kind ?? "");
        if (kind === "session.start") {
          this.onmessage?.({ data: JSON.stringify({ frame: { kind: "session.ack" } }) });
          return;
        }
        if (kind === "upload.open") {
          this.onmessage?.({
            data: JSON.stringify({ frame: { kind: "upload.progress", uploadId: frame.uploadId ?? "u1" } }),
          });
          return;
        }
        if (kind === "upload.data") {
          this.inFlightUploadData += 1;
          this.maxInFlightUploadData = Math.max(this.maxInFlightUploadData, this.inFlightUploadData);
          setTimeout(() => {
            this.inFlightUploadData -= 1;
            this.onmessage?.({
              data: JSON.stringify({
                frame: {
                  kind: "upload.ack",
                  uploadId: frame.uploadId ?? "u1",
                  seq: Number(frame.seq ?? 0),
                },
              }),
            });
          }, 5);
          return;
        }
        if (kind === "upload.close") {
          this.onmessage?.({
            data: JSON.stringify({ frame: { kind: "upload.complete", objectKeys: ["shards/gw-1/library/chunks/a"] } }),
          });
          return;
        }
        if (kind === "session.end") {
          this.onmessage?.({ data: JSON.stringify({ frame: { kind: "session.ack" } }) });
        }
      }

      close() {
        this.onclose?.({});
      }
    }

    const captured: { ws: MockWs | null } = { ws: null };
    const WsCtor = class extends MockWs {
      constructor(url: string) {
        super(url);
        captured.ws = this;
      }
    };

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          policy: {
            policy: "rendezvous-v1",
            epoch: 1,
            seed: "s",
            replicaCount: 1,
            shards: [{ id: "gw-1", gatewayUrl: "https://storage.dev.spacebadger.io", status: "active" }],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          sessionId: "s1",
          protocolVersion: 1,
          createdAt: 1,
          expiresAt: 2,
          features: { upload: true, download: true },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const client = createUserStorageTunnelClient({
      getApiBaseUrl: () => "https://api.dev.spacebadger.io",
      getProfileId: () => PROFILE_ID,
      fetchImpl: fetchMock as unknown as typeof fetch,
      WebSocketImpl: WsCtor,
      preferWebSocket: true,
    });

    console.info("[storage-tunnel:ws-pipeline] uploading 8 bytes chunkSize=2 uploadWindow=3");
    await client.uploadObject("token-1", "library/chunks/a", new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), {
      uploadId: "u1",
      chunkSize: 2,
      uploadWindow: 3,
    });
    console.info(
      `[storage-tunnel:ws-pipeline] upload complete wsInstance=${captured.ws ? "present" : "null"} maxInFlightUploadData=${captured.ws?.maxInFlightUploadData ?? 0}`,
    );

    if (!captured.ws || (captured.ws.maxInFlightUploadData ?? 0) <= 1) {
      dumpStorageTunnelSnapshot("ws-pipeline-not-pipelined", {
        wsInstance: captured.ws
          ? { maxInFlightUploadData: captured.ws.maxInFlightUploadData }
          : null,
      });
    }
    expect(captured.ws).toBeTruthy();
    expect(captured.ws?.maxInFlightUploadData ?? 0).toBeGreaterThan(1);
  });

  it("accepts upload.ack even when ack seq differs from sent chunk seq", async () => {
    const client = createUserStorageTunnelClient({
      getApiBaseUrl: () => "https://api.dev.spacebadger.io",
      getProfileId: () => PROFILE_ID,
      fetchImpl: fetchMock as unknown as typeof fetch,
      preferWebSocket: false,
    });

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          policy: {
            policy: "rendezvous-v1",
            epoch: 1,
            seed: "s",
            replicaCount: 1,
            shards: [{ id: "gw-1", gatewayUrl: "https://storage.dev.spacebadger.io", status: "active" }],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          sessionId: "s1",
          protocolVersion: 1,
          createdAt: 1,
          expiresAt: 2,
          features: { upload: true, download: true },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ frame: { kind: "session.ack" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ frame: { kind: "upload.progress", uploadId: "u1" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ frame: { kind: "upload.ack", uploadId: "u1", seq: 999 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ frame: { kind: "upload.complete", uploadId: "u1", objectKeys: ["shards/gw-1/library/chunks/a"] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ frame: { kind: "session.ack" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    console.info("[storage-tunnel:ack-seq-mismatch] uploading with server ack seq=999 vs sent seq=0");
    const key = await client.uploadObject("token-1", "library/chunks/a", new Uint8Array([1, 2]), {
      uploadId: "u1",
      chunkSize: 2,
    });
    console.info(`[storage-tunnel:ack-seq-mismatch] resolved objectKey=${key}`);
    if (key !== "shards/gw-1/library/chunks/a") {
      dumpStorageTunnelSnapshot("ack-seq-mismatch-wrong-key", { extras: { resolvedKey: key } });
    }
    expect(key).toBe("shards/gw-1/library/chunks/a");
  });

  it("normalizes raw hex checksum returned by custom checksumFn", async () => {
    const client = createUserStorageTunnelClient({
      getApiBaseUrl: () => "https://api.dev.spacebadger.io",
      getProfileId: () => PROFILE_ID,
      fetchImpl: fetchMock as unknown as typeof fetch,
      preferWebSocket: false,
    });

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          policy: {
            policy: "rendezvous-v1",
            epoch: 1,
            seed: "s",
            replicaCount: 1,
            shards: [{ id: "gw-1", gatewayUrl: "https://storage.dev.spacebadger.io", status: "active" }],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          sessionId: "s1",
          protocolVersion: 1,
          createdAt: 1,
          expiresAt: 2,
          features: { upload: true, download: true },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ frame: { kind: "session.ack" } }), { status: 200 }));
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ frame: { kind: "upload.progress", uploadId: "u1" } }), { status: 200 })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ frame: { kind: "upload.ack", uploadId: "u1", seq: 0 } }), { status: 200 })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ frame: { kind: "upload.complete", uploadId: "u1", objectKeys: ["shards/gw-1/library/chunks/a"] } }),
        { status: 200 }
      )
    );
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ frame: { kind: "session.ack" } }), { status: 200 }));

    console.info("[storage-tunnel:checksum-normalize-fn] uploading with raw-hex checksumFn (no sha256: prefix)");
    await client.uploadObject("token-1", "library/chunks/a", new Uint8Array([1, 2]), {
      uploadId: "u1",
      checksumFn: () => "38164fbd17603d73f696b8b4d72664d735bb6a7c88577687fd2ae33fd6964153",
    });

    const uploadDataCall = fetchMock.mock.calls.find(([, init]) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      return body?.frame?.kind === "upload.data";
    });
    const uploadDataBody = JSON.parse(String(uploadDataCall?.[1]?.body ?? "{}"));
    console.info(
      `[storage-tunnel:checksum-normalize-fn] upload.data found=${Boolean(uploadDataCall)} checksum=${uploadDataBody?.frame?.checksum}`,
    );
    if (!uploadDataCall || uploadDataBody?.frame?.checksum !== "sha256:38164fbd17603d73f696b8b4d72664d735bb6a7c88577687fd2ae33fd6964153") {
      dumpStorageTunnelSnapshot("checksum-normalize-fn-mismatch", {
        extras: { observedChecksum: uploadDataBody?.frame?.checksum },
      });
    }
    expect(uploadDataCall).toBeTruthy();
    expect(uploadDataBody.frame.checksum).toBe(
      "sha256:38164fbd17603d73f696b8b4d72664d735bb6a7c88577687fd2ae33fd6964153"
    );
  });

  it("normalizes raw hex checksum for direct sendFrame upload.data calls", async () => {
    const client = createUserStorageTunnelClient({
      getApiBaseUrl: () => "https://api.dev.spacebadger.io",
      getProfileId: () => PROFILE_ID,
      fetchImpl: fetchMock as unknown as typeof fetch,
      preferWebSocket: false,
    });

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          policy: {
            policy: "rendezvous-v1",
            epoch: 1,
            seed: "s",
            replicaCount: 1,
            shards: [{ id: "gw-1", gatewayUrl: "https://storage.dev.spacebadger.io", status: "active" }],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          sessionId: "s1",
          protocolVersion: 1,
          createdAt: 1,
          expiresAt: 2,
          features: { upload: true, download: true },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ frame: { kind: "upload.ack", uploadId: "u1", seq: 0 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    console.info("[storage-tunnel:checksum-normalize-sendframe] creating session then sending raw-hex upload.data frame");
    const session = await client.createSession("token-1", "library/chunks/a");
    console.info(`[storage-tunnel:checksum-normalize-sendframe] sessionId=${session.sessionId}`);
    await client.sendFrame("token-1", session.sessionId, {
      kind: "upload.data",
      uploadId: "u1",
      seq: 0,
      checksum: "38164fbd17603d73f696b8b4d72664d735bb6a7c88577687fd2ae33fd6964153",
      ciphertextBase64: "AQI=",
    });

    const uploadDataCall = fetchMock.mock.calls.find(([, init]) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      return body?.frame?.kind === "upload.data";
    });
    const uploadDataBody = JSON.parse(String(uploadDataCall?.[1]?.body ?? "{}"));
    console.info(
      `[storage-tunnel:checksum-normalize-sendframe] upload.data found=${Boolean(uploadDataCall)} checksum=${uploadDataBody?.frame?.checksum}`,
    );
    if (!uploadDataCall || uploadDataBody?.frame?.checksum !== "sha256:38164fbd17603d73f696b8b4d72664d735bb6a7c88577687fd2ae33fd6964153") {
      dumpStorageTunnelSnapshot("checksum-normalize-sendframe-mismatch", {
        extras: { observedChecksum: uploadDataBody?.frame?.checksum, sessionId: session.sessionId },
      });
    }
    expect(uploadDataCall).toBeTruthy();
    expect(uploadDataBody.frame.checksum).toBe(
      "sha256:38164fbd17603d73f696b8b4d72664d735bb6a7c88577687fd2ae33fd6964153"
    );
  });

  it("does not resend duplicate download.stream.credit on repeated progress frames", async () => {
    class MockWs {
      onopen: ((event: unknown) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onclose: ((event: unknown) => void) | null = null;
      creditCount = 0;

      constructor(_url: string) {
        setTimeout(() => this.onopen?.({}), 0);
      }

      send(data: string | Uint8Array | ArrayBuffer) {
        const payload =
          typeof data === "string"
            ? (JSON.parse(data) as { frame: Record<string, unknown> })
            : decodeBinaryWsFrame(data instanceof Uint8Array ? data : new Uint8Array(data));
        if (!payload) throw new Error("invalid_ws_payload");
        const frame = payload.frame;
        const kind = String(frame.kind ?? "");
        if (kind === "session.start") {
          this.onmessage?.({ data: JSON.stringify({ frame: { kind: "session.ack" } }) });
          return;
        }
        if (kind === "download.stream.start") {
          this.onmessage?.({
            data: JSON.stringify({
              frame: {
                kind: "download.data",
                downloadId: String(frame.downloadId ?? "d1"),
                seq: 0,
                checksum: "sha256:38164fbd17603d73f696b8b4d72664d735bb6a7c88577687fd2ae33fd6964153",
                ciphertext: { "0": 65, "1": 66 },
              },
            }),
          });
          this.onmessage?.({
            data: JSON.stringify({
              frame: {
                kind: "download.progress",
                downloadId: String(frame.downloadId ?? "d1"),
                bytesSent: 2,
                bytesRemaining: 0,
              },
            }),
          });
          this.onmessage?.({
            data: JSON.stringify({
              frame: {
                kind: "download.progress",
                downloadId: String(frame.downloadId ?? "d1"),
                bytesSent: 2,
                bytesRemaining: 0,
              },
            }),
          });
          this.onmessage?.({
            data: JSON.stringify({
              frame: {
                kind: "download.complete",
                downloadId: String(frame.downloadId ?? "d1"),
              },
            }),
          });
          return;
        }
        if (kind === "download.stream.credit") {
          this.creditCount += 1;
          return;
        }
        if (kind === "download.close" || kind === "session.end") {
          this.onmessage?.({ data: JSON.stringify({ frame: { kind: "session.ack" } }) });
        }
      }

      close() {
        this.onclose?.({});
      }
    }

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          policy: {
            policy: "rendezvous-v1",
            epoch: 1,
            seed: "s",
            replicaCount: 1,
            shards: [{ id: "gw-1", gatewayUrl: "https://storage.dev.spacebadger.io", status: "active" }],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          sessionId: "s1",
          protocolVersion: 1,
          createdAt: 1,
          expiresAt: 2,
          features: { upload: true, download: true },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const captured: { ws: MockWs | null } = { ws: null };
    const WsCtor = class extends MockWs {
      constructor(url: string) {
        super(url);
        captured.ws = this;
      }
    };

    const client = createUserStorageTunnelClient({
      getApiBaseUrl: () => "https://api.dev.spacebadger.io",
      getProfileId: () => PROFILE_ID,
      fetchImpl: fetchMock as unknown as typeof fetch,
      WebSocketImpl: WsCtor,
      preferWebSocket: true,
      preferWsDownloadStream: true,
    });

    console.info("[storage-tunnel:credit-dedup] downloading over ws-stream with 2 repeated progress frames");
    const payload = await client.downloadObject("token-1", "library/chunks/a", { downloadId: "d1" });
    console.info(
      `[storage-tunnel:credit-dedup] payload=[${Array.from(payload).join(",")}] creditCount=${captured.ws?.creditCount}`,
    );
    if (Array.from(payload).join(",") !== "65,66" || captured.ws?.creditCount !== 1) {
      dumpStorageTunnelSnapshot("credit-dedup-mismatch", {
        wsInstance: captured.ws ? { creditCount: captured.ws.creditCount } : null,
        extras: { payload: Array.from(payload) },
      });
    }
    expect(Array.from(payload)).toEqual([65, 66]);
    expect(captured.ws?.creditCount).toBe(1);
  });

  it("falls back from ws-stream to request-response and reports fallback reason", async () => {
    class MockWs {
      onopen: ((event: unknown) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onclose: ((event: unknown) => void) | null = null;

      constructor(_url: string) {
        setTimeout(() => this.onopen?.({}), 0);
      }

      send(data: string | Uint8Array | ArrayBuffer) {
        const payload =
          typeof data === "string"
            ? (JSON.parse(data) as { frame: Record<string, unknown> })
            : decodeBinaryWsFrame(data instanceof Uint8Array ? data : new Uint8Array(data));
        if (!payload) throw new Error("invalid_ws_payload");
        const frame = payload.frame;
        const kind = String(frame.kind ?? "");
        if (kind === "session.start") {
          this.onmessage?.({ data: JSON.stringify({ frame: { kind: "session.ack" } }) });
          return;
        }
        if (kind === "download.stream.start") {
          this.onmessage?.({ data: JSON.stringify({ frame: { kind: "unexpected" } }) });
          return;
        }
        if (kind === "download.open") {
          this.onmessage?.({
            data: JSON.stringify({
              frame: {
                kind: "download.data",
                downloadId: String(frame.downloadId ?? "d1"),
                seq: 0,
                checksum: "sha256:38164fbd17603d73f696b8b4d72664d735bb6a7c88577687fd2ae33fd6964153",
                ciphertext: { "0": 65, "1": 66 },
              },
            }),
          });
          return;
        }
        if (kind === "download.ack") {
          this.onmessage?.({
            data: JSON.stringify({
              frame: {
                kind: "download.complete",
                downloadId: String(frame.downloadId ?? "d1"),
              },
            }),
          });
          return;
        }
        if (kind === "download.close" || kind === "session.end") {
          this.onmessage?.({ data: JSON.stringify({ frame: { kind: "session.ack" } }) });
          return;
        }
      }

      close() {
        this.onclose?.({});
      }
    }

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          policy: {
            policy: "rendezvous-v1",
            epoch: 1,
            seed: "s",
            replicaCount: 1,
            shards: [{ id: "gw-1", gatewayUrl: "https://storage.dev.spacebadger.io", status: "active" }],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          sessionId: "s1",
          protocolVersion: 1,
          createdAt: 1,
          expiresAt: 2,
          features: { upload: true, download: true },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const perfEvents: Array<Record<string, unknown>> = [];
    const client = createUserStorageTunnelClient({
      getApiBaseUrl: () => "https://api.dev.spacebadger.io",
      getProfileId: () => PROFILE_ID,
      fetchImpl: fetchMock as unknown as typeof fetch,
      WebSocketImpl: MockWs,
      preferWebSocket: true,
      preferWsDownloadStream: true,
      onDownloadPerf: (_event, payload) => perfEvents.push(payload),
    });

    console.info("[storage-tunnel:ws-fallback] downloading with ws-stream forced to emit unexpected frame → expect fallback");
    const payload = await client.downloadObject("token-1", "library/chunks/a", { downloadId: "d1" });
    console.info(
      `[storage-tunnel:ws-fallback] payload=[${Array.from(payload).join(",")}] perfEvents.length=${perfEvents.length} mode=${perfEvents[0]?.mode} fallbackReason=${perfEvents[0]?.fallbackReason}`,
    );
    if (
      Array.from(payload).join(",") !== "65,66" ||
      perfEvents.length !== 1 ||
      perfEvents[0]?.mode !== "request-response" ||
      perfEvents[0]?.fallbackCount !== 1 ||
      perfEvents[0]?.fallbackReason !== "TUNNEL_DOWNLOAD_INVALID_FRAME"
    ) {
      dumpStorageTunnelSnapshot("ws-fallback-mismatch", {
        extras: { payload: Array.from(payload), perfEvents },
      });
    }
    expect(Array.from(payload)).toEqual([65, 66]);
    expect(perfEvents).toHaveLength(1);
    expect(perfEvents[0]?.mode).toBe("request-response");
    expect(perfEvents[0]?.fallbackCount).toBe(1);
    expect(perfEvents[0]?.fallbackReason).toBe("TUNNEL_DOWNLOAD_INVALID_FRAME");
  });

  it("fails request-response download on sequence gaps", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          policy: {
            policy: "rendezvous-v1",
            epoch: 1,
            seed: "s",
            replicaCount: 1,
            shards: [{ id: "gw-1", gatewayUrl: "https://storage.dev.spacebadger.io", status: "active" }],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          sessionId: "s1",
          protocolVersion: 1,
          createdAt: 1,
          expiresAt: 2,
          features: { upload: true, download: true },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ frame: { kind: "session.ack" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          frame: {
            kind: "download.data",
            downloadId: "d1",
            seq: 0,
            checksum: "sha256:38164fbd17603d73f696b8b4d72664d735bb6a7c88577687fd2ae33fd6964153",
            ciphertext: { "0": 65, "1": 66 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          frame: {
            kind: "download.data",
            downloadId: "d1",
            seq: 2,
            checksum: "sha256:38164fbd17603d73f696b8b4d72664d735bb6a7c88577687fd2ae33fd6964153",
            ciphertext: { "0": 65, "1": 66 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ frame: { kind: "session.ack" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    const client = createUserStorageTunnelClient({
      getApiBaseUrl: () => "https://api.dev.spacebadger.io",
      getProfileId: () => PROFILE_ID,
      fetchImpl: fetchMock as unknown as typeof fetch,
      preferWebSocket: false,
    });

    // NOTE: each frame is mocked via mockResolvedValueOnce, so the download must
    // run exactly once — the rejects.toThrow assertion below consumes the single
    // attempt. We wrap it so a failure (no reject, or wrong message) dumps the
    // fetch-call history before rethrowing.
    console.info("[storage-tunnel:seq-gap] downloading with download.data seq 0 then 2 (gap) → expect INVALID_FRAME reject");
    try {
      await expect(client.downloadObjectToSink("token-1", "library/chunks/a", async () => undefined)).rejects.toThrow(
        "TUNNEL_DOWNLOAD_INVALID_FRAME"
      );
    } catch (assertionErr) {
      dumpStorageTunnelSnapshot("seq-gap-no-reject", {
        extras: {
          assertionError: assertionErr instanceof Error ? assertionErr.message : String(assertionErr),
        },
      });
      throw assertionErr;
    }
  });

  it("serializes HTTP upload frame fallback even with high uploadWindow", async () => {
    let inFlightHttpFrames = 0;
    let maxInFlightHttpFrames = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/storage/placement")) {
        return new Response(
          JSON.stringify({
            policy: {
              policy: "rendezvous-v1",
              epoch: 1,
              seed: "s",
              replicaCount: 1,
              shards: [{ id: "gw-1", gatewayUrl: "https://storage.dev.spacebadger.io", status: "active" }],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.endsWith("/storage/tunnel/session")) {
        return new Response(
          JSON.stringify({
            sessionId: "s1",
            protocolVersion: 1,
            createdAt: 1,
            expiresAt: 2,
            features: { upload: true, download: true },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.endsWith("/storage/tunnel/frame")) {
        inFlightHttpFrames += 1;
        maxInFlightHttpFrames = Math.max(maxInFlightHttpFrames, inFlightHttpFrames);
        const body = JSON.parse(String(init?.body ?? "{}")) as { frame?: Record<string, unknown> };
        const frame = body.frame ?? {};
        const kind = String(frame.kind ?? "");
        await new Promise((resolve) => setTimeout(resolve, kind === "upload.data" ? 5 : 1));
        inFlightHttpFrames -= 1;
        if (kind === "session.start" || kind === "session.end") {
          return new Response(JSON.stringify({ frame: { kind: "session.ack" } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (kind === "upload.open") {
          return new Response(JSON.stringify({ frame: { kind: "upload.progress", uploadId: frame.uploadId } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (kind === "upload.data") {
          return new Response(JSON.stringify({ frame: { kind: "upload.ack", uploadId: frame.uploadId, seq: frame.seq } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (kind === "upload.close") {
          return new Response(JSON.stringify({ frame: { kind: "upload.complete", objectKeys: ["shards/gw-1/library/chunks/a"] } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
      }
      return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
    });

    class FailingWs {
      onopen: ((event: unknown) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onclose: ((event: unknown) => void) | null = null;
      constructor(_url: string) {
        setTimeout(() => this.onerror?.({}), 0);
      }
      send(_data: string | Uint8Array | ArrayBuffer) {}
      close() {}
    }

    const client = createUserStorageTunnelClient({
      getApiBaseUrl: () => "https://api.dev.spacebadger.io",
      getProfileId: () => PROFILE_ID,
      fetchImpl: fetchMock as unknown as typeof fetch,
      WebSocketImpl: FailingWs,
      preferWebSocket: true,
    });

    console.info("[storage-tunnel:http-serialize] ws fails on open → uploading 8 bytes chunkSize=2 uploadWindow=4 over HTTP fallback");
    await client.uploadObject("token-1", "library/chunks/a", new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), {
      uploadId: "u1",
      chunkSize: 2,
      uploadWindow: 4,
    });
    console.info(`[storage-tunnel:http-serialize] maxInFlightHttpFrames=${maxInFlightHttpFrames} (expect 1 = serialized)`);

    if (maxInFlightHttpFrames !== 1) {
      dumpStorageTunnelSnapshot("http-serialize-concurrent", {
        extras: { maxInFlightHttpFrames },
      });
    }
    expect(maxInFlightHttpFrames).toBe(1);
  });

  it("creates user tunnel sessions from placement policy", async () => {
    const client = createUserStorageTunnelClient({
      getApiBaseUrl: () => "https://api.dev.spacebadger.io",
      getProfileId: () => PROFILE_ID,
      fetchImpl: fetchMock as unknown as typeof fetch,
      preferWebSocket: false,
    });

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          policy: {
            policy: "rendezvous-v1",
            epoch: 1,
            seed: "s",
            replicaCount: 1,
            shards: [{ id: "gw-1", gatewayUrl: "https://storage.dev.spacebadger.io", status: "active" }],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          sessionId: "s1",
          protocolVersion: 1,
          createdAt: 1,
          expiresAt: 2,
          features: { upload: true, download: true },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    console.info("[storage-tunnel:create-session] creating user session from rendezvous-v1 placement");
    const session = await client.createSession("token-1", "library/chunks/a");
    console.info(
      `[storage-tunnel:create-session] sessionId=${session.sessionId} resolvedObjectKey=${session.resolvedObjectKey}`,
    );
    if (session.sessionId !== "s1" || session.resolvedObjectKey !== "shards/gw-1/library/chunks/a") {
      dumpStorageTunnelSnapshot("create-session-unexpected", {
        extras: { sessionId: session.sessionId, resolvedObjectKey: session.resolvedObjectKey },
      });
    }
    expect(session.sessionId).toBe("s1");
    expect(session.resolvedObjectKey).toBe("shards/gw-1/library/chunks/a");
    try {
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        "https://api.dev.spacebadger.io/storage/placement",
        expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({
            Authorization: "Bearer token-1",
            "x-space-app": "badger",
          }),
        })
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        "https://storage.dev.spacebadger.io/storage/tunnel/session",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer token-1",
            "x-space-app": "badger",
          }),
        })
      );
    } catch (assertionErr) {
      dumpStorageTunnelSnapshot("create-session-call-shape", {
        extras: {
          call1Headers: (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.headers,
          call2Headers: (fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)?.headers,
        },
      });
      throw assertionErr;
    }
  });

  it("uses provided app scope header for user tunnel requests", async () => {
    const client = createUserStorageTunnelClient({
      getApiBaseUrl: () => "https://api.dev.spacebadger.io",
      getAppId: () => "parrot",
      getProfileId: () => PROFILE_ID,
      fetchImpl: fetchMock as unknown as typeof fetch,
      preferWebSocket: false,
    });

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          policy: {
            policy: "rendezvous-v1",
            epoch: 1,
            seed: "s",
            replicaCount: 1,
            shards: [{ id: "gw-1", gatewayUrl: "https://storage.dev.spacebadger.io", status: "active" }],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          sessionId: "s1",
          protocolVersion: 1,
          createdAt: 1,
          expiresAt: 2,
          features: { upload: true, download: true },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    console.info("[storage-tunnel:app-scope] creating session with getAppId=parrot → expect x-space-app: parrot");
    await client.createSession("token-1", "library/chunks/a");
    try {
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        "https://api.dev.spacebadger.io/storage/placement",
        expect.objectContaining({
          headers: expect.objectContaining({
            "x-space-app": "parrot",
          }),
        })
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        "https://storage.dev.spacebadger.io/storage/tunnel/session",
        expect.objectContaining({
          headers: expect.objectContaining({
            "x-space-app": "parrot",
          }),
        })
      );
    } catch (assertionErr) {
      dumpStorageTunnelSnapshot("app-scope-wrong-header", {
        extras: {
          call1Headers: (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.headers,
          call2Headers: (fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)?.headers,
        },
      });
      throw assertionErr;
    }
  });

  it("sends user tunnel frames over HTTP fallback", async () => {
    const client = createUserStorageTunnelClient({
      getApiBaseUrl: () => "https://api.dev.spacebadger.io",
      getProfileId: () => PROFILE_ID,
      fetchImpl: fetchMock as unknown as typeof fetch,
      preferWebSocket: false,
    });

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          policy: {
            policy: "rendezvous-v1",
            epoch: 1,
            seed: "s",
            replicaCount: 1,
            shards: [{ id: "gw-1", gatewayUrl: "https://storage.dev.spacebadger.io", status: "active" }],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          sessionId: "s1",
          protocolVersion: 1,
          createdAt: 1,
          expiresAt: 2,
          features: { upload: true, download: true },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ frame: { kind: "session.ack" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    console.info("[storage-tunnel:http-frame] createSession then sendFrame(session.start) over HTTP fallback");
    await client.createSession("token-1", "library/chunks/a");
    const frame = await client.sendFrame("token-1", "s1", { kind: "session.start", sessionId: "s1" });
    console.info(`[storage-tunnel:http-frame] response frame.kind=${frame.kind}`);
    if (frame.kind !== "session.ack") {
      dumpStorageTunnelSnapshot("http-frame-wrong-kind", { extras: { frameKind: frame.kind } });
    }
    expect(frame.kind).toBe("session.ack");
    try {
      expect(fetchMock).toHaveBeenNthCalledWith(
        3,
        "https://storage.dev.spacebadger.io/storage/tunnel/frame",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer token-1",
            "x-space-app": "badger",
          }),
        })
      );
    } catch (assertionErr) {
      dumpStorageTunnelSnapshot("http-frame-call-shape", {
        extras: { call3: fetchMock.mock.calls[2] },
      });
      throw assertionErr;
    }
  });

  it("downloads ciphertext frames serialized as numeric-key objects", async () => {
    const client = createUserStorageTunnelClient({
      getApiBaseUrl: () => "https://api.dev.spacebadger.io",
      getProfileId: () => PROFILE_ID,
      fetchImpl: fetchMock as unknown as typeof fetch,
      preferWebSocket: false,
    });

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          policy: {
            policy: "rendezvous-v1",
            epoch: 1,
            seed: "s",
            replicaCount: 1,
            shards: [{ id: "gw-1", gatewayUrl: "https://storage.dev.spacebadger.io", status: "active" }],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          sessionId: "s1",
          protocolVersion: 1,
          createdAt: 1,
          expiresAt: 2,
          features: { upload: true, download: true },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ frame: { kind: "session.ack" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          frame: {
            kind: "download.data",
            downloadId: "d1",
            seq: 0,
            checksum: "sha256:38164fbd17603d73f696b8b4d72664d735bb6a7c88577687fd2ae33fd6964153",
            ciphertext: { "0": 65, "1": 66 },
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      )
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ frame: { kind: "download.complete", downloadId: "d1" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ frame: { kind: "session.ack" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ frame: { kind: "session.ack" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    console.info("[storage-tunnel:numeric-key-download] downloading ciphertext serialized as {0:65,1:66} object");
    const payload = await client.downloadObject("token-1", "library/chunks/a", {
      downloadId: "d1",
    });
    console.info(`[storage-tunnel:numeric-key-download] payload=[${Array.from(payload).join(",")}]`);
    if (Array.from(payload).join(",") !== "65,66") {
      dumpStorageTunnelSnapshot("numeric-key-download-mismatch", {
        extras: { payload: Array.from(payload) },
      });
    }
    expect(Array.from(payload)).toEqual([65, 66]);
  });

  it("streams download to sink without assembling merged buffer", async () => {
    const client = createUserStorageTunnelClient({
      getApiBaseUrl: () => "https://api.dev.spacebadger.io",
      getProfileId: () => PROFILE_ID,
      fetchImpl: fetchMock as unknown as typeof fetch,
      preferWebSocket: false,
    });

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          policy: {
            policy: "rendezvous-v1",
            epoch: 1,
            seed: "s",
            replicaCount: 1,
            shards: [{ id: "gw-1", gatewayUrl: "https://storage.dev.spacebadger.io", status: "active" }],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          sessionId: "s1",
          protocolVersion: 1,
          createdAt: 1,
          expiresAt: 2,
          features: { upload: true, download: true },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ frame: { kind: "session.ack" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          frame: {
            kind: "download.data",
            downloadId: "d1",
            seq: 0,
            checksum: "sha256:38164fbd17603d73f696b8b4d72664d735bb6a7c88577687fd2ae33fd6964153",
            ciphertext: { "0": 65, "1": 66 },
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      )
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ frame: { kind: "download.complete", downloadId: "d1" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ frame: { kind: "session.ack" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ frame: { kind: "session.ack" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    console.info("[storage-tunnel:download-to-sink] streaming download to a sink (no merged buffer)");
    const received: number[] = [];
    const result = await client.downloadObjectToSink(
      "token-1",
      "library/chunks/a",
      (chunk) => {
        received.push(...chunk);
      },
      { downloadId: "d1" }
    );
    console.info(
      `[storage-tunnel:download-to-sink] received=[${received.join(",")}] result.bytes=${result.bytes}`,
    );

    if (received.join(",") !== "65,66" || result.bytes !== 2) {
      dumpStorageTunnelSnapshot("download-to-sink-mismatch", {
        extras: { received, resultBytes: result.bytes },
      });
    }
    expect(received).toEqual([65, 66]);
    expect(result.bytes).toBe(2);
  });

  it("detects truncated/corrupted response via checksum mismatch", async () => {
    const client = createUserStorageTunnelClient({
      getApiBaseUrl: () => "https://api.dev.spacebadger.io",
      getProfileId: () => PROFILE_ID,
      fetchImpl: fetchMock as unknown as typeof fetch,
      preferWebSocket: false,
    });

    // Placement
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          policy: {
            policy: "rendezvous-v1",
            epoch: 1,
            seed: "s",
            replicaCount: 1,
            shards: [{ id: "gw-1", gatewayUrl: "https://storage.dev.spacebadger.io", status: "active" }],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    // Session creation
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          sessionId: "s-bad",
          protocolVersion: 1,
          createdAt: 1,
          expiresAt: 2,
          features: { upload: true, download: true },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    // Session start ack
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ frame: { kind: "session.ack" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    // Download data with WRONG checksum (payload is [65, 66] but checksum is all zeros)
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          frame: {
            kind: "download.data",
            downloadId: "d-bad",
            seq: 0,
            checksum: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            ciphertext: { "0": 65, "1": 66 },
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      )
    );
    // Session end ack (cleanup)
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ frame: { kind: "session.ack" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ frame: { kind: "session.ack" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    console.info("[storage-tunnel:checksum-mismatch] downloading payload [65,66] tagged with all-zero checksum → expect MISMATCH reject");
    try {
      await expect(
        client.downloadObjectToSink(
          "token-1",
          "library/chunks/bad-checksum",
          () => {},
          { downloadId: "d-bad" }
        )
      ).rejects.toThrow("TUNNEL_DOWNLOAD_CHECKSUM_MISMATCH");
    } catch (assertionErr) {
      dumpStorageTunnelSnapshot("checksum-mismatch-no-reject", {
        extras: {
          assertionError: assertionErr instanceof Error ? assertionErr.message : String(assertionErr),
        },
      });
      throw assertionErr;
    }
  });
});
