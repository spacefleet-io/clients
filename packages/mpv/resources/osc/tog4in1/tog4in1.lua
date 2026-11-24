-- SPDX-License-Identifier: LGPL-2.1-or-later
--
-- tog4in1.lua, the desktop player's on-screen controller.
--
-- Derived from mpv's built-in OSC (player/lua/osc.lua), copyright the mpv
-- developers (https://github.com/mpv-player/mpv), through this chain of forks:
--   mpv-osc-modern by maoiscat         https://github.com/maoiscat/mpv-osc-modern
--   ModernX by cyl0                    https://github.com/cyl0/ModernX
--   modernx.lua by dexeonify           https://github.com/dexeonify/mpv-config
--   mpv-modern-x-compact by 1-minute-to-midnight
--                                      https://github.com/1-minute-to-midnight/mpv-modern-x-compact
--   tog4in1 by zTnR                    https://github.com/zTnR/mpv-osc-tog4in1
--                                      (tog4in1-Multi/tog4in1.lua, commit fcaa253)
-- Modified by SpaceFleet (the SpaceBadger player controls).
--
-- This file is free software: you can redistribute it and/or modify it under
-- the terms of the GNU Lesser General Public License as published by the Free
-- Software Foundation, either version 2.1 of the License, or (at your option)
-- any later version. It is distributed WITHOUT ANY WARRANTY; without even the
-- implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See
-- the GNU Lesser General Public License, in ../LGPL-2.1.txt, for details.

local ipairs,loadfile,pairs,pcall,tonumber,tostring = ipairs,loadfile,pairs,pcall,tonumber,tostring
local debug,io,math,os,string,table,utf8 = debug,io,math,os,string,table,utf8
local min,max,floor,ceil,huge = math.min,math.max,math.floor,math.ceil,math.huge
local mp		= require "mp"
local assdraw	= require "mp.assdraw"
local msg		= require "mp.msg"
local opt		= require "mp.options"
local utils		= require "mp.utils"

--
-- Parameters
--

local user_opts = {
	showwindowed = true,					-- show OSC when windowed?
	showfullscreen = true,					-- show OSC when fullscreen?
	idlescreen = false,						-- show mpv logo on idle
	-- MPV-OSC-05: one on-screen size whatever the window size, windowed and
	-- fullscreen alike: OSD pixels per layout unit, times the display's HiDPI
	-- scale (display-hidpi-scale: Windows display scaling, macOS Retina,
	-- Wayland / Xft.dpi). Upstream's separate fullscreen scale (2.8) made the
	-- controls jump 40 % on fullscreen; vidscale grew them with the window.
	scalewindowed = 2.0,					-- OSD px per layout unit at HiDPI scale 1 (every window size)
	scaleforcedwindow = 1,					-- same, when rendered on a forced window without video
	vidscale = false,						-- MPV-OSC-05: never scale the controller with the video
	boxalpha = 80,							-- opacity of the background box (thumbnail), 0 (opaque) to 255 (transparent)
	alphaUntoggledButton = 166,				-- opacity untoggled / disabled button, 0 (opaque) to 255 (transparent): the phone's 0.35 (MPV-OSC-03)
	seekrangealpha = 64,					-- transparency of seekranges
	seekbarhandlesize = 0,					-- size ratio of the knob handle
	seekbarkeyframes = true,				-- use keyframes when dragging the seekbar
	hidetimeout = 0,						-- duration in ms until the OSC hides (case "don't show on mouse move")
	fadeduration = 0,						-- duration of fade out in ms, 0 = no fade (case "don't show on mouse move")
	hidetimeoutMouseMove = 1000,			-- duration in ms until the OSC hides (case "show on mouse move")
	fadedurationMouseMove = 500,			-- duration of fade out in ms, 0 = no fade (case "show on mouse move")
	minmousemove = 1,						-- min amount of pixels for OSC to show up (Don't show < 0, show >= 0)
	layout = "modernx",						-- set thumbnail layout
	title = "${media-title}",				-- what's playing line (PLAY-OVL-01): the desktop app sets force-media-title via sf.lua
	timetotal = false,						-- display total time instead of remaining time?
	visibility = "auto",					-- only used at init to set visibility_mode(...)
	-- (SpaceBadger, MPV-OSC-04) no window controls: the top-left back chip closes the player
	livemarkers = true,						-- update seekbar chapter markers on duration change
	chapters_osd = false,					-- whether to show chapters OSD on next/prev
	playlist_osd = false,					-- whether to show playlist OSD on next/prev
	chapter_fmt = "Chapter: %s",			-- chapter print format for seekbar-hover. "no" to disable
	showonpause = true,						-- show OSC on pause
	showonstart = true,						-- show OSC on startup or when the next file in playlist starts playing
	showonseek = true,						-- show OSC when seeking
	oscFont = "Inter",						-- the phone player's font (MPV-OSC-03): title, timecodes, labels, menus
	tick_delay = 1 / 60,					-- minimum interval between OSC redraws in seconds
	seekrangestyle = "none",				-- display demuxer cache in seekbar
	tick_delay_follow_display_fps = false,  -- use display fps as the minimum interval
    volume_control = true,                  -- show mute button and volume slider
    volume_control_type = "linear",         -- volume scale type: "linear" or "logarithmic"

	-- tog4in1

	minimalSeekY = 30,					    -- Height minimal UI
	jumpValue = 5,						    -- Default jump value in s (From OSC only)
	smallIcon = 20,						    -- Dimensions in px of small icons
	seekbarHeight = 0,					    -- seekbar height offset
	showCache = false,					    -- Show cache
	showInfos = false,					    -- Toggle Statistics
	showThumbfast = true,				    -- Toggle Thumbfast
	showTooltip = false,				    -- Toggle Tooltips
	showChapters = true, 				    -- Toggle chapters on / off
	showTitle = true,					    -- show title in OSC (SpaceBadger: always, PLAY-OVL-01)
	showIcons = false,					    -- show extra buttons
	onTopWhilePlaying = false, 			    -- Toggle On top while playing
	oscMode = "default",				    -- Toggle OSC Modes default / onpause / always
	heightoscShowHidearea = 120,		    -- Height show / hide osc area
	heightwcShowHidearea = 48,			    -- Height of the top band (back chip, title, meta line; MPV-OSC-04)
	visibleButtonsW = 300,				    -- Max width for bottom OSC side buttons visible
}

-- read options from config and command-line
opt.read_options(user_opts, "osc", function(list) update_options(list) end)

-- deus0ww - 2021-11-26

-----------
-- Utils --
-----------

local OS_MAC, OS_WIN, OS_NIX = "MAC", "WIN", "NIX"
local function get_os()
	if jit and jit.os then
		if jit.os == "Windows" then return OS_WIN
		elseif jit.os == "OSX" then return OS_MAC
		else return OS_NIX end
	end
	if (package.config:sub(1,1) ~= "/") then return OS_WIN end
	local res = mp.command_native({ name = "subprocess", args = {"uname", "-s"}, playback_only = false, capture_stdout = true, capture_stderr = true, })
	return (res and res.stdout and res.stdout:lower():find("darwin") ~= nil) and OS_MAC or OS_NIX
end
local OPERATING_SYSTEM = get_os()

local function format_json(tab)
	local json, err = utils.format_json(tab)
	if err then msg.error("Formatting JSON failed:", err) end
	if json then return json else return "" end
end

local function parse_json(json)
	local tab, err = utils.parse_json(json, true)
	if err then msg.error("Parsing JSON failed:", err) end
	if tab then return tab else return {} end
end

local function join_paths(...)
	local sep = OPERATING_SYSTEM == OS_WIN and "\\" or "/"
	local result = ""
	for _, p in ipairs({...}) do
		result = (result == "") and p or result .. sep .. p
	end
	return result
end

--------------------
-- Data Structure --
--------------------

local tn_state, tn_osc, tn_osc_options, tn_osc_stats
local tn_thumbnails_indexed, tn_thumbnails_ready
local tn_gen_time_start, tn_gen_duration

local function reset_all()
	tn_state			  = nil
	tn_osc = {
		cursor				= {},
		position			= {},
		scale				= {},
		osc_scale			= {},
		spacer				= {},
		osd					= {},
		background			= {text = "︎✇",},
		font_scale			= {},
		display_progress  	= {},
		progress			= {},
		mini				= {text = "⚆",},
		thumbnail = {
			visible	  		= false,
			path_last		= nil,
			x_last	   		= nil,
			y_last	   		= nil,
		},
	}
	tn_osc_options		= nil
	tn_osc_stats = {
		queued				= 0,
		processing			= 0,
		ready				= 0,
		failed				= 0,
		total				= 0,
		total_expected		= 0,
		percent				= 0,
		timer				= 0,
	}
	tn_thumbnails_indexed 	= {}
	tn_thumbnails_ready   	= {}
	tn_gen_time_start	 	= nil
	tn_gen_duration	   		= nil
end

-------------------
-- Thumbnail OSC --
-------------------

local message = {
	osc = {
		registration	= "tn_osc_registration",
		reset			= "tn_osc_reset",
		update			= "tn_osc_update",
		finish			= "tn_osc_finish",
	},
	debug = "Thumbnailer-debug",

	queued		= 1,
	processing	= 2,
	ready		= 3,
	failed		= 4,
}

local osc_reg = {
	script_name = mp.get_script_name(),
	osc_opts = {
		scalewindowed   = user_opts.scalewindowed,
		scalefullscreen = user_opts.scalewindowed,
	},
}
mp.command_native({"script-message", message.osc.registration, format_json(osc_reg)})

local tn_palette = {
	black			= "000000",
	white			= "FFFFFF",
	alpha_opaque 	= 0,
	alpha_clear  	= 255,
	alpha_black  	= min(255, user_opts.boxalpha),
	alpha_white  	= min(255, user_opts.boxalpha + (255 - user_opts.boxalpha) * 0.8),
}

local tn_style_format = {
	background		= "{\\bord0\\1c&H%s&\\1a&H%X&}",
	subbackground	= "{\\bord0\\1c&H%s&\\1a&H%X&}",
	spinner 		= "{\\bord0\\fs%d\\fscx%f\\fscy%f",
	spinner2		= "\\1c&%s&\\1a&H%X&\\frz%d}",
	closest_index	= "{\\1c&H%s&\\1a&H%X&\\3c&H%s&\\3a&H%X&\\xbord%d\\ybord%d}",
	progress_mini	= "{\\bord0\\1c&%s&\\1a&H%X&\\fs18\\fscx%f\\fscy%f",
	progress_mini2	= "\\frz%d}",
	progress_block	= "{\\bord0\\1c&H%s&\\1a&H%X&}",
	progress_text   = "{\\1c&%s&\\3c&H%s&\\1a&H%X&\\3a&H%X&\\blur0.25\\fs18\\fscx%f\\fscy%f\\xbord%f\\ybord%f}",
	text_timer		= "%.2ds",
	text_progress	= "%.3d/%.3d",
	text_progress2	= "[%d]",
	text_percent	= "%d%%",
}

local tn_style = {
	background		= (tn_style_format.background):format(tn_palette.black, tn_palette.alpha_black),
	subbackground	= (tn_style_format.subbackground):format(tn_palette.white, tn_palette.alpha_white),
	spinner			= (tn_style_format.spinner):format(0, 1, 1),
	closest_index	= (tn_style_format.closest_index):format(tn_palette.white, tn_palette.alpha_black, tn_palette.black, tn_palette.alpha_black, -1, -1),
	progress_mini	= (tn_style_format.progress_mini):format(tn_palette.white, tn_palette.alpha_opaque, 1, 1),
	progress_block	= (tn_style_format.progress_block):format(tn_palette.white, tn_palette.alpha_white),
	progress_text	= (tn_style_format.progress_text):format(tn_palette.white, tn_palette.black, tn_palette.alpha_opaque, tn_palette.alpha_black, 1, 1, 2, 2),
}

local function set_thumbnail_above(offset)
	local tn_osc = tn_osc
	tn_osc.background.bottom	= tn_osc.position.y - offset - tn_osc.spacer.bottom
	tn_osc.background.top		= tn_osc.background.bottom - tn_osc.background.h
	tn_osc.thumbnail.top		= tn_osc.background.bottom - tn_osc.thumbnail.h
	tn_osc.progress.top			= tn_osc.background.bottom - tn_osc.background.h
	tn_osc.progress.mid			= tn_osc.progress.top + tn_osc.progress.h * 0.5
	tn_osc.background.rotation	= -1
end

local function set_thumbnail_below(offset)
	local tn_osc = tn_osc
	tn_osc.background.top		= tn_osc.position.y + offset + tn_osc.spacer.top
	tn_osc.thumbnail.top		= tn_osc.background.top
	tn_osc.progress.top			= tn_osc.background.top + tn_osc.thumbnail.h + tn_osc.spacer.y
	tn_osc.progress.mid			= tn_osc.progress.top + tn_osc.progress.h * 0.5
	tn_osc.background.rotation	= 1
end

local function set_mini_above() tn_osc.mini.y = (tn_osc.background.top - 12 * tn_osc.osc_scale.y) end
local function set_mini_below() tn_osc.mini.y = (tn_osc.background.bottom + 12 * tn_osc.osc_scale.y) end

local set_thumbnail_layout = {
	topbar	= function()	tn_osc.spacer.top = 0.25
							set_thumbnail_below(38.75)
							set_mini_above() end,
	bottombar = function()  tn_osc.spacer.bottom = 0.25
							set_thumbnail_above(38.75)
							set_mini_below() end,
	box	   = function()		set_thumbnail_above(15)
							set_mini_above() end,
	slimbox   = function()  set_thumbnail_above(12)
							set_mini_above() end,
	modernx   = function()  set_thumbnail_above(20)
							set_mini_below() end,
}

local function update_tn_osc_params(seek_y)
	local tn_state, tn_osc_stats, tn_osc, tn_style, tn_style_format = tn_state, tn_osc_stats, tn_osc, tn_style, tn_style_format
	tn_osc.scale.x, tn_osc.scale.y		= get_virt_scale_factor()
	tn_osc.osd.w, tn_osc.osd.h			= mp.get_osd_size()
	tn_osc.cursor.x, tn_osc.cursor.y	= get_virt_mouse_pos()
	tn_osc.position.y					= seek_y

	local osc_changed = false
	if	 tn_osc.scale.x_last ~= tn_osc.scale.x or tn_osc.scale.y_last ~= tn_osc.scale.y
		or tn_osc.w_last ~= tn_state.width or tn_osc.h_last ~= tn_state.height
		or tn_osc.osd.w_last ~= tn_osc.osd.w or tn_osc.osd.h_last ~= tn_osc.osd.h
	then
		tn_osc.scale.x_last, tn_osc.scale.y_last = tn_osc.scale.x, tn_osc.scale.y
		tn_osc.w_last, tn_osc.h_last			 = tn_state.width, tn_state.height
		tn_osc.osd.w_last, tn_osc.osd.h_last	 = tn_osc.osd.w, tn_osc.osd.h
		osc_changed = true
	end

	if osc_changed then
		tn_osc.osc_scale.x, tn_osc.osc_scale.y   = 1, 1
		tn_osc.spacer.x, tn_osc.spacer.y		 = tn_osc_options.spacer, tn_osc_options.spacer
		tn_osc.font_scale.x, tn_osc.font_scale.y = 100, 100
		tn_osc.progress.h						 = (16 + tn_osc_options.spacer)
		if not user_opts.vidscale then
			tn_osc.osc_scale.x  = tn_osc.scale.x * tn_osc_options.scale
			tn_osc.osc_scale.y  = tn_osc.scale.y * tn_osc_options.scale
			tn_osc.spacer.x	 = tn_osc.osc_scale.x * tn_osc.spacer.x
			tn_osc.spacer.y	 = tn_osc.osc_scale.y * tn_osc.spacer.y
			tn_osc.font_scale.x = tn_osc.osc_scale.x * tn_osc.font_scale.x
			tn_osc.font_scale.y = tn_osc.osc_scale.y * tn_osc.font_scale.y
			tn_osc.progress.h   = tn_osc.osc_scale.y * tn_osc.progress.h
		end
		tn_osc.spacer.top, tn_osc.spacer.bottom  = tn_osc.spacer.y, tn_osc.spacer.y
		tn_osc.thumbnail.w, tn_osc.thumbnail.h   = tn_state.width * tn_osc.scale.x, tn_state.height * tn_osc.scale.y
		tn_osc.osd.w_scaled, tn_osc.osd.h_scaled = tn_osc.osd.w * tn_osc.scale.x, tn_osc.osd.h * tn_osc.scale.y
		tn_style.spinner						 = (tn_style_format.spinner):format(min(tn_osc.thumbnail.w, tn_osc.thumbnail.h) * 0.6667, tn_osc.font_scale.x, tn_osc.font_scale.y)
		tn_style.closest_index					 = (tn_style_format.closest_index):format(tn_palette.white, tn_palette.alpha_black, tn_palette.black, tn_palette.alpha_black, -1 * tn_osc.scale.x, -1 * tn_osc.scale.y)
		if tn_osc_stats.percent < 1 then
			tn_style.progress_text = (tn_style_format.progress_text):format(tn_palette.white, tn_palette.black, tn_palette.alpha_opaque, tn_palette.alpha_black, tn_osc.font_scale.x, tn_osc.font_scale.y, 2 * tn_osc.scale.x, 2 * tn_osc.scale.y)
			tn_style.progress_mini = (tn_style_format.progress_mini):format(tn_palette.white, tn_palette.alpha_opaque, tn_osc.font_scale.x, tn_osc.font_scale.y)
		end
	end

	if not tn_osc.position.y then return end
	if (osc_changed or tn_osc.cursor.x_last ~= tn_osc.cursor.x) and tn_osc.osd.w_scaled >= (tn_osc.thumbnail.w + 2 * tn_osc.spacer.x) then
		tn_osc.cursor.x_last  = tn_osc.cursor.x
		if tn_osc_options.centered then
			tn_osc.position.x = tn_osc.osd.w_scaled * 0.5
		else
			local limit_left  = tn_osc.spacer.x + tn_osc.thumbnail.w * 0.5
			local limit_right = tn_osc.osd.w_scaled - limit_left
			tn_osc.position.x = min(max(tn_osc.cursor.x, limit_left), limit_right)
		end
		tn_osc.thumbnail.left, tn_osc.thumbnail.right = tn_osc.position.x - tn_osc.thumbnail.w * 0.5, tn_osc.position.x + tn_osc.thumbnail.w * 0.5
		tn_osc.mini.x = tn_osc.thumbnail.right - 6 * tn_osc.osc_scale.x
	end

	if (osc_changed or tn_osc.display_progress.last ~= tn_osc.display_progress.current) then
		tn_osc.display_progress.last = tn_osc.display_progress.current
		tn_osc.background.h = tn_osc.thumbnail.h + (tn_osc.display_progress.current and (tn_osc.progress.h + tn_osc.spacer.y) or 0)
		set_thumbnail_layout[user_opts.layout]()
	end
end

local function find_closest(seek_index, round_up)
	local tn_state, tn_thumbnails_indexed, tn_thumbnails_ready = tn_state, tn_thumbnails_indexed, tn_thumbnails_ready
	if not (tn_thumbnails_indexed and tn_thumbnails_ready) then return nil, nil end
	local time_index = floor(seek_index * tn_state.delta)
	if tn_thumbnails_ready[time_index] then return seek_index + 1, tn_thumbnails_indexed[time_index] end
	local direction, index = round_up and 1 or -1
	for i = 1, tn_osc_stats.total_expected do
		index		= seek_index + (i * direction)
		time_index	= floor(index * tn_state.delta)
		if tn_thumbnails_ready[time_index] then return index + 1, tn_thumbnails_indexed[time_index] end
		index		= seek_index + (i * -direction)
		time_index	= floor(index * tn_state.delta)
		if tn_thumbnails_ready[time_index] then return index + 1, tn_thumbnails_indexed[time_index] end
	end
	return nil, nil
end

local draw_cmd = { name = "overlay-add",	id = 9, offset = 0, fmt = "bgra" }
local hide_cmd = { name = "overlay-remove", id = 9}

local function draw_thumbnail(x, y, path)
	draw_cmd.x = x
	draw_cmd.y = y
	draw_cmd.file = path
	mp.command_native(draw_cmd)
	tn_osc.thumbnail.visible = true
end

local function hide_thumbnail()
	if tn_osc and tn_osc.thumbnail and tn_osc.thumbnail.visible then
		mp.command_native(hide_cmd)
		tn_osc.thumbnail.visible = false
	end
end

local function show_thumbnail(seek_percent)
	if not seek_percent then return nil, nil end
	local scale, thumbnail, total_expected, ready = tn_osc.scale, tn_osc.thumbnail, tn_osc_stats.total_expected, tn_osc_stats.ready
	local seek = seek_percent * (total_expected - 1)
	local seek_index = floor(seek + 0.5)
	local closest_index, path = thumbnail.closest_index_last, thumbnail.path_last
	if	 thumbnail.seek_index_last		 ~= seek_index
		or thumbnail.ready_last			 ~= ready
		or thumbnail.total_expected_last ~= tn_osc_stats.total_expected
	then
		closest_index, path = find_closest(seek_index, seek_index < seek)
		thumbnail.closest_index_last, thumbnail.total_expected_last, thumbnail.ready_last, thumbnail.seek_index_last = closest_index, total_expected, ready, seek_index
	end
	local x, y = floor((thumbnail.left or 0) / scale.x + 0.5), floor((thumbnail.top or 0) / scale.y + 0.5)
	if path and not (thumbnail.visible and thumbnail.x_last == x and thumbnail.y_last == y and thumbnail.path_last == path) then
		thumbnail.x_last, thumbnail.y_last, thumbnail.path_last  = x, y, path
		draw_thumbnail(x, y, path)
	end
	return closest_index, path
end

local function ass_new(ass, x, y, align, style, text)
	ass:new_event()
	ass:pos(x, y)
	if align then ass:an(align)		end
	if style then ass:append(style) end
	if text  then ass:append(text)  end
end

local function ass_rect(ass, x1, y1, x2, y2)
	ass:draw_start()
	ass:rect_cw(x1, y1, x2, y2)
	ass:draw_stop()
end

local draw_progress = {
	[message.queued]	 = function(ass, index, block_w, block_h) ass:rect_cw((index - 1) * block_w,			 0, index * block_w, block_h) end,
	[message.processing] = function(ass, index, block_w, block_h) ass:rect_cw((index - 1) * block_w, block_h * 0.2, index * block_w, block_h * 0.8) end,
	[message.failed]	 = function(ass, index, block_w, block_h) ass:rect_cw((index - 1) * block_w, block_h * 0.4, index * block_w, block_h * 0.6) end,
}

local function display_tn_osc(seek_y, seek_percent, ass)
	if not (seek_y and seek_percent and ass and tn_state and tn_osc_stats and tn_osc_options and tn_state.width and tn_state.height and tn_state.duration and tn_state.cache_dir) or not tn_osc_options.visible then hide_thumbnail() return end

	update_tn_osc_params(seek_y)
	local tn_osc_stats, tn_osc, tn_style, tn_style_format, ass_new, ass_rect, seek_percent = tn_osc_stats, tn_osc, tn_style, tn_style_format, ass_new, ass_rect, seek_percent * 0.01
	local closest_index, path = show_thumbnail(seek_percent)

	-- Background
	ass_new(ass, tn_osc.thumbnail.left, tn_osc.background.top, 7, tn_style.background)
	ass_rect(ass, -tn_osc.spacer.x, -tn_osc.spacer.top, tn_osc.thumbnail.w + tn_osc.spacer.x, tn_osc.background.h + tn_osc.spacer.bottom)

	local spinner_color, spinner_alpha = tn_palette.white, tn_palette.alpha_white
	if not path then
		ass_new(ass, tn_osc.thumbnail.left, tn_osc.thumbnail.top, 7, tn_style.subbackground)
		ass_rect(ass, 0, 0, tn_osc.thumbnail.w, tn_osc.thumbnail.h)
		spinner_color, spinner_alpha = tn_palette.black, tn_palette.alpha_black
	end
	ass_new(ass, tn_osc.position.x, tn_osc.thumbnail.top + tn_osc.thumbnail.h * 0.5, 5, tn_style.spinner .. (tn_style_format.spinner2):format(spinner_color, spinner_alpha, tn_osc.background.rotation * seek_percent * 1080), tn_osc.background.text)

	-- Mini Progress Spinner
	if tn_osc.display_progress.current ~= nil and not tn_osc.display_progress.current and tn_osc_stats.percent < 1 then
		ass_new(ass, tn_osc.mini.x, tn_osc.mini.y, 5, tn_style.progress_mini .. (tn_style_format.progress_mini2):format(tn_osc_stats.percent * -360 + 90), tn_osc.mini.text)
	end

	-- Progress Bar
	if tn_osc.display_progress.current then
		local block_w, index = tn_osc_stats.total_expected > 0 and tn_state.width * tn_osc.scale.y / tn_osc_stats.total_expected or 0, 0
		if tn_thumbnails_indexed and block_w > 0 then
			-- Loading bar
			ass_new(ass, tn_osc.thumbnail.left, tn_osc.progress.top, 7, tn_style.progress_block)
			ass:draw_start()
			for time_index, status in pairs(tn_thumbnails_indexed) do
				index = floor(time_index / tn_state.delta) + 1
				if index ~= closest_index and not tn_thumbnails_ready[time_index] and index <= tn_osc_stats.total_expected and draw_progress[status] ~= nil then
					draw_progress[status](ass, index, block_w, tn_osc.progress.h)
				end
			end
			ass:draw_stop()

			if closest_index and closest_index <= tn_osc_stats.total_expected then
				ass_new(ass, tn_osc.thumbnail.left, tn_osc.progress.top, 7, tn_style.closest_index)
				ass_rect(ass, (closest_index - 1) * block_w, 0, closest_index * block_w, tn_osc.progress.h)
			end
		end

		-- Text: Timer
		ass_new(ass, tn_osc.thumbnail.left + 3 * tn_osc.osc_scale.y, tn_osc.progress.mid, 4, tn_style.progress_text, (tn_style_format.text_timer):format(tn_osc_stats.timer))

		-- Text: Number or Index of Thumbnail
		local temp = tn_osc_stats.percent < 1 and tn_osc_stats.ready or closest_index
		local processing = tn_osc_stats.processing > 0 and (tn_style_format.text_progress2):format(tn_osc_stats.processing) or ""
		ass_new(ass, tn_osc.position.x, tn_osc.progress.mid, 5, tn_style.progress_text, (tn_style_format.text_progress):format(temp and temp or 0, tn_osc_stats.total_expected) .. processing)

		-- Text: Percentage
		ass_new(ass, tn_osc.thumbnail.right - 3 * tn_osc.osc_scale.y, tn_osc.progress.mid, 6, tn_style.progress_text, (tn_style_format.text_percent):format(min(100, tn_osc_stats.percent * 100)))
	end
end

---------------
-- Listeners --
---------------

mp.register_script_message(message.osc.reset, function()
	hide_thumbnail()
	reset_all()
end)

local text_progress_format = { two_digits = "%.2d/%.2d", three_digits = "%.3d/%.3d" }

mp.register_script_message(message.osc.update, function(json)
	local new_data = parse_json(json)
	if not new_data then return end
	if new_data.state then
		tn_state = new_data.state
		if tn_state.is_rotated then tn_state.width, tn_state.height = tn_state.height, tn_state.width end
		draw_cmd.w = tn_state.width
		draw_cmd.h = tn_state.height
		draw_cmd.stride = tn_state.width * 4
	end
	if new_data.osc_options then tn_osc_options = new_data.osc_options end
	if new_data.osc_stats then
		tn_osc_stats = new_data.osc_stats
		if tn_osc_options and tn_osc_options.show_progress then
			if	 tn_osc_options.show_progress == 0 then tn_osc.display_progress.current = false
			elseif tn_osc_options.show_progress == 1 then tn_osc.display_progress.current = tn_osc_stats.percent < 1
			else										  tn_osc.display_progress.current = true end
		end
		tn_style_format.text_progress = tn_osc_stats.total > 99 and text_progress_format.three_digits or text_progress_format.two_digits
		if tn_osc_stats.percent >= 1 then mp.command_native({"script-message", message.osc.finish}) end
	end
	if new_data.thumbnails and tn_state then
		local index, ready
		for time_string, status in pairs(new_data.thumbnails) do
			index, ready = tonumber(time_string), (status == message.ready)
			tn_thumbnails_indexed[index] = ready and join_paths(tn_state.cache_dir, time_string) .. tn_state.cache_extension or status
			tn_thumbnails_ready[index]   = ready
		end
	end
	request_tick()
end)

mp.register_script_message(message.debug, function()
	msg.info("Thumbnailer OSC Internal States:")
	msg.info("tn_state:", tn_state and utils.to_string(tn_state) or "nil")
	msg.info("tn_thumbnails_indexed:", tn_thumbnails_indexed and utils.to_string(tn_thumbnails_indexed) or "nil")
	msg.info("tn_thumbnails_ready:", tn_thumbnails_ready and utils.to_string(tn_thumbnails_ready) or "nil")
	msg.info("tn_osc_options:", tn_osc_options and utils.to_string(tn_osc_options) or "nil")
	msg.info("tn_osc_stats:", tn_osc_stats and utils.to_string(tn_osc_stats) or "nil")
	msg.info("tn_osc:", tn_osc and utils.to_string(tn_osc) or "nil")
end)

-----------------------------------------------
-- Seek-bar preview pictures (MPV-PREV-01)   --
-----------------------------------------------
-- The desktop app sends `sf-preview-sheets` {width, height, intervalSeconds}
-- for the playing video, or null when it has no previews. While the seekbar
-- is hovered the OSC asks for the moment's picture once per picture slot
-- (`sf-preview-hover <token> <seconds>`; seconds -1 when the pointer leaves),
-- the app answers `sf-preview-picture` {token, path, width, height} with a raw
-- BGRA file, and the OSC draws it above the hover time with overlay-add id 9
-- and confirms with `sf-preview-shown <token>` (the app keeps that file, which
-- overlay-add re-reads when the pointer moves). An answer with path null means
-- that moment has no picture: the previous one is removed, not left showing a
-- wrong moment. A reply whose token is not the latest request is stale and
-- dropped. With no record nothing is drawn: no box, no placeholder.
--
-- MPV-PREV-06: `sf-preview-sheets` {hint} means the video has no pictures
-- yet but they are still to come: while the seekbar is hovered the hint
-- ("Previews are being prepared", UI language) is written in small text
-- above the hover time instead of a picture, and nothing is requested. Null
-- (no record, or generation gave up) still draws nothing.

local sf_preview = {
	info = nil,		-- {width, height, intervalSeconds} of the playing video
	hint = nil,		-- text shown above the hover time while the pictures are being prepared
	token = 0,		-- latest request sent
	slot = nil,		-- picture slot of the latest request (nil: not hovering)
	picture = nil,	-- {path, width, height} of the last accepted reply
	drawn = nil,	-- "x,y,path" of the overlay on screen
}
-- Vertical gap (virtual ASS units) between the seekbar top and the picture: room for the hover time label.
local SF_PREVIEW_LABEL_GAP = 16
local SF_PREVIEW_PAD = 3		-- dark frame around the picture, OSD px
local SF_PREVIEW_MARGIN = 8		-- distance kept from the window's left / right edge, OSD px

local function sf_preview_hide()
	if sf_preview.drawn then
		mp.command_native(hide_cmd)
		sf_preview.drawn = nil
	end
end

-- The pointer left the seekbar (or the OSC hid): remove the picture and cancel the request.
local function sf_preview_leave()
	sf_preview_hide()
	sf_preview.picture = nil
	if sf_preview.slot ~= nil then
		sf_preview.slot = nil
		sf_preview.token = sf_preview.token + 1
		mp.commandv("script-message", "sf-preview-hover", tostring(sf_preview.token), "-1")
	end
end

-- Seekbar hovered at `sliderpos` percent; `tx`, `ty`: hover time label anchor (virtual ASS units, label bottom at ty).
local function sf_preview_draw(ass, tx, ty, sliderpos)
	local info = sf_preview.info
	local duration = mp.get_property_number("duration")
	if not (info and duration and duration > 0) then
		sf_preview_hide()
		return
	end
	local seconds = duration * sliderpos / 100
	local slot = floor(seconds / info.intervalSeconds)
	if slot ~= sf_preview.slot then
		sf_preview.slot = slot
		sf_preview.token = sf_preview.token + 1
		mp.commandv("script-message", "sf-preview-hover", tostring(sf_preview.token), string.format("%.3f", seconds))
	end
	-- Until the first picture arrives nothing is drawn; while scrubbing the previous one stays until the next lands.
	local pic = sf_preview.picture
	if not pic then return end
	local osd_w = mp.get_osd_size()
	local sx, sy = get_virt_scale_factor()
	if not osd_w or osd_w <= 0 or sx == 0 or sy == 0 then return end
	local w, h = pic.width, pic.height
	local x = floor(min(osd_w - w - SF_PREVIEW_MARGIN, max(SF_PREVIEW_MARGIN, tx / sx - w / 2)) + 0.5)
	local y = floor((ty - SF_PREVIEW_LABEL_GAP) / sy - SF_PREVIEW_PAD - h + 0.5)
	ass:new_event()
	ass:pos((x - SF_PREVIEW_PAD) * sx, (y - SF_PREVIEW_PAD) * sy)
	ass:an(7)
	ass:append("{\\bord0\\1c&H000000&\\1a&H50&}")
	ass:draw_start()
	ass:rect_cw(0, 0, (w + 2 * SF_PREVIEW_PAD) * sx, (h + 2 * SF_PREVIEW_PAD) * sy)
	ass:draw_stop()
	local key = x .. "," .. y .. "," .. pic.path
	if sf_preview.drawn ~= key then
		mp.command_native({ name = "overlay-add", id = 9, x = x, y = y, file = pic.path, offset = 0, fmt = "bgra", w = w, h = h, stride = w * 4 })
		sf_preview.drawn = key
	end
end

-- No pictures yet (MPV-PREV-06): one short line above the hover time, kept inside the window.
local function sf_preview_draw_hint(ass, tx, ty)
	local osd_w = mp.get_osd_size()
	local sx = get_virt_scale_factor()
	if not osd_w or osd_w <= 0 or sx == 0 then return end
	local fs = 9
	-- Inter averages about 0.55 em per character; half the line plus the margin stays on screen.
	local half = #sf_preview.hint * fs * 0.55 / 2 + SF_PREVIEW_MARGIN * sx
	local x = min(osd_w * sx - half, max(half, tx))
	ass:new_event()
	ass:pos(x, ty - SF_PREVIEW_LABEL_GAP)
	ass:an(2)
	ass:append("{\\blur0\\bord1\\shad0\\1c&HFFFFFF&\\3c&H000000&\\1a&H30&\\3a&H60&\\fs" .. fs .. "\\fn" .. user_opts.oscFont .. "}")
	ass:append(sf_preview.hint)
end

mp.register_script_message("sf-preview-sheets", function(json)
	local data = utils.parse_json(json or "")
	local info, hint = nil, nil
	if type(data) == "table" and tonumber(data.width) and tonumber(data.height) and tonumber(data.intervalSeconds) and data.intervalSeconds > 0 then
		info = { width = data.width, height = data.height, intervalSeconds = data.intervalSeconds }
	elseif type(data) == "table" and type(data.hint) == "string" then
		-- Plain text only: braces and backslashes would be ASS override tags.
		hint = data.hint:gsub("[{}\\]", ""):sub(1, 80)
		if hint == "" then hint = nil end
	end
	local current = sf_preview.info
	msg.info("[sf-preview] sheets " .. (info and (info.width .. "x" .. info.height) or ("none" .. (hint and (" (hint: " .. hint .. ")") or ""))))
	if hint ~= sf_preview.hint then
		sf_preview.hint = hint
		request_tick()
	end
	-- The app re-sends the record with every metadata update (reloads, skip markers): the same record keeps the hover.
	if (info == nil and current == nil) or (info and current and info.width == current.width and info.height == current.height and info.intervalSeconds == current.intervalSeconds) then
		return
	end
	sf_preview_leave()
	sf_preview.info = info
	request_tick()
end)

mp.register_script_message("sf-preview-picture", function(json)
	local data = utils.parse_json(json or "")
	if type(data) ~= "table" or not sf_preview.info or sf_preview.slot == nil or data.token ~= sf_preview.token then
		msg.debug("[sf-preview] stale picture dropped")
		return
	end
	if type(data.path) ~= "string" or not tonumber(data.width) or not tonumber(data.height) then
		-- No picture for this moment: drop the previous one rather than show the wrong moment.
		msg.debug("[sf-preview] no picture for token " .. tostring(data.token))
		sf_preview_hide()
		sf_preview.picture = nil
		request_tick()
		return
	end
	sf_preview.picture = { path = data.path, width = data.width, height = data.height }
	mp.commandv("script-message", "sf-preview-shown", tostring(data.token))
	request_tick()
end)

-------------
-- tog4in1 --
-------------

--https://github.com/mpv-player/mpv/issues/3201#issuecomment-2016505146

local saveParamsFile = mp.command_native({"expand-path", "~~/saveparams.ini"})

-- create style
function createStyle(blur, bord, color1, color2, font, icon)
	local style =  "{\\blur"..blur.."\\bord"..bord.."\\1c&H" .. color1 .. "&\\3c&H" .. color2 .. "&"
	if font
	then
		style = style.."\\fs"..font.."\\fn"..icon
	end
	return style.."}"
end

-- Times like the phone player's formatTime: m:ss, h:mm:ss from one hour.
function format_time(seconds)
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

-- Runtime for the meta line (MPV-OSC-04): "2h 33m", "2h", "42m"; nil until
-- the duration is known.
function format_runtime(seconds)
	if not seconds or seconds ~= seconds or seconds <= 0 or seconds == math.huge then
		return nil
	end
	local minutes = math.max(1, math.floor(seconds / 60 + 0.5))
	local h, m = math.floor(minutes / 60), minutes % 60
	if h == 0 then
		return string.format("%dm", m)
	elseif m == 0 then
		return string.format("%dh", h)
	end
	return string.format("%dh %dm", h, m)
end

-- The meta line under the title (MPV-OSC-04): sf.lua's now-playing meta (film
-- "1927", episode "S1 · E3 “The Signal” · 2024"), then the runtime ("2h 33m",
-- "42m") once the duration is known; "" when neither is.
function now_playing_meta()
	local parts = {}
	local meta = mp.get_property_native("user-data/sf/now-playing-meta")
	if type(meta) == "string" and meta ~= "" then
		parts[#parts + 1] = (meta:gsub("\n", " "):gsub("{", "\\{"))
	end
	local runtime = format_runtime(mp.get_property_number("duration"))
	if runtime then
		parts[#parts + 1] = runtime
	end
	return table.concat(parts, " · ")
end

-----------------
-- modernx.lua --
-----------------

local osc_param = { -- calculated by osc_init()
	playresy = 0,
	playresx = 0,
	display_aspect = 1,
	unscaled_y = 0,
	areas = {},
}

-- alignments

-- 1 > from left, up
-- 2 > from center, up
-- 3 > from right, up

-- 4 > from left, center
-- 5 > from center, center
-- 6 > from right, center

-- 7 > from left, down
-- 8 > from center, down
-- 9 > from right, down

local alignments = {
  [1] = function () return x, y-h, x+w, y end,
  [2] = function () return x-(w/2), y-h, x+(w/2), y end,
  [3] = function () return x-w, y-h, x, y end,

  [4] = function () return x, y-(h/2), x+w, y+(h/2) end,
  [5] = function () return x-(w/2), y-(h/2), x+(w/2), y+(h/2) end,
  [6] = function () return x-w, y-(h/2), x, y+(h/2) end,

  [7] = function () return x, y, x+w, y+h end,
  [8] = function () return x-(w/2), y, x+(w/2), y+h end,
  [9] = function () return x-w, y, x, y+h end,
}

-- Player colours (BGR), MPV-OSC-03: the phone player's DEFAULT_THEME
-- (packages/mobile-mpv-playback/src/components/PlayerControls.tsx), checked
-- against it pixel by pixel in osc-player-chrome.test.ts.
local black = "000000"
local white = "FFFFFF"				-- icons and text (#fff)
local accent = "57B3FF"				-- accent #ffb357 (Badger yellow, PLAY-LOOK-01): seek and volume tracks, hover
-- MPV-OSC-04 (the approved centre-controls design): unplayed track white at
-- 0.25, chips rgba(21, 21, 23) at 0.9 (bottom, back) or 0.75 (centre), no ring.
local unplayedAlpha = 0xBF			-- the unplayed track: white at 0.25 opacity
local chipFillAlpha = 0x1A			-- chip fill at 0.9
local chipCentreFillAlpha = 0x40	-- centre chips' fill at 0.75

-- osc styles - params : blur, bord, color1, color2, font size, icon
local osc_styles = {
	-- Backdrop gradient. Its glow reaches bord + 2*blur virtual px (x2.8 fullscreen)
	-- above the screen bottom and the sw OSD blends that whole bitmap on every
	-- update: 75/100 reached 700 px and cost ~45% vo-thread CPU (vs ~10% without
	-- an OSC), skipping frames on low-end hosts. Keep reach <= 25% of the OSD
	-- height (osc-backdrop-glow-cost.test.ts).
	transBg				= createStyle(20, 45, black, black, nil, nil),
	transBgMini			= createStyle(75, 75, black, black, nil, nil),
	transBgPot			= createStyle(0, 70, black, black, nil, nil),
	transBgPotMini		= createStyle(0, 30, black, black, nil, nil),
	seekbarFg			= createStyle(0, 0, accent, accent, nil, nil),
	-- hover: fill and stroke in the accent (outline icons draw with \bord)
	elementHover		= createStyle(0, 0, accent, accent, nil, nil),
	-- round button chip: rgba(21, 21, 23) fill, no ring (MPV-OSC-04)
	chip				= "{\\blur0\\bord0\\shad0\\1c&H171515&}",

	-- drawn icons (osc_icons) and Inter text, white like the phone's. Every
	-- icon is an ASS drawing: the OSC ships no icon font.
	bigButtons			= createStyle(0, 0, white, white, 22, user_opts.oscFont),
	mediumButtons2		= createStyle(0, 0, white, white, 18, user_opts.oscFont),
	togTooltip			= createStyle(0, 0, white, white, 16, "mpv-osd-symbols"),
	
	timecodeL			= createStyle(0, 0, white, white, 13, user_opts.oscFont),
	timecodeR			= createStyle(0, 0, white, white, 13, user_opts.oscFont),
	titlePotMini		= createStyle(0, 0, white, white, 14, user_opts.oscFont),
	tooltip				= createStyle(0, 0, white, black, 10, user_opts.oscFont),
	vidTitle			= createStyle(0, 0, white, white, 12, user_opts.oscFont),
	
	-- What's-playing title and meta line (PLAY-OVL-01, MPV-OSC-04): Space
	-- Grotesk semi-bold over an Inter meta line at 0.75. A thin dark outline
	-- keeps white text readable over bright video. Glyph-local, unlike a top
	-- gradient, which would add a second screen-wide blended glow bitmap
	-- (osc-backdrop-glow-cost.test.ts).
	topTitle			= createStyle(0.5, 1.2, white, black, 14, "Space Grotesk") .. "{\\b1}",
	topMeta				= createStyle(0.5, 1, white, black, 8.5, user_opts.oscFont),
	
	elementDown = "{\\1c&H" .. black .. "&}",
}

-- Icons (MPV-OSC-04, Chris 2026-11-09): the approved centre-controls design's
-- lucide icons (back arrow, play, pause, skip-back / skip-forward, list,
-- audio-lines, captions, settings, scan / minimize, volume-2 / volume-x) as ASS
-- vector drawings, converted from their 24-unit SVG paths at the mockup's size
-- (CSS px / 2 = virtual px windowed). Lucide strokes are 2 of 24 units: outline
-- icons draw a transparent fill and a \bord stroke (open sub-paths run there
-- and back so the implicit close adds no edge; the captions box runs there and back
-- too, since libass clears a border under a transparent fill and would hide the
-- text lines inside a closed box, PLAY-OVL-05); play, pause and the skip
-- triangles are filled like the mockup's.
local osc_icons = {
	back            = "{\\1a&HFF&\\bord0.46}{\\p1}m 3.21 6.42 l 0 3.21 l 3.21 0 l 0 3.21 l 3.21 6.42 m 6.42 3.21 l 0 3.21 l 6.42 3.21{\\p0}",
	play            = "{\\bord0.71}{\\p1}m 0 1.48 b 0 0.97 0.27 0.51 0.71 0.25 b 1.15 0 1.69 0 2.13 0.26 l 10.63 5.21 b 11.07 5.47 11.33 5.93 11.33 6.44 b 11.33 6.94 11.07 7.41 10.63 7.66 l 2.13 12.62 b 1.69 12.88 1.15 12.88 0.71 12.63 b 0.27 12.37 0 11.91 0 11.4{\\p0}",
	pause           = "{\\bord0.71}{\\p1}m 7.08 0 l 9.21 0 b 9.6 0 9.92 0.32 9.92 0.71 l 9.92 12.04 b 9.92 12.43 9.6 12.75 9.21 12.75 l 7.08 12.75 b 6.69 12.75 6.38 12.43 6.38 12.04 l 6.38 0.71 b 6.38 0.32 6.69 0 7.08 0 m 0.71 0 l 2.83 0 b 3.22 0 3.54 0.32 3.54 0.71 l 3.54 12.04 b 3.54 12.43 3.22 12.75 2.83 12.75 l 0.71 12.75 b 0.32 12.75 0 12.43 0 12.04 l 0 0.71 b 0 0.32 0.32 0 0.71 0{\\p0}",
	episode_prev    = "{\\bord0.52}{\\p1}m 7.8 0.2 b 8.12 0.01 8.52 0 8.85 0.18 b 9.17 0.37 9.38 0.72 9.38 1.09 l 9.38 7.34 b 9.38 7.72 9.17 8.06 8.85 8.25 b 8.52 8.43 8.12 8.43 7.8 8.23 l 2.59 5.11 b 2.28 4.92 2.08 4.58 2.08 4.22 b 2.08 3.85 2.27 3.51 2.59 3.32 m 0 8.38 l 0 0.05 l 0 8.38{\\p0}",
	episode_next    = "{\\bord0.52}{\\p1}m 9.38 0.05 l 9.38 8.38 l 9.38 0.05 m 1.58 0.2 b 1.26 0.01 0.86 0 0.53 0.18 b 0.2 0.37 0 0.72 0 1.09 l 0 7.34 b 0 7.72 0.2 8.06 0.53 8.25 b 0.86 8.43 1.26 8.43 1.58 8.23 l 6.78 5.11 b 7.1 4.92 7.29 4.58 7.29 4.22 b 7.29 3.85 7.1 3.51 6.79 3.32{\\p0}",
	chapters        = "{\\1a&HFF&\\bord0.44}{\\p1}m 0 2.63 l 0 2.63 l 0 2.63 m 0 5.25 l 0 5.25 l 0 5.25 m 0 0 l 0 0 l 0 0 m 2.19 2.63 l 7.88 2.63 l 2.19 2.63 m 2.19 5.25 l 7.88 5.25 l 2.19 5.25 m 2.19 0 l 7.88 0 l 2.19 0{\\p0}",
	audio           = "{\\1a&HFF&\\bord0.44}{\\p1}m 0 3.06 l 0 4.38 l 0 3.06 m 1.75 1.31 l 1.75 6.13 l 1.75 1.31 m 3.5 0 l 3.5 7.88 l 3.5 0 m 5.25 2.19 l 5.25 5.25 l 5.25 2.19 m 7 0.88 l 7 6.56 l 7 0.88 m 8.75 3.06 l 8.75 4.38 l 8.75 3.06{\\p0}",
	captions        = "{\\1a&HFF&\\bord0.44}{\\p1}m 0.88 0 l 7 0 b 7.48 0 7.88 0.39 7.88 0.88 l 7.88 5.25 b 7.88 5.73 7.48 6.13 7 6.13 l 0.88 6.13 b 0.39 6.13 0 5.73 0 5.25 l 0 0.88 b 0 0.39 0.39 0 0.88 0 b 0.39 0 0 0.39 0 0.88 l 0 5.25 b 0 5.73 0.39 6.13 0.88 6.13 l 7 6.13 b 7.48 6.13 7.88 5.73 7.88 5.25 l 7.88 0.88 b 7.88 0.39 7.48 0 7 0 l 0.88 0 m 1.75 2.63 l 2.63 2.63 l 1.75 2.63 m 4.38 2.63 l 6.13 2.63 l 4.38 2.63 m 1.75 4.38 l 3.5 4.38 l 1.75 4.38 m 5.25 4.38 l 6.13 4.38 l 5.25 4.38{\\p0}",
	quality         = "{\\1a&HFF&\\bord0.44}{\\p1}m 3.03 0.93 b 3.08 0.4 3.52 0 4.04 0 b 4.57 0 5.01 0.4 5.06 0.93 b 5.09 1.26 5.28 1.56 5.57 1.72 b 5.86 1.89 6.21 1.91 6.52 1.76 b 7 1.55 7.56 1.73 7.83 2.18 b 8.09 2.64 7.96 3.22 7.54 3.53 b 7.26 3.72 7.1 4.03 7.1 4.37 b 7.1 4.7 7.26 5.01 7.54 5.21 b 7.96 5.51 8.09 6.09 7.83 6.55 b 7.56 7.01 7 7.19 6.52 6.97 b 6.21 6.83 5.86 6.84 5.57 7.01 b 5.28 7.18 5.09 7.47 5.06 7.81 b 5.01 8.33 4.57 8.73 4.04 8.73 b 3.52 8.73 3.08 8.33 3.03 7.81 b 3 7.47 2.81 7.18 2.52 7.01 b 2.23 6.84 1.88 6.83 1.57 6.97 b 1.09 7.19 0.53 7.01 0.26 6.55 b 0 6.09 0.13 5.51 0.55 5.21 b 0.83 5.01 0.99 4.7 0.99 4.37 b 0.99 4.03 0.83 3.72 0.55 3.53 b 0.13 3.22 0 2.64 0.26 2.19 b 0.53 1.73 1.09 1.55 1.57 1.76 b 1.88 1.91 2.23 1.89 2.52 1.72 b 2.81 1.56 3 1.26 3.02 0.93 b 3 1.26 2.81 1.56 2.52 1.72 b 2.23 1.89 1.88 1.91 1.57 1.76 b 1.09 1.55 0.53 1.73 0.26 2.19 b 0 2.64 0.13 3.22 0.55 3.53 b 0.83 3.72 0.99 4.03 0.99 4.37 b 0.99 4.7 0.83 5.01 0.55 5.21 b 0.13 5.51 0 6.09 0.26 6.55 b 0.53 7.01 1.09 7.19 1.57 6.97 b 1.88 6.83 2.23 6.84 2.52 7.01 b 2.81 7.18 3 7.47 3.03 7.81 b 3.08 8.33 3.52 8.73 4.04 8.73 b 4.57 8.73 5.01 8.33 5.06 7.81 b 5.09 7.47 5.28 7.18 5.57 7.01 b 5.86 6.84 6.21 6.83 6.52 6.97 b 7 7.19 7.56 7.01 7.83 6.55 b 8.09 6.09 7.96 5.51 7.54 5.21 b 7.26 5.01 7.1 4.7 7.1 4.37 b 7.1 4.03 7.26 3.72 7.54 3.53 b 7.96 3.22 8.09 2.64 7.83 2.18 b 7.56 1.73 7 1.55 6.52 1.76 b 6.21 1.91 5.86 1.89 5.57 1.72 b 5.28 1.56 5.09 1.26 5.06 0.93 b 5.01 0.4 4.57 0 4.04 0 b 3.52 0 3.08 0.4 3.03 0.93 m 2.73 4.37 b 2.73 3.64 3.32 3.05 4.04 3.05 b 4.77 3.05 5.36 3.64 5.36 4.37 b 5.36 5.09 4.77 5.68 4.04 5.68 b 3.32 5.68 2.73 5.09 2.73 4.37{\\p0}",
	fullscreen      = "{\\1a&HFF&\\bord0.44}{\\p1}m 2.19 0 l 0.88 0 b 0.39 0 0 0.39 0 0.88 l 0 2.19 l 0 0.88 b 0 0.39 0.39 0 0.88 0 l 2.19 0 m 7.88 2.19 l 7.88 0.88 b 7.88 0.39 7.48 0 7 0 l 5.69 0 l 7 0 b 7.48 0 7.88 0.39 7.88 0.88 l 7.88 2.19 m 0 5.69 l 0 7 b 0 7.48 0.39 7.88 0.88 7.88 l 2.19 7.88 l 0.88 7.88 b 0.39 7.88 0 7.48 0 7 l 0 5.69 m 5.69 7.88 l 7 7.88 b 7.48 7.88 7.88 7.48 7.88 7 l 7.88 5.69 l 7.88 7 b 7.88 7.48 7.48 7.88 7 7.88 l 5.69 7.88{\\p0}",
	fullscreen_exit = "{\\1a&HFF&\\bord0.44}{\\p1}m 2.19 0 l 2.19 1.31 b 2.19 1.8 1.8 2.19 1.31 2.19 l 0 2.19 l 1.31 2.19 b 1.8 2.19 2.19 1.8 2.19 1.31 l 2.19 0 m 7.88 2.19 l 6.56 2.19 b 6.08 2.19 5.69 1.8 5.69 1.31 l 5.69 0 l 5.69 1.31 b 5.69 1.8 6.08 2.19 6.56 2.19 l 7.88 2.19 m 0 5.69 l 1.31 5.69 b 1.8 5.69 2.19 6.08 2.19 6.56 l 2.19 7.88 l 2.19 6.56 b 2.19 6.08 1.8 5.69 1.31 5.69 l 0 5.69 m 5.69 7.88 l 5.69 6.56 b 5.69 6.08 6.08 5.69 6.56 5.69 l 7.88 5.69 l 6.56 5.69 b 6.08 5.69 5.69 6.08 5.69 6.56 l 5.69 7.88{\\p0}",
	volume          = "{\\1a&HFF&\\bord0.46}{\\p1}m 4.13 0.35 b 4.12 0.22 4.05 0.1 3.93 0.05 b 3.8 0 3.67 0.03 3.57 0.12 l 2.02 1.67 b 1.9 1.79 1.74 1.86 1.57 1.86 l 0.46 1.86 b 0.21 1.86 0 2.06 0 2.32 l 0 5.07 b 0 5.32 0.21 5.53 0.46 5.53 l 1.57 5.53 b 1.74 5.53 1.9 5.59 2.02 5.72 l 3.57 7.27 b 3.67 7.36 3.8 7.39 3.93 7.34 b 4.05 7.29 4.13 7.17 4.13 7.04 m 6.42 2.32 b 7.03 3.13 7.03 4.25 6.42 5.07 b 7.03 4.25 7.03 3.13 6.42 2.32 m 7.96 6.61 b 8.73 5.84 9.17 4.79 9.17 3.69 b 9.17 2.6 8.73 1.55 7.96 0.78 b 8.73 1.55 9.17 2.6 9.17 3.69 b 9.17 4.79 8.73 5.84 7.96 6.61{\\p0}",
	volume_mute     = "{\\1a&HFF&\\bord0.46}{\\p1}m 4.13 0.35 b 4.12 0.22 4.05 0.1 3.93 0.05 b 3.8 0 3.67 0.03 3.57 0.12 l 2.02 1.67 b 1.9 1.79 1.74 1.86 1.57 1.86 l 0.46 1.86 b 0.21 1.86 0 2.06 0 2.32 l 0 5.07 b 0 5.32 0.21 5.53 0.46 5.53 l 1.57 5.53 b 1.74 5.53 1.9 5.59 2.02 5.72 l 3.57 7.27 b 3.67 7.36 3.8 7.39 3.93 7.34 b 4.05 7.29 4.13 7.17 4.13 7.04 m 9.17 2.32 l 6.42 5.07 l 9.17 2.32 m 6.42 2.32 l 9.17 5.07 l 6.42 2.32{\\p0}",
}

-- internal states, do not touch
local state = {
	showtime,								-- time of last invocation (last mouse move)
	osc_visible = false,					-- OSC visible
	anistart,								-- time when the animation started
	anitype,								-- current type of animation
	animation,								-- current animation alpha
	mouse_down_counter = 0,					-- used for softrepeat
	active_element = nil,					-- nil = none, 0 = background, 1+ = see elements[]
	active_event_source = nil,				-- the "button" that issued the current event
	mp_screen_sizeX, mp_screen_sizeY,		-- last screen-resolution, to detect resolution changes to issue reINITs
	initREQ = false,						-- is a re-init request pending?
	marginsREQ = false,						-- is a margins update pending?
	last_mouseX, last_mouseY,				-- last mouse position, to detect significant mouse movement
	mouse_in_window = false,
	message_text,
	message_hide_timer,
	fullscreen = false,
	tick_timer = nil,
	tick_last_time = 0,						-- when the last tick() was run
	hide_timer = nil,
	cache_state = nil,
	idle = false,
	enabled = true,
	input_enabled = true,
	wc_enabled = true, -- "window-controls" is enabled at load (see its set_key_bindings)
	centre_enabled = true, -- "centre" too (MPV-OSC-04)
	-- SpaceBadger: neighbouring playable episodes, from sf.lua's
	-- user-data/sf/episode-nav ({hasPrevious, hasNext, previousLabel, nextLabel}).
	episode_nav = {},
	showhide_enabled = false,
	dmx_cache = 0,
	osd = mp.create_osd_overlay("ass-events"),
	chapter_list = {},						-- sorted by time
	lastvisibility = user_opts.visibility,	-- save last visibility on pause if showonpause
}

local thumbfast = {
	width = 0,
	height = 0,
	disabled = true,
	available = false
}

local tick_delay = 1 / 60

-- Automatically disable OSC
local builtin_osc_enabled = mp.get_property_native("osc")
if builtin_osc_enabled then
	mp.set_property_native("osc", false)
end

--
-- Helper functions
--

function kill_animation()
	state.anistart = nil
	state.animation = nil
	state.anitype =  nil
end

function set_osd(res_x, res_y, text)
	if state.osd.res_x == res_x and
	   state.osd.res_y == res_y and
	   state.osd.data == text then
		return
	end
	state.osd.res_x = res_x
	state.osd.res_y = res_y
	state.osd.data = text
	state.osd.z = 1000
	state.osd:update()
end

-- scale factor for translating between real and virtual ASS coordinates
function get_virt_scale_factor()
	local w, h = mp.get_osd_size()
	if w <= 0 or h <= 0 then
		return 0, 0
	end
	return osc_param.playresx / w, osc_param.playresy / h
end

-- return mouse position in virtual ASS coordinates (playresx/y)
function get_virt_mouse_pos()
	if state.mouse_in_window then
		local sx, sy = get_virt_scale_factor()
		local x, y = mp.get_mouse_pos()
		return x * sx, y * sy
	else
		return -1, -1
	end
end

function set_virt_mouse_area(x0, y0, x1, y1, name)
	local sx, sy = get_virt_scale_factor()
	mp.set_mouse_area(x0 / sx, y0 / sy, x1 / sx, y1 / sy, name)
end

function scale_value(x0, x1, y0, y1, val)
	local m = (y1 - y0) / (x1 - x0)
	local b = y0 - (m * x0)
	return (m * val) + b
end

-- returns hitbox spanning coordinates (top left, bottom right corner) according to alignment

-- 1 > from left, up
-- 2 > from center, up
-- 3 > from right, up

-- 4 > from left, center
-- 5 > from center, center
-- 6 > from right, center

-- 7 > from left, down
-- 8 > from center, down
-- 9 > from right, down

function get_hitbox_coords(x, y, an, w, h)

	local alignments = {
	  [1] = function () return x, y-h, x+w, y end,
	  [2] = function () return x-(w/2), y-h, x+(w/2), y end,
	  [3] = function () return x-w, y-h, x, y end,

	  [4] = function () return x, y-(h/2), x+w, y+(h/2) end,
	  [5] = function () return x-(w/2), y-(h/2), x+(w/2), y+(h/2) end,
	  [6] = function () return x-w, y-(h/2), x, y+(h/2) end,

	  [7] = function () return x, y, x+w, y+h end,
	  [8] = function () return x-(w/2), y, x+(w/2), y+h end,
	  [9] = function () return x-w, y, x, y+h end,
	}

	return alignments[an]()
end

function get_hitbox_coords_geo(geometry)
	return get_hitbox_coords(geometry.x, geometry.y, geometry.an,
		geometry.w, geometry.h)
end

function get_element_hitbox(element)
	return element.hitbox.x1, element.hitbox.y1,
		element.hitbox.x2, element.hitbox.y2
end

function mouse_hit(element)
	return mouse_hit_coords(get_element_hitbox(element))
end

function mouse_hit_coords(bX1, bY1, bX2, bY2)
	local mX, mY = get_virt_mouse_pos()
	return (mX >= bX1 and mX <= bX2 and mY >= bY1 and mY <= bY2)
end

function limit_range(min, max, val)
	if val > max then
		val = max
	elseif val < min then
		val = min
	end
	return val
end

-- translate value into element coordinates
function get_slider_ele_pos_for(element, val)

	local ele_pos = scale_value(
		element.slider.min.value, element.slider.max.value,
		element.slider.min.ele_pos, element.slider.max.ele_pos,
		val)

	return limit_range(
		element.slider.min.ele_pos, element.slider.max.ele_pos,
		ele_pos)
end

-- Thumb proportions of a track slider, in track heights: the layout's
-- slider.thumb {w, h, gap} (MPV-OSC-04), else the phone's 6 x 24 thumb and
-- 7 gap on an 8 track (MPV-OSC-03).
function slider_thumb(slider_lo)
	return slider_lo.thumb or {w = 6 / 8, h = 24 / 8, gap = 7 / 8}
end

-- MPV-OSC-03 seek track: the pill thumb is taller than the element, so the
-- drawing grows by it on both sides. libass places a drawing from its origin,
-- not from its lowest y, so every part of a track slider (track, thumb, chapter
-- ticks, cache ranges, the invisible box) moves down by this to start at 0:
-- the box stays centred on the element and the track on its centre line.
function slider_track_oy(slider_lo, elem_geo)
	if not slider_lo.track then return 0 end
	local thumbH = (elem_geo.h - 2 * slider_lo.gap) * slider_thumb(slider_lo).h
	return math.max(0, thumbH / 2 - elem_geo.h / 2)
end

-- translates global (mouse) coordinates to value
function get_slider_value_at(element, glob_pos)

	local val = scale_value(
		element.slider.min.glob_pos, element.slider.max.glob_pos,
		element.slider.min.value, element.slider.max.value,
		glob_pos)

	return limit_range(
		element.slider.min.value, element.slider.max.value,
		val)
end

-- get value at current mouse position
function get_slider_value(element)
	return get_slider_value_at(element, get_virt_mouse_pos())
end

-- Tell the app where an absolute-percent seekbar seek is going. mpv reports
-- the pre-seek time-pos until the seek lands, so an ABR reload started
-- meanwhile would restart at the old position (issue #25 P1b).
-- Channel name: LUA_OUTBOUND_CHANNELS.OSC_SEEK in @space/mpv-protocol.
local function announce_osc_seek(percent)
	local duration = mp.get_property_number("duration")
	if not duration or duration <= 0 or not percent then
		return
	end
	local seconds = math.max(0, math.min(duration, percent / 100 * duration))
	mp.commandv("script-message", "sf-osc-seek", string.format("%.3f", seconds))
end

-- multiplies two alpha values, formular can probably be improved
function mult_alpha(alphaA, alphaB)
	return 255 - (((1-(alphaA/255)) * (1-(alphaB/255))) * 255)
end

function add_area(name, x1, y1, x2, y2)
	-- create area if needed
	if (osc_param.areas[name] == nil) then
		osc_param.areas[name] = {}
	end
	table.insert(osc_param.areas[name], {x1=x1, y1=y1, x2=x2, y2=y2})
end

function ass_append_alpha(ass, alpha, modifier)
	local ar = {}

	for ai, av in pairs(alpha) do
		av = mult_alpha(av, modifier)
		if state.animation then
			av = mult_alpha(av, state.animation)
		end
		ar[ai] = av
	end

	ass:append(string.format("{\\1a&H%X&\\2a&H%X&\\3a&H%X&\\4a&H%X&}",
			   ar[1], ar[2], ar[3], ar[4]))
end

function ass_draw_cir_cw(ass, x, y, r)
	ass:round_rect_cw(x-r, y-r, x+r, y+r, r)
end

function ass_draw_rr_h_cw(ass, x0, y0, x1, y1, r1, hexagon, r2)
	if hexagon then
		ass:hexagon_cw(x0, y0, x1, y1, r1, r2)
	else
		ass:round_rect_cw(x0, y0, x1, y1, r1, r2)
	end
end

function ass_draw_rr_h_ccw(ass, x0, y0, x1, y1, r1, hexagon, r2)
	if hexagon then
		ass:hexagon_ccw(x0, y0, x1, y1, r1, r2)
	else
		ass:round_rect_ccw(x0, y0, x1, y1, r1, r2)
	end
end

function round(number, decimals)
	local power = 10^(decimals or 1)
	return math.floor(number * power + 0.5) / power
end

--
-- Tracklist Management
--

local nicetypes = {video = "Video", audio = "Audio", sub = "Subtitle"}

-- updates the OSC internal playlists, should be run each time the track-layout changes
function update_tracklist()
	local tracktable = mp.get_property_native("track-list", {})

	-- by osc_id
	tracks_osc = {}
	tracks_osc.video, tracks_osc.audio, tracks_osc.sub = {}, {}, {}
	-- by mpv_id
	tracks_mpv = {}
	tracks_mpv.video, tracks_mpv.audio, tracks_mpv.sub = {}, {}, {}
	for n = 1, #tracktable do
		if not (tracktable[n].type == "unknown") then
			local type = tracktable[n].type
			local mpv_id = tonumber(tracktable[n].id)

			-- by osc_id
			table.insert(tracks_osc[type], tracktable[n])

			-- by mpv_id
			tracks_mpv[type][mpv_id] = tracktable[n]
			tracks_mpv[type][mpv_id].osc_id = #tracks_osc[type]
		end
	end
end

-- return a nice list of tracks of the given type (video, audio, sub)
function get_tracklist(type)
	local msg = "Available " .. nicetypes[type] .. " Tracks: "
	if not tracks_osc or #tracks_osc[type] == 0 then
		msg = msg .. "none"
	else
		for n = 1, #tracks_osc[type] do
			local track = tracks_osc[type][n]
			local lang, title, selected, codec = "unknown", "", "○", ""
			if not(track.lang == nil) then lang = track.lang end
			if not(track.title == nil) then title = track.title end
			if not(track.codec == nil) then codec = track.codec end
			if (track.id == tonumber(mp.get_property(type))) then
				selected = "●"
			end
			msg = msg.."\n"..selected.." "..n.." : ["..lang.."] "..codec.." "..title
		end
	end
	return msg
end

-- relatively change the track of given <type> by <next> tracks
	--(+1 -> next, -1 -> previous)
function set_track(type, next)
	local current_track_mpv, current_track_osc
	if (mp.get_property(type) == "no") then
		current_track_osc = 0
	else
		current_track_mpv = tonumber(mp.get_property(type))
		current_track_osc = tracks_mpv[type][current_track_mpv].osc_id
	end
	local new_track_osc = (current_track_osc + next) % (#tracks_osc[type] + 1)
	local new_track_mpv
	if new_track_osc == 0 then
		new_track_mpv = "no"
	else
		new_track_mpv = tracks_osc[type][new_track_osc].id
	end

	mp.commandv("set", type, new_track_mpv)
end

function get_track_name(type)
	if type == "sub" then
		local msg = "Subtitle : Off"
		if not (get_track("sub") == 0) then
			msg = "Subtitle ["..get_track("sub").."∕"..#tracks_osc.sub.."] "
			local lang = mp.get_property("current-tracks/sub/lang") or "N/A"
			local title = mp.get_property("current-tracks/sub/title") or ""
			msg = msg .. "(" .. lang .. ")" .. " " .. title
		end
		if not user_opts.showTooltip then
			mp.osd_message(utils.to_string(msg))
		end
		return msg
	else
		local msg = "Audio :  Off"
		if not (get_track("audio") == 0) then
			msg = "Audio ["..get_track("audio").."∕"..#tracks_osc.audio.."] "
			local lang = mp.get_property("current-tracks/audio/lang") or "N/A"
			local title = mp.get_property("current-tracks/audio/title") or ""
			msg = msg .. "(" .. lang .. ")" .. " " .. title
		end
		if not user_opts.showTooltip then
			mp.osd_message(utils.to_string(msg))
		end
		return msg
	end
end

-- get the currently selected track of <type>, OSC-style counted
function get_track(type)
	local track = mp.get_property(type)
	if track ~= "no" and track ~= nil then
		local tr = tracks_mpv[type][tonumber(track)]
		if tr then
			return tr.osc_id
		end
	end
	return 0
end

--
-- Element Management
--

local elements = {}

function prepare_elements()

	-- remove elements without layout or invisble
	local elements2 = {}
	for n, element in pairs(elements) do
		if not (element.layout == nil) and (element.visible) then
			table.insert(elements2, element)
		end
	end
	elements = elements2

	function elem_compare (a, b)
		return a.layout.layer < b.layout.layer
	end

	table.sort(elements, elem_compare)

	for _,element in pairs(elements) do

		local elem_geo = element.layout.geometry

		-- Calculate the hitbox
		local bX1, bY1, bX2, bY2 = get_hitbox_coords_geo(elem_geo)
		element.hitbox = {x1 = bX1, y1 = bY1, x2 = bX2, y2 = bY2}

		local style_ass = assdraw.ass_new()

		-- prepare static elements
		style_ass:append("{}") -- hack to troll new_event into inserting a \n
		style_ass:new_event()
		style_ass:pos(elem_geo.x, elem_geo.y)
		style_ass:an(elem_geo.an)
		style_ass:append(element.layout.style)

		element.style_ass = style_ass

		local static_ass = assdraw.ass_new()

		if (element.type == "box") then
			--draw box
			static_ass:draw_start()
			ass_draw_rr_h_cw(static_ass, 0, 0, elem_geo.w, elem_geo.h,
							 element.layout.box.radius, element.layout.box.hexagon)
			static_ass:draw_stop()

		elseif (element.type == "slider") then
			--draw static slider parts
			local slider_lo = element.layout.slider
			-- calculate positions of min and max points
			element.slider.min.ele_pos = user_opts.seekbarhandlesize * elem_geo.h / 2
			element.slider.max.ele_pos = elem_geo.w - element.slider.min.ele_pos
			element.slider.min.glob_pos = element.hitbox.x1 + element.slider.min.ele_pos
			element.slider.max.glob_pos = element.hitbox.x1 + element.slider.max.ele_pos

			static_ass:draw_start()
			-- a hack which prepares the whole slider area to allow center placements such like an=5
			local oy = slider_track_oy(slider_lo, elem_geo)
			static_ass:rect_cw(0, 0, elem_geo.w, elem_geo.h + 2 * oy)
			static_ass:rect_ccw(0, 0, elem_geo.w, elem_geo.h + 2 * oy)
			-- marker nibbles
			if not (element.slider.markerF == nil) and (slider_lo.gap > 0) then
				local markers = element.slider.markerF()
				for _,marker in pairs(markers) do
					if (marker >= element.slider.min.value) and
						(marker <= element.slider.max.value) then

						local s = get_slider_ele_pos_for(element, marker)

						if (slider_lo.gap > 5) then -- draw triangles

							--top
							if (slider_lo.nibbles_top) then
								static_ass:move_to(s - 1, oy + slider_lo.gap - 5)
								static_ass:line_to(s + 1, oy + slider_lo.gap - 5)
								static_ass:line_to(s, oy + slider_lo.gap - 1)
							end

							--bottom
							if (slider_lo.nibbles_bottom) then
								static_ass:move_to(s - 1, oy + elem_geo.h - slider_lo.gap + 5)
								static_ass:line_to(s, oy + elem_geo.h - slider_lo.gap + 1)
								static_ass:line_to(s + 1, oy + elem_geo.h - slider_lo.gap + 5)
							end

						else -- draw 2x1px nibbles

							--top
							if (slider_lo.nibbles_top) then
								static_ass:rect_cw(s - 1, oy, s + 1, oy + slider_lo.gap);
							end

							--bottom
							if (slider_lo.nibbles_bottom) then
								static_ass:rect_cw(s - 1,
									oy + elem_geo.h - slider_lo.gap,
									s + 1, oy + elem_geo.h);
							end
						end
					end
				end
			end
		end

		element.static_ass = static_ass

		-- if the element is supposed to be disabled,
		-- style it accordingly and kill the eventresponders
		if not (element.enabled) then
			-- a seek track with no position is drawn whole and unplayed at its usual
			-- alpha, like the phone's (MPV-OSC-03); only buttons dim
			if not (element.layout.slider and element.layout.slider.track) then
				element.layout.alpha[1] = user_opts.alphaUntoggledButton
			end
			element.eventresponder = nil
		end

		-- gray out the element if it is toggled off
		if (element.off) then
			element.layout.alpha[1] = user_opts.alphaUntoggledButton
		end
	end
end

--
-- Element Rendering
--

-- returns nil or a chapter element from the native property chapter-list
function get_chapter(possec)
	local cl = state.chapter_list  -- sorted, get latest before possec, if any

	for n=#cl,1,-1 do
		if possec >= cl[n].time then
			return cl[n]
		end
	end
end

function render_elements(master_ass)

	-- when the slider is dragged or hovered and we have a target chapter name
	-- then we use it instead of the normal title. we calculate it before the
	-- render iterations because the title may be rendered before the slider.
	state.forced_title = nil
	local se, ae = state.slider_element, elements[state.active_element]
	if user_opts.chapter_fmt ~= "no" and se and (ae == se or (not ae and mouse_hit(se)))
		and user_opts.showChapters then
		local dur = mp.get_property_number("duration", 0)
		if dur > 0 then
			local possec = get_slider_value(se) * dur / 100 -- of mouse pos
			local ch = get_chapter(possec)
			if ch and ch.title and ch.title ~= "" then
				state.forced_title = string.format(user_opts.chapter_fmt, ch.title)
			end
		end
	end

	for n=1, #elements do
		local element = elements[n]

		local style_ass = assdraw.ass_new()
		style_ass:merge(element.style_ass)
		local alpha = element.layout.alpha
		if element.type == "button" and alpha[3] == 255 then
			-- outline icons (MPV-OSC-04) draw their stroke with \bord: it fades
			-- with the button (disabled, toggled off) like the fill does
			alpha = {alpha[1], alpha[2], alpha[1], alpha[4]}
		end
		ass_append_alpha(style_ass, alpha, 0)

		if element.eventresponder and (state.active_element == n) then

			-- run render event functions
			if not (element.eventresponder.render == nil) then
				element.eventresponder.render(element)
			end

			if mouse_hit(element) then
				-- mouse down styling
				if (element.styledown) then
					style_ass:append(osc_styles.elementDown)
				end

				if (element.softrepeat) and (state.mouse_down_counter >= 15
					and state.mouse_down_counter % 5 == 0) then

					element.eventresponder[state.active_event_source.."_down"](element)
				end
				state.mouse_down_counter = state.mouse_down_counter + 1
			end

		end

		local elem_ass = assdraw.ass_new()

		elem_ass:merge(style_ass)

		if not (element.type == "button") then
			elem_ass:merge(element.static_ass)
		end

		if (element.type == "slider") then

			local slider_lo = element.layout.slider
			local elem_geo = element.layout.geometry
			local s_min = element.slider.min.value
			local s_max = element.slider.max.value

			-- draw pos marker
			local pos = element.slider.posF()
			local seekRanges = element.slider.seekRangesF()
			local rh = user_opts.seekbarhandlesize * elem_geo.h / 2 -- Handle radius
			local xp

			if slider_lo.track then
				-- MPV-OSC-03 / MPV-OSC-04: played part up to a gap before an upright
				-- pill thumb (proportions from slider_thumb). With no position yet
				-- (before file-loaded, no duration) the whole track is unplayed.
				local th = elem_geo.h - 2 * slider_lo.gap
				local tr = th / 2
				local thumb = slider_thumb(slider_lo)
				local thumbW, thumbH, thumbGap = th * thumb.w, th * thumb.h, th * thumb.gap
				local cy = elem_geo.h / 2
				local oy = slider_track_oy(slider_lo, elem_geo)
				local unplayedFrom, boxH = 0, elem_geo.h + 2 * oy
				if pos then
					xp = get_slider_ele_pos_for(element, pos)
					if xp - thumbGap - thumbW / 2 > th then
						elem_ass:round_rect_cw(0, oy + slider_lo.gap, xp - thumbGap - thumbW / 2, oy + elem_geo.h - slider_lo.gap, tr)
					end
					elem_ass:round_rect_cw(xp - thumbW / 2, oy + cy - thumbH / 2, xp + thumbW / 2, oy + cy + thumbH / 2, thumbW / 2)
					unplayedFrom = xp + thumbGap + thumbW / 2
				end
				-- unplayed part: white at unplayedAlpha, its own event
				elem_ass:draw_stop()
				elem_ass:merge(element.style_ass)
				elem_ass:append("{\\1c&H" .. white .. "&}")
				ass_append_alpha(elem_ass, element.layout.alpha, unplayedAlpha)
				elem_ass:draw_start()
				-- the played event's bounding box, drawn invisibly so pos / an line up
				elem_ass:rect_cw(0, 0, elem_geo.w, boxH)
				elem_ass:rect_ccw(0, 0, elem_geo.w, boxH)
				if elem_geo.w - unplayedFrom > th then
					elem_ass:round_rect_cw(unplayedFrom, oy + slider_lo.gap, elem_geo.w, oy + elem_geo.h - slider_lo.gap, tr)
				end
			elseif pos then
				xp = get_slider_ele_pos_for(element, pos)
				ass_draw_cir_cw(elem_ass, xp, elem_geo.h/2, rh)
				elem_ass:rect_cw(0, slider_lo.gap, xp, elem_geo.h - slider_lo.gap)
			end

			if seekRanges then
				elem_ass:draw_stop()
				elem_ass:merge(element.style_ass)
				ass_append_alpha(elem_ass, element.layout.alpha, user_opts.seekrangealpha)
				elem_ass:merge(element.static_ass)

				for _,range in pairs(seekRanges) do
					local pstart = get_slider_ele_pos_for(element, range["start"])
					local pend = get_slider_ele_pos_for(element, range["end"])
					local oy = slider_track_oy(slider_lo, elem_geo)
					elem_ass:rect_cw(pstart - rh, oy + slider_lo.gap, pend + rh, oy + elem_geo.h - slider_lo.gap)
				end
			end

			elem_ass:draw_stop()

			-- add tooltip
			if not (element.slider.tooltipF == nil) then

				if mouse_hit(element) then
					local sliderpos = get_slider_value(element)
					local tooltiplabel = element.slider.tooltipF(sliderpos)

					local an = slider_lo.tooltip_an

					local ty

					if (an == 2) then
						ty = element.hitbox.y1
					else
						ty = element.hitbox.y1 + elem_geo.h/2
					end

					local tx = get_virt_mouse_pos()
					if (slider_lo.adjust_tooltip) then
						if (an == 2) then
							if (sliderpos < (s_min + 3)) then
								an = an - 1
							elseif (sliderpos > (s_max - 3)) then
								an = an + 1
							end
						elseif (sliderpos > (s_max-s_min)/2) then
							an = an + 1
							tx = tx - 5
						else
							an = an - 1
							tx = tx + 10
						end
					end

					-- tooltip label
					elem_ass:new_event()
					elem_ass:pos(tx, ty)
					elem_ass:an(an)
					elem_ass:append(slider_lo.tooltip_style)
					ass_append_alpha(elem_ass, slider_lo.alpha, 0)
					elem_ass:append(tooltiplabel)

					-- thumbnail
					if thumbfast.available and user_opts.showThumbfast then
						local osd_w = mp.get_property_number("osd-width")
						if osd_w and not thumbfast.disabled then
							local r_w, r_h = get_virt_scale_factor()

							local thumbPad = 4
							local thumbMarginX = 18 / r_w
							local thumbMarginY = 40
							local tooltipBgColor = "000000"
							local tooltipBgAlpha = 80
							local thumbX = math.min(osd_w - thumbfast.width - thumbMarginX, math.max(thumbMarginX, tx / r_w - thumbfast.width / 2))
							local thumbY = ((ty - thumbMarginY) / r_h - thumbfast.height)

							elem_ass:new_event()
							elem_ass:pos(thumbX * r_w, ty - thumbMarginY - thumbfast.height * r_h)
							elem_ass:an(7)
							elem_ass:append(("{\\bord0\\1c&H%s&\\1a&H%X&}"):format(tooltipBgColor, tooltipBgAlpha))
							elem_ass:draw_start()
							elem_ass:rect_cw(-thumbPad * r_h, -thumbPad * r_h, (thumbfast.width + thumbPad) * r_w, (thumbfast.height + thumbPad) * r_h)
							elem_ass:draw_stop()

							mp.commandv("script-message-to", "thumbfast", "thumb",
								mp.get_property_number("duration", 0) * (sliderpos / 100),
								thumbX,
								thumbY
							)
						end
					elseif element.name == "seekbar" and sf_preview.info then
						sf_preview_draw(elem_ass, tx, ty, sliderpos)
					elseif element.name == "seekbar" and sf_preview.hint then
						sf_preview_draw_hint(elem_ass, tx, ty)
					else
						display_tn_osc(ty, sliderpos, elem_ass)
					end
				else
					if thumbfast.available then
						mp.commandv("script-message-to", "thumbfast", "clear")
					elseif element.name == "seekbar" and sf_preview.info then
						sf_preview_leave()
					else
						hide_thumbnail()
					end
				end
			end

		elseif (element.type == "button") then

			local buttontext

			if type(element.content) == "function" then
				buttontext = element.content() -- function objects
			elseif not (element.content == nil) then
				buttontext = element.content -- text objects
			end

			local maxchars = element.layout.button.maxchars
			if not (maxchars == nil) and (#buttontext > maxchars) then
				local max_ratio = 1.25  -- up to 25% more chars while shrinking
				local limit = math.max(0, math.floor(maxchars * max_ratio) - 3)
				if (#buttontext > limit) then
					while (#buttontext > limit) do
						buttontext = buttontext:gsub(".[\128-\191]*$", "")
					end
					buttontext = buttontext .. "..."
				end
				local _, nchars2 = buttontext:gsub(".[\128-\191]*", "")
				local stretch = (maxchars/#buttontext)*100
				buttontext = string.format("{\\fscx%f}",
					(maxchars/#buttontext)*100) .. buttontext
			end

			-- MPV-OSC-03 / MPV-OSC-04: a round chip behind the button, rgba(21, 21, 23)
			-- at 0.9 (chip_alpha overrides it: 0.75 in the centre), dimmed with the button.
			local chip_r = element.layout.button.chip_r
			if chip_r then
				local chip_ass = assdraw.ass_new()
				chip_ass:append("{}") -- same hack as prepare_elements: makes new_event insert the \n
				chip_ass:new_event()
				chip_ass:pos((element.hitbox.x1 + element.hitbox.x2) / 2, (element.hitbox.y1 + element.hitbox.y2) / 2)
				chip_ass:an(5)
				chip_ass:append(osc_styles.chip)
				local a = element.layout.alpha[1]
				ass_append_alpha(chip_ass, {mult_alpha(a, element.layout.button.chip_alpha or chipFillAlpha), 255, 255, 255}, 0)
				chip_ass:draw_start()
				ass_draw_cir_cw(chip_ass, chip_r, chip_r, chip_r)
				chip_ass:draw_stop()
				master_ass:merge(chip_ass)
			end

			elem_ass:append(buttontext)

			-- add tooltips
			if not (element.tooltipF == nil) and element.enabled then
				if mouse_hit(element) then
					local tooltiplabel = element.tooltipF
					local an = 1
					local ty = element.hitbox.y1
					local tx = get_virt_mouse_pos()

					if ty < osc_param.playresy / 2 then
						ty = element.hitbox.y2
						an = 7
					end

					-- tooltip label
					if type(element.tooltipF) == "function" then
						tooltiplabel = element.tooltipF()
					else
						tooltiplabel = element.tooltipF
					end
					elem_ass:new_event()
					elem_ass:pos(tx, ty)
					elem_ass:an(an)
					elem_ass:append(element.tooltip_style)
					elem_ass:append(tooltiplabel)
				end
			end

			-- add hover effect
			-- source: https://github.com/Zren/mpvz/issues/13
			local button_lo = element.layout.button
			if mouse_hit(element) and element.hoverable and element.enabled then
				local shadow_ass = assdraw.ass_new()
				shadow_ass:merge(style_ass)
				shadow_ass:append(button_lo.hoverstyle .. buttontext)
				elem_ass:merge(shadow_ass)
			end
		end

		master_ass:merge(elem_ass)
	end
end

--
-- Message display
--

-- pos is 1 based
function limited_list(prop, pos)
	local proplist = mp.get_property_native(prop, {})
	local count = #proplist
	if count == 0 then
		return count, proplist
	end

	local fs = tonumber(mp.get_property("options/osd-font-size"))
	local max = math.ceil(osc_param.unscaled_y*0.75 / fs)
	if max % 2 == 0 then
		max = max - 1
	end
	local delta = math.ceil(max / 2) - 1
	local begi = math.max(math.min(pos - delta, count - max + 1), 1)
	local endi = math.min(begi + max - 1, count)

	local reslist = {}
	for i=begi, endi do
		local item = proplist[i]
		item.current = (i == pos) and true or nil
		table.insert(reslist, item)
	end
	return count, reslist
end

function get_playlist()
	local pos = mp.get_property_number("playlist-pos", 0) + 1
	local count, limlist = limited_list("playlist", pos)
	if count == 0 then
		return "Empty playlist."
	end

	local message = string.format("Playlist [%d/%d]:\n", pos, count)
	for i, v in ipairs(limlist) do
		local title = v.title
		local _, filename = utils.split_path(v.filename)
		if title == nil then
			title = filename
		end
		message = string.format("%s %s %s\n", message, (v.current and "●" or "○"), title)
	end

	return message
end

-- Playlist data at pos delta (osc_tethys)
function getDeltaPlaylistItem(delta)
	local deltaIndex, deltaItem = getDeltaListItem("playlist", "playlist-pos", delta, false)
	if deltaItem == nil then
		return nil
	end
	deltaItem = {
		index = deltaIndex,
		filename = deltaItem.filename,
		title = deltaItem.title,
		label = nil,
	}
	local label = deltaItem.title
	if label == nil then
		local _, filename = utils.split_path(deltaItem.filename)
		label = filename
	end
	deltaItem.label = label
	return deltaItem
end

-- (osc_tethys)
function getDeltaListItem(listKey, curKey, delta, clamp)
	local pos = mp.get_property_number(curKey, 0) + 1
	local count, limlist = limited_list(listKey, pos)
	if count == 0 then
		return nil
	end

	local curIndex = -1
	for i, v in ipairs(limlist) do
		if v.current then
			curIndex = i
			break
		end
	end

	local deltaIndex = curIndex + delta
	if curIndex == -1 then
		return nil
	elseif deltaIndex < 1 then
		if clamp then
			deltaIndex = 1
		else
			return nil
		end
	elseif deltaIndex > count then
		if clamp then
			deltaIndex = count
		else
			return nil
		end
	end

	local deltaItem = limlist[deltaIndex]
	return deltaIndex, deltaItem
end

function get_chapterlist()
	local pos = mp.get_property_number("chapter", 0) + 1
	local count, limlist = limited_list("chapter-list", pos)
	if count == 0 then
		return "No chapters."
	end

	local message = string.format("Chapters [%d/%d]:\n", pos, count)
	for i, v in ipairs(limlist) do
		local time = format_time(v.time)
		local title = v.title
		if title == nil then
			title = string.format("Chapter %02d", i)
		end
		message = string.format("%s[%s] %s %s\n", message, time,
			(v.current and "●" or "○"), title)
	end
	return message
end

function show_message(text, duration)

	--print("text: "..text.."   duration: " .. duration)
	if duration == nil then
		duration = tonumber(mp.get_property("options/osd-duration")) / 1000
	elseif not type(duration) == "number" then
		print("duration: " .. duration)
	end

	-- cut the text short, otherwise the following functions
	-- may slow down massively on huge input
	text = string.sub(text, 0, 4000)

	-- replace actual linebreaks with ASS linebreaks
	text = string.gsub(text, "\n", "\\N")
	state.message_text = text

	--state.message_text = mp.command_native({"escape-ass", text})

	if not state.message_hide_timer then
		state.message_hide_timer = mp.add_timeout(0, request_tick)
	end
	state.message_hide_timer:kill()
	state.message_hide_timer.timeout = duration
	state.message_hide_timer:resume()
	request_tick()
end

function render_message(ass)
	if state.message_hide_timer and state.message_hide_timer:is_enabled() and
	   state.message_text
	then
		local _, lines = string.gsub(state.message_text, "\\N", "")

		local fontsize = tonumber(mp.get_property("options/osd-font-size"))
		local outline = tonumber(mp.get_property("options/osd-border-size"))
		local maxlines = math.ceil(osc_param.unscaled_y*0.75 / fontsize)
		local counterscale = osc_param.playresy / osc_param.unscaled_y

		if user_opts.vidscale then
			fontsize = fontsize * counterscale / math.max(1 + math.min(lines/maxlines, 1), 1)
			outline = outline * counterscale / math.max(1 + math.min(lines/maxlines, 1)/2, 1)
		else
			fontsize = fontsize * counterscale / math.max(0.65 + math.min(lines/maxlines, 1), 1)
			outline = outline * counterscale / math.max(0.75 + math.min(lines/maxlines, 1)/2, 1)
		end

		local style = "{\\bord" .. outline .. "\\fs" .. fontsize .. "}"

		ass:new_event()
		ass:append(style .. state.message_text)
	else
		state.message_text = nil
	end
end

--
-- Initialisation and Layout
--

function new_element(name, type)
	elements[name] = {}
	elements[name].type = type
	elements[name].name = name

	-- add default stuff
	elements[name].eventresponder = {}
	elements[name].visible = true
	elements[name].enabled = true
	elements[name].softrepeat = false
	elements[name].styledown = (type == "button")
	elements[name].hoverable = (type == "button")
	elements[name].state = {}

	if (type == "slider") then
		elements[name].slider = {min = {value = 0}, max = {value = 100}}
	end

	return elements[name]
end

function add_layout(name)

	if not (elements[name] == nil) then

		-- new layout
		elements[name].layout = {}

		-- set layout defaults
		elements[name].layout.layer = 50
		elements[name].layout.alpha = {[1] = 0, [2] = 255, [3] = 255, [4] = 255}

		local nibbletop = false
		local nibblebottom = false
		nibbletop = user_opts.showChapters
		nibblebottom = user_opts.showChapters

		if (elements[name].type == "button") then
			elements[name].layout.button = {
				maxchars = nil,
				hoverstyle = osc_styles.elementHover
			}
		elseif (elements[name].type == "slider") then
			-- slider defaults
			elements[name].layout.slider = {
				border = 1,
				gap = 1,
				nibbles_top = false,
				nibbles_bottom = true,
				adjust_tooltip = true,
				tooltip_style = "",
				tooltip_an = 2,
				alpha = {[1] = 0, [2] = 255, [3] = 88, [4] = 255},
			}
		elseif (elements[name].type == "box") then
			elements[name].layout.box = {radius = 0, hexagon = false}
		end

		return elements[name].layout
	else
		msg.error("Can't add_layout to element \""..name.."\", doesn't exist.")
	end
end

-- MPV-OSC-05: which controls fit a window of w x h layout units (2 OSD px
-- each at HiDPI 1, every window size). Controls never shrink with the window:
-- when it is too narrow or too low for all of them, the lower-priority ones
-- are left out (not laid out, so neither drawn nor clickable), so the rest
-- keep their full size and hit areas and never overlap. Bottom row, first
-- left out first: the volume track, Chapters, quality, mute, audio,
-- subtitles; fullscreen always stays. The seek track keeps at least
-- SF_FIT.seekMin, so the times go before it gets shorter. The centre cluster
-- moves up between the top band and the seek row; when it does not fit there
-- the title and meta line make way so it can sit beside the back chip, and
-- it goes (a click on the picture still plays / pauses, MPV-CLICK-01) only
-- when the play chip fits nowhere; the previous / next chips go when the
-- window is too narrow for them. The title and meta line also go below
-- SF_FIT.titleMin of room, the whole top band when the seek row would reach it.
SF_FIT = {
	margin = 22, chip = 27, gap = 6, volume = 9 + 90, tc = 28 + 13, seekMin = 48,
	backRight = 40, titleX = 48, titleMin = 40, bandBottom = 36, seekRowTop = 66, play = 43,
	episodeHalfW = 21.5 + 20 + 2 * 15.5,
}
SF_FIT_DROP_ORDER = {"volume_slider", "chapters", "cy_qual", "volume", "cy_audio", "cy_sub"}
SF_FIT_RIGHT_GROUP = {"chapters", "cy_sub", "cy_audio", "cy_qual", "tog_fs"}

function sf_fit_controls(w, h, hasChapters)
	local f = SF_FIT
	local shown = {volume = true, volume_slider = true, chapters = hasChapters, cy_sub = true, cy_audio = true, cy_qual = true, tog_fs = true}
	local function row_fits()
		local left = f.margin - f.gap
		if shown.volume then
			left = f.margin + f.chip + (shown.volume_slider and f.volume or 0)
		end
		local n = 0
		for _, name in ipairs(SF_FIT_RIGHT_GROUP) do
			if shown[name] then n = n + 1 end
		end
		return w - f.margin - n * f.chip - (n - 1) * f.gap - left >= f.gap
	end
	for _, name in ipairs(SF_FIT_DROP_ORDER) do
		if row_fits() then break end
		shown[name] = false
	end
	local fit = {shown = shown}
	fit.timecodes = w - 2 * (f.margin + f.tc) >= f.seekMin
	fit.band = h - f.seekRowTop >= f.bandBottom + f.gap
	fit.title = fit.band and w - f.titleX - f.margin >= f.titleMin
	local top = fit.band and f.bandBottom + f.gap or f.gap
	local bottom = h - f.seekRowTop - f.gap
	-- left edge the centre cluster must stay right of: the back chip's, once it sits in the band's row
	local leftLimit = 0
	if bottom - top < f.play and bottom - f.gap >= f.play and fit.band and w / 2 - f.play / 2 >= f.backRight + f.gap then
		fit.title = false
		top = f.gap
		leftLimit = f.backRight
	end
	fit.centre = bottom - top >= f.play
	fit.centreY = math.max(top + f.play / 2, math.min(h / 2, bottom - f.play / 2))
	fit.episodes = fit.centre and w / 2 - f.episodeHalfW >= leftLimit + f.gap
	return fit
end

-- Top band (PLAY-OVL-01, MPV-OSC-04, Chris 2026-11-09): no window controls; a
-- round back-arrow chip closes the player, then the title (Space Grotesk) over
-- the meta line. Its forced "window-controls" section keeps a click in the band
-- the OSC's (sf.lua's click-to-pause sits below it, see "sf-bindings-ready").
function top_band()
	local bandH = user_opts.heightwcShowHidearea
	local w = osc_param.playresx
	local fit = state.sf_fit
	if not fit.band then
		-- MPV-OSC-05: too low a window for the band; an empty area clears the
		-- forced section the last layout set, so it no longer eats clicks.
		add_area("window-controls", 0, 0, 0, 0)
		return
	end
	-- without the title, only the back chip's corner is the band's
	add_area("window-controls", get_hitbox_coords(0, 0, 7, fit.title and w or SF_FIT.titleX, bandH))
	add_area("showhide_wc", get_hitbox_coords(0, 0, 7, w, bandH))

	-- back chip: 48 CSS px at left 32 / top 24 (virtual px = CSS px / 2)
	local backR = 12
	local backX, backY = 16 + backR, 12 + backR
	local lo = add_layout("back")
	lo.geometry = {x = backX, y = backY, an = 5, w = 2 * backR, h = 2 * backR}
	lo.style = osc_styles.mediumButtons2
	lo.button.chip_r = backR

	if not fit.title then return end
	-- title and meta line, 16 CSS px after the chip, centred on it together;
	-- clipped at the right margin
	local textX = backX + backR + 8
	local textW = w - textX - 22
	local hasMeta = now_playing_meta() ~= ""
	local titleY = hasMeta and backY - 5 or backY
	lo = add_layout("title")
	lo.geometry = {x = textX, y = titleY, an = 4, w = textW, h = 14}
	lo.style = string.format("%s{\\clip(%f,%f,%f,%f)}", osc_styles.topTitle, textX, 0, textX + textW, bandH)
	lo.alpha[3] = 64 -- outline: dark, a little see-through
	if hasMeta then
		lo = add_layout("meta")
		lo.geometry = {x = textX, y = backY + 7.5, an = 4, w = textW, h = 9}
		lo.style = string.format("%s{\\clip(%f,%f,%f,%f)}", osc_styles.topMeta, textX, 0, textX + textW, bandH)
		lo.alpha[1] = 64 -- the meta line at 0.75
		lo.alpha[3] = 128
	end
end

--
-- Modernx Layout
--

function layout()

	local osc_geo = {
		w = osc_param.playresx,
		h = 120 -- Not too low to avoid Thumbnails not disappearing
	}
	user_opts.heightoscShowHidearea = osc_geo.h

	local chapters = mp.get_property_native("chapter-list", {})
	local showChapters
	if #chapters > 0 then
		showChapters = true
	else
		showChapters = false
	end

	-- origin of the controllers, bottom left corner
	local posX = 0
	local posY = osc_param.playresy

	-- alignment
	local refX = osc_geo.w / 2
	local refY = posY

	osc_param.areas = {} -- delete areas

	-- area for active mouse input - OSC hover bottom
	add_area("input", get_hitbox_coords(posX, posY, 1, osc_geo.w, osc_geo.h))

	-- area for show/hide
	add_area("showhide", 0, 0, osc_param.playresx, osc_param.playresy)

	local lo

	-- MPV-OSC-04 (the approved centre-controls design, Chris 2026-11-09), in
	-- virtual px (the mockup's 1440 x 900 CSS px / 2, the windowed scale):
	-- bottom inset 22 left / right and 15 from the bottom; the controls row of
	-- 27-wide chips, 11 above it the times and the seek track.
	local marginX = 22
	local chipSmall = 13.5
	local chipGap = 6
	local rowY = refY - 15 - chipSmall
	local seekY = rowY - chipSmall - 11 - 9
	local tcW = 28
	local seekbarHeight = 11 + user_opts.seekbarHeight
	local seekTrackH = 5 + user_opts.seekbarHeight

	-- Controller Background

	new_element("transBg", "box")
	lo = add_layout("transBg")
	lo.geometry = {x = posX, y = posY, an = 7, w = osc_geo.w, h = 10}
	lo.style = osc_styles.transBg
	lo.layer = 10
	lo.alpha[3] = 0

	-- MPV-OSC-05: what fits this window at full size (sf_fit_controls).
	local fit = sf_fit_controls(osc_geo.w, osc_param.playresy, showChapters)
	state.sf_fit = fit

	-- Seekbar: the played part in the accent, an upright 6 x 36 CSS px pill
	-- thumb 10 px clear of either part, the unplayed part white at 0.25 (render_elements).

	local seekX1 = marginX + (fit.timecodes and tcW + 13 or 0)
	local seekX2 = osc_geo.w - seekX1
	lo = add_layout("seekbar")
	lo.geometry = {x = (seekX1 + seekX2) / 2, y = seekY, an = 5, w = seekX2 - seekX1, h = seekbarHeight}
	lo.style = osc_styles.seekbarFg
	lo.slider.gap = (seekbarHeight - seekTrackH) / 2
	lo.slider.track = true
	lo.slider.thumb = {w = 6 / 10, h = 36 / 10, gap = 10 / 10}
	lo.slider.tooltip_style = osc_styles.tooltip
	lo.slider.tooltip_an = 2

	-- Timecodes, either side of the seek track

	if fit.timecodes then
		lo = add_layout("tc_left")
		lo.geometry = {x = marginX, y = seekY, an = 4, w = tcW, h = 10}
		lo.style = osc_styles.timecodeL

		lo = add_layout("tc_right")
		lo.geometry = {x = osc_geo.w - marginX, y = seekY, an = 6, w = tcW, h = 10}
		lo.style = osc_styles.timecodeR
	end

	-- Bottom-right group (PLAY-OVL-02), left to right: Chapters (only when the
	-- file has chapters), subtitles, audio, quality, fullscreen; packed to the
	-- right edge, without the chips that do not fit (MPV-OSC-05).
	local step = 2 * chipSmall + chipGap
	local chipX = osc_geo.w - marginX - chipSmall
	for i = #SF_FIT_RIGHT_GROUP, 1, -1 do
		local name = SF_FIT_RIGHT_GROUP[i]
		if fit.shown[name] then
			lo = add_layout(name)
			lo.geometry = {x = chipX, y = rowY, an = 5, w = 2 * chipSmall, h = 2 * chipSmall}
			lo.style = osc_styles.mediumButtons2
			lo.button.chip_r = chipSmall
			chipX = chipX - step
		end
	end

	-- Top of the bottom bar (the seek row's thumb, 9 above the track centre): while the controls show,
	-- subtitles stay above it (sf_update_sub_raise).
	state.sf_bottom_chrome_top = seekY - 9

	-- Volume: the mute chip, then the 90-wide volume track 8 after it, on
	-- the chip's centre line
	local volX = marginX + chipSmall
	local volTrackW, volGap = 90, 9
	if fit.shown.volume then
		lo = add_layout("volume")
		lo.geometry = {x = volX, y = rowY, an = 5, w = 2 * chipSmall, h = 2 * chipSmall}
		lo.style = osc_styles.mediumButtons2
		lo.button.chip_r = chipSmall
	end
	if fit.shown.volume_slider then
		lo = add_layout("volume_slider")
		lo.geometry = {x = volX + chipSmall + volGap + volTrackW / 2, y = rowY, an = 5, w = volTrackW, h = 8}
		lo.style = osc_styles.seekbarFg
		lo.slider.gap = 2.25
		lo.slider.track = true
		lo.slider.thumb = {w = 5 / 7, h = 24 / 7, gap = 6 / 7}
		lo.slider.tooltip_style = osc_styles.tooltip
		lo.slider.tooltip_an = 2
	end

	-- Centre (MPV-OSC-04): play / pause in the middle of the picture, the
	-- previous / next EPISODE chips 20 either side, each only when that episode
	-- exists (PLAY-OVL-03), so a movie or a lone episode shows neither. Its own
	-- forced section ("centre") takes clicks only on this cluster. In a low
	-- window it moves up clear of the seek row, or goes (MPV-OSC-05).
	if not fit.centre then
		-- an empty area clears the forced section the last layout set
		add_area("centre", 0, 0, 0, 0)
		return
	end
	local centreY = fit.centreY
	local chipPlay, chipEpisode, gapNav = 21.5, 15.5, 20
	local navX = chipPlay + gapNav + chipEpisode
	lo = add_layout("playpause")
	lo.geometry = {x = refX, y = centreY, an = 5, w = 2 * chipPlay, h = 2 * chipPlay}
	lo.style = osc_styles.bigButtons
	lo.button.chip_r = chipPlay
	lo.button.chip_alpha = chipCentreFillAlpha

	local hasPrevious = fit.episodes and state.episode_nav.hasPrevious
	local hasNext = fit.episodes and state.episode_nav.hasNext
	if hasPrevious then
		lo = add_layout("ep_prev")
		lo.geometry = {x = refX - navX, y = centreY, an = 5, w = 2 * chipEpisode, h = 2 * chipEpisode}
		lo.style = osc_styles.mediumButtons2
		lo.button.chip_r = chipEpisode
		lo.button.chip_alpha = chipCentreFillAlpha
	end

	if hasNext then
		lo = add_layout("ep_next")
		lo.geometry = {x = refX + navX, y = centreY, an = 5, w = 2 * chipEpisode, h = 2 * chipEpisode}
		lo.style = osc_styles.mediumButtons2
		lo.button.chip_r = chipEpisode
		lo.button.chip_alpha = chipCentreFillAlpha
	end

	local centreHalfW = chipPlay
	if hasPrevious or hasNext then
		centreHalfW = navX + chipEpisode
	end
	add_area("centre", refX - centreHalfW, centreY - chipPlay, refX + centreHalfW, centreY + chipPlay)
end

function update_options(list, changed)
	if changed.tick_delay or changed.tick_delay_follow_display_fps then
		set_tick_delay("display_fps", mp.get_property_number("display_fps", nil))
	end
	request_tick()
	set_tick_delay("display_fps", mp.get_property_number("display_fps", nil))
	visibility_mode(user_opts.visibility, true)
	update_duration_watch()
	request_init()
end

-- OSC INIT
function osc_init()

	-- set canvas resolution according to display aspect and scaling setting
	local baseResY = 720
	local display_w, display_h, display_aspect = mp.get_osd_size()
	local scale = 1
	-- MPV-OSC-05: the display's HiDPI scale; 1 where the VO reports none.
	local hidpi = mp.get_property_number("display-hidpi-scale", 1)
	if not hidpi or hidpi <= 0 then hidpi = 1 end

	if (mp.get_property("video") == "no") then -- dummy/forced window
		scale = user_opts.scaleforcedwindow * hidpi
	else
		scale = user_opts.scalewindowed * hidpi
	end
	state.sf_ui_scale = scale

	if user_opts.vidscale then
		osc_param.unscaled_y = baseResY
	else
		osc_param.unscaled_y = display_h
	end
	osc_param.playresy = osc_param.unscaled_y / scale
	if (display_aspect > 0) then
		osc_param.display_aspect = display_aspect
	end
	osc_param.playresx = osc_param.playresy * osc_param.display_aspect

	-- stop seeking with the slider to prevent skipping files
	state.active_element = nil

	elements = {}

	local ne

	-- seekbar

	ne = new_element("seekbar", "slider")
	ne.enabled = not (mp.get_property("percent-pos") == nil)
	state.slider_element = ne.enabled and ne or nil  -- used for forced_title
	ne.slider.markerF = function ()
		local duration = mp.get_property_number("duration")
		if not (duration == nil) then
			local chapters = mp.get_property_native("chapter-list", {})
			local markers = {}
			for n = 1, #chapters do
				markers[n] = (chapters[n].time / duration * 100)
			end
			return markers
		else
			return {}
		end
	end
	ne.slider.posF =
		function () return mp.get_property_number("percent-pos") end
	ne.slider.tooltipF = function (pos)
		local duration = mp.get_property_number("duration")
		if not ((duration == nil) or (pos == nil)) then
			possec = duration * (pos / 100)
			return format_time(possec)
		else
			return ""
		end
	end
	ne.slider.seekRangesF = function()
		if user_opts.seekrangestyle == "none" then
			return nil
		end
		local cache_state = state.cache_state
		if not cache_state then
			return nil
		end
		local duration = mp.get_property_number("duration")
		if (duration == nil) or duration <= 0 then
			return nil
		end
		local ranges = cache_state["seekable-ranges"]
		if #ranges == 0 then
			return nil
		end
		local nranges = {}
		for _, range in pairs(ranges) do
			nranges[#nranges + 1] = {
				["start"] = 100 * range["start"] / duration,
				["end"] = 100 * range["end"] / duration,
			}
		end
		return nranges
	end
	ne.eventresponder["mouse_move"] = --keyframe seeking when mouse is dragged
		function (element)
			-- mouse move events may pile up during seeking and may still get
			-- sent when the user is done seeking, so we need to throw away
			-- identical seeks
			local seekto = get_slider_value(element)
			if (element.state.lastseek == nil) or
				(not (element.state.lastseek == seekto)) then
					local flags = "absolute-percent"
					if not user_opts.seekbarkeyframes then
						flags = flags .. "+exact"
					end
					mp.commandv("seek", seekto, flags)
					announce_osc_seek(seekto)
					element.state.lastseek = seekto
			end

		end
	ne.eventresponder["mbtn_left_down"] = --exact seeks on single clicks
		function (element)
			local seekto = get_slider_value(element)
			mp.commandv("seek", seekto, "absolute-percent+exact")
			announce_osc_seek(seekto)
		end
	ne.eventresponder["mbtn_right_up"] = function () -- right clic : switch chapter mode on / off
		user_opts.showChapters = not user_opts.showChapters
		request_init()
	end
	ne.eventresponder["wheel_up_press"] = function () -- mouse wheel : bar height
		if user_opts.seekbarHeight <= 9 then
			user_opts.seekbarHeight = user_opts.seekbarHeight + 1
			request_init()
		end
	end
	ne.eventresponder["wheel_down_press"] = function () -- mouse wheel : bar height
		if user_opts.seekbarHeight > 0 then
			user_opts.seekbarHeight = user_opts.seekbarHeight - 1
			request_init()
		end
	end
	ne.eventresponder["reset"] = function
		(element) element.state.lastseek = nil 
	end

	-- title: the "what's playing" line, top-left on every media (PLAY-OVL-01).
	-- The desktop app sets force-media-title through sf.lua; the seekbar's
	-- chapter name no longer stamps over it, and it stays shown with or
	-- without chapters.

	ne = new_element("title", "button")
	ne.visible = true
	ne.hoverable = false
	ne.content = function ()
		local title = mp.command_native({"expand-text", user_opts.title})
		title = title:gsub("\\n", " "):gsub("\\$", ""):gsub("{","\\{")
		return title
	end

	-- meta: the line under the title (now_playing_meta)

	ne = new_element("meta", "button")
	ne.hoverable = false
	ne.content = now_playing_meta

	-- back: closes the player, like the window controls' close did (MPV-OSC-04)

	ne = new_element("back", "button")
	ne.content = osc_icons.back
	ne.eventresponder["mbtn_left_up"] = function ()
		msg.info("[sf-back] back clicked -> quit")
		mp.commandv("quit")
	end

	-- tc_left (current pos)

	ne = new_element("tc_left", "button")
	ne.hoverable = false
	ne.styledown = true
	ne.content = function ()
		return format_time(mp.get_property_number("playback-time", 0))
	end
	if user_opts.showTooltip then
		ne.tooltip_style = osc_styles.tooltip
		ne.tooltipF = function ()
			local title = state.forced_title or mp.command_native({"expand-text", user_opts.title})
			title = title:gsub("\\n", " "):gsub("\\$", ""):gsub("{","\\{")
			return title
		end
	end
	-- (SpaceBadger) no click toggles on tc_left: the title is always shown.
	ne.eventresponder["wheel_down_press"] = function ()
		mp.commandv("seek", -user_opts.jumpValue)
	end
	ne.eventresponder["wheel_up_press"] = function ()
		mp.commandv("seek", user_opts.jumpValue) 
	end
		
	-- separator /

	ne = new_element("tc_separator", "button")
	ne.hoverable = false
	ne.styledown = false
	ne.visible = false
	ne.content = function () return "/" end

	-- tc_right (total/remaining time)

	ne = new_element("tc_right", "button")
	ne.hoverable = false
	ne.styledown = false
	ne.content = function ()
		if user_opts.timetotal then
			return format_time(mp.get_property_number("playtime-remaining", 0))
		end
		return format_time(mp.get_property_number("duration", 0))
	 end
	ne.eventresponder["mbtn_left_up"] = function ()
		user_opts.timetotal = not user_opts.timetotal
	end
	ne.eventresponder["mbtn_right_up"] = function () -- right clic : switch UI minimal / default
		request_init()
	end
	ne.eventresponder["wheel_up_press"] = function () -- wheel : move bar up / down in minimal UI mode
		if user_opts.minimalSeekY > 0 then
			user_opts.minimalSeekY = user_opts.minimalSeekY - 1
		end
		request_init()
	end
	ne.eventresponder["wheel_down_press"] = function () -- wheel : move bar up / down in minimal UI mode
		if user_opts.minimalSeekY < 50 then
			user_opts.minimalSeekY = user_opts.minimalSeekY + 1
		end
		request_init()
	end

	--
	-- big buttons
	--

	-- playpause

	ne = new_element("playpause", "button")
	ne.content = function ()
		if mp.get_property("pause") == "yes" then
			return (osc_icons.play)
		else
			return (osc_icons.pause)
		end
	end
	ne.eventresponder["mbtn_left_up"] = function ()
		mp.commandv("cycle", "pause") 
	end
	-- (SpaceBadger) no right-click colour cycling: the accent is the phone player's (MPV-OSC-03).

	-- SpaceBadger player overlay (Chris 2026-10-29, PLAY-OVL-02 / PLAY-OVL-03):
	-- the centre previous / next buttons step between playable EPISODES (sf.lua
	-- publishes which neighbours exist in user-data/sf/episode-nav and turns a
	-- press into the app's osc action). They are not laid out when there is no
	-- such episode, so neither shows on a movie. Chapters are picked only from
	-- the Chapters button in the bottom-right group; the old chapter-skip buttons are gone.

	-- ep_prev

	ne = new_element("ep_prev", "button")
	ne.content = osc_icons.episode_prev
	if user_opts.showTooltip then
		ne.tooltip_style = osc_styles.tooltip
		ne.tooltipF = function ()
			return state.episode_nav.previousLabel or ""
		end
	end
	ne.eventresponder["mbtn_left_up"] = function ()
		msg.info("[sf-episode] ep_prev clicked -> sf-episode-nav previous")
		mp.commandv("script-message-to", "sf", "sf-episode-nav", "previous")
	end

	-- ep_next

	ne = new_element("ep_next", "button")
	ne.content = osc_icons.episode_next
	if user_opts.showTooltip then
		ne.tooltip_style = osc_styles.tooltip
		ne.tooltipF = function ()
			return state.episode_nav.nextLabel or ""
		end
	end
	ne.eventresponder["mbtn_left_up"] = function ()
		msg.info("[sf-episode] ep_next clicked -> sf-episode-nav next")
		mp.commandv("script-message-to", "sf", "sf-episode-nav", "next")
	end

	-- chapters (bottom-right group): opens the chapter picker, only laid out when the
	-- file has chapters (PLAY-OVL-02).

	ne = new_element("chapters", "button")
	ne.content = osc_icons.chapters
	ne.eventresponder["mbtn_left_up"] = function ()
		msg.info("[sf-chapters] chapters button clicked -> sf_select/select-chapter")
		mp.commandv("script-binding", "sf_select/select-chapter")
	end

	update_tracklist()

	-- cy_audio

	ne = new_element("cy_audio", "button")
	ne.enabled = (#tracks_osc.audio > 0)
	ne.off = (get_track("audio") == 0)
	ne.content = osc_icons.audio
	ne.eventresponder["mbtn_left_up"] = function ()
		mp.commandv("script-binding", "sf_select/select-aid")
		mp.commandv("script-message-to", "osc", "osc-hide")
	end

	-- cy_sub

	ne = new_element("cy_sub", "button")
	-- Never greyed, even with no subtitle track (#2500, PLAY-SUBGET-05): sf-select
	-- then opens its menu, Off and "Get more subtitles…" (PLAY-SUBGET-24).
	ne.content = osc_icons.captions
	ne.eventresponder["mbtn_left_up"] = function ()
		mp.commandv("script-binding", "sf_select/select-sid")
		mp.commandv("script-message-to", "osc", "osc-hide")
	end

	-- cy_qual

	ne = new_element("cy_qual", "button")
	ne.content = osc_icons.quality
	ne.eventresponder["mbtn_left_up"] = function ()
		mp.commandv("script-binding", "sf_select/select-vid")
		mp.commandv("script-message-to", "osc", "osc-hide")
	end

	-- tog_fs

	ne = new_element("tog_fs", "button")
	ne.content = function ()
		if state.fullscreen then
			return osc_icons.fullscreen_exit
		else
			return osc_icons.fullscreen
		end
	end
	ne.eventresponder["mbtn_left_up"] = function ()
		mp.commandv("cycle", "fullscreen") 
	end

	-- volume

	ne = new_element("volume", "button")
	ne.content = function()
		local volume = mp.get_property_number("volume", 0)
		local mute = mp.get_property_native("mute")
		if volume == 0 or mute then
			return osc_icons.volume_mute
		else
			return osc_icons.volume
		end
	end
	ne.eventresponder["mbtn_left_up"] = function ()
		mp.commandv("cycle", "mute")
	end
	ne.eventresponder["wheel_up_press"] = function ()
		mp.commandv("osd-auto", "add", "volume", 5) 
	end
	ne.eventresponder["wheel_down_press"] = function ()
		mp.commandv("osd-auto", "add", "volume", -5) 
	end

	-- volume slider

	ne = new_element("volume_slider", "slider")
	ne.visible = user_opts.volume_control
	ne.slider.posF = function ()
		local mute = mp.get_property_native("mute")
		if mute then
			return 0
		else
			return mp.get_property_number("volume", 0)
		end
	end
	ne.slider.seekRangesF = function()
	  return nil
	end
	ne.slider.tooltipF = function (pos)
		if pos == nil then
			return ""
		end
		return string.format("%d%%", math.floor(pos + 0.5))
	end
	ne.eventresponder["mouse_move"] = function (element)
		local volume = get_slider_value(element)
		if volume ~= nil then
			mp.set_property_number("volume", volume)
		end
	end
	ne.eventresponder["mbtn_left_down"] = function (element)
		local volume = get_slider_value(element)
		if volume ~= nil then
			mp.set_property_number("volume", volume)
		end
	end

	-- cache

	if user_opts.showCache then
		ne = new_element("cache", "button")
		ne.visible = (osc_param.playresx >= user_opts.visibleButtonsW)
		ne.hoverable = false
		ne.content = function ()
			local cache_state = state.cache_state
			--if not (cache_state and cache_state["seekable-ranges"] and
			--	#cache_state["seekable-ranges"] > 0) then
				-- probably not a network stream
			   -- return ""
			--end
			local dmx_cache = cache_state and cache_state["cache-duration"]
			local thresh = math.min(state.dmx_cache * 0.05, 5)  -- 5% or 5s
			if dmx_cache and math.abs(dmx_cache - state.dmx_cache) >= thresh then
				state.dmx_cache = dmx_cache
			else
				dmx_cache = state.dmx_cache
			end
			local min = math.floor(dmx_cache / 60)
			local sec = math.floor(dmx_cache % 60) -- don't round e.g. 59.9 to 60
			return "Cache : " .. (min > 0 and
				string.format("%sm%02.0fs", min, sec) or
				string.format("%3.0fs", sec))
		end
	end

	-- save params external file

	-- load layout
	layout()

	-- top band: back chip, title, meta line (MPV-OSC-04)
	top_band()

	-- do something with the elements
	prepare_elements()
	-- the band's OSD height follows the scale (windowed / fullscreen)
	publish_top_band()
	-- the bottom bar's height follows the scale too
	sf_update_sub_raise()
end

--
-- Other important stuff
--

function show_osc()

	-- show when disabled can happen (e.g. mouse_move) due to async/delayed unbinding
	if not state.enabled then return end

	--remember last time of invocation (mouse move)
	state.showtime = mp.get_time()

	osc_visible(true)

	if get_fadeduration() > 0 then
		state.anitype = nil
	end
end

function hide_osc()
	if user_opts.oscMode == "always" then
		osc_visible(true)
	elseif not state.enabled then
		-- typically hide happens at render() from tick(), but now tick() is
		-- no-op and won't render again to remove the osc, so do that manually.
		state.osc_visible = false
		publish_top_band()
		sf_update_sub_raise()
		render_wipe()
	elseif get_fadeduration() > 0 then
		if state.osc_visible then
			state.anitype = "out"
			request_tick()
		end
	else
		osc_visible(false)
	end
end

-- SpaceBadger: sf.lua draws its skip pill (Skip intro / Skip credits / Next
-- episode) in the top-left corner, where the what's-playing title sits while
-- the controls show. Publish whether the controls are shown and where their
-- top band ends (OSD px) so sf.lua moves the pill below it (PLAY-OVL-01).
local published_top_band_key = nil
function publish_top_band()
	local _, sy = get_virt_scale_factor()
	local bottom = sy > 0 and math.ceil(user_opts.heightwcShowHidearea / sy) or 0
	local shown = state.osc_visible == true
	local key = tostring(shown) .. ":" .. bottom
	if key == published_top_band_key then
		return
	end
	published_top_band_key = key
	mp.set_property_native("user-data/sf/osc-top-band", { visible = shown, bottom = bottom })
	msg.info("[sf-osc-top-band] visible=" .. tostring(shown) .. " bottom=" .. bottom)
end

function osc_visible(visible)
	if state.osc_visible ~= visible then
		state.osc_visible = visible
	end
	publish_top_band()
	sf_update_sub_raise()
	request_tick()
end

-- SpaceBadger (desktop): while the controls show, subtitles move up above the
-- bottom bar so they never sit behind the seekbar or the buttons; when the
-- controls hide, the user's own sub-pos comes back (Chris 2026-10-29). The lift
-- only clears the bar: a line already above it does not move (Chris 2026-10-30).
-- sub-pos places the line's bottom in proportion down a box: the window for
-- text subs libass may draw in the black bars (SRT / WebVTT with
-- sub-use-margins), the video picture for the others (ASS without
-- sub-ass-use-margins; picture subs, PGS / VobSub / DVB / XSUB, shifted by
-- (100 - sub-pos) % of the picture). In a letterboxed window the picture box
-- ends above the lower black band, so the bar's top is measured in that box.
-- Picture subs are told apart by codec: mpv's track `image` flag only marks
-- cover-art video tracks, never subtitles.
local SF_PICTURE_SUB_CODECS = {
	hdmv_pgs_subtitle = true, dvd_subtitle = true, dvb_subtitle = true, xsub = true,
}
local function sf_sub_box()
	local dims = mp.get_property_native("osd-dimensions")
	if not dims or not dims.h or dims.h <= 0 then return nil end
	local track = mp.get_property_native("current-tracks/sub")
	local in_picture = true
	if track and not SF_PICTURE_SUB_CODECS[track.codec] then
		if track.codec == "ass" or track.codec == "ssa" then
			in_picture = not mp.get_property_bool("sub-ass-use-margins", false)
		else
			in_picture = not mp.get_property_bool("sub-use-margins", true)
		end
	end
	if in_picture then
		-- the line's own bottom margin (ASS MarginV, image placement) is unknown:
		-- 0 assumes the line sits on the box's bottom edge, which can only lift
		-- less than a perfect fit, never into the bar
		return { top = dims.mt or 0, height = dims.h - (dims.mt or 0) - (dims.mb or 0), margin = 0, osd_h = dims.h, kind = "picture" }
	end
	-- text subs keep sub-margin-y (scaled px of a 720-line OSD) under the line;
	-- the line's bottom then sits at (h - margin) * sub-pos / 100
	local margin = mp.get_property_number("sub-margin-y", 22) * dims.h / 720
	return { top = 0, height = dims.h, margin = margin, osd_h = dims.h, kind = "window" }
end

local sf_sub_raise = { raised = false, saved_pos = nil, applied_pos = nil }
function sf_update_sub_raise()
	local top = state.sf_bottom_chrome_top
	local box = (state.osc_visible == true and top ~= nil and osc_param.playresy > 0) and sf_sub_box() or nil
	if box and box.height - box.margin > 0 then
		local top_px = top / osc_param.playresy * box.osd_h
		-- in 1/64 steps: exact in mpv's single-precision sub-pos, so the value read
		-- back equals applied_pos and is not taken for a user change
		local pos = math.floor((top_px - box.top) / (box.height - box.margin) * 100 * 64) / 64
		pos = math.max(0, math.min(100, pos))
		if not sf_sub_raise.raised then
			sf_sub_raise.saved_pos = mp.get_property_number("sub-pos", 100)
			sf_sub_raise.raised = true
		end
		-- never lower subtitles the user already placed higher
		pos = math.min(pos, sf_sub_raise.saved_pos)
		if sf_sub_raise.applied_pos ~= pos then
			sf_sub_raise.applied_pos = pos
			mp.set_property_number("sub-pos", pos)
			msg.info(string.format("[sf-subs] controls shown: sub-pos %s -> %.2f (bottom bar top y=%.1f px; %s box y=%d h=%d of %d)",
				tostring(sf_sub_raise.saved_pos), pos, top_px, box.kind, box.top, box.height, box.osd_h))
		end
	elseif sf_sub_raise.raised then
		mp.set_property_number("sub-pos", sf_sub_raise.saved_pos)
		msg.info(string.format("[sf-subs] controls hidden: sub-pos restored to %s", tostring(sf_sub_raise.saved_pos)))
		sf_sub_raise.raised = false
		sf_sub_raise.saved_pos = nil
		sf_sub_raise.applied_pos = nil
	end
end

-- The box changes with the window (letterbox bands) and with the subtitle track.
mp.observe_property("osd-dimensions", "native", function() sf_update_sub_raise() end)
mp.observe_property("current-tracks/sub", "native", function() sf_update_sub_raise() end)

-- A sub-pos change while the subtitles are lifted (anything other than the
-- value this script applied) is the user's new place: keep it for the hide,
-- and reapply the lift as min(lift, new place) (agent reading, approved by
-- Main 2026-10-29, review of PR 821). The script's own writes come back here
-- as the applied value and are ignored.
mp.observe_property("sub-pos", "number", function(_, value)
	if not sf_sub_raise.raised or value == nil or value == sf_sub_raise.applied_pos then return end
	msg.info(string.format("[sf-subs] user moved sub-pos while lifted: %s (applied %s, saved %s)",
		tostring(value), tostring(sf_sub_raise.applied_pos), tostring(sf_sub_raise.saved_pos)))
	sf_sub_raise.saved_pos = value
	sf_sub_raise.applied_pos = nil
	sf_update_sub_raise()
end)

function pause_state(name, enabled)
	state.paused = enabled
	mp.add_timeout(0.1, function() state.osd:update() end)
	if user_opts.showonpause then
		if enabled then
			state.lastvisibility = user_opts.visibility
			visibility_mode("always", true)
			show_osc()
		else
			visibility_mode(state.lastvisibility, true)
		end
	end
	request_tick()
end

function cache_state(name, st)
	state.cache_state = st
	request_tick()
end

-- Request that tick() is called (which typically re-renders the OSC).
-- The tick is then either executed immediately, or rate-limited if it was
-- called a small time ago.
function request_tick()
	if state.tick_timer == nil then
		state.tick_timer = mp.add_timeout(0, tick)
	end

	if not state.tick_timer:is_enabled() then
		local now = mp.get_time()
		local timeout = tick_delay - (now - state.tick_last_time)
		if timeout < 0 then
			timeout = 0
		end
		state.tick_timer.timeout = timeout
		state.tick_timer:resume()
	end
end

function mouse_leave()
	if get_hidetimeout() >= 0 then
		hide_osc()
	end
	-- reset mouse position
	state.last_mouseX, state.last_mouseY = nil, nil
	state.mouse_in_window = false
end

function request_init()
	state.initREQ = true
	request_tick()
end

-- Like request_init(), but also request an immediate update
function request_init_resize()
	request_init()
	-- ensure immediate update
	state.tick_timer:kill()
	state.tick_timer.timeout = 0
	state.tick_timer:resume()
end

function render_wipe()
	msg.trace("render_wipe()")
	state.osd.data = "" -- allows set_osd to immediately update on enable
	state.osd:remove()
end

-- A forced section with one mouse rect (the top band, the centre cluster):
-- its rect follows the layout while the OSC shows. SpaceBadger (#25 size/perf
-- §4.3): the section is pushed only when the OSC's visibility flips;
-- re-enabling it on every render tick (upstream) logged one `enable-section`
-- command per video frame and rebuilt the input stack each frame.
-- "sf-bindings-ready" re-pushes it after sf.lua's own flush. Returns whether
-- the mouse is over the rect.
function sync_forced_area(name, flag)
	local areas = osc_param.areas[name]
	if not areas then
		return false
	end
	local over = false
	for _, cords in ipairs(areas) do
		if state.osc_visible then -- activate only when OSC is actually visible
			set_virt_mouse_area(cords.x1, cords.y1, cords.x2, cords.y2, name)
		end
		if mouse_hit_coords(cords.x1, cords.y1, cords.x2, cords.y2) then
			over = true
		end
	end
	if state.osc_visible ~= state[flag] then
		if state.osc_visible then
			mp.enable_key_bindings(name)
		else
			mp.disable_key_bindings(name)
		end
		state[flag] = state.osc_visible
	end
	return over
end

function render()
	msg.trace("rendering")
	local current_screen_sizeX, current_screen_sizeY, aspect = mp.get_osd_size()
	local mouseX, mouseY = get_virt_mouse_pos()
	local now = mp.get_time()

	-- check if display changed, if so request reinit
	if not (state.mp_screen_sizeX == current_screen_sizeX
		and state.mp_screen_sizeY == current_screen_sizeY) then

		request_init_resize()

		state.mp_screen_sizeX = current_screen_sizeX
		state.mp_screen_sizeY = current_screen_sizeY
	end

	-- init management
	if state.active_element then
		-- mouse is held down on some element - keep ticking and igore initReq
		-- till it's released, or else the mouse-up (click) will misbehave or
		-- get ignored. that's because osc_init() recreates the osc elements,
		-- but mouse handling depends on the elements staying unmodified
		-- between mouse-down and mouse-up (using the index active_element).
		request_tick()
	elseif state.initREQ then
		osc_init()
		state.initREQ = false

		-- store initial mouse position
		if (state.last_mouseX == nil or state.last_mouseY == nil)
			and not (mouseX == nil or mouseY == nil) then

			state.last_mouseX, state.last_mouseY = mouseX, mouseY
		end
	end

	-- fade animation
	if not(state.anitype == nil) then

		if (state.anistart == nil) then
			state.anistart = now
		end

		if (now < state.anistart + (get_fadeduration()/1000)) then
			if (state.anitype == "in") then --fade in
				osc_visible(true)
				state.animation = scale_value(state.anistart,
					(state.anistart + (get_fadeduration()/1000)),
					255, 0, now)
			elseif (state.anitype == "out") then --fade out
				state.animation = scale_value(state.anistart,
					(state.anistart + (get_fadeduration()/1000)),
					0, 255, now)
			end
		else
			if (state.anitype == "out") then
				osc_visible(false)
			end
			kill_animation()
		end
	else
		kill_animation()
	end

	-- mouse show/hide area
	for k,cords in pairs(osc_param.areas["showhide"]) do
		set_virt_mouse_area(cords.x1, cords.y1, cords.x2, cords.y2, "showhide")
	end
	if osc_param.areas["showhide_wc"] then
		for k,cords in pairs(osc_param.areas["showhide_wc"]) do
			set_virt_mouse_area(cords.x1, cords.y1, cords.x2, cords.y2, "showhide_wc")
		end
	else
		set_virt_mouse_area(0, 0, 0, 0, "showhide_wc")
	end
	do_enable_keybindings()

	-- mouse input area
	local mouse_over_osc = false

	for _,cords in ipairs(osc_param.areas["input"]) do
		if state.osc_visible then -- activate only when OSC is actually visible
			set_virt_mouse_area(cords.x1, cords.y1, cords.x2, cords.y2, "input")
		end
		if state.osc_visible ~= state.input_enabled then
			if state.osc_visible then
				mp.enable_key_bindings("input")
			else
				mp.disable_key_bindings("input")
			end
			state.input_enabled = state.osc_visible
		end

		if (mouse_hit_coords(cords.x1, cords.y1, cords.x2, cords.y2)) then
			mouse_over_osc = true
		end
	end

	-- the top band ("window-controls") and the centre cluster ("centre",
	-- MPV-OSC-04): forced sections of their own, each one mouse rect
	if sync_forced_area("window-controls", "wc_enabled") then
		mouse_over_osc = true
	end
	if sync_forced_area("centre", "centre_enabled") then
		mouse_over_osc = true
	end

	-- autohide
	if not (state.showtime == nil) and (get_hidetimeout() >= 0) then
		local timeout = state.showtime + (get_hidetimeout()/1000) - now
		if timeout <= 0 then
			if (state.active_element == nil) and not (mouse_over_osc) then
				hide_osc()
			end
		else
			-- the timer is only used to recheck the state and to possibly run
			-- the code above again
			if not state.hide_timer then
				state.hide_timer = mp.add_timeout(0, tick)
			end
			state.hide_timer.timeout = timeout
			-- re-arm
			state.hide_timer:kill()
			state.hide_timer:resume()
		end
	end

	-- actual rendering
	local ass = assdraw.ass_new()

	-- Messages
	render_message(ass)

	-- actual OSC
	if state.osc_visible then
		render_elements(ass)
	else
		hide_thumbnail()
		sf_preview_leave()
	end

	-- submit
	set_osd(osc_param.playresy * osc_param.display_aspect,
			osc_param.playresy, ass.text)
end

--
-- Event handling
--

local function element_has_action(element, action)
	return element and element.eventresponder and
		element.eventresponder[action]
end

function process_event(source, what)
	local action = string.format("%s%s", source,
		what and ("_" .. what) or "")

	if what == "down" or what == "press" then

		for n = 1, #elements do

			if mouse_hit(elements[n]) and
				elements[n].eventresponder and
				(elements[n].eventresponder[source .. "_up"] or
					elements[n].eventresponder[action]) then

				if what == "down" then
					state.active_element = n
					state.active_event_source = source
				end
				-- fire the down or press event if the element has one
				if element_has_action(elements[n], action) then
					elements[n].eventresponder[action](elements[n])
				end

			end
		end

	elseif what == "up" then

		if elements[state.active_element] then
			local n = state.active_element

			if n == 0 then
				--click on background (does not work)
			elseif element_has_action(elements[n], action) and
				mouse_hit(elements[n]) then

				elements[n].eventresponder[action](elements[n])
			end

			--reset active element
			if element_has_action(elements[n], "reset") then
				elements[n].eventresponder["reset"](elements[n])
			end

		end
		state.active_element = nil
		state.mouse_down_counter = 0

	elseif source == "mouse_move" then

		state.mouse_in_window = true
		
		local mouseX, mouseY = get_virt_mouse_pos()
		-- OSC hover Top / Bottom
		if (user_opts.minmousemove < 0) then
			if (mouseY >= (osc_param.playresy - user_opts.heightoscShowHidearea)) or (mouseY <= user_opts.heightwcShowHidearea)
			then
				show_osc()
			end
		-- OSC when mouse moves
		elseif (not ((state.last_mouseX == nil) or (state.last_mouseY == nil)) and
				((math.abs(mouseX - state.last_mouseX) >= user_opts.minmousemove)
					or (math.abs(mouseY - state.last_mouseY) >= user_opts.minmousemove))) then
			show_osc()
		end
		state.last_mouseX, state.last_mouseY = mouseX, mouseY

		local n = state.active_element
		if element_has_action(elements[n], action) then
			elements[n].eventresponder[action](elements[n])
		end
	end

	-- ensure rendering after any (mouse) event - icons could change etc
	request_tick()
end

-- called by mpv on every frame
function tick()
	if state.marginsREQ == true then
		state.marginsREQ = false
	end

	if (not state.enabled) then return end

	if (state.idle) then

		-- render idle message
		msg.trace("idle message")
		local icon_x, icon_y = 320 - 26, 140

		local ass = assdraw.ass_new()

		 if user_opts.idlescreen then
			ass:new_event()
			ass:pos(320, icon_y+65)
			ass:an(8)
			--ass:append("Drop files or URLs to play here.")
		end
		set_osd(640, 360, ass.text)

		if state.showhide_enabled then
			mp.disable_key_bindings("showhide")
			mp.disable_key_bindings("showhide_wc")
			state.showhide_enabled = false
		end

	elseif (state.fullscreen and user_opts.showfullscreen)
		or (not state.fullscreen and user_opts.showwindowed) then

		-- render the OSC
		render()
	else
		-- Flush OSD
		render_wipe()
	end

	state.tick_last_time = mp.get_time()

	if state.anitype ~= nil then
		-- state.anistart can be nil - animation should now start, or it can
		-- be a timestamp when it started. state.idle has no animation.
		if not state.idle and
		   (not state.anistart or
			mp.get_time() < 1 + state.anistart + get_fadeduration()/1000)
		then
			-- animating or starting, or still within 1s past the deadline
			request_tick()
		else
			kill_animation()
		end
	end
end

function do_enable_keybindings()
	if state.enabled then
		if not state.showhide_enabled then
			mp.enable_key_bindings("showhide", "allow-vo-dragging+allow-hide-cursor")
			mp.enable_key_bindings("showhide_wc", "allow-vo-dragging+allow-hide-cursor")
		end
		state.showhide_enabled = true
	end
end

function enable_osc(enable)
	state.enabled = enable
	if enable then
		do_enable_keybindings()
	else
		hide_osc() -- acts immediately when state.enabled == false
		if state.showhide_enabled then
			mp.disable_key_bindings("showhide")
			mp.disable_key_bindings("showhide_wc")
		end
		state.showhide_enabled = false
	end
end

-- duration is observed for the sole purpose of updating chapter markers
-- positions. live streams with chapters are very rare, and the update is also
-- expensive (with request_init), so it's only observed when we have chapters
-- and the user didn't disable the livemarkers option (update_duration_watch).
function on_duration() request_init() end

local duration_watched = false
function update_duration_watch()
	local want_watch = user_opts.livemarkers and
					   (mp.get_property_number("chapters", 0) or 0) > 0 and
					   true or false  -- ensure it's a boolean

	if (want_watch ~= duration_watched) then
		if want_watch then
			mp.observe_property("duration", nil, on_duration)
		else
			mp.unobserve_property(on_duration)
		end
		duration_watched = want_watch
	end
end

-- the meta line lays the title out over it: re-lay when it comes or goes
-- (sf.lua's meta; the runtime once the duration is known)
local meta_shown = nil
function on_meta_change()
	local shown = now_playing_meta() ~= ""
	if shown ~= meta_shown then
		meta_shown = shown
		request_init()
	end
end
mp.observe_property("user-data/sf/now-playing-meta", "native", on_meta_change)
mp.observe_property("duration", "number", on_meta_change)
update_duration_watch()

local function set_tick_delay(_, display_fps)
	-- may be nil if unavailable or 0 fps is reported
	if not display_fps or not user_opts.tick_delay_follow_display_fps then
		tick_delay = user_opts.tick_delay
		return
	end
	tick_delay = 1 / display_fps
end

-- Save params on exit
function shutdown()
end

mp.register_event("shutdown", shutdown)
mp.register_event("start-file", request_init)
if user_opts.showonstart then mp.register_event("file-loaded", show_osc) end
if user_opts.showonseek then mp.register_event("seek", show_osc) end

mp.observe_property("track-list", nil, request_init)
mp.observe_property("playlist", nil, request_init)
mp.observe_property("chapter-list", "native", function(_, list)
	list = list or {}  -- safety, shouldn't return nil
	table.sort(list, function(a, b) return a.time < b.time end)
	state.chapter_list = list
	update_duration_watch()
	request_init()
end)

-- SpaceBadger (PLAY-OVL-03): sf.lua publishes which neighbouring playable
-- episodes exist; re-layout so ep_prev / ep_next appear or vanish.
mp.observe_property("user-data/sf/episode-nav", "native", function(_, nav)
	state.episode_nav = type(nav) == "table" and nav or {}
	msg.info(string.format("[sf-episode] episode-nav hasPrevious=%s hasNext=%s",
		tostring(state.episode_nav.hasPrevious), tostring(state.episode_nav.hasNext)))
	request_init()
end)

mp.register_script_message("osc-message", show_message)
mp.register_script_message("osc-chapterlist", function(dur)
	show_message(get_chapterlist(), dur)
end)
mp.register_script_message("osc-playlist", function(dur)
	show_message(get_playlist(), dur)
end)
mp.register_script_message("osc-tracklist", function(dur)
	local msg = {}
	for k,v in pairs(nicetypes) do
		table.insert(msg, get_tracklist(k))
	end
	show_message(table.concat(msg, "\n\n"), dur)
end)

mp.observe_property("fullscreen", "bool", function(_, val)
	state.fullscreen = val
	state.marginsREQ = true
	request_init_resize()
end)
-- MPV-OSC-05: the window moved to a display with another scale.
mp.observe_property("display-hidpi-scale", "number", function()
	request_init_resize()
end)
mp.observe_property("idle-active", "bool", function(_, val)
	state.idle = val
	request_tick()
end)

mp.observe_property("display-fps", "number", set_tick_delay)
mp.observe_property("pause", "bool", pause_state)
mp.observe_property("demuxer-cache-state", "native", cache_state)
mp.observe_property("vo-configured", "bool", function(name, val)
	request_tick()
end)
mp.observe_property("playback-time", "number", function(name, val)
	request_tick()
end)
mp.observe_property("osd-dimensions", "native", function(name, val)
	-- (we could use the value instead of re-querying it all the time, but then
	--  we might have to worry about property update ordering)
	request_init_resize()
end)

-- OnTop while playing
-- https://github.com/mpv-player/mpv/blob/master/TOOLS/lua/ontop-playback.lua

mp.observe_property("pause", "bool", function(_, value)
	if user_opts.onTopWhilePlaying then
		local ontop = mp.get_property_native("ontop")
		if value then
			if ontop then
				mp.set_property_native("ontop", false)
				was_ontop = true
			end
		else
			if not ontop then
				mp.set_property_native("ontop", true) 
			end
		end
	end
end)

-- mouse show/hide bindings
mp.set_key_bindings({
	{"mouse_move",			function(e) process_event("mouse_move", nil) end},
	{"mouse_leave",			mouse_leave},
}, "showhide", "force")
mp.set_key_bindings({
	{"mouse_move",			function(e) process_event("mouse_move", nil) end},
	{"mouse_leave",			mouse_leave},
}, "showhide_wc", "force")
do_enable_keybindings()

-- SpaceBadger P9 (#25): sf.lua draws its Skip intro / Skip credits / Next
-- episode pill top-left, under our forced window-controls band (84 OSD px tall
-- in fullscreen). Our forced sections sit above sf.lua's MBTN_LEFT binding
-- (see "sf-bindings-ready" below), so a pill click was swallowed here.
-- sf.lua publishes the pill hit rect (OSD pixels) in user-data/sf/pill-rect;
-- clicks inside it are forwarded to sf.lua so the pill always wins its area.
function sf_pill_hit()
	local rect = mp.get_property_native("user-data/sf/pill-rect")
	if type(rect) ~= "table" or not rect.active then
		return false
	end
	local mx, my = mp.get_mouse_pos()
	return mx >= rect.left and mx <= rect.right and my >= rect.top and my <= rect.bottom
end

function mbtn_left_event(what)
	if sf_pill_hit() then
		msg.info("[sf-pill] mbtn_left " .. what .. " inside pill rect, forwarding to sf")
		mp.commandv("script-message-to", "sf", "sf-pill-mouse", what)
		return
	end
	process_event("mbtn_left", what)
end

--mouse input bindings
mp.set_key_bindings({
	{"mbtn_left",			function(e) mbtn_left_event("up") end,
							function(e) mbtn_left_event("down")  end},
	{"shift+mbtn_left",		function(e) process_event("shift+mbtn_left", "up") end,
							function(e) process_event("shift+mbtn_left", "down")  end},
	{"mbtn_right",			function(e) process_event("mbtn_right", "up") end,
							function(e) process_event("mbtn_right", "down")  end},
	-- alias to shift_mbtn_left for single-handed mouse use
	{"mbtn_mid",			function(e) process_event("shift+mbtn_left", "up") end,
							function(e) process_event("shift+mbtn_left", "down")  end},
	{"wheel_up",			function(e) process_event("wheel_up", "press") end},
	{"wheel_down",			function(e) process_event("wheel_down", "press") end},
	{"shift+wheel_up",		function(e) process_event("shift+wheel_up", "press") end},
	{"shift+wheel_down",	function(e) process_event("shift+wheel_down", "press") end},
	{"mbtn_left_dbl", 		"ignore"},
	{"shift+mbtn_left_dbl",	"ignore"},
	{"mbtn_right_dbl",		"ignore"},
}, "input", "force")
mp.enable_key_bindings("input")

mp.set_key_bindings({
	{"mbtn_left",			function(e) mbtn_left_event("up") end,
							function(e) mbtn_left_event("down")  end},
}, "window-controls", "force")
mp.enable_key_bindings("window-controls")

-- the centre cluster (MPV-OSC-04): play / pause and the episode chips
mp.set_key_bindings({
	{"mbtn_left",			function(e) mbtn_left_event("up") end,
							function(e) mbtn_left_event("down")  end},
}, "centre", "force")
mp.enable_key_bindings("centre")

-- SpaceBadger (#25 size/perf §4.3): the newest enabled section wins, and our
-- sections are pushed only when the OSC's visibility flips. sf.lua flushes its
-- forced section (MBTN_LEFT = click-to-pause) from its own thread, possibly
-- after our first reveal (a paused start shows the OSC at once). sf.lua sends
-- this once its bindings are live; re-push ours on top while they are enabled,
-- so a click on the window controls or the bottom bar stays the OSC's. Our
-- listener can register after sf.lua's one-shot broadcast (separate script
-- threads), so ask once right after registering it; sf.lua answers if it is
-- already live, else its later broadcast reaches us. Broadcasts: no error
-- without sf.lua.
mp.register_script_message("sf-bindings-ready", function()
	msg.info("[sf-sections] sf.lua bindings live; re-stacking input=" .. tostring(state.input_enabled) .. " window-controls=" .. tostring(state.wc_enabled) .. " centre=" .. tostring(state.centre_enabled))
	if state.input_enabled then
		mp.enable_key_bindings("input")
	end
	if state.wc_enabled then
		mp.enable_key_bindings("window-controls")
	end
	if state.centre_enabled then
		mp.enable_key_bindings("centre")
	end
end)
msg.info("[sf-sections] asking sf.lua for sf-bindings-ready")
mp.commandv("script-message", "sf-bindings-query")

function get_hidetimeout()
	if user_opts.visibility == "always" then
		return -1 -- disable autohide
	end
	if user_opts.minmousemove < 0 then
		return user_opts.hidetimeout
	else
		return user_opts.hidetimeoutMouseMove
	end
end

function get_fadeduration()
	if user_opts.minmousemove < 0 then
		return user_opts.fadeduration
	else
		return user_opts.fadedurationMouseMove
	end
end

function always_on(val)
	if state.enabled then
		if val then
			show_osc()
		else
			hide_osc()
		end
	end
end

-- mode can be auto/always/never/cycle
-- the modes only affect internal variables and not stored on its own.
function visibility_mode(mode, no_osd)
	if mode == "cycle" then
		if not state.enabled then
			mode = "auto"
		elseif user_opts.visibility ~= "always" then
			mode = "always"
		else
			mode = "never"
		end
	end

	if mode == "auto" then
		always_on(false)
		enable_osc(true)
	elseif mode == "always" then
		enable_osc(true)
		always_on(true)
	elseif mode == "never" then
		enable_osc(false)
	else
		msg.warn("Ignoring unknown visibility mode '" .. mode .. "'")
		return
	end

	user_opts.visibility = mode

	-- Only an OSC that is switched off ("never") needs its sections dropped
	-- here: tick() is a no-op while it is disabled and would never disable
	-- them. An enabled OSC reconciles both sections on its next render tick
	-- (osc_visible vs state.input_enabled / state.wc_enabled / state.centre_enabled).
	-- Disabling them eagerly, as upstream does, leaves "input" off until that
	-- tick: showonpause runs this on every pause/resume, and an MBTN_LEFT
	-- inside the window (one tick, tens of ms on a loaded host) goes to the
	-- player's own bindings instead of the OSC button (#25 c013: cy_audio click
	-- lost 5 ms after the product's pause=false, the track menu never opened).
	if not state.enabled then
		mp.disable_key_bindings("input")
		mp.disable_key_bindings("window-controls")
		mp.disable_key_bindings("centre")
		state.input_enabled = false
		state.wc_enabled = false
		state.centre_enabled = false
	end

	request_tick()
end

function idlescreen_visibility(mode, no_osd)
	if mode == "cycle" then
		if user_opts.idlescreen then
			mode = "no"
		else
			mode = "yes"
		end
	end

	if mode == "yes" then
		user_opts.idlescreen = true
	else
		user_opts.idlescreen = false
	end

	if not no_osd and tonumber(mp.get_property("osd-level")) >= 1 then
		mp.osd_message("OSC logo visibility: " .. tostring(mode))
	end

	request_tick()
end

visibility_mode(user_opts.visibility, true)
mp.register_script_message("osc-visibility", visibility_mode)
mp.register_script_message("osc-show", show_osc)
mp.add_key_binding(nil, "visibility", function() visibility_mode("cycle") end)

mp.register_script_message("osc-idlescreen", idlescreen_visibility)

-- E2E hook (ultimate stress suite): reply with every laid-out element's
-- hitbox converted from virtual ASS coordinates to OSD pixels, i.e. the
-- coordinate space of the JSON IPC `mouse` command. No-op unless a client
-- sends `script-message sf-e2e-layout`. `elements` is a list after
-- prepare_elements(), so key the reply by element.name.
mp.register_script_message("sf-e2e-layout", function()
	local osd_w, osd_h = mp.get_osd_size()
	local sx, sy = get_virt_scale_factor()
	local out = {
		osd_w = osd_w,
		osd_h = osd_h,
		virt_per_osd_y = sy,
		ui_scale = state.sf_ui_scale,
		hidpi = mp.get_property_number("display-hidpi-scale", 1),
		osc_visible = state.osc_visible == true,
		elements = {},
	}
	local count = 0
	if sx ~= 0 and sy ~= 0 then
		for k, element in pairs(elements) do
			if type(element) == "table" and element.hitbox then
				local style = tostring(element.layout.style)
				local alpha = element.layout.alpha or {}
				out.elements[element.name or tostring(k)] = {
					x1 = element.hitbox.x1 / sx,
					y1 = element.hitbox.y1 / sy,
					x2 = element.hitbox.x2 / sx,
					y2 = element.hitbox.y2 / sy,
					visible = element.visible == true,
					enabled = element.enabled == true,
					-- toggled off (e.g. cy_audio with no audio track): drawn dim like a disabled one
					off = element.off == true,
					-- libass \blur / \bord of the element style (virtual ASS px): the glow
					-- they paint reaches bord + ~2*blur beyond the box, and the sw OSD
					-- rasterizes + blends that whole bitmap on every OSD update.
					blur = tonumber(style:match("\\blur([%d%.]+)")) or 0,
					bord = tonumber(style:match("\\bord([%d%.]+)")) or 0,
					-- font (\fn): Inter for text (MPV-OSC-03); a private-use glyph only means something in its own icon font
					font = style:match("\\fn([^\\}]+)"),
					-- how it is drawn: fill / outline / shadow colour (BGR hex), \shad, \fs and the
					-- layout alpha [fill, 2nd, outline, shadow] (0 opaque .. 255 clear) after
					-- prepare_elements dimmed a disabled / toggled-off one.
					c1 = style:match("\\1c&H(%x+)&"),
					c3 = style:match("\\3c&H(%x+)&"),
					c4 = style:match("\\4c&H(%x+)&"),
					shad = tonumber(style:match("\\shad([%d%.]+)")) or 0,
					fs = tonumber(style:match("\\fs([%d%.]+)")),
					alpha = {alpha[1] or 0, alpha[2] or 0, alpha[3] or 0, alpha[4] or 0},
					-- radius (OSD px) of the round chip drawn behind a button (MPV-OSC-03)
					chip_r = element.layout.button and element.layout.button.chip_r and element.layout.button.chip_r / sy or nil,
					-- text content (the title, CC / HD), or the ASS drawing of a drawn icon
					content = (function ()
						local c = element.content
						if type(c) == "function" then
							local ok, value = pcall(c)
							c = ok and value or nil
						end
						return type(c) == "string" and c or nil
					end)(),
				}
				count = count + 1
			end
		end
	end
	msg.info(string.format("[sf-e2e-layout] osd=%sx%s scale=%s,%s elements=%d", tostring(osd_w), tostring(osd_h), tostring(sx), tostring(sy), count))
	msg.info("[sf-e2e-layout] json " .. utils.format_json(out))
	mp.commandv("script-message", "sf-e2e-layout-json", utils.format_json(out))
end)

mp.register_script_message("thumbfast-info", function(json)
	local data = utils.parse_json(json)
	if type(data) ~= "table" or not data.width or not data.height then
		msg.error("thumbfast-info: received json didn't produce a table with thumbnail information")
	else
		thumbfast = data
		mp.command_native({"script-message", message.osc.finish, format_json(osc_reg)})
	end
end)

set_virt_mouse_area(0, 0, 0, 0, "input")
set_virt_mouse_area(0, 0, 0, 0, "window-controls")
set_virt_mouse_area(0, 0, 0, 0, "centre")
