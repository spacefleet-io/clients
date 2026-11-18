// @req UX-TV-02[badger-mobile,badger-tv]
/**
 * @level unit
 * @why Every Play on TV message is validated field by field after it is opened: a malformed or foreign body must be
 *   dropped, never half-applied. The replay guard stops a relay from replaying or re-attributing a sealed command, and
 *   the log summary must never carry a title or a media id (logs leave the device).
 */
import { describe, expect, it } from "vitest";
import {
  IDLE_STATE,
  MESSAGE_MAX_AGE_MS,
  PLAY_ON_TV_PROTOCOL,
  buildMessage,
  createReplayGuard,
  describeBody,
  parseRemoteBody,
  parseRemoteMessage,
  type TvState,
} from "../src/lib/playOnTv/protocol";

const STATE: TvState = {
  ...IDLE_STATE,
  phase: "playing",
  mediaId: "media-secret-42",
  episodeId: "ep-7",
  title: "Secret Title",
  positionSeconds: 61.6,
  durationSeconds: 3600.2,
  audioTracks: [{ idx: 0, label: "English", language: "en" }],
  subtitleTracks: [
    { idx: 0, label: null, language: "fr" },
    { idx: 1, label: "SDH", language: null },
  ],
  audioIdx: 0,
  subtitleIdx: 1,
};

describe("parseRemoteBody", () => {
  it("accepts every simple command and drops unknown fields", () => {
    for (const type of ["hello", "pause", "play", "stop"] as const) {
      const parsed = parseRemoteBody({ type, extra: "x" });
      console.info("[phase:parse] simple", JSON.stringify({ type, parsed }));
      expect(parsed).toEqual({ type });
    }
  });

  it("validates start", () => {
    const valid = { type: "start", mediaId: "m1", episodeId: null, positionSeconds: 12.5, tracks: { audioIdx: 1, subtitleIdx: -1 } };
    expect(parseRemoteBody(valid)).toEqual(valid);
    expect(parseRemoteBody({ ...valid, tracks: undefined })).toEqual({ ...valid, tracks: null });
    expect(parseRemoteBody({ ...valid, tracks: { audioIdx: null, subtitleIdx: null } })).toEqual({
      ...valid,
      tracks: { audioIdx: null, subtitleIdx: null },
    });
    const bad = [
      { ...valid, mediaId: "" },
      { ...valid, mediaId: 3 },
      { ...valid, episodeId: 4 },
      { ...valid, episodeId: undefined },
      { ...valid, positionSeconds: -1 },
      { ...valid, positionSeconds: Number.NaN },
      { ...valid, positionSeconds: "10" },
      { ...valid, tracks: { audioIdx: -1, subtitleIdx: 0 } },
      { ...valid, tracks: { audioIdx: 0, subtitleIdx: -2 } },
      { ...valid, tracks: { audioIdx: 0.5, subtitleIdx: 0 } },
      { ...valid, tracks: [] },
    ];
    for (const body of bad) {
      console.info("[phase:parse] start reject", JSON.stringify(body));
      expect(parseRemoteBody(body)).toBeNull();
    }
  });

  it("validates seeks and track picks", () => {
    expect(parseRemoteBody({ type: "seekBy", deltaSeconds: -10 })).toEqual({ type: "seekBy", deltaSeconds: -10 });
    expect(parseRemoteBody({ type: "seekBy", deltaSeconds: Infinity })).toBeNull();
    expect(parseRemoteBody({ type: "seekTo", positionSeconds: 0 })).toEqual({ type: "seekTo", positionSeconds: 0 });
    expect(parseRemoteBody({ type: "seekTo", positionSeconds: -1 })).toBeNull();
    expect(parseRemoteBody({ type: "setAudio", idx: 2 })).toEqual({ type: "setAudio", idx: 2 });
    expect(parseRemoteBody({ type: "setAudio", idx: -1 })).toBeNull();
    expect(parseRemoteBody({ type: "setSubtitle", idx: -1 })).toEqual({ type: "setSubtitle", idx: -1 });
    expect(parseRemoteBody({ type: "setSubtitle", idx: -2 })).toBeNull();
    expect(parseRemoteBody({ type: "setSubtitle", idx: 1.5 })).toBeNull();
  });

  it("validates state", () => {
    expect(parseRemoteBody(STATE)).toEqual(STATE);
    expect(parseRemoteBody(IDLE_STATE)).toEqual(IDLE_STATE);
    const bad: unknown[] = [
      { ...STATE, phase: "rewinding" },
      { ...STATE, mediaId: 1 },
      { ...STATE, title: undefined },
      { ...STATE, error: 5 },
      { ...STATE, audioTracks: "x" },
      { ...STATE, audioTracks: [{ idx: -1, label: null, language: null }] },
      { ...STATE, subtitleTracks: [{ idx: 0, label: 1, language: null }] },
      { ...STATE, positionSeconds: Number.NaN },
      { ...STATE, durationSeconds: null },
      { ...STATE, audioIdx: -1 },
      { ...STATE, subtitleIdx: null },
    ];
    for (const body of bad) {
      console.info("[phase:parse] state reject", JSON.stringify(Object.keys(body as object)));
      expect(parseRemoteBody(body)).toBeNull();
    }
  });

  it("rejects non-objects and unknown types", () => {
    for (const value of [null, undefined, 1, "hello", [], { type: 1 }, { type: "rewind" }]) {
      expect(parseRemoteBody(value)).toBeNull();
    }
  });
});

