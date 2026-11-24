-- SpaceBadger mpv OSC tweaks (paired with ModernZ)
local mp = require("mp")
local msg = require("mp.msg")
local utils = require("mp.utils")
local opts = require("mp.options")
local input = require("mp.input")

local user_opts = {
  subtitles = "",
  actions_file = "",
  parent_pid = "",
  parent_pidns = "",
}

opts.read_options(user_opts, "sf")

-- ---------------------------------------------------------------------------
-- Parent-death watchdog (ultimate-stress finding F6, violation `orphan-mpv`).
--
-- The desktop app spawns mpv `detached:true` + unref so mpv is NOT in the
-- Electron process group. If the Electron main process dies by any means
-- (SIGKILL, OOM-kill, crash) nothing tells mpv to stop and a fullscreen player
-- is left orphaned. The app hands us its pid via `--script-opts=sf-parent_pid=<pid>`;
-- we poll that process and quit mpv as soon as it is gone.
--
-- Why polling rather than "quit when the IPC client disconnects": mpv keeps
-- running when IPC clients disconnect, and the app opens short-lived request
-- connections as well as a persistent event socket that legitimately reconnects,
-- so a disconnect is not a reliable parent-death signal.
--
-- Liveness check (a positive "gone" verdict is required before quitting; any
-- inconclusive probe leaves mpv running):
--   * Linux:   /proc/<pid>/stat. Gone = file missing, zombie/dead state, or a
--              different start time than the one captured at load (pid reuse).
--   * macOS / other POSIX: `ps -o stat=,lstart= -p <pid>` (async). Gone =
--              ps reports no such pid, zombie state, or a different lstart.
--   * Windows: not supported; a notice is logged and the watchdog is off.
--
-- Sandboxed mpv (issue #25, @bugfix sf-parent-watchdog-sandboxed-pid-namespace):
-- a SF_MPV_SYSTEM_BIN wrapper such as flatpak/bwrap/firejail can run mpv in
-- its own PID namespace with its own /proc, where the app's pid does not exist
-- (or names an unrelated process). The app also hands us its PID-namespace
-- inode (`sf-parent_pidns`); when ours differs the watchdog is disabled with a
-- warning instead of quitting mpv at start. The sandbox normally tears mpv down
-- with its own lifetime, so orphan protection is the sandbox's job there.
-- ---------------------------------------------------------------------------
local PARENT_WATCHDOG_INTERVAL_S = 0.5

local function parent_stat_linux(pid)
  local f = io.open("/proc/" .. pid .. "/stat", "r")
  if not f then
    return nil
  end
  local line = f:read("*l")
  f:close()
  if not line then
    return nil
  end
  -- "<pid> (<comm>) <state> <ppid> ... <starttime>": comm may contain spaces
  -- and parens, so split after the LAST ")". starttime is field 22 = 20th token
  -- after the ")".
  local rest = line:match("^.*%)%s+(.*)$")
  if not rest then
    return nil
  end
  local fields = {}
  for token in rest:gmatch("%S+") do
    fields[#fields + 1] = token
  end
  return { state = fields[1], start = fields[20] }
end

local function start_parent_watchdog()
  local raw = user_opts.parent_pid
  if raw == nil or raw == "" then
    msg.info("parent-watchdog: disabled (no sf-parent_pid script-opt)")
    return
  end
  local pid = tonumber(raw)
  if not pid or pid < 2 or pid ~= math.floor(pid) then
    msg.warn("parent-watchdog: disabled, invalid sf-parent_pid=" .. tostring(raw))
    return
  end
  pid = math.floor(pid)

  if package.config:sub(1, 1) == "\\" then
    msg.warn("parent-watchdog: unsupported on Windows; mpv will not exit when parent pid " .. pid .. " dies")
    return
  end

  local quit_requested = false
  local function parent_gone(reason)
    if not quit_requested then
      msg.warn("parent-watchdog: parent pid " .. pid .. " is gone (" .. reason .. "); quitting mpv")
    end
    quit_requested = true
    mp.commandv("quit")
  end

  local proc_probe = io.open("/proc/self/stat", "r")
  if proc_probe then
    proc_probe:close()
    local parent_ns = user_opts.parent_pidns
    if parent_ns ~= nil and parent_ns ~= "" then
      -- `readlink` runs in mpv's own PID namespace, so /proc/self/ns/pid there
      -- names the same namespace as mpv's.
      local res = mp.command_native({
        name = "subprocess",
        args = { "readlink", "/proc/self/ns/pid" },
        capture_stdout = true,
        playback_only = false,
      })
      local own_ns = type(res) == "table" and res.status == 0 and (res.stdout or ""):match("^pid:%[(%d+)%]") or nil
      if own_ns == nil then
        msg.warn("parent-watchdog: cannot read own pid namespace; assuming the app's (" .. parent_ns .. ")")
      elseif own_ns ~= parent_ns then
        msg.warn(
          "parent-watchdog: disabled, mpv runs in another PID namespace (mpv "
            .. own_ns
            .. ", app "
            .. parent_ns
            .. "; sandboxed SF_MPV_SYSTEM_BIN?) so app pid "
            .. pid
            .. " is not visible; mpv will not exit by itself when the app dies"
        )
        return
      else
        msg.info("parent-watchdog: same pid namespace as the app (" .. own_ns .. ")")
      end
    end
    local baseline = parent_stat_linux(pid)
    if not baseline then
      parent_gone("already dead at mpv start")
      return
    end
    msg.info("parent-watchdog: watching pid " .. pid .. " via /proc (starttime=" .. tostring(baseline.start) .. ")")
    mp.add_periodic_timer(PARENT_WATCHDOG_INTERVAL_S, function()
      local cur = parent_stat_linux(pid)
      if not cur then
        parent_gone("no /proc entry")
      elseif cur.state == "Z" or cur.state == "X" then
        parent_gone("process state " .. cur.state)
      elseif baseline.start and cur.start ~= baseline.start then
        parent_gone("pid reused, starttime " .. tostring(baseline.start) .. " -> " .. tostring(cur.start))
      end
    end)
    return
  end

  -- macOS / other POSIX: no /proc. `ps` exits 1 with no output for a missing pid.
  local function ps_probe(cb)
    mp.command_native_async({
      name = "subprocess",
      args = { "ps", "-o", "stat=,lstart=", "-p", tostring(pid) },
      capture_stdout = true,
      playback_only = false,
    }, function(success, res)
      if not success or type(res) ~= "table" then
        cb(nil)
        return
      end
      local out = (res.stdout or ""):gsub("^%s+", ""):gsub("%s+$", "")
      if res.status == 1 and out == "" then
        cb({ gone = true })
      elseif res.status == 0 and out ~= "" then
        local state, start = out:match("^(%S+)%s+(.*)$")
        cb({ gone = false, state = state or out, start = start })
      else
        cb(nil) -- ps missing / unexpected failure: inconclusive
      end
    end)
  end

  local baseline = nil
  local probing = false
  msg.info("parent-watchdog: watching pid " .. pid .. " via ps (non-Linux POSIX)")
  mp.add_periodic_timer(PARENT_WATCHDOG_INTERVAL_S, function()
    if probing then
      return
    end
    probing = true
    ps_probe(function(r)
      probing = false
      if r == nil then
        return
      end
      if r.gone then
        parent_gone("ps: no such pid")
      elseif r.state and r.state:sub(1, 1) == "Z" then
        parent_gone("ps: zombie")
      elseif baseline == nil then
        baseline = r.start or ""
      elseif r.start and r.start ~= baseline then
        parent_gone("pid reused, lstart changed")
      end
    end)
  end)
end

start_parent_watchdog()

local function subtitle_exists(url, title, lang)
  local tracks = mp.get_property_native("track-list")
  if type(tracks) ~= "table" then
    return false
  end
  for _, track in ipairs(tracks) do
    if track.type == "sub" then
      local external_name = track["external-filename"]
      if url and external_name == url then
        return true
      end
      if title and track.title == title then
        if not lang or track.lang == lang then
          return true
        end
      end
    end
  end
  return false
end

local added_subtitles = {}

local function subtitle_key(url, title, lang)
  return tostring(url or "") .. "|" .. tostring(title or "") .. "|" .. tostring(lang or "")
end

local function maybe_add_subtitle(url, title, lang, selected)
  if not url or url == "" then
    return
  end
  local key = subtitle_key(url, title, lang)
  if added_subtitles[key] then
    return
  end
  if subtitle_exists(url, title, lang) then
    added_subtitles[key] = true
    return
  end
  added_subtitles[key] = true
  -- "select" forces this sub as the active sid the moment sub-add lands —
  -- BEFORE the first decoded frame — which avoids mpv's mid-stream refresh
  -- seek (the user-visible 1–4s loop near launch). "auto" loads but leaves
  -- sid="no" until the renderer later picks one (which triggers the seek).
  local flag = selected and "select" or "auto"
  mp.commandv("sub-add", url, flag, title or "", lang or "")
end

local playback_state = {
  markers = {},
  next_episode = nil,
  -- The playable episode before this one ({id,label}), for the centre
  -- previous-episode button (PLAY-OVL-03); nil on the first one and on movies.
  previous_episode = nil,
  autoplay_next_episode = true,
  -- Drives the 5s-pre-roll auto-fire for the end-of-media "Next episode" pill
  -- (when no credits marker exists). Set from the desktop's creditsSkipEnabled
  -- toggle. Separate from autoplay_next_episode (which gates the existing
  -- fire-at-0.35s-from-end behavior).
  auto_skip_next_episode = false,
  fallback_countdown_seconds = 15,
  -- Auto-skip bookkeeping: auto_skip_media_elapsed maps marker_key -> MEDIA
  -- seconds played since the pill armed (P22, #25: counted on media time so
  -- pause freezes it and slow playback stretches it), auto_skip_fired maps
  -- marker_key -> true once the skip has fired. Cleared on start-file so a
  -- new episode starts fresh and a manual rewind into a marker won't
  -- re-trigger.
  auto_skip_media_elapsed = {},
  auto_skip_fired = {},
  -- "Mid-marker entry" suppression: when a marker FIRST becomes active, we
  -- check whether the prior time-pos was BEFORE the marker's startSeconds.
  -- If yes (natural progression — user played through the boundary) auto-
  -- skip is allowed to arm. If no (we appeared inside the marker on first
  -- observation — user resumed or seeked into the middle of the marker)
  -- the key is added to auto_skip_suppressed and refresh_pill skips the
  -- arming branch, leaving the pill in manual-click mode. The suppression
  -- is per-marker-activation; once time-pos exits the marker window the
  -- key is cleared so a future natural re-entry re-arms.
  last_time_pos = nil,
  auto_skip_suppressed = {},
  -- Raw JSON of the most recent envelope the desktop sent. Cached so a LATE
  -- `start-file` can't permanently wipe the markers. On the resume / direct-
  -- launch path the renderer sends the envelope BEFORE mpv fires start-file
  -- for the slow-opening HLS stream (observed: envelope at mpv-time 20.2s,
  -- start-file at ~31.5s when the stream finally opened). start-file then
  -- clears playback_state.markers and — without re-application — they're
  -- gone for the whole session (hasMarker never becomes true, no pill, no
  -- auto-skip). The `file-loaded` event (which fires AFTER start-file)
  -- re-applies this cached payload when it finds the markers empty. NOT
  -- cleared on start-file (that would re-lose the bug-case envelope before
  -- file-loaded can restore it); it is naturally overwritten by the next
  -- apply_playback_json the renderer sends for a new episode.
  cached_envelope_payload = nil,
  -- Parsed chapter list the desktop last sent (sf-chapters-json), cached for
  -- the SAME reason as cached_envelope_payload above: a reload's second
  -- start-file wipes pending_chapters, and chapters arrive on a channel whose
  -- re-send can be ignored (already-applied) or land before that start-file.
  -- file-loaded re-applies from here when it finds chapter-list empty. NOT
  -- cleared on start-file; overwritten by the next apply_chapters_json (the
  -- renderer sends chapters on every load — including an empty list — so this
  -- stays coherent with the current file).
  -- @bugfix mpv-chapters-disappear-after-reload
  cached_chapters = nil,
}

-- Synthetic key for the end-of-media "Next episode" pill (which has no marker
-- to derive a stable key from). One per file path so a re-open after the
-- action fires starts a fresh timer.
local function end_of_media_key()
  return "endOfMedia:" .. tostring(mp.get_property("path", ""))
end

-- Pill stays visible for this many seconds of MEDIA time before auto-skip
-- fires, so the user has a window to dismiss/click manually. Matches typical
-- streaming-service UX. Media time, not wall clock (P22, #25): on a stuttering
-- PC playing at 0.3x a wall-clock grace was ~1.5 s of video, and a pause
-- during the pill made the skip fire the moment playback resumed.
local AUTO_SKIP_DELAY_SECONDS = 5
-- While a countdown is armed, refresh_pill also runs on this timer so the
-- pill's countdown and the fire do not depend on time-pos observer cadence.
local AUTO_SKIP_TICK_SECONDS = 0.25
-- How long the boxed "Opening next episode" notice stays on screen.
local NEXT_EPISODE_NOTICE_SECONDS = 2
-- Colours are written in ASS byte order (&HBBGGRR&), from the app's tokens:
-- amber #FFB357, fill #1F2430, neutral #C8CCD4, text #F2F4F8 (PLAY-SKIP-06:
-- the outline was drawn light blue because RGB was written as BGR).
local AMBER = "57B3FF"
local AMBER_HOVER = "8BD3FF"
local AMBER_PRESSED = "3A9CE4"
local FILL = "30241F"
local NEUTRAL = "D4CCC8"
local TEXT = "F8F4F2"
local MUTED = "CEBAB6"
local DARK = "1A1A1A"
-- The notice uses the pill's box and fill but a neutral outline: the amber
-- outline marks a clickable action, the notice is status only.
local NOTICE_OUTLINE = NEUTRAL

-- Characters, not bytes: French labels carry accents (é is two bytes).
local function ulen(s)
  local _, count = tostring(s):gsub("[^\128-\191]", "")
  return count
end

-- Width estimate of `s` at an ASS font size (Inter, bold included).
local function text_width(s, fs)
  return ulen(s) * fs * 0.36
end

-- Rounded rectangle (radius rr) as an ASS drawing path.
local function ass_round_path(l, t, r, b, rr)
  rr = math.min(rr, (b - t) / 2, (r - l) / 2)
  local k = rr * 0.4477
  return string.format(
    "m %.1f %.1f l %.1f %.1f b %.1f %.1f %.1f %.1f %.1f %.1f l %.1f %.1f b %.1f %.1f %.1f %.1f %.1f %.1f l %.1f %.1f b %.1f %.1f %.1f %.1f %.1f %.1f l %.1f %.1f b %.1f %.1f %.1f %.1f %.1f %.1f",
    l + rr, t, r - rr, t,
    r - k, t, r, t + k, r, t + rr,
    r, b - rr,
    r, b - k, r - k, b, r - rr, b,
    l + rr, b,
    l + k, b, l, b - k, l, b - rr,
    l, t + rr,
    l, t + k, l + k, t, l + rr, t)
end

local function ass_circle_path(cx, cy, r)
  return ass_round_path(cx - r, cy - r, cx + r, cy + r, r)
end

local function ass_shape(path, fill, outline, bord, alpha)
  return string.format("{\\p1\\an7\\pos(0,0)\\1c&H%s&\\3c&H%s&\\1a&H%s&\\bord%s\\shad0}%s{\\p0}",
    fill, outline or fill, alpha or "22", bord or 0, path)
end

local function ass_text(x, y, an, fs, color, bold, s)
  return string.format("{\\an%d\\pos(%.1f,%.1f)\\bord0\\shad0\\fs%d\\1c&H%s&\\b%d}%s", an, x, y, fs, color, bold and 1 or 0, s)
end

local pill_state = {
  active = nil,
  osd = mp.create_osd_overlay("ass-events"),
  width = 0,
  height = 0,
  mouse_x = -1,
  mouse_y = -1,
  hover = false,
  pressed = false,
  rect = nil,
  next_requested = false,
  -- Text of the boxed transient notice ("Opening next episode"), drawn in the
  -- pill's style instead of an unboxed osd_message; nil when hidden.
  notice = nil,
  notice_timer = nil,
  -- MPV-AUDIO-01: set by the app's sf-audio-stall {"state":"stalled"} when the
  -- audio output stopped taking sound and the player went on without sound;
  -- { output, device } as mpv reported them. While set, the pill offers
  -- "Retry with sound" with the explanation under it. nil otherwise.
  audio_stall = nil,
  -- OSD y where the controls' top band ends while tog4in1 shows the controls
  -- (user-data/sf/osc-top-band), else nil: the pill then moves below it so it
  -- never covers the what's-playing title (PLAY-OVL-01, review of PR 817).
  top_band_bottom = nil,
  -- True while a drawn pill is held between files (time-pos unavailable
  -- during a reload); see refresh_pill.
  reload_hold = false,
}

-- PLAY-SKIP-03/04/10: the skip UI (asked line, change panel, save scope),
-- drawn by the functions after announce_osc_seek. `mode` is nil, "asked",
-- "panel" or "scope"; times are in seconds; regions/areas are logical px.
local skip_ui = {
  osd = mp.create_osd_overlay("ass-events"),
  mode = nil,
  kind = "intro",
  start = 0,
  stop = 0,
  sel = "end",
  drag = false,
  hover = nil,
  pressed = nil,
  regions = {},
  areas = {},
  track = nil,
  seekbar = nil,
  asked_at = 0,
  asked_timer = nil,
  scope = "season",
  far = false,
  awaiting = nil,
  answer_timer = nil,
  return_pos = nil,
  was_paused = false,
  last_drag_seek = 0,
}

local PILL_MARGIN_X = 28
local PILL_MARGIN_Y = 28
local PILL_PADDING_X = 24
local PILL_HEIGHT = 58
local PILL_MIN_WIDTH = 280

-- P9 (#25): tog4in1's forced "window-controls" section sits above our forced
-- MBTN_LEFT binding (it re-stacks on "sf-bindings-ready", see the end), and in
-- fullscreen its top band (30 virtual px * the OSC scale, 2 OSD px per unit at HiDPI 1, MPV-OSC-05)
-- covers part of the pill. Input-section stacking can't be won
-- reliably from here, so we publish the pill hit rect (OSD pixels, same space
-- as mp.get_mouse_pos) in user-data; tog4in1 reads it synchronously in its
-- MBTN_LEFT handlers and forwards hits to "sf-pill-mouse" instead of eating
-- them.
local PILL_RECT_PROPERTY = "user-data/sf/pill-rect"
local published_pill_rect_key = nil
-- The pill's rect and the skip UI's (OSD px); tog4in1 reads one rect, so the
-- rect covering both is published (the pill hides while the skip UI shows).
local pill_hit_rect = nil
local skip_hit_rect = nil

local function publish_hit_rects()
  local rect = pill_hit_rect
  if skip_hit_rect then
    rect = rect and {
      left = math.min(rect.left, skip_hit_rect.left),
      top = math.min(rect.top, skip_hit_rect.top),
      right = math.max(rect.right, skip_hit_rect.right),
      bottom = math.max(rect.bottom, skip_hit_rect.bottom),
    } or skip_hit_rect
  end
  local key = rect and string.format("%d,%d,%d,%d",
    math.floor(rect.left), math.floor(rect.top), math.floor(rect.right), math.floor(rect.bottom)) or "none"
  if key == published_pill_rect_key then
    return
  end
  published_pill_rect_key = key
  local value = { active = rect ~= nil }
  if rect then
    value.left = rect.left
    value.top = rect.top
    value.right = rect.right
    value.bottom = rect.bottom
  end
  mp.set_property_native(PILL_RECT_PROPERTY, value)
  msg.info("[sf-pill] published hit rect " .. key)
end

local function publish_pill_rect(rect)
  pill_hit_rect = rect
  publish_hit_rects()
end

local function clamp(value, min_value, max_value)
  if value < min_value then return min_value end
  if value > max_value then return max_value end
  return value
end

local function format_pill_countdown(seconds)
  local total = math.max(0, math.floor(seconds + 0.5))
  local minutes = math.floor(total / 60)
  local secs = total % 60
  return string.format("%d:%02d", minutes, secs)
end

-- MPV-OSC-05: the pill keeps one on-screen size like the controls: its
-- geometry below is in logical pixels (OSD pixels / display-hidpi-scale).
local function update_pill_dimensions()
  local width, height = mp.get_osd_size()
  pill_state.width = width or 0
  pill_state.height = height or 0
  local hidpi = mp.get_property_number("display-hidpi-scale", 1)
  pill_state.ui_scale = (hidpi and hidpi > 0) and hidpi or 1
end

-- A logical-pixel rect in OSD pixels (the mouse's and tog4in1's space).
local function pill_rect_to_osd(rect)
  local s = pill_state.ui_scale or 1
  return { left = rect.left * s, top = rect.top * s, right = rect.right * s, bottom = rect.bottom * s }
end

local function update_pill_mouse()
  local x, y = mp.get_mouse_pos()
  pill_state.mouse_x = x or -1
  pill_state.mouse_y = y or -1
end

-- `kind` is the app's osc action type: "next_episode" (pill, auto-advance,
-- centre next button) or "previous_episode" (centre previous button).
-- `timePos` is where the user left this episode: the app saves that place
-- before it switches (PLAY-OVL-03, PLAY-RESUME-02). Its own progress poll
-- runs every 250 ms and saves every 500 ms, so it can miss the last moments,
-- e.g. the step past the credits start that makes the episode watched.
local function write_episode_action(kind)
  if user_opts.actions_file == nil or user_opts.actions_file == "" then
    msg.warn("[sf-episode] no actions_file; " .. kind .. " not sent")
    return
  end
  local file = io.open(user_opts.actions_file, "w")
  if not file then
    msg.warn("[sf-episode] cannot open actions_file " .. user_opts.actions_file)
    return
  end
  local time_pos = mp.get_property_number("time-pos")
  local left_at = time_pos and string.format(',"timePos":%.3f', time_pos) or ""
  file:write(string.format('{"type":"%s","requestedAt":%d%s}', kind, math.floor((mp.get_time() or 0) * 1000), left_at))
  file:close()
  msg.info("[sf-episode] wrote osc action " .. kind .. " timePos=" .. tostring(time_pos))
end

local function write_next_episode_action()
  write_episode_action("next_episode")
end

-- tog4in1 lays out the centre previous / next EPISODE buttons from this
-- (PLAY-OVL-03): a button exists only when that episode does.
local function publish_episode_nav()
  local nav = {
    hasPrevious = playback_state.previous_episode ~= nil,
    hasNext = playback_state.next_episode ~= nil,
    previousLabel = playback_state.previous_episode and playback_state.previous_episode.label or "",
    nextLabel = playback_state.next_episode and playback_state.next_episode.label or "",
  }
  mp.set_property_native("user-data/sf/episode-nav", nav)
  msg.info(string.format("[sf-episode] publish episode-nav hasPrevious=%s hasNext=%s",
    tostring(nav.hasPrevious), tostring(nav.hasNext)))
end

-- After a press the switch is in flight: forget both neighbours and hide the
-- buttons, so a double click (or a click while the next file loads) cannot
-- send a second switch from the old episode (review of PR 817). The new
-- episode's sf-playback-json brings them back.
local function on_episode_nav(direction)
  local kind = nil
  if direction == "previous" and playback_state.previous_episode then
    msg.info("[sf-episode] previous episode requested -> " .. playback_state.previous_episode.id)
    kind = "previous_episode"
  elseif direction == "next" and playback_state.next_episode then
    msg.info("[sf-episode] next episode requested -> " .. playback_state.next_episode.id)
    kind = "next_episode"
  else
    msg.info("[sf-episode] " .. tostring(direction) .. " ignored: no such episode (or a switch is in flight)")
    return
  end
  write_episode_action(kind)
  playback_state.previous_episode = nil
  playback_state.next_episode = nil
  publish_episode_nav()
end

local function active_marker(time_pos)
  if type(time_pos) ~= "number" then
    return nil
  end
  for _, marker in ipairs(playback_state.markers) do
    if time_pos >= marker.startSeconds and time_pos < marker.endSeconds then
      return marker
    end
  end
  return nil
end

local function marker_identity(marker)
  return string.format(
    "%d-%d-%s",
    math.floor((marker.startSeconds or 0) * 1000),
    math.floor((marker.endSeconds or 0) * 1000),
    tostring(marker.type or "")
  )
end

-- The audio notice's text (MPV-AUDIO-01/02), English until the app pushes the
-- UI language on `sf-labels-json` (i18n `player.audio*`, OscMenuPrompts).
local audio_text = {
  audioRetry = "Retry with sound",
  audioRetrying = "Retrying with sound",
  audioStallExplanation = "Audio device not responding. Check your headphones or sound output. Playing without sound.",
  audioNoOutputExplanation = "No sound output could be opened. Check your headphones, speakers or sound output. Playing without sound.",
  audioOutputLabel = "Sound output:",
}
local AUDIO_RETRY_NOTICE_SECONDS = 2
-- The skip texts (PLAY-SKIP-07), English until the app pushes the UI language
-- in `sf-labels-json` `skip` (i18n `player.skipUi.*`, OSC_SKIP_LABEL_KEYS).
local skip_text = {
  skipIntro = "Skip intro",
  skipCredits = "Skip credits",
  nextEpisode = "Next episode",
  nextEpisodeIn = "Next episode will start in",
  openingNextEpisode = "Opening next episode",
  enterKey = "[Enter]",
  askedIntro = "Intro skipped. Was it right?",
  askedCredits = "Credits skipped. Was it right?",
  yes = "Yes",
  changeTimes = "Change times",
  thanks = "Thanks",
  changeIntroTimes = "Change intro times",
  changeCreditsTimes = "Change credits times",
  start = "Start",
  ["end"] = "End",
  hint = "Drag a handle: the picture follows it.  ← → move the selected one by 1 s",
  save = "Save  [Enter]",
  cancel = "Cancel  [Esc]",
  back = "Back",
  scopeQuestion = "Use these times for",
  thisSeason = "This season",
  onlyThisEpisode = "Only this episode",
  farNote = "These times are far from the rest of this season.",
  savedSeason = "Saved for this season",
  savedEpisode = "Saved for this episode",
  menuPrompt = "Intro and credits",
  introEndsHere = "Intro ends here",
  creditsStartHere = "Credits start here",
}

local function current_pill_action()
  -- The frozen-audio notice wins over skip markers: without it the user hears
  -- nothing and does not know why (MPV-AUDIO-01).
  if pill_state.audio_stall then
    return { kind = "audio_retry", label = audio_text.audioRetry }
  end
  local time_pos = mp.get_property_number("time-pos", nil)
  local duration = mp.get_property_number("duration", nil)
  local marker = active_marker(time_pos)
  if marker then
    if marker.type == "intro" then
      return {
        kind = "skip_intro",
        label = skip_text.skipIntro,
        marker = marker,
        autoSkip = marker.autoSkip == true,
        countdown = math.max(0, (marker.endSeconds or 0) - (time_pos or 0)),
      }
    end
    if marker.type == "credits" then
      if playback_state.next_episode then
        local remaining = type(duration) == "number" and type(time_pos) == "number"
          and math.max(0, duration - time_pos)
          or nil
        local show_countdown =
          playback_state.autoplay_next_episode and
          type(remaining) == "number" and
          remaining <= playback_state.fallback_countdown_seconds
        return {
          kind = "next_episode",
          label = skip_text.nextEpisode,
          -- Carry the credits marker through so refresh_pill can apply the
          -- creditsSkipEnabled auto-skip to this pill too. Without this, the
          -- "Next episode" pill would only auto-fire via the legacy end-of-
          -- media fallback (last 0.35s of duration). Starting the next episode
          -- by itself also needs autoplay on (PLAY-NEXT-01), like the
          -- end-of-media fallback below; "Skip credits" keeps marker.autoSkip.
          -- @bugfix sf-credits-pill-ignores-autoplay-off
          marker = marker,
          autoSkip = marker.autoSkip == true and playback_state.autoplay_next_episode == true,
          countdown = show_countdown and remaining or nil,
        }
      end
      return {
        kind = "skip_credits",
        label = skip_text.skipCredits,
        marker = marker,
        -- PLAY-SKIP-02: credits are never skipped on their own; the user presses.
        autoSkip = false,
        countdown = math.max(0, (marker.endSeconds or 0) - (time_pos or 0)),
      }
    end
  end

  -- End-of-media fallback "Next episode" pill, for episodes without a
  -- credits marker in the metadata service. Only meaningful when the file has
  -- actually loaded (duration > 0). During mpv's loading phase both
  -- duration and time_pos are 0 — without the duration guard the fallback
  -- would fire immediately on launch (remaining = 0 - 0 = 0 <= 15) and
  -- briefly show the "Next episode will start in" pill before the real
  -- video starts. Requiring duration > fallback_countdown_seconds also
  -- skips the fallback entirely for clips shorter than the window, where
  -- it never made sense.
  if playback_state.next_episode
    and type(duration) == "number"
    and type(time_pos) == "number"
    and duration > playback_state.fallback_countdown_seconds
  then
    local remaining = math.max(0, duration - time_pos)
    if remaining <= playback_state.fallback_countdown_seconds then
      -- Carry `autoSkip` from the top-level auto_skip_next_episode flag so
      -- refresh_pill applies the 5s pre-roll here too — the user's
      -- creditsSkipEnabled toggle should fire next episode regardless of
      -- whether the metadata service has a credits marker.
      return {
        kind = "next_episode",
        label = skip_text.nextEpisode,
        autoSkip = playback_state.auto_skip_next_episode == true
          and playback_state.autoplay_next_episode == true,
        endOfMediaFallback = true,
        countdown = playback_state.autoplay_next_episode and remaining or nil,
      }
    end
  end

  return nil
end

-- Top-left pill box geometry for `label`, in logical pixels (MPV-OSC-05): below
-- the controls' top band (the what's-playing title) while the controls show,
-- else in the corner. The hit rect is this same rect in OSD pixels
-- (pill_rect_to_osd), so clicks follow the drawn pill.
local function pill_box_rect(label)
  local char_width = 13
  local box_width = math.max(PILL_MIN_WIDTH, (ulen(label) * char_width) + PILL_PADDING_X * 2)
  local left = PILL_MARGIN_X
  local top = PILL_MARGIN_Y
  if pill_state.top_band_bottom then
    top = pill_state.top_band_bottom / (pill_state.ui_scale or 1) + PILL_MARGIN_Y / 2
  end
  return { left = left, top = top, right = left + box_width, bottom = top + PILL_HEIGHT }
end

-- ASS for the pill box (filled, outlined, rounded rectangle) with `label`
-- inside. Shared by the clickable pill and the transient notice so both read
-- the same way on busy video. On an amber fill the text turns dark.
local function pill_box_ass(rect, label, fill, outline)
  local text_color = (fill == AMBER or fill == AMBER_HOVER or fill == AMBER_PRESSED) and DARK or TEXT
  local draw = ass_shape(ass_round_path(rect.left, rect.top, rect.right, rect.bottom, 12), fill, outline, 2, "22")
  local text = string.format(
    "{\\an4\\pos(%.1f,%.1f)\\bord0\\shad0\\fs26\\1c&H%s&\\b1}%s",
    rect.left + PILL_PADDING_X,
    rect.top + (PILL_HEIGHT / 2),
    text_color,
    label
  )
  return draw .. "\n" .. text
end

local function show_pill_osd(data)
  pill_state.osd.res_x = pill_state.width / (pill_state.ui_scale or 1)
  pill_state.osd.res_y = pill_state.height / (pill_state.ui_scale or 1)
  pill_state.osd.z = 1000
  pill_state.osd.data = data
  pill_state.osd:update()
end

local function render_pill()
  update_pill_dimensions()
  update_pill_mouse()
  if pill_state.width <= 0 or pill_state.height <= 0 then
    return
  end
  local action = pill_state.active
  if pill_state.notice or not action or pill_state.next_requested or skip_ui.mode ~= nil then
    pill_state.rect = nil
    publish_pill_rect(nil)
    pill_state.hover = false
    pill_state.pressed = false
    if pill_state.notice then
      -- Non-interactive status: no hit rect is published, so clicks pass
      -- through, and the outline is neutral rather than the action amber.
      show_pill_osd(pill_box_ass(pill_box_rect(pill_state.notice), pill_state.notice, FILL, NOTICE_OUTLINE))
    else
      pill_state.osd.data = ""
      pill_state.osd:update()
    end
    return
  end

  local countdown = type(action.countdown) == "number" and action.countdown or nil
  local hint = action.label
  if countdown ~= nil then
    hint = string.format("%s  %s  %s", action.label, format_pill_countdown(countdown), skip_text.enterKey)
  else
    hint = string.format("%s  %s", action.label, skip_text.enterKey)
  end

  local rect = pill_box_rect(hint)
  pill_state.rect = pill_rect_to_osd(rect)
  publish_pill_rect(pill_state.rect)
  pill_state.hover =
    pill_state.mouse_x >= pill_state.rect.left and pill_state.mouse_x <= pill_state.rect.right and
    pill_state.mouse_y >= pill_state.rect.top and pill_state.mouse_y <= pill_state.rect.bottom

  local fill = pill_state.pressed and AMBER_PRESSED or (pill_state.hover and AMBER or FILL)
  local outline = pill_state.hover and AMBER_HOVER or AMBER
  local data = pill_box_ass(rect, hint, fill, outline)
  if action.kind == "audio_retry" and pill_state.audio_stall then
    -- The why, under the action: status text, not part of the hit rect.
    local device = pill_state.audio_stall.device
    local detail = pill_state.audio_stall.reason == "no-output" and audio_text.audioNoOutputExplanation
      or audio_text.audioStallExplanation
    if type(device) == "string" and device ~= "" then
      detail = detail .. "\\N" .. audio_text.audioOutputLabel .. " " .. device
    end
    data = data .. "\n" .. string.format(
      "{\\an7\\pos(%.1f,%.1f)\\bord2\\shad0\\3c&H000000&\\fs22\\1c&H" .. TEXT .. "&}%s",
      rect.left,
      rect.bottom + 12,
      detail
    )
  end
  show_pill_osd(data)
end

-- Boxed transient notice in the pill's place (the unboxed osd_message was
-- hard to read over busy video, ultimate-stress visual review, #25).
local function show_pill_notice(text, seconds)
  if pill_state.notice_timer then
    pill_state.notice_timer:kill()
  end
  pill_state.notice = text
  msg.info(string.format("[sf-pill] notice shown: %s (%.1fs)", text, seconds))
  pill_state.notice_timer = mp.add_timeout(seconds, function()
    pill_state.notice = nil
    pill_state.notice_timer = nil
    render_pill()
  end)
  render_pill()
end

-- Tell the app where an absolute OSC seek is going. mpv reports the pre-seek
-- time-pos until the seek lands, so an ABR reload started meanwhile would
-- restart at the old position (issue #25 P1b).
-- Channel name: LUA_OUTBOUND_CHANNELS.OSC_SEEK in @space/mpv-protocol.
local function announce_osc_seek(seconds)
  mp.commandv("script-message", "sf-osc-seek", string.format("%.3f", seconds))
end

-- ---------------------------------------------------------------------------
-- Skip UI (PLAY-SKIP-03/04/10): the "Intro skipped. Was it right?" line after
-- an intro skip, the control bar's intro / credits menu, and the change panel:
-- two handles on the seek bar (dragging one shows that frame), -1 s / +1 s,
-- arrow keys, Cancel [Esc], Save [Enter], then where the times apply. Drawn on
-- its own overlay above the pill, in logical pixels like the pill
-- (MPV-OSC-05). The app stores the times: this script sends `sf-skip-edit`
-- (LUA_OUTBOUND_CHANNELS.SKIP_EDIT, string args, seconds) and the app answers
-- on `sf-skip-edit-json` (skipEditAnswerSchema in @space/mpv-protocol).
local SKIP_ASKED_SECONDS = 6
local SKIP_NOTICE_SECONDS = 2.5
local SKIP_ANSWER_TIMEOUT_SECONDS = 5
local SKIP_PANEL_WIDTH = 960
local SKIP_PANEL_HEIGHT = 214
local SKIP_MIN_LENGTH_SECONDS = 1
local SKIP_DRAG_SEEK_INTERVAL_SECONDS = 0.08

local function skip_marker_of(kind)
  for _, marker in ipairs(playback_state.markers) do
    if marker.type == kind then
      return marker
    end
  end
  return nil
end

local function skip_seconds(value)
  return string.format("%.3f", value)
end

local function skip_duration()
  return mp.get_property_number("duration", 0) or 0
end

local function send_skip_edit(...)
  local args = { ... }
  msg.info("[sf-skip] sf-skip-edit " .. table.concat(args, " "))
  mp.commandv("script-message", "sf-skip-edit", ...)
end

-- The seek track tog4in1 publishes (user-data/sf/seekbar, OSD px) in logical
-- px; while the controls are hidden a track of our own is drawn instead.
local function skip_track(w, h)
  local s = pill_state.ui_scale or 1
  local bar = skip_ui.seekbar
  if type(bar) == "table" and bar.visible == true and type(bar.x1) == "number" and type(bar.x2) == "number"
    and type(bar.y) == "number" and bar.x2 > bar.x1
  then
    return { x1 = bar.x1 / s, x2 = bar.x2 / s, y = bar.y / s, own = false }
  end
  return { x1 = 60, x2 = w - 60, y = h - 110, own = true }
end

local function skip_time_x(track, t)
  local d = skip_duration()
  local frac = d > 0 and clamp(t / d, 0, 1) or 0
  return track.x1 + (track.x2 - track.x1) * frac
end

local function skip_x_time(track, x)
  local frac = clamp((x - track.x1) / (track.x2 - track.x1), 0, 1)
  return frac * skip_duration()
end

local function skip_region(id, l, t, r, b)
  table.insert(skip_ui.regions, { id = id, left = l, top = t, right = r, bottom = b })
end

-- The topmost region under (x, y): later regions are drawn above earlier ones.
local function skip_region_at(x, y)
  for i = #skip_ui.regions, 1, -1 do
    local r = skip_ui.regions[i]
    if x >= r.left and x <= r.right and y >= r.top and y <= r.bottom then
      return r.id
    end
  end
  return nil
end

local function skip_in_area(x, y)
  for _, r in ipairs(skip_ui.areas) do
    if x >= r.left and x <= r.right and y >= r.top and y <= r.bottom then
      return true
    end
  end
  return false
end

-- A rounded button; returns its right edge. Primary = amber with dark text.
local function skip_button(out, id, l, cy, label, fs, primary)
  local w = text_width(label, fs) + 34
  local bh = fs + 18
  local hover = skip_ui.hover == id
  local fill, outline, color
  if primary then
    fill = hover and AMBER_HOVER or AMBER
    outline = fill
    color = DARK
  else
    fill = FILL
    outline = hover and AMBER or NEUTRAL
    color = TEXT
  end
  table.insert(out, ass_shape(ass_round_path(l, cy - bh / 2, l + w, cy + bh / 2, bh / 2), fill, outline, 1.5, "00"))
  table.insert(out, ass_text(l + w / 2, cy, 5, fs, color, true, label))
  skip_region(id, l, cy - bh / 2, l + w, cy + bh / 2)
  return l + w
end

-- The asked line, in the pill's place; a strip along its bottom shows the
-- time left before it goes away.
local function draw_skip_asked(out)
  local fs, bh = 24, 62
  local s = pill_state.ui_scale or 1
  local left = PILL_MARGIN_X
  local top = pill_state.top_band_bottom and (pill_state.top_band_bottom / s + PILL_MARGIN_Y / 2) or PILL_MARGIN_Y
  local tx = left + PILL_PADDING_X
  local cy = top + bh / 2
  local buttons = {}
  local asked = skip_ui.kind == "credits" and skip_text.askedCredits or skip_text.askedIntro
  local r1 = skip_button(buttons, "yes", tx + text_width(asked, fs) + 22, cy, skip_text.yes, 22, true)
  local right = skip_button(buttons, "change", r1 + 10, cy, skip_text.changeTimes, 22, false) + 14
  table.insert(out, ass_shape(ass_round_path(left, top, right, top + bh, 14), FILL, NEUTRAL, 1.5, "22"))
  table.insert(out, ass_text(tx, cy, 4, fs, TEXT, false, asked))
  for _, part in ipairs(buttons) do
    table.insert(out, part)
  end
  local left_frac = clamp(1 - (mp.get_time() - skip_ui.asked_at) / SKIP_ASKED_SECONDS, 0, 1)
  if left_frac > 0.01 then
    table.insert(out, ass_shape(ass_round_path(left + 12, top + bh - 6, left + 12 + (right - left - 24) * left_frac, top + bh - 3, 1.5),
      NEUTRAL, NEUTRAL, 0, "60"))
  end
  table.insert(skip_ui.areas, { left = left, top = top, right = right, bottom = top + bh })
end

-- The range on the seek track, a handle at each end; the selected handle is
-- amber with its time above it, with a halo while dragged.
local function draw_skip_range(out, track)
  local y = track.y
  if track.own then
    table.insert(out, ass_shape(ass_round_path(track.x1, y - 3, track.x2, y + 3, 3), NEUTRAL, NEUTRAL, 0, "60"))
  end
  local xs, xe = skip_time_x(track, skip_ui.start), skip_time_x(track, skip_ui.stop)
  table.insert(out, ass_shape(ass_round_path(xs, y - 12, xe, y + 12, 6), TEXT, AMBER_HOVER, 2, "A8"))
  skip_region("track", track.x1 - 10, y - 20, track.x2 + 10, y + 20)
  local chip_top = y
  local fs = 22
  local labels = { start = format_pill_countdown(skip_ui.start), ["end"] = format_pill_countdown(skip_ui.stop) }
  local widths = { start = text_width(labels.start, fs) + 20, ["end"] = text_width(labels["end"], fs) + 20 }
  -- Each time chip is centred on its handle; when the handles are too close for that, the two chips sit
  -- side by side around the middle of the range, start on the left, so neither covers the other.
  local centres = { start = xs, ["end"] = xe }
  local gap = 6
  if xe - xs < (widths.start + widths["end"]) / 2 + gap then
    local mid = (xs + xe) / 2
    centres.start = mid - gap / 2 - widths.start / 2
    centres["end"] = mid + gap / 2 + widths["end"] / 2
  end
  local function handle(which, x)
    local selected = skip_ui.sel == which
    local hw, hh = selected and 16 or 12, selected and 44 or 36
    if selected and skip_ui.drag then
      table.insert(out, ass_shape(ass_circle_path(x, y, 34), AMBER, AMBER, 0, "B0"))
    end
    table.insert(out, ass_shape(ass_round_path(x - hw / 2, y - hh / 2, x + hw / 2, y + hh / 2, 5),
      selected and AMBER or TEXT, selected and AMBER_HOVER or AMBER, selected and 3 or 2, "00"))
    local cw, cx = widths[which], centres[which]
    local ct = y - hh / 2 - 44
    chip_top = math.min(chip_top, ct)
    table.insert(out, ass_shape(ass_round_path(cx - cw / 2, ct, cx + cw / 2, ct + 34, 8),
      selected and AMBER or FILL, selected and AMBER or NEUTRAL, 1.5, "10"))
    table.insert(out, ass_text(cx, ct + 17, 5, fs, selected and DARK or TEXT, true, labels[which]))
    skip_region("h-" .. which, x - 20, ct, x + 20, y + hh / 2 + 4)
  end
  -- The selected handle last, so it wins where both overlap.
  if skip_ui.sel == "start" then
    handle("end", xe)
    handle("start", xs)
  else
    handle("start", xs)
    handle("end", xe)
  end
  table.insert(skip_ui.areas, { left = track.x1 - 24, top = chip_top, right = track.x2 + 24, bottom = y + 30 })
end

local function draw_skip_panel_box(out, w, track)
  local pw = math.min(SKIP_PANEL_WIDTH, w - 40)
  local left = (w - pw) / 2
  local top = math.max(10, track.y - 90 - SKIP_PANEL_HEIGHT)
  table.insert(out, ass_shape(ass_round_path(left, top, left + pw, top + SKIP_PANEL_HEIGHT, 16), FILL, NEUTRAL, 1.5, "00"))
  table.insert(skip_ui.areas, { left = left, top = top, right = left + pw, bottom = top + SKIP_PANEL_HEIGHT })
  return left, top, pw
end

-- Cancel or Back, then Save, at the panel's bottom right.
local function draw_skip_footer(out, left, top, pw, first_id, first_label)
  local by = top + SKIP_PANEL_HEIGHT - 36
  local fs = 22
  local save_left = left + pw - PILL_PADDING_X - (text_width(skip_text.save, fs) + 34)
  local first_left = save_left - 12 - (text_width(first_label, fs) + 34)
  skip_button(out, first_id, first_left, by, first_label, fs, false)
  skip_button(out, "save", save_left, by, skip_text.save, fs, true)
end

local function draw_skip_change(out, w, track)
  local left, top, pw = draw_skip_panel_box(out, w, track)
  local title = skip_ui.kind == "credits" and skip_text.changeCreditsTimes or skip_text.changeIntroTimes
  table.insert(out, ass_text(left + PILL_PADDING_X, top + 36, 4, 28, TEXT, true, title))
  local ry = top + 92
  local function readout(id, x, label, value, selected)
    table.insert(out, ass_text(x, ry, 4, 22, MUTED, false, label))
    local vx = x + text_width(label, 22) + 16
    local vw = text_width(value, 30) + 24
    if selected then
      table.insert(out, ass_shape(ass_round_path(vx - 4, ry - 24, vx + vw, ry + 24, 10), FILL, AMBER, 2, "00"))
    end
    table.insert(out, ass_text(vx + 8, ry, 4, 30, selected and AMBER or TEXT, true, value))
    skip_region(id, x, ry - 24, vx + vw, ry + 24)
    return vx + vw
  end
  local e1 = readout("sel-start", left + PILL_PADDING_X, skip_text.start, format_pill_countdown(skip_ui.start), skip_ui.sel == "start")
  readout("sel-end", e1 + 40, skip_text["end"], format_pill_countdown(skip_ui.stop), skip_ui.sel == "end")
  local minus, plus = "−1 s", "+1 s"
  local plus_left = left + pw - PILL_PADDING_X - (text_width(plus, 24) + 34)
  local minus_left = plus_left - 12 - (text_width(minus, 24) + 34)
  skip_button(out, "minus", minus_left, ry, minus, 24, false)
  skip_button(out, "plus", plus_left, ry, plus, 24, false)
  table.insert(out, ass_text(left + PILL_PADDING_X, top + 142, 4, 19, MUTED, false, skip_text.hint))
  draw_skip_footer(out, left, top, pw, "cancel", skip_text.cancel)
end

-- Save, second step: where the new times apply. "This season" is preselected
-- unless the app found them far from the rest of the season.
local function draw_skip_scope(out, w, track)
  local left, top, pw = draw_skip_panel_box(out, w, track)
  table.insert(out, ass_text(left + PILL_PADDING_X, top + 36, 4, 28, TEXT, true, skip_text.scopeQuestion))
  local ry = top + 96
  local function option(id, l, label, on)
    local fs = 24
    local ow = 56 + text_width(label, fs) + 24
    local hover = skip_ui.hover == id
    table.insert(out, ass_shape(ass_round_path(l, ry - 28, l + ow, ry + 28, 14), FILL,
      (on or hover) and AMBER or NEUTRAL, on and 2.5 or 1.5, "00"))
    table.insert(out, ass_shape(ass_circle_path(l + 28, ry, 11), FILL, on and AMBER or NEUTRAL, 2, "00"))
    if on then
      table.insert(out, ass_shape(ass_circle_path(l + 28, ry, 5.5), AMBER, AMBER, 0, "00"))
    end
    table.insert(out, ass_text(l + 50, ry, 4, fs, on and AMBER or TEXT, true, label))
    skip_region(id, l, ry - 28, l + ow, ry + 28)
    return l + ow
  end
  local e1 = option("scope-season", left + PILL_PADDING_X, skip_text.thisSeason, skip_ui.scope == "season")
  option("scope-episode", e1 + 16, skip_text.onlyThisEpisode, skip_ui.scope == "episode")
  if skip_ui.far then
    table.insert(out, ass_text(left + PILL_PADDING_X, top + 142, 4, 20, AMBER, false, skip_text.farNote))
  end
  draw_skip_footer(out, left, top, pw, "back", skip_text.back)
end

local function render_skip_ui()
  update_pill_dimensions()
  local s = pill_state.ui_scale or 1
  local w, h = pill_state.width / s, pill_state.height / s
  skip_ui.regions = {}
  skip_ui.areas = {}
  local out = {}
  if skip_ui.mode and w > 0 and h > 0 then
    if skip_ui.mode == "asked" then
      draw_skip_asked(out)
    else
      local track = skip_track(w, h)
      skip_ui.track = track
      draw_skip_range(out, track)
      if skip_ui.mode == "panel" then
        draw_skip_change(out, w, track)
      else
        draw_skip_scope(out, w, track)
      end
    end
  end
  if w > 0 and h > 0 then
    skip_ui.osd.res_x = w
    skip_ui.osd.res_y = h
  end
  skip_ui.osd.z = 1001
  skip_ui.osd.data = table.concat(out, "\n")
  skip_ui.osd:update()
  local union = nil
  for _, r in ipairs(skip_ui.areas) do
    union = union and {
      left = math.min(union.left, r.left),
      top = math.min(union.top, r.top),
      right = math.max(union.right, r.right),
      bottom = math.max(union.bottom, r.bottom),
    } or { left = r.left, top = r.top, right = r.right, bottom = r.bottom }
  end
  skip_hit_rect = union and pill_rect_to_osd(union) or nil
  publish_hit_rects()
end

local function stop_skip_asked_timer()
  if skip_ui.asked_timer then
    skip_ui.asked_timer:kill()
    skip_ui.asked_timer = nil
  end
end

local function close_skip_asked(reason)
  if skip_ui.mode ~= "asked" then
    return
  end
  stop_skip_asked_timer()
  skip_ui.mode = nil
  skip_ui.hover = nil
  msg.info("[sf-skip] asked line closed: " .. reason)
  render_skip_ui()
  render_pill()
end

-- After a skip (automatic, or the user's press) of times this device detected
-- and is unsure of (marker.ask), ask whether they were right (PLAY-SKIP-03).
-- Gone after SKIP_ASKED_SECONDS, a seek, a pause or the menu.
local function show_skip_asked(marker)
  stop_skip_asked_timer()
  skip_ui.mode = "asked"
  skip_ui.kind = marker.type == "credits" and "credits" or "intro"
  skip_ui.start = marker.startSeconds or 0
  skip_ui.stop = marker.endSeconds or 0
  skip_ui.asked_at = mp.get_time()
  skip_ui.hover = nil
  skip_ui.asked_timer = mp.add_periodic_timer(0.2, function()
    if mp.get_time() - skip_ui.asked_at >= SKIP_ASKED_SECONDS then
      close_skip_asked("timeout")
    else
      render_skip_ui()
    end
  end)
  msg.info(string.format("[sf-skip] asked line shown: %s %.2f-%.2f", skip_ui.kind, skip_ui.start, skip_ui.stop))
  render_skip_ui()
  render_pill()
end

-- Show the frame at the selected handle.
local function skip_show_frame()
  local t = skip_ui.sel == "start" and skip_ui.start or skip_ui.stop
  mp.commandv("seek", skip_seconds(t), "absolute", "exact")
  announce_osc_seek(t)
end

local function skip_move_handle(which, t)
  if which == "start" then
    skip_ui.start = clamp(t, 0, math.max(0, skip_ui.stop - SKIP_MIN_LENGTH_SECONDS))
  else
    skip_ui.stop = clamp(t, math.min(skip_duration(), skip_ui.start + SKIP_MIN_LENGTH_SECONDS), skip_duration())
  end
end

local function skip_select_handle(which)
  skip_ui.sel = which
  skip_show_frame()
  render_skip_ui()
end

local function skip_nudge(delta)
  local current = skip_ui.sel == "start" and skip_ui.start or skip_ui.stop
  skip_move_handle(skip_ui.sel, current + delta)
  msg.info(string.format("[sf-skip] %s moved by %+d s: %.2f-%.2f", skip_ui.sel, delta, skip_ui.start, skip_ui.stop))
  skip_show_frame()
  render_skip_ui()
end

local function stop_skip_answer_timer()
  if skip_ui.answer_timer then
    skip_ui.answer_timer:kill()
    skip_ui.answer_timer = nil
  end
end

local function close_skip_panel(reason, restore)
  if skip_ui.mode ~= "panel" and skip_ui.mode ~= "scope" then
    return
  end
  skip_ui.mode = nil
  skip_ui.drag = false
  skip_ui.hover = nil
  skip_ui.awaiting = nil
  stop_skip_answer_timer()
  mp.remove_key_binding("sf-skip-edit-tab")
  msg.info("[sf-skip] change panel closed: " .. reason)
  if restore ~= false then
    if type(skip_ui.return_pos) == "number" then
      mp.commandv("seek", skip_seconds(skip_ui.return_pos), "absolute", "exact")
      announce_osc_seek(skip_ui.return_pos)
    end
    if not skip_ui.was_paused then
      mp.set_property_bool("pause", false)
    end
  end
  skip_ui.return_pos = nil
  render_skip_ui()
  render_pill()
end

-- Open the change panel on `kind` with these times. Playback pauses (the
-- controls stay up) and comes back where it was on close.
local function open_skip_panel(kind, start, stop)
  local d = skip_duration()
  if d <= 0 then
    msg.warn("[sf-skip] change panel not opened: duration unknown")
    return
  end
  stop_skip_asked_timer()
  if skip_ui.mode ~= "panel" and skip_ui.mode ~= "scope" then
    skip_ui.return_pos = mp.get_property_number("time-pos", nil)
    skip_ui.was_paused = mp.get_property_bool("pause", false) == true
  end
  skip_ui.kind = kind
  skip_ui.start = clamp(start or 0, 0, d)
  skip_ui.stop = clamp(stop or d, 0, d)
  if skip_ui.stop - skip_ui.start < SKIP_MIN_LENGTH_SECONDS then
    if kind == "intro" then
      skip_ui.stop = math.min(d, skip_ui.start + SKIP_MIN_LENGTH_SECONDS)
    else
      skip_ui.start = math.max(0, skip_ui.stop - SKIP_MIN_LENGTH_SECONDS)
    end
  end
  skip_ui.mode = "panel"
  skip_ui.sel = kind == "intro" and "end" or "start"
  skip_ui.drag = false
  skip_ui.hover = nil
  skip_ui.awaiting = nil
  mp.set_property_bool("pause", true)
  mp.add_forced_key_binding("TAB", "sf-skip-edit-tab", function()
    if skip_ui.mode == "panel" then
      skip_select_handle(skip_ui.sel == "start" and "end" or "start")
    end
  end)
  msg.info(string.format("[sf-skip] change panel opened: %s %.2f-%.2f", kind, skip_ui.start, skip_ui.stop))
  skip_show_frame()
  render_skip_ui()
  render_pill()
end

local function open_skip_scope(scope)
  skip_ui.mode = "scope"
  skip_ui.scope = scope == "episode" and "episode" or "season"
  skip_ui.far = skip_ui.scope == "episode"
  skip_ui.awaiting = nil
  skip_ui.hover = nil
  stop_skip_answer_timer()
  msg.info("[sf-skip] save scope step: preselected " .. skip_ui.scope)
  render_skip_ui()
end

-- Save, first step: ask the app which scope to preselect (PLAY-SKIP-05).
local function skip_ask_scope()
  skip_ui.awaiting = "preselect"
  send_skip_edit("preselect", skip_ui.kind, skip_seconds(skip_ui.start), skip_seconds(skip_ui.stop))
  stop_skip_answer_timer()
  skip_ui.answer_timer = mp.add_timeout(SKIP_ANSWER_TIMEOUT_SECONDS, function()
    skip_ui.answer_timer = nil
    if skip_ui.awaiting == "preselect" then
      msg.warn("[sf-skip] no preselect answer from the app; offering this season")
      open_skip_scope("season")
    end
  end)
end

local function skip_save()
  skip_ui.awaiting = "save"
  send_skip_edit("save", skip_ui.kind, skip_seconds(skip_ui.start), skip_seconds(skip_ui.stop), skip_ui.scope,
    skip_seconds(skip_duration()))
  stop_skip_answer_timer()
  skip_ui.answer_timer = mp.add_timeout(SKIP_ANSWER_TIMEOUT_SECONDS, function()
    skip_ui.answer_timer = nil
    if skip_ui.awaiting == "save" then
      msg.warn("[sf-skip] no save answer from the app; closing the panel")
      close_skip_panel("save not answered")
    end
  end)
end

local function skip_ui_action(id)
  local mode = skip_ui.mode
  msg.info("[sf-skip] ui action " .. id .. " mode=" .. tostring(mode))
  if mode == "asked" then
    if id == "yes" then
      send_skip_edit("verdict", skip_ui.kind, skip_seconds(skip_ui.start), skip_seconds(skip_ui.stop),
        skip_seconds(skip_duration()))
      close_skip_asked("yes")
      show_pill_notice("✓  " .. skip_text.thanks, SKIP_NOTICE_SECONDS)
    elseif id == "change" then
      skip_ui.mode = nil
      open_skip_panel(skip_ui.kind, skip_ui.start, skip_ui.stop)
    end
    return
  end
  if mode == "panel" then
    if id == "sel-start" then
      skip_select_handle("start")
    elseif id == "sel-end" then
      skip_select_handle("end")
    elseif id == "minus" then
      skip_nudge(-1)
    elseif id == "plus" then
      skip_nudge(1)
    elseif id == "cancel" then
      close_skip_panel("cancel")
    elseif id == "save" and skip_ui.awaiting == nil then
      skip_ask_scope()
    end
    return
  end
  if mode == "scope" then
    if id == "scope-season" or id == "scope-episode" then
      skip_ui.scope = id == "scope-episode" and "episode" or "season"
      render_skip_ui()
    elseif id == "back" then
      skip_ui.mode = "panel"
      render_skip_ui()
    elseif id == "save" and skip_ui.awaiting == nil then
      skip_save()
    end
  end
end

-- Keys while the panel is open; true when the key was the panel's.
local function skip_ui_key(key)
  local mode = skip_ui.mode
  if mode ~= "panel" and mode ~= "scope" then
    return false
  end
  if key == "ESC" then
    if mode == "scope" then
      skip_ui_action("back")
    else
      skip_ui_action("cancel")
    end
  elseif key == "ENTER" then
    skip_ui_action("save")
  elseif key == "LEFT" or key == "RIGHT" then
    if mode == "panel" then
      skip_nudge(key == "LEFT" and -1 or 1)
    else
      skip_ui_action(key == "LEFT" and "scope-season" or "scope-episode")
    end
  end
  return true
end

-- MBTN_LEFT down / up for the skip UI; true when it was the skip UI's.
local function skip_ui_mouse(event)
  if not skip_ui.mode then
    return false
  end
  local s = pill_state.ui_scale or 1
  local mx, my = mp.get_mouse_pos()
  local x, y = (mx or -1) / s, (my or -1) / s
  if skip_ui.drag then
    if event.event == "up" or event.event == "cancel" then
      skip_ui.drag = false
      msg.info(string.format("[sf-skip] drag ended: %.2f-%.2f", skip_ui.start, skip_ui.stop))
      skip_show_frame()
      render_skip_ui()
    end
    return true
  end
  local id = skip_region_at(x, y)
  if id == nil and not skip_in_area(x, y) then
    return false
  end
  if event.event == "down" then
    skip_ui.pressed = id
    if skip_ui.mode ~= "asked" and skip_ui.track and (id == "h-start" or id == "h-end" or id == "track") then
      if id == "track" then
        skip_move_handle(skip_ui.sel, skip_x_time(skip_ui.track, x))
      else
        skip_ui.sel = id == "h-start" and "start" or "end"
      end
      if skip_ui.mode == "scope" then
        skip_ui.mode = "panel"
      end
      skip_ui.drag = true
      skip_ui.pressed = nil
      msg.info("[sf-skip] drag started on " .. skip_ui.sel)
      skip_show_frame()
      render_skip_ui()
    end
    return true
  end
  if event.event == "up" then
    local pressed = skip_ui.pressed
    skip_ui.pressed = nil
    if id and pressed == id then
      skip_ui_action(id)
    end
  end
  return true
end

-- Pointer moves: drag the selected handle (the picture follows, a seek at most
-- every SKIP_DRAG_SEEK_INTERVAL_SECONDS) and hover highlights.
local function skip_ui_pointer(pos)
  if not skip_ui.mode or type(pos) ~= "table" or type(pos.x) ~= "number" then
    return
  end
  local s = pill_state.ui_scale or 1
  local x, y = pos.x / s, pos.y / s
  if skip_ui.drag and skip_ui.track then
    skip_move_handle(skip_ui.sel, skip_x_time(skip_ui.track, x))
    local now = mp.get_time()
    if now - skip_ui.last_drag_seek >= SKIP_DRAG_SEEK_INTERVAL_SECONDS then
      skip_ui.last_drag_seek = now
      skip_show_frame()
    end
    render_skip_ui()
    return
  end
  local id = skip_region_at(x, y)
  if id ~= skip_ui.hover then
    skip_ui.hover = id
    render_skip_ui()
  end
end

-- The control bar's intro / credits button (tog4in1 cy_skip, PLAY-SKIP-10):
-- with times, change them; without, mark the current moment.
local function open_skip_menu()
  close_skip_asked("menu")
  if skip_ui.mode then
    msg.info("[sf-skip] menu ignored: change panel open")
    return
  end
  local now = mp.get_property_number("time-pos", 0) or 0
  local d = skip_duration()
  if d <= 0 then
    msg.warn("[sf-skip] menu ignored: duration unknown")
    return
  end
  local items, actions = {}, {}
  local intro, credits = skip_marker_of("intro"), skip_marker_of("credits")
  if intro then
    table.insert(items, skip_text.changeIntroTimes)
    table.insert(actions, function() open_skip_panel("intro", intro.startSeconds, intro.endSeconds) end)
  else
    table.insert(items, skip_text.introEndsHere)
    table.insert(actions, function() open_skip_panel("intro", 0, now) end)
  end
  if credits then
    table.insert(items, skip_text.changeCreditsTimes)
    table.insert(actions, function() open_skip_panel("credits", credits.startSeconds, credits.endSeconds) end)
  else
    table.insert(items, skip_text.creditsStartHere)
    table.insert(actions, function() open_skip_panel("credits", now, d) end)
  end
  msg.info(string.format("[sf-skip] menu opened at %.2f: intro=%s credits=%s", now, tostring(intro ~= nil), tostring(credits ~= nil)))
  input.select({
    prompt = skip_text.menuPrompt .. "  (" .. format_pill_countdown(now) .. ")",
    items = items,
    default_item = 1,
    submit = function(index)
      local action = actions[index]
      if action then
        action()
      end
    end,
  })
end

-- The app's answers to sf-skip-edit (skipEditAnswerSchema).
local function on_skip_edit_answer(payload)
  local ok, parsed = pcall(utils.parse_json, payload or "")
  if not ok or type(parsed) ~= "table" then
    msg.warn("[sf-skip] unreadable sf-skip-edit-json: " .. tostring(payload))
    return
  end
  msg.info("[sf-skip] answer " .. tostring(parsed.kind) .. " scope=" .. tostring(parsed.scope) .. " awaiting=" .. tostring(skip_ui.awaiting))
  if parsed.kind == "preselect" and skip_ui.awaiting == "preselect" then
    open_skip_scope(parsed.scope)
  elseif parsed.kind == "saved" and skip_ui.awaiting == "save" then
    close_skip_panel("saved")
    show_pill_notice("✓  " .. (parsed.scope == "episode" and skip_text.savedEpisode or skip_text.savedSeason), SKIP_NOTICE_SECONDS)
  elseif parsed.kind == "failed" and skip_ui.awaiting ~= nil then
    close_skip_panel("the app could not save")
  end
end

-- A new file: the asked line and the panel belonged to the previous one.
local function reset_skip_ui()
  stop_skip_asked_timer()
  stop_skip_answer_timer()
  if skip_ui.mode == "panel" or skip_ui.mode == "scope" then
    close_skip_panel("new file", false)
  end
  skip_ui.mode = nil
  skip_ui.awaiting = nil
  render_skip_ui()
end

local function trigger_active_action()
  local action = pill_state.active
  if not action then
    return false
  end
  if action.kind == "skip_intro" or action.kind == "skip_credits" then
    local marker = action.marker
    if not marker then
      return false
    end
    local end_pos = clamp(marker.endSeconds or 0, 0, mp.get_property_number("duration", 0) or 0)
    mp.commandv("seek", tostring(end_pos), "absolute", "exact")
    announce_osc_seek(end_pos)
    if marker.ask == true then
      show_skip_asked(marker)
    end
    return true
  end
  if action.kind == "audio_retry" then
    -- MPV-AUDIO-01/02: the app restores the audio track or reopens the output;
    -- if it is still dead it sends sf-audio-stall stalled again after its threshold.
    pill_state.audio_stall = nil
    msg.info("[sf-audio-stall] retry with sound requested")
    mp.commandv("script-message", "sf-audio-retry")
    show_pill_notice(audio_text.audioRetrying, AUDIO_RETRY_NOTICE_SECONDS)
    return true
  end
  if action.kind == "next_episode" then
    pill_state.next_requested = true
    write_next_episode_action()
    show_pill_notice(skip_text.openingNextEpisode, NEXT_EPISODE_NOTICE_SECONDS)
    return true
  end
  return false
end

-- Emit the current pill state to any listening script-message subscriber
-- (E2E observers; production listeners ignore it). refresh_pill runs per
-- frame during playback, so emitting on every call flooded mpv IPC and the
-- desktop main process (~16 msg/s, #25 NEW-pill-state-flood). Emit only when
-- the pill's visible state changes, plus a 1 Hz heartbeat while refreshes keep
-- coming so observers still see time-pos advance. `countdown` is reported in
-- whole seconds, exactly what the pill shows (format_pill_countdown), so a
-- running countdown changes the payload once per second, not per frame.
-- `timePos` is excluded from the change signature (it moves every frame).
-- @bugfix mpv-pill-state-ipc-flood
local PILL_STATE_HEARTBEAT_SECONDS = 1.0
local last_pill_signature = nil
local last_pill_emit_at = nil

local function emit_pill_state()
  local p = pill_state.active
  local marker_key = p and p.marker and marker_identity(p.marker) or nil
  local countdown = nil
  if p and type(p.countdown) == "number" then
    countdown = math.max(0, math.floor(p.countdown + 0.5))
  end
  local payload = {
    active = p ~= nil,
    kind = p and p.kind or nil,
    label = p and p.label or nil,
    countdown = countdown,
    autoSkip = (p and p.autoSkip == true) or false,
    hasMarker = (p and p.marker ~= nil) or false,
    endOfMediaFallback = (p and p.endOfMediaFallback == true) or false,
    suppressed = (marker_key and playback_state.auto_skip_suppressed[marker_key] == true) or false,
    fired = (marker_key and playback_state.auto_skip_fired[marker_key] == true) or false,
  }
  local signature = table.concat({
    tostring(payload.active), tostring(payload.kind), tostring(payload.label),
    tostring(payload.countdown), tostring(payload.autoSkip), tostring(payload.hasMarker),
    tostring(payload.endOfMediaFallback), tostring(payload.suppressed), tostring(payload.fired),
  }, "|")
  local now = mp.get_time()
  if signature == last_pill_signature
    and last_pill_emit_at ~= nil
    and now - last_pill_emit_at < PILL_STATE_HEARTBEAT_SECONDS
  then
    return
  end
  payload.timePos = mp.get_property_number("time-pos", nil)
  local ok, encoded = pcall(utils.format_json, payload)
  if ok and type(encoded) == "string" then
    last_pill_signature = signature
    last_pill_emit_at = now
    mp.commandv("script-message", "sf-pill-state", encoded)
  end
end

-- Threshold for detecting a time-pos discontinuity (manual seek, resume from
-- backdrop→HLS handoff, etc). Normal playback advances time-pos by ~0.04s per
-- refresh (24fps) up to ~0.06s (16fps), so 1.5s is comfortably above the
-- natural-progression noise floor while still catching small user seeks.
local TIME_POS_DISCONTINUITY_THRESHOLD = 1.5

-- The end-of-media fallback opens the next episode in the last
-- END_OF_MEDIA_FIRE_SECONDS of the file. It may only do so when playback
-- reached that window naturally (P6, #25): a premature demux EOF (partial
-- segment, network error) makes keep-open mpv seek to the last frame, so
-- time-pos jumps e.g. 145.9 -> 720 and the old check opened the next episode
-- at minute 2. `playback_state.end_approach` is decided once per entry into
-- the window: true when the previous sample was a continuous step from
-- outside it, or when the jump started while the next-episode / skip-credits
-- pill was up (the user skipping the end: RIGHT, Skip credits). False for any
-- other jump in (premature EOF, seek, resume at the very end). Leaving the
-- window clears it.
local END_OF_MEDIA_FIRE_SECONDS = 0.35

local function update_end_approach(time_pos, prev_time_pos, prev_pill_kind)
  local duration = mp.get_property_number("duration", nil)
  if type(duration) ~= "number" or type(time_pos) ~= "number" or duration <= 0 then
    playback_state.end_approach = nil
    return
  end
  if duration - time_pos > END_OF_MEDIA_FIRE_SECONDS then
    playback_state.end_approach = nil
    return
  end
  if playback_state.end_approach ~= nil then
    return
  end
  local continuous = type(prev_time_pos) == "number"
    and duration - prev_time_pos > END_OF_MEDIA_FIRE_SECONDS
  local from_end_pill = prev_pill_kind == "next_episode" or prev_pill_kind == "skip_credits"
  local natural = continuous or from_end_pill
  playback_state.end_approach = natural
  msg.info(string.format(
    "[sf-eof] end window entered natural=%s continuous=%s prev_pill=%s prev=%s time_pos=%.2f duration=%.2f eof-reached=%s",
    tostring(natural),
    tostring(continuous),
    tostring(prev_pill_kind),
    tostring(prev_time_pos),
    time_pos,
    duration,
    tostring(mp.get_property_bool("eof-reached", false))
  ))
end

-- 250 ms tick that re-runs refresh_pill while an auto-skip countdown is armed
-- (created stopped below refresh_pill; started/stopped from refresh_pill).
local countdown_timer = nil

local function set_countdown_ticking(on)
  if not countdown_timer then
    return
  end
  if on and not countdown_timer:is_enabled() then
    countdown_timer:resume()
  elseif not on and countdown_timer:is_enabled() then
    countdown_timer:stop()
  end
end

-- Drop a pill held across a reload (see refresh_pill) and draw the cleared
-- state: the next file is other media, or playback stopped.
local function drop_held_pill(reason)
  if not pill_state.reload_hold then
    return
  end
  pill_state.reload_hold = false
  msg.info("[sf-pill] reload hold dropped: " .. reason)
  pill_state.active = nil
  render_pill()
  emit_pill_state()
end

local function refresh_pill()
  local time_pos = mp.get_property_number("time-pos", nil)
  -- Between files (any reload or next file) time-pos is unavailable. A pill
  -- drawn at that moment is HELD as drawn instead of cleared: an Auto-quality
  -- reload of the same episode resumes at the same spot, and clearing blanked
  -- the pill for the whole stream open (#25 c055: ~0.66 s, the user saw it
  -- vanish mid-intro). The hold ends when time-pos is known again (this
  -- refresh then recomputes from the reloaded envelope, so a reload landing
  -- outside the marker clears it), when an envelope for other media arrives
  -- (apply_playback_json) or when mpv goes idle (playback stopped).
  -- @bugfix mpv-pill-blinks-on-abr-reload
  if type(time_pos) ~= "number" then
    if pill_state.reload_hold then
      return
    end
    if pill_state.active ~= nil
      and pill_state.rect ~= nil
      and mp.get_property_bool("idle-active", false) ~= true
    then
      pill_state.reload_hold = true
      msg.info(string.format(
        "[sf-pill] held across reload: kind=%s (time-pos unavailable)",
        tostring(pill_state.active.kind)
      ))
      return
    end
  elseif pill_state.reload_hold then
    pill_state.reload_hold = false
    msg.info(string.format("[sf-pill] reload hold released: time-pos %.3f known", time_pos))
  end
  local paused = mp.get_property_bool("pause", false) == true
  -- Media seconds played since the previous refresh: the auto-skip grace is
  -- counted on this, not on the wall clock (P22, #25). Zero while paused,
  -- scaled by the real playback rate (slow/stuttering playback stretches the
  -- grace), and zero across seeks/discontinuities.
  local media_delta = 0
  if not paused
    and type(time_pos) == "number"
    and type(playback_state.last_time_pos) == "number"
  then
    local step = time_pos - playback_state.last_time_pos
    if step > 0 and step <= TIME_POS_DISCONTINUITY_THRESHOLD then
      media_delta = step
    end
  end
  -- Discontinuity detection: if time-pos jumped by more than the threshold in
  -- EITHER direction since the last refresh, treat this as a seek / resume /
  -- stream-handoff event. Clearing last_time_pos here makes the mid-marker
  -- entry suppression block below see nil and decide "not natural progression"
  -- if a marker is already active at the new time_pos. Catches:
  --   - Manual user seeks (forward or backward) into a marker
  --   - The backdrop→HLS handoff on a resume launch where the renderer's
  --     backdrop stream observes 0→~3 before the actual HLS takes over at
  --     the requested startTime (e.g. resume into intro at t=10s).
  if type(time_pos) == "number"
    and type(playback_state.last_time_pos) == "number"
    and math.abs(time_pos - playback_state.last_time_pos) > TIME_POS_DISCONTINUITY_THRESHOLD
  then
    msg.info(string.format(
      "[sf-skip] discontinuity detected: prev=%.2f cur=%.2f",
      playback_state.last_time_pos,
      time_pos
    ))
    playback_state.last_time_pos = nil
  end
  update_end_approach(time_pos, playback_state.last_time_pos, pill_state.active and pill_state.active.kind or nil)
  pill_state.active = current_pill_action()
  if pill_state.active == nil then
    pill_state.next_requested = false
    -- No marker active right now. Clear suppression flags so a future natural
    -- progression (last_time_pos < startSeconds → time_pos >= startSeconds)
    -- can arm afresh. We keep auto_skip_fired untouched so user rewinds back
    -- into a marker that already auto-fired don't re-trigger (the once-per-
    -- activation guard).
    playback_state.auto_skip_suppressed = {}
    -- Likewise an un-fired countdown restarts from the full grace on the
    -- next natural entry instead of resuming where it was left.
    playback_state.auto_skip_media_elapsed = {}
    set_countdown_ticking(false)
    playback_state.last_time_pos = type(time_pos) == "number" and time_pos or nil
    render_pill()
    emit_pill_state()
    return
  end

  -- Auto-skip honors `marker.autoSkip` (driven by the desktop's
  -- introSkipEnabled / creditsSkipEnabled toggles). The pill stays visible
  -- during a brief grace window so the user has a chance to dismiss or click
  -- through, matching streaming-service UX. After AUTO_SKIP_DELAY_SECONDS the
  -- skip fires once per activation (rewinding back into the marker / re-
  -- approaching end-of-media won't re-trigger because the key stays in
  -- `auto_skip_fired`).
  --
  -- Mid-marker entry suppression: when the user RESUMES or SEEKS directly
  -- into the middle of an intro/credits zone, we want NO auto-skip — only
  -- manual click. Detected by: on the first refresh where the marker is
  -- active, `last_time_pos` is either nil (first ever observation, likely a
  -- resume) or >= marker.startSeconds (we appeared inside, not naturally
  -- crossing the boundary). The suppression key matches the auto-skip key so
  -- the elapsed-arm block below will skip arming.
  --
  -- Three kinds eligible:
  --   skip_intro     — marker-keyed
  --   skip_credits   — marker-keyed
  --   next_episode   — marker-keyed when driven by a credits marker;
  --                    end-of-media-fallback uses a synthetic per-file key
  --                    so the same 5s pre-roll applies even when the metadata service
  --                    has no credits marker for this episode.
  local action = pill_state.active
  local has_eligible_kind =
    action.kind == "skip_intro" or action.kind == "skip_credits" or action.kind == "next_episode"
  local triggers_auto_skip =
    has_eligible_kind and action.autoSkip and (action.marker ~= nil or action.endOfMediaFallback == true)
  if triggers_auto_skip then
    local key = action.marker and marker_identity(action.marker) or end_of_media_key()
    -- First time we observe this marker active in the current activation
    -- window: decide whether it counts as natural progression or mid-marker
    -- entry. We do this BEFORE the auto_skip_media_elapsed branch so the
    -- decision is made exactly once per activation.
    if not playback_state.auto_skip_fired[key]
      and not playback_state.auto_skip_media_elapsed[key]
      and not playback_state.auto_skip_suppressed[key]
    then
      local boundary = action.marker and action.marker.startSeconds
        or (mp.get_property_number("duration", 0) - playback_state.fallback_countdown_seconds)
      local crossed_naturally =
        type(playback_state.last_time_pos) == "number"
        and type(boundary) == "number"
        and playback_state.last_time_pos < boundary
      if not crossed_naturally then
        playback_state.auto_skip_suppressed[key] = true
        msg.info(string.format(
          "[sf-skip] suppressed (mid-marker entry) kind=%s key=%s last_time_pos=%s boundary=%s",
          action.kind,
          key,
          tostring(playback_state.last_time_pos),
          tostring(boundary)
        ))
      end
    end
    if not playback_state.auto_skip_fired[key] and not playback_state.auto_skip_suppressed[key] then
      local elapsed = playback_state.auto_skip_media_elapsed[key]
      if elapsed == nil then
        elapsed = 0
        msg.info(string.format(
          "[sf-skip] armed kind=%s key=%s time_pos=%s delay=%ds (media time)",
          action.kind,
          key,
          tostring(time_pos),
          AUTO_SKIP_DELAY_SECONDS
        ))
      else
        elapsed = elapsed + media_delta
      end
      playback_state.auto_skip_media_elapsed[key] = elapsed
      -- Override the pill's countdown so the user sees seconds-until-auto-skip,
      -- not the unrelated "time remaining in the marker window" default. The
      -- label for next_episode flips to "Next episode will start in" so the
      -- countdown reads as a pre-roll, not a generic timer.
      local auto_remaining = math.max(0, AUTO_SKIP_DELAY_SECONDS - elapsed)
      action.countdown = auto_remaining
      if action.kind == "next_episode" then
        action.label = skip_text.nextEpisodeIn
      end
      -- Never fire while paused; the 1e-6 absorbs float drift from summing
      -- per-frame deltas.
      if not paused and elapsed >= AUTO_SKIP_DELAY_SECONDS - 1e-6 then
        playback_state.auto_skip_fired[key] = true
        set_countdown_ticking(false)
        msg.info(string.format(
          "[sf-skip] firing kind=%s key=%s media_elapsed=%.2f time_pos=%s",
          action.kind,
          key,
          elapsed,
          tostring(time_pos)
        ))
        if trigger_active_action() then
          playback_state.last_time_pos = type(time_pos) == "number" and time_pos or nil
          emit_pill_state()
          return
        end
      else
        set_countdown_ticking(true)
      end
    else
      set_countdown_ticking(false)
    end
  else
    set_countdown_ticking(false)
  end
  playback_state.last_time_pos = type(time_pos) == "number" and time_pos or nil
  render_pill()
  emit_pill_state()
end

countdown_timer = mp.add_periodic_timer(AUTO_SKIP_TICK_SECONDS, refresh_pill)
countdown_timer:stop()

local function apply_playback_json(payload)
  local ok, parsed = pcall(utils.parse_json, payload or "")
  if not ok or type(parsed) ~= "table" then
    return
  end
  -- An envelope for other media (next episode) while a pill is held across
  -- a reload: that pill belongs to the previous media, clear it now. The
  -- same media's re-send is byte-identical and keeps the hold.
  if pill_state.reload_hold and payload ~= playback_state.cached_envelope_payload then
    drop_held_pill("envelope for other media")
  end
  -- Cache the raw payload so the file-loaded handler can re-apply it if a
  -- late start-file wiped the markers (slow resume/direct launch race).
  -- Stored on every successful apply so the cache always reflects the most
  -- recent episode's envelope.
  playback_state.cached_envelope_payload = payload
  local markers = {}
  if type(parsed.markers) == "table" then
    for _, marker in ipairs(parsed.markers) do
      if type(marker) == "table" and type(marker.startSeconds) == "number" and type(marker.endSeconds) == "number" then
        table.insert(markers, {
          type = marker.type,
          startSeconds = marker.startSeconds,
          endSeconds = marker.endSeconds,
          -- PLAY-SKIP-02: credits are never skipped on their own.
          autoSkip = marker.autoSkip == true and marker.type ~= "credits",
          ask = marker.ask == true,
        })
        msg.info(string.format(
          "[sf-skip] envelope marker: type=%s start=%.2f end=%.2f autoSkip=%s",
          tostring(marker.type),
          marker.startSeconds,
          marker.endSeconds,
          tostring(marker.autoSkip == true)
        ))
      end
    end
  end
  msg.info(string.format(
    "[sf-skip] apply_playback_json: markers=%d nextEpisode=%s autoplayNextEpisode=%s autoSkipNextEpisode=%s",
    #markers,
    parsed.nextEpisode and "set" or "nil",
    tostring(parsed.autoplayNextEpisode),
    tostring(parsed.autoSkipNextEpisode)
  ))
  -- Do NOT reset auto_skip bookkeeping here. apply_playback_json fires on
  -- every desktop-side metadata refresh (e.g. when MediaPlaybackController's
  -- lazy-fetch lands and useMpvPlaybackEngine re-sends the envelope mid-
  -- countdown), and wiping the timer state mid-pill caused the countdown
  -- to reset to 5s every refresh — never reaching 0. The bookkeeping is
  -- reset on the `start-file` event below, which is what actually
  -- distinguishes "new episode" from "same episode, refreshed metadata".
  -- The once-per-activation guard (`auto_skip_fired`) handles the rewind
  -- case independently of envelope refreshes.
  table.sort(markers, function(left, right)
    return (left.startSeconds or 0) < (right.startSeconds or 0)
  end)
  playback_state.markers = markers
  local next_episode = parsed.nextEpisode
  if type(next_episode) == "table" and type(next_episode.id) == "string" and next_episode.id ~= "" then
    playback_state.next_episode = {
      id = next_episode.id,
      label = type(next_episode.label) == "string" and next_episode.label or "Next episode",
    }
  else
    playback_state.next_episode = nil
  end
  local previous_episode = parsed.previousEpisode
  if type(previous_episode) == "table" and type(previous_episode.id) == "string" and previous_episode.id ~= "" then
    playback_state.previous_episode = {
      id = previous_episode.id,
      label = type(previous_episode.label) == "string" and previous_episode.label or "",
    }
  else
    playback_state.previous_episode = nil
  end
  publish_episode_nav()
  -- What's-playing line (PLAY-OVL-01): tog4in1's title shows ${media-title}.
  -- Kept across start-file so the next episode's title replaces it without a
  -- flash of the stream URL.
  if type(parsed.title) == "string" and parsed.title ~= "" then
    mp.set_property("force-media-title", parsed.title)
    msg.info("[sf-episode] force-media-title=" .. parsed.title)
  end
  -- The meta line under it (MPV-OSC-04): year, episode, "" when the app sends
  -- none. tog4in1 appends the runtime.
  local meta = type(parsed.meta) == "string" and parsed.meta or ""
  mp.set_property_native("user-data/sf/now-playing-meta", meta)
  msg.info("[sf-episode] now-playing-meta=" .. meta)
  playback_state.autoplay_next_episode = parsed.autoplayNextEpisode ~= false
  playback_state.auto_skip_next_episode = parsed.autoSkipNextEpisode == true
  if type(parsed.fallbackCountdownSeconds) == "number" and parsed.fallbackCountdownSeconds > 0 then
    playback_state.fallback_countdown_seconds = parsed.fallbackCountdownSeconds
  else
    playback_state.fallback_countdown_seconds = 15
  end
  -- PLAY-SKIP-10: the control bar's intro / credits button shows on episodes.
  playback_state.skip_menu = parsed.skipMenu == true
  mp.set_property_native("user-data/sf/skip-menu", playback_state.skip_menu)
  msg.info("[sf-skip] skip-menu=" .. tostring(playback_state.skip_menu))
  pill_state.next_requested = false
  refresh_pill()
end

-- Escape exits fullscreen first, otherwise exits playback
mp.add_forced_key_binding("ESC", "sf-esc", function()
  if skip_ui_key("ESC") then
    return
  end
  if mp.get_property_bool("fullscreen") then
    mp.commandv("cycle", "fullscreen")
  else
    mp.commandv("quit")
  end
end)

-- Core transport controls (match desktop UX shortcuts)
mp.add_forced_key_binding("SPACE", "sf-toggle-pause", function()
  mp.commandv("cycle", "pause")
end)
mp.add_forced_key_binding("ENTER", "sf-toggle-pause-enter", function()
  if skip_ui_key("ENTER") then
    return
  end
  if not trigger_active_action() then
    mp.commandv("cycle", "pause")
  end
end)
mp.add_forced_key_binding("KP_ENTER", "sf-toggle-pause-kp-enter", function()
  if skip_ui_key("ENTER") then
    return
  end
  if not trigger_active_action() then
    mp.commandv("cycle", "pause")
  end
end)
mp.add_forced_key_binding("LEFT", "sf-seek-back-10", function()
  if skip_ui_key("LEFT") then
    return
  end
  mp.commandv("seek", -10, "relative")
end)
mp.add_forced_key_binding("RIGHT", "sf-seek-forward-10", function()
  if skip_ui_key("RIGHT") then
    return
  end
  mp.commandv("seek", 10, "relative")
end)
mp.add_forced_key_binding("UP", "sf-volume-up", function()
  mp.commandv("add", "volume", 5)
end)
mp.add_forced_key_binding("DOWN", "sf-volume-down", function()
  mp.commandv("add", "volume", -5)
end)
mp.add_forced_key_binding("m", "sf-mute", function()
  mp.commandv("cycle", "mute")
end)
mp.add_forced_key_binding("f", "sf-fullscreen", function()
  mp.commandv("cycle", "fullscreen")
end)
-- Keep window geometry stable across track switches. Windowed only: on macOS
-- setting autofit/geometry while fullscreen resizes the window out of
-- fullscreen (#2643: the picture shrank to the top-left 70 % after a launch or
-- reload); mpv keeps the windowed size for when fullscreen ends.
local locked_geometry = nil
local geometry_reapply_attempts = 0
local function is_fullscreen()
  return mp.get_property_native("fullscreen") == true
end
local function lock_window_size()
  if is_fullscreen() then
    return
  end
  mp.set_property("autofit", "0")
  mp.set_property("autofit-larger", "0")
  mp.set_property("autofit-smaller", "0")
  mp.set_property("keepaspect-window", "yes")
end

local function reapply_geometry()
  if not locked_geometry or locked_geometry == "" or is_fullscreen() then
    return
  end
  lock_window_size()
  mp.set_property("geometry", locked_geometry)
  if geometry_reapply_attempts > 0 then
    geometry_reapply_attempts = geometry_reapply_attempts - 1
    mp.add_timeout(0.05, reapply_geometry)
  end
end

mp.observe_property("geometry", "string", function(_, value)
  if value and value ~= "" then
    locked_geometry = value
  end
end)

mp.observe_property("video-params", "native", function()
  if locked_geometry then
    geometry_reapply_attempts = 4
    reapply_geometry()
  end
end)

-- Inject subtitle metadata so OSC can show friendly names
mp.register_event("file-loaded", function()
  if not locked_geometry then
    locked_geometry = mp.get_property("geometry")
  end
  lock_window_size()
  geometry_reapply_attempts = 4
  reapply_geometry()
  if user_opts.subtitles == "" then
    return
  end
  local file = io.open(user_opts.subtitles, "r")
  if not file then
    return
  end
  local payload = file:read("*all")
  file:close()
  local ok, list = pcall(utils.parse_json, payload)
  if not ok or type(list) ~= "table" then
    return
  end
  for _, sub in ipairs(list) do
    maybe_add_subtitle(sub.url, sub.title, sub.lang, sub.selected)
  end
end)

local subtitles_applied = false
local pending_subtitles = nil
-- Last subtitle list the renderer sent, kept across start-file for the same
-- reason as playback_state.cached_chapters: a reload / next file fires
-- start-file, which nils pending_subtitles, and the renderer's re-send can land
-- BEFORE that start-file (when the previous file's subtitles_applied was still
-- true) or never come at all (quality reload). file-loaded re-applies from
-- here. Overwritten by every sf-subtitles-json (the renderer always sends it,
-- [] included, so a subtitle-less next episode clears it).
-- @bugfix mpv-subtitles-lost-after-reload
local cached_subtitles = nil
local subtitle_apply_attempts = 0
local subtitle_apply_timer = nil
local chapters_applied = false
local pending_chapters = nil
local chapter_apply_attempts = 0
local chapter_apply_timer = nil

local function chapter_list_matches(value)
  if type(value) ~= "table" or type(pending_chapters) ~= "table" then
    return false
  end
  -- An empty pending list (a chapterless file) matches only an empty
  -- chapter-list, so applying [] settles as "done" instead of retrying.
  if #pending_chapters == 0 then
    return #value == 0
  end
  if #value == 0 or #value ~= #pending_chapters then
    return false
  end
  local first = value[1]
  local last = value[#value]
  local expected_first = pending_chapters[1]
  local expected_last = pending_chapters[#pending_chapters]
  if not first or not last or not expected_first or not expected_last then
    return false
  end
  local first_time = tonumber(first.time) or 0
  local last_time = tonumber(last.time) or 0
  local expected_first_time = tonumber(expected_first.time) or 0
  local expected_last_time = tonumber(expected_last.time) or 0
  if math.abs(first_time - expected_first_time) > 0.001 then
    return false
  end
  if math.abs(last_time - expected_last_time) > 0.001 then
    return false
  end
  return true
end

local function ensure_chapters_applied()
  if not pending_chapters then
    return
  end
  local existing = mp.get_property_native("chapter-list")
  if chapter_list_matches(existing) then
    chapters_applied = true
    return
  end
  local ok_set = pcall(mp.set_property_native, "chapter-list", pending_chapters)
  if ok_set then
    local updated = mp.get_property_native("chapter-list")
    if chapter_list_matches(updated) then
      chapters_applied = true
      return
    end
  else
    mp.msg.warn("Failed to set chapter list via IPC payload")
  end
end

mp.register_event("start-file", function()
  subtitles_applied = false
  chapters_applied = false
  added_subtitles = {}
  pending_subtitles = nil
  subtitle_apply_attempts = 0
  if subtitle_apply_timer then
    subtitle_apply_timer:kill()
    subtitle_apply_timer = nil
  end
  pending_chapters = nil
  chapter_apply_attempts = 0
  if chapter_apply_timer then
    chapter_apply_timer:kill()
    chapter_apply_timer = nil
  end
  playback_state.markers = {}
  playback_state.next_episode = nil
  playback_state.previous_episode = nil
  publish_episode_nav()
  playback_state.auto_skip_media_elapsed = {}
  playback_state.auto_skip_fired = {}
  playback_state.auto_skip_suppressed = {}
  playback_state.last_time_pos = nil
  playback_state.end_approach = nil
  -- A pill held across the reload stays as drawn until time-pos is known.
  if not pill_state.reload_hold then
    pill_state.active = nil
  end
  pill_state.next_requested = false
  set_countdown_ticking(false)
  reset_skip_ui()
end)

local function ensure_subtitles_applied()
  if not pending_subtitles then
    return
  end
  for _, sub in ipairs(pending_subtitles) do
    maybe_add_subtitle(sub.url, sub.title, sub.lang, sub.selected)
  end
  -- Check if at least one subtitle was actually added to mpv's track list
  local tracks = mp.get_property_native("track-list")
  if type(tracks) == "table" then
    for _, track in ipairs(tracks) do
      if track.type == "sub" and track.external then
        subtitles_applied = true
        pending_subtitles = nil
        if subtitle_apply_timer then
          subtitle_apply_timer:kill()
          subtitle_apply_timer = nil
        end
        return
      end
    end
  end
end

-- Retry ensure_subtitles_applied every 0.5 s (up to 20 times) until mpv's
-- track-list shows an external subtitle: right after start-file / file-loaded
-- mpv can still reject sub-add while the demuxer is opening.
local function schedule_subtitle_retry()
  if subtitles_applied or subtitle_apply_timer or not pending_subtitles then
    return
  end
  subtitle_apply_timer = mp.add_periodic_timer(0.5, function()
    if not pending_subtitles then
      subtitle_apply_timer:kill()
      subtitle_apply_timer = nil
      return
    end
    if subtitles_applied then
      subtitle_apply_timer:kill()
      subtitle_apply_timer = nil
      return
    end
    subtitle_apply_attempts = subtitle_apply_attempts + 1
    if subtitle_apply_attempts > 20 then
      subtitle_apply_timer:kill()
      subtitle_apply_timer = nil
      mp.msg.warn("subtitle retry exhausted after 20 attempts")
      return
    end
    ensure_subtitles_applied()
  end)
end

mp.register_event("file-loaded", function()
  -- Re-apply the cached subtitle list when this file has none applied yet: a
  -- reload's / next file's start-file wiped pending_subtitles, and the
  -- renderer's re-send either landed before that start-file or never came.
  -- @bugfix mpv-subtitles-lost-after-reload
  if not subtitles_applied and not pending_subtitles and cached_subtitles and #cached_subtitles > 0 then
    msg.info(string.format(
      "[sf-subs] file-loaded: re-applying %d cached subtitle(s) (reload / late start-file)",
      #cached_subtitles
    ))
    pending_subtitles = cached_subtitles
  end
  ensure_subtitles_applied()
  schedule_subtitle_retry()
  ensure_chapters_applied()
  -- Re-apply the cached envelope if a LATE start-file wiped the markers.
  -- start-file fires when mpv commits to a playlist entry; on the slow
  -- resume/direct-launch path the HLS stream can take 30+ s to open, so the
  -- renderer's eagerly-sent envelope (markers) lands BEFORE start-file, and
  -- start-file then clears playback_state.markers. file-loaded fires AFTER
  -- start-file, so re-applying here restores the markers for the rest of the
  -- session. Guarded on "markers currently empty" so we don't redundantly
  -- re-apply when the envelope arrived after start-file (the normal case).
  -- @bugfix mpv-late-start-file-wipes-skip-markers
  if #playback_state.markers == 0 and playback_state.cached_envelope_payload then
    msg.info("[sf-skip] file-loaded: markers empty — re-applying cached envelope (late start-file race)")
    apply_playback_json(playback_state.cached_envelope_payload)
  end
  -- Re-apply chapters if a late/second start-file wiped pending_chapters. Same
  -- race as the cached-envelope re-apply above, but chapters live on their own
  -- channel: a reload (quality change, or an early init re-fire) fires a second
  -- start-file that nils pending_chapters, and the renderer's chapter re-send
  -- can land BEFORE that start-file (then be ignored as already-applied), so
  -- without this the chapter ticks vanish from the seekbar for the rest of the
  -- session. Guarded on "chapter-list empty" + "cached chapters present" so a
  -- chapterless file (cached_chapters == {}) correctly stays chapterless.
  -- @bugfix mpv-chapters-disappear-after-reload
  if not chapters_applied and playback_state.cached_chapters and #playback_state.cached_chapters > 0 then
    local existing_chapters = mp.get_property_native("chapter-list")
    if type(existing_chapters) ~= "table" or #existing_chapters == 0 then
      msg.info("[sf-chapters] file-loaded: chapter-list empty — re-applying cached chapters (late start-file race)")
      pending_chapters = playback_state.cached_chapters
      ensure_chapters_applied()
    end
  end
  -- Reset last_time_pos so the FIRST refresh_pill on the freshly-loaded HLS
  -- stream observes nil and treats an already-active marker as mid-marker
  -- entry (suppress auto-skip). Necessary because the renderer's
  -- backdrop→HLS handoff makes refresh_pill see backdrop time-pos rising
  -- 0→~3 before the actual HLS takes over at the requested resume position.
  -- Without this reset, last_time_pos ≈ 3 < marker.startSeconds = 5, and
  -- sf.lua would treat the resume as natural progression and arm auto-skip.
  -- Set AFTER the cached-envelope re-apply above (apply_playback_json's
  -- internal refresh_pill would otherwise leave last_time_pos at the resume
  -- time-pos). The other auto-skip bookkeeping (auto_skip_fired,
  -- auto_skip_media_elapsed, auto_skip_suppressed) is reset on start-file.
  msg.info("[sf-skip] file-loaded reset of last_time_pos")
  playback_state.last_time_pos = nil
end)

mp.register_event("playback-restart", function()
  ensure_subtitles_applied()
  ensure_chapters_applied()
end)

mp.observe_property("chapter-list", "native", function(_, value)
  if not pending_chapters then
    return
  end
  if chapter_list_matches(value) then
    chapters_applied = true
    if chapter_apply_timer then
      chapter_apply_timer:kill()
      chapter_apply_timer = nil
    end
    return
  end
  ensure_chapters_applied()
end)

mp.observe_property("track-list", "native", function()
  if not pending_chapters then
    return
  end
  ensure_chapters_applied()
end)

local function apply_subtitles_json(payload)
  local ok, list = pcall(utils.parse_json, payload or "")
  if not ok or type(list) ~= "table" then
    return
  end
  -- Cache BEFORE anything else so the cache tracks the latest file even when
  -- this send lands before a reload's start-file. No early return on
  -- subtitles_applied: that flag can be stale (previous file, start-file not
  -- yet delivered) and used to drop the new list for good;
  -- maybe_add_subtitle already dedups per file, so a redundant re-send is a
  -- no-op. @bugfix mpv-subtitles-lost-after-reload
  cached_subtitles = list
  if #list == 0 then
    return
  end
  pending_subtitles = list
  ensure_subtitles_applied()
  schedule_subtitle_retry()
end

local function apply_chapters_json(payload)
  local ok, list = pcall(utils.parse_json, payload or "")
  if not ok or type(list) ~= "table" then
    return
  end
  local chapters = {}
  for i, chapter in ipairs(list) do
    local start = tonumber(chapter.startSeconds) or 0
    local title = chapter.title or ("Chapter " .. tostring(i))
    table.insert(chapters, { time = start, title = title })
  end
  -- Cache the latest chapters for THIS file BEFORE the already-applied
  -- early-return, so the cache always tracks the current file even when a
  -- redundant re-send arrives while chapters are already applied. file-loaded
  -- re-applies from here if a reload's second start-file wipes pending_chapters.
  -- Mirrors playback_state.cached_envelope_payload.
  -- @bugfix mpv-chapters-disappear-after-reload
  playback_state.cached_chapters = chapters
  if chapters_applied then
    return
  end
  pending_chapters = chapters
  chapters_applied = false
  ensure_chapters_applied()
  if not chapter_apply_timer then
    chapter_apply_timer = mp.add_periodic_timer(1, function()
      if not pending_chapters then
        chapter_apply_timer:kill()
        chapter_apply_timer = nil
        return
      end
      if chapters_applied then
        chapter_apply_timer:kill()
        chapter_apply_timer = nil
        return
      end
      chapter_apply_attempts = chapter_apply_attempts + 1
      if chapter_apply_attempts > 60 then
        chapter_apply_timer:kill()
        chapter_apply_timer = nil
        return
      end
      ensure_chapters_applied()
    end)
  end
end

mp.register_script_message("sf-subtitles-json", apply_subtitles_json)
mp.register_script_message("sf-chapters-json", apply_chapters_json)
mp.register_script_message("sf-playback-json", apply_playback_json)
-- MPV-AUDIO-01: the app saw the audio clock freeze (output not taking sound)
-- and went on without sound ("stalled"); MPV-AUDIO-02: no sound output could
-- be opened (reason "no-output"); or sound is back / being retried
-- ("cleared"). Channel: LUA_CHANNELS.AUDIO_STALL in @space/mpv-protocol.
mp.register_script_message("sf-audio-stall", function(payload)
  local ok, parsed = pcall(utils.parse_json, payload or "")
  if not ok or type(parsed) ~= "table" then
    msg.warn("[sf-audio-stall] unparseable payload: " .. tostring(payload))
    return
  end
  if parsed.state == "stalled" then
    pill_state.audio_stall = { output = parsed.output, device = parsed.device, reason = parsed.reason }
    msg.warn(string.format("[sf-audio-stall] notice shown: reason=%s output=%s device=%s",
      tostring(parsed.reason), tostring(parsed.output), tostring(parsed.device)))
  else
    pill_state.audio_stall = nil
    msg.info("[sf-audio-stall] notice cleared (" .. tostring(parsed.state) .. ")")
  end
  refresh_pill()
end)
-- The audio notice's text in the UI language; sf-select.lua reads the same
-- payload for the track menus. A missing or empty key keeps the previous text.
mp.register_script_message("sf-labels-json", function(payload)
  local ok, parsed = pcall(utils.parse_json, payload or "")
  if not ok or type(parsed) ~= "table" then
    return
  end
  for key in pairs(audio_text) do
    if type(parsed[key]) == "string" and parsed[key] ~= "" then
      audio_text[key] = parsed[key]
    end
  end
  if type(parsed.skip) == "table" then
    for key in pairs(skip_text) do
      if type(parsed.skip[key]) == "string" and parsed.skip[key] ~= "" then
        skip_text[key] = parsed.skip[key]
      end
    end
    msg.info("[sf-skip] skip texts from the app: " .. skip_text.skipIntro)
    render_skip_ui()
  end
  refresh_pill()
end)
-- tog4in1's centre previous / next episode buttons (PLAY-OVL-03).
mp.register_script_message("sf-episode-nav", on_episode_nav)
-- E2E hook: lets tests simulate a manual pill click without keypress
-- synthesis. Production callers (the user) hit the ENTER key bindings above.
mp.register_script_message("sf-skip-confirm", function()
  trigger_active_action()
end)
-- E2E hook (ultimate stress suite): reply with the current pill and its rect
-- in mp.get_mouse_pos() pixels (the JSON IPC `mouse` command's space), so a
-- test can click the real pill. No-op unless a client sends the message.
mp.register_script_message("sf-e2e-pill", function()
  local p = pill_state.active
  local payload = {
    active = p ~= nil,
    kind = p and p.kind or nil,
    rect = pill_state.rect,
  }
  local ok, encoded = pcall(utils.format_json, payload)
  if not ok or type(encoded) ~= "string" then
    msg.warn("[sf-e2e-pill] failed to encode pill payload")
    return
  end
  msg.info("[sf-e2e-pill] " .. encoded)
  mp.commandv("script-message", "sf-e2e-pill-json", encoded)
end)

-- tog4in1 only publishes its top band (user-data/sf/osc-top-band, for the
-- pill's place), not its whole chrome, so for click-to-pause we
-- approximate its chrome with y-bands: bottom ~17% (heightoscShowHidearea=120/720)
-- for the seekbar/buttons, top ~5% for window controls. Clicks there don't toggle.
local function click_inside_tog4in1_chrome(mouse_y, osd_height)
  if not osd_height or osd_height <= 0 then return false end
  return mouse_y >= (osd_height * 0.83) or mouse_y <= (osd_height * 0.05)
end

-- Click-vs-drag state (MPV-CLICK-01): a press on the picture toggles pause
-- only when it is a real click. Moving 3 px with the button held starts mpv's
-- window drag (begin-vo-dragging), which releases MBTN_LEFT as a CANCELED up;
-- the window then moves with the pointer, so the pointer barely moves inside
-- it. A canceled up, a move of more than a few pixels, or a hold longer than
-- 250 ms is not a click.
local toggle_click_state = { x = nil, y = nil, t = nil }
local TOGGLE_CLICK_MAX_PIXELS = 4
local TOGGLE_CLICK_MAX_SECONDS = 0.25

local function handle_pill_mouse(event)
  if skip_ui_mouse(event) then
    return
  end
  local pill_active = pill_state.active and pill_state.rect
  local mx, my = mp.get_mouse_pos()
  mx = mx or -1
  my = my or -1
  local _, osd_h = mp.get_osd_size()
  local inside_pill = pill_active and
    mx >= pill_state.rect.left and mx <= pill_state.rect.right and
    my >= pill_state.rect.top and my <= pill_state.rect.bottom
  local outside_chrome = not click_inside_tog4in1_chrome(my, osd_h)

  -- Record the cursor position + time on "down" so the matching "up" can
  -- decide whether this was a click or a drag.
  if event.event == "down" and not inside_pill and outside_chrome then
    toggle_click_state.x = mx
    toggle_click_state.y = my
    toggle_click_state.t = mp.get_time()
  end

  -- Click-to-pause fallback: only on "up", outside the pill, outside tog4in1
  -- chrome, AND the down→up movement was small and brief. Drag (window-move)
  -- and long-press do not toggle. "cancel"/"press" never toggle.
  if event.event == "up" and event.canceled then
    msg.info(string.format("[sf-click] canceled MBTN_LEFT up at %s,%s (window drag or another key): no pause toggle", tostring(mx), tostring(my)))
    toggle_click_state.x = nil
    toggle_click_state.y = nil
    toggle_click_state.t = nil
  elseif event.event == "up" and not inside_pill and outside_chrome then
    local sx, sy, st = toggle_click_state.x, toggle_click_state.y, toggle_click_state.t
    toggle_click_state.x = nil
    toggle_click_state.y = nil
    toggle_click_state.t = nil
    if sx and sy and st then
      local dx = math.abs(mx - sx)
      local dy = math.abs(my - sy)
      local dt = mp.get_time() - st
      if dx <= TOGGLE_CLICK_MAX_PIXELS and dy <= TOGGLE_CLICK_MAX_PIXELS
          and dt <= TOGGLE_CLICK_MAX_SECONDS then
        msg.info(string.format("[sf-click] click on the picture (dx=%d dy=%d dt=%.3f): toggling pause", dx, dy, dt))
        mp.commandv("cycle", "pause")
        if pill_active then
          pill_state.pressed = false
          render_pill()
        end
        return
      end
      msg.info(string.format("[sf-click] press on the picture is not a click (dx=%d dy=%d dt=%.3f): no pause toggle", dx, dy, dt))
    end
  end

  if not pill_active then
    pill_state.pressed = false
    return
  end
  pill_state.mouse_x = mx
  pill_state.mouse_y = my
  if event.event == "down" then
    pill_state.pressed = inside_pill
    render_pill()
    return
  end
  if event.event == "up" then
    local should_apply = pill_state.pressed and inside_pill and not event.canceled
    pill_state.pressed = false
    render_pill()
    if should_apply then
      trigger_active_action()
    end
    return
  end
  if event.event == "cancel" or event.event == "press" then
    pill_state.pressed = false
    render_pill()
  end
end

mp.add_forced_key_binding("MBTN_LEFT", "sf-pill-click", handle_pill_mouse, { complex = true })

-- P9 (#25): tog4in1's forced window-controls/input sections sit above ours and
-- forward MBTN_LEFT down/up that land inside the published pill rect here.
mp.register_script_message("sf-pill-mouse", function(what)
  local mx, my = mp.get_mouse_pos()
  msg.info(string.format("[sf-pill] forwarded MBTN_LEFT %s at %s,%s", tostring(what), tostring(mx), tostring(my)))
  handle_pill_mouse({ event = what })
end)

mp.observe_property("time-pos", "number", function()
  refresh_pill()
end)

-- tog4in1 publishes whether its controls show and where their top band ends
-- (OSD px); the pill sits below that band while they show (see pill_box_rect).
mp.observe_property("user-data/sf/osc-top-band", "native", function(_, band)
  local bottom = nil
  if type(band) == "table" and band.visible == true and type(band.bottom) == "number" and band.bottom > 0 then
    bottom = band.bottom
  end
  if bottom == pill_state.top_band_bottom then
    return
  end
  pill_state.top_band_bottom = bottom
  msg.info("[sf-pill] controls top band " .. (bottom and ("shown, pill below y=" .. bottom) or "hidden, pill in the corner"))
  render_pill()
  render_skip_ui()
end)

-- PLAY-SKIP-04: tog4in1 publishes where its seek track runs; the change
-- panel's handles sit on it.
mp.observe_property("user-data/sf/seekbar", "native", function(_, bar)
  skip_ui.seekbar = type(bar) == "table" and bar or nil
  if skip_ui.mode == "panel" or skip_ui.mode == "scope" then
    render_skip_ui()
  end
end)

mp.observe_property("mouse-pos", "native", function(_, pos)
  skip_ui_pointer(pos)
end)

-- The asked line goes away on a pause or a seek (not the skip's own seek,
-- which lands just after it shows).
mp.observe_property("pause", "bool", function(_, paused)
  if paused == true then
    close_skip_asked("pause")
  end
end)
mp.register_event("seek", function()
  if skip_ui.mode == "asked" and mp.get_time() - skip_ui.asked_at > 1.0 then
    close_skip_asked("seek")
  end
end)

-- tog4in1's cy_skip button (PLAY-SKIP-10).
mp.register_script_message("sf-skip-menu", open_skip_menu)
-- The app's answers to sf-skip-edit (LUA_CHANNELS.SKIP_EDIT_JSON).
mp.register_script_message("sf-skip-edit-json", on_skip_edit_answer)

mp.observe_property("duration", "number", function()
  refresh_pill()
end)

-- Playback stopped (no next file): a pill held across the end of the file
-- must not linger on the idle window.
mp.observe_property("idle-active", "bool", function(_, idle)
  if idle == true then
    drop_held_pill("mpv idle")
  end
end)

mp.observe_property("osd-width", "number", function()
  render_pill()
  render_skip_ui()
end)

mp.observe_property("osd-height", "number", function()
  render_pill()
  render_skip_ui()
end)

-- MPV-OSC-05: subtitles and mpv's own messages keep one on-screen size
-- whatever the window size, like the controls. The app launches mpv with
-- --sub-scale-by-window=no and --osd-scale-by-window=no (packages/mpv/src/
-- external.ts), so their text is a fixed number of OSD pixels; times the
-- display's scale (display-hidpi-scale: Windows display scaling, macOS
-- Retina) that is a fixed size in screen points. Subtitles keep the size they
-- had full screen on a 1080-line display at 100 % (mpv's 720-line size x 1.5);
-- messages the size they had in a 720-line window. Picture subtitles (PGS,
-- VobSub) are images on the video and still scale with it. So do styled ASS /
-- SSA subtitles: their positions, signs and karaoke are laid out on the
-- picture, so they keep their authored size (sub-scale 1; mpv applies
-- sub-scale to ASS fonts but not the window rule, so 1.5 would draw them half
-- as big again as authored).
local SUB_SCALE_AT_HIDPI_1 = 1.5
local OSD_SCALE_AT_HIDPI_1 = 1
local SF_AUTHORED_SIZE_SUB_CODECS = { ass = true, ssa = true }
local text_scale = { hidpi = 1, sub_codec = nil }

local function apply_text_scale()
  local hidpi = text_scale.hidpi
  local sub_scale = SF_AUTHORED_SIZE_SUB_CODECS[text_scale.sub_codec or ""] and 1 or SUB_SCALE_AT_HIDPI_1 * hidpi
  mp.set_property_number("sub-scale", sub_scale)
  mp.set_property_number("osd-scale", OSD_SCALE_AT_HIDPI_1 * hidpi)
  msg.info(string.format("[sf-text-scale] display-hidpi-scale=%s sub-codec=%s sub-scale=%s osd-scale=%s",
    tostring(hidpi), tostring(text_scale.sub_codec), tostring(sub_scale), tostring(OSD_SCALE_AT_HIDPI_1 * hidpi)))
end

-- The pill, the subtitles and the messages follow the display's scale (also
-- when the window moves to a display with another one). mpv calls this once
-- at start with the current value.
mp.observe_property("display-hidpi-scale", "number", function(_, hidpi)
  if not hidpi or hidpi <= 0 then hidpi = 1 end
  text_scale.hidpi = hidpi
  apply_text_scale()
  render_pill()
end)

mp.observe_property("current-tracks/sub/codec", "string", function(_, codec)
  if codec == text_scale.sub_codec then return end
  text_scale.sub_codec = codec
  apply_text_scale()
end)

mp.add_periodic_timer(0.1, function()
  if pill_state.active then
    local duration = mp.get_property_number("duration", nil)
    local time_pos = mp.get_property_number("time-pos", nil)
    if pill_state.active.kind == "next_episode" and playback_state.autoplay_next_episode and playback_state.next_episode and type(duration) == "number" and type(time_pos) == "number" then
      if math.max(0, duration - time_pos) <= END_OF_MEDIA_FIRE_SECONDS and not pill_state.next_requested then
        -- P6 (#25): only a genuine end of file advances. A premature EOF
        -- (time-pos jumped into the window) leaves the app to recover the
        -- stream at the real position.
        if playback_state.end_approach == true then
          trigger_active_action()
          return
        end
        if not pill_state.premature_eof_logged then
          pill_state.premature_eof_logged = true
          msg.warn(string.format(
            "[sf-eof] end reached without a natural approach (premature EOF?) time_pos=%.2f duration=%.2f — not opening next episode",
            time_pos,
            duration
          ))
        end
      else
        pill_state.premature_eof_logged = false
      end
    end
    render_pill()
  end
end)

-- Optional: expose track selection via keyboard shortcuts
mp.add_forced_key_binding("v", "sf-select-video", function()
  mp.commandv("script-binding", "sf_select/select-vid")
end)
mp.add_forced_key_binding("a", "sf-select-audio", function()
  mp.commandv("script-binding", "sf_select/select-aid")
end)
mp.add_forced_key_binding("s", "sf-select-sub", function()
  mp.commandv("script-binding", "sf_select/select-sid")
end)

-- #25 size/perf §4.3: mp.add_*_key_binding only marks our sections dirty;
-- mp.defaults flushes (defines + enables) them from its idle handler, which
-- runs before this one. tog4in1 pushes its forced sections only when the OSC's
-- visibility flips, so a flush landing after its first reveal would put our
-- MBTN_LEFT (click-to-pause) above its window controls. Tell it once ours are
-- live so it re-stacks on top. Scripts load on separate threads, so tog4in1's
-- listener may register after our one-shot broadcast: it also asks with
-- "sf-bindings-query" at load, and we answer whenever we are live. Either the
-- broadcast or the reply reaches it, whatever the load order. Broadcasts: no
-- error when tog4in1 is absent.
local bindings_live = false
local function announce_bindings_ready()
  mp.unregister_idle(announce_bindings_ready)
  bindings_live = true
  msg.info("[sf-sections] forced bindings live; broadcasting sf-bindings-ready")
  mp.commandv("script-message", "sf-bindings-ready")
end
mp.register_idle(announce_bindings_ready)
mp.register_script_message("sf-bindings-query", function()
  msg.info("[sf-sections] sf-bindings-query received; live=" .. tostring(bindings_live))
  if bindings_live then mp.commandv("script-message", "sf-bindings-ready") end
end)
