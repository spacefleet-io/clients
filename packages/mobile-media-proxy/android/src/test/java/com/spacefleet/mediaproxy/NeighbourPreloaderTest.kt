package com.spacefleet.mediaproxy

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * @req PAR-PLAY-07[parrot]
 *
 * The proxy keeps the openings of the next and previous songs ready so Next and Previous start at once, and never lets
 * that loading take the connection from the playing song: it loads only after the player read nothing for a quiet
 * period, drops a load the moment the player reads something else, loads no next opening under a high-traffic cap, and
 * never fixes a song's copy by loading it (PAR-PLAY-04).
 */
class NeighbourPreloaderTest {
  private fun log(msg: String) = println("[neighbour-preloader-test] $msg")

  private val quietMs = 150L

  private fun song(id: String, chunks: Int) =
    ChunkedFile(id, "audio/flac", chunks * 100L, (0 until chunks).map { ChunkRef("$id/c$it", it * 100L, 100L) })

  /** A fetcher whose prefetches of [blocking] keys hang until cancelled (or [release]d), recording everything asked of it. */
  private class FakeFetcher(private val blocking: Set<String> = emptySet()) : ChunkFetcher {
    val prefetched: MutableList<String> = Collections.synchronizedList(mutableListOf<String>())
    val cancelled: MutableList<String> = Collections.synchronizedList(mutableListOf<String>())
    @Volatile var pins: Set<String> = emptySet()
    private val gates = HashMap<String, CountDownLatch>()
    @Volatile private var failed = HashSet<String>()
    val started = CountDownLatch(1)

    @Synchronized private fun gate(key: String) = gates.getOrPut(key) { CountDownLatch(1) }

    override fun openObject(key: String): ObjectBody = throw UnsupportedOperationException()

    override fun prefetch(key: String) {
      prefetched.add(key)
      if (key in blocking && prefetched.count { it == key } == 1) {
        started.countDown()
        gate(key).await(5, TimeUnit.SECONDS)
        if (key in failed) throw java.io.IOException("Canceled")
      }
    }

    override fun cancelInFlight(matches: (String) -> Boolean): Int {
      var n = 0
      for (key in blocking) {
        if (!matches(key)) continue
        cancelled.add(key)
        failed.add(key)
        gate(key).countDown()
        n += 1
      }
      return n
    }

    fun release(key: String) = gate(key).countDown()

    override fun pin(keys: Set<String>) {
      pins = keys
    }

    override fun shutdown() {}
  }

  private val preloaders = mutableListOf<NeighbourPreloader>()

  private fun preloader(fetcher: ChunkFetcher, registry: ChunkedFileRegistry) =
    NeighbourPreloader(fetcher, registry::peek, quietMs = quietMs).also { preloaders.add(it) }

  @After
  fun stopAll() = preloaders.forEach { it.stop() }

  private fun waitUntil(what: String, timeoutMs: Long = 3_000, check: () -> Boolean) {
    val until = System.currentTimeMillis() + timeoutMs
    while (!check()) {
      if (System.currentTimeMillis() > until) throw AssertionError("timed out waiting for $what")
      Thread.sleep(10)
    }
  }

  private fun registry(vararg files: ChunkedFile) = ChunkedFileRegistry().apply { files.forEach { register(it) } }

  @Test
  fun loadsTheNextOpeningThenThePreviousOnlyOnceThePlayerIsQuiet() {
    log("phase: setup (playing b, next c, previous a)")
    val fetcher = FakeFetcher()
    val p = preloader(fetcher, registry(song("a", 3), song("b", 3), song("c", 3)))
    val reading = CountDownLatch(1)
    val player = Thread { p.playerRead("b/c0") { reading.await(5, TimeUnit.SECONDS) } }.apply { start() }
    Thread.sleep(50)
    p.setNeighbours("b", "c", "a")
    log("phase: a player read of the playing song runs for 400 ms")
    Thread.sleep(400)
    log("while the player reads: prefetched=${fetcher.prefetched}")
    assertTrue("nothing may load while the player reads", fetcher.prefetched.isEmpty())
    val endedAt = System.currentTimeMillis()
    reading.countDown()
    player.join()
    waitUntil("both openings") { fetcher.prefetched.size == 2 }
    val waited = System.currentTimeMillis() - endedAt
    log("after the read: prefetched=${fetcher.prefetched} waitedMs=$waited pins=${fetcher.pins}")
    assertEquals(listOf("c/c0", "a/c0"), fetcher.prefetched.toList())
    assertTrue("loads only after the quiet period (waited $waited ms)", waited >= quietMs - 20)
    assertEquals(setOf("a/c0", "b/c0", "c/c0"), fetcher.pins)
    Thread.sleep(300)
    assertEquals("each opening loads once", 2, fetcher.prefetched.size)
  }

  @Test
  fun dropsTheLoadTheMomentThePlayerReadsAnotherObjectAndLoadsItAgainLater() {
    log("phase: setup, the next opening hangs on the network")
    val fetcher = FakeFetcher(blocking = setOf("c/c0"))
    val p = preloader(fetcher, registry(song("b", 3), song("c", 3)))
    p.setNeighbours("b", "c", null)
    assertTrue("the load started", fetcher.started.await(3, TimeUnit.SECONDS))
    log("phase: the playing song needs its next chunk")
    val readStart = System.currentTimeMillis()
    p.playerRead("b/c2") { log("player read b/c2 runs; cancelled=${fetcher.cancelled}") }
    log("player read took ${System.currentTimeMillis() - readStart} ms; cancelled=${fetcher.cancelled}")
    assertEquals(listOf("c/c0"), fetcher.cancelled.toList())
    waitUntil("the opening loaded again") { fetcher.prefetched.count { it == "c/c0" } == 2 }
    log("phase: loaded again after the quiet period: prefetched=${fetcher.prefetched}")
  }

