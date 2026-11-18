import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import type { RuntimeFetch } from "../src/fetch";
import { createRuntimeEventStream } from "../src/events";
import { createRuntimeSession, type RuntimeSessionHandle } from "../src/session";
import { EventEmitter } from "node:events";

const SUITE = "runtime-client-events";
const BASE_URL = "http://127.0.0.1:3020";
const ENVELOPE_TAIL_MAX = 10;

class FakeWebSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  static instances: FakeWebSocket[] = [];
  static envelopeTail: Array<{
    direction: "send" | "recv";
    at: number;
    payload: unknown;
  }> = [];

  readyState = FakeWebSocket.CONNECTING;
  sentMessages: string[] = [];

  constructor(public url: string) {
    super();
    FakeWebSocket.instances.push(this);
    // Auto-connect on next tick
    setTimeout(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.emit("open");
    }, 0);
  }

  addEventListener(type: string, listener: (event?: unknown) => void) {
    this.on(type, listener);
  }

  send(data: string) {
    this.sentMessages.push(data);
    try {
      FakeWebSocket.envelopeTail.push({
        direction: "send",
        at: Date.now(),
        payload: JSON.parse(data),
      });
    } catch {
      FakeWebSocket.envelopeTail.push({
        direction: "send",
        at: Date.now(),
        payload: data,
      });
    }
    if (FakeWebSocket.envelopeTail.length > ENVELOPE_TAIL_MAX) {
      FakeWebSocket.envelopeTail.splice(
        0,
        FakeWebSocket.envelopeTail.length - ENVELOPE_TAIL_MAX,
      );
    }
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close");
  }

  simulateMessage(data: unknown) {
    try {
      FakeWebSocket.envelopeTail.push({
        direction: "recv",
        at: Date.now(),
        payload: data,
      });
      if (FakeWebSocket.envelopeTail.length > ENVELOPE_TAIL_MAX) {
        FakeWebSocket.envelopeTail.splice(
          0,
          FakeWebSocket.envelopeTail.length - ENVELOPE_TAIL_MAX,
        );
      }
    } catch {
      // ignore tail-bookkeeping failures
    }
    this.emit("message", { data: JSON.stringify(data) });
  }
}

