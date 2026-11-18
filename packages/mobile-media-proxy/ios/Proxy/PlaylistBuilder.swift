import Foundation

struct HlsSegment {
  let key: String
  let durationSeconds: Double
  let startSeconds: Double?
}

struct HlsTrack {
  let initKey: String
  let codecString: String?
  let segments: [HlsSegment]
}

struct HlsVideoVariant {
  let id: String
  let quality: String
  let bitrateKbps: Int?
  let width: Int?
  let height: Int?
  let track: HlsTrack
}

struct HlsAudioVariant {
  let id: String
  let language: String
  let label: String
  let isDefault: Bool
  let track: HlsTrack
}

/// `format` is "vtt", "pgs" or "vobsub". Only VTT is advertised in the master (lavf's HLS demuxer cannot carry a
/// bitmap subtitle rendition, as on Android); PGS/VobSub are loaded sidecar by JS (`sub-add` on `/playback/object/<key>`).
struct HlsSubtitleVariant {
  let id: String
  let language: String
  let label: String
  let isDefault: Bool
  let format: String
  let objectKey: String
  let durationSeconds: Double
}

struct HlsSession {
  let id: String
  let mode: String  // "vod" | "event"
  let videos: [HlsVideoVariant]
  let audio: [HlsAudioVariant]
  let subtitles: [HlsSubtitleVariant]

  /// Every storage object the session plays: init and media segments of each video and audio version, and the subtitle
  /// objects. The cast server answers these keys and no others (UX-TV-03); same set as the Kotlin `LanAllowList`.
  var objectKeys: Set<String> {
    var keys = Set<String>()
    for track in videos.map(\.track) + audio.map(\.track) {
      if !track.initKey.isEmpty { keys.insert(track.initKey) }
      for segment in track.segments { keys.insert(segment.key) }
    }
    for subtitle in subtitles where !subtitle.objectKey.isEmpty { keys.insert(subtitle.objectKey) }
    return keys
  }
}

/// HLS playlist generator for the embedded libmpv (lavf's HLS demuxer). Same routes and structure as the Android
/// `PlaylistBuilder`:
///  - `EXT-X-VERSION:7` + `EXT-X-MAP` for the fMP4 init segment,
///  - a CODECS attribute (video + audio) when the video codec string is known,
///  - `AVERAGE-BANDWIDTH`, `FRAME-RATE`-less but with `RESOLUTION` when known,
///  - subtitle renditions are plain single-segment WebVTT playlists (no CODECS needed on the SUBTITLES group).
enum PlaylistBuilder {
  private static let urlUnreserved = CharacterSet(
    charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

  private static func urlEncode(_ s: String) -> String {
    // ASCII-only unreserved set: `CharacterSet.alphanumerics` also lets Unicode letters through unescaped.
    s.addingPercentEncoding(withAllowedCharacters: urlUnreserved) ?? s
  }

  private static func attr(_ s: String) -> String {
    s.replacingOccurrences(of: "\"", with: "'")
  }

  private static func seconds(_ d: Double) -> String { String(format: "%.3f", locale: Locale(identifier: "en_US_POSIX"), d) }

  private static func header(mode: String, targetDuration: Double) -> [String] {
    [
      "#EXTM3U",
      "#EXT-X-VERSION:7",
      "#EXT-X-INDEPENDENT-SEGMENTS",
      "#EXT-X-TARGETDURATION:\(max(1, Int(targetDuration.rounded(.up))))",
      "#EXT-X-MEDIA-SEQUENCE:0",
      mode == "event" ? "#EXT-X-PLAYLIST-TYPE:EVENT" : "#EXT-X-PLAYLIST-TYPE:VOD",
    ]
  }

  static func buildTrackPlaylist(track: HlsTrack, baseUrl: String, mode: String) -> String {
    let target = track.segments.map(\.durationSeconds).max() ?? 1
    var lines = header(mode: mode, targetDuration: target)
    lines.append("#EXT-X-MAP:URI=\"\(baseUrl)/playback/object/\(urlEncode(track.initKey))\"")
    for seg in track.segments {
      lines.append("#EXTINF:\(seconds(seg.durationSeconds)),")
      lines.append("\(baseUrl)/playback/object/\(urlEncode(seg.key))")
    }
    if mode == "vod" { lines.append("#EXT-X-ENDLIST") }
    return lines.joined(separator: "\n") + "\n"
  }

  /// Single-segment WebVTT playlist: one EXTINF pointing at the whole .vtt.
  static func buildSubtitlePlaylist(sub: HlsSubtitleVariant, baseUrl: String, mode: String) -> String {
    let duration = sub.durationSeconds > 0 ? sub.durationSeconds : 1
    var lines = header(mode: mode, targetDuration: duration)
    lines.append("#EXTINF:\(seconds(duration)),")
    lines.append("\(baseUrl)/playback/object/\(urlEncode(sub.objectKey))")
    if mode == "vod" { lines.append("#EXT-X-ENDLIST") }
    return lines.joined(separator: "\n") + "\n"
  }

  static func buildMasterPlaylist(session: HlsSession, baseUrl: String, onlyVideoId: String? = nil) -> String {
    var lines = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-INDEPENDENT-SEGMENTS"]
    let isMuxed = session.audio.isEmpty
    var audioCodecs: [String] = []
    for entry in session.audio {
      if let c = entry.track.codecString, !c.isEmpty, !audioCodecs.contains(c) { audioCodecs.append(c) }
    }
    if !isMuxed {
      for entry in session.audio {
        let url = "\(baseUrl)/playback/hls/\(session.id)/audio-\(entry.id).m3u8"
        lines.append(
          "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio\",LANGUAGE=\"\(attr(entry.language))\",NAME=\"\(attr(entry.label))\",DEFAULT=\(entry.isDefault ? "YES" : "NO"),AUTOSELECT=YES,URI=\"\(url)\""
        )
      }
    }
    let vttSubs = session.subtitles.filter { $0.format == "vtt" }
    for sub in vttSubs {
      let url = "\(baseUrl)/playback/hls/\(session.id)/subs-\(sub.id).m3u8"
      lines.append(
        "#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"subs\",LANGUAGE=\"\(attr(sub.language))\",NAME=\"\(attr(sub.label))\",DEFAULT=\(sub.isDefault ? "YES" : "NO"),AUTOSELECT=YES,FORCED=NO,URI=\"\(url)\""
      )
    }
    for video in session.videos where onlyVideoId == nil || video.id == onlyVideoId {
      // Without a video codec string a partial CODECS attribute would mislead the player; omit it entirely.
      var codecAttr = ""
      if let videoCodec = video.track.codecString, !videoCodec.isEmpty {
        let codecs = ([videoCodec] + audioCodecs.filter { $0 != videoCodec }).joined(separator: ",")
        codecAttr = ",CODECS=\"\(codecs)\""
      }
      let bandwidth = max(1, (video.bitrateKbps ?? 5000) * 1000)
      var resolution = ""
      if let w = video.width, let h = video.height { resolution = ",RESOLUTION=\(w)x\(h)" }
      let audioRef = isMuxed ? "" : ",AUDIO=\"audio\""
      let subsRef = vttSubs.isEmpty ? "" : ",SUBTITLES=\"subs\""
      lines.append("#EXT-X-STREAM-INF:BANDWIDTH=\(bandwidth),AVERAGE-BANDWIDTH=\(bandwidth)\(codecAttr)\(audioRef)\(subsRef)\(resolution)")
      lines.append("\(baseUrl)/playback/hls/\(session.id)/video-\(video.id).m3u8")
    }
    return lines.joined(separator: "\n") + "\n"
  }
}
