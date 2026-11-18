/**
 * Typed builders for mpv JSON-IPC commands beyond plain `get_property` /
 * `set_property` (those live in properties.ts).
 *
 * The flagship export is `buildScriptMessageCommand`, which validates the
 * payload against the channel's envelope schema before serializing it onto
 * the wire. Schema mismatches are loud at the desktop boundary instead of
 * silent in mpv's Lua handler.
 *
 * By project rule, all renderer↔Lua communication must go through
 * this layer — never call `script-message` with a raw `JSON.stringify(...)`
 * payload, since that's exactly the shape that has historically drifted.
 */

import { ENVELOPE_SCHEMAS, type EnvelopeChannel, type EnvelopePayload } from "./envelopes";

export type ScriptMessageCommand<C extends EnvelopeChannel = EnvelopeChannel> = {
  command: ["script-message", C, string];
};

export type SeekMode = "relative" | "absolute" | "absolute-percent" | "relative-percent";
export type SeekPrecision = "exact" | "keyframes";
export type LoadfileMode = "replace" | "append" | "append-play";
export type SubAddFlag = "select" | "auto" | "cached";

export type SeekCommand = { command: ["seek", number, ...string[]] };
export type LoadfileCommand = {
  command:
    | ["loadfile", string, LoadfileMode]
    | ["loadfile", string, LoadfileMode, number, string];
};

/**
 * A per-load track selection: an mpv track id, or "no" to disable the type.
 * Carried on reloads so a track the user picked in the OSC survives a quality
 * / ABR reload (issue #25 P18).
 */
export type LoadfileTrackSelection = number | "no";

/**
 * Per-load mpv options (mpv loadfile 5th arg) — comma-separated `key=value`
 * pairs applied for the duration of this load only. See mpv manual
 * "loadfile" command for the full set; the typed shape covers the options
 * the engine actively uses.
 *
 * Examples — `start=3081.5`, `pause=yes`, `vid=1`, `aid=2`.
 */
export type LoadfilePerLoadOptions = {
  startSeconds?: number | null;
  paused?: boolean;
  audioTrack?: LoadfileTrackSelection | null;
  subtitleTrack?: LoadfileTrackSelection | null;
  /**
   * The HLS variant to play: mpv picks the highest variant whose BANDWIDTH
   * is ≤ this. A reload must name it — without it mpv falls back to the
   * launch-time `--hls-bitrate` rung (issue #25 P19).
   */
  hlsBitrateBps?: number | null;
};
const formatTrackSelection = (value: LoadfileTrackSelection | null | undefined): string | null => {
  if (value === "no") return "no";
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return String(value);
  return null;
};

/**
 * The per-load tracks of a launch that opens the stream itself (no backdrop
 * handoff loadfile to carry them), as mpv command-line options.
 *
 * @bugfix @regression-proof #2762: a direct launch carried no `aid`, so mpv
 * opened on HLS rendition 1 and the app set `aid` within the first second.
 * mpv refreshes a newly selected stream by seeking the demuxer to
 * `time-pos - 1 s`, FFmpeg 8.1's HLS demuxer rejects any seek before the
 * playlist start, and the new audio then came from the read-ahead position:
 * playback jumped seconds ahead or stayed buffering.
 */
export const buildLaunchTrackArgs = (
  options: Pick<LoadfilePerLoadOptions, "audioTrack" | "subtitleTrack">,
): string[] => {
  const args: string[] = [];
  const aid = formatTrackSelection(options.audioTrack);
  if (aid !== null) args.push(`--aid=${aid}`);
  const sid = formatTrackSelection(options.subtitleTrack);
  if (sid !== null) args.push(`--sid=${sid}`);
  return args;
};

/**
 * Earliest `time-pos` at which a runtime `aid` switch on an HLS stream is safe.
 * mpv refreshes a newly selected stream with a demuxer seek to
 * `time-pos - 1 s` (demux.c initiate_refresh_seek); FFmpeg 8.1's HLS demuxer
 * fails every seek before the playlist start ("Seek failed (Operation not
 * permitted)"), after which the new track plays from the read-ahead position.
 * 0.25 s of margin covers the HLS start offset and the poll interval (#2762).
 */
export const MPV_TRACK_SWITCH_SAFE_SECONDS = 1.25;

