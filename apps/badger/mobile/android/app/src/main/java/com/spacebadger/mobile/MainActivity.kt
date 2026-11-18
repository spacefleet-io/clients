package com.spacebadger.mobile

import android.app.UiModeManager
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.os.Bundle
import android.view.KeyEvent
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  // Matches the appName in app.json ("SpaceBadgerMobile") which is what
  // index.js passes to AppRegistry.registerComponent. Was "TfpMobile",
  // a leftover from before the SpaceBadger rename swept the codebase.
  override fun getMainComponentName(): String = "SpaceBadgerMobile"

  private val television by lazy { isTelevision() }

  /** Google Cast (UX-TV-03) in the Play build; nothing in the Google-free build (src/play, src/foss). */
  private val cast by lazy { CastSupport(this, television) }

  override fun onCreate(savedInstanceState: Bundle?) {
    // Phones stay in portrait outside the player (the player switches to landscape itself). A TV keeps the
    // landscape screen it has, so the lock is set here for phones only rather than in the manifest.
    if (!television) requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
    super.onCreate(savedInstanceState)
    cast.onCreate()
  }

  override fun onStart() {
    super.onStart()
    cast.onStart()
  }

  override fun onStop() {
    cast.onStop()
    super.onStop()
  }

  /**
   * Some TV remotes reach apps with OK as numeric-keypad Enter (a BenQ Smart Remote on an SDMC Google TV box: the
   * box's remote service sends `KEYCODE_NUMPAD_ENTER`). react-native-tvos presses a focused control only on the D-pad
   * centre and Enter, so on a TV that key becomes the centre key, as every other TV app treats it.
   */
  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    if (!television || event.keyCode != KeyEvent.KEYCODE_NUMPAD_ENTER) return super.dispatchKeyEvent(event)
    return super.dispatchKeyEvent(
        KeyEvent(
            event.downTime,
            event.eventTime,
            event.action,
            KeyEvent.KEYCODE_DPAD_CENTER,
            event.repeatCount,
            event.metaState,
            event.deviceId,
            event.scanCode,
            event.flags,
            event.source,
        ),
    )
  }

  /**
   * Back with nothing left to close in the app (the sign-in page, the home page): on a phone the app goes to the
   * background, as Android 12+ does for any launcher app, instead of finishing the activity. Finishing it on older
   * Android rebuilt the React surface on the next open, and a tester saw a blank starfield there.
   */
  override fun invokeDefaultOnBackPressed() {
    if (television) super.invokeDefaultOnBackPressed() else moveTaskToBack(true)
  }

  private fun isTelevision(): Boolean {
    val uiMode = getSystemService(UiModeManager::class.java)?.currentModeType
    return uiMode == Configuration.UI_MODE_TYPE_TELEVISION ||
        packageManager.hasSystemFeature("android.software.leanback") ||
        packageManager.hasSystemFeature("amazon.hardware.fire_tv")
  }

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)
}
