import { describe, expect, it } from "vitest";
import type { HeartbeatResult, StartStreamRequest, StartStreamResult, StreamSlotsClient, StreamSlotTimers } from "@space/stream-slots";
import { JellyfinStreamSlots, PLAY_HERE_WINDOW_MS } from "../src/streamSlots";
import { handleIntegrationRequest, type IntegrationDeps } from "../src/server";

/**
 * ACCT-STREAM-01..04 for the Jellyfin plugin's sidecar: every Jellyfin playback of a Badger item asks for the
 * server's one place through the shared gate (`@space/stream-slots`), heartbeats while it plays, frees it on stop,
 * and at the limit answers the shared question for the plugin to show.
 */

const T = "[jf-stream]";
const PROFILE = "profile-main";

/** A one-profile API with a limit of 1 (Badger) and an optional other device already playing. */
const fakeApi = (opts: { otherPlaying?: { deviceName: string | null; deviceType: string | null } } = {}) => {
  const calls: Array<{ op: string; body?: unknown }> = [];
  let other = opts.otherPlaying ?? null;
  let mine: string | null = null;
  let nextId = 1;
  let takenOverBy: { deviceName: string | null; deviceType: string | null } | null = null;
  const client: StreamSlotsClient = {
    startStream: async (request: StartStreamRequest): Promise<StartStreamResult> => {
      calls.push({ op: "start", body: request });
      if (other && !request.takeover) {
        return { status: "limit", limit: 1, playingOn: [{ streamId: "other", deviceName: other.deviceName, deviceType: other.deviceType, startedAt: "2026-11-11T10:00:00Z" }] };
      }
      other = null;
      mine = `stream-${nextId++}`;
      return { status: "started", stream: { streamId: mine, profileId: PROFILE, heartbeatIntervalSeconds: 20, expiresInSeconds: 60 } };
    },
    heartbeat: async (streamId: string): Promise<HeartbeatResult> => {
      calls.push({ op: "heartbeat", body: streamId });
      if (takenOverBy) return { status: "taken_over", by: takenOverBy };
      return streamId === mine ? { status: "alive", expiresInSeconds: 60 } : { status: "ended" };
    },
    stopStream: async (streamId: string) => {
      calls.push({ op: "stop", body: streamId });
      if (streamId === mine) mine = null;
    },
  };
  return {
    client,
    calls,
    held: () => mine,
    /** Another device answers "Play here": this server's next heartbeat learns it. */
    takeOverFrom: (by: { deviceName: string | null; deviceType: string | null }) => {
      takenOverBy = by;
      mine = null;
    },
  };
};

const manualTimers = () => {
  const intervals = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  const timers: StreamSlotTimers = {
    setInterval: (fn, ms) => {
      const id = next++;
      intervals.set(id, { fn, ms });
      return id;
    },
    clearInterval: (handle) => {
      intervals.delete(handle as number);
    },
  };
  return { timers, intervals, tick: async () => {
    for (const { fn } of [...intervals.values()]) fn();
    await new Promise((resolve) => setTimeout(resolve, 0));
  } };
};

const setup = (api = fakeApi()) => {
  const clock = { now: 1_000_000 };
  const timers = manualTimers();
  const logs: string[] = [];
  const slots = new JellyfinStreamSlots({
    client: api.client,
    getProfileId: () => PROFILE,
    log: (message, meta) => {
      const line = `${T} ${message} ${JSON.stringify(meta ?? {})}`;
      logs.push(line);
      console.log(line);
    },
    now: () => clock.now,
    timers: timers.timers,
  });
  const dump = () => console.log(`${T} dump calls=${JSON.stringify(api.calls)} holder=${slots.holderSession} held=${api.held()} intervals=${timers.intervals.size}\n${logs.join("\n")}`);
  return { api, slots, clock, timers, dump };
};

const play = (session: string, item = "item-sintel", deviceName = "Living room (Jellyfin Web)") => ({ session, item, deviceName, language: "en" });

