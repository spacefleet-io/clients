package com.spacefleet.mpvplayback.mpv

import android.os.Handler
import android.util.Log
import `is`.xyz.mpv.MPVLib

/**
 * Subtitles under direct rendering (`vo=mediacodec_embed`, PLAT-TV-06). That VO has no OSD, so mpv decodes the
 * selected `sid` but never paints it; the app draws it instead, never by switching back to `vo=gpu`.
 *  - text subtitles (SRT, ASS, WebVTT…): mpv's `sub-text` (the current line, formatting stripped) goes to
 *    [MpvSurfaceView.setSubtitleText], which forwards it to JS. mpv notifies observed properties only when the value
 *    changes, so this runs once per subtitle line, never per frame;
 *  - `sub-visibility=no` hides the overlay like it hides mpv's own subtitles;
 *  - bitmap subtitles (PGS, VobSub, DVB): no `sub-text`, and libmpv has no way to hand their images out without a VO
 *    that renders the OSD (`screenshot-raw` and the render API both need `vo=gpu`/`libmpv`). They don't show under
 *    direct rendering; a warning is logged when one is selected (PLAY-TRACK-05 gap).
 */
class MpvSubtitles(
  private val view: MpvSurfaceView,
  private val mainHandler: Handler,
) : MPVLib.EventObserver {
  override fun eventProperty(property: String) {
    // String/flag properties with no value (no subtitle track) arrive here.
    if (property == "sub-text") post { view.setSubtitleText("") }
  }

  override fun eventProperty(property: String, value: Long) {
    if (property != "sid" || !view.directRender || view.isExiting) return
    warnIfBitmap(value)
  }

  override fun eventProperty(property: String, value: Boolean) {
    if (property == "sub-visibility") post { view.setSubtitleVisible(value) }
  }

  override fun eventProperty(property: String, value: String) {
    if (property == "sub-text") post { view.setSubtitleText(value) }
  }

  override fun eventProperty(property: String, value: Double) = Unit

  override fun event(eventId: Int) = Unit

  private fun post(action: () -> Unit) {
    if (view.isExiting) return
    mainHandler.post { if (!view.isExiting) action() }
  }

  private fun warnIfBitmap(sid: Long) {
    try {
      val codec = MpvGuard.getPropertyString("current-tracks/sub/codec").orEmpty()
      if (codec in BITMAP_CODECS) {
        Log.w(TAG, "playback.subtitles.bitmap_unsupported sid=$sid codec=$codec: direct rendering draws text subtitles only")
      } else {
        Log.i(TAG, "playback.subtitles.selected sid=$sid codec=${codec.ifEmpty { "unknown" }} drawn by the app")
      }
    } catch (e: Exception) {
      Log.w(TAG, "playback.subtitles.codec_read failed: ${e.message}")
    }
  }

  private companion object {
    const val TAG = "MpvPlayback"

    /** FFmpeg codec names of image-based subtitles. */
    val BITMAP_CODECS = setOf("hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle", "xsub")
  }
}
