-- Drives sf.lua's frozen-audio notice (MPV-AUDIO-01) under the mocked mp
-- runtime (mp_mock.lua) and prints one machine-readable line: RESULT {...}
--   * notice : sf-audio-stall stalled -> the "Retry with sound" pill with the
--              explanation; Enter sends sf-audio-retry and hides it; cleared
--              from the app hides it too.
-- Usage: <lua> sf_audio_stall_scenario.lua <path/to/sf.lua> <scenario>

local here = arg[0]:match("^(.*)[/\\]") or "."
package.path = here .. "/?.lua;" .. package.path
local M = require("mp_mock")

local sf_path, scenario = arg[1], arg[2]
assert(sf_path and scenario, "usage: sf_audio_stall_scenario.lua <sf.lua> <scenario>")

local result = { scenario = scenario, checkpoints = {} }

local function retries()
  local n = 0
  for _, c in ipairs(M.commands) do
    if c[1] == "script-message" and c[2] == "sf-audio-retry" then n = n + 1 end
  end
  return n
end

local function checkpoint(label)
  local state = M.last_pill_state or {}
  local overlay = M.overlays[1]
  local entry = {
    label = label,
    active = state.active == true,
    kind = state.kind,
    label_text = state.label,
    overlay = overlay and overlay.data or "",
    retries = retries(),
  }
  M.log(string.format("[sf-audio-stall-scenario] checkpoint %s active=%s kind=%s retries=%d overlay=%s",
    label, tostring(entry.active), tostring(entry.kind), entry.retries, entry.overlay:gsub("\n", " | ")))
  result.checkpoints[#result.checkpoints + 1] = entry
end

M.load(sf_path, {
  path = "/media/movie.mkv",
  duration = 1200,
  pause = false,
  speed = 1,
  ["track-list"] = {},
})
M.fire_event("start-file")
M.fire_event("file-loaded")
M.set_prop("time-pos", 30)
M.script_message("sf-playback-json", M.json.encode({ markers = {}, autoplayNextEpisode = true, autoSkipNextEpisode = false }))
M.play(1)
checkpoint("playing")

if scenario == "notice" then
  M.script_message("sf-audio-stall", M.json.encode({ state = "stalled", output = "pipewire", device = "WH-1000XM4 (pipewire/bluez_output.AC_80_0A)" }))
  checkpoint("stalled")
  -- The video keeps playing without sound: the notice stays up.
  M.play(5)
  checkpoint("playing silent")
  M.key_bindings["sf-toggle-pause-enter"].fn()
  M.play(0.5)
  checkpoint("after Enter")
  result.pausedAfterEnter = M.props.pause == true
  M.play(3)
  checkpoint("after retry notice")
  -- Stalled again (device still dead), then the app clears it (user picked a track).
  M.script_message("sf-audio-stall", M.json.encode({ state = "stalled", output = "pipewire", device = "auto (system default output)" }))
  checkpoint("stalled again")
  M.script_message("sf-audio-stall", M.json.encode({ state = "cleared" }))
  M.play(0.5)
  checkpoint("cleared")
elseif scenario == "no-output-translated" then
  -- MPV-AUDIO-02: no sound output could be opened, French UI. The labels
  -- arrive with the playback metadata, before any notice.
  M.script_message("sf-labels-json", M.json.encode({
    subtitlesOff = "Aucun",
    audioRetry = "Réessayer avec le son",
    audioRetrying = "Nouvel essai avec le son",
    audioStallExplanation = "Le périphérique audio ne répond pas.",
    audioNoOutputExplanation = "Aucune sortie audio n'a pu être ouverte.",
    audioOutputLabel = "Sortie audio :",
  }))
  M.script_message("sf-audio-stall", M.json.encode({ state = "stalled", reason = "no-output", output = "null", device = "auto (system default output)" }))
  checkpoint("no output")
  M.key_bindings["sf-toggle-pause-enter"].fn()
  M.play(0.5)
  checkpoint("after Enter")
  M.play(3)
  -- A frozen clock later in the same session shows its own explanation.
  M.script_message("sf-audio-stall", M.json.encode({ state = "stalled", output = "wasapi", device = "Casque" }))
  checkpoint("frozen")
else
  error("unknown scenario " .. scenario)
end

print("RESULT " .. M.json.encode(result))
