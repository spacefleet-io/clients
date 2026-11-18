package com.spacefleet.mpvplayback.mpv

import android.util.Log
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.common.LifecycleState
import com.facebook.react.common.MapBuilder
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp

class MpvSurfaceViewManager(private val reactContext: ReactApplicationContext) :
  SimpleViewManager<MpvSurfaceView>() {

  companion object {
    private const val TAG = "MpvSurfaceViewManager"

    /**
     * One engine per view instance — the engine owns the libmpv lifecycle for that view; [PlayerCores] decides when it
     * is freed. Process-wide like libmpv's one core, so [MpvControlModule] can announce an episode switch.
     */
    val cores = PlayerCores<MpvSurfaceView, MpvEngine, MpvSurfaceView.CarriedOver>(
      destroy = { it.destroy() },
      carryOver = { it.carryOver() },
      log = { Log.i(TAG, it) },
    )
  }

  // The view name JS uses to reference us via requireNativeComponent("MpvPlayerView").
  // Renamed from mpv-poc's "MpvPocView" / badger's "TfpMpvView" to a single shared
  // identifier that apps/badger/mobile and any future app use.
  override fun getName(): String = "MpvPlayerView"

  override fun createViewInstance(reactContext: ThemedReactContext): MpvSurfaceView {
    // libmpv is one core per process and a second MPVLib.create aborts it. The new view takes over the core that exists
    // as it is (PlayerCores.mount): the one an episode changed while the window was hidden (lock screen, notification,
    // PLAY-OSMEDIA-01) left playing the new episode, or the one of a view React has not dropped yet. Only with no core
    // does a new engine start; then the new view goes on with the file the core freed last played, from where it was (it
    // only applies when the new source is that file).
    val view = MpvSurfaceView(reactContext)
    val mounted = cores.mount(view, appInForeground = this.reactContext.lifecycleState == LifecycleState.RESUMED) { MpvEngine() }
    view.carriedOver = mounted.carried
    if (mounted.reused) mounted.engine.rebind(view) else mounted.engine.attach(reactContext.applicationContext, view, NoopDispatcher)
    MpvSurfaceView.live = java.lang.ref.WeakReference(view)
    return view
  }

  override fun onDropViewInstance(view: MpvSurfaceView) {
    cores.drop(view, appInForeground = reactContext.lifecycleState == LifecycleState.RESUMED)
    MpvSurfaceView.live = cores.live?.let { java.lang.ref.WeakReference(it) }
    super.onDropViewInstance(view)
  }

  @ReactProp(name = "startOptions")
  fun setStartOptions(view: MpvSurfaceView, options: String?) {
    view.startOptions = options
  }

  @ReactProp(name = "source")
  fun setSource(view: MpvSurfaceView, source: String?) {
    if (source.isNullOrBlank()) return
    // Posted so every prop of the same update batch (notably startOptions) is applied first.
    view.post { PropSourceLoad.run(source, view, cores.engineOf(view)?.let { engine -> { s: String -> engine.loadSource(s) } }) { Log.w(TAG, it) } }
  }

  override fun getExportedCustomDirectEventTypeConstants(): Map<String, Any> {
    return MapBuilder.builder<String, Any>()
      .put("onSurfaceTap", MapBuilder.of("registrationName", "onSurfaceTap"))
      .build()
  }

  // No-op dispatcher used until a richer event-emitter is wired (DeviceEventEmitter
  // emit per property change). The control surface is good enough to drive playback
  // through MpvControlModule's pull-style API today; observer events would only be
  // needed for true reactive UI bindings.
  private object NoopDispatcher : MpvObserverDispatcher {
    override fun onObserverEvent(property: String) {}
    override fun onObserverEvent(property: String, value: Long) {}
    override fun onObserverEvent(property: String, value: Boolean) {}
    override fun onObserverEvent(property: String, value: String) {}
    override fun onObserverEvent(property: String, value: Double) {}
    override fun onObserverEvent(eventId: Int) {}
  }
}
