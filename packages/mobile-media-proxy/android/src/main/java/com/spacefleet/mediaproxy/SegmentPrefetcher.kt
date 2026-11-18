package com.spacefleet.mediaproxy

import android.util.Log
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/**
 * Proxy-side read-ahead for HLS segments.
 *
 * libmpv's lavf HLS demuxer reads ONE segment at a time (video, audio and the unused alternates are visited serially on the
 * demux thread), so every cold read pays `tunnel + decrypt` back to back: a timeline seek on the throttled phone fetched
 * ~4 video + ~6 audio segments one after the other (2.2 s on a normal phone). The segments are all going to be requested
 * anyway, so this class fetches them in parallel, ahead of mpv, into the [ChunkFetcher] cache (dedup'd with mpv's own
 * request by the fetcher's in-flight map, so a request that arrives mid-prefetch simply waits for the remainder).
 *
 * Three triggers, all keyed on the object key mpv asks for:
 *  - [register]: init + first segment of every track the moment a session exists (mpv's startup probe reads them all,
 *    serially, one `start-file` later);
 *  - [onRequest]: a segment of a *live* track (one mpv has read past its first two segments) pulls the time-aligned
 *    segments of the other live tracks (playing video variant <-> audio) in parallel: that is what a seek looks like from here;
 *  - [onServed]: after a live track's segment is served, the next [LOOKAHEAD_SEGMENTS] of the same track, plus the
 *    segments of the other live tracks (the playing video variant and the audio) that their own look-ahead would fetch
 *    anyway and that lie fully inside that stretch of the timeline: the batch mixes audio and video without any track
 *    reaching further ahead than its own [LOOKAHEAD_SEGMENTS].
 *
 * Each trigger collects its keys into one batch and requests it in a shuffled order that mixes audio and video
 * ([BatchShuffle], PRIV-ENC-05), never track by track.
 *
 * A rung switch is make-before-break ([beginSwitch], PLAY-ABR-04): the old player keeps playing while the target rung's
 * segment is fetched, with the link to itself, and JS reloads onto it once it is here.
 *
 * Nothing here changes what mpv receives. Failures are logged and swallowed (the real request re-fetches).
 */
