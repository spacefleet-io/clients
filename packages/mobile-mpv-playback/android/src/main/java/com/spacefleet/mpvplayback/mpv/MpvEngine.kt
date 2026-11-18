// Adapted from mpvEx — Apache 2.0 — https://github.com/marlboro-advance/mpvEx
package com.spacefleet.mpvplayback.mpv

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import `is`.xyz.mpv.MPVLib
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Lifecycle owner for a single libmpv instance.
 *
 * Independent of any Activity. Plain Kotlin object that the RN ViewManager /
 * NativeModule drives.
 *
 * Responsibilities:
 *  - Initialize libmpv (`MPVLib.create` -> `surfaceView.initOptions` -> `MPVLib.init`).
 *  - Register a property observer that fans out to a swappable [MpvObserverDispatcher].
 *  - Expose imperative playback API (load / play / pause / seek / track selection).
 *  - Tear down cleanly on [destroy].
 *
 * Lifecycle expectation: one engine per live libmpv core, bound to one player view at a time; a view that mounts while
 * the core lives (an episode switch, in front or hidden) takes it over ([rebind]). libmpv itself is process-singleton
 * (its native state is global), so creating a second engine while one is alive will fight over the same global mpv:
 * [PlayerCores] only creates one when none is alive.
 */
class MpvEngine {
  /** mpv property name -> `MPVLib.MpvFormat.MPV_FORMAT_*` constant. */
  private val observedProps: Map<String, Int> = linkedMapOf(
    "pause" to MPVLib.MpvFormat.MPV_FORMAT_FLAG,
    "paused-for-cache" to MPVLib.MpvFormat.MPV_FORMAT_FLAG,
    "eof-reached" to MPVLib.MpvFormat.MPV_FORMAT_FLAG,

    "time-pos" to MPVLib.MpvFormat.MPV_FORMAT_DOUBLE,
    "duration" to MPVLib.MpvFormat.MPV_FORMAT_DOUBLE,
    "demuxer-cache-time" to MPVLib.MpvFormat.MPV_FORMAT_DOUBLE,

    // NOTE: `demuxer-cache-state` would be MPV_FORMAT_NODE. The is.xyz.mpv AAR's
    // EventObserver interface has no NODE overload, so registering it here
    // would never deliver a typed callback. If we ever need cache state, read
    // `demuxer-cache-state` directly via getPropertyString and parse JSON.

    "aid" to MPVLib.MpvFormat.MPV_FORMAT_INT64,
    "sid" to MPVLib.MpvFormat.MPV_FORMAT_INT64,
    "secondary-sid" to MPVLib.MpvFormat.MPV_FORMAT_INT64,
    "track-list/count" to MPVLib.MpvFormat.MPV_FORMAT_INT64,

    // Subtitles drawn by the app under direct rendering (MpvSubtitles, PLAT-TV-06). Notified on change only.
    "sub-text" to MPVLib.MpvFormat.MPV_FORMAT_STRING,
    "sub-visibility" to MPVLib.MpvFormat.MPV_FORMAT_FLAG,

    "video-params/aspect" to MPVLib.MpvFormat.MPV_FORMAT_DOUBLE,
    "video-params/w" to MPVLib.MpvFormat.MPV_FORMAT_INT64,
    "video-params/h" to MPVLib.MpvFormat.MPV_FORMAT_INT64,
  )

  private val mainHandler = Handler(Looper.getMainLooper())
  private val initialized = AtomicBoolean(false)
  private val destroyed = AtomicBoolean(false)

  private var surfaceView: MpvSurfaceView? = null
  private var observer: MpvPropertyObserver? = null
  private val playbackReport = MpvPlaybackReport()
  private var directRender: MpvDirectRender? = null
  private var subtitles: MpvSubtitles? = null
  private var audioFocus: MpvAudioFocus? = null
  private var dispatcher: MpvObserverDispatcher? = null

  /**
   * Wire a freshly-created [MpvSurfaceView] to libmpv. Idempotent per engine.
   *
   *  1. `MPVLib.create(context.applicationContext)` — allocates the mpv core.
   *  2. `view.initOptions()` — applies our mobile-friendly option set.
   *  3. `MPVLib.init()` — starts the mpv core (must come AFTER setOptionString calls).
   *  4. `view.observeProperties(...)` + `MPVLib.addObserver(...)` — wires events.
   *  5. `view.postInitOptions()` — late tweaks.
   */
  fun attach(context: Context, view: MpvSurfaceView, dispatcher: MpvObserverDispatcher) {
    if (destroyed.get()) {
      Log.w(TAG, "attach() called on a destroyed engine — ignoring")
      return
    }
    if (!initialized.compareAndSet(false, true)) {
      Log.w(TAG, "attach() called twice — ignoring (existing surface stays bound)")
      return
    }

    surfaceView = view
    this.dispatcher = dispatcher

    MpvFontConfig.install(context.applicationContext)
    MPVLib.create(context.applicationContext)
    view.initOptions()
    MPVLib.init()
    MpvGuard.markLive()

    // Tap libmpv's internal log stream and surface it under tag "MpvCore"
    // in logcat. Default level is `warn` for everyday use.
    MPVLib.setOptionString("msg-level", "all=warn")
    MPVLib.addLogObserver(MpvLogBridge)

    view.observeProperties(observedProps)
    val obs = MpvPropertyObserver(
      dispatcher = dispatcher,
      isExiting = { view.isExiting || destroyed.get() },
      mainHandler = mainHandler,
    )
    MPVLib.addObserver(obs)
    observer = obs
    MPVLib.addObserver(playbackReport)
    directRender = MpvDirectRender(view, mainHandler).also { MPVLib.addObserver(it) }
    subtitles = MpvSubtitles(view, mainHandler).also { MPVLib.addObserver(it) }
    // Audio focus and headphones unplugged (PLAY-FOCUS-01).
    audioFocus = MpvAudioFocus(context, mainHandler).also { MPVLib.addObserver(it) }
    MpvProbe.attach(context)

    view.postInitOptions()

    Log.i(TAG, "attached: ${observedProps.size} properties observed")
  }

