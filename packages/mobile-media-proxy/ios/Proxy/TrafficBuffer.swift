import Foundation

/// Playback under the gateway's high-traffic state (STOR-BW-01): the viewer keeps only the next `playbackBufferSeconds`
/// buffered instead of the full read-ahead (port of the Android `TrafficBuffer`). JS reads the silo's report and calls
/// `PlaybackBridge.setBufferCap`. A cap is a number of seconds; `noCap` (0) means traffic is normal.
public enum TrafficBuffer {
  public static let noCap = 0.0

  /// What `MpvEngine` configures at start: `cache-secs` and `demuxer-readahead-secs`. Change them together.
  public static let normalCacheSecs = 30
  public static let normalReadaheadSecs = 10

  /// mpv `cache-secs` under `capSeconds`: never above the normal value, at least 1 s.
  public static func cacheSecs(_ capSeconds: Double) -> Int { capped(normalCacheSecs, capSeconds) }

  /// mpv `demuxer-readahead-secs` under `capSeconds`: never above the normal value, at least 1 s.
  public static func readaheadSecs(_ capSeconds: Double) -> Int { capped(normalReadaheadSecs, capSeconds) }

  private static func capped(_ normal: Int, _ capSeconds: Double) -> Int {
    guard capSeconds > 0, capSeconds.isFinite else { return normal }
    return min(normal, max(1, Int(capSeconds.rounded(.down))))
  }

  /// How many of the segments after the one served (`nextDurations`, in order) the proxy reads ahead: all while traffic
  /// is normal; else the leading ones whose cumulative duration stays within `capSeconds`, and at least one so playback
  /// never starves for want of its next segment.
  static func lookaheadCount(_ nextDurations: [Double], _ capSeconds: Double) -> Int {
    guard !nextDurations.isEmpty, capSeconds > 0, capSeconds.isFinite else { return nextDurations.count }
    var total = 0.0
    var count = 0
    for duration in nextDurations {
      if count > 0 && total + duration > capSeconds { break }
      total += duration
      count += 1
    }
    return max(1, count)
  }
}
