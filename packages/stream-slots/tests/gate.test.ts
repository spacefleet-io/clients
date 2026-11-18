/**
 * @level unit
 * `StreamSlotGate`: the player-facing flow the phone, TV and Parrot players share (ACCT-STREAM-01..04): ask before
 * playing, the "Play here instead?" question at the limit, takeover, the taken-over notice, release, casting, and
 * what happens when the API cannot be reached. Runs against a fake `StreamSlotsClient` and fake timers.
 * The per-app wiring is proven next to each app (badger-mobile `tests/stream-slot-phone.test.ts`, Parrot phone
 * `tests/stream-slot.test.ts`, Parrot desktop `tests/stream-slot.test.tsx`).
 */
import { describe, expect, it } from "vitest";
import {
  StreamSlotGate,
  StreamSlotsError,
  deviceToTakeOver,
  type HeartbeatResult,
  type StartStreamRequest,
  type StartStreamResult,
  type StreamSlotGateState,
  type StreamSlotsClient,
  type StreamSlotTimers,
} from "../src/index";

const SUITE = "stream-slots.gate";

type Step = StartStreamResult | Error;

const fakeClient = () => {
  const starts: StartStreamRequest[] = [];
  const stops: string[] = [];
  const startReplies: Step[] = [];
  const beatReplies: Array<HeartbeatResult | Error> = [];
  const client: StreamSlotsClient = {
    startStream: async (request) => {
      starts.push(request);
      const reply = startReplies.shift();
      console.info(`[${SUITE}] start ${JSON.stringify(request)} -> ${reply instanceof Error ? reply.message : (reply?.status ?? "none")}`);
      if (!reply) throw new Error("no start reply queued");
      if (reply instanceof Error) throw reply;
      return reply;
    },
    heartbeat: async (streamId) => {
      const reply = beatReplies.shift() ?? { status: "alive", expiresInSeconds: 60 };
      console.info(`[${SUITE}] heartbeat ${streamId} -> ${reply instanceof Error ? reply.message : reply.status}`);
      if (reply instanceof Error) throw reply;
      return reply;
    },
    stopStream: async (streamId) => {
      console.info(`[${SUITE}] stop ${streamId}`);
      stops.push(streamId);
    },
  };
  return { client, starts, stops, startReplies, beatReplies };
};

const fakeTimers = () => {
  const intervals = new Map<number, () => void>();
  let next = 0;
  const timers: StreamSlotTimers = {
    setInterval: (callback) => {
      next += 1;
      intervals.set(next, callback);
      return next;
    },
    clearInterval: (handle) => intervals.delete(handle as number),
  };
  return { timers, tick: () => [...intervals.values()].forEach((callback) => callback()), count: () => intervals.size };
};

const started = (streamId: string): StartStreamResult => ({
  status: "started",
  stream: { streamId, profileId: "p1", heartbeatIntervalSeconds: 20, expiresInSeconds: 60 },
});
const atLimit = (deviceName: string | null, deviceType = "tv"): StartStreamResult => ({
  status: "limit",
  limit: 1,
  playingOn: [{ streamId: "other", deviceName, deviceType, startedAt: "2026-11-06T10:00:00Z" }],
});

/** Settles the fake client's already-resolved promises (microtasks only, no clock). */
const flush = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

const makeGate = (profileId: string | null = "p1", app: "badger" | "parrot" = "badger") => {
  const api = fakeClient();
  const clock = fakeTimers();
  const takenOver: unknown[] = [];
  const states: StreamSlotGateState[] = [];
  const gate = new StreamSlotGate({
    client: api.client,
    app,
    getProfileId: () => profileId,
    onTakenOver: (by) => takenOver.push(by),
    log: (event, fields) => console.info(`[${SUITE}] ${event} ${JSON.stringify(fields)}`),
    timers: clock.timers,
  });
  gate.subscribe(() => states.push(gate.getState()));
  return { gate, api, clock, takenOver, states };
};

