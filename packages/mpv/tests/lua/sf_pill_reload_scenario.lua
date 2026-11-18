-- Drives sf.lua under the mocked mp runtime (mp_mock.lua): a drawn skip pill
-- across a same-media reload (Auto ABR quality switch), replayed from the #25
-- ultimate run 1791529129542 shard-3 case c055 (mpv-10-1792047556669.log
-- L1261-1703), plus the controls where the pill must go away.
-- Prints one machine-readable line: RESULT {...}
-- Usage: <lua> sf_pill_reload_scenario.lua <path/to/sf.lua> <scenario>

local here = arg[0]:match("^(.*)[/\\]") or "."
package.path = here .. "/?.lua;" .. package.path
local M = require("mp_mock")

local sf_path, scenario = arg[1], arg[2]
assert(sf_path and scenario, "usage: sf_pill_reload_scenario.lua <sf.lua> <scenario>")

local result = { scenario = scenario, steps = {} }

-- The c055 episode envelope (log L893 and the identical re-send at L1311).
local ENVELOPE = M.json.encode({
  markers = {
    { type = "intro", startSeconds = 60, endSeconds = 150, autoSkip = true },
    { type = "credits", startSeconds = 630, endSeconds = 720, autoSkip = true },
  },
  nextEpisode = { id = "f1448618-c2e8-43a9-8b9a-05742dd7e24b", label = "S1E06 - Part 6" },
  autoplayNextEpisode = true,
  autoSkipNextEpisode = true,
  fallbackCountdownSeconds = 15,
})
-- The next episode's envelope: its intro is elsewhere, other next episode.
local NEXT_ENVELOPE = M.json.encode({
  markers = {
    { type = "intro", startSeconds = 30, endSeconds = 90, autoSkip = true },
  },
  nextEpisode = { id = "0c7e3e4a-1111-4a2b-9c3d-000000000007", label = "S1E07 - Part 7" },
  autoplayNextEpisode = true,
  autoSkipNextEpisode = true,
  fallbackCountdownSeconds = 15,
})

local pill_overlay = nil
local emit_cursor = 1

local function pill_drawn()
  return pill_overlay ~= nil and (pill_overlay.data or ""):find("Skip intro", 1, true) ~= nil
end

-- sf-pill-state emits since the previous record() call.
local function new_emits()
  local out = {}
  for i = emit_cursor, #M.commands do
    local c = M.commands[i]
    if c[1] == "script-message" and c[2] == "sf-pill-state" then
      local state = M.json.decode(c[3])
      out[#out + 1] = { active = state.active, kind = state.kind, timePos = state.timePos }
    end
  end
  emit_cursor = #M.commands + 1
  return out
end

local function record(step)
  local entry = {
    step = step,
    wall = M.wall,
    timePos = M.props["time-pos"],
    pillDrawn = pill_drawn(),
    emits = new_emits(),
  }
  result.steps[#result.steps + 1] = entry
  M.log(string.format(
    "STEP %-34s wall=%.3f time-pos=%s pillDrawn=%s emits=%s",
    step, M.wall, tostring(M.props["time-pos"]), tostring(entry.pillDrawn), M.json.encode(entry.emits)
  ))
end

-- mpv keeps running while the new stream opens: the wall clock (and every
-- timer) advances, time-pos stays unavailable. M.play would invent a time-pos,
-- so run it with playback paused at the raw-property level (no observer).
local function loading(seconds)
  local paused = M.props.pause
  M.props.pause = true
  M.play(seconds)
  M.props.pause = paused
end

-- Boot c055: episode, intro 60-150 autoSkip, harness seekbar seek to 145.936
-- (mid-marker entry: pill shown, auto-skip suppressed), 1.5 s of playback.
local function boot_with_pill_drawn()
  M.load(sf_path, {
    path = "http://127.0.0.1:35713/playback/hls/cb786c48/master.m3u8",
    duration = 720,
    pause = false,
    speed = 1,
    ["track-list"] = {},
  })
  M.fire_event("start-file")
  M.fire_event("file-loaded")
  M.set_prop("time-pos", 0)
  M.script_message("sf-playback-json", ENVELOPE)
  M.play(1)
  M.set_prop("time-pos", 145.936)
  M.play(1.5)
  for _, overlay in ipairs(M.overlays) do
    if (overlay.data or ""):find("Skip intro", 1, true) then
      pill_overlay = overlay
    end
  end
  record("pill drawn before reload")
end

-- The renderer's `loadfile replace` (log L1261): mpv ends the old file, so
-- time-pos becomes unavailable (L1289: pre-fix the pill was cleared here).
local function old_file_ends()
  M.props["track-list"] = {}
  M.set_prop("time-pos", nil)
  record("old file ended (time-pos nil)")
end

-- New file is open (log L1689): time-pos is known when file-loaded runs; the
-- first observer tick follows.
local function new_file_loaded(at)
  M.props["time-pos"] = at
  M.fire_event("file-loaded")
  record("file-loaded")
  M.set_prop("time-pos", at + 1 / 24)
  record("first time-pos tick")
end

if scenario == "abr-reload" then
  boot_with_pill_drawn()
  old_file_ends()
  -- L1311: the renderer re-sends the same envelope right after loadfile.
  M.script_message("sf-playback-json", ENVELOPE)
  record("same envelope re-sent")
  M.fire_event("start-file")
  record("start-file")
  loading(0.66) -- L1314 → L1689: 4.075 → 4.732
  record("stream opening (0.66 s)")
  new_file_loaded(145.938)
  M.play(0.5)
  record("0.5 s after reload")
elseif scenario == "next-episode" then
  boot_with_pill_drawn()
  old_file_ends()
  -- Another media: its envelope differs, so the old pill must not stay.
  M.script_message("sf-playback-json", NEXT_ENVELOPE)
  record("next episode envelope sent")
  M.fire_event("start-file")
  record("start-file")
  loading(0.66)
  record("stream opening (0.66 s)")
  new_file_loaded(0)
  M.play(0.5)
  record("0.5 s after load")
elseif scenario == "reload-outside-marker" then
  boot_with_pill_drawn()
  old_file_ends()
  M.script_message("sf-playback-json", ENVELOPE)
  M.fire_event("start-file")
  loading(0.3)
  record("stream opening (0.3 s)")
  -- The reload lands past the intro: once time-pos is known, no pill.
  new_file_loaded(200)
elseif scenario == "stopped-idle" then
  boot_with_pill_drawn()
  old_file_ends()
  -- Playback stopped: mpv went idle, no file follows.
  M.set_prop("idle-active", true)
  record("idle-active true")
  loading(0.5)
  record("idle 0.5 s")
else
  error("unknown scenario " .. scenario)
end

print("RESULT " .. M.json.encode(result))
