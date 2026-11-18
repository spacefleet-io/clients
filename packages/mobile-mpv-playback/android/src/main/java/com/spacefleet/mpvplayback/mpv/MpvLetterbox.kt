package com.spacefleet.mpvplayback.mpv

import android.graphics.Rect
import kotlin.math.roundToInt

/** Aspect-fit of a video inside a box: the largest centred rect with the video's display aspect. */
object MpvLetterbox {
  /** Rect relative to the box's top-left. Bars top/bottom for wider video, left/right for narrower. */
  fun fit(boxW: Int, boxH: Int, videoAspect: Double): Rect {
    if (boxW <= 0 || boxH <= 0 || videoAspect <= 0.001) return Rect(0, 0, boxW, boxH)
    val boxAspect = boxW.toDouble() / boxH
    return if (videoAspect >= boxAspect) {
      val h = (boxW / videoAspect).roundToInt().coerceIn(1, boxH)
      val top = (boxH - h) / 2
      Rect(0, top, boxW, top + h)
    } else {
      val w = (boxH * videoAspect).roundToInt().coerceIn(1, boxW)
      val left = (boxW - w) / 2
      Rect(left, 0, left + w, boxH)
    }
  }
}
