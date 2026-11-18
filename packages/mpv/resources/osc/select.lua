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

local function format_track_label(track)
    if track.type == "video" then
        return label_from_height(track["demux-h"]) or track.title or "Video"
    end
    if track.type == "audio" then
        return track.title or track.lang or "Audio"
    end
    if track.type == "sub" then
        return track.title or track.lang or "Subtitle"
    end
    return track.title or track.lang or track.type
end

local function format_track(track)
    return (track.selected and "●" or "○") .. " " ..
        format_track_label(track) .. format_flags(track)
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
                mp.set_property(track.type, track.selected and "no" or track.id)
            end
        end,
    })
end)

local function select_track(property, type, prompt, warning)
    local tracks = {}
    local items = {}
    local default_item
    local track_id = mp.get_property_native(property)

    for _, track in ipairs(mp.get_property_native("track-list")) do
        if track.type == type then
            tracks[#tracks + 1] = track
            items[#items + 1] = format_track(track)

            if track.id == track_id then
                default_item = #items
            end
        end
    end

    if #items == 0 then
        show_warning(warning)
        return
    end

    input.select({
        prompt = prompt,
        items = items,
        default_item = default_item,
        submit = function (id)
            mp.set_property(property, tracks[id].selected and "no" or tracks[id].id)
        end,
    })
end

mp.add_key_binding(nil, "select-sid", function ()
    select_track("sid", "sub", "Select a subtitle:", "No available subtitles.")
end)

mp.add_key_binding(nil, "select-secondary-sid", function ()
    select_track("secondary-sid", "sub", "Select a secondary subtitle:",
                 "No available subtitles.")
end)

mp.add_key_binding(nil, "select-aid", function ()
    select_track("aid", "audio", "Select an audio track:",
                 "No available audio tracks.")
end)

mp.add_key_binding(nil, "select-vid", function ()
    select_track("vid", "video", "Select a video track:",
                 "No available video tracks.")
end)

local function format_time(t, duration)
    local fmt = math.max(t, duration) >= 60 * 60 and "%H:%M:%S" or "%M:%S"
    return mp.format_time(t, fmt)
end

mp.add_key_binding(nil, "select-chapter", function ()
    local chapters = {}
    local default_item = mp.get_property_native("chapter")

    if default_item == nil then
        show_warning("No available chapters.")
        return
    end

    local duration = mp.get_property_native("duration", math.huge)

    for i, chapter in ipairs(mp.get_property_native("chapter-list")) do
        chapters[i] = format_time(chapter.time, duration) .. " " .. chapter.title
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

