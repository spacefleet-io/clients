package com.spacefleet.mpvplayback.mpv

import android.content.Context

/**
 * Release stub of the debug-only player state probe (see src/debug/.../MpvProbe.kt).
 * Compiled into release builds instead of the real probe: every call is a no-op, so
 * no receiver, thread, property poll or logcat line exists in a release APK.
 */
object MpvProbe {
  @Suppress("UNUSED_PARAMETER")
  fun attach(context: Context) = Unit

  fun detach() = Unit
}
