/**
 * Single-source-of-truth constants for channel names shared between the
 * JS desktop renderer and the in-mpv Lua scripts.
 *
 * Both sides previously hard-coded these strings. A parity test
 * (tests/parity-lua-channels.test.ts) text-greps `sf.lua` + `sf-select.lua`
 * to assert every channel in `LUA_CHANNELS` appears as the first argument
 * to `mp.register_script_message(...)`. That way, renaming a channel here
 * fails CI when the Lua side hasn't been updated.
 */

export const LUA_CHANNELS = {
  SUBTITLES_JSON: "sf-subtitles-json",
  CHAPTERS_JSON: "sf-chapters-json",
  AUDIO_JSON: "sf-audio-json",
  LABELS_JSON: "sf-labels-json",
  PLAYBACK_JSON: "sf-playback-json",
  PREVIEW_SHEETS: "sf-preview-sheets",
  PREVIEW_PICTURE: "sf-preview-picture",
  AUDIO_STALL: "sf-audio-stall",
  SUBTITLE_FETCH_JSON: "sf-subtitle-fetch-json",
} as const;

export type LuaChannelKey = keyof typeof LUA_CHANNELS;
export type LuaChannelName = (typeof LUA_CHANNELS)[LuaChannelKey];

/**
 * Lookup table for the parity test — pairs every channel name with the
 * Lua file that registers its handler.
 */
export const LUA_CHANNEL_REGISTRATIONS: ReadonlyArray<{
  channel: LuaChannelName;
  file: "sf.lua" | "sf-select.lua" | "tog4in1/tog4in1.lua";
}> = [
  { channel: "sf-subtitles-json", file: "sf.lua" },
  { channel: "sf-chapters-json", file: "sf.lua" },
  { channel: "sf-playback-json", file: "sf.lua" },
  { channel: "sf-audio-json", file: "sf-select.lua" },
  { channel: "sf-labels-json", file: "sf-select.lua" },
  { channel: "sf-labels-json", file: "sf.lua" },
  { channel: "sf-preview-sheets", file: "tog4in1/tog4in1.lua" },
  { channel: "sf-preview-picture", file: "tog4in1/tog4in1.lua" },
  { channel: "sf-audio-stall", file: "sf.lua" },
  { channel: "sf-subtitle-fetch-json", file: "sf-select.lua" },
];

/**
 * Lua → renderer channels: emitted by the Lua scripts with
 * `mp.commandv("script-message", <channel>, ...)` and forwarded by the main
 * process as `{ type: "script_message", name, args }`.
 *
 * TRACK_PICKED (sf-select.lua): the user picked a track in the OSC menu.
 * Args: `[property, value]`, property is "aid" | "sid", value is the mpv track
 * id as a string or "no". Issue #25 P18: without it the renderer never learns
 * the pick and a quality/ABR reload reverts it.
 *
 * OSC_SEEK (tog4in1.lua seekbar, sf.lua skip markers): the OSC issued an
 * absolute seek. Args: `[seconds]`, the target in movie time as a "%.3f"
 * string. Issue #25 P1b: mpv reports the pre-seek `time-pos` until the seek
 * lands, so a reload started meanwhile restarted at the old position.
 *
 * PREVIEW_HOVER (tog4in1.lua seekbar, MPV-PREV-01): the pointer is over the
 * seekbar at a new picture slot. Args: `[token, seconds]`, an increasing
 * request number and the moment as a "%.3f" string; seconds "-1" means the
 * pointer left. Handled by the main process (mpvPreviewPictures), which
 * answers `sf-preview-picture`; not forwarded to the renderer.
 *
 * PREVIEW_SHOWN (tog4in1.lua, MPV-PREV-01): the OSC accepted the picture
 * answered for `[token]` and draws it; it re-reads that file whenever the
 * pointer moves, so the main process keeps it until another one is shown.
 * Not forwarded to the renderer.
 *
 * AUDIO_RETRY (sf.lua, MPV-AUDIO-01): the user chose "Retry with sound" on the
 * frozen-audio notice. No args. Handled by the main process (mpvAudioStall),
 * which restores the audio track; not forwarded to the renderer.
 *
 * SUBTITLE_FETCH (sf-select.lua, PLAY-SUBGET-02): the "Get more subtitles…"
 * flow drawn over the paused video. Args: `["open"]` (the subtitle menu's row
 * was picked), `["pick", key]` (a language of the list was picked) or
 * `["cancel"]` (Escape on the list or a panel). The renderer answers on
 * `sf-subtitle-fetch-json`.
 */
export const LUA_OUTBOUND_CHANNELS = {
  TRACK_PICKED: "sf-track-picked",
  OSC_SEEK: "sf-osc-seek",
  PREVIEW_HOVER: "sf-preview-hover",
  PREVIEW_SHOWN: "sf-preview-shown",
  AUDIO_RETRY: "sf-audio-retry",
  SUBTITLE_FETCH: "sf-subtitle-fetch",
} as const;
