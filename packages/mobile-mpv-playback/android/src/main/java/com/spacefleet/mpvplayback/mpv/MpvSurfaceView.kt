// Adapted from mpvEx — Apache 2.0 — https://github.com/marlboro-advance/mpvEx
package com.spacefleet.mpvplayback.mpv

import android.app.UiModeManager
import android.content.Context
import android.content.res.Configuration
import android.util.AttributeSet
import android.util.Log
import android.view.MotionEvent
import android.view.SurfaceHolder
import android.view.SurfaceView
import com.facebook.react.bridge.Arguments
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.events.RCTEventEmitter
import `is`.xyz.mpv.MPVLib
import kotlin.reflect.KProperty

/**
 * Surface-bearing view for libmpv playback.
 *
 * Our libmpv-android.aar exposes `is.xyz.mpv.MPVLib` only (no `BaseMPVView`),
 * so this class implements the surface lifecycle manually instead of subclassing
 * mpvEx's `BaseMPVView`. The shape of `initOptions()` / `observeProperties()` is
 * preserved so the engine can drive lifecycle without caring whether the AAR has
 * `BaseMPVView` or not.
 *
 * Touch handling is forwarded to React Native — the player UI lives in JS.
 */
class MpvSurfaceView : SurfaceView, SurfaceHolder.Callback, PropSourceTarget {
  private var pendingSource: String? = null

  /**
   * Per-file mpv options applied to the next [loadSource] (comma-joined
   * `key=value`, e.g. `start=123.4,vid=2`). Lets JS open a title directly at the
   * resume position / chosen quality instead of loading twice.
   */
  @Volatile
  var startOptions: String? = null

  private fun loadfileArgs(src: String): Array<String> = MpvLoadfile.args(src, startOptions)
  private var surfaceReady = false

  /**
   * The video track to put back once a surface returns, set while the app is in the background or the screen is locked:
   * the picture is switched off (`vid=no`) so the sound keeps playing and the OS media controls keep driving it
   * (PLAY-OSMEDIA-01 item 4). Null while a surface is attached.
   */
  private var parkedVid: String? = null

  /** Set by [MpvEngine] during teardown so the property observer can short-circuit. */
  @Volatile
  var isExiting: Boolean = false

  /** True while mpv renders with `vo=mediacodec_embed` (set in [initOptions] on TV, cleared by the GPU fallback). */
  @Volatile
  var directRender: Boolean = false

  /** Display aspect of the current video, from `video-params/aspect`; null until mpv knows it. */
  private var videoAspect: Double? = null

  /** The box React Native laid this view out in; [layout] may shrink the view inside it to letterbox. */
  private val slot = android.graphics.Rect()

  /**
   * Direct rendering stretches the decoder's frames over the whole surface, so the view itself takes the video's
   * shape: centred in the box React Native gave it, black bars (the player background) around it. With the GPU
   * path mpv letterboxes inside a full-size surface and this is a plain pass-through.
   */
  override fun layout(l: Int, t: Int, r: Int, b: Int) {
    slot.set(l, t, r, b)
    val aspect = videoAspect
    if (!directRender || aspect == null || r <= l || b <= t) {
      super.layout(l, t, r, b)
      publishSubtitle()
      return
    }
    val fit = MpvLetterbox.fit(r - l, b - t, aspect)
    super.layout(l + fit.left, t + fit.top, l + fit.right, t + fit.bottom)
    publishSubtitle()
  }

  /** Main thread only. Re-fits the view to a new video aspect (null = fill the slot). */
  fun setVideoAspect(aspect: Double?) {
    if (aspect == videoAspect) return
    videoAspect = aspect
    Log.i(TAG, "videoAspect=$aspect directRender=$directRender slot=$slot")
    if (!slot.isEmpty) layout(slot.left, slot.top, slot.right, slot.bottom)
  }

  // --- Subtitles drawn by the app (direct rendering, PLAT-TV-06) ----------------------
  // vo=mediacodec_embed has no OSD, so mpv never paints subtitles there. mpv still decodes the selected `sid` and
  // exposes the current line as `sub-text` ([MpvSubtitles]); the view forwards it with the video's rect to JS, which
  // draws it over the picture. Main thread only; an event goes out only when something JS draws changed.