describe("StreamSlotGate", () => {
  it("@req ACCT-STREAM-01[badger-mobile,parrot] asks the server before playing and plays when a place is free", async () => {
    const { gate, api, clock } = makeGate();
    api.startReplies.push(started("s1"));
    expect(await gate.acquire()).toBe("play");
    console.info(`[${SUITE}] state after acquire ${JSON.stringify(gate.getState())} holding=${gate.holding}`);
    expect(api.starts).toEqual([{ app: "badger", profileId: "p1", kind: "play", takeover: false }]);
    expect(gate.getState()).toEqual({ kind: "playing" });
    expect(gate.holding).toBe(true);
    expect(clock.count()).toBe(1);
    // A second acquire (format reload, next episode or song of the same playback) reuses the held place.
    expect(await gate.acquire()).toBe("play");
    expect(api.starts).toHaveLength(1);
  });

  it("@req ACCT-STREAM-02[badger-mobile,parrot] at the limit asks 'Play here instead?'; Play here takes the place over", async () => {
    const { gate, api } = makeGate();
    api.startReplies.push(atLimit("Living room TV"), started("s2"));
    const answer = gate.acquire();
    await flush();
    console.info(`[${SUITE}] state at limit ${JSON.stringify(gate.getState())}`);
    expect(gate.getState()).toEqual({ kind: "asking", device: { deviceName: "Living room TV", deviceType: "tv" } });
    gate.answer("playHere");
    expect(await answer).toBe("play");
    expect(api.starts.map((start) => start.takeover)).toEqual([false, true]);
    expect(gate.getState()).toEqual({ kind: "playing" });
  });

  it("@req ACCT-STREAM-02[badger-mobile,parrot] Cancel changes nothing: no takeover, no place held", async () => {
    const { gate, api } = makeGate();
    api.startReplies.push(atLimit(null, "mobile"));
    const answer = gate.acquire();
    await flush();
    gate.answer("cancel");
    expect(await answer).toBe("cancel");
    expect(api.starts).toHaveLength(1);
    expect(api.stops).toEqual([]);
    expect(gate.getState()).toEqual({ kind: "idle" });
    expect(gate.holding).toBe(false);
  });

  it("@req ACCT-STREAM-02[badger-mobile,parrot] asks again when another device took the last place between the question and Play here", async () => {
    const { gate, api } = makeGate();
    api.startReplies.push(atLimit("Phone"), atLimit("Laptop", "desktop"), started("s3"));
    const answer = gate.acquire();
    await flush();
    gate.answer("playHere");
    await flush();
    expect(gate.getState()).toEqual({ kind: "asking", device: { deviceName: "Laptop", deviceType: "desktop" } });
    gate.answer("playHere");
    expect(await answer).toBe("play");
  });

  it("@req ACCT-STREAM-02[parrot] with two streams playing (Parrot) the question names the oldest, the one Play here stops", () => {
    const device = deviceToTakeOver([
      { streamId: "b", deviceName: "Kitchen phone", deviceType: "mobile", startedAt: "2026-11-06T10:05:00Z" },
      { streamId: "a", deviceName: "Office laptop", deviceType: "desktop", startedAt: "2026-11-06T10:00:00Z" },
    ]);
    console.info(`[${SUITE}] device to take over ${JSON.stringify(device)}`);
    expect(device).toEqual({ deviceName: "Office laptop", deviceType: "desktop" });
  });

  it("@req ACCT-STREAM-02[badger-mobile,parrot] taken over by another device: the player is told to stop and the notice names the device", async () => {
    const { gate, api, clock, takenOver } = makeGate();
    api.startReplies.push(started("s1"));
    await gate.acquire();
    api.beatReplies.push({ status: "taken_over", by: { deviceName: "Bedroom TV", deviceType: "tv" } });
    clock.tick();
    await flush();
    console.info(`[${SUITE}] state after takeover ${JSON.stringify(gate.getState())}`);
    expect(takenOver).toEqual([{ deviceName: "Bedroom TV", deviceType: "tv" }]);
    expect(gate.getState()).toEqual({ kind: "takenOver", device: { deviceName: "Bedroom TV", deviceType: "tv" } });
    expect(gate.holding).toBe(false);
    // The player closing afterwards keeps the notice up until the user dismisses it.
    await gate.release();
    expect(gate.getState().kind).toBe("takenOver");
    gate.dismiss();
    expect(gate.getState()).toEqual({ kind: "idle" });
  });

  it("@req ACCT-STREAM-04[badger-mobile,parrot] heartbeats every interval while playing and frees the place on release", async () => {
    const { gate, api, clock } = makeGate();
    api.startReplies.push(started("s1"));
    await gate.acquire();
    clock.tick();
    clock.tick();
    await flush();
    await gate.release();
    expect(api.stops).toEqual(["s1"]);
    expect(clock.count()).toBe(0);
    expect(gate.getState()).toEqual({ kind: "idle" });
  });

  it("release while the question is open answers it with cancel", async () => {
    const { gate, api } = makeGate();
    api.startReplies.push(atLimit("TV"));
    const answer = gate.acquire();
    await flush();
    await gate.release();
    expect(await answer).toBe("cancel");
    expect(gate.getState()).toEqual({ kind: "idle" });
  });

  // #1757 hand-try: ~8 min into Sintel on the TV, logcat showed `stream_slot.gate.answer cancel` then
  // `stream_slot.stop` with nobody touching the remote. That pair is what `release()` logged: the player screen
  // unmounted because Metro reloaded the whole JS app (`Running "SpaceBadgerMobile"` 3 s later, same pid) 1.2 s after
  // a `git rebase` rewrote the files Metro served. These pin that nothing in the gate itself ends a long playback.
  it("@req ACCT-STREAM-04[badger-mobile,parrot] a long playback keeps its place: 40 min of heartbeats, a failed beat, an expiry and a stray Cancel never stop it", async () => {
    const { gate, api, clock, takenOver, states } = makeGate();
    api.startReplies.push(started("s1"));
    expect(await gate.acquire({ owner: "player" })).toBe("play");
    // 20 s heartbeats for 40 minutes; beat 10 fails on the network, beat 50 finds the stream expired (device slept).
    for (let beat = 1; beat <= 120; beat += 1) {
      if (beat === 10) api.beatReplies.push(new StreamSlotsError("heartbeat", 0, null));
      if (beat === 50) {
        api.beatReplies.push({ status: "ended" });
        api.startReplies.push(started("s1b"));
      }
      clock.tick();
      await flush();
      if (beat % 30 === 0) console.info(`[${SUITE}] long-play beat=${beat} (${beat * 20}s) state=${JSON.stringify(gate.getState())} holding=${gate.holding} stops=${JSON.stringify(api.stops)}`);
    }
    // An alert's onDismiss or a TV back press reaching `answer` while no question is open changes nothing.
    gate.answer("cancel");
    await flush();
    console.info(`[${SUITE}] long-play end starts=${JSON.stringify(api.starts)} stops=${JSON.stringify(api.stops)} states=${JSON.stringify(states)}`);
    expect(api.stops).toEqual([]);
    expect(takenOver).toEqual([]);
    expect(api.starts.map((start) => start.takeover)).toEqual([false, false]);
    expect(gate.holding).toBe(true);
    expect(gate.getState()).toEqual({ kind: "playing" });
    expect(states.some((state) => state.kind === "asking")).toBe(false);
    expect(clock.count()).toBe(1);
  });

  it("a release is logged as stream_slot.gate.release, never as the user answering Cancel", async () => {
    const api = fakeClient();
    const events: Array<[string, Record<string, unknown>]> = [];
    const gate = new StreamSlotGate({
      client: api.client,
      app: "badger",
      getProfileId: () => "p1",
      log: (event, fields) => {
        console.info(`[${SUITE}] ${event} ${JSON.stringify(fields)}`);
        events.push([event, fields]);
      },
      timers: fakeTimers().timers,
    });
    api.startReplies.push(started("s1"));
    await gate.acquire({ owner: "player" });
    await gate.release("player");
    console.info(`[${SUITE}] release events ${JSON.stringify(events)}`);
    expect(events.map(([event]) => event)).not.toContain("stream_slot.gate.answer");
    expect(events).toContainEqual(["stream_slot.gate.release", { owner: "player", holder: "player", streamId: "s1", asking: false }]);
    expect(api.stops).toEqual(["s1"]);
  });

  it("release during the start request frees the place the late answer took", async () => {
    const { gate, api } = makeGate();
    const pending = Promise.withResolvers<StartStreamResult>();
    api.client.startStream = (request) => {
      api.starts.push(request);
      return pending.promise;
    };
    const answer = gate.acquire();
    await flush();
    const released = gate.release();
    pending.resolve(started("late"));
    expect(await answer).toBe("cancel");
    await released;
    await flush();
    expect(api.stops).toEqual(["late"]);
  });

  it("@req ACCT-STREAM-03[badger-mobile] casting takes the place as kind cast; a held play place is given back first, without a question", async () => {
    const { gate, api } = makeGate();
    api.startReplies.push(started("play-1"), started("cast-1"));
    expect(await gate.acquire({ owner: "player" })).toBe("play");
    expect(await gate.acquire({ kind: "cast", owner: "cast" })).toBe("play");
    console.info(`[${SUITE}] starts ${JSON.stringify(api.starts)} stops ${JSON.stringify(api.stops)}`);
    expect(api.starts.map((start) => start.kind)).toEqual(["play", "cast"]);
    expect(api.stops).toEqual(["play-1"]);
    // The closing player cannot free the place the cast screen now holds.
    await gate.release("player");
    expect(api.stops).toEqual(["play-1"]);
    expect(gate.holding).toBe(true);
    await gate.release("cast");
    expect(api.stops).toEqual(["play-1", "cast-1"]);
  });

  it("an owner's release frees its own place", async () => {
    const { gate, api } = makeGate();
    api.startReplies.push(started("s1"));
    await gate.acquire({ owner: "player" });
    await gate.release("player");
    expect(api.stops).toEqual(["s1"]);
    expect(gate.holding).toBe(false);
  });

  it("API unreachable: plays anyway without holding a place, and asks again on the next playback", async () => {
    const { gate, api, clock } = makeGate(null);
    api.startReplies.push(new StreamSlotsError("start", 0, null), started("s1"));
    expect(await gate.acquire()).toBe("play");
    expect(api.starts[0]).toEqual({ app: "badger", kind: "play", takeover: false });
    expect(clock.count()).toBe(0);
    await gate.release();
    expect(await gate.acquire()).toBe("play");
    expect(api.starts).toHaveLength(2);
  });

  it("@req ACCT-STREAM-01[parrot] Parrot asks with app parrot", async () => {
    const { gate, api } = makeGate("p9", "parrot");
    api.startReplies.push(started("m1"));
    expect(await gate.acquire()).toBe("play");
    expect(api.starts).toEqual([{ app: "parrot", profileId: "p9", kind: "play", takeover: false }]);
  });
});
