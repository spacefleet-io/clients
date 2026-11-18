// @req UX-TV-02[badger-mobile,badger-tv]
/**
 * @level unit
 * @why The phone remote shows only what the TV reports: its status must move connecting -> waiting -> connected on the
 *   TV's own states, turn unreachable when the relay says nobody listens or the TV stays silent, end when the TV says
 *   so, ignore other peers, keep its presence alive and stop everything on dispose. The TV picker lists TVs only.
 */
import { describe, expect, it, vi } from "vitest";
import type { ListenStatus, PlayOnTvChannel, RelayPeer } from "../src/lib/playOnTv/channel";
import { createPhoneRemote, tvTargets, type RemoteView } from "../src/lib/playOnTv/phoneRemote";
import { IDLE_STATE, type RemoteBody, type StartCommand, type TvState } from "../src/lib/playOnTv/protocol";
import { createManualClock } from "./play-on-tv-fakes";

const TV = "tv-1";
const START: StartCommand = { type: "start", mediaId: "m1", episodeId: null, positionSeconds: 42, tracks: null };
const state = (phase: TvState["phase"]): TvState => ({ ...IDLE_STATE, phase, positionSeconds: 10, durationSeconds: 100 });

const makeChannel = () => {
  const sent: Array<{ to: string; body: RemoteBody }> = [];
  const deliveries: Array<number | null> = [];
  let onMessage: ((from: string, body: RemoteBody) => void) | null = null;
  let listens = 0;
  let stops = 0;
  const channel: PlayOnTvChannel = {
    peerId: "phone-1",
    send: async (to, body) => {
      sent.push({ to, body });
      return deliveries.length ? (deliveries.shift() as number | null) : 1;
    },
    listen: (handler: (from: string, body: RemoteBody) => void, _onStatus?: (s: ListenStatus) => void) => {
      listens += 1;
      onMessage = handler;
      return () => {
        stops += 1;
        onMessage = null;
      };
    },
  };
  return {
    channel,
    sent,
    deliveries,
    receive: (from: string, body: RemoteBody) => onMessage?.(from, body),
    counts: () => ({ listens, stops }),
  };
};

const setup = () => {
  const fake = makeChannel();
  const clock = createManualClock();
  let registers = 0;
  const remote = createPhoneRemote({
    channel: fake.channel,
    registerSelf: async () => {
      registers += 1;
      return "ok";
    },
    tvPeerId: TV,
    log: (event, data) => console.info("[phase:remote.log]", event, JSON.stringify(data ?? {})),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    replyTimeoutMs: 15_000,
    presenceEveryMs: 20_000,
  });
  const views: RemoteView[] = [];
  remote.subscribe((view) => views.push(view));
  return { fake, clock, remote, views, registers: () => registers };
};

describe("createPhoneRemote", () => {
  it("goes connecting -> waiting -> connected on the TV's state", async () => {
    const { fake, remote, views } = setup();
    await remote.start(START);
    console.info("[phase:start]", JSON.stringify({ statuses: views.map((v) => v.status), sent: fake.sent.map((s) => s.body.type) }));
    expect(views.map((v) => v.status)).toEqual(["connecting", "waiting"]);
    expect(fake.sent).toEqual([{ to: TV, body: START }]);
    fake.receive(TV, state("loading"));
    fake.receive(TV, state("playing"));
    expect(remote.view()).toEqual({ status: "connected", tv: state("playing") });
    expect(fake.counts().listens).toBe(1);
  });

  it("ends when the TV reports ended and a later timeout keeps it ended", async () => {
    const { fake, remote, clock } = setup();
    await remote.start(START);
    fake.receive(TV, state("playing"));
    await remote.send({ type: "stop" });
    fake.receive(TV, state("ended"));
    clock.advance(15_000);
    console.info("[phase:ended]", JSON.stringify(remote.view().status));
    expect(remote.view().status).toBe("ended");
  });

  it("is unreachable when nobody listens (delivered 0) or the relay fails (null)", async () => {
    for (const delivered of [0, null]) {
      const { fake, remote, clock } = setup();
      fake.deliveries.push(delivered);
      await remote.start(START);
      console.info("[phase:unreachable]", JSON.stringify({ delivered, status: remote.view().status }));
      expect(remote.view().status).toBe("unreachable");
      expect(clock.pending()).toBe(1); // only the presence heartbeat, no reply timer
    }
  });

  it("is unreachable when the TV stays silent past the reply timeout", async () => {
    const { remote, clock, fake } = setup();
    await remote.start(START);
    clock.advance(14_999);
    expect(remote.view().status).toBe("waiting");
    clock.advance(1);
    console.info("[phase:timeout]", JSON.stringify(remote.view().status));
    expect(remote.view().status).toBe("unreachable");
    // A late state brings it back.
    fake.receive(TV, state("playing"));
    expect(remote.view().status).toBe("connected");
  });

  it("a state cancels the reply timer", async () => {
    const { remote, clock, fake } = setup();
    await remote.start(START);
    fake.receive(TV, state("playing"));
    clock.advance(60_000);
    expect(remote.view().status).toBe("connected");
  });

  it("ignores states from another peer and commands echoed back", async () => {
    const { remote, fake } = setup();
    await remote.start(START);
    fake.receive("tv-other", state("playing"));
    fake.receive(TV, { type: "pause" });
    console.info("[phase:ignore]", JSON.stringify(remote.view()));
    expect(remote.view()).toEqual({ status: "waiting", tv: null });
  });

  it("togglePause sends play when the TV is paused, pause otherwise", async () => {
    const { remote, fake } = setup();
    await remote.start(START);
    await remote.togglePause();
    fake.receive(TV, state("playing"));
    await remote.togglePause();
    fake.receive(TV, state("paused"));
    await remote.togglePause();
    const types = fake.sent.map((s) => s.body.type);
    console.info("[phase:toggle]", JSON.stringify(types));
    expect(types).toEqual(["start", "pause", "pause", "play"]);
    expect(remote.view().status).toBe("connected"); // a command while connected does not fall back to waiting
  });

  it("resume asks the TV for its state with hello", async () => {
    const { remote, fake, views } = setup();
    await remote.resume();
    expect(fake.sent.map((s) => s.body)).toEqual([{ type: "hello" }]);
    expect(views.map((v) => v.status)).toEqual(["connecting", "waiting"]);
  });

  it("keeps its presence with a registerSelf heartbeat", async () => {
    const { remote, clock, registers } = setup();
    await remote.start(START);
    await remote.send({ type: "pause" });
    expect(registers()).toBe(1); // registered once, not per command
    clock.advance(20_000);
    clock.advance(20_000);
    console.info("[phase:presence]", JSON.stringify({ registers: registers() }));
    expect(registers()).toBe(3);
  });

  it("dispose stops listening, timers and listeners", async () => {
    const { remote, clock, fake, views, registers } = setup();
    await remote.start(START);
    const before = views.length;
    remote.dispose();
    console.info("[phase:dispose]", JSON.stringify({ counts: fake.counts(), pending: clock.pending() }));
    expect(fake.counts()).toEqual({ listens: 1, stops: 1 });
    expect(clock.pending()).toBe(0);
    clock.advance(100_000);
    expect(registers()).toBe(1);
    fake.receive(TV, state("playing"));
    expect(views).toHaveLength(before);
  });
});

