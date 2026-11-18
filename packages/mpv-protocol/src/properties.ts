/**
 * Typed catalog of mpv properties read/written by SpaceBadger desktop.
 *
 * mpv's JSON IPC `get_property` / `set_property` API uses plain strings, so
 * every callsite has historically been stringly-typed:
 *
 *   send({ command: ["get_property", "time-pos"] })
 *   send({ command: ["set_property", "sid", existing.id] })
 *
 * A typo in either the property name or the value type silently breaks
 * playback with no compile-time signal. The wrappers below preserve the
 * exact wire format (so transport behavior is unchanged) but add a
 * literal-union of supported property names and a per-property value type.
 *
 * The `send` callback is intentionally generic — `(cmd: unknown) =>
 * Promise<unknown>` — so this module stays transport-agnostic. Callers in
 * the renderer hook pass `sendExternalRequest`; future main-process or
 * native callers can pass anything that fulfils the same contract.
 *
 * Mirror of the @space/runtime-contracts `defineCommand` / `parsePayload`
 * pattern.
 */

import type { MpvTrack } from "./trackList";

export type MpvChapter = {
  title?: string;
  time?: number;
};

export type MpvDemuxerCacheState = {
  "cache-duration"?: number;
  underrun?: boolean;
  [key: string]: unknown;
};

export type MpvTrackId = number | "no" | "auto";

/**
 * Union of every property name the SpaceBadger desktop renderer / main
 * process reads or writes via JSON IPC today. Extend this union if a new
 * property is added — TypeScript will then force the corresponding entry
 * in MpvPropertyTypes.
 */
export type MpvProperty =
  | "time-pos"
  | "time-start"
  | "track-list"
  | "chapter-list"
  | "vo-configured"
  | "pause"
  | "mute"
  | "volume"
  | "duration"
  | "demuxer-cache-time"
  | "demuxer-cache-state"
  | "paused-for-cache"
  | "eof-reached"
  | "sid"
  | "aid"
  | "vid"
  | "idle-active"
  | "cache-secs"
  | "demuxer-max-bytes"
  | "hwdec-current"
  | "hwdec-interop"
  | "current-vo"
  | "current-gpu-context"
  | "frame-drop-count"
  | "decoder-frame-drop-count"
  | "avsync"
  | "log-file"
  | "seeking"
  | "audio-pts"
  | "current-ao"
  | "audio-device"
  | "audio-device-list";

/**
 * Per-property value type as it appears in mpv's `data` field on a
 * successful response and as it is expected on the wire for set_property.
 */
export type MpvPropertyTypes = {
  "time-pos": number;
  "time-start": number;
  duration: number;
  "track-list": MpvTrack[];
  "chapter-list": MpvChapter[];
  "vo-configured": boolean;
  pause: boolean;
  mute: boolean;
  volume: number;
  "demuxer-cache-time": number;
  "paused-for-cache": boolean;
  "eof-reached": boolean;
  sid: MpvTrackId;
  aid: MpvTrackId;
  vid: MpvTrackId;
  "idle-active": boolean;
  "demuxer-cache-state": MpvDemuxerCacheState;
  "cache-secs": number;
  /** Demuxer packet cache limit, bytes (`--demuxer-max-bytes`). */
  "demuxer-max-bytes": number;
  /**
   * Hardware decoder in use for the current video track ("nvdec", "vaapi", "d3d11va", "videotoolbox", …)
   * or "no" = software decode. Unavailable (property error) until a video decoder exists.
   */
  "hwdec-current": string;
  /** GPU interop the vo loaded for hwdec ("cuda-nvdec", "vaapi-egl", "d3d11", …); unavailable on a CPU vo. */
  "hwdec-interop": string;
  /** Video output that actually initialised ("gpu", "gpu-next", "x11", "null", …); unavailable before the vo. */
  "current-vo": string;
  /** GPU context of a gpu/gpu-next vo ("x11egl", "d3d11", "macvk", …); unavailable on a CPU vo. */
  "current-gpu-context": string;
  /** Frames the vo dropped (late) since the file started. */
  "frame-drop-count": number;
  /** Frames the decoder dropped (framedrop=decoder) since the file started. */
  "decoder-frame-drop-count": number;
  /** Last A/V difference in seconds (audio - video). */
  avsync: number;
  /** mpv's log file; "" closes it (createMpvRenderPathReporter, transient launch logs). */
  "log-file": string;
  /** True while mpv seeks or loads (until playback restarts); unavailable before playback is initialised. */
  seeking: boolean;
  /** Current audio position in seconds after the output's delay; unavailable without an audio output (MPV-AUDIO-01). */
  "audio-pts": number;
  /** Audio output driver in use ("pipewire", "pulse", "alsa", "coreaudio", "wasapi", "null", …); unavailable without audio. */
  "current-ao": string;
  /** Selected audio device ("auto" = the system default output, else "<ao>/<device>"). */
  "audio-device": string;
  /** Outputs mpv can see; changes when a device appears or goes away. */
  "audio-device-list": Array<{ name: string; description: string }>;
};

