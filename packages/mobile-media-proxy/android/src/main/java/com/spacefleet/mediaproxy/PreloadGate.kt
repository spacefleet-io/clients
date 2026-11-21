package com.spacefleet.mediaproxy

/**
 * When and what the proxy loads ahead for the songs around the playing one (PAR-PLAY-07). Pure: [NeighbourPreloader] feeds
 * it what the proxy sees. Port: `ios/Proxy/NeighbourPreloader.swift` `PreloadGate`; change them together.
 *
 * The player's own reads always come first. A player asks the proxy for audio only while its buffer is below its target
 * (Media3's `DefaultLoadControl` keeps 50 s, AVPlayer its own forward buffer), so the proxy taking no player read for
 * [QUIET_MS] means the playing song's buffer is full: only then may an opening load. The moment the player reads again,
 * a loading opening of another object is dropped ([yields]) so the two never share the connection.
 */
object PreloadGate {
  /** How long no player read must have run before an opening loads. */
  const val QUIET_MS = 1_000L

  /** Chunks of a song's opening: one 1 MiB chunk is several seconds of any copy, and the proxy reads the next chunk as soon as the first is served. */
  const val OPENING_CHUNKS = 1

  /**
   * How long to wait before loading: null while a player read runs (asked again when it ends), else the time left of the
   * quiet period since the last player read ended, 0 when it is over.
   */
  fun waitMs(playerReads: Int, lastPlayerReadEndMs: Long, nowMs: Long, quietMs: Long = QUIET_MS): Long? {
    if (playerReads > 0) return null
    return maxOf(0L, lastPlayerReadEndMs + quietMs - nowMs)
  }

  /**
   * The objects to load, in order: the next song's opening first (the likelier press), then the previous song's, which is
   * normally still cached from when it played and then costs nothing. Under a high-traffic cap (STOR-BW-01) the next
   * song's opening is not loaded: the silo's playback buffer is the playing song's whole budget.
   */
  fun targets(nextOpening: List<String>, previousOpening: List<String>, capped: Boolean): List<String> =
    ((if (capped) emptyList() else nextOpening) + previousOpening).distinct()

  /** The objects the cache keeps whatever else is fetched: the openings of the playing, next and previous songs. */
  fun pinned(currentOpening: List<String>, nextOpening: List<String>, previousOpening: List<String>): Set<String> =
    (currentOpening + nextOpening + previousOpening).toSet()

  /** True when a player read of [playerKey] must cut the loading of [loadingKey]; the player taking that very object adopts the load instead. */
  fun yields(loadingKey: String?, playerKey: String): Boolean = loadingKey != null && loadingKey != playerKey

  /** The object keys of [file]'s opening. */
  fun opening(file: ChunkedFile?): List<String> = file?.chunks?.take(OPENING_CHUNKS)?.map { it.objectKey } ?: emptyList()
}
