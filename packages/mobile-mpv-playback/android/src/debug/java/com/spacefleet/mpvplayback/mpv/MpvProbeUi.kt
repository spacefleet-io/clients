package com.spacefleet.mpvplayback.mpv

import android.app.Activity
import android.app.Application
import android.graphics.Rect
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import java.lang.ref.WeakReference

/**
 * DEBUG-BUILD-ONLY on-screen element dump for the phone harness.
 * `uiautomator dump` never returns here (the app animates continuously), so the harness asks the
 * app itself: walks the native view tree of every window root (the resumed Activity plus RN Modal dialogs) and
 * reports every visible view that has text, a contentDescription (RN accessibilityLabel) or a testID, with its on-screen bounds.
 */
object MpvProbeUi {
  private var resumed = WeakReference<Activity>(null)

  fun track(app: Application) {
    app.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
      override fun onActivityResumed(activity: Activity) { resumed = WeakReference(activity) }
      override fun onActivityPaused(activity: Activity) { if (resumed.get() === activity) resumed = WeakReference(null) }
      override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit
      override fun onActivityStarted(activity: Activity) = Unit
      override fun onActivityStopped(activity: Activity) = Unit
      override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
      override fun onActivityDestroyed(activity: Activity) = Unit
    })
  }

  /** Must run on the main thread (the broadcast receiver does). */
  fun dump(): JSONObject {
    val o = JSONObject().put("v", 1).put("ts", System.currentTimeMillis())
    val activity = resumed.get() ?: return o.put("error", "no-resumed-activity")
    val nodes = JSONArray()
    // Every window root of the process, bottom to top: the Activity's decorView plus RN Modal dialogs (their own
    // window, e.g. the account-language question and the API host dialog). getGlobalVisibleRect is relative to the
    // window root; shift by each root's on-screen origin.
    val roots = windowRoots(activity)
    for (root in roots) {
      val origin = IntArray(2)
      root.getLocationOnScreen(origin)
      walk(root, nodes, origin[0], origin[1])
    }
    o.put("roots", roots.size)
    val origin = IntArray(2)
    activity.window.decorView.getLocationOnScreen(origin)
    val dm = activity.resources.displayMetrics
    @Suppress("DEPRECATION")
    val rotation = activity.windowManager.defaultDisplay.rotation
    o.put("w", dm.widthPixels).put("h", dm.heightPixels).put("density", dm.density).put("rotation", rotation).put("nodes", nodes)
    // D-pad / remote focus (Android TV harness): the view holding input focus, with every text/description/testID inside it
    // (a focusable Pressable carries no text itself; its labels are its children's).
    activity.currentFocus?.let { f ->
      val fr = Rect()
      if (f.visibility == View.VISIBLE && f.getGlobalVisibleRect(fr)) {
        val texts = JSONArray()
        collectLabels(f, texts)
        o.put(
          "focus",
          JSONObject()
            .put("x", fr.left + origin[0]).put("y", fr.top + origin[1]).put("r", fr.right + origin[0]).put("b", fr.bottom + origin[1])
            .put("cls", f.javaClass.simpleName)
            .put("testId", runCatching { f.getTag(com.facebook.react.R.id.react_test_id) as? String }.getOrNull() ?: JSONObject.NULL)
            .put("labels", texts),
        )
      }
    }
    return o
  }

  /**
   * Harness text entry (`...probe.SETTEXT`). Focuses the visible EditText whose RN testID is [testId] and replaces
   * its text, as the IME would: the view's own text watcher sends the change to JS (`onChangeText`). Answers with the
   * resulting length and whether it equals [text]; never echoes the text (passwords, library key).
   * Must run on the main thread (the broadcast receiver does).
   */
  fun setText(testId: String, text: String): JSONObject {
    val o = JSONObject().put("v", 1).put("testId", testId)
    val activity = resumed.get() ?: return o.put("ok", false).put("error", "no-resumed-activity")
    val field = windowRoots(activity).asReversed().firstNotNullOfOrNull { findEditText(it, testId) }
      ?: return o.put("ok", false).put("error", "no-visible-edittext-with-testid")
    field.requestFocus()
    field.setText(text)
    field.setSelection(field.text?.length ?: 0)
    val now = field.text?.toString().orEmpty()
    return o.put("ok", now == text).put("length", now.length)
  }

  private fun findEditText(v: View, testId: String): android.widget.EditText? {
    if (v.visibility != View.VISIBLE) return null
    if (v is android.widget.EditText && runCatching { v.getTag(com.facebook.react.R.id.react_test_id) as? String }.getOrNull() == testId) return v
    if (v is ViewGroup) for (i in 0 until v.childCount) findEditText(v.getChildAt(i), testId)?.let { return it }
    return null
  }

  /**
   * The process's attached, visible window roots in z-order (WindowManagerGlobal.mViews, read by reflection: this is
   * debug-only harness code). Falls back to the resumed Activity's decorView when the field cannot be read.
   */
  private fun windowRoots(activity: Activity): List<View> {
    val decor = activity.window.decorView
    val all = runCatching {
      val wmg = Class.forName("android.view.WindowManagerGlobal")
      val instance = wmg.getMethod("getInstance").invoke(null)
      val field = wmg.getDeclaredField("mViews").apply { isAccessible = true }
      @Suppress("UNCHECKED_CAST")
      (field.get(instance) as List<View>).toList()
    }.getOrElse { e ->
      android.util.Log.w("SBProbe", "window roots unavailable (${e.javaClass.simpleName}): activity decorView only")
      emptyList()
    }
    val roots = all.filter { it.isAttachedToWindow && it.visibility == View.VISIBLE && it.windowVisibility == View.VISIBLE }
    return if (decor in roots) roots else listOf(decor) + roots
  }

  private fun collectLabels(v: View, out: JSONArray) {
    if (v.visibility != View.VISIBLE) return
    (v as? TextView)?.text?.toString()?.takeIf { it.isNotBlank() }?.let { out.put(it.take(200)) }
    v.contentDescription?.toString()?.takeIf { it.isNotBlank() }?.let { out.put(it.take(200)) }
    if (v is ViewGroup) for (i in 0 until v.childCount) collectLabels(v.getChildAt(i), out)
  }

  private fun walk(v: View, out: JSONArray, ox: Int, oy: Int) {
    if (v.visibility != View.VISIBLE || v.alpha == 0f) return
    val text = (v as? TextView)?.text?.toString()?.takeIf { it.isNotBlank() }
    val hint = (v as? TextView)?.takeIf { text == null }?.hint?.toString()?.takeIf { it.isNotBlank() }
    val desc = v.contentDescription?.toString()?.takeIf { it.isNotBlank() }
    val testId = runCatching { v.getTag(com.facebook.react.R.id.react_test_id) as? String }.getOrNull()
    if (text != null || hint != null || desc != null || testId != null) {
      val r = Rect()
      if (v.getGlobalVisibleRect(r) && r.width() > 0 && r.height() > 0) {
        val n = JSONObject()
          .put("x", r.left + ox).put("y", r.top + oy).put("r", r.right + ox).put("b", r.bottom + oy)
          .put("cls", v.javaClass.simpleName)
          .put("clickable", v.isClickable)
        text?.let { n.put("text", it.take(200)) }
        hint?.let { n.put("hint", it.take(200)) }
        if (v is android.widget.EditText) n.put("editable", true)
        // D-pad / remote focus (Android TV harness): true only on the view that currently holds input focus.
        if (v.isFocused) n.put("focused", true)
        desc?.let { n.put("desc", it.take(200)) }
        testId?.let { n.put("testId", it) }
        // Switch/checkbox rows (RN accessibilityState.checked) expose their state through the accessibility node info.
        if (desc != null) {
          runCatching {
            val info = v.createAccessibilityNodeInfo()
            if (info.isCheckable) n.put("checked", info.isChecked)
            info.recycle()
          }
        }
        out.put(n)
      }
    }
    if (v is ViewGroup) for (i in 0 until v.childCount) walk(v.getChildAt(i), out, ox, oy)
  }
}