/** True when an `aid` switch now would send mpv's refresh seek before the stream start (#2762). */
export const trackSwitchSeeksBeforeStart = (timePos: unknown): boolean =>
  typeof timePos !== "number" || !Number.isFinite(timePos) || timePos < MPV_TRACK_SWITCH_SAFE_SECONDS;

export type SubAddCommand = { command: ["sub-add", ...string[]] };
export type SubRemoveCommand = { command: ["sub-remove", number] };

/**
 * Build a `seek` command. Optional mode/precision flags are passed as
 * separate positional arguments per mpv's JSON-IPC quirk (the manual
 * documents a comma-joined form, but multi-arg works too and is what
 * existing call sites use).
 */
export const buildSeekCommand = (
  target: number,
  mode?: SeekMode,
  precision?: SeekPrecision,
): SeekCommand => {
  const args: ["seek", number, ...string[]] = ["seek", target];
  if (mode !== undefined) args.push(mode);
  if (precision !== undefined) args.push(precision);
  return { command: args };
};

/**
 * Resume points below this many seconds — segment 0's first GOP, with
 * headroom (ingest GOP is 96 frames: 4 s at 24 fps, 8 s at 12 fps) — load
 * with a from-0:00 prefill of exactly this many seconds
 * (`demuxer-cache-wait=yes,cache-secs=<this>`); every other load starts as
 * soon as the stream is playable. Shorter than the 16 s readahead target,
 * which the desktop main process restores on the file's first
 * playback-restart. @space/mpv buildExternalMpvArgs mirrors it for `--start`
 * launches; a desktop test keeps the two in lockstep.
 */
export const MPV_RESUME_PREFILL_WINDOW_SECONDS = 8;

/**
 * Build a `loadfile` command. Most callers want `replace`; `append` /
 * `append-play` mutate the playlist instead of swapping the source.
 *
 * `options` is mpv's per-load options syntax (5th positional arg). Use it
 * when the load must carry its own `start` / `pause` so the cmdline
 * `--start` / `--pause` don't apply (e.g. swapping from a backdrop image
 * to the actual HLS stream where the resume offset matters). Any options
 * object also pins the load's cache policy (`demuxer-cache-wait`), so the
 * 5th arg is never empty.
 *
 * The 4th positional arg `insertionIndex` is hard-coded to `-1` here; mpv
 * uses that as the "default" sentinel for replace mode.
 */
export const buildLoadfileCommand = (
  url: string,
  mode: LoadfileMode,
  options?: LoadfilePerLoadOptions,
): LoadfileCommand => {
  if (options === undefined) {
    return { command: ["loadfile", url, mode] };
  }
  const pieces: string[] = [];
  const startSeconds =
    typeof options.startSeconds === "number" && Number.isFinite(options.startSeconds) && options.startSeconds > 0
      ? options.startSeconds
      : null;
  if (startSeconds !== null) pieces.push(`start=${startSeconds}`);
  // No prefill: playback starts as soon as the stream is playable and the
  // cache fills to its --cache-secs readahead target in the background
  // (Chris, 2026-10-09, #25 playable-start). `demuxer-cache-wait=yes` held
  // the first frame until 16 s were cached — on a fresh start, a resume
  // (mpv runs the wait BEFORE the `start=` seek, so it read 16 s from 0:00
  // and discarded them, @bugfix ttff-resume-cache-wait-prefills-from-zero)
  // and an ABR/quality reload (10-23 s silent after a downshift on a slow
  // link). Throttled real-mpv run, 2500 kbps stream over a 2.8 Mbps link:
  // first frame 12.7 s → 0.47 s, no stall; `cache-pause-initial` only added
  // a ~1 s stall, so there is no initial threshold either.
  //
  // A resume INSIDE segment 0's first GOP keeps a short prefill: FFmpeg's
  // HLS demuxer snaps a seek into segment 0 to its start, then drops packets
  // until a keyframe with DTS >= 0 — the first keyframe's DTS is negative
  // (B-frame delay), so an uncached seek there plays from the NEXT keyframe
  // (resume at 1 s started at ~4 s). Served from the seekable cache, it is
  // exact. `cache-secs=<window>` caps that prefill (mpv waits until the
  // readahead target is cached). @bugfix resume-first-gop-lands-one-gop-late
  //
  // Always explicit, also from 0:00: an alive-mpv reload must not inherit
  // the globals of a first-GOP `--start` launch. Same split as @space/mpv
  // buildExternalMpvArgs.
  pieces.push(
    ...(startSeconds !== null && startSeconds < MPV_RESUME_PREFILL_WINDOW_SECONDS
      ? ["demuxer-cache-wait=yes", `cache-secs=${MPV_RESUME_PREFILL_WINDOW_SECONDS}`]
      : ["demuxer-cache-wait=no"]),
  );
  if (typeof options.paused === "boolean") {
    pieces.push(`pause=${options.paused ? "yes" : "no"}`);
  }
  const aid = formatTrackSelection(options.audioTrack);
  if (aid !== null) pieces.push(`aid=${aid}`);
  const sid = formatTrackSelection(options.subtitleTrack);
  if (sid !== null) pieces.push(`sid=${sid}`);
  if (typeof options.hlsBitrateBps === "number" && Number.isInteger(options.hlsBitrateBps) && options.hlsBitrateBps > 0) {
    pieces.push(`hls-bitrate=${options.hlsBitrateBps}`);
  }
  return { command: ["loadfile", url, mode, -1, pieces.join(",")] };
};

