package com.spacefleet.mediaproxy

import android.util.Log
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Keeps the openings of the songs around the playing one ready, so Next and Previous start at once, without ever taking
 * the connection from the playing song (PAR-PLAY-07). JS names the playing, next and previous queue entries
 * ([setNeighbours], after the next song's copy is settled); the server wraps every player read of a chunk in [playerRead].
 *
 * One worker thread loads one opening at a time, only when [PreloadGate.waitMs] allows (no player read for
 * [PreloadGate.QUIET_MS]); a player read of another object cancels it at once ([PreloadGate.yields]) and it is loaded again
 * after the next quiet period. The three openings are pinned in the fetcher's cache. The entries' chunk keys are read with
 * [peek], which leaves a song's copy open to the swap that settles it (PAR-PLAY-04): loading ahead is never the player
 * asking. A kept song's opening goes to the fetcher like any other and comes from disk ([OfflineChunkFetcher.prefetch]).
 * Port: `ios/Proxy/NeighbourPreloader.swift`; change them together.
 */
class NeighbourPreloader(
  private val fetcher: ChunkFetcher,
  /** The file registered at a queue entry's id now, without fixing it (see [ChunkedFileRegistry.peek]). */
  private val peek: (String) -> ChunkedFile?,
  private val quietMs: Long = PreloadGate.QUIET_MS,
  private val clock: () -> Long = { System.nanoTime() / 1_000_000 },
) {
  private val lock = ReentrantLock()
  private val changed = lock.newCondition()
  private var current: String? = null
  private var next: String? = null
  private var previous: String? = null
  private var trafficHigh = false
  private var bufferCapped = false
  /** Player reads running now. */
  private var readCount = 0
  private var lastReadEndMs = 0L
  /** The object the worker is loading, null when none. */
  private var loading: String? = null
  private var loadingYielded = false
  /** Objects loaded (or failed) for the current neighbours: not tried again until they change. */
  private val done = HashSet<String>()
  private var lastPins: Set<String> = emptySet()
  private var running = true
  private val worker = Thread({ loop() }, "PlaybackHttp-preload").apply {
    isDaemon = true
    priority = Thread.MIN_PRIORITY
    start()
  }

  /** The playing, next and previous queue entries (registered chunked-file ids); null where there is none. */
  fun setNeighbours(current: String?, next: String?, previous: String?) {
    lock.withLock {
      if (current == this.current && next == this.next && previous == this.previous) return
      // A new playing song is about to be read from its start: its quiet period starts now, not at the last song's reads.
      if (current != this.current) lastReadEndMs = clock()
      this.current = current
      this.next = next
      this.previous = previous
      done.clear()
      Log.i(TAG, "preload.neighbours current=$current next=$next previous=$previous")
      changed.signalAll()
    }
  }

  /** The silo's high-traffic state (STOR-BW-01), heard by the tunnel. */
  fun setTrafficHigh(high: Boolean) = setCapped { trafficHigh = high }

  /** The high-traffic buffer cap JS set ([PlaybackHttpServer.setBufferCap]); a positive cap counts as high traffic. */
  fun setBufferCap(seconds: Double) = setCapped { bufferCapped = seconds > 0 && seconds.isFinite() }

  private fun setCapped(change: () -> Unit) {
    lock.withLock {
      val before = trafficHigh || bufferCapped
      change()
      val after = trafficHigh || bufferCapped
      if (before == after) return
      Log.i(TAG, "preload.capped capped=$after")
      changed.signalAll()
    }
  }

  /** Runs one player read of [key] (a chunk the player asked for, or the server's read-ahead for it) as a player read. */
  fun <T> playerRead(key: String, block: () -> T): T {
    beginRead(key)
    try {
      return block()
    } finally {
      endRead()
    }
  }

  private fun beginRead(key: String) {
    val cut = lock.withLock {
      readCount += 1
      val load = loading
      if (PreloadGate.yields(load, key) && !loadingYielded) {
        loadingYielded = true
        load
      } else {
        null
      }
    } ?: return
    val aborted = fetcher.cancelInFlight { it == cut }
    Log.i(TAG, "preload.yield key=$cut for=$key aborted=$aborted")
  }

  private fun endRead() {
    lock.withLock {
      readCount -= 1
      lastReadEndMs = clock()
      if (readCount == 0) changed.signalAll()
    }
  }

  fun stop() {
    lock.withLock {
      running = false
      changed.signalAll()
    }
    worker.interrupt()
  }

  private fun loop() {
    while (true) {
      val key = try {
        awaitTarget() ?: return
      } catch (_: InterruptedException) {
        return
      }
      val startMs = clock()
      Log.i(TAG, "preload.start key=$key")
      try {
        fetcher.prefetch(key)
        lock.withLock {
          if (loadingYielded) {
            // The player read something else while this ran but the fetch was past cancelling: it is loaded all the same.
            Log.i(TAG, "preload.done_after_yield key=$key elapsedMs=${clock() - startMs}")
          } else {
            Log.i(TAG, "preload.done key=$key elapsedMs=${clock() - startMs}")
          }
          done.add(key)
        }
      } catch (e: Throwable) {
        lock.withLock {
          if (loadingYielded) {
            Log.i(TAG, "preload.dropped key=$key elapsedMs=${clock() - startMs} (loaded again after the next quiet period)")
          } else {
            done.add(key)
            Log.w(TAG, "preload.failed key=$key elapsedMs=${clock() - startMs} msg=${e.message}")
          }
        }
      } finally {
        lock.withLock {
          loading = null
          loadingYielded = false
        }
      }
    }
  }

  /** Blocks until an opening may load now and returns its key (marked [loading]); null once stopped. */
  private fun awaitTarget(): String? {
    lock.withLock {
      while (running) {
        val nextOpening = PreloadGate.opening(next?.let(peek))
        val previousOpening = PreloadGate.opening(previous?.let(peek))
        val pins = PreloadGate.pinned(PreloadGate.opening(current?.let(peek)), nextOpening, previousOpening)
        if (pins != lastPins) {
          lastPins = pins
          fetcher.pin(pins)
        }
        val target = PreloadGate.targets(nextOpening, previousOpening, trafficHigh || bufferCapped).firstOrNull { it !in done }
        if (target == null) {
          // Looked at again now and then: a swap that settles an entry's copy changes its opening without telling us.
          changed.await(quietMs, TimeUnit.MILLISECONDS)
          continue
        }
        val wait = PreloadGate.waitMs(readCount, lastReadEndMs, clock(), quietMs)
        when {
          wait == null -> changed.await()
          wait > 0 -> changed.await(wait, TimeUnit.MILLISECONDS)
          else -> {
            loading = target
            loadingYielded = false
            return target
          }
        }
      }
      return null
    }
  }

  companion object {
    private const val TAG = "NeighbourPreloader"
  }
}
