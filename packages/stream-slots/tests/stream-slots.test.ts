/**
 * @level unit
 * `@space/stream-slots`: the typed client against a fake `fetch` speaking the API's documented answers, the
 * `StreamSlot` controller (20 s heartbeat, takeover callback, expiry restart, stop) on fake timers, and the prompt
 * text in every language. The API side is proven by the API's own integration tests.
 */
import { describe, expect, it, vi } from "vitest";
import {
  STREAM_LIMITS,
  STREAM_SLOT_LANGUAGES,
  STREAM_SLOT_STRINGS,
  StreamSlot,
  StreamSlotsError,
  createStreamSlotsClient,
  streamSlotText,
  type StreamSlotTimers,
} from "../src/index";

const SUITE = "stream-slots";

type Reply = { status: number; body?: unknown };

/** A fake API: answers queued per "METHOD path"; records every request. */
const fakeApi = () => {
  const queues = new Map<string, Reply[]>();
  const requests: Array<{ method: string; url: string; headers: Record<string, string>; body: unknown }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const path = new URL(url).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, url, headers: (init?.headers ?? {}) as Record<string, string>, body });
    const reply = queues.get(`${method} ${path}`)?.shift();
    console.info(`[${SUITE}] ${method} ${path} ${body ? JSON.stringify(body) : ""} -> ${reply ? reply.status : "NO REPLY QUEUED"}`);
    if (!reply) throw new TypeError("network down");
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status });
  }) as typeof fetch;
  return {
    fetchImpl,
    requests,
    queue: (key: string, ...replies: Reply[]) => queues.set(key, [...(queues.get(key) ?? []), ...replies]),
  };
};

const started = (streamId: string) => ({
  status: 201,
  body: { streamId, profileId: "p1", heartbeatIntervalSeconds: 20, expiresInSeconds: 60 },
});

const fakeTimers = () => {
  const intervals = new Map<number, { callback: () => void; ms: number }>();
  let next = 0;
  const timers: StreamSlotTimers = {
    setInterval: (callback, ms) => {
      next += 1;
      intervals.set(next, { callback, ms });
      return next;
    },
    clearInterval: (handle) => intervals.delete(handle as number),
  };
  return { timers, intervals, tick: () => [...intervals.values()].forEach((entry) => entry.callback()) };
};

/** Drains pending microtasks so the controller's awaited fetch/json chain settles; no real clock involved. */
const flush = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

describe("stream slots client", () => {
  it("sends the session token and body, and maps 201 / 409 stream_limit", async () => {
    const api = fakeApi();
    const client = createStreamSlotsClient({ baseUrl: "https://api.test/", getToken: () => "tok", fetch: api.fetchImpl });
    api.queue("POST /playback/streams", started("s1"), {
      status: 409,
      body: { error: "stream_limit", limit: 1, playingOn: [{ streamId: "s0", deviceName: "Living room TV", deviceType: "tv", startedAt: "2026-11-06T10:00:00.000Z" }] },
    });
    expect(await client.startStream({ app: "badger" })).toEqual({ status: "started", stream: started("s1").body });
    expect(api.requests[0]).toMatchObject({ url: "https://api.test/playback/streams", headers: { Authorization: "Bearer tok" }, body: { app: "badger" } });
    const limit = await client.startStream({ app: "badger", profileId: "p1" });
    expect(limit).toEqual({ status: "limit", limit: 1, playingOn: [expect.objectContaining({ deviceName: "Living room TV" })] });
  });

  it("maps heartbeat 200 / 409 stream_taken_over / 404 stream_ended and treats stop's 404 as done", async () => {
    const api = fakeApi();
    const client = createStreamSlotsClient({ baseUrl: "https://api.test", getToken: async () => "tok", fetch: api.fetchImpl });
    api.queue(
      "POST /playback/streams/s1/heartbeat",
      { status: 200, body: { expiresInSeconds: 60 } },
      { status: 409, body: { error: "stream_taken_over", byDeviceName: "Office PC", byDeviceType: "desktop" } },
      { status: 404, body: { error: "stream_ended" } }
    );
    expect(await client.heartbeat("s1")).toEqual({ status: "alive", expiresInSeconds: 60 });
    expect(await client.heartbeat("s1")).toEqual({ status: "taken_over", by: { deviceName: "Office PC", deviceType: "desktop" } });
    expect(await client.heartbeat("s1")).toEqual({ status: "ended" });
    api.queue("DELETE /playback/streams/s1", { status: 204 }, { status: 404, body: { error: "not_found" } });
    await client.stopStream("s1");
    await client.stopStream("s1");
  });

  it("throws StreamSlotsError on 401, 5xx and network failure", async () => {
    const api = fakeApi();
    const client = createStreamSlotsClient({ baseUrl: "https://api.test", getToken: () => null, fetch: api.fetchImpl });
    api.queue("POST /playback/streams", { status: 401, body: { error: "unauthorized" } });
    await expect(client.startStream({ app: "parrot" })).rejects.toMatchObject({ name: "StreamSlotsError", status: 401, code: "unauthorized" });
    expect(api.requests[0].headers.Authorization).toBeUndefined();
    api.queue("POST /playback/streams/s1/heartbeat", { status: 503 });
    await expect(client.heartbeat("s1")).rejects.toBeInstanceOf(StreamSlotsError);
    await expect(client.stopStream("s1")).rejects.toMatchObject({ status: 0, operation: "stop" });
  });
});

