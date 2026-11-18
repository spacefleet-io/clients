package com.spacefleet.mediaproxy

import java.util.Locale
import kotlin.math.ceil
import kotlin.math.max

/**
 * HLS playlist generator. Emits a master playlist with all video variants,
 * audio renditions, and subtitle renditions, plus the per-variant media
 * playlists. mpv's `vid`/`aid`/`sid` properties pick the active rendition
 * at runtime — no server-side filtering required.
 *
 * Multi-track shape:
 * - [HlsSession.videos] — one EXT-X-STREAM-INF per entry (1080p / 720p / …);
 *   mpv usually picks the highest-bandwidth, JS cycle button forces
 *   alternates via `MPVLib.setPropertyInt("vid", id)`.
 * - [HlsSession.audio] — one EXT-X-MEDIA TYPE=AUDIO,GROUP-ID="audio" per
 *   rendition; switched at runtime via the `aid` property. When this list
 *   is empty (muxed-fmp4 source), we omit EXT-X-MEDIA and the
 *   `AUDIO="audio"` STREAM-INF attribute — exposing a separate audio
 *   rendition group when none exists is what triggered the lavf
 *   rendition-imbalance lock on older libmpv builds.
 * - [HlsSession.subtitles] — VTT entries get an EXT-X-MEDIA TYPE=SUBTITLES,
 *   GROUP-ID="subs" line in the master so lavf's HLS demuxer can discover
 *   them. PGS (HDMV bitmap) subs are intentionally NOT advertised in the
 *   master — lavf's HLS demuxer can't load them via a TYPE=SUBTITLES
 *   rendition. JS loads PGS (and re-loads VTT) sidecar via mpv's `sub-add`
 *   pointed at `/playback/object/{key}` directly, so subtitle cycling is
 *   format-agnostic on the JS side.
 */

data class HlsSegment(
  val key: String,
  val durationSeconds: Double,
  val startSeconds: Double?,
)

data class HlsTrack(
  val initKey: String,
  val codecString: String?,
  val segments: List<HlsSegment>,
)

data class HlsVideoVariant(
  val id: String,
  val quality: String,
  val bitrateKbps: Int?,
  val width: Int?,
  val height: Int?,
  val track: HlsTrack,
)

data class HlsAudioVariant(
  val id: String,
  val language: String,
  val label: String,
  val isDefault: Boolean,
  val track: HlsTrack,
)

/**
 * Subtitle rendition. [objectKey] is the storage object key of the subtitle
 * file. [format] is `"vtt"` (text WebVTT), `"pgs"` (HDMV PGS bitmap from a
 * `.sup` file) or `"vobsub"` (DVD/VobSub bitmap muxed into a matroska `.mkv`).
 *
 * VTT subs are advertised in the HLS master as `EXT-X-MEDIA TYPE=SUBTITLES`
 * renditions AND loaded sidecar via `sub-add`. PGS subs are NOT in the HLS
 * master (lavf's HLS demuxer can't carry PGS in a TYPE=SUBTITLES rendition)
 * — they're loaded sidecar only. Both flow through the same JS UI: the
 * cycle handler calls `MpvControl.addSubtitle(<proxy-url>)` and mpv's
 * libavcodec decodes whichever codec matches the file's content.
 */
data class HlsSubtitleVariant(
  val id: String,
  val language: String,
  val label: String,
  val isDefault: Boolean,
  val format: String,
  val objectKey: String,
  val durationSeconds: Double,
)

data class HlsSession(
  val id: String,
  val mode: String, // "vod" or "event"
  val videos: List<HlsVideoVariant>,
  val audio: List<HlsAudioVariant>,
  val subtitles: List<HlsSubtitleVariant> = emptyList(),
)

object PlaylistBuilder {
  private fun urlEncode(s: String): String =
    java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20")

  private fun buildHlsHeader(mode: String, targetDuration: Double): MutableList<String> {
    val lines = mutableListOf(
      "#EXTM3U",
      "#EXT-X-VERSION:7",
      "#EXT-X-INDEPENDENT-SEGMENTS",
      "#EXT-X-TARGETDURATION:${max(1, ceil(targetDuration).toInt())}",
      "#EXT-X-MEDIA-SEQUENCE:0",
    )
    lines.add(if (mode == "event") "#EXT-X-PLAYLIST-TYPE:EVENT" else "#EXT-X-PLAYLIST-TYPE:VOD")
    return lines
  }

  /**
   * Build a media playlist (video or audio variant) listing every segment
   * with its EXTINF duration. Single init segment via EXT-X-MAP.
   */
  fun buildTrackPlaylist(
    track: HlsTrack,
    baseUrl: String,
    mode: String,
  ): String {
    val segments = track.segments
    val targetDuration = if (segments.isNotEmpty()) segments.maxOf { it.durationSeconds } else 1.0
    val lines = buildHlsHeader(mode, targetDuration)
    lines.add("#EXT-X-MAP:URI=\"$baseUrl/playback/object/${urlEncode(track.initKey)}\"")
    segments.forEach { seg ->
      lines.add("#EXTINF:${"%.3f".format(Locale.ROOT, seg.durationSeconds)},")
      lines.add("$baseUrl/playback/object/${urlEncode(seg.key)}")
    }
    if (mode == "vod") {
      lines.add("#EXT-X-ENDLIST")
    }
    return lines.joinToString("\n") + "\n"
  }

