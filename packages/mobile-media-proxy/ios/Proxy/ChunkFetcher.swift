import Foundation

/// "Object key -> plaintext bytes". Implementations dedupe in-flight fetches and keep an LRU cache; they may be called
/// concurrently from the HTTP server's worker threads. Throws on fetch or crypto failure (the server answers 502).
/// Objects above `spoolThresholdBytes` (subtitle sidecars) come back as a memory-mapped `PlaintextSpool` file and stay
/// out of the in-memory LRU.
protocol ChunkFetcher: AnyObject {
  func getObject(_ key: String) throws -> Data
  /// Warms the cache ahead of the player's own request (see `SegmentPrefetcher`).
  func prefetch(_ key: String) throws
  /// Aborts the downloads of the keys `matches` picks (their fetch throws), including one not on the wire yet (still
  /// opening the session), which is aborted as it starts; another read that joined such a fetch fetches the object again
  /// rather than failing. Returns how many. Port of the Kotlin `ChunkFetcher.cancelInFlight`.
  func cancelInFlight(_ matches: (String) -> Bool) -> Int
  /// The objects the cache keeps whatever else is fetched (`NeighbourPreloader`, PAR-PLAY-07); replaces the previous set.
  func pin(_ keys: Set<String>)
  func shutdown()
}

extension ChunkFetcher {
  func prefetch(_ key: String) throws { _ = try getObject(key) }
  func cancelInFlight(_ matches: (String) -> Bool) -> Int { 0 }
  func pin(_ keys: Set<String>) {}
}

/// Latch other threads wait on while one thread fetches a key.
final class FetchDeferred {
  private let cond = NSCondition()
  private var done = false
  private var value: Data?
  private var error: Error?
  /// Set by `cancelInFlight` (under the fetcher's cache lock): the fetch is aborted, also before its download started.
  var cancelled = false

  func resolve(_ v: Data) {
    cond.lock(); value = v; done = true; cond.broadcast(); cond.unlock()
  }

  func reject(_ e: Error) {
    cond.lock(); error = e; done = true; cond.broadcast(); cond.unlock()
  }

  func waitValue() throws -> Data {
    cond.lock()
    defer { cond.unlock() }
    while !done { cond.wait() }
    if let error { throw error }
    return value ?? Data()
  }
}