describe("createPhoneRemote while its first registration is in flight", () => {
  // A slow relay registration: each call waits until the test releases it.
  const setupSlowRegister = () => {
    const fake = makeChannel();
    const clock = createManualClock();
    const pending: Array<() => void> = [];
    const remote = createPhoneRemote({
      channel: fake.channel,
      registerSelf: () => {
        const { promise, resolve } = Promise.withResolvers<"ok">();
        pending.push(() => resolve("ok"));
        return promise;
      },
      tvPeerId: TV,
      log: (event, data) => console.info("[phase:remote.log]", event, JSON.stringify(data ?? {})),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    const releaseAll = () => {
      while (pending.length) pending.shift()?.();
    };
    return { fake, clock, remote, pending, releaseAll };
  };

  it("@bugfix two quick taps during the first registration open one listener, not two", async () => {
    const { fake, remote, pending, releaseAll } = setupSlowRegister();
    const first = remote.start(START);
    const second = remote.send({ type: "pause" });
    await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
    const registersInFlight = pending.length;
    releaseAll();
    await Promise.all([first, second]);
    console.info("[phase:in-flight]", JSON.stringify({ registersInFlight, counts: fake.counts(), sent: fake.sent.map((s) => s.body.type) }));
    expect(registersInFlight).toBe(1);
    expect(fake.counts()).toEqual({ listens: 1, stops: 0 });
    expect(fake.sent.map((s) => s.body.type).sort()).toEqual(["pause", "start"]);
    remote.dispose();
    expect(fake.counts()).toEqual({ listens: 1, stops: 1 });
  });

  it("@bugfix dispose during the first registration never opens a listener", async () => {
    const { fake, clock, remote, pending, releaseAll } = setupSlowRegister();
    const started = remote.start(START);
    await vi.waitFor(() => expect(pending.length).toBe(1));
    remote.dispose();
    releaseAll();
    await started;
    console.info("[phase:dispose-in-flight]", JSON.stringify({ counts: fake.counts(), pending: clock.pending() }));
    expect(fake.counts()).toEqual({ listens: 0, stops: 0 });
    expect(clock.pending()).toBe(0);
  });
});

describe("tvTargets", () => {
  it("lists TVs only, with a fallback name, sorted by name", () => {
    const peers: RelayPeer[] = [
      { peerId: "tv-b", kind: "tv", name: "Kitchen", updatedAt: 1 },
      { peerId: "m-1", kind: "mobile", name: "Phone", updatedAt: 1 },
      { peerId: "tv-a", kind: "tv", name: null, updatedAt: 1 },
      { peerId: "tv-c", kind: "tv", name: "Bedroom", updatedAt: 1 },
      { peerId: "d-1", kind: "desktop", name: "Mac", updatedAt: 1 },
    ];
    const targets = tvTargets(peers, "TV");
    console.info("[phase:targets]", JSON.stringify(targets));
    expect(targets).toEqual([
      { peerId: "tv-c", name: "Bedroom" },
      { peerId: "tv-b", name: "Kitchen" },
      { peerId: "tv-a", name: "TV" },
    ]);
  });
});