describe("StreamSlot controller", () => {
  const setup = () => {
    const api = fakeApi();
    const clock = fakeTimers();
    const onTakenOver = vi.fn();
    const onError = vi.fn();
    const log = vi.fn((event: string, fields: Record<string, unknown>) => console.info(`[${SUITE}] ${event} ${JSON.stringify(fields)}`));
    const slot = new StreamSlot({
      client: createStreamSlotsClient({ baseUrl: "https://api.test", getToken: () => "tok", fetch: api.fetchImpl }),
      app: "badger",
      profileId: "p1",
      onTakenOver,
      onError,
      log,
      timers: clock.timers,
    });
    return { api, clock, slot, onTakenOver, onError };
  };

  it("starts, heartbeats every 20 s and stops on takeover, calling onTakenOver once with the other device", async () => {
    const { api, clock, slot, onTakenOver } = setup();
    api.queue("POST /playback/streams", started("s1"));
    expect((await slot.start()).status).toBe("started");
    expect(slot.streamId).toBe("s1");
    expect([...clock.intervals.values()].map((entry) => entry.ms)).toEqual([20_000]);
    expect(api.requests[0].body).toEqual({ app: "badger", profileId: "p1", kind: "play", takeover: false });

    api.queue("POST /playback/streams/s1/heartbeat", { status: 200, body: { expiresInSeconds: 60 } });
    clock.tick();
    await flush();
    expect(onTakenOver).not.toHaveBeenCalled();

    api.queue("POST /playback/streams/s1/heartbeat", { status: 409, body: { error: "stream_taken_over", byDeviceName: "Office PC", byDeviceType: "desktop" } });
    clock.tick();
    await flush();
    expect(onTakenOver).toHaveBeenCalledTimes(1);
    expect(onTakenOver).toHaveBeenCalledWith({ deviceName: "Office PC", deviceType: "desktop" });
    expect(slot.streamId).toBeNull();
    expect(clock.intervals.size).toBe(0);
  });

  it("at the limit returns the playing devices and starts with takeover when the user picks Play here", async () => {
    const { api, slot } = setup();
    api.queue("POST /playback/streams", {
      status: 409,
      body: { error: "stream_limit", limit: 1, playingOn: [{ streamId: "s0", deviceName: null, deviceType: "tv", startedAt: "2026-11-06T10:00:00.000Z" }] },
    });
    const first = await slot.start();
    expect(first.status).toBe("limit");
    expect(slot.streamId).toBeNull();
    api.queue("POST /playback/streams", started("s2"));
    expect((await slot.start({ takeover: true })).status).toBe("started");
    expect(api.requests[1].body).toMatchObject({ takeover: true });
    expect(slot.streamId).toBe("s2");
  });

  it("after an expiry (404 stream_ended) takes a slot again without taking over", async () => {
    const { api, clock, slot, onTakenOver } = setup();
    api.queue("POST /playback/streams", started("s1"), started("s3"));
    await slot.start();
    api.queue("POST /playback/streams/s1/heartbeat", { status: 404, body: { error: "stream_ended" } });
    clock.tick();
    await flush();
    await flush();
    expect(slot.streamId).toBe("s3");
    expect(api.requests.at(-1)?.body).toMatchObject({ takeover: false });
    expect(onTakenOver).not.toHaveBeenCalled();
    expect(clock.intervals.size).toBe(1);
  });

  it("a failed heartbeat goes to onError and the slot keeps beating; stop frees the slot", async () => {
    const { api, clock, slot, onError } = setup();
    api.queue("POST /playback/streams", started("s1"));
    await slot.start();
    clock.tick();
    await flush();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(slot.streamId).toBe("s1");
    api.queue("DELETE /playback/streams/s1", { status: 204 });
    await slot.stop();
    expect(slot.streamId).toBeNull();
    expect(clock.intervals.size).toBe(0);
    expect(api.requests.at(-1)).toMatchObject({ method: "DELETE" });
  });
});

describe("prompt text", () => {
  it("carries every key in en, fr, nl and de with the {device} placeholder where needed", () => {
    for (const language of STREAM_SLOT_LANGUAGES) {
      const strings = STREAM_SLOT_STRINGS[language];
      expect(strings.alreadyPlaying).toContain("{device}");
      expect(strings.playingElsewhere).toContain("{device}");
      expect(strings.playHere.length).toBeGreaterThan(0);
      expect(strings.cancel.length).toBeGreaterThan(0);
    }
  });

  it("fills the device name, or a generic label from its type, and falls back to English", () => {
    expect(streamSlotText("en", "alreadyPlaying", { deviceName: "Living room TV", deviceType: "tv" })).toBe("Already playing on Living room TV. Play here instead?");
    expect(streamSlotText("fr-FR", "playingElsewhere", { deviceName: null, deviceType: "desktop" })).toBe("Lecture en cours sur un ordinateur");
    expect(streamSlotText("de", "alreadyPlaying", { deviceName: " ", deviceType: null })).toBe(
      "Wird bereits auf einem anderen Gerät abgespielt. Stattdessen hier abspielen?"
    );
    expect(streamSlotText("ja", "playHere")).toBe("Play here");
  });

  it("keeps the ACCT-STREAM-01 limits", () => {
    expect(STREAM_LIMITS).toEqual({ badger: 1, parrot: 2 });
  });
});
