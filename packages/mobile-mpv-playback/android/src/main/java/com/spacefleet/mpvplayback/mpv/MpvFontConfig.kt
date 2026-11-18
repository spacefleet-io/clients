package com.spacefleet.mpvplayback.mpv

import android.content.Context
import android.system.Os
import android.util.Log
import java.io.File

/**
 * Gives libass' fontconfig a real config + a writable, persistent cache directory.
 *
 * Without `FONTCONFIG_FILE` the AAR's fontconfig logs "No usable fontconfig configuration file found, using fallback" and its
 * fallback cache dir is a compiled-in path that does not exist on Android, so EVERY mpv instance re-scans and re-parses all of
 * /system/fonts (hundreds of Noto faces) the first time a text subtitle is shown. Measured on the throttled OnePlus 6: 1.2 s
 * (`[sub/ass] Setting up fonts...` -> `Using font provider fontconfig`) which blocks mpv's core thread (audio underrun) and is
 * the whole subtitle track-switch budget. With a persistent cache the setup reads one cache file instead.
 *
 * Must run BEFORE `MPVLib.create` (fontconfig reads the environment when libass first initialises).
 */
internal object MpvFontConfig {
  private const val TAG = "MpvFontConfig"

  fun install(context: Context) {
    try {
      val cacheDir = File(context.cacheDir, "fontconfig").apply { mkdirs() }
      val confFile = File(context.filesDir, "fonts.conf")
      val conf = """<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>/system/fonts</dir>
  <dir>/product/fonts</dir>
  <dir>/system_ext/fonts</dir>
  <cachedir>${cacheDir.absolutePath}</cachedir>
</fontconfig>
"""
      if (!confFile.exists() || confFile.readText() != conf) confFile.writeText(conf)
      Os.setenv("FONTCONFIG_FILE", confFile.absolutePath, true)
      Os.setenv("FONTCONFIG_PATH", context.filesDir.absolutePath, true)
      Os.setenv("XDG_CACHE_HOME", context.cacheDir.absolutePath, true)
      Log.i(TAG, "installed conf=${confFile.absolutePath} cache=${cacheDir.absolutePath}")
    } catch (e: Throwable) {
      // Subtitles still work through the slow fallback; never block the player on this.
      Log.w(TAG, "install failed, libass will use the fontconfig fallback", e)
    }
  }
}
