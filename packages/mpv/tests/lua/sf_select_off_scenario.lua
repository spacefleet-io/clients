-- Drives sf-select.lua's subtitle menu under the mocked mp runtime (mp_mock.lua)
-- for #25 "cannot turn subtitles off" (Orchard: ONE French subtitle track) and
-- prints one machine-readable line: RESULT {...}
-- Usage: <lua> sf_select_off_scenario.lua <path/to/sf-select.lua> <scenario>

local here = arg[0]:match("^(.*)[/\\]") or "."
package.path = here .. "/?.lua;" .. package.path
local M = require("mp_mock")

local select_path, scenario = arg[1], arg[2]
assert(select_path and scenario, "usage: sf_select_off_scenario.lua <sf-select.lua> <scenario>")

local result = { scenario = scenario }

local FRENCH = { id = 1, type = "sub", external = true, title = "French", lang = "fr" }
local ENGLISH = { id = 2, type = "sub", external = true, title = "English", lang = "en" }

-- A fresh copy of a track with its `selected` flag, as mpv's track-list reports it.
local function track(base, selected)
  local copy = {}
  for k, v in pairs(base) do copy[k] = v end
  copy.selected = selected
  return copy
end

-- sid as mpv reports it: the selected track id, or false when none is selected.
local function boot(tracks, sid)
  M.load(select_path, {
    ["track-list"] = tracks,
    sid = sid,
    ["secondary-sid"] = false,
  })
end

local function open_menu(binding)
  local before = #M.menus
  M.key_bindings[binding or "select-sid"].fn()
  local menu = M.menus[#M.menus]
  if #M.menus == before then return nil end
  return menu
end

local function describe_menu(menu)
  if not menu then return nil end
  return { items = menu.items, default_item = menu.default_item or 0, prompt = menu.prompt }
end

local function picks()
  local out = {}
  for _, c in ipairs(M.commands) do
    if c[1] == "script-message" and c[2] == "sf-track-picked" then
      out[#out + 1] = { c[3], c[4] }
    end
  end
  return out
end

local function sid_sets()
  local n = 0
  for _, set in ipairs(M.property_sets) do
    if set.name == "sid" then n = n + 1 end
  end
  return n
end

if scenario == "single-selected" then
  -- Orchard: one French subtitle, selected by default.
  boot({ track(FRENCH, true) }, 1)
  local menu = open_menu()
  result.menu = describe_menu(menu)
  menu.submit(1) -- the Off row
  result.sid = M.props.sid
  result.picks = picks()
elseif scenario == "single-off" then
  -- Subtitles off (off by default, or after Off): the Off row is current.
  boot({ track(FRENCH, false) }, false)
  local menu = open_menu()
  result.menu = describe_menu(menu)
elseif scenario == "off-then-track" then
  -- Off, then the track again: submitting the track turns it back on.
  boot({ track(FRENCH, false) }, false)
  local menu = open_menu()
  menu.submit(2)
  result.sid = M.props.sid
  result.picks = picks()
elseif scenario == "reselect-current" then
  -- Submitting the track that is already on keeps it on (it is not a toggle) and
  -- does not re-set sid, which would make mpv refresh-seek.
  boot({ track(FRENCH, true) }, 1)
  local menu = open_menu()
  menu.submit(2)
  result.sid = M.props.sid
  result.sidSets = sid_sets()
  result.picks = picks()
elseif scenario == "off-when-already-off" then
  boot({ track(FRENCH, false) }, false)
  local menu = open_menu()
  menu.submit(1)
  result.sidSets = sid_sets()
  result.picks = picks()
elseif scenario == "two-tracks" then
  boot({ track(FRENCH, false), track(ENGLISH, true) }, 2)
  local menu = open_menu()
  result.menu = describe_menu(menu)
  menu.submit(1)
  result.sid = M.props.sid
  result.picks = picks()
elseif scenario == "two-tracks-switch" then
  boot({ track(FRENCH, false), track(ENGLISH, true) }, 2)
  local menu = open_menu()
  menu.submit(2) -- French
  result.sid = M.props.sid
  result.picks = picks()
elseif scenario == "label-fr" then
  boot({ track(FRENCH, true) }, 1)
  M.script_message("sf-labels-json", M.json.encode({ subtitlesOff = "Aucun" }))
  result.menu = describe_menu(open_menu())
elseif scenario == "label-garbage" then
  boot({ track(FRENCH, true) }, 1)
  M.script_message("sf-labels-json", "{not json")
  M.script_message("sf-labels-json", M.json.encode({ subtitlesOff = "" }))
  result.menu = describe_menu(open_menu())
elseif scenario == "no-tracks" then
  boot({}, false)
  result.menu = describe_menu(open_menu())
  result.warned = #M.osd_messages
elseif scenario == "audio-keeps-toggle" then
  -- aid menu: no Off row, submitting the selected track still turns it off.
  boot({ { id = 1, type = "audio", selected = true, lang = "en", title = "English" } }, false)
  M.props.aid = 1
  local menu = open_menu("select-aid")
  result.menu = describe_menu(menu)
  menu.submit(1)
  result.aid = M.props.aid
  result.picks = picks()
elseif scenario == "prompts-default" or scenario == "prompts-fr" then
  -- The menus' prompts come from sf-labels-json in the UI language; English until it arrives.
  boot({ track(FRENCH, true), { id = 1, type = "audio", selected = true, lang = "en", title = "English" } }, 1)
  M.props.aid = 1
  if scenario == "prompts-fr" then
    M.script_message("sf-labels-json", M.json.encode({
      subtitlesOff = "Aucun",
      selectSubtitle = "Choisir des sous-titres :",
      selectAudioTrack = "Choisir une piste audio :",
      noVideoTracks = "Aucune piste vidéo disponible.",
    }))
    -- A later payload without the prompts (the online/offline re-send) keeps them.
    M.script_message("sf-labels-json", M.json.encode({ subtitlesOff = "Aucun", getMoreSubtitles = "", selectAudioTrack = "" }))
  end
  result.subPrompt = open_menu("select-sid").prompt
  result.audioPrompt = open_menu("select-aid").prompt
  M.props["vo-configured"] = true -- the warning reaches the OSD only with a video output
  open_menu("select-vid") -- no video track: the empty-state line instead of a menu
  result.osd = M.osd_messages
else
  error("unknown scenario " .. scenario)
end

print("RESULT " .. M.json.encode(result))
