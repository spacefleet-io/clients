/**
 * Frozen audio clock (MPV-AUDIO-01) and a sound output that cannot be opened (MPV-AUDIO-02).
 *
 * mpv keeps time from the audio output. When the output stops taking sound (2026-10-31: Bluetooth headphones refused
 * the stream with `org.bluez.Error.NotAuthorized`), `audio-pts` stops, the picture freezes with it, and nothing says
 * why: the player is unpaused, not buffering, not seeking, the cache is full and no frame is dropped.
 *
 * This watcher sees that state, which no healthy playback has: not paused, not paused-for-cache, not seeking, an audio
 * output open, and `audio-pts` unchanged for {@link AUDIO_STALL_MS}. It then
 *  - drops to no sound (`aid=no`) so mpv times the video from the system clock and the picture keeps moving,
 *  - tells the OSC (`sf-audio-stall`) to show the notice with its "Retry with sound" action,
 *  - logs one warning naming the audio output and device mpv reports.
 * Retry (the notice's action, `sf-audio-retry`) or a change in the outputs mpv sees restores the saved audio track;
 * when the device is still dead the clock freezes again and the cycle repeats after the same threshold.
 *
 * Threshold: 3 s. A healthy output never holds the clock still that long: mpv's audio buffer is 0.2 s and a
 * PipeWire/PulseAudio sink's latency well under 1 s, and a Bluetooth codec renegotiation pauses sound for 1-2 s. The
 * main process sees `audio-pts` through a 250 ms trailing throttle and checks every 500 ms, so 3 s leaves a margin over
 * those hiccups while the frozen picture stays short enough to read as a glitch, not a broken player.
 *
 * No sound output (MPV-AUDIO-02). When mpv cannot open the sound output at all (2026-11-16, a Windows PC: default
 * device gone or held exclusively, audio service hiccup) it used to drop the audio track and play the video silently,
 * with nothing on screen or in the logs. The launch now passes `--audio-fallback-to-null=yes`: mpv keeps the track on
 * its `null` output, so `current-ao` reads "null" while a track is on. Unless the launch asked for the null output
 * itself (SF_SILENT, `--ao=null`), the watcher shows the notice at once (reason `no-output`) and logs it; the notice's
 * retry or a change in the outputs runs `ao-reload`, which reopens the real output once it answers. A retry on an
 * output that still cannot open shows the notice again after the same threshold.
 */

import type { AudioStallPayload, MpvProperty, MpvTrackId } from "@space/mpv-protocol";

export const AUDIO_STALL_MS = 3_000;
/** How often the main process checks the clock (setInterval). */
export const AUDIO_STALL_TICK_MS = 500;
/** Throttle on the `audio-pts` / `time-pos` observers: mpv pushes them per frame. */
export const AUDIO_STALL_PTS_THROTTLE_MS = 250;

export const AUDIO_STALL_PROPERTIES = [
  "pause",
  "paused-for-cache",
  "seeking",
  "audio-pts",
  "time-pos",
  "current-ao",
  "audio-device",
  "audio-device-list",
  "aid",
] as const satisfies readonly MpvProperty[];

export type AudioStallProperty = (typeof AUDIO_STALL_PROPERTIES)[number];

type AudioStallLog = {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
};

export type MpvAudioStallWatchDeps = {
  now: () => number;
  /** Sets mpv's `aid` ("no" to drop the sound, the saved track to restore it). */
  setAid: (value: MpvTrackId) => Promise<unknown>;
  /** Runs mpv's `ao-reload`: tries the real sound output again after mpv fell back to its null output. */
  reloadAo: () => Promise<unknown>;
  /** The launch asked for mpv's null output itself (SF_SILENT, `--ao=null`): "null" then means silence on purpose. */
  intentionalNullAo: boolean;
  /** Sends `sf-audio-stall` to the OSC. */
  notify: (payload: AudioStallPayload) => void;
  log: AudioStallLog;
  stallMs?: number;
};

export type AudioStallMode = "watching" | "fallback";
/** Why the player plays without sound: a frozen clock (MPV-AUDIO-01) or no output could be opened (MPV-AUDIO-02). */
export type AudioFallbackReason = "frozen" | "no-output";

