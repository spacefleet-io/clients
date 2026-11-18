/**
 * Typed IPC bridge surface — replaces the `(command: unknown)` boundary
 * that historically connected the desktop renderer (via preload) to the
 * Electron main process. Every command sent over the bridge is one of the
 * known shapes produced by the builders in commands.ts / properties.ts.
 *
 * This file is type-only — no runtime — so it imposes zero overhead and
 * the wire format is identical to what the engine produced before Tier-2.
 * The bridge types are what catch typos at compile time:
 *
 *   // before: sendExternalMpvCommand({ command: ["set_propery", "sid", 1] })
 *   //         silently produces an mpv error response, no type signal
 *   // after:  TypeScript errors — { command: ["set_propery", ...] } is not
 *   //         assignable to MpvCommand (no "set_propery" variant exists)
 */

import type {
  GetPropertyCommand,
  MpvProperty,
  SetPropertyCommand,
} from "./properties";
import type {
  LoadfileCommand,
  ScriptMessageCommand,
  SeekCommand,
  SubAddCommand,
  SubRemoveCommand,
} from "./commands";
import type { OscActionFile } from "./envelopes";
import type { LifecycleState } from "./lifecycle";

/**
 * Discriminated union of every command shape produced by an
 * `@space/mpv-protocol` builder, plus the few low-level commands the
 * desktop main process issues directly (`quit`, `cycle`).
 *
 * Extend this union when adding a new builder — TypeScript will then
 * force every caller of `sendExternalMpvCommand` / `sendExternalMpvRequest`
 * to handle (or accept) the new shape.
 */
export type MpvCommand =
  | GetPropertyCommand
  | SetPropertyCommand
  | ScriptMessageCommand
  | SeekCommand
  | LoadfileCommand
  | SubAddCommand
  | SubRemoveCommand
  | { command: ["quit"] }
  | { command: ["cycle", ...string[]] }
  | { command: ["ao-reload"] };

/**
 * mpv's JSON-IPC envelope around any successful or failed command.
 *
 * mpv always replies with `error: "success"` on a successful command.
 * Anything else in `error` indicates a real failure. `data` is present
 * on `get_property` and similar reads; `request_id` echoes the value the
 * client set on the request (used by the main-process client to
 * correlate concurrent in-flight requests).
 *
 * The transport layer (UnixSocketMpvClient + PreloadMpvClient in later
 * tiers) may also surface synthetic responses like
 * `{ error: "mpv_socket_missing" }` when the socket is gone; consumers
 * should treat any non-`"success"` error as a real failure (per
 * `isExternalMpvResponseError` in responseError.ts).
 */
export type MpvResponse = {
  data?: unknown;
  error?: string;
  request_id?: number;
};

/**
 * The set of Electron IPC channel names this package recognizes for
 * external-mpv coordination. Used by preload to type its handlers and
 * by tests to assert there's no string-literal drift.
 *
 * Tier-4 retired the per-event channels `sf-mpv-external-exit` and
 * `sf-mpv-external-osc-action` in favor of a single multiplexed
 * `sf-mpv-external-message` channel that carries an `MpvExternalMessage`
 * discriminated union (exit / osc_action / property_change). The single
 * channel halves the number of preload listeners renderer code has to
 * register and gives the new `property_change` push events (from mpv's
 * `observe_property`) a home alongside the existing lifecycle events.
 */
export type IpcChannelName =
  | "sf-mpv-external-play"
  | "sf-mpv-external-command"
  | "sf-mpv-external-request"
  | "sf-mpv-external-stop"
  | "sf-mpv-external-alive"
  | "sf-mpv-external-message"
  | "sf-mpv-cache-subtitles"
  | "sf-mpv-clear-subtitle-cache"
  | "sf-mpv-playback-ready"
  | "sf-app-hide"
  | "sf-app-show";

/**
 * Discriminated union of every message the main process pushes to the
 * renderer over `sf-mpv-external-message`. The `type` field is the
 * discriminator; consumers should `switch` on it to handle each variant.
 *
 *   - `exit`           — mpv process exited (sent once per lifecycle).
 *   - `osc_action`     — sf.lua wrote a JSON action (next_episode / previous_episode).
 *   - `property_change` — observe_property push for one of the
 *     push-friendly subset (time-pos, duration, pause, mute, volume,
 *     eof-reached). The `value` field is `unknown` here because the
 *     channel is shape-agnostic; the renderer-side `PreloadMpvClient`
 *     narrows by property name when dispatching to subscribers.
 *   - `lifecycle`      — Tier-5 lifecycle state snapshot. The main-process
 *     client dispatches the pure reducer from `./lifecycle` on every
 *     event source and forwards the new state here. The renderer-side
 *     `useMpvLifecycleStore` hook consumes this via
 *     `MpvClient.subscribeLifecycle` to replace the 7 lifecycle refs
 *     scattered across `useMpvPlaybackEngine.ts`.
 *   - `script_message` — mpv emitted a `client-message` event because a
 *     Lua script called `mp.commandv("script-message", name, ...args)`.
 *     `name` is the channel (e.g. "sf-pill-state"); `args` are the
 *     remaining string arguments. Today this powers the E2E pill-state
 *     observer (sf.lua: emit_pill_state) but is shape-agnostic so any
 *     future Lua→renderer signal can reuse it without IPC plumbing.
 *   - `end_file`       — mpv emitted `end-file` (reason eof|stop|quit|error|
 *     redirect, plus mpv's `file_error`). An IDLE-launched mpv (backdrop
 *     handoff) does not exit when a `loadfile` fails, so `reason: "error"`
 *     is the renderer's signal to close mpv, show the app window and surface
 *     the playback error (issue #25, @bugfix
 *     mpv-handoff-load-failure-black-idle-window).
 *   - `file_loaded`    — mpv emitted `file-loaded`: the `loadfile`'d stream
 *     opened. The backdrop handoff waits on it when the `loadfile` reply
 *     itself timed out on a loaded PC (issue #25 P17).
 *   - `playback_restart` — mpv's first `playback-restart` of the loaded file
 *     (its first frame is up); the ABR first-frame clock (issue #25 N4).
 *
 * Tier-4 of the @space/mpv-protocol consolidation added `property_change`;
 * Tier-5 added `lifecycle`; Tier-6 added `script_message`.
 */
export type MpvExternalMessage =
  | { type: "exit" }
  // `seq` is a main-assigned monotonic id for the osc_action. It lets a
  // renderer that re-subscribes after a listener teardown window dedupe a
  // recovered (pulled) action against the live one — see the durable-delivery
  // path (main `sf-get-pending-osc-action`). Optional for backward-compat with
  // any emitter that doesn't set it.
  | { type: "osc_action"; action: OscActionFile; seq?: number }
  | { type: "property_change"; name: MpvProperty; value: unknown }
  | { type: "lifecycle"; state: LifecycleState }
  | { type: "script_message"; name: string; args: string[] }
  | { type: "end_file"; reason: string | null; fileError: string | null; playlistEntryId?: number | null }
  // mpv `start-file`: the events after it belong to the newly loaded entry (issue #25 P15).
  | { type: "start_file"; playlistEntryId: number | null }
  | { type: "file_loaded" }
  | { type: "playback_restart" };