  private var subtitleText: String = ""
  private var subtitleVisible: Boolean = true
  private var lastSubtitlePayload: SubtitlePayload? = null

  private data class SubtitlePayload(
    val text: String,
    val visible: Boolean,
    val directRender: Boolean,
    val left: Int,
    val top: Int,
    val width: Int,
    val height: Int,
  )

  fun setSubtitleText(text: String) {
    if (text == subtitleText) return
    subtitleText = text
    publishSubtitle()
  }

  fun setSubtitleVisible(visible: Boolean) {
    if (visible == subtitleVisible) return
    subtitleVisible = visible
    Log.i(TAG, "subtitles.visibility visible=$visible directRender=$directRender")
    publishSubtitle()
  }

  /** Sends the subtitle state to JS if it changed; also called after [MpvDirectRender] switched to vo=gpu. */
  fun publishSubtitle() {
    // Without direct rendering mpv draws subtitles itself: JS gets one empty, hidden state and nothing per line.
    val direct = directRender
    val payload = SubtitlePayload(
      text = if (direct) subtitleText else "",
      visible = subtitleVisible,
      directRender = direct,
      left = left - slot.left,
      top = top - slot.top,
      width = width,
      height = height,
    )
    if (payload == lastSubtitlePayload) return
    val reactContext = (context as? ThemedReactContext)?.reactApplicationContext ?: return
    if (!reactContext.hasActiveReactInstance()) return
    val previous = lastSubtitlePayload
    lastSubtitlePayload = payload
    if (previous == null || previous.directRender != direct || previous.visible != payload.visible ||
      previous.width != payload.width || previous.height != payload.height
    ) {
      Log.i(
        TAG,
        "subtitles.state directRender=$direct visible=${payload.visible} " +
          "rect=${payload.left},${payload.top} ${payload.width}x${payload.height}",
      )
    }
    val density = resources.displayMetrics.density.takeIf { it > 0f }?.toDouble() ?: 1.0
    val map = Arguments.createMap()
    map.putString("text", payload.text)
    map.putBoolean("visible", payload.visible)
    map.putBoolean("directRender", direct)
    map.putDouble("x", payload.left / density)
    map.putDouble("y", payload.top / density)
    map.putDouble("width", payload.width / density)
    map.putDouble("height", payload.height / density)
    try {
      reactContext.emitDeviceEvent(SUBTITLE_EVENT, map)
    } catch (e: Throwable) {
      Log.w(TAG, "subtitles.emit failed: ${e.message}")
    }
  }

  // --- Track delegates (port of mpvEx TrackDelegate) ---------------------------------
  // -1 means "no" (no track / disabled). Any other value is the mpv track id.

  class TrackDelegate(private val name: String) {
    operator fun getValue(thisRef: Any?, property: KProperty<*>): Int {
      val v = MPVLib.getPropertyString(name)
      return v?.toIntOrNull() ?: -1
    }

    operator fun setValue(thisRef: Any?, property: KProperty<*>, value: Int) {
      if (value == -1) MPVLib.setPropertyString(name, "no")
      else MPVLib.setPropertyInt(name, value)
    }
  }

  var sid: Int by TrackDelegate("sid")
  var secondarySid: Int by TrackDelegate("secondary-sid")
  var aid: Int by TrackDelegate("aid")

  // --- Constructors -------------------------------------------------------------------

  constructor(context: Context) : super(context) {
    initView()
  }

  constructor(context: Context, attrs: AttributeSet?) : super(context, attrs) {
    initView()
  }

  constructor(context: Context, attrs: AttributeSet?, defStyle: Int) :
    super(context, attrs, defStyle) {
    initView()
  }

  private fun initView() {
    holder.addCallback(this)
    // Never consume touches by default — RN gesture layer handles all interaction.
    isClickable = false
    isFocusable = false
  }

  // --- mpv option setup (called by MpvEngine after MPVLib.create, before MPVLib.init) -

