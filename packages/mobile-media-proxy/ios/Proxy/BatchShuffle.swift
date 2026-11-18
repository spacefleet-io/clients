import Foundation

/// Order of one look-ahead batch (PRIV-ENC-05): the blocks a playback client is about to fetch are requested in a shuffled
/// order that mixes audio and video, so the rhythm of the requests does not tell the storage servers which block is which.
///
/// Fisher-Yates, driven by `nextInt` (`nextInt(n)` returns an integer in `0..<n`). Port of the Android `BatchShuffle.kt`:
/// change them together.
enum BatchShuffle {
  /// Production source of randomness: `SystemRandomNumberGenerator` is cryptographically secure and thread-safe, so an
  /// observer cannot undo the shuffle.
  static let systemNextInt: (Int) -> Int = { bound in
    var generator = SystemRandomNumberGenerator()
    return Int.random(in: 0..<bound, using: &generator)
  }

  /// `items` in shuffled order; `items` itself is not modified.
  static func shuffled<T>(_ items: [T], nextInt: (Int) -> Int) -> [T] {
    var out = items
    var i = out.count - 1
    while i >= 1 {
      let j = nextInt(i + 1)
      out.swapAt(i, j)
      i -= 1
    }
    return out
  }
}
