package com.spacefleet.mediaproxy

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * @req PAR-PLAY-04[parrot]
 *
 * Parrot's phone settles which copy of a queued song plays (the original or the light copy, PAR-PLAY-02) by swapping the
 * file behind the song's proxy id. Once the player has asked for that id, the song is playing: a swap then must be
 * refused, so a song never changes copy midway (PAR-PLAY-04).
 */
class ChunkedFileRegistryTest {
  private fun log(msg: String) = println("[chunked-file-registry-test] $msg")

  private fun copy(id: String, mime: String, size: Long) = ChunkedFile(id, mime, size, listOf(ChunkRef("library/chunks/$mime-$size", 0, size)))

  private val original = copy("tr-nook~1", "audio/flac", 30_000_000)
  private val light = copy("tr-nook~1", "audio/ogg; codecs=opus", 1_500_000)

  @Test
  fun swapsTheCopyUntilThePlayerAsksForTheSong() {
    val registry = ChunkedFileRegistry()
    registry.register(original)
    val swapped = registry.swap(light)
    val served = registry.serve(original.id)
    log("swap before the player asked: swapped=$swapped served=${served?.mime}")
    assertTrue(swapped)
    assertEquals("audio/ogg; codecs=opus", served?.mime)
  }

  @Test
  fun neverSwapsASongThePlayerAlreadyAskedFor() {
    val registry = ChunkedFileRegistry()
    registry.register(original)
    assertEquals("audio/flac", registry.serve(original.id)?.mime)
    val swapped = registry.swap(light)
    val served = registry.serve(original.id)
    log("swap after the player asked: swapped=$swapped served=${served?.mime}")
    assertFalse(swapped)
    assertEquals("audio/flac", served?.mime)
  }

  @Test
  fun registeringAgainOpensTheIdAndUnknownIdsAreNeverSwapped() {
    val registry = ChunkedFileRegistry()
    assertFalse("an id never registered is not created by a swap", registry.swap(light))
    assertNull(registry.serve(light.id))
    registry.register(original)
    registry.serve(original.id)
    registry.register(original) // a new queue registers the song again: it has not started in that queue
    assertTrue(registry.swap(light))
    assertTrue(registry.unregister(original.id))
    assertFalse(registry.swap(light))
    log("re-register, unregister: ok")
  }
}