export type MpvAudioStallWatch = {
  onProperty: (name: AudioStallProperty, value: unknown) => void;
  /** Called every {@link AUDIO_STALL_TICK_MS}: decides whether the clock is frozen or the sound fell on the null output. */
  tick: () => void;
  /** "Retry with sound" (user) or a change in the outputs (device-change). No-op outside a fallback. */
  retry: (reason: "user" | "device-change") => void;
  snapshot: () => {
    mode: AudioStallMode;
    reason: AudioFallbackReason | null;
    props: Partial<Record<AudioStallProperty, unknown>>;
    lastProgressAt: number | null;
    savedAid: MpvTrackId | null;
    recovering: boolean;
  };
};

/** Whether mpv args end on the null output (`--ao=null`, the last `--ao` wins): an SF_SILENT launch or a test's own. */
export const requestsNullAo = (args: readonly string[]): boolean => {
  const ao = args.filter((arg) => arg.startsWith("--ao=")).at(-1);
  return ao !== undefined && ao.slice("--ao=".length).split(",")[0] === "null";
};

const isTrackId = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0;

/** "WH-1000XM4 (pipewire/bluez_output.AC_80_0A)", or the raw name when mpv lists no description for it. */
const describeDevice = (device: unknown, list: unknown): string => {
  const name = typeof device === "string" && device !== "" ? device : "unknown";
  if (name === "auto") return "auto (system default output)";
  const entry = Array.isArray(list)
    ? (list as Array<{ name?: unknown; description?: unknown }>).find((item) => item?.name === name)
    : undefined;
  return typeof entry?.description === "string" && entry.description !== "" ? `${entry.description} (${name})` : name;
};

