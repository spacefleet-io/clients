package com.spacefleet.mediaproxy

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The cast server answers only the objects of its own session (UX-TV-03): what [LanAllowList] lets through. */
class LanAllowListTest {
  private fun track(init: String, vararg segments: String) =
    HlsTrack(init, null, segments.map { HlsSegment(it, 4.0, null) })

  private fun session(subtitles: List<HlsSubtitleVariant> = emptyList()) = HlsSession(
    id = "s1",
    mode = "vod",
    videos = listOf(HlsVideoVariant("v", "1080p", null, 1920, 1080, track("video/init.mp4", "video/0.m4s", "video/1.m4s"))),
    audio = listOf(HlsAudioVariant("a", "en", "English", true, track("audio/init.mp4", "audio/0.m4s"))),
    subtitles = subtitles,
  )

  private fun subtitle(key: String, format: String = "vtt") = HlsSubtitleVariant("s", "en", "English", true, format, key, 0.0)

  @Test
  fun allowsTheInitAndMediaSegmentsOfEveryVersionAndTheSubtitleObject() {
    val keys = LanAllowList.keysOf(session(listOf(subtitle("subs/en.vtt"))))
    assertEquals(
      setOf("video/init.mp4", "video/0.m4s", "video/1.m4s", "audio/init.mp4", "audio/0.m4s", "subs/en.vtt"),
      keys,
    )
  }

  @Test
  fun refusesAKeyThatIsNotInTheSession() {
    val keys = LanAllowList.keysOf(session())
    assertFalse("other-title/0.m4s" in keys)
    assertFalse("../video/0.m4s" in keys)
    assertTrue("video/0.m4s" in keys)
  }

  @Test
  fun skipsEmptyKeysSoAnEmptyRequestPathIsNeverAllowed() {
    val noInit = HlsSession(
      id = "s2",
      mode = "vod",
      videos = listOf(HlsVideoVariant("v", "1080p", null, null, null, track("", "video/0.m4s"))),
      audio = emptyList(),
      subtitles = listOf(subtitle("")),
    )
    assertEquals(setOf("video/0.m4s"), LanAllowList.keysOf(noInit))
  }
}
