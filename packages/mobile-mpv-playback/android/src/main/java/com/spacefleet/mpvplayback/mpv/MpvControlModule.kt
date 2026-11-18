package com.spacefleet.mpvplayback.mpv

import android.app.Activity
import android.os.Build
import android.util.DisplayMetrics
import android.provider.Settings
import android.view.WindowManager
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.os.SystemClock
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.WritableMap
import com.facebook.react.bridge.WritableNativeMap
import com.facebook.react.uimanager.DisplayMetricsHolder
import com.spacefleet.mediaproxy.NetworkMeter

class MpvControlModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "MpvControl"

  private companion object {
    /** Delays after an orientation request at which JS `Dimensions` is re-synced (the config change lands in between). */
    val DIMENSION_RESYNC_DELAYS_MS = longArrayOf(250L, 900L, 2000L)

    /** Lowest window brightness the swipe gesture sets. */
    const val MIN_WINDOW_BRIGHTNESS = 0.01

    /** Polling step / cap for "the portrait restore has landed" before the system bars are shown again. */
    const val BARS_RESTORE_POLL_MS = 16L
    const val BARS_RESTORE_MAX_POLLS = 60
  }

  private val mainHandler = Handler(Looper.getMainLooper())

  /** Player screens currently holding the landscape lock (a next-episode swap overlaps two). */
  private var playerScreens = 0

  /**
   * The activity's requested orientation before the first player screen took the landscape lock, restored when the last
   * one leaves: PORTRAIT on phones (MainActivity locks it), UNSPECIFIED on TVs, which must never be asked for portrait.
   * Null when no player took the lock (its mount call found no activity): the close then leaves the orientation alone.
   */
  private var orientationBeforePlayer: Int? = null

  private val dimensionResyncs = mutableListOf<Runnable>()

  /**
   * React Native keeps the window metrics it read when it last saw a rotation change, and re-reads them only on the next
   * rotation. The player's landscape/portrait round trip can land the read before the application resources carry the new
   * configuration: JS then keeps the old window size while the screen is already the other way round (details sheet laid out
   * 2201 px wide on a 1080 px portrait screen, shell pager pages the wrong width, taps land on nothing). Re-read the metrics
   * after the configuration settles; JS is told through the same `didUpdateDimensions` event RN uses.
   */
  private fun scheduleDimensionResync(activity: Activity) {
    dimensionResyncs.forEach { mainHandler.removeCallbacks(it) }
    dimensionResyncs.clear()
    for (delayMs in DIMENSION_RESYNC_DELAYS_MS) {
      val resync = Runnable {
        val app = reactApplicationContext
        DisplayMetricsHolder.initDisplayMetrics(app)
        val window = windowMetrics(activity)
        val actual = activity.resources.displayMetrics
        Log.i(
          "MpvControl",
          "dimensions.resync delayMs=$delayMs window=${window.widthPixels}x${window.heightPixels} " +
            "activity=${actual.widthPixels}x${actual.heightPixels}",
        )
        // DeviceInfoModule (internal to RN) only emits on its own triggers; emit the fresh metrics ourselves, in its
        // payload shape. JS `Dimensions` ignores a payload equal to what it holds, so repeating this is harmless.
        val fontScale = app.resources.configuration.fontScale.toDouble()
        app.emitDeviceEvent(
          "didUpdateDimensions",
          WritableNativeMap().apply {
            putMap("windowPhysicalPixels", physicalPixels(window, fontScale))
            putMap("screenPhysicalPixels", physicalPixels(DisplayMetricsHolder.getScreenDisplayMetrics(), fontScale))
          },
        )
      }
      dimensionResyncs.add(resync)
      mainHandler.postDelayed(resync, delayMs)
    }
  }

  /**
   * The window size RN 0.88's DeviceInfoModule reports with edge-to-edge off (both phone apps set
   * `edgeToEdgeEnabled=false`): the window bounds less the system bars and cutout, or the resource metrics (which already
   * exclude the bars) before insets exist or below API 30. RN 0.88 made its own copy internal, so it is computed here.
   */
  private fun windowMetrics(activity: Activity): DisplayMetrics {
    val metrics = DisplayMetrics().apply { setTo(activity.resources.displayMetrics) }
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return metrics
    val insets = ViewCompat.getRootWindowInsets(activity.window.decorView) ?: return metrics
    val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
    val bounds = activity.windowManager.currentWindowMetrics.bounds
    metrics.widthPixels = bounds.width() - (bars.left + bars.right)
    metrics.heightPixels = bounds.height() - (bars.top + bars.bottom)
    return metrics
  }

  private fun physicalPixels(metrics: DisplayMetrics, fontScale: Double): WritableMap =
    WritableNativeMap().apply {
      putInt("width", metrics.widthPixels)
      putInt("height", metrics.heightPixels)
      putDouble("scale", metrics.density.toDouble())
      putDouble("fontScale", fontScale)
      putDouble("densityDpi", metrics.densityDpi.toDouble())
    }

  /**
   * Shows the system bars once the activity is portrait again. The show is an app-driven insets animation (the app holds
   * the bars' leash); started while the rotation is in flight, it finishes with the landscape position, so the gesture
   * handle stayed drawn mid-screen (y = landscape bottom) and missing from the real bottom edge.
   */
  private var pendingBarsRestore: Runnable? = null

  private fun showSystemBarsWhenPortrait(activity: Activity) {
    var polls = 0
    val restore = object : Runnable {
      override fun run() {
        val portrait = activity.resources.configuration.orientation == Configuration.ORIENTATION_PORTRAIT
        if (!portrait && polls++ < BARS_RESTORE_MAX_POLLS) {
          mainHandler.postDelayed(this, BARS_RESTORE_POLL_MS)
          return
        }
        pendingBarsRestore = null
        // One more frame so the rotation's own layout pass is done before the insets animation starts.
        activity.window.decorView.post {
          WindowCompat.getInsetsController(activity.window, activity.window.decorView).show(WindowInsetsCompat.Type.systemBars())
        }
      }
    }
    pendingBarsRestore = restore
    mainHandler.post(restore)
  }

  /**
   * Lock the host activity to landscape and hide the system bars (immersive
   * sticky) when [enabled] is true. When false, restore the orientation the
   * activity had before the player and the system bars. Idempotent.
   *
   * Called by JS at PlayerScreen mount/unmount: the player is landscape-only, the
   * rest of the app is portrait-only on phones (MainActivity, UX-ORIENT-01) and
   * free on TVs, so leaving the player restores that orientation and never hands
   * rotation to the sensor.
   */
  @ReactMethod
  fun setImmersiveLandscape(enabled: Boolean, promise: Promise) {
    val activity: Activity? = getCurrentActivity()
    if (activity == null) {
      promise.reject("no_activity", "no current activity")
      return
    }
    activity.runOnUiThread {
      try {
        val window = activity.window
        val decor = window.decorView
        pendingBarsRestore?.let { mainHandler.removeCallbacks(it) }
        pendingBarsRestore = null
        Log.i(
          "MpvControl",
          "orientation.lock enabled=$enabled screens=$playerScreens config=${activity.resources.configuration.orientation}",
        )
        if (enabled) {
          if (playerScreens == 0) orientationBeforePlayer = activity.requestedOrientation
          playerScreens += 1
          activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
          WindowCompat.setDecorFitsSystemWindows(window, false)
          val controller = WindowCompat.getInsetsController(window, decor)
          controller.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
          controller.hide(WindowInsetsCompat.Type.systemBars())
          scheduleDimensionResync(activity)
        } else if (playerScreens > 1) {
          // "Next episode" mounts the new player before the old one unmounts: the
          // surviving player still needs the landscape lock.
          playerScreens -= 1
        } else {
          playerScreens = 0
          orientationBeforePlayer?.let { activity.requestedOrientation = it }
          orientationBeforePlayer = null
          WindowCompat.setDecorFitsSystemWindows(window, true)
          showSystemBarsWhenPortrait(activity)
          scheduleDimensionResync(activity)
        }
        promise.resolve(true)
      } catch (e: Exception) {
        promise.reject("immersive_error", e.message)
      }
    }
  }

  /** TV audio sink facts for the JS planner (`src/tvAudioOutput.ts`, MPV-TV-03); no mpv core needed. */
  @ReactMethod
  fun getAudioOutputReport(promise: Promise) {
    try {
      promise.resolve(TvAudioOutput.report(reactApplicationContext))
    } catch (e: Exception) {
      promise.reject("mpv_error", e.message)
    }
  }

  /** Applies the JS TV audio plan: `audio-spdif` + `audio-channels` (tvOS-only [preferredOutputChannels] is ignored here). */
  @ReactMethod
  fun setAudioOutput(spdif: String, channels: String, preferredOutputChannels: Int, reason: String, promise: Promise) {
    try {
      TvAudioOutput.apply(spdif, channels, reason)
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("mpv_error", e.message)
    }
  }

  @ReactMethod
  fun togglePause(promise: Promise) {
    try {
      MpvGuard.command(arrayOf("cycle", "pause"))
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("mpv_error", e.message)
    }
  }

  /**
   * Seek to an absolute time. The optional [mode] string is passed through to
   * mpv's `seek` command — supports the documented mpv flags such as
   * `absolute`, `absolute+keyframes`, `absolute+exact`, `absolute-percent`, etc.
   *
   * Defaults to `absolute+exact`. Pairs with `hr-seek=yes` in
   * [MpvSurfaceView.initOptions] for sub-second landings on HLS-fmp4 sources
   * even when segment boundaries don't align with keyframes.
   */
  @ReactMethod
  fun seek(seconds: Double, mode: String?, promise: Promise) {
    try {
      val resolvedMode = mode?.takeIf { it.isNotBlank() } ?: "absolute+exact"
      MpvGuard.command(arrayOf("seek", seconds.toString(), resolvedMode))
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("mpv_error", e.message)
    }
  }

  /**
   * Seek by reloading the source at start=<seconds>. Available as a fallback
   * for callers who specifically need the loadfile + start= path; the regular
   * seek bar uses [seek] directly now that the new mpv build handles
   * mid-segment HLS seeks cleanly.
   */
  @ReactMethod
  fun seekToTime(url: String, seconds: Double, promise: Promise) {
    try {
      MpvGuard.command(MpvLoadfile.args(url, "start=" + seconds.toString()))
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("mpv_error", e.message)
    }
  }

  /**
   * Reload [url] at [startSeconds] keeping the playback state requested by JS.
   * Used for quality / HEVC-fallback switches that cannot be done by flipping
   * `vid` in place. [options] is a comma-joined mpv per-file option string
   * (e.g. "aid=2,sid=3,pause=yes"); empty/null for none.
   */
  @ReactMethod
  fun loadAt(url: String, startSeconds: Double, options: String?, promise: Promise) {
    try {
      val opts = mutableListOf("start=" + startSeconds.toString())
      if (!options.isNullOrBlank()) opts.add(options)
      MpvGuard.command(MpvLoadfile.args(url, opts.joinToString(",")))
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("mpv_error", e.message)
    }
  }

  /**
   * JS is about to switch episode (PLAY-OSMEDIA-01). Awaited before the switch: with the app hidden React Native drops
   * the old player view at once but holds the new one until the window shows again, so the old core is kept to play
   * the next episode ([MpvSurfaceViewManager.cores]).
   */
  @ReactMethod
  fun holdCoreForSwitch(promise: Promise) {
    MpvSurfaceViewManager.cores.switchPending()
    promise.resolve(true)
  }

  /**
   * Loads [url] with the per-file [options] into the live player view now, for a new source picked while the app is in
   * the background (PLAY-OSMEDIA-01 item 4: next or previous on the lock screen, the notification or a headset). React
   * Native holds the `source` prop until the window shows again; the view then skips that prop. Resolves false when no
   * player view exists or [url] is already loaded.
   */
  @ReactMethod
  fun loadInBackground(url: String, options: String?, promise: Promise) {
    mainHandler.post {
      val view = MpvSurfaceView.live?.get()
      if (view == null) {
        android.util.Log.w("MpvControl", "background.load_no_view: $url")
        promise.resolve(false)
        return@post
      }
      try {
        promise.resolve(view.loadInBackground(url, options))
      } catch (e: Exception) {
        promise.reject("mpv_error", e.message)
      }
    }
  }

  @ReactMethod
  fun loadFromUrl(url: String, promise: Promise) {
    try {
      MpvGuard.command(MpvLoadfile.args(url, null))
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("mpv_error", e.message)
    }
  }

  @ReactMethod
  fun seekRelative(seconds: Double, mode: String?, promise: Promise) {
    try {
      val resolvedMode = mode?.takeIf { it.isNotBlank() } ?: "relative+exact"
      MpvGuard.command(arrayOf("seek", seconds.toString(), resolvedMode))
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("mpv_error", e.message)
    }
  }

  @ReactMethod
  fun getPlaybackState(promise: Promise) {
    try {
      val map = WritableNativeMap()
      map.putDouble("position", safeGetDouble("time-pos"))
      map.putDouble("duration", safeGetDouble("duration"))
      map.putBoolean("paused", safeGetBool("pause"))
      map.putDouble("cacheEnd", safeGetDouble("demuxer-cache-time"))
      promise.resolve(map)
    } catch (e: Exception) {
      promise.reject("mpv_error", e.message)
    }
  }

  /**
   * One-shot snapshot of everything the JS player needs to decide what to show
   * and when to adapt. JS polls this at 0.5-1 Hz (never per frame); every field
   * is a plain mpv property read so a poll is a handful of cheap native calls.
   */
  @ReactMethod
  fun getPlaybackSnapshot(promise: Promise) {
    try {
      val map = WritableNativeMap()
      // Taken with time-pos: JS judges media progress on this clock, never on when the JS thread processed the poll.
      map.putDouble("sampledAtMs", SystemClock.elapsedRealtime().toDouble())
      map.putDouble("position", safeGetDouble("time-pos"))
      map.putDouble("duration", safeGetDouble("duration"))
      map.putBoolean("paused", safeGetBool("pause"))
      map.putDouble("cacheEnd", safeGetDouble("demuxer-cache-time"))
      map.putDouble("cacheDuration", safeGetDouble("demuxer-cache-duration"))
      map.putDouble("cacheSpeed", safeGetDouble("cache-speed"))
      map.putBoolean("eof", safeGetBool("eof-reached"))
      map.putBoolean("pausedForCache", safeGetBool("paused-for-cache"))
      map.putBoolean("seeking", safeGetBool("seeking"))
      map.putBoolean("idle", safeGetBool("idle-active"))
      map.putBoolean("coreIdle", safeGetBool("core-idle"))
      map.putBoolean("voConfigured", safeGetBool("vo-configured"))
      map.putString("hwdec", safeGetString("hwdec-current"))
      map.putString("videoCodec", safeGetString("video-format"))
      map.putDouble("frameDrops", safeGetInt("frame-drop-count").toDouble())
      map.putDouble("decoderFrameDrops", safeGetInt("decoder-frame-drop-count").toDouble())
      map.putInt("vid", safeGetTrackIdOrNull("vid") ?: -1)
      map.putInt("aid", safeGetTrackIdOrNull("aid") ?: -1)
      map.putInt("sid", safeGetTrackIdOrNull("sid") ?: -1)
      map.putInt("videoWidth", safeGetInt("video-params/w"))
      map.putInt("videoHeight", safeGetInt("video-params/h"))
      // Adaptive-quality inputs (see apps/badger/mobile/src/lib/playback/quality.ts).
      map.putDouble("avsync", safeGetDouble("avsync"))
      map.putString("currentVo", safeGetString("current-vo"))
      map.putDouble("netBps", NetworkMeter.bitsPerSecond())
      map.putDouble("cacheSecs", safeGetDouble("cache-secs"))
      map.putDouble("demuxerMaxBytes", safeGetDouble("demuxer-max-bytes"))
      promise.resolve(map)
    } catch (e: Exception) {
      promise.reject("mpv_error", e.message)
    }
  }

  /** Switch mpv's decoder policy live (e.g. "mediacodec,mediacodec-copy,no" or "no" for software). */
  @ReactMethod
  fun setHwdec(value: String, promise: Promise) {
    try {
      MpvGuard.setPropertyString("hwdec", value)
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("mpv_error", e.message)
    }
  }

  /** Keep the display awake while playing (FLAG_KEEP_SCREEN_ON on the host window). */
  @ReactMethod
  fun setKeepScreenOn(enabled: Boolean, promise: Promise) {
    val activity: Activity? = getCurrentActivity()
    if (activity == null) {
      promise.reject("no_activity", "no current activity")
      return
    }
    activity.runOnUiThread {
      if (enabled) activity.window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      else activity.window.clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      promise.resolve(true)
    }
  }

  /**
   * Brightness of the host window as 0..1: the player's own override when set, else the system level. The system
   * level is read on the 0..255 setting scale, which is only an approximation on devices with a different curve.
   */
  @ReactMethod
  fun getScreenBrightness(promise: Promise) {
    val activity: Activity? = getCurrentActivity()
    if (activity == null) {
      promise.reject("no_activity", "no current activity")
      return
    }
    activity.runOnUiThread {
      val own = activity.window.attributes.screenBrightness
      if (own >= 0f) {
        promise.resolve(own.toDouble())
      } else {
        val system = Settings.System.getInt(activity.contentResolver, Settings.System.SCREEN_BRIGHTNESS, 128)
        promise.resolve((system / 255.0).coerceIn(0.0, 1.0))
      }
    }
  }

  /** Overrides the host window brightness (0..1, no permission needed); a negative level hands control back to the system. */
  @ReactMethod
  fun setScreenBrightness(level: Double, promise: Promise) {
    val activity: Activity? = getCurrentActivity()
    if (activity == null) {
      promise.reject("no_activity", "no current activity")
      return
    }
    activity.runOnUiThread {
      val attrs = activity.window.attributes
      attrs.screenBrightness =
        if (level < 0) WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
        // 0 would switch some panels fully off: keep a floor so the picture stays visible.
        else level.coerceIn(MIN_WINDOW_BRIGHTNESS, 1.0).toFloat()
      activity.window.attributes = attrs
      promise.resolve(true)
    }
  }

  @ReactMethod
  fun setVolume(volume: Double, promise: Promise) {
    try {
      MpvGuard.setPropertyString("volume", volume.toInt().toString())
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("mpv_error", e.message)
    }
  }

  @ReactMethod
  fun setAudioTrack(id: Int, promise: Promise) {
    try {
      if (id < 0) MpvGuard.setPropertyString("aid", "no")
      else MpvGuard.setPropertyInt("aid", id)
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("mpv_error", e.message)
    }
  }

  @ReactMethod
  fun setSubtitleTrack(id: Int, promise: Promise) {
    try {
      if (id < 0) MpvGuard.setPropertyString("sid", "no")
      else MpvGuard.setPropertyInt("sid", id)
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("mpv_error", e.message)
    }
  }

  @ReactMethod
  fun setSecondarySubtitleTrack(id: Int, promise: Promise) {
    try {
      if (id < 0) MpvGuard.setPropertyString("secondary-sid", "no")
      else MpvGuard.setPropertyInt("secondary-sid", id)
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("mpv_error", e.message)
    }
  }

  @ReactMethod
  fun setPaused(paused: Boolean, promise: Promise) {
    try {
      MpvGuard.setPropertyBoolean("pause", paused)
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("mpv_error", e.message)
    }
  }

  @ReactMethod
  fun getTimePos(promise: Promise) {
    try {
      val value = MpvGuard.getPropertyDouble("time-pos")
      promise.resolve(value ?: -1.0)
    } catch (_: Exception) {
      promise.resolve(-1.0)
    }
  }

  @ReactMethod
  fun setSubDelay(seconds: Double, promise: Promise) {
    try {
      MpvGuard.setPropertyDouble("sub-delay", seconds)
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("mpv_error", e.message)
    }
  }

  /** mpv `sub-pos` (where the bottom subtitle line ends, % of the picture height; 100 when mpv isn't live). */
  @ReactMethod
  fun getSubPos(promise: Promise) {
    try {
      promise.resolve(MpvGuard.getPropertyDouble("sub-pos") ?: 100.0)
    } catch (_: Exception) {
      promise.resolve(100.0)
    }
  }

  /** Sets mpv `sub-pos`: subtitles move up above the TV controls while they show (MPV-OSC-02). */
  @ReactMethod
  fun setSubPos(value: Double, promise: Promise) {
    try {
      MpvGuard.setPropertyDouble("sub-pos", value)
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("mpv_error", e.message)
    }
  }

  /**
   * `sub-add <url> select [title [lang]]`. The JNI `command` binding drops mpv's return code, but `sub-add` is
   * synchronous (it returns once mpv has fetched and opened the file), so a load that failed (HTTP error from the
   * playback proxy, unreadable file) is detected by the track list not growing. Rejects `subtitle_load_failed`
   * then, so JS can say so and put the previous subtitle back (PLAY-TRACK-06).
   */
  @ReactMethod
  fun addSubtitle(url: String, language: String?, title: String?, promise: Promise) {
    try {
      // mpv's sub-add positional args are `<flags> <title> <lang>`; a lang without a title would
      // land in the title slot, so a title is always passed first (falling back to the language).
      val args = mutableListOf("sub-add", url, "select")
      val label = title?.takeIf { it.isNotBlank() } ?: language?.takeIf { it.isNotBlank() }
      if (label != null) args.add(label)
      if (!language.isNullOrBlank()) args.add(language)
      val before = MpvGuard.getPropertyInt("track-list/count") ?: 0
      val started = SystemClock.elapsedRealtime()
      MpvGuard.command(args.toTypedArray())
      val after = MpvGuard.getPropertyInt("track-list/count") ?: 0
      val ms = SystemClock.elapsedRealtime() - started
      if (after <= before) {
        Log.w("MpvControl", "subtitle.add_failed ms=$ms tracks=$before->$after lang=$language url=$url")
        promise.reject("subtitle_load_failed", "sub-add did not add a track: $url")
        return
      }
      Log.i("MpvControl", "subtitle.add ms=$ms tracks=$before->$after lang=$language url=$url")
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("mpv_error", e.message)
    }
  }

  @ReactMethod
  fun removeAllSubtitles(promise: Promise) {
    try {
      // Loop sub-remove until mpv reports no current sid. Bounded to avoid
      // a runaway if something goes sideways with property reads.
      repeat(8) {
        val sid = safeGetTrackIdOrNull("sid") ?: -1
        if (sid <= 0) return@repeat
        MpvGuard.command(arrayOf("sub-remove"))
      }
      MpvGuard.setPropertyString("sid", "no")
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("mpv_error", e.message)
    }
  }

  @ReactMethod
  fun setVideoTrack(id: Int, promise: Promise) {
    try {
      if (id < 0) MpvGuard.setPropertyString("vid", "no")
      else MpvGuard.setPropertyInt("vid", id)
      promise.resolve(true)
    } catch (e: Exception) {
      promise.reject("mpv_error", e.message)
    }
  }

  /**
   * The phone's real decoder capabilities (`MediaCodecList`) and, per probe `{id, mime, width, height, fps, tenBit}`, whether a
   * hardware / software decoder supports it. Feeds the start-quality decision; logs `playback.decoder.caps` once per process.
   */
  @ReactMethod
  fun getDecoderCaps(probes: ReadableArray?, promise: Promise) {
    try {
      promise.resolve(DecoderCaps.report(probes))
    } catch (e: Exception) {
      promise.reject("decoder_caps_error", e.message)
    }
  }

  @ReactMethod
  fun getTrackList(promise: Promise) {
    try {
      val raw = MpvGuard.getPropertyString("track-list") ?: "[]"
      val arr = org.json.JSONArray(raw)
      val out = com.facebook.react.bridge.WritableNativeArray()
      for (i in 0 until arr.length()) {
        val item = arr.getJSONObject(i)
        val map = WritableNativeMap()
        map.putInt("id", item.optInt("id", -1))
        map.putString("type", item.optString("type", ""))
        map.putBoolean("selected", item.optBoolean("selected", false))
        if (item.has("lang") && !item.isNull("lang")) map.putString("lang", item.optString("lang", "")) else map.putNull("lang")
        if (item.has("title") && !item.isNull("title")) map.putString("title", item.optString("title", "")) else map.putNull("title")
        if (item.has("codec") && !item.isNull("codec")) map.putString("codec", item.optString("codec", "")) else map.putNull("codec")
        map.putInt("demuxW", item.optInt("demux-w", 0))
        map.putInt("demuxH", item.optInt("demux-h", 0))
        map.putDouble("hlsBitrate", item.optDouble("hls-bitrate", 0.0))
        map.putBoolean("external", item.optBoolean("external", false))
        out.pushMap(map)
      }
      promise.resolve(out)
    } catch (e: Exception) {
      promise.reject("mpv_error", e.message)
    }
  }

  private fun safeGetDouble(name: String): Double {
    return try {
      MpvGuard.getPropertyDouble(name) ?: 0.0
    } catch (e: Exception) {
      0.0
    }
  }

  private fun safeGetString(name: String): String {
    return try {
      MpvGuard.getPropertyString(name) ?: ""
    } catch (e: Exception) {
      ""
    }
  }

  private fun safeGetIntOrNull(name: String): Int? {
    return try {
      MpvGuard.getPropertyInt(name)
    } catch (e: Exception) {
      null
    }
  }

  /**
   * Track ids (vid/aid/sid) are choice properties: a number, or "no"/"auto". Reading them as INT64
   * fails with "unsupported format" whenever no track is selected (no subtitles is the common case),
   * and libmpv logs that error on every 500 ms snapshot poll. Read them as strings instead.
   */
  private fun safeGetTrackIdOrNull(name: String): Int? {
    return try {
      MpvGuard.getPropertyString(name)?.toIntOrNull()
    } catch (e: Exception) {
      null
    }
  }

  private fun safeGetInt(name: String): Int = safeGetIntOrNull(name) ?: 0

  private fun safeGetBool(name: String): Boolean {
    return try {
      MpvGuard.getPropertyBoolean(name) ?: false
    } catch (e: Exception) {
      false
    }
  }
}
