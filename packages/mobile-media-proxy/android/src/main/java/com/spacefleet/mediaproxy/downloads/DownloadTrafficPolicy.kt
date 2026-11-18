package com.spacefleet.mediaproxy.downloads

/** What the engine tells JS about the traffic rules acting on the downloads, as the `traffic` field of the state JSON. */
object DownloadTrafficState {
  const val NORMAL = "normal"

  /** The silo is in its high-traffic state: downloads run slower, never stopped (STOR-BW-01). */
  const val SLOWED = "slowed"

  /** The silo is saturated: downloads wait and resume by themselves (STOR-BW-09). */
  const val HELD = "held"

  /** Held wins over slowed (a saturated silo is also high). */
  fun of(held: Boolean, slowed: Boolean): String = if (held) HELD else if (slowed) SLOWED else NORMAL
}

/**
 * Rules the download engine applies under load, with no Android types (no JVM test target runs them yet).
 *
 * - Slowed (STOR-BW-01): the average rate of the downloads stays at or under [HIGH_TRAFFIC_BYTES_PER_SEC] (4 Mbit/s, the
 *   desktop's agent reading, `offlineTrafficGate.ts`), however many objects are in flight.
 * - Held (STOR-BW-09): while a silo is saturated no object is requested.
 * - While an item downloads, the silo's report is re-read every [TRAFFIC_POLL_MS] (at most once a minute, like the desktop
 *   gate) whatever its state, so a high or saturated state that starts or ends mid-item is seen.
 */
object DownloadTrafficPolicy {
  const val HIGH_TRAFFIC_BYTES_PER_SEC = 500_000L
  const val TRAFFIC_POLL_MS = 60_000L

  /** The first retry of a download that failed for a cause that heals by itself (DECOM-02), and its cap. */
  private const val HEAL_BASE_MS = 60_000L
  private const val HEAL_MAX_MS = 30L * 60_000L

  /** A failure that heals by itself: a lost session / network, a refused token the app can renew. Never storage or space. */
  fun isHealable(errorCode: String?): Boolean =
    errorCode == DownloadErrorCode.AUTH || errorCode == DownloadErrorCode.NETWORK

  /** Delay before the [consecutiveFailures]-th automatic retry (1 = first): 1, 2, 4, 8, 16 min, then 30 min. */
  fun healDelayMs(consecutiveFailures: Int): Long {
    val n = (consecutiveFailures - 1).coerceIn(0, 20)
    return minOf(HEAL_MAX_MS, HEAL_BASE_MS shl n)
  }

  /**
   * An object read that went silent: the gateway holds an export flow's bytes while its silo is saturated, so a read
   * timeout is not a failed attempt then. The silo's own report decides.
   */
  fun isReadTimeout(e: Throwable): Boolean {
    var cur: Throwable? = e
    while (cur != null) {
      if (cur is java.net.SocketTimeoutException || cur is java.io.InterruptedIOException) return true
      cur = cur.cause
    }
    return false
  }
}

/**
 * Paces the downloads while the silo is high. [reserve] hands out time slots on one shared timeline of
 * `bytes / HIGH_TRAFFIC_BYTES_PER_SEC`, so the parallel fetches of an item together stay at the average rate; time spent
 * idle or held earns no credit for a later burst.
 */
class DownloadPacer(
  private val bytesPerSec: Long = DownloadTrafficPolicy.HIGH_TRAFFIC_BYTES_PER_SEC,
  private val now: () -> Long = System::currentTimeMillis,
) {
  private var nextFreeMs = 0L

  /** Milliseconds to wait before starting an object of [bytes]; 0 unless [slowed]. Reserves the slot. */
  @Synchronized
  fun reserve(bytes: Long, slowed: Boolean): Long {
    if (!slowed) return 0L
    val t = now()
    val start = maxOf(t, nextFreeMs)
    nextFreeMs = start + slotMs(bytes)
    return start - t
  }

  /** Books [bytes] already transferred (an object of unknown size) so the next one waits for it. */
  @Synchronized
  fun charge(bytes: Long, slowed: Boolean) {
    if (!slowed) return
    nextFreeMs = maxOf(now(), nextFreeMs) + slotMs(bytes)
  }

  private fun slotMs(bytes: Long): Long = if (bytes <= 0) 0L else (bytes * 1000L + bytesPerSec - 1) / bytesPerSec
}

