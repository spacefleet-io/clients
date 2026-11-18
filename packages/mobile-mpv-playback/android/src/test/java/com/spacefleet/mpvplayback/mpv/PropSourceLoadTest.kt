package com.spacefleet.mpvplayback.mpv

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * @req PLAY-OSMEDIA-01[badger-mobile]
 * @bugfix @regression-proof
 *
 * Found on a OnePlus 9 (2026-11-11, PR #1762): Previous pressed on the lock screen mounted a new player and dropped it
 * 50 ms later; the `source` prop posted to the dropped view then ran `loadfile` on the freed core ("libmpv is not
 * initialized") and the app process exited. A dropped view must never reach libmpv.
 */
class PropSourceLoadTest {
  private val log = mutableListOf<String>()

  private class FakeView(private val alreadyLoaded: String? = null) : PropSourceTarget {
    override fun takePropSource(source: String) = source != alreadyLoaded
  }

  private fun run(source: String, view: FakeView, engineLoads: MutableList<String>?): Boolean {
    val result = PropSourceLoad.run(source, view, engineLoads?.let { loads -> { s: String -> loads += s } }) { log += it }
    println("source=$source engine=${engineLoads != null} result=$result engineLoads=$engineLoads log=$log")
    return result
  }

  @Test
  fun `a live view loads through its engine`() {
    val view = FakeView()
    val engineLoads = mutableListOf<String>()
    assertTrue(run("http://e01.m3u8", view, engineLoads))
    assertEquals(listOf("http://e01.m3u8"), engineLoads)
    assertEquals(emptyList<String>(), log)
  }

  @Test
  fun `a dropped view never loads, so the freed core is never called`() {
    val view = FakeView()
    assertFalse(run("http://e01.m3u8", view, null))
    // Nothing else can reach libmpv from here: the only load path is the engine, and there is none.
    assertEquals(listOf("source.skipped_dropped_view: http://e01.m3u8"), log)
  }

  @Test
  fun `a source already loaded in the background is not loaded twice`() {
    val view = FakeView(alreadyLoaded = "http://e02.m3u8")
    val engineLoads = mutableListOf<String>()
    assertFalse(run("http://e02.m3u8", view, engineLoads))
    assertEquals(emptyList<String>(), engineLoads)
  }
}
