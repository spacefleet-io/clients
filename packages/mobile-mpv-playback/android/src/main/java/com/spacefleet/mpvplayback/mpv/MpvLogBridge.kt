package com.spacefleet.mpvplayback.mpv

import android.util.Log
import `is`.xyz.mpv.MPVLib

/**
 * Forwards libmpv's internal log stream to Android logcat under tag `MpvCore`.
 *
 * Wired in [MpvEngine.attach] right after `MPVLib.init()`. The companion option
 * `msg-level=all=v,...` controls verbosity at the libmpv side; this object only
 * decides how each emitted line surfaces in logcat.
 *
 * Filter from a shell with:
 *   adb logcat -v time -s MpvCore:V playback-proxy:V controls:V
 *
 * Singleton because libmpv itself is process-singleton — there is exactly one
 * mpv core per app process, so exactly one log observer is meaningful.
 */
object MpvLogBridge : MPVLib.LogObserver {

  override fun logMessage(prefix: String, level: Int, text: String) {
    val message = "[$prefix] ${text.trimEnd('\n', '\r', ' ')}"
    when (level) {
      MPVLib.MpvLogLevel.MPV_LOG_LEVEL_FATAL,
      MPVLib.MpvLogLevel.MPV_LOG_LEVEL_ERROR -> Log.e(TAG, message)
      MPVLib.MpvLogLevel.MPV_LOG_LEVEL_WARN -> Log.w(TAG, message)
      MPVLib.MpvLogLevel.MPV_LOG_LEVEL_INFO -> Log.i(TAG, message)
      MPVLib.MpvLogLevel.MPV_LOG_LEVEL_V,
      MPVLib.MpvLogLevel.MPV_LOG_LEVEL_DEBUG -> Log.d(TAG, message)
      MPVLib.MpvLogLevel.MPV_LOG_LEVEL_TRACE -> Log.v(TAG, message)
      else -> Log.i(TAG, message)
    }
  }

  private const val TAG = "MpvCore"
}