export type MpvPropertyValue<P extends MpvProperty> = MpvPropertyTypes[P];

/**
 * Generic `send` shape. mpv IPC always returns an object with either `data`
 * (success) or `error` (anything else), but we don't constrain the response
 * here — the wrappers normalize what they receive. The argument type is
 * the typed `MpvCommand` discriminated union from bridge.ts so the consumer
 * can be passed any `MpvCommand`-typed callback (variance-safe).
 */
import type { MpvCommand } from "./bridge";
export type MpvSend = (cmd: MpvCommand) => Promise<unknown>;

/**
 * Wire-shape command types for get_property / set_property. Named exports
 * so the bridge-level discriminated union in bridge.ts can reference them
 * without re-deriving the shapes.
 */
export type GetPropertyCommand<P extends MpvProperty = MpvProperty> = {
  command: ["get_property", P];
};

export type SetPropertyCommand<P extends MpvProperty = MpvProperty> = {
  command: ["set_property", P, MpvPropertyValue<P>];
};

/**
 * Build the wire-shape JSON-IPC command for get_property/set_property.
 * Useful for callers that compose their own batches.
 */
export const buildGetPropertyCommand = <P extends MpvProperty>(
  property: P,
): GetPropertyCommand<P> => ({
  command: ["get_property", property],
});

export const buildSetPropertyCommand = <P extends MpvProperty>(
  property: P,
  value: MpvPropertyValue<P>,
): SetPropertyCommand<P> => ({
  command: ["set_property", property, value],
});

/**
 * Read a property over IPC. Returns the typed value on success, or null
 * when the response is missing/error/wrong shape (preserving the existing
 * "soft failure" semantics that callers already handle).
 */
export const getProperty = async <P extends MpvProperty>(
  send: MpvSend,
  property: P,
): Promise<MpvPropertyValue<P> | null> => {
  const result = (await send(buildGetPropertyCommand(property))) as
    | { data?: unknown; error?: unknown }
    | null
    | undefined;
  if (!result || typeof result !== "object") return null;
  if ("error" in result && typeof result.error === "string" && result.error !== "success") {
    return null;
  }
  if (!("data" in result)) return null;
  return result.data as MpvPropertyValue<P>;
};

/**
 * Write a property over IPC. Returns true when mpv ACKs (error: "success")
 * or replies without an explicit error; false when mpv reports a real
 * failure or the transport returns null.
 */
export const setProperty = async <P extends MpvProperty>(
  send: MpvSend,
  property: P,
  value: MpvPropertyValue<P>,
): Promise<boolean> => {
  const result = (await send(buildSetPropertyCommand(property, value))) as
    | { error?: unknown }
    | null
    | undefined;
  if (!result || typeof result !== "object") return false;
  if (!("error" in result)) return true;
  const error = (result as { error?: unknown }).error;
  if (typeof error !== "string") return !error;
  return error === "success";
};
