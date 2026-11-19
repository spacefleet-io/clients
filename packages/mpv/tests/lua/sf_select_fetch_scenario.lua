-- Drives sf-select.lua's "Get more subtitles…" row and the subtitle-fetch views
-- (PLAY-SUBGET-02) under the mocked mp runtime (mp_mock.lua) and prints one
-- machine-readable line: RESULT {...}
-- Usage: <lua> sf_select_fetch_scenario.lua <path/to/sf-select.lua> <scenario>

local here = arg[0]:match("^(.*)[/\\]") or "."
package.path = here .. "/?.lua;" .. package.path
local M = require("mp_mock")

local select_path, scenario = arg[1], arg[2]
assert(select_path and scenario, "usage: sf_select_fetch_scenario.lua <sf-select.lua> <scenario>")

local result = { scenario = scenario }
local FRENCH = { id = 1, type = "sub", external = true, title = "French", lang = "fr", selected = true }

local function boot(tracks, sid, label, version, add_file, off)
  M.load(select_path, { ["track-list"] = tracks, sid = sid, ["secondary-sid"] = false })
  if label or add_file then
    M.script_message("sf-labels-json", M.json.encode({
      subtitlesOff = off or "Off",
      getMoreSubtitles = label,
      tryAnotherVersion = version,
      addSubtitleFile = add_file,
    }))
  end
end

