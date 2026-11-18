package com.spacefleet.mediaproxy

/**
 * The storage object keys a cast server may hand out (UX-TV-03). The one-time token only proves the caller was given the
 * cast address; behind it the server still holds the user's tunnel credentials and the library key, so it answers
 * `/playback/object/<key>` for the keys of the one session it was started with and nothing else: the init segment and the
 * segments of the video and audio versions the session lists, and the subtitle objects. Texts the cast flow registers with
 * `putText` are allowed by the server itself.
 */
internal object LanAllowList {
  fun keysOf(session: HlsSession): Set<String> {
    val keys = HashSet<String>()
    for (track in session.videos.map { it.track } + session.audio.map { it.track }) {
      if (track.initKey.isNotEmpty()) keys.add(track.initKey)
      for (segment in track.segments) keys.add(segment.key)
    }
    for (subtitle in session.subtitles) if (subtitle.objectKey.isNotEmpty()) keys.add(subtitle.objectKey)
    return keys
  }
}
