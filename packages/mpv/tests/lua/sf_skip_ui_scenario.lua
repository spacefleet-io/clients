-- Drives sf.lua's skip UI (PLAY-SKIP-03/04/05/10) under the mocked mp runtime
-- (mp_mock.lua): the "Was it right?" line after an intro skip, the Change
-- times panel, the save-scope step and the control bar's skip menu. Prints one
-- machine-readable line:
--   RESULT {"scenario":...,"edits":[[...args]],"checkpoints":[...],"menus":[...]}
-- Usage: <lua> sf_skip_ui_scenario.lua <path/to/sf.lua> <scenario>
-- Scenarios: asked-yes | asked-timeout | change-save | change-cancel |
--            menu-without-times | menu-with-times | asked-french

local here = arg[0]:match("^(.*)[/\\]") or "."
package.path = here .. "/?.lua;" .. package.path
local M = require("mp_mock")

local sf_path, scenario = arg[1], arg[2]
assert(sf_path and scenario, "usage: sf_skip_ui_scenario.lua <sf.lua> <scenario>")

local result = { scenario = scenario, edits = {}, checkpoints = {}, menus = {} }

-- The skip UI's own overlay (z 1001) and the pill's (the first one created).
local function skip_overlay()
  for _, o in ipairs(M.overlays) do
    if o.z == 1001 then return o.data end
  end
  return ""
end

local function pill_overlay()
  local o = M.overlays[1]
  return o and o.data or ""
end

