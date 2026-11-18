package com.spacefleet.mediaproxy

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

/**
 * A make-before-break rung switch on the proxy ([SegmentPrefetcher.beginSwitch]): the target's segment is fetched with the
 * link to itself while the old player plays on, and the old player's requests never compete with it.
 *
 * @req PLAY-ABR-04[badger-mobile]
 */
class SegmentPrefetcherSwitchTest {
  /** Records what is fetched and aborted; [fail] makes the prefetch of a key throw. */
  private class FakeFetcher(private val inFlight: List<String>) : ChunkFetcher {
    val prefetched = mutableListOf<String>()
    val aborted = mutableListOf<String>()
    var fail: String? = null

    override fun openObject(key: String): ObjectBody = throw UnsupportedOperationException(key)

    override fun prefetch(key: String) {
      synchronized(prefetched) { prefetched += key }
      if (key == fail) throw IOException("tunnel_download_failed: 502 key=$key")
    }

    override fun cancelInFlight(matches: (String) -> Boolean): Int {
      val hit = inFlight.filter(matches)
      aborted += hit
      return hit.size
    }

    override fun shutdown() {}
  }

  private fun track(prefix: String, count: Int, seconds: Double) =
    HlsTrack("$prefix/init", null, (0 until count).map { HlsSegment("$prefix/$it", seconds, null) })

  /** 1080p and 420p video in 20 s segments, one audio track in 10 s segments. */
  private val session = HlsSession(
    id = "s1",
    mode = "vod",
    videos = listOf(
      HlsVideoVariant("v1080", "1080p", 6000, 1920, 1080, track("v1080", 10, 20.0)),
      HlsVideoVariant("v420", "420p", 900, 746, 420, track("v420", 10, 20.0)),
    ),
    audio = listOf(HlsAudioVariant("a", "en", "English", true, track("a", 20, 10.0))),
  )

  /** The 1080p player is live at 60 s: it has read its segment 3 and the audio's segment 6. */
  private fun playing1080(fetcher: FakeFetcher, spawned: MutableList<Runnable>): SegmentPrefetcher {
    val prefetcher = SegmentPrefetcher(fetcher, { it.run() }, { spawned += it })
    prefetcher.register(session)
    prefetcher.onRequest("v1080/3")
    prefetcher.onRequest("a/6")
    fetcher.prefetched.clear()
    return prefetcher
  }

  @Test
  fun warmsTheTargetSegmentAndAbortsOnlyTheOtherVariantsFetches() {
    val fetcher = FakeFetcher(inFlight = listOf("v1080/4", "v1080/5", "v420/2", "a/7"))
    val spawned = mutableListOf<Runnable>()
    val prefetcher = playing1080(fetcher, spawned)
    val done = CompletableFuture<Throwable?>()

    assertTrue(prefetcher.beginSwitch("v420", 83.4) { done.complete(it) })
    println("switch: aborted=${fetcher.aborted} spawned=${spawned.size}")
    assertEquals(listOf("v1080/4", "v1080/5"), fetcher.aborted)
    // One fetch per thread of its own: the target's init, its segment at 83.4 s, the audio's two segments there.
    assertEquals(4, spawned.size)
    spawned.forEach { it.run() }
    println("warm fetched: ${fetcher.prefetched.sorted()}")
    assertEquals(listOf("a/8", "a/9", "v420/4", "v420/init"), fetcher.prefetched.sorted())
    assertNull(done.getNow(IllegalStateException("not done")))
  }

  @Test
  fun reportsTheFirstWarmFailureOnce() {
    val fetcher = FakeFetcher(inFlight = emptyList())
    val spawned = mutableListOf<Runnable>()
    val prefetcher = playing1080(fetcher, spawned)
    fetcher.fail = "v420/4"
    val reports = mutableListOf<Throwable?>()

    assertTrue(prefetcher.beginSwitch("v420", 83.4) { synchronized(reports) { reports += it } })
    spawned.forEach { it.run() }
    println("reports: ${reports.map { it?.message }}")
    assertEquals(1, reports.size)
    assertEquals("tunnel_download_failed: 502 key=v420/4", reports[0]?.message)
  }

  @Test
  fun refusesAVariantTheSessionDoesNotHave() {
    val prefetcher = playing1080(FakeFetcher(emptyList()), mutableListOf())
    var called = false
    assertFalse(prefetcher.beginSwitch("v2160", 10.0) { called = true })
    assertFalse(called)
    assertFalse(prefetcher.holdLeftBehind("v1080/4"))
  }

  @Test
  fun readsNoVideoAheadWhileTheSwitchIsPending() {
    val fetcher = FakeFetcher(emptyList())
    val prefetcher = playing1080(fetcher, mutableListOf())
    prefetcher.beginSwitch("v420", 83.4) {}
    fetcher.prefetched.clear()

    // The old player finishes writing a 1080p segment, then an audio one: neither pulls video read-ahead.
    prefetcher.onServed("v1080/3")
    prefetcher.onServed("a/6")
    println("read-ahead while pending: ${fetcher.prefetched}")
    assertTrue(fetcher.prefetched.none { it.startsWith("v") })
    assertTrue(fetcher.prefetched.isNotEmpty())
  }

  @Test
  fun parksTheOldPlayersVideoRequestUntilTheNewPlayerReadsTheTarget() {
    val prefetcher = playing1080(FakeFetcher(emptyList()), mutableListOf())
    prefetcher.beginSwitch("v420", 83.4) {}

    // Audio and the target are served as usual.
    assertFalse(prefetcher.holdLeftBehind("a/7"))
    assertFalse(prefetcher.holdLeftBehind("v420/4"))

    val parked = CompletableFuture.supplyAsync { prefetcher.holdLeftBehind("v1080/4") }
    Thread.sleep(200)
    assertFalse("the old player's request waits while the warm runs", parked.isDone)
    // The reload: the new player's first request is the target's init.
    prefetcher.onRequest("v420/init")
    val dropped = parked.get(5, TimeUnit.SECONDS)
    println("parked request after the reload: dropped=$dropped")
    assertTrue(dropped)
    // The switch is over: nothing parks any more, and the target reads ahead.
    assertFalse(prefetcher.holdLeftBehind("v1080/5"))
  }

  @Test
  fun aSupersededSwitchLetsTheOldPlayersParkedRequestThrough() {
    val prefetcher = playing1080(FakeFetcher(emptyList()), mutableListOf())
    prefetcher.beginSwitch("v420", 83.4) {}
    val parked = CompletableFuture.supplyAsync { prefetcher.holdLeftBehind("v1080/4") }
    Thread.sleep(200)

    // Before any reload, the switch is turned back to the rung the player is on: its request is fetched after all.
    prefetcher.beginSwitch("v1080", 83.4) {}
    val dropped = parked.get(5, TimeUnit.SECONDS)
    println("parked request after the switch back: dropped=$dropped")
    assertFalse(dropped)
    assertFalse(prefetcher.holdLeftBehind("v1080/5"))
  }

  @Test
  fun aNewSessionEndsThePendingSwitch() {
    val prefetcher = playing1080(FakeFetcher(emptyList()), mutableListOf())
    prefetcher.beginSwitch("v420", 83.4) {}
    prefetcher.register(session)
    assertFalse(prefetcher.holdLeftBehind("v1080/4"))
  }
}