  /**
   * Single-segment subtitle media playlist for a WebVTT file. mpv's lavf
   * HLS demuxer accepts a one-EXTINF playlist that points at a .vtt and
   * loads the whole file at once. Only valid for vtt — PGS subs are not
   * referenced from the master, so this path is never hit for them.
   */
  fun buildSubtitlePlaylist(
    sub: HlsSubtitleVariant,
    baseUrl: String,
    mode: String,
  ): String {
    require(sub.format == "vtt") { "buildSubtitlePlaylist called for non-vtt format=${sub.format}" }
    val duration = if (sub.durationSeconds > 0) sub.durationSeconds else 1.0
    val lines = buildHlsHeader(mode, duration)
    lines.add("#EXTINF:${"%.3f".format(Locale.ROOT, duration)},")
    lines.add("$baseUrl/playback/object/${urlEncode(sub.objectKey)}")
    if (mode == "vod") {
      lines.add("#EXT-X-ENDLIST")
    }
    return lines.joinToString("\n") + "\n"
  }

  /**
   * Build the master playlist with all video variants, audio renditions,
   * and subtitle renditions emitted. mpv's `aid`/`sid` properties pick which
   * audio/subtitle rendition is active.
   *
   * Video: lavf's HLS demuxer exposes ONE video track per master (the
   * highest-bandwidth variant), so `vid` cannot switch rungs. The app picks a
   * rung by loading `master-{videoId}.m3u8` ([onlyVideoId] set): that variant
   * plus every audio/subtitle rendition.
   *
   * Muxed mode: when [HlsSession.audio] is empty, the input is muxed fmp4
   * (single segment per period containing both video and audio frames). The
   * video variant's codec string already lists both codecs (e.g.
   * "hev1.1.6.L150.90,mp4a.40.2"). We omit EXT-X-MEDIA and the
   * AUDIO="..." STREAM-INF attribute in that case.
   *
   * Subtitles: one EXT-X-MEDIA TYPE=SUBTITLES per VTT entry, GROUP-ID="subs".
   * STREAM-INFs get SUBTITLES="subs" only when at least one VTT entry
   * exists. PGS (bitmap) subs are excluded from the master — they're loaded
   * sidecar from JS via `sub-add` against `/playback/object/{key}`.
   */
  fun buildMasterPlaylist(
    session: HlsSession,
    baseUrl: String,
    onlyVideoId: String? = null,
  ): String {
    val lines = mutableListOf("#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-INDEPENDENT-SEGMENTS")
    val isMuxed = session.audio.isEmpty()
    val primaryAudio = session.audio.firstOrNull { it.isDefault } ?: session.audio.firstOrNull()
    if (!isMuxed) {
      session.audio.forEach { entry ->
        val audioUrl = "$baseUrl/playback/hls/${session.id}/audio-${entry.id}.m3u8"
        val default = if (entry.isDefault) "YES" else "NO"
        lines.add(
          "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio\",LANGUAGE=\"${entry.language}\",NAME=\"${entry.label}\",DEFAULT=$default,AUTOSELECT=YES,URI=\"$audioUrl\""
        )
      }
    }
    val vttSubs = session.subtitles.filter { it.format == "vtt" }
    val hasSubs = vttSubs.isNotEmpty()
    if (hasSubs) {
      vttSubs.forEach { sub ->
        val subUrl = "$baseUrl/playback/hls/${session.id}/subs-${sub.id}.m3u8"
        val default = if (sub.isDefault) "YES" else "NO"
        lines.add(
          "#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"subs\",LANGUAGE=\"${sub.language}\",NAME=\"${sub.label}\",DEFAULT=$default,AUTOSELECT=YES,FORCED=NO,URI=\"$subUrl\""
        )
      }
    }
    session.videos.filter { onlyVideoId == null || it.id == onlyVideoId }.forEach { video ->
      val codecString = if (isMuxed) {
        video.track.codecString ?: ""
      } else {
        listOfNotNull(video.track.codecString, primaryAudio?.track?.codecString)
          .filter { it.isNotEmpty() }
          .joinToString(",")
      }
      val bandwidth = max(1, (video.bitrateKbps ?: 5000) * 1000)
      val resolution = if (video.width != null && video.height != null)
        ",RESOLUTION=${video.width}x${video.height}" else ""
      val audioRef = if (isMuxed) "" else ",AUDIO=\"audio\""
      val subsRef = if (hasSubs) ",SUBTITLES=\"subs\"" else ""
      lines.add(
        "#EXT-X-STREAM-INF:BANDWIDTH=$bandwidth,CODECS=\"$codecString\"$audioRef$subsRef$resolution"
      )
      lines.add("$baseUrl/playback/hls/${session.id}/video-${video.id}.m3u8")
    }
    return lines.joinToString("\n") + "\n"
  }
}