local function open_menu()
  local before = #M.menus
  M.key_bindings["select-sid"].fn()
  if #M.menus == before then return nil end
  return M.menus[#M.menus]
end

local function sent(channel)
  local out = {}
  for _, c in ipairs(M.commands) do
    if c[1] == "script-message" and c[2] == channel then
      local args = {}
      for i = 3, #c do args[#args + 1] = c[i] end
      out[#out + 1] = args
    end
  end
  return out
end

local function view(payload)
  M.script_message("sf-subtitle-fetch-json", M.json.encode(payload))
end

-- The panel overlay is the one sf-select.lua creates (the only ass-events overlay).
local function panel()
  for _, overlay in ipairs(M.overlays) do
    if overlay.format == "ass-events" then return overlay.data end
  end
  return nil
end

if scenario == "row" then
  boot({ FRENCH }, 1, "Get more subtitles…")
  local menu = open_menu()
  result.items = menu.items
  menu.submit(#menu.items)
  result.fetch = sent("sf-subtitle-fetch")
  result.picks = sent("sf-track-picked")
  result.sid = M.props.sid
elseif scenario == "row-hidden" then
  boot({ FRENCH }, 1, nil)
  result.items = open_menu().items
elseif scenario == "row-cleared" then
  boot({ FRENCH }, 1, "Get more subtitles…")
  M.script_message("sf-labels-json", M.json.encode({ subtitlesOff = "Off", getMoreSubtitles = "" }))
  result.items = open_menu().items
elseif scenario == "no-tracks" then
  -- PLAY-SUBGET-24: the subtitles button opens the menu (Off, then the get-more row), searching nothing until the row is picked.
  boot({}, false, "Weitere Untertitel suchen…")
  local menu = open_menu()
  result.items = menu and menu.items or nil
  result.warned = #M.osd_messages
  result.fetch_on_open = sent("sf-subtitle-fetch")
  if menu then menu.submit(#menu.items) end
  result.fetch = sent("sf-subtitle-fetch")
elseif scenario == "no-tracks-no-label" then
  -- Chris 2026-11-18: nothing to search (no catalog id) and no track; the button still opens the menu, Off alone.
  boot({}, false, nil)
  M.props["vo-configured"] = true
  local menu = open_menu()
  result.items = menu and menu.items or nil
  result.warned = #M.osd_messages
  if menu then menu.submit(1) end
  result.fetch = sent("sf-subtitle-fetch")
  result.picks = sent("sf-track-picked")
elseif scenario == "no-tracks-both-rows" then
  -- PLAY-SUBGET-24/-23 (Chris 2026-11-18): no track, the menu offers Off, Get more, then Add a subtitle file.
  boot({}, false, "Get more subtitles…", nil, "Add a subtitle file…")
  M.props["vo-configured"] = true
  local menu = open_menu()
  result.items = menu and menu.items or nil
  result.warned = #M.osd_messages
  result.fetch_on_open = sent("sf-subtitle-fetch")
elseif scenario == "no-tracks-both-rows-fr" then
  boot({}, false, "Chercher d'autres sous-titres…", nil, "Ajouter un fichier de sous-titres…", "Désactivés")
  M.props["vo-configured"] = true
  local menu = open_menu()
  result.items = menu and menu.items or nil
elseif scenario == "add-file-row" then
  -- PLAY-SUBGET-23: the last row asks the app for the file picker and changes no track.
  boot({ FRENCH }, 1, "Get more subtitles…", "Try another version", "Add a subtitle file…")
  local menu = open_menu()
  result.items = menu.items
  menu.submit(#menu.items)
  result.fetch = sent("sf-subtitle-fetch")
  result.picks = sent("sf-track-picked")
  result.sid = M.props.sid
elseif scenario == "add-file-alone" then
  -- No catalog id and no title search possible: Add a subtitle file still shows, Get more does not.
  boot({}, false, nil, nil, "Add a subtitle file…")
  M.props["vo-configured"] = true
  local menu = open_menu()
  result.items = menu and menu.items or nil
  if menu then menu.submit(#menu.items) end
  result.fetch = sent("sf-subtitle-fetch")
elseif scenario == "title-field" then
  -- PLAY-SUBGET-24: no catalog id, the app asks which film or show this is; Enter sends the typed title.
  boot({}, false, "Get more subtitles…")
  view({ title = { prompt = "Which film or show is this?", field = "Title", query = "Alien" } })
  local field = M.inputs[#M.inputs]
  result.prompt = field.prompt
  result.default_text = field.default_text
  result.cursor = field.cursor_position
  field.submit("Aliens")
  field.closed()
  result.fetch = sent("sf-subtitle-fetch")
  result.terminated = M.input_terminated
elseif scenario == "title-cancel" then
  boot({}, false, "Get more subtitles…")
  view({ panel = "Looking for this title…", dismissable = true })
  view({ title = { prompt = "Which film or show is this?", field = "Title", query = "Alien" } })
  result.after = panel()
  M.inputs[#M.inputs].closed()
  result.fetch = sent("sf-subtitle-fetch")
elseif scenario == "version-row" then
  boot({ FRENCH }, 1, "Get more subtitles…", "Try another version")
  local menu = open_menu()
  result.items = menu.items
  menu.submit(#menu.items)
  result.fetch = sent("sf-subtitle-fetch")
  result.picks = sent("sf-track-picked")
  result.sid = M.props.sid
elseif scenario == "version-row-off" then
  local french = { id = 1, type = "sub", external = true, title = "French", lang = "fr", selected = false }
  boot({ french }, false, "Get more subtitles…", "Try another version")
  result.items = open_menu().items
elseif scenario == "version-row-cleared" then
  boot({ FRENCH }, 1, "Get more subtitles…", "Try another version")
  M.script_message("sf-labels-json", M.json.encode({ subtitlesOff = "Off", tryAnotherVersion = "" }))
  result.items = open_menu().items
elseif scenario == "list-pick" then
  boot({ FRENCH }, 1, "Get more subtitles…")
  view({ list = { prompt = "Pick a language", items = { { key = "en|plain|", label = "English" }, { key = "es|plain|", label = "Spanish" } } } })
  local menu = M.menus[#M.menus]
  result.prompt = menu.prompt
  result.items = menu.items
  menu.submit(2)
  menu.closed()
  result.fetch = sent("sf-subtitle-fetch")
elseif scenario == "list-cancel" then
  boot({ FRENCH }, 1, "Get more subtitles…")
  view({ list = { prompt = "Pick a language", items = { { key = "en|plain|", label = "English" } } } })
  M.menus[#M.menus].closed()
  result.fetch = sent("sf-subtitle-fetch")
elseif scenario == "panel-dismiss" then
  boot({ FRENCH }, 1, "Get more subtitles…")
  view({ panel = "Looking for subtitles…", dismissable = true })
  result.shown = panel()
  result.escape = M.key_bindings["sf-subtitle-fetch-dismiss"] and M.key_bindings["sf-subtitle-fetch-dismiss"].key or nil
  M.key_bindings["sf-subtitle-fetch-dismiss"].fn()
  result.after = panel()
  result.fetch = sent("sf-subtitle-fetch")
  result.bound = M.key_bindings["sf-subtitle-fetch-dismiss"] ~= nil
elseif scenario == "panel-busy" then
  boot({ FRENCH }, 1, "Get more subtitles…")
  view({ panel = "Looking for subtitles…", dismissable = true })
  view({ panel = "Saving to your media library {now}", dismissable = false })
  result.shown = panel()
  result.bound = M.key_bindings["sf-subtitle-fetch-dismiss"] ~= nil
  view({ close = true })
  result.after = panel()
  result.fetch = sent("sf-subtitle-fetch")
elseif scenario == "panel-wrap" then
  boot({ FRENCH }, 1, "Get more subtitles…")
  view({ panel = "Something went wrong getting these subtitles. We're working on it and it should be back soon.", dismissable = true })
  result.shown = panel()
else
  error("unknown scenario " .. scenario)
end

print("RESULT " .. M.json.encode(result))
