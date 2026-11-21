package io.spacefleet.parrot

import android.content.pm.ActivityInfo
import android.os.Bundle
import android.util.Log
import android.view.KeyEvent
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {
  /** The component index.js registers (app.json `name`). */
  override fun getMainComponentName(): String = "Parrot"

  /** Android TV, Google TV or Fire TV (PAR-TV-01): the same APK runs the TV app there. */
  private val television by lazy { isTelevision() }

  override fun onCreate(savedInstanceState: Bundle?) {
    // Phones stay in portrait. A TV keeps the landscape screen it has, so the lock is set here for phones only rather
    // than in the manifest (as Badger's MainActivity).
    if (!television) requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
    Log.i("parrot.app", "MainActivity onCreate television=$television")
    super.onCreate(savedInstanceState)
  }

  /**
   * Some TV remotes reach apps with OK as numeric-keypad Enter (a BenQ Smart Remote on an SDMC Google TV box sends
   * `KEYCODE_NUMPAD_ENTER`). react-native-tvos presses a focused control only on the D-pad centre and Enter, so on a
   * TV that key becomes the centre key, as every other TV app treats it (same as Badger).
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

  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)
}