  /**
   * Apply mobile-friendly mpv options. Called once per engine lifecycle, between
   * `MPVLib.create(context)` and `MPVLib.init()`. Values are baked-in defaults rather
   * than preference-driven (mpvEx uses Koin-injected preferences; we don't).
   */
  fun initOptions() {
    // Video / audio output. Phones: opensles (stereo, no passthrough). Android TV: audiotrack, which can send
    // Dolby Digital / DD+ / DTS untouched and decoded sound as multichannel PCM; opensles stays the fallback. Which
    // formats pass through and how many channels decoded sound uses is set per box from its HDMI sink, before the
    // first file loads (JS `configureTvAudioOutput`, MPV-TV-03).
    MPVLib.setOptionString("vo", "gpu")
    MPVLib.setOptionString("gpu-context", "android")
    MPVLib.setOptionString("ao", if (isTelevision(context)) "audiotrack,opensles" else "opensles")

    // Hardware decoding with software fallback chain.
    // mediacodec (HW+) -> mediacodec-copy (HW) -> no (SW). All codecs.
    MPVLib.setOptionString("hwdec", "mediacodec,mediacodec-copy,no")
    MPVLib.setOptionString("hwdec-codecs", "all")

    // Android TV renders straight from the hardware decoder into this surface (mediacodec_embed): no copy back
    // to memory, no GL pass. On a low-budget Amlogic Android TV box (Android 11, armv7) vo=gpu forced
    // mediacodec-copy and dropped ~8.5 of 24 frames/s on 1080p H.264 with zero decoder drops, and garbled 4K
    // HEVC (squashed, tiled, green); direct rendering dropped none on either. mpv can't scale or letterbox in this
    // mode, so [layout] fits the view to the video aspect. If the decoder can't take a file, MpvDirectRender
    // falls back to vo=gpu, which the bilinear scalers keep cheap (SDMC QS02 measurement, PR #781).
    // This VO has no OSD: mpv still decodes the selected `sid`, but the app draws the line (`sub-text`, MpvSubtitles);
    // subtitles never switch back to vo=gpu. Bitmap subtitles (PGS/VobSub) have no text and don't show here.
    if (isTelevision(context)) {
      directRender = true
      MPVLib.setOptionString("vo", "mediacodec_embed")
      MPVLib.setOptionString("hwdec", "mediacodec")
      MPVLib.setOptionString("scale", "bilinear")
      MPVLib.setOptionString("cscale", "bilinear")
      MPVLib.setOptionString("dscale", "bilinear")
      MPVLib.setOptionString("sigmoid-upscaling", "no")
      MPVLib.setOptionString("linear-downscaling", "no")
      MPVLib.setOptionString("correct-downscaling", "no")
      TvAudioOutput.applyStoredOptions()
    }

    // OSC / OSD off — RN owns the UI.
    MPVLib.setOptionString("osc", "no")
    MPVLib.setOptionString("osd-bar", "no")
    MPVLib.setOptionString("osd-level", "0")

    // Disable ytdl_hook — youtube-dl isn't present on Android and the hook adds
    // ~200 ms of subprocess-fork noise on every load (every HLS segment).
    MPVLib.setOptionString("ytdl", "no")

    // Playback behaviour.
    MPVLib.setOptionString("keep-open", "yes")
    MPVLib.setOptionString("input-default-bindings", "yes")

    // Demuxer / network tuning for HLS over the local proxy.
    MPVLib.setOptionString("demuxer-max-bytes", "32MiB")
    MPVLib.setOptionString("demuxer-max-back-bytes", "32MiB")
    MPVLib.setOptionString("demuxer-readahead-secs", "10")
    MPVLib.setOptionString("network-timeout", "30")
    MPVLib.setOptionString("demuxer-lavf-o", "seg_max_retry=2")

    // hr-seek MUST be "yes" for HLS-fmp4 with non-keyframe-aligned segments.
    // (verified against 2026-05-06 playback traces).
    MPVLib.setOptionString("cache-secs", "30")
    MPVLib.setOptionString("hr-seek", "yes")
    MPVLib.setOptionString("hr-seek-framedrop", "yes")
    // cache-pause=yes: on a network underrun mpv pauses and raises
    // `paused-for-cache`, then resumes once ~1 s is buffered (no A/V stutter).
    // That flag is the ONLY thing separating a network stall from HEVC decode
    // lag (JS lag detector, spinner, ABR underrun downshift, seek/switch settle
    // guards). `cache-pause-initial=no` keeps the first frame immediate.
    MPVLib.setOptionString("cache-pause", "yes")
    MPVLib.setOptionString("cache-pause-initial", "no")

    // Disable mpv's auto track selection — JS PlayerControls drives.
    MPVLib.setOptionString("alang", "")
    MPVLib.setOptionString("slang", "")
    MPVLib.setOptionString("sub-auto", "no")
    MPVLib.setOptionString("sub-file-paths", "")
    MPVLib.setOptionString("subs-fallback", "no")

    // NOTE: TLS-CA setup is intentionally skipped. Our AAR does not ship a
    // `cacert.pem` asset, and HLS reaches mpv via the local in-process proxy
    // over plain HTTP. If mpv ever needs to fetch over real HTTPS, wire up
    // `tls-verify=yes` + `tls-ca-file=...` here.
  }

