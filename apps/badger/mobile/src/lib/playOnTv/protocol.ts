/**
 * "Play on TV" (UX-TV-02): the messages between the phone (the remote) and the SpaceBadger TV app (the player). They travel
 * through our servers' peer relay (`/p2p/relay/*`) sealed with the account key (`seal.ts`), so the servers forward them
 * without learning what is played. Pure: no React Native import, so the TV, the phone, the tests and the e2e node client
 * (`e2e-tv/lib/playOnTvClient.ts`) all share this one definition.
 *
 * Phone -> TV: `hello` (ask for the state), `start`, `pause`, `play`, `seekBy`, `seekTo`, `setAudio`, `setSubtitle`, `stop`.
 * TV -> phone: `state` (after every command and about once a second while a remote is attached).
 */

export const PLAY_ON_TV_PROTOCOL = 1;

/** A message older than this (or this far in the future: clocks drift) is dropped: a replayed command does nothing. */
export const MESSAGE_MAX_AGE_MS = 10 * 60_000;

/** Library track indexes to start with; `subtitleIdx` -1 = subtitles off, null = the TV's own choice (PLAY-TRACK-04). */
export type TrackChoice = { audioIdx: number | null; subtitleIdx: number | null };

export type StartCommand = {
  type: "start";
  mediaId: string;
  /** The episode for a show; null for a movie, or for a show when the TV should pick the episode its own Play button would. */
  episodeId: string | null;
  /** The phone's resume point, in seconds (0 = from the start). */
  positionSeconds: number;
  tracks: TrackChoice | null;
};

/** What the TV's player gets from a remote start (navigation param): where to start and which tracks to pick. */
export type RemoteStart = { positionSeconds: number; tracks: TrackChoice | null };

export type RemoteCommand =
  | { type: "hello" }
  | StartCommand
  | { type: "pause" }
  | { type: "play" }
  | { type: "seekBy"; deltaSeconds: number }
  | { type: "seekTo"; positionSeconds: number }
  | { type: "setAudio"; idx: number }
  /** `idx` -1 = subtitles off. */
  | { type: "setSubtitle"; idx: number }
  | { type: "stop" };

export type RemoteCommandType = RemoteCommand["type"];

/** `idle`: nothing playing. `loading`: the title is opening. `ended`: the player closed after a stop or the end. */
export type TvPhase = "idle" | "loading" | "playing" | "paused" | "ended" | "failed";

export type TvTrack = { idx: number; label: string | null; language: string | null };

export type TvState = {
  type: "state";
  phase: TvPhase;
  mediaId: string | null;
  episodeId: string | null;
  /** Title shown on the phone's remote (sealed like everything else). */
  title: string | null;
  positionSeconds: number;
  durationSeconds: number;
  audioTracks: TvTrack[];
  subtitleTracks: TvTrack[];
  audioIdx: number | null;
  /** -1 = off. */
  subtitleIdx: number;
  /** Why the last command could not be applied (`not_playing`, `media_not_found`, `start_failed`, ...), else null. */
  error: string | null;
};

export type RemoteBody = RemoteCommand | TvState;

/** What is sealed: the body plus who sent it, to whom, when, and a unique id (the replay guard keys on it). */
export type RemoteMessage = {
  proto: typeof PLAY_ON_TV_PROTOCOL;
  id: string;
  /** The sender's relay peer id: must equal the relay's `fromPeerId`, so the server cannot re-attribute a message. */
  from: string;
  /** The recipient's relay peer id: must equal the receiving device's own, so the server cannot redirect a message. */
  to: string;
  sentAt: number;
  body: RemoteBody;
};