export const createMpvAudioStallWatch = (deps: MpvAudioStallWatchDeps): MpvAudioStallWatch => {
  const stallMs = deps.stallMs ?? AUDIO_STALL_MS;
  const props: Partial<Record<AudioStallProperty, unknown>> = {};
  let mode: AudioStallMode = "watching";
  let reason: AudioFallbackReason | null = null;
  let lastProgressAt: number | null = null;
  let savedAid: MpvTrackId | null = null;
  // Set by a retry until the clock has moved for a full threshold: then "sound back" is logged once.
  let recovering = false;
  let retriedAt = 0;

  const setAid = (value: MpvTrackId, why: string) => {
    void deps.setAid(value).catch((error: unknown) => {
      deps.log.warn({ aid: value, why, error: error instanceof Error ? error.message : String(error) }, "[sf-audio-stall] set aid failed");
    });
  };

  const armed = (): boolean =>
    props.pause === false &&
    props["paused-for-cache"] !== true &&
    props.seeking === false &&
    typeof props["audio-pts"] === "number" &&
    typeof props["current-ao"] === "string" &&
    props["current-ao"] !== "";

  const enterFallback = (stalledMs: number) => {
    mode = "fallback";
    reason = "frozen";
    recovering = false;
    savedAid = isTrackId(props.aid) ? props.aid : "auto";
    const output = String(props["current-ao"]);
    const device = describeDevice(props["audio-device"], props["audio-device-list"]);
    deps.log.warn(
      {
        output,
        device,
        audioDevice: props["audio-device"] ?? null,
        audioPts: props["audio-pts"] ?? null,
        timePos: props["time-pos"] ?? null,
        stalledMs,
        aid: props.aid ?? null,
        pause: props.pause,
        pausedForCache: props["paused-for-cache"],
        seeking: props.seeking,
      },
      `[sf-audio-stall] audio clock frozen for ${stalledMs} ms while playing (not paused, not buffering, not seeking): audio output "${output}" device "${device}" is not taking sound; continuing without sound`,
    );
    setAid("no", "fallback");
    deps.notify({ state: "stalled", output, device });
  };

  const enterNoOutput = () => {
    mode = "fallback";
    reason = "no-output";
    recovering = false;
    savedAid = isTrackId(props.aid) ? props.aid : "auto";
    const device = describeDevice(props["audio-device"], props["audio-device-list"]);
    deps.log.warn(
      { output: "null", device, audioDevice: props["audio-device"] ?? null, aid: props.aid ?? null, timePos: props["time-pos"] ?? null },
      `[sf-audio-stall] no sound output could be opened: mpv plays the audio track on its null output, device "${device}"; continuing without sound`,
    );
    deps.notify({ state: "stalled", reason: "no-output", output: "null", device });
  };

  const leaveFallback = (why: string) => {
    mode = "watching";
    reason = null;
    recovering = true;
    retriedAt = deps.now();
    lastProgressAt = retriedAt;
    deps.notify({ state: "cleared" });
    deps.log.info({ why, savedAid, audioDevice: props["audio-device"] ?? null }, "[sf-audio-stall] leaving the no-sound fallback");
  };

  return {
    onProperty(name, value) {
      const previous = props[name];
      props[name] = value;
      switch (name) {
        case "audio-pts":
          if (typeof value === "number" && value !== previous) lastProgressAt = deps.now();
          return;
        case "pause":
        case "paused-for-cache":
        case "seeking":
          // A pause, a buffering wait or a seek holds the clock on purpose: the window restarts when it ends.
          if (value !== previous) lastProgressAt = deps.now();
          return;
        case "aid":
          // The user picked an audio track (OSC menu, reload) while we were silent: their choice wins. Not on the null
          // output: a track picked there plays on it too; only an output that opens brings the sound back.
          if (mode === "fallback" && reason === "frozen" && isTrackId(value) && value !== previous) {
            savedAid = value;
            leaveFallback("audio track picked");
          }
          return;
        case "current-ao":
          // A real output opened (ao-reload, the next file): the sound is back.
          if (mode === "fallback" && reason === "no-output" && typeof value === "string" && value !== "" && value !== "null") {
            leaveFallback(`sound output "${value}" opened`);
          }
          return;
        case "audio-device":
        case "audio-device-list":
          if (mode === "fallback" && previous !== undefined && JSON.stringify(value) !== JSON.stringify(previous)) {
            deps.log.info({ name, value }, "[sf-audio-stall] audio outputs changed while silent: retrying with sound");
            this.retry("device-change");
          }
          return;
        default:
          return;
      }
    },
    tick() {
      if (mode !== "watching") return;
      const now = deps.now();
      // A track playing on mpv's null output although the launch asked for a real one: no output could be opened.
      if (!deps.intentionalNullAo && props["current-ao"] === "null" && props.pause === false && isTrackId(props.aid)) {
        // Right after a retry "null" may still be read while ao-reload runs: give it the same threshold.
        if (!recovering || now - retriedAt >= stallMs) enterNoOutput();
        return;
      }
      if (!armed() || lastProgressAt === null) return;
      const stalledMs = now - lastProgressAt;
      if (stalledMs >= stallMs) {
        enterFallback(stalledMs);
        return;
      }
      if (recovering && lastProgressAt > retriedAt && now - retriedAt >= stallMs) {
        recovering = false;
        deps.log.info(
          { output: props["current-ao"], device: describeDevice(props["audio-device"], props["audio-device-list"]), audioPts: props["audio-pts"] },
          "[sf-audio-stall] sound back: the audio clock is moving again",
        );
      }
    },
    retry(why) {
      if (mode !== "fallback") {
        deps.log.info({ reason: why, mode }, "[sf-audio-stall] retry ignored: not in the no-sound fallback");
        return;
      }
      if (reason === "no-output") {
        leaveFallback(`retry (${why}): reopening the sound output`);
        void deps.reloadAo().catch((error: unknown) => {
          deps.log.warn({ why, error: error instanceof Error ? error.message : String(error) }, "[sf-audio-stall] ao-reload failed");
        });
        return;
      }
      const aid = savedAid ?? "auto";
      leaveFallback(`retry (${why})`);
      setAid(aid, `retry (${why})`);
    },
    snapshot: () => ({ mode, reason, props: { ...props }, lastProgressAt, savedAid, recovering }),
  };
};
