// @req UX-TV-02[badger-mobile,badger-tv]
/**
 * @level unit
 * @why The player link tells the TV receiver when a player opens and closes: a stale detach (an old player unmounting
 *   after a new one attached) must not clear the new player, and the handover flag keeps a next-episode switch from
 *   ending the phone's session. States are only built while a receiver listens.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetRemotePlayerLinkForTests,
  attachRemotePlayer,
  currentRemotePlayer,
  onRemotePlayerEvent,
  publishRemoteState,
  remoteStateWanted,
  type RemotePlayer,
  type RemotePlayerEvent,
} from "../src/lib/playOnTv/playerLink";
import { IDLE_STATE, type TvState } from "../src/lib/playOnTv/protocol";

const player = (phase: TvState["phase"]): RemotePlayer => ({
  apply: async () => null,
  state: () => ({ ...IDLE_STATE, phase }),
});

const record = () => {
  const events: RemotePlayerEvent[] = [];
  const stop = onRemotePlayerEvent((event) => {
    console.info("[phase:link.event]", JSON.stringify({ kind: event.kind, handover: event.kind === "detached" ? event.handover : undefined }));
    events.push(event);
  });
  return { events, stop };
};

describe("playerLink", () => {
  beforeEach(() => {
    __resetRemotePlayerLinkForTests();
  });

  it("emits attached and detached with the last state", () => {
    const { events } = record();
    const p = player("playing");
    const detach = attachRemotePlayer(p);
    expect(currentRemotePlayer()).toBe(p);
    detach();
    expect(currentRemotePlayer()).toBeNull();
    expect(events).toEqual([
      { kind: "attached" },
      { kind: "detached", last: { ...IDLE_STATE, phase: "playing" }, handover: false },
    ]);
  });

  it("carries the handover flag", () => {
    const { events } = record();
    attachRemotePlayer(player("playing"))(true);
    expect(events[1]).toMatchObject({ kind: "detached", handover: true });
  });

  it("a stale detach is a no-op", () => {
    const { events } = record();
    const oldDetach = attachRemotePlayer(player("playing"));
    const next = player("loading");
    attachRemotePlayer(next);
    oldDetach();
    console.info("[phase:link.stale]", JSON.stringify({ kinds: events.map((e) => e.kind) }));
    expect(currentRemotePlayer()).toBe(next);
    expect(events.map((e) => e.kind)).toEqual(["attached", "attached"]);
  });

  it("detaching twice emits once", () => {
    const { events } = record();
    const detach = attachRemotePlayer(player("paused"));
    detach();
    detach();
    expect(events.filter((e) => e.kind === "detached")).toHaveLength(1);
  });

  it("publishes states and keeps going when a listener throws", () => {
    onRemotePlayerEvent(() => {
      throw new Error("boom");
    });
    const { events } = record();
    const state = { ...IDLE_STATE, phase: "paused" as const };
    publishRemoteState(state);
    expect(events).toEqual([{ kind: "state", state }]);
  });

  it("remoteStateWanted follows the listeners", () => {
    expect(remoteStateWanted()).toBe(false);
    const a = record();
    const b = record();
    expect(remoteStateWanted()).toBe(true);
    a.stop();
    expect(remoteStateWanted()).toBe(true);
    b.stop();
    expect(remoteStateWanted()).toBe(false);
  });

  it("__resetRemotePlayerLinkForTests forgets the player and the listeners", () => {
    const { events } = record();
    attachRemotePlayer(player("playing"));
    __resetRemotePlayerLinkForTests();
    expect(currentRemotePlayer()).toBeNull();
    expect(remoteStateWanted()).toBe(false);
    publishRemoteState(IDLE_STATE);
    expect(events).toHaveLength(1);
  });
});
