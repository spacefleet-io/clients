package com.spacefleet.mpvplayback.mpv

/** The view side of a posted `source` prop ([MpvSurfaceView] implements it). */
interface PropSourceTarget {
  /** False when the URL already came through [MpvSurfaceView.loadInBackground] and must not load a second time. */
  fun takePropSource(source: String): Boolean
}

/**
 * What a `source` prop does once its posted runnable runs. [engineLoad] is the view's engine, null once
 * [MpvSurfaceViewManager] dropped the view (or freed its core for the view that replaces it). A dropped view never loads:
 * its core is freed, and `loadfile` on a freed core aborts the process ("libmpv is not initialized"). React can mount a
 * player and drop it within the same frame, as a lock-screen Previous did on a OnePlus 9, so the posted prop lands late.
 */
object PropSourceLoad {
  fun run(source: String, target: PropSourceTarget, engineLoad: ((String) -> Unit)?, log: (String) -> Unit): Boolean {
    if (engineLoad == null) {
      log("source.skipped_dropped_view: $source")
      return false
    }
    if (!target.takePropSource(source)) return false
    engineLoad(source)
    return true
  }
}
