// @req UX-TV-02[badger-mobile,badger-tv]
/**
 * @level unit
 * @why The Play on TV transport is the account's peer relay: registration outcomes drive what the phone shows, the
 *   peer list feeds the TV picker, `delivered` tells the phone whether the TV listens, and the stream must keep
 *   reconnecting (server closes, errors, silent dead sockets). The channel on top must seal every send and only hand
 *   over messages that open with the account key, are fresh, unseen and from the relay's claimed sender.
 */
import * as nodeCrypto from "crypto";
import { Buffer } from "buffer";
import { describe, expect, it } from "vitest";
import {
  createHttpRelayTransport,
  createPlayOnTvChannel,
  type EventSourceLike,
  type HttpRelayOptions,
  type ListenStatus,
  type RelayEvent,
  type RelayTransport,
} from "../src/lib/playOnTv/channel";
import { buildMessage, type RemoteBody } from "../src/lib/playOnTv/protocol";
import { createRemoteSealer, type SealCrypto, type SealedEnvelope } from "../src/lib/playOnTv/seal";
import { createManualClock } from "./play-on-tv-fakes";

type Call = { url: string; method?: string; headers: Record<string, string>; body?: unknown };
type Reply = { status: number; body?: unknown } | Error;

const makeFetch = (replies: Reply[]) => {
  const calls: Call[] = [];
  const fetch: HttpRelayOptions["fetch"] = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const reply = replies.shift();
    if (!reply) throw new Error("no reply queued");
    if (reply instanceof Error) throw reply;
    return { status: reply.status, ok: reply.status >= 200 && reply.status < 300, json: async () => reply.body };
  };
  return { fetch, calls };
};

type FakeSource = EventSourceLike & {
  url: string;
  headers: Record<string, string>;
  closed: boolean;
  emit: (type: string, data?: string | null) => void;
};

const makeEventSources = () => {
  const sources: FakeSource[] = [];
  const open: HttpRelayOptions["openEventSource"] = (url, headers) => {
    const listeners = new Map<string, Array<(event: { data?: string | null }) => void>>();
    const source: FakeSource = {
      url,
      headers,
      closed: false,
      addEventListener(type, listener) {
        listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      },
      close() {
        source.closed = true;
      },
      emit(type, data) {
        for (const listener of listeners.get(type) ?? []) listener({ data });
      },
    };
    sources.push(source);
    return source;
  };
  return { sources, open };
};

const makeTransport = (overrides: Partial<HttpRelayOptions> & { replies?: Reply[] } = {}) => {
  const { fetch, calls } = makeFetch(overrides.replies ?? []);
  const es = makeEventSources();
  const clock = createManualClock(1_000);
  const logs: Array<[string, Record<string, unknown> | undefined]> = [];
  const transport = createHttpRelayTransport({
    peerId: "phone 1",
    getApiBaseUrl: () => "https://api.test//",
    getToken: () => "tok",
    fetch,
    openEventSource: es.open,
    log: (event, data) => {
      logs.push([event, data]);
      console.info("[phase:transport.log]", event, JSON.stringify(data ?? {}));
    },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: clock.now,
    reconnectMs: 2_000,
    staleMs: 50_000,
    ...overrides,
  });
  return { transport, calls, es, clock, logs };
};

