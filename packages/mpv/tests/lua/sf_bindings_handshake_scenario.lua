-- Drives sf.lua under the mocked mp runtime (mp_mock.lua) for the #25
-- sf-bindings-ready handshake and prints one machine-readable line: RESULT {...}
--   * late-listener : tog4in1 registers after sf.lua's one-shot broadcast and
--                     asks with sf-bindings-query; sf.lua must answer.
--   * early-query   : tog4in1 asks before sf.lua's bindings are live; sf.lua
--                     must not claim ready early, and broadcasts once they are.
-- Usage: <lua> sf_bindings_handshake_scenario.lua <path/to/sf.lua> <scenario>

local here = arg[0]:match("^(.*)[/\\]") or "."
package.path = here .. "/?.lua;" .. package.path
local M = require("mp_mock")

local sf_path, scenario = arg[1], arg[2]
assert(sf_path and scenario, "usage: sf_bindings_handshake_scenario.lua <sf.lua> <scenario>")

local result = { scenario = scenario }

local function readies()
  local n = 0
  for _, c in ipairs(M.commands) do
    if c[1] == "script-message" and c[2] == "sf-bindings-ready" then n = n + 1 end
  end
  return n
end

-- mp.defaults runs idle handlers after every event-loop pass; one pass here.
local function run_idle()
  local pending = {}
  for i, fn in ipairs(M.idle) do pending[i] = fn end
  for _, fn in ipairs(pending) do fn() end
end

-- A broadcast script-message nobody registered is silently dropped by mpv.
local function query()
  print("[handshake] tog4in1 -> sf-bindings-query")
  if M.script_messages["sf-bindings-query"] == nil then
    print("[handshake] no sf-bindings-query handler in sf.lua; message dropped")
    return
  end
  M.script_message("sf-bindings-query")
end

M.load(sf_path, { path = "/media/episode-1.mkv", duration = 1200, pause = true, speed = 1, ["track-list"] = {} })

if scenario == "late-listener" then
  run_idle()
  result.after_broadcast = readies()
  query()
  result.after_query = readies()
elseif scenario == "early-query" then
  query()
  result.after_early_query = readies()
  run_idle()
  result.after_idle = readies()
  run_idle()
  result.after_second_idle = readies()
else
  error("unknown scenario " .. scenario)
end

print("RESULT " .. M.json.encode(result))
