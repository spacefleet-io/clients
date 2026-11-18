import { describe, expect, it } from "vitest";
import { createStorageTunnelWsConnection } from "../src/storageTransport/v2";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  sent: string[] = [];
  url: string;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.onopen?.({});
    });
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.onclose?.({});
  }

  emitMessage(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

// On assertion failure, dump the fake socket + connection state so a missed
// frame / open-state mismatch is diagnosable offline. try/catch so a dump
// failure can't mask the real assertion.
const dumpWsSnapshot = (
  label: string,
  ctx: { ws?: FakeWebSocket; conn?: { isOpen: () => boolean }; frame?: unknown },
) => {
  try {
    console.error(`=== [storage-tunnel-v2-ws-client:${label}] snapshot ===`);
    console.error(`fakeWebSocket instances=${FakeWebSocket.instances.length}`);
    if (ctx.ws) {
      console.error(`ws.url=${ctx.ws.url} ws.sent(${ctx.ws.sent.length})=${JSON.stringify(ctx.ws.sent, null, 2)}`);
    }
    if (ctx.conn) {
      console.error(`conn.isOpen=${ctx.conn.isOpen()}`);
    }
    if (ctx.frame !== undefined) {
      console.error(`received frame=${JSON.stringify(ctx.frame, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("storage transport v2 ws tunnel client", () => {
  it("opens connection, sends frame, and resolves with gateway frame", async () => {
    console.info(`[storage-tunnel-v2-ws-client:setup] opening ws connection to wss://api.dev.spacebadger.io/storage/tunnel/ws`);
    const conn = await createStorageTunnelWsConnection({
      wsEndpoint: "wss://api.dev.spacebadger.io/storage/tunnel/ws",
      token: "token-1",
      sessionId: "session-1",
      WebSocketImpl: FakeWebSocket,
    });
    const ws = FakeWebSocket.instances.at(-1)!;
    console.info(`[storage-tunnel-v2-ws-client:send] sending session.start frame (fake instances=${FakeWebSocket.instances.length})`);
    const promise = conn.sendFrame({
      kind: "session.start",
      sessionId: "session-1",
      token: "token-1",
      clientType: "desktop",
      clientVersion: "test",
    });
    console.info(`[storage-tunnel-v2-ws-client:recv] emitting gateway session.ack`);
    ws.emitMessage({
      frame: {
        kind: "session.ack",
        sessionId: "session-1",
        protocolVersion: 1,
      },
    });
    const frame = await promise;
    console.info(
      `[storage-tunnel-v2-ws-client:recv] resolved frame.kind=${frame.kind} ws.sent=${ws.sent.length} conn.isOpen=${conn.isOpen()}`,
    );
    try {
      expect(frame.kind).toBe("session.ack");
      expect(ws.sent.length).toBe(1);
      expect(conn.isOpen()).toBe(true);
      conn.close();
      expect(conn.isOpen()).toBe(false);
    } catch (err) {
      dumpWsSnapshot("open-send-resolve", { ws, conn, frame });
      throw err;
    }
  });

  it("surfaces server error payloads", async () => {
    console.info(`[storage-tunnel-v2-ws-client:setup] opening ws connection (error-payload case)`);
    const conn = await createStorageTunnelWsConnection({
      wsEndpoint: "wss://api.dev.spacebadger.io/storage/tunnel/ws",
      token: "token-1",
      sessionId: "session-1",
      WebSocketImpl: FakeWebSocket,
    });
    const ws = FakeWebSocket.instances.at(-1)!;
    console.info(`[storage-tunnel-v2-ws-client:send] sending upload.open frame, then emitting error payload`);
    const promise = conn.sendFrame({
      kind: "upload.open",
      uploadId: "up-1",
      objectKey: "library/chunks/test",
      objectNamespace: "library",
      logicalRef: "media:1",
    });
    ws.emitMessage({ error: "out_of_order" });
    try {
      await expect(promise).rejects.toThrow("out_of_order");
    } catch (err) {
      dumpWsSnapshot("server-error-payload", { ws, conn });
      throw err;
    }
  });
});