/**
 * Build a `sub-add` command.
 *
 * The `flag` choice is load-bearing — `"select"` sets `sid` BEFORE the
 * first decoded frame and avoids the post-launch refresh-seek loop
 * (see commit 7d42d8ff). `"auto"` loads the sub but leaves `sid="no"`
 * until something else selects it, which is what we want for additional
 * tracks the user can toggle later but didn't choose at launch.
 */
export const buildSubAddCommand = (
  url: string,
  flag: SubAddFlag,
  title?: string,
  lang?: string,
): SubAddCommand => {
  const args: ["sub-add", ...string[]] = ["sub-add", url, flag];
  if (title !== undefined) args.push(title);
  if (lang !== undefined) args.push(lang);
  return { command: args };
};

/** Build a `sub-remove` command: drops the subtitle track `sid` from mpv's track list. */
export const buildSubRemoveCommand = (sid: number): SubRemoveCommand => ({ command: ["sub-remove", sid] });

export type BuildScriptMessageOptions = {
  /**
   * When true, the payload is parsed against the envelope schema and an
   * error is thrown if it fails. Defaults to true under non-production
   * NODE_ENV so dev/test catches shape drift; production sends the payload
   * through unchanged to preserve the existing wire behavior.
   */
  validate?: boolean;
};

const shouldValidateByDefault = (): boolean => {
  if (typeof process === "undefined" || !process?.env) return true;
  return process.env.NODE_ENV !== "production";
};

/**
 * Format a Zod error into a single human-readable line.
 */
const formatZodIssues = (
  issues: ReadonlyArray<{ path: ReadonlyArray<unknown>; message: string }>,
): string =>
  issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");

/**
 * Build a mpv `script-message` command for one of the well-known channels,
 * validating the payload shape in dev/test. Returns the wire-shape object
 * ready to hand to mpv's JSON IPC `send`.
 *
 *   buildScriptMessageCommand("sf-subtitles-json", [{ url: "/x.srt" }])
 *     → { command: ["script-message", "sf-subtitles-json", "[{\"url\":\"/x.srt\"}]"] }
 *
 * Throws `Error` if validation is enabled and the payload doesn't match
 * the envelope schema. The error message lists every Zod issue.
 */
export const buildScriptMessageCommand = <C extends EnvelopeChannel>(
  channel: C,
  payload: EnvelopePayload<C>,
  options: BuildScriptMessageOptions = {},
): ScriptMessageCommand<C> => {
  const validate = options.validate ?? shouldValidateByDefault();
  if (validate) {
    const schema = ENVELOPE_SCHEMAS[channel];
    const result = schema.safeParse(payload);
    if (!result.success) {
      throw new Error(
        `buildScriptMessageCommand(${channel}): payload failed envelope validation: ${formatZodIssues(result.error.issues)}`,
      );
    }
  }
  return {
    command: ["script-message", channel, JSON.stringify(payload)],
  };
};
