package com.spacefleet.mpvplayback.mpv

import android.util.Log
import `is`.xyz.mpv.MPVLib

/**
 * Production log of what mpv actually decodes and renders with, read back after playback starts.
 *
 * `hwdec` / `vo` are only REQUESTS (`hwdec=mediacodec,mediacodec-copy,no`, `vo=gpu`); mpv silently falls back down
 * the chain, so the truth is `hwdec-current` and `current-vo` once the decoder is up. This observer logs them
 * (tag [TAG], always, release builds included) at the first PLAYBACK_RESTART of a file and again whenever either value
 * changes (a decoder fallback, a variant switch to another codec). The same two values ride the JS playback snapshot
 * (`hwdec`, `currentVo`) and the debug probe.
 */
class MpvPlaybackReport : MPVLib.EventObserver {
  @Volatile private var lastLogged: String? = null

  override fun eventProperty(property: String) = Unit
  override fun eventProperty(property: String, value: Long) = Unit
  override fun eventProperty(property: String, value: Boolean) = Unit
  override fun eventProperty(property: String, value: String) = Unit
  override fun eventProperty(property: String, value: Double) = Unit

  override fun event(eventId: Int) {
    when (eventId) {
      MPVLib.MpvEvent.MPV_EVENT_START_FILE -> lastLogged = null
      MPVLib.MpvEvent.MPV_EVENT_PLAYBACK_RESTART -> report()
    }
  }

  private fun report() {
    try {
      val hwdec = MpvGuard.getPropertyString("hwdec-current").orEmpty()
      val vo = MpvGuard.getPropertyString("current-vo").orEmpty()
      val codec = MpvGuard.getPropertyString("video-format").orEmpty()
      val w = MpvGuard.getPropertyInt("video-params/w") ?: 0
      val h = MpvGuard.getPropertyInt("video-params/h") ?: 0
      val line = "playback.gpu hwdec-current=${hwdec.ifEmpty { "none" }} current-vo=${vo.ifEmpty { "none" }} codec=$codec ${w}x$h"
      if (line == lastLogged) return
      lastLogged = line
      Log.i(TAG, line)
    } catch (e: Exception) {
      Log.w(TAG, "playback.gpu readback failed: ${e.message}")
    }
  }

  private companion object {
    const val TAG = "MpvPlayback"
  }
}
