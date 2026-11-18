// Adapted from mpvEx — Apache 2.0 — https://github.com/marlboro-advance/mpvEx
package com.spacefleet.mpvplayback.mpv

import android.os.Handler
import `is`.xyz.mpv.MPVLib

/**
 * Decoupled receiver of mpv property + core events.
 *
 * mpvEx's `PlayerObserver` calls back into a `PlayerActivity` directly. Here we
 * parameterize that out so the observer can be wired into anything (engine,
 * RN bridge, tests) without dragging an Activity behind it.
 *
 * Implementations should treat callbacks as fire-and-forget — the observer has
 * already hopped to the main thread and short-circuited if teardown started.
 *
 * Note: jdtech's AAR does not expose `MPVNode`, so there is no `MPVNode` overload
 * in [MPVLib.EventObserver] (mpvEx's observer has one because it uses the
 * `is.xyz.mpv` namespace which ships `MPVNode`). NODE-format properties cannot
 * deliver typed events through this AAR — use a different format if you need
 * change notifications, or read the property directly via `getPropertyString`.
 */
interface MpvObserverDispatcher {
  fun onObserverEvent(property: String)
  fun onObserverEvent(property: String, value: Long)
  fun onObserverEvent(property: String, value: Boolean)
  fun onObserverEvent(property: String, value: String)
  fun onObserverEvent(property: String, value: Double)
  fun onObserverEvent(eventId: Int)
}

/**
 * Bridges [MPVLib.EventObserver] callbacks (which arrive on mpv's worker thread)
 * onto the main looper, while honoring an `isExiting` short-circuit so callbacks
 * stop firing the moment teardown begins.
 *
 * Port of mpvEx `PlayerObserver.kt`. Differences:
 *  - No Activity dependency (uses [Handler] for thread hop instead of `runOnUiThread`).
 *  - No `eventProperty(String, MPVNode)` override — that overload doesn't exist on
 *    jdtech's `MPVLib.EventObserver` interface.
 *  - `event(int)` (not `event(int, MPVNode)`) — same reason.
 */
class MpvPropertyObserver(
  private val dispatcher: MpvObserverDispatcher,
  private val isExiting: () -> Boolean,
  private val mainHandler: Handler,
) : MPVLib.EventObserver {

  override fun eventProperty(property: String) {
    if (isExiting()) return
    mainHandler.post { if (!isExiting()) dispatcher.onObserverEvent(property) }
  }

  override fun eventProperty(property: String, value: Long) {
    if (isExiting()) return
    mainHandler.post { if (!isExiting()) dispatcher.onObserverEvent(property, value) }
  }

  override fun eventProperty(property: String, value: Boolean) {
    if (isExiting()) return
    mainHandler.post { if (!isExiting()) dispatcher.onObserverEvent(property, value) }
  }

  override fun eventProperty(property: String, value: String) {
    if (isExiting()) return
    mainHandler.post { if (!isExiting()) dispatcher.onObserverEvent(property, value) }
  }

  override fun eventProperty(property: String, value: Double) {
    if (isExiting()) return
    mainHandler.post { if (!isExiting()) dispatcher.onObserverEvent(property, value) }
  }

  override fun event(eventId: Int) {
    if (isExiting()) return
    mainHandler.post { if (!isExiting()) dispatcher.onObserverEvent(eventId) }
  }
}