local function checkpoint(label)
  local entry = {
    label = label,
    media = M.props["time-pos"],
    paused = M.props.pause == true,
    skip = skip_overlay(),
    pill = pill_overlay(),
  }
  result.checkpoints[#result.checkpoints + 1] = entry
  M.log(string.format("checkpoint %s media=%s paused=%s skip=%q", label, tostring(entry.media), tostring(entry.paused), entry.skip))
end

-- Every sf-skip-edit the renderer would receive.
local base_commandv = nil
local function record_edits()
  local commandv = _G.mp.commandv
  base_commandv = commandv
  _G.mp.commandv = function(...)
    local args = { ... }
    if args[1] == "script-message" and args[2] == "sf-skip-edit" then
      local edit = {}
      for i = 3, #args do edit[#edit + 1] = args[i] end
      result.edits[#result.edits + 1] = edit
    end
    return base_commandv(...)
  end
end

-- Click the skip UI where `label` is drawn: the ASS text's \pos is the button's
-- centre, in the overlay's logical px (display scale 1, so OSD px too).
local function click_label(label)
  local data = skip_overlay()
  local at = data:find("}" .. label, 1, true)
  assert(at, "label not drawn: " .. label .. " in " .. data)
  local before = data:sub(1, at)
  local x, y
  for px, py in before:gmatch("\\pos%(([%d%.%-]+),([%d%.%-]+)%)") do x, y = tonumber(px), tonumber(py) end
  assert(x and y, "no position for " .. label)
  M.log(string.format("click %q at %.1f,%.1f", label, x, y))
  _G.mp.get_mouse_pos = function() return x, y end
  local click = M.key_bindings["sf-pill-click"]
  click.fn({ event = "down" })
  click.fn({ event = "up" })
end

local function key(name)
  local binding = M.key_bindings[name]
  assert(binding, "no key binding " .. name)
  M.log("key " .. name)
  binding.fn()
end

-- Detected times the app is unsure of: the skip is followed by "Was it right?" (marker.ask).
local INTRO = { type = "intro", startSeconds = 60, endSeconds = 150, autoSkip = true, ask = true }
local SURE_INTRO = { type = "intro", startSeconds = 60, endSeconds = 150, autoSkip = true }
local ASK_CREDITS = { type = "credits", startSeconds = 1100, endSeconds = 1190, ask = true }
local CREDITS = { type = "credits", startSeconds = 1100, endSeconds = 1190, autoSkip = true }

local function boot(start_pos, markers, skip_labels)
  M.load(sf_path, { path = "/media/episode-1.mkv", duration = 1200, pause = false, speed = 1 })
  record_edits()
  M.fire_event("start-file")
  M.fire_event("file-loaded")
  if skip_labels then
    M.script_message("sf-labels-json", M.json.encode({ subtitlesOff = "Off", skip = skip_labels }))
  end
  M.set_prop("time-pos", start_pos)
  M.script_message("sf-playback-json", M.json.encode({
    markers = markers,
    autoplayNextEpisode = true,
    autoSkipNextEpisode = true,
    skipMenu = true,
  }))
end

-- Boot just before the intro and play until it was skipped by itself.
local function skip_intro()
  boot(58, { INTRO })
  M.play(30, nil, function() return (M.props["time-pos"] or 0) >= 150 end)
  M.play(0.3)
end

if scenario == "asked-yes" then
  skip_intro()
  checkpoint("asked")
  click_label("Yes")
  M.play(0.3)
  checkpoint("after-yes")
elseif scenario == "asked-timeout" then
  skip_intro()
  checkpoint("asked")
  M.play(7)
  checkpoint("after-wait")
elseif scenario == "change-save" then
  skip_intro()
  local before = M.props["time-pos"]
  result.returnPos = before
  click_label("Change times")
  checkpoint("panel")
  key("sf-seek-back-10")
  key("sf-seek-back-10")
  checkpoint("nudged")
  key("sf-toggle-pause-enter")
  M.play(0.2)
  M.script_message("sf-skip-edit-json", M.json.encode({ kind = "preselect", scope = "episode" }))
  checkpoint("scope")
  key("sf-toggle-pause-enter")
  M.play(0.2)
  M.script_message("sf-skip-edit-json", M.json.encode({ kind = "saved", scope = "episode" }))
  M.play(0.3)
  checkpoint("saved")
elseif scenario == "change-cancel" then
  skip_intro()
  result.returnPos = M.props["time-pos"]
  click_label("Change times")
  key("sf-seek-forward-10")
  checkpoint("panel")
  key("sf-esc")
  M.play(0.2)
  checkpoint("cancelled")
elseif scenario == "menu-without-times" then
  boot(300, {})
  M.play(0.5)
  M.script_message("sf-skip-menu")
  local menu = M.menus[#M.menus]
  result.menus[#result.menus + 1] = { prompt = menu.prompt, items = menu.items }
  menu.submit(1)
  checkpoint("intro-ends-here")
  key("sf-toggle-pause-enter")
  M.play(0.2)
elseif scenario == "menu-with-times" then
  boot(300, { INTRO, CREDITS })
  M.play(0.5)
  M.script_message("sf-skip-menu")
  local menu = M.menus[#M.menus]
  result.menus[#result.menus + 1] = { prompt = menu.prompt, items = menu.items }
  menu.submit(2)
  checkpoint("change-credits")
elseif scenario == "sure-no-ask" then
  boot(58, { SURE_INTRO })
  M.play(30, nil, function() return (M.props["time-pos"] or 0) >= 150 end)
  M.play(0.3)
  checkpoint("skipped")
elseif scenario == "credits-asked" then
  boot(1101, { ASK_CREDITS })
  M.play(0.5)
  key("sf-toggle-pause-enter")
  M.play(0.3)
  checkpoint("asked")
  click_label("Yes")
  M.play(0.3)
elseif scenario == "asked-french" then
  boot(58, { INTRO }, {
    askedIntro = "Générique passé. C’était bien ?",
    yes = "Oui",
    changeTimes = "Modifier les temps",
  })
  M.play(30, nil, function() return (M.props["time-pos"] or 0) >= 150 end)
  M.play(0.3)
  checkpoint("asked")
else
  error("unknown scenario " .. scenario)
end

checkpoint("end")
print("RESULT " .. M.json.encode(result))
