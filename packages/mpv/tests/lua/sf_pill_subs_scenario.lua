-- Drives sf.lua under the mocked mp runtime (mp_mock.lua) for two #25 bugs and
-- prints one machine-readable line: RESULT {...}
--   * pill-flood        : sf-pill-state emit rate (NEW-pill-state-flood)
--   * subs-*            : subtitles re-applied across a reload / next file
--                         (NEW-subs-lost-after-reload)
-- Usage: <lua> sf_pill_subs_scenario.lua <path/to/sf.lua> <scenario>

local here = arg[0]:match("^(.*)[/\\]") or "."
package.path = here .. "/?.lua;" .. package.path
local M = require("mp_mock")

local sf_path, scenario = arg[1], arg[2]
assert(sf_path and scenario, "usage: sf_pill_subs_scenario.lua <sf.lua> <scenario>")

local result = { scenario = scenario }

local function boot(start_pos, markers)
  M.load(sf_path, {
    path = "/media/episode-1.mkv",
    duration = 1200,
    pause = false,
    speed = 1,
    ["track-list"] = {},
  })
  M.fire_event("start-file")
  M.fire_event("file-loaded")
  M.set_prop("time-pos", start_pos)
  M.script_message("sf-playback-json", M.json.encode({
    markers = markers or {},
    autoplayNextEpisode = true,
    autoSkipNextEpisode = false,
  }))
end

local function emits() return M.pill_emits or 0 end

local function sub_adds(url)
  local n = 0
  for _, c in ipairs(M.commands) do
    if c[1] == "sub-add" and (url == nil or c[2] == url) then n = n + 1 end
  end
  return n
end

local function external_subs()
  local urls = {}
  for _, t in ipairs(M.props["track-list"] or {}) do
    if t.type == "sub" and t.external then urls[#urls + 1] = t["external-filename"] end
  end
  return urls
end

-- mpv clears the track list when it moves to a new file / reloads, then fires
-- start-file and (once the demuxer opened) file-loaded.
local function reload()
  M.log("reload: track-list cleared, start-file -> file-loaded")
  M.props["track-list"] = {}
  M.fire_event("start-file")
  M.fire_event("file-loaded")
end

local SUB_A = { url = "http://127.0.0.1/subs/ep1-en.vtt", title = "English", lang = "en", selected = true }
local SUB_B = { url = "http://127.0.0.1/subs/ep2-en.vtt", title = "English", lang = "en", selected = true }

if scenario == "pill-flood" then
  boot(10)
  M.play(0.5) -- warm-up: first emit(s) for the initial (inactive) pill
  -- 100 refresh ticks inside 0.5 s of wall clock, pill payload unchanged
  -- (no marker; only time-pos moves).
  local before = emits()
  M.play(0.5, 0.005)
  result.emitsPer100Ticks = emits() - before
  -- 10 s of normal 24 fps playback, payload unchanged: heartbeat only.
  before = emits()
  M.play(10)
  result.emitsPer10s = emits() - before
  result.lastTimePos = M.last_pill_state and M.last_pill_state.timePos or nil
  -- A real change (pill appears) is emitted on the very tick it happens.
  local now = M.props["time-pos"]
  local intro_start = now + 2
  M.script_message("sf-playback-json", M.json.encode({
    markers = { { type = "intro", startSeconds = intro_start, endSeconds = intro_start + 30, autoSkip = false } },
    autoplayNextEpisode = true,
    autoSkipNextEpisode = false,
  }))
  M.play(5, nil, function() return M.last_pill_state and M.last_pill_state.active == true end)
  result.introStart = intro_start
  result.activeAtMedia = M.props["time-pos"]
  result.activeState = M.last_pill_state
  -- 5 s inside the marker: the visible countdown changes once per second.
  before = emits()
  M.play(5)
  result.emitsPer5sCountdown = emits() - before
  result.countdownAfter5s = M.last_pill_state and M.last_pill_state.countdown or nil
  result.mediaAfter5s = M.props["time-pos"]
elseif scenario == "subs-resend-before-start" then
  -- Reload where the renderer's re-send lands BEFORE the reload's start-file
  -- (subtitles_applied still true from the previous load).
  boot(10)
  M.script_message("sf-subtitles-json", M.json.encode({ SUB_A }))
  result.addsInitial = sub_adds()
  M.script_message("sf-subtitles-json", M.json.encode({ SUB_A }))
  reload()
  M.play(2)
  result.addsAfterReload = sub_adds() - result.addsInitial
  result.externalSubs = external_subs()
elseif scenario == "subs-no-resend" then
  -- Quality / ABR reload: the renderer does not re-send subtitles at all.
  boot(10)
  M.script_message("sf-subtitles-json", M.json.encode({ SUB_A }))
  result.addsInitial = sub_adds()
  reload()
  M.play(2)
  result.addsAfterReload = sub_adds() - result.addsInitial
  result.externalSubs = external_subs()
elseif scenario == "subs-next-file-early" then
  -- Next episode: its list (B) arrives before start-file.
  boot(10)
  M.script_message("sf-subtitles-json", M.json.encode({ SUB_A }))
  result.addsInitial = sub_adds()
  M.script_message("sf-subtitles-json", M.json.encode({ SUB_B }))
  reload()
  M.play(2)
  result.addsAAfterReload = sub_adds(SUB_A.url) - 1
  result.addsBAfterReload = sub_adds(SUB_B.url)
  result.externalSubs = external_subs()
elseif scenario == "subs-next-file-empty" then
  -- Next episode has no subtitles: the renderer sends [] before start-file,
  -- which must clear the cache so episode 1's subtitles do not leak.
  boot(10)
  M.script_message("sf-subtitles-json", M.json.encode({ SUB_A }))
  result.addsInitial = sub_adds()
  M.script_message("sf-subtitles-json", "[]")
  reload()
  M.play(2)
  result.addsAfterReload = sub_adds() - result.addsInitial
  result.externalSubs = external_subs()
else
  error("unknown scenario " .. scenario)
end

print("RESULT " .. M.json.encode(result))
