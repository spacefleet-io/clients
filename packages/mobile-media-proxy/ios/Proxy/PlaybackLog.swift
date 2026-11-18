import Foundation
import os

/// Unified-log wrapper (subsystem `com.spacefleet.mpvplayback`, the iOS counterpart of the Android logcat tags
/// `PlaybackHttp`, `StorageTunnelClient`, `MpvCore`). Messages are public so they show up in `log show`/`log stream`.
/// Category `playback` = the proxy's and the player's own lines, `mpv` = libmpv's message stream (`MpvCore` on Android),
/// fed by the MpvPlayback pod through `core(_:_:)` (its `PlaybackLog.mpv(level:_:)` extension maps the libmpv levels), so
/// this pod never imports Libmpv. The subsystem keeps its historical name: `log stream` filters stay valid.
///
/// With the environment variable `SB_PLAYBACK_LOG_FILE=1` (e.g. `devicectl device process launch
/// --environment-variables`), every line is also appended to `Library/Caches/playback.log` in the app container, which
/// `devicectl device copy from --domain-type appDataContainer` can pull without root (the unified log of a device
/// needs `sudo log collect`).
public enum PlaybackLog {
  private static let logger = Logger(subsystem: "com.spacefleet.mpvplayback", category: "playback")
  private static let coreLogger = Logger(subsystem: "com.spacefleet.mpvplayback", category: "mpv")

  private static let fileSink: (handle: FileHandle, queue: DispatchQueue)? = {
    guard ProcessInfo.processInfo.environment["SB_PLAYBACK_LOG_FILE"] == "1",
          let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else { return nil }
    let url = caches.appendingPathComponent("playback.log")
    FileManager.default.createFile(atPath: url.path, contents: nil)  // truncates: one file per launch
    guard let handle = try? FileHandle(forWritingTo: url) else { return nil }
    return (handle, DispatchQueue(label: "com.spacefleet.mpvplayback.logfile", qos: .utility))
  }()

  private static func toFile(_ tag: String, _ msg: String) {
    guard let sink = fileSink else { return }
    let line = "\(Date().timeIntervalSince1970) [\(tag)] \(msg)\n"
    sink.queue.async { sink.handle.write(Data(line.utf8)) }
  }

  public static func debug(_ msg: String) { logger.debug("\(msg, privacy: .public)"); toFile("D", msg) }
  public static func info(_ msg: String) { logger.info("\(msg, privacy: .public)"); toFile("I", msg) }
  public static func warn(_ msg: String) { logger.warning("\(msg, privacy: .public)"); toFile("W", msg) }
  public static func error(_ msg: String) { logger.error("\(msg, privacy: .public)"); toFile("E", msg) }

  /// One message of the player core (category `mpv`, file tag `mpv`) at `type`: `.fault`/`.error`, `.default` (warning),
  /// `.info`, anything else debug.
  public static func core(_ type: OSLogType, _ msg: String) {
    switch type {
    case .fault, .error: coreLogger.error("\(msg, privacy: .public)")
    case .default: coreLogger.warning("\(msg, privacy: .public)")
    case .info: coreLogger.info("\(msg, privacy: .public)")
    default: coreLogger.debug("\(msg, privacy: .public)")
    }
    toFile("mpv", msg)
  }
}
