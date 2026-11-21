import Foundation

/// When the `AVQueuePlayer` may start loading the song after the playing one (PAR-PLAY-07). Making the upcoming item
/// opens its stream at once, which would share the connection with the playing song while that one still fills its
/// buffer: it waits until the playing song holds `aheadSeconds` past the position, or is loaded to its end. Pure: the
/// player feeds it the playing item's loaded ranges.
public enum UpcomingGate {
  /// How far past the position the playing song must be loaded before the next one loads.
  public static let aheadSeconds = 30.0
  /// In the song's last seconds the next one loads whatever is buffered, or the step to it would not be gapless.
  public static let lastSeconds = 10.0

  /// True when the loaded range around `positionSeconds` reaches `aheadSeconds` past it or the end of a song of known
  /// `durationSeconds` (NaN or ≤ 0 when unknown), or the song is in its `lastSeconds`. `ranges` are the loaded
  /// `(start, end)` time ranges in seconds.
  public static func ready(
    ranges: [(start: Double, end: Double)], positionSeconds: Double, durationSeconds: Double, aheadSeconds: Double = aheadSeconds
  ) -> Bool {
    let known = durationSeconds.isFinite && durationSeconds > 0
    if known && durationSeconds - positionSeconds <= lastSeconds { return true }
    // A range counts when it holds the position; a hair of slack absorbs the decoder's position running just ahead.
    let slack = 0.5
    let loadedEnd = ranges.filter { $0.start <= positionSeconds + slack && $0.end >= positionSeconds - slack }.map(\.end).max()
    guard let loadedEnd else { return false }
    if known && loadedEnd >= durationSeconds - slack { return true }
    return loadedEnd >= positionSeconds + aheadSeconds
  }
}