  /**
   * Register the set of mpv properties we want change events for. Called by
   * [MpvEngine] after `MPVLib.init()`.
   */
  fun observeProperties(props: Map<String, Int>) {
    for ((name, format) in props) MPVLib.observeProperty(name, format)
  }

  /**
   * Hook for post-init tweaks. Currently a no-op; mpvEx uses this for debanding /
   * statistics overlay toggles which we don't need.
   */
  fun postInitOptions() {
    // No-op for now.
  }

  /** Same checks as the app's MainActivity: Android TV / Google TV mode, leanback, or Fire TV. */
  private fun isTelevision(context: Context): Boolean {
    val uiMode = context.getSystemService(UiModeManager::class.java)?.currentModeType
    return uiMode == Configuration.UI_MODE_TYPE_TELEVISION ||
      context.packageManager.hasSystemFeature("android.software.leanback") ||
      context.packageManager.hasSystemFeature("amazon.hardware.fire_tv")
  }

  // --- Touch forwarding (preserved from prior implementation) -------------------------

  private var touchStartX = 0f
  private var touchStartY = 0f
  private var touchStartTime = 0L

  override fun onTouchEvent(event: MotionEvent): Boolean {
    val reactContext = context as? ThemedReactContext ?: return false
    when (event.action and MotionEvent.ACTION_MASK) {
      MotionEvent.ACTION_DOWN -> {
        touchStartX = event.x
        touchStartY = event.y
        touchStartTime = System.currentTimeMillis()
      }
      MotionEvent.ACTION_UP -> {
        val dx = event.x - touchStartX
        val dy = event.y - touchStartY
        val dt = System.currentTimeMillis() - touchStartTime
        // Only emit tap on quick, small movement (not a scroll).
        if (dt < 300 && Math.abs(dx) < 30 && Math.abs(dy) < 30) {
          val eventData = Arguments.createMap()
          eventData.putDouble("x", event.x.toDouble())
          eventData.putDouble("y", event.y.toDouble())
          eventData.putDouble("surfaceWidth", width.toDouble())
          eventData.putDouble("surfaceHeight", height.toDouble())
          // RCTEventEmitter is a legacy-bridge module. On the new architecture
          // (Fabric / Bridgeless) BridgelessReactContext.getJSModule throws an
          // IllegalArgumentException for legacy modules. Swallow it — JS-side
          // PlayerControls handles taps via an overlay Pressable, not via this
          // native event, so callers that don't ref the view can ignore.
          try {
            reactContext.getJSModule(RCTEventEmitter::class.java)
              ?.receiveEvent(id, "onSurfaceTap", eventData)
          } catch (_: Throwable) {
            // no-op — JS overlay drives taps, this is best-effort fallback
          }
        }
      }
    }
    return true
  }

  // --- SurfaceHolder.Callback ---------------------------------------------------------

