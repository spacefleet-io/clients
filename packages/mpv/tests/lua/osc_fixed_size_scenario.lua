-- MPV-OSC-05 unit scenarios, printing one machine-readable line: RESULT {...}
--   * fit <tog4in1.lua>  : runs tog4in1's REAL sf_fit_controls (cut out of the
--                          script: it needs no mpv) for a grid of window sizes
--                          and display scales, in tog4in1's layout units
--                          (2 OSD px per unit x display-hidpi-scale).
--   * text-scale <sf.lua>: loads the REAL sf.lua under mp_mock.lua and reports
--                          the sub-scale / osd-scale it sets per subtitle
--                          codec, display scale and window size.
-- Usage: <lua> osc_fixed_size_scenario.lua <scenario> <script.lua>

local here = arg[0]:match("^(.*)[/\\]") or "."
package.path = here .. "/?.lua;" .. package.path
local M = require("mp_mock")

local scenario, script = arg[1], arg[2]
assert(scenario and script, "usage: osc_fixed_size_scenario.lua <fit|text-scale> <script.lua>")

local WINDOWS = { {1920, 1080}, {1600, 900}, {1280, 720}, {960, 540}, {640, 360}, {480, 270}, {320, 180}, {240, 135} }
local SCALES = { 1, 1.25, 1.5, 2 }
local result = { scenario = scenario, cases = {} }

if scenario == "fit" then
  local f = assert(io.open(script, "r"))
  local src = f:read("*a")
  f:close()
  local from = assert(src:find("\nSF_FIT = {", 1, true), "SF_FIT not found in tog4in1.lua")
  local fn_at = assert(src:find("\nfunction sf_fit_controls(", from, true), "sf_fit_controls not found")
  local to = assert(src:find("\nend\n", fn_at, true), "end of sf_fit_controls not found")
  local chunk = assert((loadstring or load)(src:sub(from + 1, to + 4)))
  chunk()
  for _, win in ipairs(WINDOWS) do
    for _, hidpi in ipairs(SCALES) do
      for _, chapters in ipairs({ false, true }) do
        -- the window is win points = win * hidpi OSD px, and a layout unit is
        -- 2 * hidpi OSD px: the same units at every display scale
        local w, h = win[1] * hidpi / (2 * hidpi), win[2] * hidpi / (2 * hidpi)
        local fit = sf_fit_controls(w, h, chapters)
        result.cases[#result.cases + 1] = {
          window = win[1] .. "x" .. win[2], hidpi = hidpi, chapters = chapters, w = w, h = h,
          shown = fit.shown, timecodes = fit.timecodes, band = fit.band, title = fit.title,
          centre = fit.centre, centreY = fit.centreY, episodes = fit.episodes,
        }
      end
    end
  end
  result.fit = SF_FIT
  result.drop_order = SF_FIT_DROP_ORDER
  result.right_group = SF_FIT_RIGHT_GROUP
elseif scenario == "text-scale" then
  M.load(script, { path = "/media/movie.mkv", duration = 1200, pause = true, speed = 1, ["track-list"] = {} })
  for _, codec in ipairs({ "subrip", "webvtt", "ass", "ssa" }) do
    M.set_prop("current-tracks/sub/codec", codec)
    for _, hidpi in ipairs(SCALES) do
      for _, win in ipairs(WINDOWS) do
        M.set_prop("osd-width", win[1] * hidpi)
        M.set_prop("osd-height", win[2] * hidpi)
        M.set_prop("display-hidpi-scale", hidpi)
        result.cases[#result.cases + 1] = {
          window = win[1] .. "x" .. win[2], hidpi = hidpi, codec = codec,
          sub_scale = M.props["sub-scale"], osd_scale = M.props["osd-scale"],
        }
      end
    end
  end
else
  error("unknown scenario " .. scenario)
end

print("RESULT " .. M.json.encode(result))
