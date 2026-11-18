--
-- Modified mpv select.lua: simplified labels for SpaceBadger UI.
-- Based on upstream mpv player/lua/select.lua (https://github.com/mpv-player/mpv).
-- Copyright (C) mpv contributors. SPDX-License-Identifier: LGPL-2.1-or-later;
-- the licence text is LGPL-2.1.txt in this directory.
--
local utils = require "mp.utils"
local input = require "mp.input"

local options = {
    history_date_format = "%Y-%m-%d %H:%M:%S",
    hide_history_duplicates = true,
}

require "mp.options".read_options(options, nil, function () end)

mp.msg.info("sf-select.lua loaded")

-- MPV-OSC-03: the track / chapter menu (mpv's console, `input.select`) looks
-- like the phone player's track sheet (packages/mobile-mpv-playback/src/
-- components/PlayerControls.tsx): Inter text on an opaque #1f1f22 sheet with
-- rounded corners, the focused row lifted with white at 14% like the TV's
-- focused row. The console draws its menu background in osd-outline-color
-- (osd-border-style is outline-and-shadow) and re-reads its script-opts when
-- they change. Set here so the app and the tests get the same look.
mp.set_property("osd-font", "Inter")
mp.set_property("osd-outline-color", "#1F1F22")
for _, opt in ipairs({
    "console-background_alpha=0",
    "console-corner_radius=16",
    "console-padding=16",
    "console-gap=0.5",
    "console-focused_back_color=#3E3E41",
    "console-focused_color=#FFFFFF",
    "console-match_color=#FFB357",
    -- MPV-OSC-05: the menus keep one on-screen size: the console's font in
    -- pixels times display-hidpi-scale, not scaled with the window height
    -- (its "auto" follows osd-scale-by-window, default yes: osd-height / 720).
    "console-scale_with_window=no",
}) do
    mp.commandv("change-list", "script-opts", "append", opt)
end
local audio_label_overrides = {}
local audio_override_payload = nil

local function show_warning(message)
    mp.msg.warn(message)
    if mp.get_property_native("vo-configured") then
        mp.osd_message(message)
    end
end

local function show_error(message)
    mp.msg.error(message)
    if mp.get_property_native("vo-configured") then
        mp.osd_message(message)
    end
end

mp.add_key_binding(nil, "select-playlist", function ()
    local playlist = {}
    local default_item
    local show = mp.get_property_native("osd-playlist-entry")
    local trailing_slash_pattern = mp.get_property("platform") == "windows"
                                   and "[/\\]+$" or "/+$"

    for i, entry in ipairs(mp.get_property_native("playlist")) do
        playlist[i] = entry.title
        if not playlist[i] or show ~= "title" then
            playlist[i] = entry.filename
            if not playlist[i]:find("://") then
                playlist[i] = select(2, utils.split_path(
                    playlist[i]:gsub(trailing_slash_pattern, "")))
            end
        end
        if entry.title and show == "both" then
            playlist[i] = string.format("%s (%s)", entry.title, playlist[i])
        end

        if entry.playing then
            default_item = i
        end
    end

    if #playlist == 0 then
        show_warning("The playlist is empty.")
        return
    end

    input.select({
        prompt = "Select a playlist entry:",
        items = playlist,
        default_item = default_item,
        submit = function (index)
            mp.commandv("playlist-play-index", index - 1)
        end,
    })
end)

local function format_flags(track)
    local flags = ""

    for _, flag in ipairs({
        "default", "forced", "dependent", "visual-impaired", "hearing-impaired",
        "image", "external"
    }) do
        if track[flag] then
            flags = flags .. flag .. " "
        end
    end

    if flags == "" then
        return ""
    end

    return " [" .. flags:sub(1, -2) .. "]"
end

local function label_from_height(height)
    if not height then
        return nil
    end
    if height >= 2160 then
        return "4K"
    end
    if height >= 1440 then
        return "1440p"
    end
    if height >= 1000 then
        return "1080p"
    end
    if height >= 1080 then
        return "1080p"
    end
    if height >= 720 then
        return "720p"
    end
    if height >= 480 then
        return "480p"
    end
    if height >= 420 then
        return "420p"
    end
    if height >= 360 then
        return "360p"
    end
    if height >= 240 then
        return "240p"
    end
    if height >= 144 then
        return "144p"
    end
    return tostring(height) .. "p"
end

local function label_from_dimensions(width, height)
    if width then
        if width >= 3800 then
            return "4K"
        end
        if width >= 2560 and (not height or height >= 1200) then
            return "1440p"
        end
        if width >= 1900 then
            return "1080p"
        end
    end
    return label_from_height(height)
end

local function strip_suffix_flags(label)
    if not label or label == "" then
        return label
    end
    local cleaned = label
    local changed = true
    while changed do
        changed = false
        local next_label = cleaned:gsub("%s*%b[]%s*$", "")
        if next_label ~= cleaned then
            cleaned = next_label
            changed = true
        end
        next_label = cleaned:gsub("%s*%b()%s*$", "")
        if next_label ~= cleaned then
            cleaned = next_label
            changed = true
        end
    end
    return cleaned
end

local function is_generic_audio_label(label)
    if not label or label == "" then
        return true
    end
    local normalized = label:lower():gsub("%s+", "")
    return normalized == "audio" or normalized == "unknown" or normalized == "und"
end

local function rebuild_audio_label_overrides()
    audio_label_overrides = {}
    if type(audio_override_payload) ~= "table" then
        return
    end
    local audio_tracks = {}
    for _, track in ipairs(mp.get_property_native("track-list") or {}) do
        if track.type == "audio" and track.id then
            audio_tracks[#audio_tracks + 1] = track
        end
    end
    for index, track in ipairs(audio_tracks) do
        local payload = audio_override_payload[index]
        if type(payload) == "table" then
            local label = strip_suffix_flags(payload.title) or strip_suffix_flags(payload.label)
            if label and label ~= "" then
                audio_label_overrides[track.id] = label
            end
        end
    end
end

local function format_track_label(track)
    if track.type == "video" then
        local width = track["demux-w"] or track.w
        local height = track["demux-h"] or track.h
        return label_from_dimensions(width, height) or strip_suffix_flags(track.title) or "Video"
    end
    if track.type == "audio" then
        if track.id and audio_label_overrides[track.id] and audio_label_overrides[track.id] ~= "" then
            return audio_label_overrides[track.id]
        end
        local title = strip_suffix_flags(track.title)
        if title and not is_generic_audio_label(title) then
            return title
        end
        return track.lang or "Audio"
    end
    if track.type == "sub" then
        return strip_suffix_flags(track.title) or track.lang or "Subtitle"
    end
    return strip_suffix_flags(track.title) or track.lang or track.type
end

local function apply_audio_json(payload)
    local ok, list = pcall(utils.parse_json, payload or "")
    if not ok or type(list) ~= "table" then
        audio_override_payload = nil
        audio_label_overrides = {}
        return
    end
    audio_override_payload = list
    rebuild_audio_label_overrides()
end

mp.observe_property("track-list", "native", function ()
    rebuild_audio_label_overrides()
end)

mp.register_script_message("sf-audio-json", apply_audio_json)

local function format_track(track)
    return (track.selected and "●" or "○") .. " " .. format_track_label(track)
end

-- Tell the app which track the user picked (issue #25 P18). mpv's IPC turns
-- this into a `client-message` the renderer stores, so a quality / ABR reload
-- (`loadfile … replace`) carries the pick instead of reverting to the default
-- track. aid/sid are carried on reloads; a vid pick is a quality pick the
-- app turns into a manual format switch that stops ABR (issue #25 P19).
-- Other properties (secondary-sid) are not sent.
-- Channel name: LUA_OUTBOUND_CHANNELS.TRACK_PICKED in @space/mpv-protocol.
local track_property_for_type = { audio = "aid", sub = "sid", video = "vid" }
local function emit_track_picked(property, value)
    if property ~= "aid" and property ~= "sid" and property ~= "vid" then
        return
    end
    local encoded = tostring(value)
    mp.msg.info("track picked in OSC: " .. property .. "=" .. encoded)
    mp.commandv("script-message", "sf-track-picked", property, encoded)
end

mp.add_key_binding(nil, "select-track", function ()
    local tracks = {}

    for i, track in ipairs(mp.get_property_native("track-list")) do
        tracks[i] = (track.image and "Image" or
                     track.type:sub(1, 1):upper() .. track.type:sub(2)) .. ": " ..
                    format_track(track)
    end

    if #tracks == 0 then
        show_warning("No available tracks.")
        return
    end

    input.select({
        prompt = "Select a track:",
        items = tracks,
        submit = function (id)
            local track = mp.get_property_native("track-list/" .. id - 1)
            if track then
                local value = track.selected and "no" or track.id
                mp.set_property(track.type, value)
                emit_track_picked(track_property_for_type[track.type], value)
            end
        end,
    })
end)

-- Label of the subtitle menu's "Off" row. The app pushes the UI-language string
-- (i18n `player.subtitlesOff`: "Off" / "Aucun") on `sf-labels-json`; "Off" is the
-- fallback until it arrives. Channel name: LUA_CHANNELS.LABELS_JSON in @space/mpv-protocol.
local subtitles_off_label = "Off"
-- Label of the subtitle menu's "Get more subtitles…" row (PLAY-SUBGET-02), also
-- pushed on `sf-labels-json`. Empty (the default) hides the row: the app sends
-- it only when this film or episode can be searched.
local get_more_subtitles_label = ""
-- Label of the "Try another version" row after it (PLAY-SUBGET-07), pushed on
-- `sf-labels-json` non-empty only while the subtitle that is on was fetched; the
-- row shows only while a subtitle is on.
local try_another_version_label = ""

-- The track menus' prompts and empty-state lines, also pushed on `sf-labels-json`
-- in the UI language (i18n `player.menu*`); English until the app's payload arrives.
local menu_text = {
    selectSubtitle = "Select a subtitle:",
    selectSecondarySubtitle = "Select a secondary subtitle:",
    selectAudioTrack = "Select an audio track:",
    selectVideoTrack = "Select a video track:",
    noSubtitles = "No available subtitles.",
    noAudioTracks = "No available audio tracks.",
    noVideoTracks = "No available video tracks.",
}

local function apply_labels_json(payload)
    local ok, parsed = pcall(utils.parse_json, payload or "")
    if not ok or type(parsed) ~= "table" then
        return
    end
    if type(parsed.subtitlesOff) == "string" and parsed.subtitlesOff ~= "" then
        subtitles_off_label = parsed.subtitlesOff
    end
    if type(parsed.getMoreSubtitles) == "string" then
        get_more_subtitles_label = parsed.getMoreSubtitles
    end
    if type(parsed.tryAnotherVersion) == "string" then
        try_another_version_label = parsed.tryAnotherVersion
    end
    for key in pairs(menu_text) do
        if type(parsed[key]) == "string" and parsed[key] ~= "" then
            menu_text[key] = parsed[key]
        end
    end
end

mp.register_script_message("sf-labels-json", apply_labels_json)

-- mpv reports an off track property as `false` over the property API ("no" when
-- set); both mean "no track selected".
local function track_property_is_off(value)
    return value == nil or value == false or value == "no"
end

-- Marks the "Off" row in `rows` (every other row is a track-list entry).
local OFF_ROW = { off = true, id = 0 }
-- Marks the subtitle menu's last row, "Get more subtitles…" (PLAY-SUBGET-02).
local FETCH_ROW = { fetch = true, id = -1 }
-- Marks "Try another version" (PLAY-SUBGET-07), after "Get more subtitles…".
local VERSION_ROW = { version = true, id = -2 }
-- Channel name: LUA_OUTBOUND_CHANNELS.SUBTITLE_FETCH in @space/mpv-protocol.
local function emit_subtitle_fetch(...)
    mp.commandv("script-message", "sf-subtitle-fetch", ...)
end

-- The subtitle menu (property "sid") leads with an "Off" row so a subtitle can be
-- turned off without re-submitting the selected track (#25, Orchard: single French
-- subtitle, nothing to click to turn it off). The Off row is the current row, and
-- the cursor's start row, whenever no subtitle is selected. Every other menu
-- (aid, secondary-sid) keeps its toggle: submitting the selected track turns it off.
local function select_track(property, type, prompt, warning)
    local with_off = property == "sid"
    local with_fetch = with_off and get_more_subtitles_label ~= ""
    local tracks = {}
    local track_id = mp.get_property_native(property)

    for _, track in ipairs(mp.get_property_native("track-list")) do
        if track.type == type then
            tracks[#tracks + 1] = track
        end
    end

    -- The subtitle menu always opens, with nothing searched: Off, every subtitle
    -- the title already has, then "Get more subtitles…", the only row that
    -- searches online (PLAY-SUBGET-24). Other menus with nothing to pick warn.
    if #tracks == 0 and not with_fetch then
        show_warning(warning)
        return
    end

    local rows = {}
    local items = {}
    local default_item

    if with_off then
        rows[1] = OFF_ROW
        items[1] = (track_property_is_off(track_id) and "●" or "○") .. " " .. subtitles_off_label
        if track_property_is_off(track_id) then
            default_item = 1
        end
    end
    for _, track in ipairs(tracks) do
        rows[#rows + 1] = track
        items[#items + 1] = format_track(track)
        if track.id == track_id then
            default_item = #items
        end
    end
    if with_fetch then
        rows[#rows + 1] = FETCH_ROW
        items[#items + 1] = "+ " .. get_more_subtitles_label
    end
    if with_off and try_another_version_label ~= "" and not track_property_is_off(track_id) then
        rows[#rows + 1] = VERSION_ROW
        items[#items + 1] = "+ " .. try_another_version_label
    end

    -- Test-only introspection for the e2e-ultimate OSC checks (issue #25):
    -- the menu's exact entries, their track ids (0 = the Off row, -1 = "Get
    -- more subtitles…") and the
    -- cursor's start row. Published only under SF_E2E=1; no behaviour change.
    local e2e = os.getenv("SF_E2E") == "1"
    if e2e then
        local ids = {}
        for i, row in ipairs(rows) do
            ids[i] = row.id
        end
        mp.set_property_native("user-data/sf/e2e/select", {
            open = true, property = property, type = type, prompt = prompt,
            items = items, ids = ids, default_item = default_item or 0,
            openedAt = mp.get_time(),
        })
    end

    input.select({
        prompt = prompt,
        items = items,
        default_item = default_item,
        submit = function (id)
            local row = rows[id]
            if e2e then
                mp.set_property_native("user-data/sf/e2e/select", { open = false, submitted = row.id })
            end
            if row == FETCH_ROW then
                emit_subtitle_fetch("open")
                return
            end
            if row == VERSION_ROW then
                emit_subtitle_fetch("version")
                return
            end
            local value
            if row == OFF_ROW then
                value = "no"
            elseif with_off then
                -- Explicit pick: submitting the current subtitle keeps it on.
                value = row.id
            else
                value = row.selected and "no" or row.id
            end
            -- Re-setting the value mpv already has makes it refresh-seek (the
            -- replay loop sf.lua's "select" sub-add avoids): skip it, but still
            -- report the pick so the app records it.
            if not (with_off and ((row == OFF_ROW and track_property_is_off(mp.get_property_native(property)))
                                  or (row ~= OFF_ROW and row.selected))) then
                mp.set_property(property, value)
            end
            emit_track_picked(property, value)
        end,
        closed = function ()
            if e2e and (mp.get_property_native("user-data/sf/e2e/select") or {}).open then
                mp.set_property_native("user-data/sf/e2e/select", { open = false })
            end
        end,
    })
end

mp.add_key_binding(nil, "select-sid", function ()
    select_track("sid", "sub", menu_text.selectSubtitle, menu_text.noSubtitles)
end)

-- "Get more subtitles…" (PLAY-SUBGET-02): the app runs the search, download
-- and storage and tells this script what to draw over the paused video on
-- `sf-subtitle-fetch-json` (LUA_CHANNELS.SUBTITLE_FETCH_JSON):
--   { panel = text, dismissable = bool }  a centred panel ("Looking for subtitles…",
--                                         "Downloading"); Escape leaves it when dismissable
--   { list = { prompt, items = { { key, label } } } }  the language list (this menu)
--   { close = true }                      nothing
-- Answers go back on `sf-subtitle-fetch`: "pick" <key>, or "cancel" when the
-- list or a dismissable panel is left.
-- MPV-OSC-05: drawn in logical pixels (OSD pixels / display-hidpi-scale), so the
-- panel keeps one on-screen size whatever the window size; re-laid out on resize.
local fetch_panel = mp.create_osd_overlay("ass-events")
local fetch_panel_shown = nil
local FETCH_DISMISS_BINDING = "sf-subtitle-fetch-dismiss"
local FETCH_PANEL_WIDTH = 640
-- Logical px kept clear on each side of a panel narrowed to fit a small window.
local FETCH_PANEL_SIDE_MARGIN = 16
local FETCH_PANEL_CHARS_PER_LINE = 44

local function ass_escape(text)
    return (text:gsub("\\", "\\\239\187\191"):gsub("{", "\\{"):gsub("}", "\\}"))
end

-- Breaks the panel's text into lines that fit the panel (libass wraps at the
-- screen's edges, not the panel's): 44 characters at the full width, fewer in
-- a panel narrowed to fit the window.
local function wrap_panel_text(text, chars_per_line)
    local lines, line = {}, ""
    for word in text:gmatch("%S+") do
        if line ~= "" and #line + 1 + #word > chars_per_line then
            lines[#lines + 1] = line
            line = word
        else
            line = line == "" and word or (line .. " " .. word)
        end
    end
    if line ~= "" then lines[#lines + 1] = line end
    return lines
end

local function publish_fetch_e2e(state)
    if os.getenv("SF_E2E") == "1" then
        mp.set_property_native("user-data/sf/e2e/subtitle-fetch", state)
    end
end

local function hide_fetch_panel()
    mp.remove_key_binding(FETCH_DISMISS_BINDING)
    fetch_panel_shown = nil
    fetch_panel.data = ""
    fetch_panel:update()
end

-- `text` is the raw panel text; it is wrapped here, for the panel's width at
-- this window size.
local function draw_fetch_panel(text)
    local osd_w, osd_h = mp.get_osd_size()
    local hidpi = mp.get_property_number("display-hidpi-scale", 1)
    if not hidpi or hidpi <= 0 then hidpi = 1 end
    if not osd_w or osd_w <= 0 or not osd_h or osd_h <= 0 then osd_w, osd_h = 1280, 720 end
    fetch_panel.res_x, fetch_panel.res_y = osd_w / hidpi, osd_h / hidpi
    -- One fixed width, narrowed only when the window is too small for it.
    local w = math.min(FETCH_PANEL_WIDTH, fetch_panel.res_x - 2 * FETCH_PANEL_SIDE_MARGIN)
    local chars = math.max(8, math.floor(FETCH_PANEL_CHARS_PER_LINE * w / FETCH_PANEL_WIDTH))
    local lines = {}
    for i, line in ipairs(wrap_panel_text(text, chars)) do
        lines[i] = ass_escape(line)
    end
    local height = 56 + 36 * math.max(#lines, 1)
    local cx, cy = fetch_panel.res_x / 2, fetch_panel.res_y / 2
    local h = height
    fetch_panel.data = string.format(
        "{\\an5\\pos(%d,%d)\\bord0\\shad0\\1c&H221F1F&\\p1}m 0 0 l %d 0 %d %d 0 %d{\\p0}\n" ..
        "{\\an5\\pos(%d,%d)\\bord0\\shad0\\fnInter\\fs28\\1c&HFFFFFF&\\q2}%s",
        cx, cy, w, w, h, h, cx, cy, table.concat(lines, "\\N"))
    fetch_panel:update()
end

mp.observe_property("osd-dimensions", "native", function()
    if fetch_panel_shown then draw_fetch_panel(fetch_panel_shown) end
end)
mp.observe_property("display-hidpi-scale", "number", function()
    if fetch_panel_shown then draw_fetch_panel(fetch_panel_shown) end
end)

-- The same opaque #1F1F22 sheet and Inter text as the track menus (MPV-OSC-03).
local function show_fetch_panel(text, dismissable)
    fetch_panel_shown = text
    draw_fetch_panel(text)
    mp.remove_key_binding(FETCH_DISMISS_BINDING)
    if dismissable then
        mp.add_forced_key_binding("ESC", FETCH_DISMISS_BINDING, function ()
            hide_fetch_panel()
            publish_fetch_e2e({ closed = true })
            emit_subtitle_fetch("cancel")
        end)
    end
    publish_fetch_e2e({ panel = text, dismissable = dismissable == true })
end

local function show_fetch_list(list)
    hide_fetch_panel()
    local keys, items = {}, {}
    for i, item in ipairs(list.items or {}) do
        keys[i] = tostring(item.key)
        items[i] = tostring(item.label)
    end
    local submitted = false
    publish_fetch_e2e({ list = items, keys = keys, prompt = list.prompt })
    input.select({
        prompt = list.prompt or "",
        items = items,
        submit = function (index)
            submitted = true
            publish_fetch_e2e({ picked = keys[index] })
            emit_subtitle_fetch("pick", keys[index])
        end,
        closed = function ()
            if not submitted then
                publish_fetch_e2e({ closed = true })
                emit_subtitle_fetch("cancel")
            end
        end,
    })
end

mp.register_script_message("sf-subtitle-fetch-json", function (payload)
    local ok, view = pcall(utils.parse_json, payload or "")
    if not ok or type(view) ~= "table" then
        return
    end
    if type(view.panel) == "string" then
        show_fetch_panel(view.panel, view.dismissable == true)
    elseif type(view.list) == "table" then
        show_fetch_list(view.list)
    elseif view.close then
        hide_fetch_panel()
        publish_fetch_e2e({ closed = true })
    end
end)

mp.add_key_binding(nil, "select-secondary-sid", function ()
    select_track("secondary-sid", "sub", menu_text.selectSecondarySubtitle,
                 menu_text.noSubtitles)
end)

mp.add_key_binding(nil, "select-aid", function ()
    select_track("aid", "audio", menu_text.selectAudioTrack,
                 menu_text.noAudioTracks)
end)

mp.add_key_binding(nil, "select-vid", function ()
    select_track("vid", "video", menu_text.selectVideoTrack,
                 menu_text.noVideoTracks)
end)

-- Times like the phone player's formatTime (and tog4in1's timecodes, MPV-OSC-03):
-- m:ss, h:mm:ss from one hour. A copy: mpv scripts share no module path here.
local function format_time(seconds)
    if not seconds or seconds ~= seconds or seconds <= 0 or seconds == math.huge then
        return "0:00"
    end
    local h = math.floor(seconds / 3600)
    local m = math.floor((seconds % 3600) / 60)
    local s = math.floor(seconds % 60)
    if h > 0 then
        return string.format("%d:%02d:%02d", h, m, s)
    end
    return string.format("%d:%02d", m, s)
end

mp.add_key_binding(nil, "select-chapter", function ()
    local chapters = {}
    local default_item = mp.get_property_native("chapter")

    if default_item == nil then
        show_warning("No available chapters.")
        return
    end

    for i, chapter in ipairs(mp.get_property_native("chapter-list")) do
        chapters[i] = format_time(chapter.time) .. " " .. chapter.title
    end

    input.select({
        prompt = "Select a chapter:",
        items = chapters,
        default_item = default_item + 1,
        submit = function (index)
            mp.set_property("chapter", index - 1)
        end,
    })
end)
