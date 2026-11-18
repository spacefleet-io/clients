package com.spacefleet.mpvplayback.mpv

/**
 * Which player view owns the process's one libmpv core, and when a dropped view's core is freed. [MpvSurfaceViewManager]
 * drives it with its views ([V]), their engines ([E]) and what a freed player played ([C]); kept free of Android so the
 * order of mounts and drops is unit-tested.
 *
 * An episode switch remounts the player (`PlayerScreen` keys it by episode). With the app in front, React mounts the new
 * view and drops the old one in the same frame. With the app hidden (lock screen, notification, headset: PLAY-OSMEDIA-01)
 * React Native may run the drop at once yet hold the mount until the app shows again, or hold both and later run every
 * held mount and drop of several switches in one go (seen on a OnePlus 9: Next, Previous, Previous while locked, then
 * three drops and two mounts at the third press). Either way nothing may be left to play the new episode.
 */
class PlayerCores<V : Any, E : Any, C : Any>(
  private val destroy: (E) -> Unit,
  private val carryOver: (V) -> C?,
  private val log: (String) -> Unit,
) {
  private val engines = LinkedHashMap<V, E>()

  /**
   * Switches announced by [switchPending] (the module's thread) whose old view was not dropped yet. Each hidden drop
   * uses one; a mount or drop with the app in front clears them.
   */
  private val pendingSwitches = java.util.concurrent.atomic.AtomicInteger(0)

  /** What the last freed player played and where, for the view that replaces it. */
  private var lastCarried: C? = null

  /** The view whose core plays now: what a background load ([MpvSurfaceView.loadInBackground]) goes to. */
  var live: V? = null
    private set

  /** JS is about to switch episode (`MpvControl.holdCoreForSwitch`). */
  fun switchPending() {
    log("engine.switch_pending count=${pendingSwitches.incrementAndGet()}")
  }

  /** What [mount] gives the new view: its engine, whether that engine is an existing core taken over, and the carry. */
  data class Mounted<E, C>(val engine: E, val reused: Boolean, val carried: C?)

  /**
   * A new view mounts. libmpv is one core per process and a second `MPVLib.create` aborts it, so the core that exists is
   * taken over as it is: it plays on, and the new view rebinds to it ([MpvEngine.rebind]). That is the core parked by a
   * hidden episode switch, or else the one of a view still mounted (React mounts the new view before it drops the old:
   * an episode switch in front, or on unlock the held mounts of several hidden switches run one after the other).
   * Rebuilding it lost playback on a OnePlus 9: on unlock the new core's reload of the episode played while locked timed
   * out. Only with no core at all does [create] make one; the core freed last ([drop]) hands its file and position over.
   * A mount while the app is hidden keeps the pending switches: React may drop this view again in the same batch, for a
   * later switch.
   */
  fun mount(view: V, appInForeground: Boolean, create: () -> E): Mounted<E, C> {
    if (appInForeground) pendingSwitches.set(0)
    val kept = parked ?: engines.entries.lastOrNull()?.toPair()
    parked = null
    if (kept != null) engines.remove(kept.first)
    for ((old, oldEngine) in engines.entries.toList()) {
      log("engine.extra_freed view=${old.hashCode()}")
      engines.remove(old)
      destroy(oldEngine)
    }
    val engine = if (kept != null) {
      lastCarried = carryOver(kept.first)
      log("engine.taken_over from=${kept.first.hashCode()} to=${view.hashCode()} carried=$lastCarried")
      kept.second
    } else {
      create()
    }
    engines[view] = engine
    live = view
    val carried = lastCarried
    lastCarried = null
    return Mounted(engine, reused = kept != null, carried = carried)
  }

  /**
   * React drops [view]. Dropped by an episode switch while the app is hidden, its core is parked: it stays [live] and
   * plays the next episode ([MpvSurfaceView.loadInBackground]) until the new view mounts, when the app shows again.
   */
  fun drop(view: V, appInForeground: Boolean) {
    val engine = engines.remove(view) ?: return
    val switching = if (appInForeground) pendingSwitches.getAndSet(0) > 0 else pendingSwitches.getAndUpdate { maxOf(it - 1, 0) } > 0
    if (switching && !appInForeground) {
      parked = view to engine
      log("engine.parked view=${view.hashCode()}")
      return
    }
    lastCarried = carryOver(view)
    destroy(engine)
    if (live === view) live = null
    log("engine.dropped foreground=$appInForeground")
  }

  /** The engine a `source` prop on [view] may load into: null once the view was dropped (parked included). */
  fun engineOf(view: V): E? = engines[view]

  /** A core kept past its view's drop by a hidden episode switch, taken over by the next mount. */
  private var parked: Pair<V, E>? = null
}
