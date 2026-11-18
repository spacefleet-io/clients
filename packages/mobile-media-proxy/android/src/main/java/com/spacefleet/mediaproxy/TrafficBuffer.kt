package com.spacefleet.mediaproxy

/**
 * Playback under the gateway's high-traffic state (STOR-BW-01): the viewer keeps only the next `playbackBufferSeconds`
 * buffered instead of the full read-ahead. No Android types (no JVM test target runs it yet). JS reads the silo's
 * report (`apps/badger/mobile/src/lib/playback/trafficBuffer.ts`) and calls `PlaybackBridge.setBufferCap`.
 *
 * The cap is a number of seconds; [NO_CAP] (0) means traffic is normal.
 */
object TrafficBuffer {
  const val NO_CAP = 0.0

  /** What `MpvSurfaceView` configures at start: `cache-secs` and `demuxer-readahead-secs`. Change them together. */
  const val NORMAL_CACHE_SECS = 30
  const val NORMAL_READAHEAD_SECS = 10

  /** mpv `cache-secs` under [capSeconds]: never above the normal value, at least 1 s. */
  fun cacheSecs(capSeconds: Double): Int = capped(NORMAL_CACHE_SECS, capSeconds)

  /** mpv `demuxer-readahead-secs` under [capSeconds]: never above the normal value, at least 1 s. */
  fun readaheadSecs(capSeconds: Double): Int = capped(NORMAL_READAHEAD_SECS, capSeconds)

  private fun capped(normal: Int, capSeconds: Double): Int {
    if (!(capSeconds > 0) || !capSeconds.isFinite()) return normal
    return minOf(normal, maxOf(1, Math.floor(capSeconds).toInt()))
  }

  /**
   * How many of the segments after the one served, [nextDurations] in order, the proxy reads ahead: all of them while
   * traffic is normal; else the leading ones whose cumulative duration stays within [capSeconds], and at least one so
   * playback never starves for want of its next segment (the desktop's `limitPrefetchKeys`).
   */
  fun lookaheadCount(nextDurations: List<Double>, capSeconds: Double): Int {
    if (nextDurations.isEmpty() || !(capSeconds > 0) || !capSeconds.isFinite()) return nextDurations.size
    var total = 0.0
    var count = 0
    for (duration in nextDurations) {
      if (count > 0 && total + duration > capSeconds) break
      total += duration
      count += 1
    }
    return maxOf(1, count)
  }
}