describe("parseRemoteMessage / buildMessage", () => {
  it("round-trips a built message through JSON", () => {
    const message = buildMessage("phone-1", "tv-1", { type: "seekBy", deltaSeconds: 10 }, 1_000);
    console.info("[phase:message] built", JSON.stringify({ id: message.id, from: message.from, to: message.to, sentAt: message.sentAt }));
    expect(message).toMatchObject({ proto: PLAY_ON_TV_PROTOCOL, from: "phone-1", to: "tv-1", sentAt: 1_000, body: { type: "seekBy", deltaSeconds: 10 } });
    expect(message.id).toMatch(/\S+/);
    expect(parseRemoteMessage(JSON.parse(JSON.stringify(message)))).toEqual(message);
  });

  it("gives every message a distinct id, even at the same instant", () => {
    const ids = new Set(Array.from({ length: 50 }, () => buildMessage("p", "t", { type: "hello" }, 5).id));
    expect(ids.size).toBe(50);
  });

  it("@bugfix rejects other protocols, missing ids/senders/recipients and bad bodies", () => {
    const ok = buildMessage("phone-1", "tv-1", { type: "hello" }, 1);
    const { to: _to, ...noRecipient } = ok;
    const rejected = [
      { ...ok, proto: 2 },
      { ...ok, id: "" },
      { ...ok, from: "" },
      { ...ok, from: 3 },
      noRecipient,
      { ...ok, to: "" },
      { ...ok, to: 4 },
      { ...ok, sentAt: "1" },
      { ...ok, body: { type: "nope" } },
      null,
      [],
    ].map((value) => parseRemoteMessage(value));
    console.info("[phase:message] rejected", JSON.stringify(rejected));
    expect(rejected.every((parsed) => parsed === null)).toBe(true);
  });
});

describe("createReplayGuard", () => {
  it("@bugfix returns ok, duplicate, stale, sender_mismatch and recipient_mismatch", () => {
    const guard = createReplayGuard();
    const now = 10_000_000;
    const message = buildMessage("phone-1", "tv-1", { type: "play" }, now);
    const fresh = (sentAt: number, to = "tv-1") => buildMessage("phone-1", to, { type: "play" }, sentAt);
    const verdicts = {
      first: guard.check(message, "phone-1", "tv-1", now),
      replay: guard.check(message, "phone-1", "tv-1", now + 1),
      mismatch: guard.check(fresh(now), "evil-peer", "tv-1", now),
      // Sealed for tv-1, handed by the relay to tv-2 (same account, same key): must not run there.
      redirected: guard.check(fresh(now), "phone-1", "tv-2", now),
      tooOld: guard.check(fresh(now - MESSAGE_MAX_AGE_MS - 1), "phone-1", "tv-1", now),
      future: guard.check(fresh(now + MESSAGE_MAX_AGE_MS + 1), "phone-1", "tv-1", now),
      edge: guard.check(fresh(now - MESSAGE_MAX_AGE_MS), "phone-1", "tv-1", now),
    };
    console.info("[phase:replay] verdicts", JSON.stringify(verdicts));
    expect(verdicts).toEqual({
      first: "ok",
      replay: "duplicate",
      mismatch: "sender_mismatch",
      redirected: "recipient_mismatch",
      tooOld: "stale",
      future: "stale",
      edge: "ok",
    });
  });

  it("@bugfix a redirected message does not burn its id for the real recipient's guard", () => {
    const tv2 = createReplayGuard();
    const message = buildMessage("phone-1", "tv-1", { type: "play" }, 1);
    const verdicts = [tv2.check(message, "phone-1", "tv-2", 1), tv2.check({ ...message, to: "tv-2" }, "phone-1", "tv-2", 1)];
    console.info("[phase:replay] redirected-then-own", JSON.stringify(verdicts));
    expect(verdicts).toEqual(["recipient_mismatch", "ok"]);
  });

  it("forgets the oldest id past its memory bound", () => {
    const guard = createReplayGuard(MESSAGE_MAX_AGE_MS, 2);
    const a = buildMessage("p", "t", { type: "play" }, 1);
    const b = buildMessage("p", "t", { type: "play" }, 1);
    const c = buildMessage("p", "t", { type: "play" }, 1);
    expect([a, b, c].map((m) => guard.check(m, "p", "t", 1))).toEqual(["ok", "ok", "ok"]);
    const again = { a: guard.check(a, "p", "t", 1), c: guard.check(c, "p", "t", 1) };
    console.info("[phase:replay] bounded", JSON.stringify(again));
    expect(again).toEqual({ a: "ok", c: "duplicate" });
  });
});

describe("describeBody", () => {
  it("never carries a title or a media id", () => {
    const bodies = [
      STATE,
      { type: "start" as const, mediaId: "media-secret-42", episodeId: "ep-7", positionSeconds: 12.4, tracks: null },
      { type: "seekTo" as const, positionSeconds: 9.6 },
      { type: "seekBy" as const, deltaSeconds: -10 },
      { type: "setAudio" as const, idx: 1 },
      { type: "stop" as const },
    ];
    for (const body of bodies) {
      const summary = describeBody(body);
      const text = JSON.stringify(summary);
      console.info("[phase:describe]", text);
      expect(text).not.toContain("media-secret-42");
      expect(text).not.toContain("Secret Title");
      expect(text).not.toContain("ep-7");
    }
    expect(describeBody(bodies[1])).toEqual({ type: "start", positionSeconds: 12, episode: true, tracks: null });
    expect(describeBody(STATE)).toMatchObject({ type: "state", phase: "playing", positionSeconds: 62, durationSeconds: 3600, audioTracks: 1, subtitleTracks: 2 });
    expect(describeBody({ type: "seekTo", positionSeconds: 9.6 })).toEqual({ type: "seekTo", positionSeconds: 10 });
  });
});