describe("createHttpRelayTransport.register", () => {
  it("posts the peer and maps statuses", async () => {
    const cases: Array<[Reply, string]> = [
      [{ status: 200, body: {} }, "ok"],
      [{ status: 403 }, "refused"],
      [{ status: 409 }, "refused"],
      [{ status: 401 }, "unauthorized"],
      [{ status: 500 }, "error"],
      [new Error("offline"), "error"],
    ];
    for (const [reply, expected] of cases) {
      const { transport, calls } = makeTransport({ replies: [reply] });
      const result = await transport.register("mobile");
      console.info("[phase:register]", JSON.stringify({ status: reply instanceof Error ? "throw" : reply.status, result }));
      expect(result).toBe(expected);
      expect(calls[0]).toMatchObject({
        url: "https://api.test/p2p/discovery/register",
        method: "POST",
        headers: { Authorization: "Bearer tok", "x-space-app": "badger", "Content-Type": "application/json" },
        body: { peerId: "phone 1", kind: "mobile" },
      });
    }
  });

  it("is unauthorized without a token and makes no request", async () => {
    const { transport, calls } = makeTransport({ getToken: () => null });
    expect(await transport.register("tv")).toBe("unauthorized");
    expect(await transport.listPeers()).toEqual({ ok: false, reason: "signed_out" });
    expect(await transport.send("tv-1", { v: 1, nonce: "a", ciphertext: "b" })).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("createHttpRelayTransport.listPeers", () => {
  it("normalises peers and drops malformed entries", async () => {
    const { transport, calls } = makeTransport({
      replies: [
        {
          status: 200,
          body: {
            peers: [
              { peerId: "tv-1", kind: "tv", name: "  Living room  ", updatedAt: 5 },
              { peerId: "tv-2", kind: "tv", name: "   " },
              { peerId: "tv-3", kind: "tv", name: 7, updatedAt: "x" },
              { peerId: 4, kind: "tv" },
              { peerId: "x" },
              null,
              "junk",
            ],
          },
        },
      ],
    });
    const listed = await transport.listPeers();
    console.info("[phase:peers]", JSON.stringify(listed));
    expect(calls[0].url).toBe("https://api.test/p2p/discovery/peers?peerId=phone%201");
    expect(listed).toEqual({
      ok: true,
      peers: [
        { peerId: "tv-1", kind: "tv", name: "Living room", updatedAt: 5 },
        { peerId: "tv-2", kind: "tv", name: null, updatedAt: 0 },
        { peerId: "tv-3", kind: "tv", name: null, updatedAt: 0 },
      ],
    });
  });

  it("reports a failed request or a throw as a failure, never as an empty list (no TV)", async () => {
    const cases: Array<[Reply, unknown]> = [
      [{ status: 500 }, { ok: false, reason: "server", status: 500 }],
      [{ status: 403 }, { ok: false, reason: "server", status: 403 }],
      [new Error("down"), { ok: false, reason: "offline" }],
    ];
    for (const [reply, expected] of cases) {
      const { transport } = makeTransport({ replies: [reply] });
      const listed = await transport.listPeers();
      console.info("[phase:peers.fail]", JSON.stringify({ reply: reply instanceof Error ? "throw" : reply, listed }));
      expect(listed).toEqual(expected);
    }
  });

  it("returns an empty list for a body without peers", async () => {
    for (const reply of [{ status: 200, body: {} }, { status: 200, body: { peers: "x" } }]) {
      const { transport } = makeTransport({ replies: [reply] });
      const listed = await transport.listPeers();
      console.info("[phase:peers.empty]", JSON.stringify({ reply, listed }));
      expect(listed).toEqual({ ok: true, peers: [] });
    }
  });
});

describe("createHttpRelayTransport.send", () => {
  const envelope: SealedEnvelope = { v: 1, nonce: "n", ciphertext: "c" };

  it("returns the delivered count", async () => {
    const { transport, calls } = makeTransport({ replies: [{ status: 200, body: { delivered: 2 } }] });
    expect(await transport.send("tv-1", envelope)).toBe(2);
    expect(calls[0]).toMatchObject({
      url: "https://api.test/p2p/relay/send",
      method: "POST",
      body: { fromPeerId: "phone 1", toPeerId: "tv-1", envelope },
    });
  });

  it("returns 0 when the count is missing and null on failure", async () => {
    const cases: Array<[Reply, number | null]> = [
      [{ status: 200, body: {} }, 0],
      [{ status: 200, body: { delivered: "2" } }, 0],
      [{ status: 502 }, null],
      [new Error("offline"), null],
    ];
    for (const [reply, expected] of cases) {
      const { transport } = makeTransport({ replies: [reply] });
      const delivered = await transport.send("tv-1", envelope);
      console.info("[phase:send]", JSON.stringify({ reply: reply instanceof Error ? "throw" : reply, delivered }));
      expect(delivered).toBe(expected);
    }
  });
});

describe("createHttpRelayTransport.listen", () => {
  it("opens the stream, reports open and forwards relayed events", () => {
    const { transport, es, logs } = makeTransport();
    const events: RelayEvent[] = [];
    const statuses: ListenStatus[] = [];
    transport.listen((event) => events.push(event), (status) => statuses.push(status));
    expect(es.sources).toHaveLength(1);
    const [source] = es.sources;
    expect(source.url).toBe("https://api.test/p2p/relay/stream?peerId=phone%201");
    expect(source.headers).toEqual({ Authorization: "Bearer tok", "x-space-app": "badger" });
    source.emit("open");
    source.emit("message", JSON.stringify({ fromPeerId: "tv-1", envelope: { v: 1 } }));
    source.emit("message", JSON.stringify({ envelope: { v: 1 } }));
    source.emit("message", null);
    source.emit("message", "{not json");
    console.info("[phase:listen]", JSON.stringify({ events, statuses }));
    expect(statuses).toEqual(["open"]);
    expect(events).toEqual([{ fromPeerId: "tv-1", envelope: { v: 1 } }]);
    expect(logs.some(([event]) => event === "stream.parse_failed")).toBe(true);
  });

  it("reconnects after an error and after a close, ignoring the dead source", () => {
    const { transport, es, clock } = makeTransport();
    const statuses: ListenStatus[] = [];
    transport.listen(() => undefined, (status) => statuses.push(status));
    es.sources[0].emit("error");
    expect(es.sources[0].closed).toBe(true);
    clock.advance(1_999);
    expect(es.sources).toHaveLength(1);
    // A second error from the same (dead) source must not schedule another reconnect.
    es.sources[0].emit("error");
    clock.advance(1);
    console.info("[phase:reconnect.error]", JSON.stringify({ sources: es.sources.length, statuses }));
    expect(es.sources).toHaveLength(2);
    es.sources[1].emit("close");
    expect(es.sources[1].closed).toBe(true);
    clock.advance(2_000);
    console.info("[phase:reconnect.close]", JSON.stringify({ sources: es.sources.length, statuses }));
    expect(es.sources).toHaveLength(3);
    expect(es.sources[2].closed).toBe(false);
    expect(statuses.filter((s) => s === "closed").length).toBeGreaterThanOrEqual(2);
  });

  it("retries without a token instead of opening a stream", () => {
    let token: string | null = null;
    const { transport, es, clock } = makeTransport({ getToken: () => token });
    transport.listen(() => undefined);
    expect(es.sources).toHaveLength(0);
    clock.advance(2_000);
    expect(es.sources).toHaveLength(0);
    token = "later";
    clock.advance(2_000);
    console.info("[phase:no_token]", JSON.stringify({ sources: es.sources.length }));
    expect(es.sources).toHaveLength(1);
    expect(es.sources[0].headers.Authorization).toBe("Bearer later");
  });

  it("reconnects a stream that went silent (stale watchdog), not one that pings", () => {
    const { transport, es, clock, logs } = makeTransport();
    transport.listen(() => undefined);
    clock.advance(30_000);
    es.sources[0].emit("ping");
    clock.advance(20_000); // watchdog fires at 50 s: last event 20 s ago -> fresh
    console.info("[phase:stale.fresh]", JSON.stringify({ sources: es.sources.length, closed: es.sources[0].closed }));
    expect(es.sources[0].closed).toBe(false);
    clock.advance(50_000); // next watchdog at 100 s: last event 70 s ago -> stale
    expect(es.sources[0].closed).toBe(true);
    expect(logs.some(([event, data]) => event === "stream.reconnect" && data?.reason === "stale")).toBe(true);
    clock.advance(2_000);
    console.info("[phase:stale.reconnected]", JSON.stringify({ sources: es.sources.length }));
    expect(es.sources).toHaveLength(2);
    expect(es.sources[1].closed).toBe(false);
  });

  it("stop closes the stream and cancels every timer", () => {
    const { transport, es, clock } = makeTransport();
    const stop = transport.listen(() => undefined);
    es.sources[0].emit("error");
    stop();
    console.info("[phase:stop]", JSON.stringify({ pendingTimers: clock.pending() }));
    expect(clock.pending()).toBe(0);
    clock.advance(200_000);
    expect(es.sources).toHaveLength(1);
    expect(es.sources[0].closed).toBe(true);
  });
});

const crypto = nodeCrypto as unknown as SealCrypto;
const KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => i * 3)).toString("base64");
const OTHER_KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => 255 - i)).toString("base64");

