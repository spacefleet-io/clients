-- Drives sf.lua under the mocked mp runtime (mp_mock.lua): a file loads and its
-- video-params arrive while mpv is fullscreen (launched with --fullscreen, or
-- toggled before an ABR reload), replayed from macos-ultimate replay 34521
-- (mpv-2-1794821850150.log L1678-2010). Records every window-geometry property
-- sf.lua sets in each phase.
-- Prints one machine-readable line: RESULT {...}
-- Usage: <lua> sf_fullscreen_geometry_scenario.lua <path/to/sf.lua>
local here = arg[0]:match("^(.*)[/\\]") or "."
package.path = here .. "/?.lua;" .. package.path
local M = require("mp_mock")
local sf_path = arg[1]
assert(sf_path, "usage: sf_fullscreen_geometry_scenario.lua <sf.lua>")
local GEOMETRY_PROPS = { geometry = true, autofit = true, ["autofit-larger"] = true, ["autofit-smaller"] = true, ["keepaspect-window"] = true }
local cursor = 1
local function window_sets()
  local out = {}
  for i = cursor, #M.property_sets do
    local s = M.property_sets[i]
    if GEOMETRY_PROPS[s.name] then out[#out + 1] = s.name .. "=" .. tostring(s.value) end
  end
  cursor = #M.property_sets + 1
  return out
end
local result = { phases = {} }
local function phase(name)
  M.play(0.5)
  result.phases[#result.phases + 1] = { phase = name, fullscreen = M.props.fullscreen == true, sets = window_sets() }
end
M.load(sf_path, { fullscreen = true, geometry = "70%x70%", pause = false, ["time-pos"] = 0 })
window_sets()
M.fire_event("file-loaded")
phase("file-loaded while fullscreen")
M.set_prop("video-params", { w = 1920, h = 1080 })
phase("video-params while fullscreen")
M.set_prop("fullscreen", false)
window_sets()
M.fire_event("file-loaded")
phase("file-loaded windowed")
print("RESULT " .. M.json.encode(result))