  override fun surfaceCreated(holder: SurfaceHolder) {
    Log.i(TAG, "surfaceCreated")
    MPVLib.attachSurface(holder.surface)
    val w = holder.surfaceFrame.width()
    val h = holder.surfaceFrame.height()
    if (w > 0 && h > 0) {
      MPVLib.setPropertyString("android-surface-size", "${w}x${h}")
    }
    surfaceReady = true
    pendingSource?.let { src ->
      pendingSource = null
      Log.i(TAG, "Loading deferred source: $src options=$startOptions")
      MPVLib.command(loadfileArgs(src))
    }
    parkedVid?.let { vid ->
      parkedVid = null
      Log.i(TAG, "background.picture_restored vid=$vid")
      runCatching { MPVLib.setPropertyString("vid", vid) }
    }
  }

  override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
    Log.i(TAG, "surfaceChanged: ${width}x${height}")
    MPVLib.setPropertyString("android-surface-size", "${width}x${height}")
  }

  override fun surfaceDestroyed(holder: SurfaceHolder) {
    Log.i(TAG, "surfaceDestroyed")
    surfaceReady = false
    // Foreground/background lifecycle only: MpvEngine.destroy() unregisters this callback before
    // freeing the core, so libmpv is always alive here. Without a surface the video output would stall playback, sound
    // included: switch the picture off so the sound keeps playing in the background, put it back in [surfaceCreated].
    if (!isExiting && parkedVid == null) {
      val vid = runCatching { MPVLib.getPropertyString("vid") }.getOrNull()
      if (vid != null && vid != "no") {
        parkedVid = vid
        Log.i(TAG, "background.picture_parked vid=$vid")
        runCatching { MPVLib.setPropertyString("vid", "no") }
      }
    }
    runCatching { MPVLib.setPropertyString("android-surface-size", "1x1") }
    runCatching { MPVLib.detachSurface() }
  }

  // --- Public API used by view manager / engine --------------------------------------

  /**
   * Load a URI. If the surface isn't attached yet, defer until [surfaceCreated].
   * `loadfile` is mpv's primary command for opening a stream.
   */
  fun loadSource(source: String) {
    lastLoadedSource = source
    // Only the old player's own file takes the carry: on return React can first replay a held, older `source` prop (the
    // episode before a background switch) and only then the current one, so a load of another file leaves it in place.
    carriedOver?.takeIf { it.source == source }?.let { carried ->
      carriedOver = null
      val seconds = carried.seconds
      if (seconds != null && seconds > 1.0 && startOptions?.contains("start=") != true) {
        startOptions = listOfNotNull(String.format(java.util.Locale.ROOT, "start=%.3f", seconds), startOptions?.takeIf { it.isNotBlank() }).joinToString(",")
        Log.i(TAG, "handover.resume source=$source seconds=$seconds")
      }
    }
    if (surfaceReady) {
      Log.i(TAG, "Loading source immediately: $source options=$startOptions")
      MPVLib.command(loadfileArgs(source))
    } else if (!directRender && !appInForeground()) {
      // The next episode, started from the lock screen or the notification while the app is in the background: play
      // its sound now, the picture comes with the surface when the app returns.
      Log.i(TAG, "background.load_without_surface: $source options=$startOptions")
      parkedVid = "auto"
      MPVLib.command(MpvLoadfile.args(source, listOfNotNull(startOptions?.takeIf { it.isNotBlank() }, "vid=no").joinToString(",")))
    } else {
      Log.i(TAG, "Deferring source load until surface ready: $source")
      pendingSource = source
    }
  }

  /** The file a replaced player was playing and where it was, so the player that replaces it goes on from there. */
  data class CarriedOver(val source: String, val seconds: Double?)

  /** Set by the view manager when this view replaces a still-mounted player (see `MpvSurfaceViewManager.createViewInstance`). */
  var carriedOver: CarriedOver? = null

  /** Read while this view's core is still alive, just before it is freed for the view that replaces it. */
  fun carryOver(): CarriedOver? {
    val source = lastLoadedSource ?: return null
    return CarriedOver(source, runCatching { MPVLib.getPropertyDouble("time-pos") }.getOrNull())
  }

  /** The last source handed to [loadSource], whichever way it came (the `source` prop or [loadInBackground]). */
  private var lastLoadedSource: String? = null

  /** Set by [loadInBackground]: the `source` prop carrying this URL arrives later and must not load it a second time. */
  private var propAlreadyLoaded: String? = null

  /**
   * The next episode, picked on the lock screen, the notification or a headset while the app is in the background
   * (PLAY-OSMEDIA-01 item 4): React Native holds the new `source` prop until the app's window shows again, so JS hands
   * the URL over through the module and it plays now. Returns false when [source] is already the one loaded.
   */
  fun loadInBackground(source: String, options: String?): Boolean {
    if (source == lastLoadedSource) {
      Log.i(TAG, "background.load_skipped already_loaded: $source")
      return false
    }
    Log.i(TAG, "background.load_from_js: $source options=$options")
    startOptions = options
    loadSource(source)
    propAlreadyLoaded = source
    return true
  }

  /** Called by the view manager for each new `source` prop: false when [loadInBackground] already loaded it. */
  override fun takePropSource(source: String): Boolean {
    val already = propAlreadyLoaded
    propAlreadyLoaded = null
    if (source == already) {
      Log.i(TAG, "source.prop_already_loaded: $source")
      return false
    }
    return true
  }

  /**
   * Called by [MpvEngine.rebind] when this view takes over [old]'s still-playing core on an episode switch (in front, or
   * hidden: PLAY-OSMEDIA-01). The file goes on as it is: this view's `source` prop for it must not load it again (another
   * file loads as usual), and the picture switched off while hidden comes back with this view's surface
   * ([surfaceCreated]). [old]'s holder callback is already removed; a surface it still holds is let go here, as
   * [surfaceDestroyed] does.
   */
  fun takeOver(old: MpvSurfaceView) {
    if (old.surfaceReady) old.surfaceDestroyed(old.holder)
    lastLoadedSource = old.lastLoadedSource
    propAlreadyLoaded = old.lastLoadedSource
    pendingSource = old.pendingSource
    parkedVid = old.parkedVid
    directRender = old.directRender
    videoAspect = old.videoAspect
    subtitleText = old.subtitleText
    subtitleVisible = old.subtitleVisible
    old.pendingSource = null
    old.parkedVid = null
    Log.i(TAG, "core.taken_over source=$lastLoadedSource parkedVid=$parkedVid pending=$pendingSource")
  }

  private fun appInForeground(): Boolean =
    (context as? ThemedReactContext)?.lifecycleState?.let { it == com.facebook.react.common.LifecycleState.RESUMED } ?: true

  /**
   * Compute the corrected aspect ratio (accounting for 90/270 rotation), or null
   * when mpv hasn't reported video dimensions yet. Mirrors mpvEx's behaviour.
   */
  fun getVideoOutAspect(): Double? {
    val rawAspect = MPVLib.getPropertyDouble("video-params/aspect")
    val rotate = MPVLib.getPropertyInt("video-params/rotate") ?: 0

    val finalAspect = if (rawAspect == null || rawAspect < 0.001) {
      val width = runCatching {
        MPVLib.getPropertyInt("width") ?: MPVLib.getPropertyInt("video-params/w") ?: 0
      }.getOrDefault(0)
      val height = runCatching {
        MPVLib.getPropertyInt("height") ?: MPVLib.getPropertyInt("video-params/h") ?: 0
      }.getOrDefault(0)
      if (width > 0 && height > 0) width.toDouble() / height.toDouble() else null
    } else {
      rawAspect
    }

    return finalAspect?.let { aspect ->
      if (aspect <= 0.001) return@let null
      val isRotated = (rotate % 180 == 90)
      if (isRotated) 1.0 / aspect else aspect
    }
  }

  companion object {
    private const val TAG = "MpvSurfaceView"

    /** Device event carrying the subtitle line + video rect; JS: `MPV_SUBTITLE_EVENT` in `src/subtitleOverlay.ts`. */
    const val SUBTITLE_EVENT = "MpvSubtitle"

    /** The player view created last, for [MpvControlModule.loadInBackground]; cleared when that view is dropped. */
    @Volatile
    var live: java.lang.ref.WeakReference<MpvSurfaceView>? = null
  }
}