describe("Jellyfin stream place (sidecar)", () => {
  it("@req ACCT-STREAM-01[badger-jellyfin] @req ACCT-STREAM-03[badger-jellyfin] @req ACCT-STREAM-04[badger-jellyfin] a playback (always kind play: no receiver, no download asks) takes the profile's place, heartbeats every 20 s and frees it on stop", async () => {
    const { api, slots, timers, dump } = setup();
    console.log(`${T} phase: start`);
    const answer = await slots.start(play("jf-session-1"));
    dump();
    expect(answer).toEqual({ status: "play", takeover: false });
    expect(api.calls[0]).toEqual({ op: "start", body: { app: "badger", profileId: PROFILE, kind: "play", takeover: false } });
    expect(api.held()).toBe("stream-1");
    expect([...timers.intervals.values()].map((entry) => entry.ms)).toEqual([20_000]);
    expect(slots.poll("jf-session-1", "en")).toEqual({ status: "play" });

    console.log(`${T} phase: heartbeat`);
    await timers.tick();
    expect(api.calls.filter((call) => call.op === "heartbeat")).toEqual([{ op: "heartbeat", body: "stream-1" }]);

    console.log(`${T} phase: next episode in the same session reuses the place`);
    expect(await slots.start(play("jf-session-1", "item-episode-2"))).toEqual({ status: "play", takeover: false });
    expect(api.calls.filter((call) => call.op === "start")).toHaveLength(1);

    console.log(`${T} phase: stop`);
    await slots.stop("jf-session-1");
    dump();
    expect(api.calls.at(-1)).toEqual({ op: "stop", body: "stream-1" });
    expect(api.held()).toBeNull();
    expect(timers.intervals.size).toBe(0);
    expect(slots.holderSession).toBeNull();
    expect(slots.poll("jf-session-1", "en")).toEqual({ status: "idle" });
  });

  it("@req ACCT-STREAM-02[badger-jellyfin] at the limit the viewer gets the question, nothing changes, and starting the title again plays here", async () => {
    const api = fakeApi({ otherPlaying: { deviceName: "Kitchen phone", deviceType: "mobile" } });
    const { slots, clock, dump } = setup(api);
    console.log(`${T} phase: start at the limit`);
    const refused = await slots.start(play("jf-session-1"));
    dump();
    expect(refused).toEqual({
      status: "limit",
      device: { deviceName: "Kitchen phone", deviceType: "mobile" },
      text: "Already playing on Kitchen phone. Play here instead?",
    });
    expect(api.held()).toBeNull();
    expect(api.calls.map((call) => call.op)).toEqual(["start"]);
    expect(slots.poll("jf-session-1", "en")).toEqual({ status: "idle" });

    console.log(`${T} phase: another title is a new question, not an answer`);
    expect((await slots.start(play("jf-session-1", "item-big-buck-bunny"))).status).toBe("limit");

    console.log(`${T} phase: same title again = Play here`);
    clock.now += PLAY_HERE_WINDOW_MS - 1;
    const here = await slots.start(play("jf-session-1"));
    dump();
    expect(here).toEqual({ status: "play", takeover: true });
    expect(api.calls.filter((call) => call.op === "start").at(-1)).toEqual({
      op: "start",
      body: { app: "badger", profileId: PROFILE, kind: "play", takeover: true },
    });
    expect(api.held()).not.toBeNull();
  });

  it("@req ACCT-STREAM-02[badger-jellyfin] a question older than the window is not an answer", async () => {
    const api = fakeApi({ otherPlaying: { deviceName: null, deviceType: "tv" } });
    const { slots, clock, dump } = setup(api);
    const first = await slots.start({ ...play("jf-session-1"), language: "fr" });
    expect(first).toMatchObject({ status: "limit", text: "Déjà en lecture sur une TV. Lire ici à la place ?" });
    clock.now += PLAY_HERE_WINDOW_MS + 1;
    const late = await slots.start(play("jf-session-1"));
    dump();
    expect(late.status).toBe("limit");
    expect(api.calls.every((call) => call.op !== "start" || (call.body as StartStreamRequest).takeover === false)).toBe(true);
  });

  it("@req ACCT-STREAM-02[badger-jellyfin] another device's Play here stops this playback with Playing on <device> now", async () => {
    const { api, slots, timers, dump } = setup();
    await slots.start(play("jf-session-1"));
    api.takeOverFrom({ deviceName: "Office laptop", deviceType: "desktop" });
    await timers.tick();
    dump();
    expect(slots.poll("jf-session-1", "en")).toEqual({
      status: "takenOver",
      device: { deviceName: "Office laptop", deviceType: "desktop" },
      text: "Playing on Office laptop now",
    });
    expect(slots.poll("jf-session-1", "en")).toEqual({ status: "idle" });
    expect(timers.intervals.size).toBe(0);
  });

  it("@req ACCT-STREAM-01[badger-jellyfin] @req ACCT-STREAM-02[badger-jellyfin] a second Jellyfin session meets the limit; Play here moves the place and stops the first", async () => {
    const { api, slots, dump } = setup();
    await slots.start(play("jf-session-1", "item-sintel", "Bedroom TV"));
    console.log(`${T} phase: second session`);
    const second = await slots.start(play("jf-session-2", "item-tears-of-steel", "Kitchen tablet"));
    dump();
    expect(second).toEqual({
      status: "limit",
      device: { deviceName: "Bedroom TV", deviceType: "jellyfin" },
      text: "Already playing on Bedroom TV. Play here instead?",
    });
    expect(slots.poll("jf-session-1", "en")).toEqual({ status: "play" });

    console.log(`${T} phase: second session answers Play here`);
    expect(await slots.start(play("jf-session-2", "item-tears-of-steel", "Kitchen tablet"))).toEqual({ status: "play", takeover: true });
    expect(slots.holderSession).toBe("jf-session-2");
    expect(slots.poll("jf-session-1", "en")).toMatchObject({ status: "takenOver", text: "Playing on Kitchen tablet now" });
    console.log(`${T} phase: the first session's stop no longer frees the place`);
    await slots.stop("jf-session-1");
    expect(api.held()).not.toBeNull();
    expect(api.calls.filter((call) => call.op === "start")).toHaveLength(1);
    await slots.stop("jf-session-2");
    expect(api.held()).toBeNull();
  });

  it("@req ACCT-STREAM-01[badger-jellyfin] the plugin's routes reach the server's place", async () => {
    const { api, slots, dump } = setup();
    const deps = { isStarting: () => false, isLibraryReady: () => true, getStatus: () => ({}), log: () => {}, streams: slots } as unknown as IntegrationDeps;
    const call = (path: string, body?: unknown) =>
      handleIntegrationRequest(
        new Request(`http://127.0.0.1/integration/v1/${path}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
        deps
      );
    const started = await call("stream/start", { session: "jf-1", item: "item-sintel", deviceName: "TV", language: "en" });
    const startedBody = await started.text();
    console.log(`${T} route stream/start -> ${started.status} ${startedBody}`);
    expect(started.status).toBe(200);
    expect(JSON.parse(startedBody)).toEqual({ status: "play", takeover: false });
    expect(await (await call("stream/jf-1?language=en")).json()).toEqual({ status: "play" });
    expect((await call("stream/start", { item: "x" })).status).toBe(400);
    expect(await (await call("stream/stop", { session: "jf-1" })).json()).toEqual({ ok: true });
    dump();
    expect(api.held()).toBeNull();
  });
});
