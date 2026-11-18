/**
 * @test-id SHARED-STORAGE-TUNNEL-UPLOAD-SOURCE-001
 * @level unit
 * @bugfix
 * @regression-proof
 *
 * Why this exists: React Native base64-encodes a binary WebSocket frame on the JS thread (~0.8 s per MB on
 * the profile build), so the mobile library snapshot upload froze the UI for seconds. An upload payload may
 * now be a `TunnelUploadSource` whose frames are built natively as ready-to-send messages (Blobs): the
 * tunnel client must hand those messages to the socket untouched and never read or checksum the bytes in
 * JS. The HTTP fallback still needs the bytes, so it reads them through `source.read`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUserStorageTunnelClient, type TunnelUploadSource } from "../src/storageTunnel";

const fetchMock = vi.fn();

afterEach(() => {
  fetchMock.mockReset();
});

const policyResponse = () =>
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
  );

const sessionResponse = () =>
  new Response(
    JSON.stringify({
      sessionId: "s1",
      protocolVersion: 1,
      createdAt: 1,
      expiresAt: 2,
      features: { upload: true, download: true },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );

const jsonFrame = (frame: Record<string, unknown>) => new Response(JSON.stringify({ frame }), { status: 200 });

type SentMessage = { kind: "blob"; tag: string } | { kind: "text"; frame: Record<string, unknown> };

/** Stands in for an RN Blob: opaque to the tunnel client, which must pass it to the socket untouched. */
class FakeBlob {
  constructor(readonly tag: string) {}
}

describe("storage tunnel upload source", () => {
  it("@bugfix @regression-proof sends natively built messages over the websocket without reading or hashing bytes", async () => {
    const sent: SentMessage[] = [];
    class MockWs {
      onopen: ((event: unknown) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onclose: ((event: unknown) => void) | null = null;

      constructor(_url: string) {
        queueMicrotask(() => this.onopen?.({}));
      }

      reply(frame: Record<string, unknown>) {
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ frame }) }));
      }

      send(data: unknown) {
        if (data instanceof FakeBlob) {
          sent.push({ kind: "blob", tag: data.tag });
          this.reply({ kind: "upload.ack", uploadId: "u1", seq: Number(data.tag.split(":")[1]) });
          return;
        }
        if (typeof data !== "string") throw new Error("a source upload must not encode binary frames in JS");
        const frame = (JSON.parse(data) as { frame: Record<string, unknown> }).frame;
        sent.push({ kind: "text", frame });
        const kind = String(frame.kind);
        if (kind === "session.start" || kind === "session.end") this.reply({ kind: "session.ack" });
        if (kind === "upload.open") this.reply({ kind: "upload.progress", uploadId: "u1" });
        if (kind === "upload.close") {
          this.reply({ kind: "upload.complete", objectKeys: ["shards/gw-1/library/chunks/a"] });
        }
      }

      close() {
        this.onclose?.({});
      }
    }

    fetchMock.mockResolvedValueOnce(policyResponse());
    fetchMock.mockResolvedValueOnce(sessionResponse());
    const read = vi.fn(async () => new Uint8Array());
    const checksumFn = vi.fn(() => "sha256:never");
    const released: string[] = [];
    const built: Array<{ uploadId: string; seq: number; offset: number; length: number }> = [];
    const source: TunnelUploadSource = {
      byteLength: 10,
      read,
      buildWsMessage: async (frame) => {
        built.push(frame);
        const tag = `blob:${frame.seq}`;
        return { message: new FakeBlob(tag) as unknown as Blob, release: () => released.push(tag) };
      },
    };

    const client = createUserStorageTunnelClient({
      getApiBaseUrl: () => "https://api.dev.spacebadger.io",
      fetchImpl: fetchMock as unknown as typeof fetch,
      WebSocketImpl: MockWs as never,
      preferWebSocket: true,
    });
    await client.uploadObject("token-1", "library/chunks/a", source, {
      uploadId: "u1",
      chunkSize: 4,
      uploadWindow: 2,
      checksumFn,
    });

    expect(built).toEqual([
      { uploadId: "u1", seq: 0, offset: 0, length: 4 },
      { uploadId: "u1", seq: 1, offset: 4, length: 4 },
      { uploadId: "u1", seq: 2, offset: 8, length: 2 },
    ]);
    expect(sent.filter((entry) => entry.kind === "blob").map((entry) => entry.kind === "blob" && entry.tag)).toEqual([
      "blob:0",
      "blob:1",
      "blob:2",
    ]);
    expect(released.sort()).toEqual(["blob:0", "blob:1", "blob:2"]);
    expect(read, "no byte may be read through JS on the websocket path").not.toHaveBeenCalled();
    expect(checksumFn, "no checksum may be computed through JS on the websocket path").not.toHaveBeenCalled();
  });

  it("@bugfix @regression-proof the HTTP fallback reads each frame range from the source", async () => {
    fetchMock.mockResolvedValueOnce(policyResponse());
    fetchMock.mockResolvedValueOnce(sessionResponse());
    fetchMock.mockResolvedValueOnce(jsonFrame({ kind: "session.ack" }));
    fetchMock.mockResolvedValueOnce(jsonFrame({ kind: "upload.progress", uploadId: "u1" }));
    fetchMock.mockResolvedValueOnce(jsonFrame({ kind: "upload.ack", uploadId: "u1", seq: 0 }));
    fetchMock.mockResolvedValueOnce(jsonFrame({ kind: "upload.ack", uploadId: "u1", seq: 1 }));
    fetchMock.mockResolvedValueOnce(jsonFrame({ kind: "upload.complete", uploadId: "u1", objectKeys: ["k"] }));
    fetchMock.mockResolvedValueOnce(jsonFrame({ kind: "session.ack" }));
    const bytes = Uint8Array.from([1, 2, 3, 4, 5, 6]);
    const buildWsMessage = vi.fn();
    const source: TunnelUploadSource = {
      byteLength: bytes.byteLength,
      read: async (offset, length) => bytes.slice(offset, offset + length),
      buildWsMessage,
    };

    const client = createUserStorageTunnelClient({
      getApiBaseUrl: () => "https://api.dev.spacebadger.io",
      fetchImpl: fetchMock as unknown as typeof fetch,
      preferWebSocket: false,
    });
    await client.uploadObject("token-1", "library/chunks/a", source, {
      uploadId: "u1",
      chunkSize: 4,
      checksumFn: () => "sha256:x",
    });

    const dataBodies = fetchMock.mock.calls
      .map(([, init]) => (typeof init?.body === "string" ? (JSON.parse(init.body) as { frame?: Record<string, unknown> }) : null))
      .filter((body) => body?.frame?.kind === "upload.data")
      .map((body) => Buffer.from(String(body?.frame?.ciphertextBase64), "base64").toString("hex"));
    expect(dataBodies).toEqual(["01020304", "0506"]);
    expect(buildWsMessage).not.toHaveBeenCalled();
  });
});
