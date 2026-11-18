/**
 * Stream slots (ACCT-STREAM-01..04): the wire contract between the API's playback stream routes
 * and every player. The API imports these constants too, so the limits and codes have one source.
 *
 * - ACCT-STREAM-01: a profile plays at most 1 stream at a time in Badger, 2 in Parrot. The API refuses the
 *   next one before playback starts (`POST /playback/streams` → 409 `stream_limit`).
 * - ACCT-STREAM-02: at the limit the new device asks "Already playing on <device>. Play here instead?";
 *   yes = start again with `takeover: true`, the other device learns it on its next heartbeat (409
 *   `stream_taken_over`) and stops, saying "Playing on <new device> now". Never a dead-end error.
 * - ACCT-STREAM-03: casting counts as the casting phone's own stream: the phone keeps (or starts with
 *   `kind: "cast"`) its lease and keeps heartbeating while the receiver plays; the receiver never takes one.
 *   Offline playback of downloads never calls this API.
 * - ACCT-STREAM-04: the playing app heartbeats every 20 s; a stream not heard from for 60 s stops counting,
 *   so a crashed device frees its slot within about a minute.
 */

export const STREAM_APPS = ["badger", "parrot"] as const;
export type StreamApp = (typeof STREAM_APPS)[number];

export const STREAM_KINDS = ["play", "cast"] as const;
export type StreamKind = (typeof STREAM_KINDS)[number];

/** ACCT-STREAM-01: live streams a single profile may hold per app. */
export const STREAM_LIMITS: Readonly<Record<StreamApp, number>> = { badger: 1, parrot: 2 };

/** ACCT-STREAM-04: how often a playing device heartbeats. */
export const STREAM_HEARTBEAT_INTERVAL_SECONDS = 20;
/** ACCT-STREAM-04: a stream not heard from for this long no longer counts. */
export const STREAM_EXPIRY_SECONDS = 60;

export const STREAM_ERRORS = {
  /** 409 on start: the profile already plays `limit` streams in this app; body lists `playingOn`. */
  limit: "stream_limit",
  /** 409 on heartbeat: another device took this stream's slot; body names it (`byDeviceName`). */
  takenOver: "stream_taken_over",
  /** 404 on heartbeat: the stream expired or was stopped; the device may start again. */
  ended: "stream_ended",
  /** 404 on start: `profileId` is not one of the account's profiles. */
  profileNotFound: "profile_not_found",
} as const;

/** `POST /playback/streams` body. `profileId` defaults to the account's oldest (main) profile. */
export type StartStreamRequest = {
  app: StreamApp;
  profileId?: string;
  kind?: StreamKind;
  takeover?: boolean;
};

/** 201 of `POST /playback/streams`. */
export type StartedStream = {
  streamId: string;
  profileId: string;
  heartbeatIntervalSeconds: number;
  expiresInSeconds: number;
};

/** One stream that holds a slot, as listed in a 409 `stream_limit`. */
export type PlayingOnDevice = {
  streamId: string;
  /** The device's name ("Living room TV", "Chrome on Windows"); null when the session has none. */
  deviceName: string | null;
  deviceType: string | null;
  startedAt: string;
};

/** 409 body of `POST /playback/streams` at the limit. */
export type StreamLimitBody = { error: typeof STREAM_ERRORS.limit; limit: number; playingOn: PlayingOnDevice[] };

/** 200 of `POST /playback/streams/{id}/heartbeat`. */
export type HeartbeatBody = { expiresInSeconds: number };

/** 409 body of a heartbeat whose stream another device took over. */
export type TakenOverBody = { error: typeof STREAM_ERRORS.takenOver; byDeviceName: string | null; byDeviceType: string | null };

/** A device as the prompt names it: its own name, else a label from its type (`deviceLabel`). */
export type StreamDevice = { deviceName: string | null; deviceType: string | null };