  /**
   * Move this live core to [view], the player view that replaces its old one on an episode switch, in front or hidden
   * ([PlayerCores.mount], PLAY-OSMEDIA-01): the core keeps playing, so no `MPVLib.create`/`init`. Audio focus, the playback
   * report and the observed properties belong to the core and stay; what reads or drives the view moves to [view].
   */
  fun rebind(view: MpvSurfaceView) {
    val old = surfaceView
    val dispatcher = dispatcher
    if (destroyed.get() || !initialized.get() || old == null || dispatcher == null) {
      Log.w(TAG, "rebind() on an engine that is not attached — ignoring")
      return
    }
    if (old === view) return
    old.holder.removeCallback(old)
    observer?.let { MPVLib.removeObserver(it) }
    directRender?.let { MPVLib.removeObserver(it) }
    subtitles?.let { MPVLib.removeObserver(it) }
    view.takeOver(old)
    old.isExiting = true

    surfaceView = view
    observer = MpvPropertyObserver(
      dispatcher = dispatcher,
      isExiting = { view.isExiting || destroyed.get() },
      mainHandler = mainHandler,
    ).also { MPVLib.addObserver(it) }
    directRender = MpvDirectRender(view, mainHandler).also { MPVLib.addObserver(it) }
    subtitles = MpvSubtitles(view, mainHandler).also { MPVLib.addObserver(it) }
    Log.i(TAG, "rebound: from=${old.hashCode()} to=${view.hashCode()}")
  }

  /**
   * Tear down the mpv core. Mirrors mpvEx's exit sequence:
   *  1. Flag the surface view as exiting so the observer short-circuits.
   *  2. Remove the observer (so no late events race with destroy).
   *  3. `MPVLib.destroy()` — releases native resources.
   *
   * Safe to call repeatedly; subsequent calls are no-ops.
   */
  fun destroy() {
    if (!destroyed.compareAndSet(false, true)) return
    // The view outlives the core on unmount: the exit rotation fires surfaceChanged/surfaceDestroyed
    // after MPVLib.destroy(), and an MPVLib call then aborts the process (destroyed JNI mutex).
    surfaceView?.let { it.holder.removeCallback(it) }
    if (!initialized.get()) {
      surfaceView = null
      observer = null
      dispatcher = null
      return
    }

    surfaceView?.isExiting = true
    observer?.let { MPVLib.removeObserver(it) }
    MPVLib.removeObserver(playbackReport)
    directRender?.let { MPVLib.removeObserver(it) }
    directRender = null
    subtitles?.let { MPVLib.removeObserver(it) }
    subtitles = null
    audioFocus?.let {
      MPVLib.removeObserver(it)
      it.release()
    }
    audioFocus = null
    MpvProbe.detach()
    observer = null
    dispatcher = null

    runCatching { MPVLib.removeLogObserver(MpvLogBridge) }.onFailure {
      Log.w(TAG, "MPVLib.removeLogObserver threw", it)
    }

    // Waits for in-flight bridge calls and blocks new ones before the core is freed.
    MpvGuard.destroy {
      runCatching { MPVLib.destroy() }.onFailure {
        Log.w(TAG, "MPVLib.destroy() threw", it)
      }
    }

    surfaceView = null
    Log.i(TAG, "destroyed")
  }

  // --- Imperative playback API consumed by the RN bridge ----------------------------

  fun loadSource(uri: String, headers: Map<String, String>? = null) {
    val view = surfaceView ?: return
    if (!headers.isNullOrEmpty()) {
      val joined = headers.entries.joinToString(",") { "${it.key}: ${it.value}" }
      MPVLib.setOptionString("http-header-fields", joined)
    }
    view.loadSource(uri)
  }

  fun play() {
    MPVLib.setPropertyBoolean("pause", false)
  }

  fun pause() {
    MPVLib.setPropertyBoolean("pause", true)
  }

  fun togglePause() {
    MPVLib.command(arrayOf("cycle", "pause"))
  }

  fun seek(seconds: Double, mode: SeekMode = SeekMode.ABSOLUTE) {
    MPVLib.command(arrayOf("seek", seconds.toString(), mode.mpvKeyword))
  }

  fun setSpeed(x: Double) {
    MPVLib.setPropertyDouble("speed", x)
  }

  fun setProperty(name: String, value: String) {
    MPVLib.setPropertyString(name, value)
  }

  fun setProperty(name: String, value: Boolean) {
    MPVLib.setPropertyBoolean(name, value)
  }

  fun setProperty(name: String, value: Long) {
    MPVLib.setPropertyInt(name, value.toInt())
  }

  fun setProperty(name: String, value: Double) {
    MPVLib.setPropertyDouble(name, value)
  }

  fun setSubtitleTrack(id: Int) {
    surfaceView?.sid = id
  }

  fun setSecondarySubtitleTrack(id: Int) {
    surfaceView?.secondarySid = id
  }

  fun setAudioTrack(id: Int) {
    surfaceView?.aid = id
  }

  fun setDispatcher(dispatcher: MpvObserverDispatcher) {
    this.dispatcher = dispatcher
  }

  val observedProperties: Map<String, Int> get() = observedProps

  enum class SeekMode(val mpvKeyword: String) {
    ABSOLUTE("absolute"),
    RELATIVE("relative"),
  }

  companion object {
    private const val TAG = "MpvEngine"
  }
}