const makeFakeTransport = (peerId: string, delivered: number | null = 1) => {
  const sent: Array<{ toPeerId: string; envelope: SealedEnvelope }> = [];
  let emit: ((event: RelayEvent) => void) | null = null;
  let stopped = false;
  const transport: RelayTransport = {
    peerId,
    register: async () => "ok",
    listPeers: async () => ({ ok: true, peers: [] }),
    send: async (toPeerId, envelope) => {
      sent.push({ toPeerId, envelope });
      return delivered;
    },
    listen: (onEvent) => {
      emit = onEvent;
      return () => {
        stopped = true;
      };
    },
  };
  return { transport, sent, deliver: (event: RelayEvent) => emit?.(event), isStopped: () => stopped };
};

describe("createPlayOnTvChannel", () => {
  const NOW = 50_000_000;

  it("seals every send with its own peer id as sender", async () => {
    const fake = makeFakeTransport("phone-1", 1);
    const logs: Array<[string, Record<string, unknown> | undefined]> = [];
    const channel = createPlayOnTvChannel({
      transport: fake.transport,
      sealer: createRemoteSealer(crypto, KEY),
      now: () => NOW,
      log: (event, data) => logs.push([event, data]),
    });
    const body: RemoteBody = { type: "start", mediaId: "media-secret", episodeId: null, positionSeconds: 30, tracks: null };
    expect(await channel.send("tv-1", body)).toBe(1);
    const { toPeerId, envelope } = fake.sent[0];
    console.info("[phase:channel.send]", JSON.stringify({ toPeerId, logs }));
    expect(toPeerId).toBe("tv-1");
    expect(JSON.stringify(envelope)).not.toContain("media-secret");
    expect(JSON.stringify(logs)).not.toContain("media-secret");
    const opened = createRemoteSealer(crypto, KEY).open(envelope);
    expect(opened).toMatchObject({ from: "phone-1", to: "tv-1", sentAt: NOW, body });
  });

  it("passes the transport's delivered count through, null included", async () => {
    const fake = makeFakeTransport("phone-1", null);
    const channel = createPlayOnTvChannel({ transport: fake.transport, sealer: createRemoteSealer(crypto, KEY), now: () => NOW });
    expect(await channel.send("tv-1", { type: "hello" })).toBeNull();
  });

  it("@bugfix delivers valid messages and drops unopenable, replayed, stale, re-attributed and redirected ones", () => {
    const fake = makeFakeTransport("tv-1");
    const logs: Array<[string, Record<string, unknown> | undefined]> = [];
    const channel = createPlayOnTvChannel({
      transport: fake.transport,
      sealer: createRemoteSealer(crypto, KEY),
      now: () => NOW,
      log: (event, data) => {
        logs.push([event, data]);
        console.info("[phase:channel.log]", event, JSON.stringify(data ?? {}));
      },
    });
    const received: Array<[string, RemoteBody]> = [];
    const stop = channel.listen((from, body) => received.push([from, body]));
    const sealer = createRemoteSealer(crypto, KEY);

    const sealFor = (to: string, body: RemoteBody, sentAt = NOW) => sealer.seal(buildMessage("phone-1", to, body, sentAt));
    const good = sealFor("tv-1", { type: "pause" });
    fake.deliver({ fromPeerId: "phone-1", envelope: good });
    fake.deliver({ fromPeerId: "phone-1", envelope: good }); // replay
    fake.deliver({ fromPeerId: "phone-2", envelope: sealFor("tv-1", { type: "play" }) }); // re-attributed
    fake.deliver({ fromPeerId: "phone-1", envelope: sealFor("tv-2", { type: "stop" }) }); // sealed for another TV, redirected here
    fake.deliver({ fromPeerId: "phone-1", envelope: sealFor("tv-1", { type: "play" }, NOW - 11 * 60_000) }); // stale
    fake.deliver({ fromPeerId: "phone-1", envelope: createRemoteSealer(crypto, OTHER_KEY).seal(buildMessage("phone-1", "tv-1", { type: "play" }, NOW)) });
    fake.deliver({ fromPeerId: "phone-1", envelope: { plain: "text" } });
    fake.deliver({ fromPeerId: "phone-1", envelope: sealFor("tv-1", { type: "seekBy", deltaSeconds: 10 }) });

    const reasons = logs.filter(([event]) => event === "receive.dropped").map(([, data]) => data?.reason);
    console.info("[phase:channel.receive]", JSON.stringify({ received, reasons }));
    expect(received).toEqual([
      ["phone-1", { type: "pause" }],
      ["phone-1", { type: "seekBy", deltaSeconds: 10 }],
    ]);
    expect(reasons).toEqual(["duplicate", "sender_mismatch", "recipient_mismatch", "stale", "unopenable", "unopenable"]);
    stop();
    expect(fake.isStopped()).toBe(true);
  });
});
