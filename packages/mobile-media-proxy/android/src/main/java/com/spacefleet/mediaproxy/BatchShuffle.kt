package com.spacefleet.mediaproxy

import java.security.SecureRandom

/**
 * Order of one look-ahead batch (PRIV-ENC-05): the blocks a playback client is about to fetch are requested in a shuffled
 * order that mixes audio and video, so the rhythm of the requests does not tell the storage servers which block is which.
 *
 * Fisher-Yates, driven by [nextInt] (`nextInt(n)` returns an integer in `0 until n`). The algorithm is mirrored in
 * `ios/Proxy/BatchShuffle.swift` (MediaProxy pod): change them together.
 */
internal object BatchShuffle {
  private val secure = SecureRandom()

  /** Production source of randomness: unpredictable, so an observer cannot undo the shuffle. */
  val systemNextInt: (Int) -> Int = { bound -> secure.nextInt(bound) }

  /** [items] in shuffled order; [items] itself is not modified. */
  fun <T> shuffled(items: List<T>, nextInt: (Int) -> Int): List<T> {
    val out = items.toMutableList()
    for (i in out.size - 1 downTo 1) {
      val j = nextInt(i + 1)
      val tmp = out[i]
      out[i] = out[j]
      out[j] = tmp
    }
    return out
  }
}