  @Test
  fun thePlayerAskingForTheLoadingObjectAdoptsItInsteadOfCancellingIt() {
    log("phase: setup, the next opening hangs on the network")
    val fetcher = FakeFetcher(blocking = setOf("c/c0"))
    val p = preloader(fetcher, registry(song("b", 3), song("c", 3)))
    p.setNeighbours("b", "c", null)
    assertTrue(fetcher.started.await(3, TimeUnit.SECONDS))
    log("phase: Next pressed, the player reads the next song's first chunk")
    p.playerRead("c/c0") { fetcher.release("c/c0") }
    Thread.sleep(300)
    log("cancelled=${fetcher.cancelled} prefetched=${fetcher.prefetched}")
    assertTrue("the player's own object is never cancelled", fetcher.cancelled.isEmpty())
    assertEquals(1, fetcher.prefetched.count { it == "c/c0" })
  }

  @Test
  fun underAHighTrafficCapOnlyThePreviousOpeningLoads() {
    val fetcher = FakeFetcher()
    val p = preloader(fetcher, registry(song("a", 2), song("b", 2), song("c", 2)))
    p.setTrafficHigh(true)
    p.setNeighbours("b", "c", "a")
    waitUntil("previous opening") { fetcher.prefetched.isNotEmpty() }
    Thread.sleep(300)
    log("capped: prefetched=${fetcher.prefetched} pins=${fetcher.pins}")
    assertEquals(listOf("a/c0"), fetcher.prefetched.toList())
    log("phase: traffic normal again")
    p.setTrafficHigh(false)
    waitUntil("next opening") { "c/c0" in fetcher.prefetched }
    log("normal: prefetched=${fetcher.prefetched}")
  }

  @Test
  fun aQueueChangeRetargetsTheLoad() {
    val fetcher = FakeFetcher()
    val p = preloader(fetcher, registry(song("b", 2), song("c", 2), song("d", 2)))
    p.setNeighbours("b", "c", null)
    waitUntil("c") { "c/c0" in fetcher.prefetched }
    log("phase: shuffle makes d the next song")
    p.setNeighbours("b", "d", null)
    waitUntil("d") { "d/c0" in fetcher.prefetched }
    log("retargeted: prefetched=${fetcher.prefetched} pins=${fetcher.pins}")
    assertEquals(setOf("b/c0", "d/c0"), fetcher.pins)
  }

  @Test
  fun loadingAheadNeverFixesTheSongsCopy() {
    val fetcher = FakeFetcher()
    val reg = registry(song("b", 2), song("c", 2))
    val p = preloader(fetcher, reg)
    p.setNeighbours("b", "c", null)
    waitUntil("c") { "c/c0" in fetcher.prefetched }
    val light = ChunkedFile("c", "audio/ogg", 50L, listOf(ChunkRef("c-light/c0", 0, 50L)))
    val swapped = reg.swap(light)
    log("swap after loading ahead: swapped=$swapped")
    assertTrue("the copy is still open to the settling swap (PAR-PLAY-04)", swapped)
    waitUntil("the swapped copy's opening") { "c-light/c0" in fetcher.prefetched }
    log("after the swap: prefetched=${fetcher.prefetched}")
  }

  @Test
  fun aNewPlayingSongGetsItsQuietPeriodBeforeAnythingLoads() {
    log("phase: the app starts a song; its player read has not begun yet")
    val fetcher = FakeFetcher()
    val p = preloader(fetcher, registry(song("b", 2), song("c", 2)))
    val setAt = System.currentTimeMillis()
    p.setNeighbours("b", "c", null)
    Thread.sleep(quietMs / 2)
    log("half the quiet period later: prefetched=${fetcher.prefetched}")
    assertTrue("nothing loads before the new song's player read had its chance", fetcher.prefetched.isEmpty())
    waitUntil("c") { "c/c0" in fetcher.prefetched }
    val waited = System.currentTimeMillis() - setAt
    log("loaded after ${waited} ms")
    assertTrue("waited the quiet period ($waited ms)", waited >= quietMs - 20)
  }

  @Test
  fun gateRules() {
    assertNull(PreloadGate.waitMs(playerReads = 1, lastPlayerReadEndMs = 0, nowMs = 10_000))
    assertEquals(600L, PreloadGate.waitMs(playerReads = 0, lastPlayerReadEndMs = 1_000, nowMs = 1_400))
    assertEquals(0L, PreloadGate.waitMs(playerReads = 0, lastPlayerReadEndMs = 1_000, nowMs = 2_400))
    assertEquals(listOf("n", "p"), PreloadGate.targets(listOf("n"), listOf("p"), capped = false))
    assertEquals(listOf("p"), PreloadGate.targets(listOf("n"), listOf("p"), capped = true))
    assertTrue(PreloadGate.yields("n", "x"))
    assertFalse(PreloadGate.yields("n", "n"))
    assertFalse(PreloadGate.yields(null, "x"))
    assertEquals(listOf("s/c0"), PreloadGate.opening(song("s", 4)))
    assertTrue(PreloadGate.opening(null).isEmpty())
  }
}
