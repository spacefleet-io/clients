-- Mocked mpv scripting runtime for driving resources/osc/sf.lua from a plain
-- Lua interpreter (LuaJIT / Lua 5.1, the dialect mpv embeds).
--
-- Clocks are fully simulated and independent:
--   * wall clock  : mp.get_time(), timers (add_periodic_timer / add_timeout)
--   * media clock : the "time-pos" property, advanced by M.play() at the
--                   configured "speed" only while "pause" is false.
-- Property observers fire synchronously when a value changes, which is how
-- mpv's observe_property behaves from the script's point of view (one call
-- per change, delivered between event-loop iterations).
--
-- Every msg.* line, osd_message and command is echoed to stdout with the
-- current wall/media clocks so a failing scenario is diagnosable from the
-- test log alone.

local M = {
  wall = 0,
  props = {},
  observers = {},
  timers = {},
  script_messages = {},
  events = {},
  key_bindings = {},
  osd_messages = {},
  commands = {},
  property_sets = {},
  menus = {},
  inputs = {},
  input_terminated = 0,
  overlays = {},
  log_lines = {},
}

local function fmt_clock()
  local tp = M.props["time-pos"]
  return string.format("[wall=%7.3f media=%s]", M.wall, type(tp) == "number" and string.format("%8.3f", tp) or "     nil")
end

