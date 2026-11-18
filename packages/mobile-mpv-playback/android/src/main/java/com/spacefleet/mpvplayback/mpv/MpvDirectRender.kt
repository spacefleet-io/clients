package com.spacefleet.mpvplayback.mpv

import android.os.Handler
import android.util.Log
import `is`.xyz.mpv.MPVLib

/**
 * Keeps direct rendering (`vo=mediacodec_embed`, Android TV) working end to end:
 *  - feeds the video's display aspect to [MpvSurfaceView] so the view letterboxes (mpv can't in this mode);
 *  - when the hardware decoder can't take a file, mpv has no way to show software-decoded frames on that VO and
 *    plays audio only. On the first playback restart without `hwdec-current=mediacodec` while the file has a video
 *    track, switch this engine to the GPU path (`vo=gpu`, copy-back chain) for the rest of its life and reselect video.
 */
class MpvDirectRender(
  private val view: MpvSurfaceView,
  private val mainHandler: Handler,
) : MPVLib.EventObserver {
  override fun eventProperty(property: String) = Unit
  override fun eventProperty(property: String, value: Long) = Unit
  override fun eventProperty(property: String, value: Boolean) = Unit
  override fun eventProperty(property: String, value: String) = Unit

  override fun eventProperty(property: String, value: Double) {
    if (property != "video-params/aspect" || view.isExiting) return
    val aspect = value.takeIf { it > 0.001 }
    mainHandler.post { if (!view.isExiting) view.setVideoAspect(aspect) }
  }

  override fun event(eventId: Int) {
    if (eventId != MPVLib.MpvEvent.MPV_EVENT_PLAYBACK_RESTART || !view.directRender || view.isExiting) return
    try {
      val hwdec = MpvGuard.getPropertyString("hwdec-current").orEmpty()
      if (hwdec == "mediacodec") return
      val videoId = firstVideoTrackId() ?: return
      Log.w(TAG, "playback.direct_render.fallback hwdec-current=${hwdec.ifEmpty { "none" }} vid=$videoId -> vo=gpu")
      view.directRender = false
      MPVLib.setPropertyString("hwdec", "mediacodec-copy,no")
      MPVLib.setPropertyString("vo", "gpu")
      MPVLib.setPropertyInt("vid", videoId)
      // mpv draws subtitles itself on vo=gpu: the setVideoAspect relayout, or the explicit publish, hides the app's overlay.
      mainHandler.post {
        if (view.isExiting) return@post
        view.setVideoAspect(null)
        view.publishSubtitle()
      }
    } catch (e: Exception) {
      Log.w(TAG, "playback.direct_render.fallback failed: ${e.message}")
    }
  }

  private fun firstVideoTrackId(): Int? {
    val count = MpvGuard.getPropertyInt("track-list/count") ?: return null
    for (i in 0 until count) {
      if (MpvGuard.getPropertyString("track-list/$i/type") != "video") continue
      if (MpvGuard.getPropertyString("track-list/$i/image") == "yes") continue
      return MpvGuard.getPropertyInt("track-list/$i/id")
    }
    return null
  }

  private companion object {
    const val TAG = "MpvPlayback"
  }
}
