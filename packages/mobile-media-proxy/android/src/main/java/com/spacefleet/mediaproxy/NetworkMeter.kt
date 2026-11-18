package com.spacefleet.mediaproxy

/**
 * Measured network throughput of the local playback proxy's upstream fetches (tunnel downloads), for the JS
 * adaptive-quality controller.
 *
 * mpv's `cache-speed` cannot serve as that signal: segments arrive in bursts through the proxy and the demuxer cache
 * is full most of the time (mpv stops reading), so it reads 0 or an average over idle time. Here every completed
 * fetch records (bytes, start, end); throughput is `bytes / busy time` over a sliding window, where busy time is the
 * union of the fetch intervals (parallel prefetches overlap, so their bytes are summed over the overlapped time,
 * not per connection). Idle time is excluded on purpose: the question is "how fast can the link deliver", not "how
 * much did the player ask for".
 */
object NetworkMeter {
  private const val WINDOW_MS = 15_000L
  /** Samples older than this carry no information about the link now: report 0 (unknown), JS keeps its estimate. */
  private const val MAX_AGE_MS = 15_000L

  private class Sample(val bytes: Long, val startMs: Long, val endMs: Long)

  private val lock = Any()
  private val samples = ArrayDeque<Sample>()

  fun record(bytes: Long, startMs: Long, endMs: Long) {
    if (bytes <= 0 || endMs <= startMs) return
    synchronized(lock) {
      samples.addLast(Sample(bytes, startMs, endMs))
      prune(endMs)
    }
  }

  /** Bits per second delivered while fetching in the last [WINDOW_MS], 0 when nothing completed recently. */
  fun bitsPerSecond(nowMs: Long = System.currentTimeMillis()): Double {
    synchronized(lock) {
      return bitsPerSecondLocked(nowMs)
    }
  }

  private fun bitsPerSecondLocked(nowMs: Long): Double {
    prune(nowMs)
    if (samples.isEmpty()) return 0.0
    val sorted = samples.sortedBy { it.startMs }
    var bytes = 0L
    var busyMs = 0L
    var curStart = sorted[0].startMs
    var curEnd = sorted[0].endMs
    for (s in sorted) {
      bytes += s.bytes
      if (s.startMs > curEnd) {
        busyMs += curEnd - curStart
        curStart = s.startMs
        curEnd = s.endMs
      } else if (s.endMs > curEnd) {
        curEnd = s.endMs
      }
    }
    busyMs += curEnd - curStart
    return if (busyMs <= 0) 0.0 else bytes * 8000.0 / busyMs
  }

  fun reset() {
    synchronized(lock) { samples.clear() }
  }

  /** Caller holds [lock]. */
  private fun prune(nowMs: Long) {
    while (samples.isNotEmpty() && nowMs - samples.first().endMs > MAX_AGE_MS) samples.removeFirst()
  }
}

/**
 * Test-only network cap applied to upstream fetches, shared across every fetch thread (one token bucket). 0 = off.
 * Only the debug/profile probe ever sets it (`probe.NETTHROTTLE`); release builds never touch it, so production
 * fetches take the unthrottled `bytes()` path.
 */
object NetworkThrottle {
  @Volatile var bytesPerSecond: Long = 0L
  private var nextFreeNs = 0L

  /** Milliseconds the caller must wait after reading [bytes] so the aggregate rate stays at the cap. */
  fun delayMsFor(bytes: Int): Long {
    val rate = bytesPerSecond
    if (rate <= 0) return 0L
    synchronized(this) {
      val now = System.nanoTime()
      val start = maxOf(now, nextFreeNs)
      nextFreeNs = start + bytes * 1_000_000_000L / rate
      return (nextFreeNs - now) / 1_000_000L
    }
  }
}