const fakeLoginResponse = () =>
  new Response(
    JSON.stringify({
      ok: true,
      token: "ws-token",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      capabilities: { apps: ["badger"] },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const dumpEventsSnapshot = (
  label: string,
  ctx: {
    lastWs: FakeWebSocket | null;
    received?: unknown[];
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    console.error(`fake ws instance count: ${FakeWebSocket.instances.length}`);
    if (ctx.lastWs) {
      console.error(`last WS url: ${ctx.lastWs.url}`);
      console.error(`last WS readyState: ${ctx.lastWs.readyState}`);
      console.error(
        `last WS sent (${ctx.lastWs.sentMessages.length} frames):\n${JSON.stringify(
          ctx.lastWs.sentMessages.map((m) => {
            try {
              return JSON.parse(m);
            } catch {
              return m;
            }
          }),
          null,
          2,
        )}`,
      );
    } else {
      console.error(`last WS: <null>`);
    }
    console.error(
      `recent envelope tail (last ${ENVELOPE_TAIL_MAX}):\n${JSON.stringify(
        FakeWebSocket.envelopeTail,
        null,
        2,
      )}`,
    );
    if (ctx.received) {
      console.error(
        `received frames (${ctx.received.length}):\n${JSON.stringify(ctx.received, null, 2)}`,
      );
    }
    if (ctx.extra) {
      console.error(`extra:\n${JSON.stringify(ctx.extra, null, 2)}`);
    }
  } catch (err) {
    console.error(
      `(snapshot failed: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
};

const waitWithLog = async (label: string, ms: number) => {
  const start = Date.now();
  await new Promise((r) => setTimeout(r, ms));
  console.info(
    `[${SUITE}:wait] ${label} predicate=timeout-only target=${ms}ms elapsed=${Date.now() - start}ms`,
  );
};

describe("createRuntimeEventStream", () => {
  console.info(
    `[${SUITE}:setup] BASE_URL=${BASE_URL} channel=badger.ingest reconnectMs=50`,
  );

  let session: RuntimeSessionHandle;
  let fetchMock: Mock<RuntimeFetch>;
  let lastWs: FakeWebSocket | null;

  beforeEach(() => {
    lastWs = null;
    FakeWebSocket.instances = [];
    FakeWebSocket.envelopeTail = [];
    fetchMock = vi.fn().mockResolvedValue(fakeLoginResponse());
    session = createRuntimeSession({
      runtimeBaseUrl: BASE_URL,
      backendToken: "backend-abc",
      apps: ["badger"],
      fetchImpl: fetchMock,
    });
  });

  const makeStream = () =>
    createRuntimeEventStream({
      session,
      runtimeBaseUrl: BASE_URL,
      apps: ["badger"],
      channels: ["badger.ingest"],
      WebSocketImpl: class extends FakeWebSocket {
        constructor(url: string) {
          super(url);
          lastWs = this;
        }
      } as any,
      reconnectMs: 50,
    });

  it("connects and sends subscribe frame on start", async () => {
    console.info(`[${SUITE}:connect] starting stream`);
    const stream = makeStream();
    await stream.start();
    await waitWithLog("await fake WS open tick", 10);
    try {
      expect(lastWs).not.toBeNull();
      expect(lastWs!.sentMessages).toHaveLength(1);
      const subscribeFrame = JSON.parse(lastWs!.sentMessages[0]);
      expect(subscribeFrame.type).toBe("subscribe");
      expect(subscribeFrame.apps).toEqual(["badger"]);
      expect(subscribeFrame.channels).toEqual(["badger.ingest"]);
      console.info(
        `[${SUITE}:connect] OK subscribe frame sent type=${subscribeFrame.type}`,
      );
    } catch (err) {
      dumpEventsSnapshot("connect-no-subscribe-frame", {
        lastWs,
      });
      throw err;
    } finally {
      stream.stop();
    }
  });

  it("validates and delivers well-formed event frames", async () => {
    console.info(`[${SUITE}:deliver] subscribing receiver, then injecting frame`);
    const stream = makeStream();
    const received: unknown[] = [];
    stream.subscribe((frame) => received.push(frame));

    await stream.start();
    await waitWithLog("await fake WS open tick", 10);

    const validFrame = {
      eventId: "e1",
      sequence: 1,
      app: "badger",
      channel: "badger.ingest",
      event: "badger.ingest.jobs_updated",
      ts: new Date().toISOString(),
      payload: { jobs: [] },
    };
    lastWs!.simulateMessage(validFrame);

    try {
      expect(received).toHaveLength(1);
      expect((received[0] as any).eventId).toBe("e1");
      console.info(`[${SUITE}:deliver] OK received eventId=e1`);
    } catch (err) {
      dumpEventsSnapshot("deliver-frame-not-received", {
        lastWs,
        received,
        extra: { validFrame },
      });
      throw err;
    } finally {
      stream.stop();
    }
  });

  it("drops frames that fail schema validation", async () => {
    console.info(`[${SUITE}:validate] injecting two malformed frames`);
    const stream = makeStream();
    const received: unknown[] = [];
    stream.subscribe((frame) => received.push(frame));

    await stream.start();
    await waitWithLog("await fake WS open tick", 10);

    // Missing required fields
    lastWs!.simulateMessage({ garbage: true });
    // Missing app field
    lastWs!.simulateMessage({
      eventId: "e1",
      sequence: 1,
      channel: "x",
      event: "y",
      ts: "z",
      payload: {},
    });

    try {
      expect(received).toHaveLength(0);
      console.info(`[${SUITE}:validate] OK both malformed frames dropped`);
    } catch (err) {
      dumpEventsSnapshot("validate-malformed-leaked-through", {
        lastWs,
        received,
      });
      throw err;
    } finally {
      stream.stop();
    }
  });

  it("unsubscribe removes listener", async () => {
    console.info(`[${SUITE}:unsubscribe] subscribing then unsubscribing`);
    const stream = makeStream();
    const received: unknown[] = [];
    const unsub = stream.subscribe((frame) => received.push(frame));

    await stream.start();
    await waitWithLog("await fake WS open tick", 10);

    unsub();

    lastWs!.simulateMessage({
      eventId: "e1",
      sequence: 1,
      app: "badger",
      channel: "badger.ingest",
      event: "badger.ingest.jobs_updated",
      ts: new Date().toISOString(),
      payload: {},
    });

    try {
      expect(received).toHaveLength(0);
      console.info(`[${SUITE}:unsubscribe] OK no frame received after unsub`);
    } catch (err) {
      dumpEventsSnapshot("unsubscribe-listener-still-active", {
        lastWs,
        received,
      });
      throw err;
    } finally {
      stream.stop();
    }
  });

  it("reconnects after close", async () => {
    console.info(`[${SUITE}:reconnect] expecting reconnect after close`);
    const stream = makeStream();
    await stream.start();
    await waitWithLog("await first WS open", 10);

    const firstWs = lastWs!;
    firstWs.close();
    console.info(
      `[${SUITE}:reconnect] firstWs closed; waiting for reconnect (reconnectMs=50)`,
    );

    await waitWithLog("await reconnect timer", 100);

    try {
      expect(lastWs).not.toBe(firstWs);
      console.info(
        `[${SUITE}:reconnect] OK new WS instance after close (count=${FakeWebSocket.instances.length})`,
      );
    } catch (err) {
      dumpEventsSnapshot("reconnect-did-not-spawn-new-ws", {
        lastWs,
        extra: {
          firstWsUrl: firstWs.url,
          firstWsReadyState: firstWs.readyState,
          totalInstances: FakeWebSocket.instances.length,
        },
      });
      throw err;
    } finally {
      stream.stop();
    }
  });

  it("a 4401 close (runtime ended the session) invalidates the cached token and the reconnect logs in again @req RT-SEC-02[runtime]", async () => {
    vi.useFakeTimers();
    // A Response body can be read once, so every login needs a fresh one.
    fetchMock.mockImplementation(async () => fakeLoginResponse());
    try {
      const stream = makeStream();
      await stream.start();
      await vi.advanceTimersByTimeAsync(10);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const firstWs = lastWs!;
      firstWs.readyState = FakeWebSocket.CLOSED;
      firstWs.emit("close", { code: 4401, reason: "session_expired" });
      await vi.advanceTimersByTimeAsync(100);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(lastWs).not.toBe(firstWs);
      stream.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("an ordinary close reuses the cached token on reconnect", async () => {
    vi.useFakeTimers();
    try {
      const stream = makeStream();
      await stream.start();
      await vi.advanceTimersByTimeAsync(10);
      const firstWs = lastWs!;
      firstWs.emit("close", { code: 1006 });
      await vi.advanceTimersByTimeAsync(100);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(lastWs).not.toBe(firstWs);
      stream.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop() prevents reconnection", async () => {
    console.info(`[${SUITE}:stop] verifying stop() halts reconnect loop`);
    const stream = makeStream();
    await stream.start();
    await waitWithLog("await first WS open", 10);

    const firstWs = lastWs!;
    stream.stop();
    console.info(`[${SUITE}:stop] stream stopped`);

    await waitWithLog("await well past reconnect window", 100);

    try {
      // No new WS was created after the first one
      expect(lastWs).toBe(firstWs);
      console.info(`[${SUITE}:stop] OK no new WS after stop`);
    } catch (err) {
      dumpEventsSnapshot("stop-allowed-reconnect", {
        lastWs,
        extra: {
          firstWsUrl: firstWs.url,
          totalInstances: FakeWebSocket.instances.length,
        },
      });
      throw err;
    }
  });
});