export const IDLE_STATE: TvState = {
  type: "state",
  phase: "idle",
  mediaId: null,
  episodeId: null,
  title: null,
  positionSeconds: 0,
  durationSeconds: 0,
  audioTracks: [],
  subtitleTracks: [],
  audioIdx: null,
  subtitleIdx: -1,
  error: null,
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isIndex = (value: unknown): value is number => isFiniteNumber(value) && Number.isInteger(value) && value >= -1;
const nullableString = (value: unknown): string | null | undefined =>
  value === null ? null : typeof value === "string" ? value : undefined;

const parseTrackChoice = (value: unknown): TrackChoice | null | undefined => {
  if (value === null || value === undefined) return null;
  if (!isObject(value)) return undefined;
  const { audioIdx, subtitleIdx } = value;
  if (audioIdx !== null && !(isIndex(audioIdx) && audioIdx >= 0)) return undefined;
  if (subtitleIdx !== null && !isIndex(subtitleIdx)) return undefined;
  return { audioIdx: audioIdx as number | null, subtitleIdx: subtitleIdx as number | null };
};

const parseTracks = (value: unknown): TvTrack[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const out: TvTrack[] = [];
  for (const entry of value) {
    if (!isObject(entry) || !isIndex(entry.idx) || entry.idx < 0) return undefined;
    const label = nullableString(entry.label);
    const language = nullableString(entry.language);
    if (label === undefined || language === undefined) return undefined;
    out.push({ idx: entry.idx, label, language });
  }
  return out;
};

const TV_PHASES: readonly TvPhase[] = ["idle", "loading", "playing", "paused", "ended", "failed"];

/** The body of a message, validated field by field; null for anything this build does not understand. */
export const parseRemoteBody = (value: unknown): RemoteBody | null => {
  if (!isObject(value) || typeof value.type !== "string") return null;
  switch (value.type) {
    case "hello":
    case "pause":
    case "play":
    case "stop":
      return { type: value.type };
    case "start": {
      const episodeId = nullableString(value.episodeId);
      const tracks = parseTrackChoice(value.tracks);
      if (typeof value.mediaId !== "string" || !value.mediaId || episodeId === undefined || tracks === undefined) return null;
      if (!isFiniteNumber(value.positionSeconds) || value.positionSeconds < 0) return null;
      return { type: "start", mediaId: value.mediaId, episodeId, positionSeconds: value.positionSeconds, tracks };
    }
    case "seekBy":
      return isFiniteNumber(value.deltaSeconds) ? { type: "seekBy", deltaSeconds: value.deltaSeconds } : null;
    case "seekTo":
      return isFiniteNumber(value.positionSeconds) && value.positionSeconds >= 0
        ? { type: "seekTo", positionSeconds: value.positionSeconds }
        : null;
    case "setAudio":
      return isIndex(value.idx) && value.idx >= 0 ? { type: "setAudio", idx: value.idx } : null;
    case "setSubtitle":
      return isIndex(value.idx) ? { type: "setSubtitle", idx: value.idx } : null;
    case "state": {
      const phase = TV_PHASES.find((p) => p === value.phase);
      const mediaId = nullableString(value.mediaId);
      const episodeId = nullableString(value.episodeId);
      const title = nullableString(value.title);
      const error = nullableString(value.error);
      const audioTracks = parseTracks(value.audioTracks);
      const subtitleTracks = parseTracks(value.subtitleTracks);
      if (!phase || mediaId === undefined || episodeId === undefined || title === undefined || error === undefined) return null;
      if (!audioTracks || !subtitleTracks) return null;
      if (!isFiniteNumber(value.positionSeconds) || !isFiniteNumber(value.durationSeconds)) return null;
      if (value.audioIdx !== null && !(isIndex(value.audioIdx) && value.audioIdx >= 0)) return null;
      if (!isIndex(value.subtitleIdx)) return null;
      return {
        type: "state",
        phase,
        mediaId,
        episodeId,
        title,
        positionSeconds: value.positionSeconds,
        durationSeconds: value.durationSeconds,
        audioTracks,
        subtitleTracks,
        audioIdx: value.audioIdx as number | null,
        subtitleIdx: value.subtitleIdx,
        error,
      };
    }
    default:
      return null;
  }
};

/** A decrypted message, validated; null when it is not ours, from another protocol version or malformed. */
export const parseRemoteMessage = (value: unknown): RemoteMessage | null => {
  if (!isObject(value) || value.proto !== PLAY_ON_TV_PROTOCOL) return null;
  if (typeof value.id !== "string" || !value.id || typeof value.from !== "string" || !value.from) return null;
  if (typeof value.to !== "string" || !value.to) return null;
  if (!isFiniteNumber(value.sentAt)) return null;
  const body = parseRemoteBody(value.body);
  if (!body) return null;
  return { proto: PLAY_ON_TV_PROTOCOL, id: value.id, from: value.from, to: value.to, sentAt: value.sentAt, body };
};

let counter = 0;
/** Unique enough for the replay guard: time, a counter and randomness (no crypto needed: the id is not a secret). */
export const newMessageId = (now: number = Date.now()): string => {
  counter = (counter + 1) % 1_000_000;
  return `${now.toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

export const buildMessage = (from: string, to: string, body: RemoteBody, now: number = Date.now()): RemoteMessage => ({
  proto: PLAY_ON_TV_PROTOCOL,
  id: newMessageId(now),
  from,
  to,
  sentAt: now,
  body,
});

export type ReplayVerdict = "ok" | "duplicate" | "stale" | "sender_mismatch" | "recipient_mismatch";

/**
 * Drops what a relay (or anyone holding an old sealed message) could replay or misroute: an id seen before, a message
 * outside `MESSAGE_MAX_AGE_MS` of this device's clock, one whose sealed sender differs from the relay's `fromPeerId`,
 * or one sealed for another device of the account (they all share the key) than `ownPeerId`.
 */
export const createReplayGuard = (maxAgeMs: number = MESSAGE_MAX_AGE_MS, maxRemembered = 512) => {
  const seen = new Map<string, number>();
  return {
    check(message: RemoteMessage, relayFromPeerId: string, ownPeerId: string, now: number = Date.now()): ReplayVerdict {
      if (message.from !== relayFromPeerId) return "sender_mismatch";
      if (message.to !== ownPeerId) return "recipient_mismatch";
      if (Math.abs(now - message.sentAt) > maxAgeMs) return "stale";
      if (seen.has(message.id)) return "duplicate";
      seen.set(message.id, now);
      if (seen.size > maxRemembered) {
        const oldest = seen.keys().next().value;
        if (oldest !== undefined) seen.delete(oldest);
      }
      return "ok";
    },
  };
};

/** One-line summary of a body for the logs: the command and its numbers, never a title or a media id (logs leave the device). */
export const describeBody = (body: RemoteBody): Record<string, unknown> => {
  switch (body.type) {
    case "start":
      return { type: body.type, positionSeconds: Math.round(body.positionSeconds), episode: body.episodeId !== null, tracks: body.tracks };
    case "seekBy":
      return { type: body.type, deltaSeconds: body.deltaSeconds };
    case "seekTo":
      return { type: body.type, positionSeconds: Math.round(body.positionSeconds) };
    case "setAudio":
    case "setSubtitle":
      return { type: body.type, idx: body.idx };
    case "state":
      return {
        type: body.type,
        phase: body.phase,
        positionSeconds: Math.round(body.positionSeconds),
        durationSeconds: Math.round(body.durationSeconds),
        audioIdx: body.audioIdx,
        subtitleIdx: body.subtitleIdx,
        audioTracks: body.audioTracks.length,
        subtitleTracks: body.subtitleTracks.length,
        error: body.error,
      };
    default:
      return { type: body.type };
  }
};
