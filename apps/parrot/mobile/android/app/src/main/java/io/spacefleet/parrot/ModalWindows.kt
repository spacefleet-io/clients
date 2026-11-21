package io.spacefleet.parrot

import android.graphics.Color
import android.os.Build
import android.util.Log
import android.view.View
import android.view.ViewTreeObserver
import android.view.Window
import androidx.core.view.WindowCompat
import com.facebook.react.ReactHost
import com.facebook.react.ReactInstanceEventListener
import com.facebook.react.bridge.ReactContext
import com.facebook.react.interfaces.ExtraWindowEventListener

/**
 * UX-SHEET-01: every React Native Modal window (the bottom sheets, the dialogs) is drawn edge to edge, under the status
 * and navigation bars, on every Android version, as Android 15 and later already enforce. react-native-tvos 0.88.1-0
 * drops the Modal's `navigationBarTranslucent` (its prop setter is commented out), so on Android 14 and older a sheet's
 * window stopped above the navigation bar and the page's tab bar showed under the sheet. The Modal re-applies
 * `disableEdgeToEdge()` on every prop update, so the window is put back edge to edge before each frame it draws, not
 * once. The Modal content keeps clear of the bars itself, from the insets it measures inside the Modal.
 */
internal object ModalWindows : ExtraWindowEventListener {
  private const val TAG = "sf.modal"
  private val keepers = HashMap<Window, ViewTreeObserver.OnPreDrawListener>()

  override fun onExtraWindowCreate(window: Window) {
    edgeToEdge(window)
    val keeper = ViewTreeObserver.OnPreDrawListener { !reassert(window) }
    keepers.put(window, keeper)?.let { window.decorView.viewTreeObserver.removeOnPreDrawListener(it) }
    window.decorView.viewTreeObserver.addOnPreDrawListener(keeper)
    Log.i(TAG, "modal window edge to edge")
  }

  override fun onExtraWindowDestroy(window: Window) {
    keepers.remove(window)?.let { window.decorView.viewTreeObserver.removeOnPreDrawListener(it) }
  }

  /**
   * True when the Modal had put the window back inside the bars; that frame is skipped and laid out again. AndroidX
   * `WindowCompat.setDecorFitsSystemWindows` (which the Modal uses too) sets `SYSTEM_UI_FLAG_LAYOUT_STABLE` while the
   * window is edge to edge and clears it when the window fits the bars again, below Android 15; from Android 15 every
   * window is edge to edge.
   */
  @Suppress("DEPRECATION")
  private fun reassert(window: Window): Boolean {
    val fits =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.VANILLA_ICE_CREAM &&
            window.decorView.systemUiVisibility and View.SYSTEM_UI_FLAG_LAYOUT_STABLE == 0
    if (fits) edgeToEdge(window)
    return fits
  }

  @Suppress("DEPRECATION")
  private fun edgeToEdge(window: Window) {
    WindowCompat.setDecorFitsSystemWindows(window, false)
    window.statusBarColor = Color.TRANSPARENT
    window.navigationBarColor = Color.TRANSPARENT
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) window.isNavigationBarContrastEnforced = false
  }

  /** Follows every React context the host makes (a reload makes a new one); a context keeps each listener once. */
  fun install(host: ReactHost) {
    host.currentReactContext?.addExtraWindowEventListener(this)
    host.addReactInstanceEventListener(
        object : ReactInstanceEventListener {
          override fun onReactContextInitialized(context: ReactContext) {
            context.addExtraWindowEventListener(ModalWindows)
          }
        },
    )
  }
}
