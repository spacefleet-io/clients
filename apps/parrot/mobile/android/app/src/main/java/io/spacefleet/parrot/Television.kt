package io.spacefleet.parrot

import android.app.UiModeManager
import android.content.Context
import android.content.res.Configuration

/** Android TV, Google TV or Fire TV (PAR-TV-01): the same APK runs the TV app there. */
fun Context.isTelevision(): Boolean {
  val uiMode = getSystemService(UiModeManager::class.java)?.currentModeType
  return uiMode == Configuration.UI_MODE_TYPE_TELEVISION ||
      packageManager.hasSystemFeature("android.software.leanback") ||
      packageManager.hasSystemFeature("amazon.hardware.fire_tv")
}
