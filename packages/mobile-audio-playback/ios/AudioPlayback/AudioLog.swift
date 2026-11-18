import Foundation
import os

/// Unified-log wrapper of the iPhone music player (subsystem `com.spacefleet.audioplayback`, category `playback`), the
/// counterpart of the Android logcat tags `AudioPlayback` and `EvenVolume`. Lines are greppable `event key=value`
/// (`audio.queue.set n=12 start=3`, `audio.state state=ready playing=true ...`, `audio.interruption type=began ...`,
/// `audio.error code=...`) and public, so `log stream --predicate 'subsystem == "com.spacefleet.audioplayback"'` and
/// `log show` print them in full.
enum AudioLog {
  private static let logger = Logger(subsystem: "com.spacefleet.audioplayback", category: "playback")

  static func debug(_ message: String) { logger.debug("\(message, privacy: .public)") }
  static func info(_ message: String) { logger.info("\(message, privacy: .public)") }
  static func warn(_ message: String) { logger.warning("\(message, privacy: .public)") }
  static func error(_ message: String) { logger.error("\(message, privacy: .public)") }
}
