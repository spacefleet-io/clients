import Foundation
import Libmpv
import MediaProxy
import os

extension PlaybackLog {
  /// One libmpv log message (`mpv_request_log_messages`), at the matching unified-log level (category `mpv`).
  static func mpv(level: mpv_log_level, _ msg: String) {
    switch level {
    case MPV_LOG_LEVEL_FATAL, MPV_LOG_LEVEL_ERROR: core(.error, msg)
    case MPV_LOG_LEVEL_WARN: core(.default, msg)
    case MPV_LOG_LEVEL_INFO: core(.info, msg)
    default: core(.debug, msg)
    }
  }
}

/// What this player plugs into the proxy pod (`MediaProxyHooks`, the iOS twin of the Kotlin `MediaProxyHooks` that
/// `MpvPlaybackPackage` installs): the high-traffic buffer cap (STOR-BW-01) also shrinks the live core's `cache-secs` and
/// `demuxer-readahead-secs`. Installed once, when the first `MpvEngine` is created: before that there is no core to
/// change, and the next core starts with the normal values anyway.
enum MpvProxyHooks {
  static let installed: Void = {
    MediaProxyHooks.onBufferCap = { seconds in
      guard let engine = MpvEngine.current else {
        PlaybackLog.debug("bufferCap.mpv_skipped reason=no_core seconds=\(seconds)")
        return
      }
      let cache = TrafficBuffer.cacheSecs(seconds)
      let readahead = TrafficBuffer.readaheadSecs(seconds)
      do {
        try engine.setString("cache-secs", String(cache))
        try engine.setString("demuxer-readahead-secs", String(readahead))
        PlaybackLog.info("bufferCap.mpv cacheSecs=\(cache) readaheadSecs=\(readahead)")
      } catch {
        PlaybackLog.debug("bufferCap.mpv_skipped \(error)")
      }
    }
    PlaybackLog.info("mediaProxyHooks.installed player=mpv")
  }()
}