internal class SegmentPrefetcher(
  private val fetcher: ChunkFetcher,
  private val executor: Executor,
  /** Runs one fetch of a switch warm: a thread of its own, so the warm never queues behind look-ahead jobs on [executor]. */
  private val spawn: (Runnable) -> Unit = { job -> Thread(job, "PlaybackHttp-warm").apply { isDaemon = true }.start() },
) {
  private class TrackIndex(val id: String, val track: HlsTrack, val isVideo: Boolean) {
    /** Cumulative start of each segment: the timeline [PlaylistBuilder] presents to mpv (sum of EXTINF). */
    val starts = DoubleArray(track.segments.size)

    /** Set once mpv has read past the startup probe window of this track. */
    @Volatile var live = false

    /** Video only: this is the variant mpv reads now. A rung switch reloads the session on another variant, whose first
     *  request clears this flag on the one left behind (which stays [live]). */
    @Volatile var playing = false

    /** Index of the last segment of this track written to mpv, -1 before the first one. */
    @Volatile var servedIndex = -1
    var siblings: List<TrackIndex> = emptyList()

    init {
      var t = 0.0
      track.segments.forEachIndexed { i, seg ->
        starts[i] = t
        t += seg.durationSeconds
      }
    }

    /** Index of the segment containing [seconds] (clamped to the track). */
    fun indexAt(seconds: Double): Int {
      var lo = 0
      var hi = starts.size - 1
      var found = 0
      while (lo <= hi) {
        val mid = (lo + hi) ushr 1
        if (starts[mid] <= seconds) {
          found = mid
          lo = mid + 1
        } else {
          hi = mid - 1
        }
      }
      return found
    }
  }

  /** [index] -1 is the track's init segment. */
  private class Slot(val track: TrackIndex, val index: Int)

  /** The gateway's `playbackBufferSeconds` while its silo is high ([TrafficBuffer.NO_CAP] otherwise). */
  @Volatile var bufferCapSeconds: Double = TrafficBuffer.NO_CAP

  private val slots = ConcurrentHashMap<String, Slot>()
  private val scheduled = ConcurrentHashMap.newKeySet<String>()

  /** Video variants (by id) and audio tracks of the last registered session: [beginSwitch] looks its target up here. */
  @Volatile private var videos: Map<String, TrackIndex> = emptyMap()
  @Volatile private var audios: List<TrackIndex> = emptyList()

  /** A rung switch between [beginSwitch] and the new player's first request of [target]. */
  private class Switch(val target: TrackIndex) {
    val over = CountDownLatch(1)

    /** Set before [over] opens: the new player reached [target], so the old player whose requests were parked is gone. */
    @Volatile var landed = false
  }

  private val pendingSwitch = AtomicReference<Switch?>(null)

  /** Warms each track's init and its first [WARMUP_SEGMENTS] segments from [fromSeconds] (0 = the start). */
  fun register(session: HlsSession, fromSeconds: Double = 0.0) {
    val tracks = session.videos.map { TrackIndex(it.id, it.track, isVideo = true) } +
      session.audio.map { TrackIndex(it.id, it.track, isVideo = false) }
    for (t in tracks) {
      t.siblings = tracks.filter { it !== t }
      slots[t.track.initKey] = Slot(t, -1)
      t.track.segments.forEachIndexed { i, seg -> slots[seg.key] = Slot(t, i) }
    }
    videos = tracks.filter { it.isVideo }.associateBy { it.id }
    audios = tracks.filter { !it.isVideo }
    // A new session (start, Retry) replaces the player: requests an earlier switch parked belong to a player that is gone.
    pendingSwitch.get()?.let { endSwitch(it, landed = true, why = "session") }
    val batch = ArrayList<Pair<String, String>>()
    for (t in tracks) {
      batch += t.track.initKey to "warmup"
      val first = if (fromSeconds > 0.0 && t.track.segments.isNotEmpty()) t.indexAt(fromSeconds) else 0
      for (i in first until minOf(first + WARMUP_SEGMENTS, t.track.segments.size)) batch += t.track.segments[i].key to "warmup"
    }
    scheduleBatch(batch)
  }

  /** `<track id>#<segment index>@<start s>` (`#init` for an init segment) of [key], or "-" when it is not a session segment. Logs only. */
  fun describe(key: String): String {
    val slot = slots[key] ?: return "-"
    if (slot.index < 0) return "${slot.track.id}#init"
    return "${slot.track.id}#${slot.index}@${"%.1f".format(java.util.Locale.ROOT, slot.track.starts[slot.index])}"
  }

  /** Called when mpv's request for [key] starts. */
  fun onRequest(key: String) {
    val slot = slots[key] ?: return
    pendingSwitch.get()?.let { sw -> if (slot.track === sw.target) endSwitch(sw, landed = true, why = "landed") }
    if (slot.index < 0) return
    val track = slot.track
    if (track.isVideo && !track.playing) {
      track.playing = true
      for (sibling in track.siblings) if (sibling.isVideo) sibling.playing = false
    }
    if (slot.index >= LIVE_AFTER_INDEX) track.live = true
    if (!track.live) return
    val at = track.starts[slot.index]
    val batch = ArrayList<Pair<String, String>>()
    for (sibling in track.siblings) {
      if (!prefetchable(sibling)) continue
      val first = sibling.indexAt(at)
      batch += sibling.track.initKey to "sibling"
      for (i in first until minOf(first + SIBLING_SEGMENTS, sibling.track.segments.size)) {
        batch += sibling.track.segments[i].key to "sibling"
      }
    }
    scheduleBatch(batch)
  }

  /** Called when [key] has been fully written to mpv. */
  fun onServed(key: String) {
    val slot = slots[key] ?: return
    if (slot.index < 0) return
    val track = slot.track
    track.servedIndex = slot.index
    // A video variant left behind by a rung switch (a serve that was already under way) reads no further ahead.
    if (!track.live || !prefetchable(track)) return
    val segments = track.track.segments
    val reach = minOf(slot.index + LOOKAHEAD_SEGMENTS, segments.size - 1)
    // High traffic (STOR-BW-01): only as many segments ahead as fit the gateway's playback buffer; the siblings follow the capped stretch.
    val ahead = TrafficBuffer.lookaheadCount((slot.index + 1..reach).map { segments[it].durationSeconds }, bufferCapSeconds)
    val last = slot.index + ahead
    val batch = ArrayList<Pair<String, String>>()
    for (i in slot.index + 1..last) batch += segments[i].key to "lookahead"
    if (last > slot.index) {
      // Mix in the other live tracks so the batch holds audio and video (PRIV-ENC-05), taking from each only segments its
      // own look-ahead covers (the next LOOKAHEAD_SEGMENTS after its last served one) that lie fully inside this window:
      // no track is fetched further ahead than before. A video variant left behind by a rung switch is skipped.
      val from = track.starts[slot.index + 1] - BOUNDARY_EPSILON_S
      val to = track.starts[last] + segments[last].durationSeconds + BOUNDARY_EPSILON_S
      for (sibling in track.siblings) {
        if (!prefetchable(sibling)) continue
        val sibSegments = sibling.track.segments
        val served = sibling.servedIndex
        for (i in served + 1..minOf(served + LOOKAHEAD_SEGMENTS, sibSegments.size - 1)) {
          val start = sibling.starts[i]
          if (start >= from && start + sibSegments[i].durationSeconds <= to) batch += sibSegments[i].key to "lookahead"
        }
      }
    }
    scheduleBatch(batch)
  }

  /**
   * Live, and for video the variant mpv reads now: a variant left by a rung switch stays [TrackIndex.live] but is never read
   * again. While a switch is pending no video is read ahead at all: the link belongs to the target's warm.
   */
  private fun prefetchable(t: TrackIndex) = t.live && (!t.isVideo || (t.playing && pendingSwitch.get() == null))

  /**
   * Make-before-break rung switch (PLAY-ABR-04). The player keeps playing the variant it is on while [variantId]'s init, the
   * segment of it holding [atSeconds] and the live audio there are fetched; [onDone] reports when they are all here (null)
   * or the first failure, and JS reloads onto the target then. From now on the target is the playing variant:
   *  - the fetches still in flight for the other video variants are aborted: on a OnePlus 6 test phone at 1 Mbit/s two 1080p read-ahead
   *    segments (9.3 MB, then one more) kept downloading through the reload, and the 2.3 MB 420p segment it waited on
   *    took 46.7 s instead of about 19 s;
   *  - no video is read ahead until the new player reads the target ([prefetchable]);
   *  - the old player's requests for its variant wait in [holdLeftBehind] instead of being fetched.
   * False (and [onDone] never called) when [variantId] is not a video variant of the session.
   */
  fun beginSwitch(variantId: String, atSeconds: Double, onDone: (Throwable?) -> Unit): Boolean {
    val target = videos[variantId] ?: return false
    val sw = Switch(target)
    // A newer switch supersedes the pending one before any reload: the old player still plays, so what that one parked is
    // fetched after all (a request for a variant the new switch leaves behind parks again on its next request).
    pendingSwitch.getAndSet(sw)?.let { endSwitch(it, landed = false, why = "superseded") }
    target.playing = true
    target.live = true
    for (video in videos.values) if (video !== target) video.playing = false
    val aborted = fetcher.cancelInFlight { key -> slots[key]?.track?.let { it.isVideo && it !== target } == true }
    val keys = ArrayList<String>()
    keys += target.track.initKey
    if (target.track.segments.isNotEmpty()) keys += target.track.segments[target.indexAt(atSeconds)].key
    for (audio in audios) {
      if (!audio.live || audio.track.segments.isEmpty()) continue
      val first = audio.indexAt(atSeconds)
      for (i in first..minOf(first + 1, audio.track.segments.size - 1)) keys += audio.track.segments[i].key
    }
    // The warm leaves the device in a shuffled order, like every look-ahead batch (PRIV-ENC-05).
    val order = BatchShuffle.shuffled(keys, BatchShuffle.systemNextInt)
    val started = System.currentTimeMillis()
    Log.i(
      TAG,
      "switch.begin target=${target.id} at=${"%.1f".format(java.util.Locale.ROOT, atSeconds)} aborted=$aborted warm=${order.joinToString(",") { describe(it) }}"
    )
    val left = AtomicInteger(order.size)
    val failed = AtomicBoolean(false)
    for (key in order) {
      spawn(Runnable {
        try {
          fetcher.prefetch(key)
          if (left.decrementAndGet() == 0 && !failed.get()) {
            Log.i(TAG, "switch.warm.done target=${target.id} ms=${System.currentTimeMillis() - started}")
            onDone(null)
          }
        } catch (e: Throwable) {
          if (failed.compareAndSet(false, true)) {
            Log.w(TAG, "switch.warm.failed target=${target.id} slot=${describe(key)} msg=${e.message}")
            onDone(e)
          }
        }
      })
    }
    return true
  }

  /**
   * Called before the player's request of [key] is fetched. While a switch is pending, a request for another video variant
   * can only come from the old player (JS loads nothing but the target during a switch): it waits here, the old player
   * playing on from its buffer, rather than take the link from the warm. True when the switch landed meanwhile (that player
   * is gone: answer without fetching); false to serve the request as usual (no switch pending, audio or the target, or a
   * switch nobody finished within [PARK_MAX_MS]).
   */
  fun holdLeftBehind(key: String): Boolean {
    val sw = pendingSwitch.get() ?: return false
    val slot = slots[key] ?: return false
    if (!slot.track.isVideo || slot.track === sw.target) return false
    Log.d(TAG, "switch.park slot=${describe(key)}")
    if (!sw.over.await(PARK_MAX_MS, TimeUnit.MILLISECONDS)) endSwitch(sw, landed = false, why = "abandoned")
    return sw.landed
  }

  private fun endSwitch(sw: Switch, landed: Boolean, why: String) {
    if (sw.over.count == 0L) return
    pendingSwitch.compareAndSet(sw, null)
    sw.landed = landed
    sw.over.countDown()
    Log.i(TAG, "switch.end target=${sw.target.id} why=$why")
  }

  /**
   * Requests one look-ahead batch in a shuffled order (PRIV-ENC-05). The pool starts jobs in submission order, so shuffling
   * the submission order shuffles the order the blocks leave the device: audio and video blocks of the batch are interleaved
   * unpredictably instead of one track after the other.
   */
  private fun scheduleBatch(batch: List<Pair<String, String>>) {
    if (batch.isEmpty()) return
    val order = BatchShuffle.shuffled(batch, BatchShuffle.systemNextInt)
    Log.d(TAG, "prefetch.batch order=${order.joinToString(",") { describe(it.first) }}")
    for ((key, reason) in order) schedule(key, reason)
  }

  private fun schedule(key: String, reason: String) {
    if (!scheduled.add(key)) return
    try {
      executor.execute {
        val started = System.currentTimeMillis()
        try {
          fetcher.prefetch(key)
          Log.d(TAG, "prefetch.done reason=$reason slot=${describe(key)} key=$key elapsedMs=${System.currentTimeMillis() - started}")
        } catch (e: Throwable) {
          Log.d(TAG, "prefetch.failed reason=$reason key=$key msg=${e.message}")
        } finally {
          scheduled.remove(key)
        }
      }
    } catch (e: Throwable) {
      // Executor shut down with the server.
      scheduled.remove(key)
    }
  }

  companion object {
    private const val TAG = "PlaybackHttp"

    /** Segments per track fetched at session start (mpv's startup probe reads the first two of every track). */
    private const val WARMUP_SEGMENTS = 2

    /** A track is "live" (actually playing, not just probed) once mpv requests a segment at or past this index. */
    private const val LIVE_AFTER_INDEX = 2

    /** Time-aligned segments pulled per sibling track (a 12 s audio segment covers about one video segment). */
    private const val SIBLING_SEGMENTS = 2
    private const val LOOKAHEAD_SEGMENTS = 3

    /** Slack on segment boundaries: two tracks cut at the same instants can sum their EXTINFs to slightly different values. */
    private const val BOUNDARY_EPSILON_S = 0.001

    /**
     * Longest an old-player request waits on a pending switch. Above the longest JS waits before it reloads anyway
     * (`qualitySwitch.ts`: the playhead's way to the warmed segment plus `SWITCH_SETTLE_TIMEOUT_MS`).
     */
    private const val PARK_MAX_MS = 90_000L
  }
}
