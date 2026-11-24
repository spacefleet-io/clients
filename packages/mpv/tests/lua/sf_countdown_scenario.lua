-- Drives sf.lua's skip / next-episode auto-fire countdown under the mocked mp
-- runtime (mp_mock.lua) and prints one machine-readable line:
--   RESULT {"scenario":...,"fires":[{"media":..,"wall":..,"kind":..}],...}
-- Usage: <lua> sf_countdown_scenario.lua <path/to/sf.lua> <scenario>
-- Scenarios: normal | slow | pause | next-episode | eof-premature[-autoplay] |
--            eof-natural | eof-seek-in-credits | credits-autoplay-off |
--            credits-last-episode-autoplay-off

local here = arg[0]:match("^(.*)[/\\]") or "."
package.path = here .. "/?.lua;" .. package.path
local M = require("mp_mock")

local sf_path, scenario = arg[1], arg[2]
assert(sf_path and scenario, "usage: sf_countdown_scenario.lua <sf.lua> <scenario>")

local result = { scenario = scenario, fires = {}, checkpoints = {} }
local fires = result.fires

local base_log = M.log
M.log = function(line)
  base_log(line)
  local kind = line:match("%[sf%-skip%] firing kind=(%S+)")
  if kind then
    fires[#fires + 1] = { media = M.props["time-pos"], wall = M.wall, kind = kind }
  end
end

local function checkpoint(label)
  local state = M.last_pill_state or {}
  local overlay = M.overlays[1]
  local entry = {
    label = label,
    wall = M.wall,
    media = M.props["time-pos"],
    paused = M.props.pause == true,
    fires = #fires,
    countdown = state.countdown,
    active = state.active,
    kind = state.kind,
    overlay = overlay and overlay.data or "",
  }
  result.checkpoints[#result.checkpoints + 1] = entry
  M.log(string.format(
    "checkpoint %s fires=%d countdown=%s active=%s overlay=%q",
    label, #fires, tostring(state.countdown), tostring(state.active), entry.overlay
  ))
end

local INTRO = { type = "intro", startSeconds = 60, endSeconds = 150, autoSkip = true }
local CREDITS = { type = "credits", startSeconds = 600, endSeconds = 700, autoSkip = true }

local function boot(start_pos, markers, next_episode, autoplay)
  M.load(sf_path, {
    path = "/media/episode-1.mkv",
    duration = 1200,
    pause = false,
    speed = 1,
  })
  M.fire_event("start-file")
  M.fire_event("file-loaded")
  M.set_prop("time-pos", start_pos)
  M.script_message("sf-playback-json", M.json.encode({
    markers = markers,
    nextEpisode = next_episode,
    autoplayNextEpisode = autoplay ~= false,
    autoSkipNextEpisode = true,
  }))
end

-- Re-sets the media length and the auto-skip flag for the end-of-media
-- scenarios (P6), which have no credits marker.
local function boot_episode_end(start_pos, auto_skip_next, autoplay)
  boot(start_pos, {}, { id = "episode-2", label = "Episode 2" }, autoplay)
  M.set_prop("duration", 720)
  M.script_message("sf-playback-json", M.json.encode({
    markers = {},
    nextEpisode = { id = "episode-2", label = "Episode 2" },
    autoplayNextEpisode = autoplay ~= false,
    autoSkipNextEpisode = auto_skip_next,
  }))
end

-- Every "Opening next episode" notice is one next-episode request (both the
-- countdown fire and the last-0.35 s fallback go through trigger_active_action).
local function next_episode_requests()
  local n = 0
  for _, line in ipairs(M.log_lines) do
    if line:find("notice shown: Opening next episode", 1, true) then n = n + 1 end
  end
  return n
end

local function first_fire() return #fires > 0 end

if scenario == "normal" then
  boot(55, { INTRO })
  M.play(30, nil, first_fire)
elseif scenario == "slow" then
  -- 0.3x playback: a struggling PC delivering ~a third of real time.
  boot(59, { INTRO })
  M.set_prop("speed", 0.3)
  M.play(60, nil, first_fire)
elseif scenario == "pause" then
  boot(58, { INTRO })
  M.play(30, nil, function() return (M.props["time-pos"] or 0) >= 62 end)
  checkpoint("before-pause")
  M.set_prop("pause", true)
  M.play(60)
  checkpoint("after-60s-paused")
  M.set_prop("pause", false)
  M.play(30, nil, first_fire)
  checkpoint("after-resume-fire")
elseif scenario == "next-episode" then
  -- PLAY-SKIP-02: the credits marker carries autoSkip, but credits are never
  -- skipped by themselves: the "Next episode" pill waits for a press.
  boot(597, { CREDITS }, { id = "episode-2", label = "Episode 2" })
  M.set_prop("speed", 0.5)
  M.play(20)
  checkpoint("credits+10s")
  result.nextEpisodeRequestsBeforeClick = next_episode_requests()
  M.script_message("sf-skip-confirm")
  M.play(0.5)
  checkpoint("notice-shown")
  M.play(5)
  checkpoint("notice-expired")
  local opening_osd = 0
  for _, m in ipairs(M.osd_messages) do
    if m.text == "Opening next episode" then opening_osd = opening_osd + 1 end
  end
  result.openingOsdMessages = opening_osd
elseif scenario == "eof-premature" or scenario == "eof-premature-autoplay" then
  -- P6 (#25): the demuxer hits a partial segment at media 145.9 of a 720 s
  -- episode. mpv (keep-open) reports EOF, seeks to the last frame and the
  -- time-pos jumps 145.9 -> 720 while paused at eof. This is not the end of
  -- the episode; nothing may open the next one.
  boot_episode_end(140, scenario == "eof-premature")
  M.play(30, nil, function() return (M.props["time-pos"] or 0) >= 145.9 end)
  checkpoint("before-eof")
  M.set_prop("pause", true)
  M.set_prop("eof-reached", true)
  M.set_prop("time-pos", 720)
  M.play(10)
  checkpoint("after-eof")
  result.nextEpisodeRequests = next_episode_requests()
elseif scenario == "eof-natural" or scenario == "eof-natural-autoplay-off" then
  -- Control: the episode plays to its real end, so the next one opens; with
  -- autoplay off (PLAY-NEXT-01) it does not, even with auto-skip on.
  if scenario == "eof-natural" then
    boot_episode_end(700, false)
  else
    boot_episode_end(700, true, false)
  end
  M.play(30, nil, function() return (M.props["time-pos"] or 0) >= 719.97 end)
  M.set_prop("pause", true)
  M.set_prop("eof-reached", true)
  M.set_prop("time-pos", 720)
  M.play(2)
  checkpoint("after-eof")
  result.nextEpisodeRequests = next_episode_requests()
elseif scenario == "eof-seek-in-credits" then
  -- Control: the next-episode pill is already up (last 15 s) and the user
  -- presses RIGHT (+10 s) past the end. That jump into the end is the user's
  -- choice, so the next episode still opens.
  boot_episode_end(708, false)
  M.play(3)
  checkpoint("before-seek")
  M.set_prop("pause", true)
  M.set_prop("eof-reached", true)
  M.set_prop("time-pos", 720)
  M.play(2)
  checkpoint("after-eof")
  result.nextEpisodeRequests = next_episode_requests()
elseif scenario == "credits-autoplay-off" then
  -- PLAY-NEXT-01: autoplay of the next episode switched off in Settings, the
  -- credits marker carries autoSkip (creditsSkipEnabled on). The credits pill
  -- is "Next episode": it stays a tap target and never starts it by itself.
  boot(597, { CREDITS }, { id = "episode-2", label = "Episode 2" }, false)
  M.play(20)
  checkpoint("credits+17s")
  result.nextEpisodeRequestsBeforeClick = next_episode_requests()
  M.script_message("sf-skip-confirm")
  M.play(0.5)
  checkpoint("after-click")
  result.nextEpisodeRequests = next_episode_requests()
elseif scenario == "credits-last-episode-autoplay-off" then
  -- Control: no next episode (last one), so the credits pill is "Skip
  -- credits", which never fires by itself either (PLAY-SKIP-02).
  boot(597, { CREDITS }, nil, false)
  M.play(30, nil, first_fire)
  checkpoint("after-wait")
  result.nextEpisodeRequests = next_episode_requests()
else
  error("unknown scenario " .. scenario)
end

checkpoint("end")
print("RESULT " .. M.json.encode(result))