function M.log(line)
  local entry = fmt_clock() .. " " .. line
  M.log_lines[#M.log_lines + 1] = entry
  print(entry)
end

-- ---------------------------------------------------------------------------
-- Minimal JSON (decode objects/arrays/strings/numbers/bools/null; encode the
-- flat tables sf.lua emits). Enough for apply_playback_json/emit_pill_state.
-- ---------------------------------------------------------------------------
local json = {}

function json.decode(s)
  local pos = 1
  local function ws()
    pos = s:find("[^ \t\r\n]", pos) or (#s + 1)
  end
  local value
  local function str()
    local out = {}
    pos = pos + 1
    while true do
      local c = s:sub(pos, pos)
      if c == "" then error("unterminated string") end
      if c == '"' then pos = pos + 1; break end
      if c == "\\" then
        local n = s:sub(pos + 1, pos + 1)
        local map = { n = "\n", t = "\t", r = "\r", b = "\b", f = "\f" }
        out[#out + 1] = map[n] or n
        pos = pos + 2
      else
        out[#out + 1] = c
        pos = pos + 1
      end
    end
    return table.concat(out)
  end
  function value()
    ws()
    local c = s:sub(pos, pos)
    if c == "{" then
      local obj = {}
      pos = pos + 1
      ws()
      if s:sub(pos, pos) == "}" then pos = pos + 1; return obj end
      while true do
        ws()
        local k = str()
        ws()
        pos = pos + 1 -- ':'
        obj[k] = value()
        ws()
        local d = s:sub(pos, pos)
        pos = pos + 1
        if d == "}" then return obj end
      end
    elseif c == "[" then
      local arr = {}
      pos = pos + 1
      ws()
      if s:sub(pos, pos) == "]" then pos = pos + 1; return arr end
      while true do
        arr[#arr + 1] = value()
        ws()
        local d = s:sub(pos, pos)
        pos = pos + 1
        if d == "]" then return arr end
      end
    elseif c == '"' then
      return str()
    elseif s:sub(pos, pos + 3) == "true" then
      pos = pos + 4; return true
    elseif s:sub(pos, pos + 4) == "false" then
      pos = pos + 5; return false
    elseif s:sub(pos, pos + 3) == "null" then
      pos = pos + 4; return nil
    else
      local num = s:match("^-?%d+%.?%d*[eE]?[-+]?%d*", pos)
      if not num or num == "" then error("bad json at " .. pos) end
      pos = pos + #num
      return tonumber(num)
    end
  end
  return value()
end

function json.encode(v)
  local t = type(v)
  if t == "nil" then return "null" end
  if t == "boolean" then return tostring(v) end
  if t == "number" then return string.format("%.6f", v) end
  if t == "string" then return '"' .. v:gsub('[%c"\\]', function(c) return string.format("\\u%04x", c:byte()) end) .. '"' end
  if t == "table" then
    if #v > 0 then
      local parts = {}
      for _, item in ipairs(v) do parts[#parts + 1] = json.encode(item) end
      return "[" .. table.concat(parts, ",") .. "]"
    end
    local keys = {}
    for k in pairs(v) do keys[#keys + 1] = tostring(k) end
    table.sort(keys)
    local parts = {}
    for _, k in ipairs(keys) do parts[#parts + 1] = json.encode(k) .. ":" .. json.encode(v[k]) end
    return "{" .. table.concat(parts, ",") .. "}"
  end
  return '"<' .. t .. '>"'
end

M.json = json

-- ---------------------------------------------------------------------------
-- mp
-- ---------------------------------------------------------------------------
local mp = {}

local function notify(name)
  for _, fn in ipairs(M.observers[name] or {}) do
    fn(name, M.props[name])
  end
end

function M.set_prop(name, value)
  if M.props[name] == value then
    return
  end
  M.props[name] = value
  notify(name)
end

function mp.get_time() return M.wall end
function mp.get_property(name, def)
  local v = M.props[name]
  if v == nil then return def end
  return tostring(v)
end
function mp.get_property_number(name, def)
  local v = M.props[name]
  if type(v) ~= "number" then return def end
  return v
end
function mp.get_property_bool(name, def)
  local v = M.props[name]
  if type(v) ~= "boolean" then return def end
  return v
end
function mp.get_property_native(name, def)
  local v = M.props[name]
  if v == nil then return def end
  return v
end
function mp.set_property(name, value)
  M.property_sets[#M.property_sets + 1] = { name = name, value = value }
  M.set_prop(name, value)
end
function mp.set_property_native(name, value) M.set_prop(name, value) end
function mp.set_property_bool(name, value) M.set_prop(name, value) end
function mp.set_property_number(name, value) M.set_prop(name, value) end

function mp.observe_property(name, _kind, fn)
  M.observers[name] = M.observers[name] or {}
  table.insert(M.observers[name], fn)
end

function mp.register_event(name, fn)
  M.events[name] = M.events[name] or {}
  table.insert(M.events[name], fn)
end

function mp.register_script_message(name, fn) M.script_messages[name] = fn end
function mp.add_forced_key_binding(key, name, fn) M.key_bindings[name] = { key = key, fn = fn } end
function mp.add_key_binding(key, name, fn) M.key_bindings[name] = { key = key, fn = fn } end
function mp.remove_key_binding(name) M.key_bindings[name] = nil end
-- Idle handlers (sf.lua's one-shot sf-bindings-ready broadcast) are recorded, never run:
-- the scenarios drive time and events directly, there is no idle loop.
M.idle = {}
function mp.register_idle(fn) table.insert(M.idle, fn) end
function mp.unregister_idle(fn)
  for i, f in ipairs(M.idle) do
    if f == fn then table.remove(M.idle, i) return end
  end
end

local function new_timer(interval, fn, periodic)
  local timer = { interval = interval, fn = fn, periodic = periodic, enabled = true, next_at = M.wall + interval }
  function timer:kill() self.enabled = false end
  function timer:stop() self.enabled = false end
  function timer:resume()
    if not self.enabled then
      self.enabled = true
      self.next_at = M.wall + self.interval
    end
  end
  function timer:is_enabled() return self.enabled end
  table.insert(M.timers, timer)
  return timer
end
function mp.add_periodic_timer(interval, fn) return new_timer(interval, fn, true) end
function mp.add_timeout(seconds, fn) return new_timer(seconds, fn, false) end

function mp.osd_message(text, duration)
  M.osd_messages[#M.osd_messages + 1] = { text = text, duration = duration, wall = M.wall }
  M.log("osd_message: " .. tostring(text))
end

function mp.commandv(...)
  local args = { ... }
  M.commands[#M.commands + 1] = args
  if args[1] == "seek" and args[3] == "absolute" then
    M.log("command: seek " .. tostring(args[2]))
    M.set_prop("time-pos", tonumber(args[2]))
  elseif args[1] == "script-message" and args[2] == "sf-pill-state" then
    M.pill_emits = (M.pill_emits or 0) + 1
    M.last_pill_state = json.decode(args[3])
  elseif args[1] == "sub-add" then
    -- Like mpv: the external track joins track-list (observers fire).
    M.log("command: " .. table.concat(args, " "))
    local list = {}
    for i, t in ipairs(M.props["track-list"] or {}) do list[i] = t end
    list[#list + 1] = {
      type = "sub", external = true, ["external-filename"] = args[2],
      title = args[4], lang = args[5], selected = args[3] == "select",
    }
    M.props["track-list"] = list
    notify("track-list")
  elseif args[1] == "cycle" and args[2] == "pause" then
    M.set_prop("pause", not M.props.pause)
  else
    M.log("command: " .. table.concat(args, " "))
  end
end
function mp.command_native() return nil end
function mp.command_native_async() return nil end
function mp.get_osd_size() return 1920, 1080 end
function mp.get_mouse_pos() return -1, -1 end

function mp.create_osd_overlay(format)
  local overlay = { format = format, data = "", res_x = 0, res_y = 0, z = 0, updates = 0 }
  function overlay:update() self.updates = self.updates + 1 end
  function overlay:remove() self.data = "" end
  table.insert(M.overlays, overlay)
  return overlay
end

local msg = {}
for _, level in ipairs({ "fatal", "error", "warn", "info", "verbose", "debug", "trace" }) do
  msg[level] = function(...)
    local parts = {}
    for i = 1, select("#", ...) do parts[#parts + 1] = tostring(select(i, ...)) end
    M.log("msg." .. level .. ": " .. table.concat(parts, " "))
  end
end

local utils = {
  parse_json = function(s)
    local ok, v = pcall(json.decode, s)
    if ok then return v end
    return nil, v
  end,
  format_json = function(v) return json.encode(v) end,
}

local options = { read_options = function() end }

-- mp.input: select() records the menu so a scenario can read its items and
-- submit a row, the way the console's select list does; get() records the text
-- field the same way (submit(text) / closed()).
local input = {
  select = function(opts)
    M.menus[#M.menus + 1] = opts
    M.log("input.select: " .. tostring(opts.prompt) .. " items=" .. table.concat(opts.items or {}, " | "))
  end,
  get = function(opts)
    M.inputs[#M.inputs + 1] = opts
    M.log("input.get: " .. tostring(opts.prompt) .. " default=" .. tostring(opts.default_text))
  end,
  terminate = function()
    M.input_terminated = M.input_terminated + 1
  end,
}

-- ---------------------------------------------------------------------------
-- Driver API
-- ---------------------------------------------------------------------------
function M.load(script_path, initial_props)
  for k, v in pairs(initial_props or {}) do M.props[k] = v end
  -- mpv exposes `mp` (and mp.msg) as globals to every script; sf-select.lua uses
  -- them directly, sf.lua requires them.
  mp.msg = msg
  _G.mp = mp
  package.preload["mp"] = function() return mp end
  package.preload["mp.msg"] = function() return msg end
  package.preload["mp.utils"] = function() return utils end
  package.preload["mp.options"] = function() return options end
  package.preload["mp.input"] = function() return input end
  dofile(script_path)
  M.log("loaded " .. script_path)
end

function M.fire_event(name)
  M.log("event: " .. name)
  for _, fn in ipairs(M.events[name] or {}) do fn({ event = name }) end
end

function M.script_message(name, ...)
  local fn = M.script_messages[name]
  if not fn then error("no script message handler " .. name) end
  fn(...)
end

local function run_due_timers()
  -- Snapshot: callbacks may add timers.
  local list = {}
  for i, t in ipairs(M.timers) do list[i] = t end
  for _, t in ipairs(list) do
    if t.enabled and t.next_at <= M.wall + 1e-9 then
      if t.periodic then
        t.next_at = t.next_at + t.interval
      else
        t.enabled = false
      end
      t.fn()
    end
  end
end

-- Advance the wall clock by `wall_seconds` in `frame` steps. While not paused,
-- time-pos advances by frame*speed per step (observers fire on each change).
-- `on_step` (optional) runs after each step and may return true to stop early.
function M.play(wall_seconds, frame, on_step)
  frame = frame or (1 / 24)
  local steps = math.floor(wall_seconds / frame + 0.5)
  for _ = 1, steps do
    M.wall = M.wall + frame
    if not M.props.pause then
      local speed = M.props.speed or 1
      local tp = M.props["time-pos"] or 0
      M.set_prop("time-pos", tp + frame * speed)
    end
    run_due_timers()
    if on_step and on_step() then
      return true
    end
  end
  return false
end

return M
