// @req UX-TV-02[badger-mobile,badger-tv]
/**
 * @level unit
 * @why The TV receiver turns the phone's commands into a started title or player calls and reports the player's own
 *   state to the phone in charge. A failed start must reach the phone as `failed` with its reason, a command with no
 *   player as `not_playing`, and only a real close (not a remote start replacing the player, not a next-episode
 *   handover) may tell the phone the session `ended`. Logs must never carry a title or a media id.
 */
import { describe, expect, it } from "vitest";
import type { PlayOnTvChannel } from "../../lib/playOnTv/channel";
import type { RemotePlayer } from "../../lib/playOnTv/playerLink";
import { IDLE_STATE, type RemoteBody, type StartCommand, type TvState } from "../../lib/playOnTv/protocol";
import { createTvReceiver, type StartOutcome } from "./playOnTvReceiver";

const START: StartCommand = { type: "start", mediaId: "media-secret", episodeId: "ep-1", positionSeconds: 90, tracks: null };
const PLAYING: TvState = { ...IDLE_STATE, phase: "playing", mediaId: "media-secret", title: "Secret Title", positionSeconds: 95, durationSeconds: 3_000 };

const setup = (options: { startOutcome?: StartOutcome | Error; player?: RemotePlayer | null } = {}) => {
  const sent: Array<{ to: string; body: RemoteBody }> = [];
  const logs: Array<[string, Record<string, unknown>]> = [];
  let player: RemotePlayer | null = options.player ?? null;
  const starts: StartCommand[] = [];
  const channel: PlayOnTvChannel = {
    peerId: "tv-1",
    send: async (to, body) => {
      sent.push({ to, body });
      return 1;
    },
    listen: () => () => undefined,
  };
  const receiver = createTvReceiver({
    channel,
    startTitle: async (command) => {
      starts.push(command);
      const outcome = options.startOutcome ?? "ok";
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    currentPlayer: () => player,
    log: (event, data) => {
      logs.push([event, data]);
      console.info("[phase:receiver.log]", event, JSON.stringify(data));
    },
  });
  return {
    receiver,
    sent,
    logs,
    starts,
    setPlayer: (next: RemotePlayer | null) => {
      player = next;
    },
  };
};

const fakePlayer = (state: TvState, result: string | null = null) => {
  const applied: RemoteBody[] = [];
  const p: RemotePlayer = {
    apply: async (command) => {
      applied.push(command);
      return result;
    },
    state: () => state,
  };
  return { player: p, applied };
};

describe("createTvReceiver", () => {
  it("start ok -> loading state for the title, then the player's states after it attaches", async () => {
    const { receiver, sent, starts, logs } = setup();
    await receiver.handle("phone-1", START);
    expect(starts).toEqual([START]);
    expect(receiver.controller()).toBe("phone-1");
    expect(sent).toEqual([
      { to: "phone-1", body: { ...IDLE_STATE, phase: "loading", mediaId: "media-secret", episodeId: "ep-1", positionSeconds: 90 } },
    ]);
    receiver.onPlayerEvent({ kind: "attached" });
    receiver.onPlayerEvent({ kind: "state", state: PLAYING });
    console.info("[phase:start.ok]", JSON.stringify(sent.map((s) => s.body.type === "state" && s.body.phase)));
    expect(sent[1]).toEqual({ to: "phone-1", body: PLAYING });
    const attached = logs.find(([event]) => event === "tv.cast.player.attached");
    expect(attached?.[1]).toEqual({ controlled: true, remoteStart: true });
    const allLogs = JSON.stringify(logs);
    expect(allLogs).not.toContain("media-secret");
    expect(allLogs).not.toContain("Secret Title");
  });

  it("start failure -> failed state with the reason", async () => {
    for (const outcome of ["media_not_found", "start_failed", new Error("nav broke")] as const) {
      const { receiver, sent } = setup({ startOutcome: outcome });
      await receiver.handle("phone-1", START);
      const body = sent[0]?.body as TvState;
      console.info("[phase:start.fail]", JSON.stringify({ outcome: String(outcome), phase: body.phase, error: body.error }));
      expect(body).toEqual({ ...IDLE_STATE, phase: "failed", error: outcome instanceof Error ? "start_failed" : outcome });
      // The pending start was cleared: a later detach is a real end.
      receiver.onPlayerEvent({ kind: "detached", last: PLAYING, handover: false });
      expect(sent).toHaveLength(2);
      expect((sent[1].body as TvState).phase).toBe("ended");
    }
  });

  it("a command without a player -> not_playing", async () => {
    const { receiver, sent } = setup();
    await receiver.handle("phone-1", { type: "pause" });
    console.info("[phase:no_player]", JSON.stringify(sent[0]));
    expect(sent).toEqual([{ to: "phone-1", body: { ...IDLE_STATE, error: "not_playing" } }]);
  });

  it("an applied command -> the player's state goes to the last commanding phone", async () => {
    const { player, applied } = fakePlayer(PLAYING);
    const { receiver, sent } = setup({ player });
    await receiver.handle("phone-1", { type: "seekBy", deltaSeconds: 10 });
    await receiver.handle("phone-2", { type: "pause" });
    console.info("[phase:applied]", JSON.stringify(sent.map((s) => s.to)));
    expect(applied).toEqual([{ type: "seekBy", deltaSeconds: 10 }, { type: "pause" }]);
    expect(sent).toEqual([
      { to: "phone-1", body: { ...PLAYING, error: null } },
      { to: "phone-2", body: { ...PLAYING, error: null } },
    ]);
    receiver.onPlayerEvent({ kind: "state", state: PLAYING });
    expect(sent[2].to).toBe("phone-2");
  });

  it("reports the player's error code, and command_failed when apply throws", async () => {
    const { player } = fakePlayer(PLAYING, "no_such_track");
    const { receiver, sent } = setup({ player });
    await receiver.handle("phone-1", { type: "setAudio", idx: 9 });
    expect((sent[0].body as TvState).error).toBe("no_such_track");
    const throwing: RemotePlayer = { apply: async () => Promise.reject(new Error("mpv")), state: () => PLAYING };
    const second = setup({ player: throwing });
    await second.receiver.handle("phone-1", { type: "play" });
    console.info("[phase:apply.error]", JSON.stringify((second.sent[0].body as TvState).error));
    expect((second.sent[0].body as TvState).error).toBe("command_failed");
  });

  it("stop -> no immediate state; the detach reports ended", async () => {
    const { player, applied } = fakePlayer(PLAYING);
    const { receiver, sent } = setup({ player });
    await receiver.handle("phone-1", { type: "stop" });
    expect(applied).toEqual([{ type: "stop" }]);
    expect(sent).toEqual([]);
    receiver.onPlayerEvent({ kind: "detached", last: PLAYING, handover: false });
    console.info("[phase:stop]", JSON.stringify(sent.map((s) => (s.body as TvState).phase)));
    expect(sent).toEqual([{ to: "phone-1", body: { ...PLAYING, phase: "ended", error: null } }]);
  });

  it("a detach while a remote start replaces the player does not report ended", async () => {
    const { player } = fakePlayer(PLAYING);
    const pendingStart = Promise.withResolvers<StartOutcome>();
    const sent: RemoteBody[] = [];
    const receiver = createTvReceiver({
      channel: { peerId: "tv-1", send: async (_to, body) => (sent.push(body), 1), listen: () => () => undefined },
      startTitle: () => pendingStart.promise,
      currentPlayer: () => player,
      log: () => undefined,
    });
    const handling = receiver.handle("phone-1", START);
    receiver.onPlayerEvent({ kind: "detached", last: PLAYING, handover: false }); // the old player closes first
    console.info("[phase:replacing]", JSON.stringify(sent.map((b) => b.type === "state" && b.phase)));
    expect(sent).toEqual([]);
    pendingStart.resolve("ok");
    await handling;
    expect(sent.map((b) => b.type === "state" && b.phase)).toEqual(["loading"]);
  });

  it("a handover detach does not report ended", async () => {
    const { player } = fakePlayer(PLAYING);
    const { receiver, sent } = setup({ player });
    await receiver.handle("phone-1", { type: "play" });
    receiver.onPlayerEvent({ kind: "detached", last: PLAYING, handover: true });
    console.info("[phase:handover]", JSON.stringify(sent.length));
    expect(sent).toHaveLength(1);
  });

  it("hello -> the current state, idle without a player", async () => {
    const { player } = fakePlayer(PLAYING);
    const withPlayer = setup({ player });
    await withPlayer.receiver.handle("phone-1", { type: "hello" });
    expect(withPlayer.sent).toEqual([{ to: "phone-1", body: PLAYING }]);
    const without = setup();
    await without.receiver.handle("phone-1", { type: "hello" });
    console.info("[phase:hello]", JSON.stringify({ withPlayer: (withPlayer.sent[0].body as TvState).phase, without: (without.sent[0].body as TvState).phase }));
    expect(without.sent).toEqual([{ to: "phone-1", body: IDLE_STATE }]);
  });

  it("ignores states sent to it and reports nothing before any phone commands", async () => {
    const { receiver, sent } = setup();
    await receiver.handle("phone-1", PLAYING);
    receiver.onPlayerEvent({ kind: "state", state: PLAYING });
    receiver.onPlayerEvent({ kind: "detached", last: PLAYING, handover: false });
    expect(receiver.controller()).toBeNull();
    expect(sent).toEqual([]);
  });
});
