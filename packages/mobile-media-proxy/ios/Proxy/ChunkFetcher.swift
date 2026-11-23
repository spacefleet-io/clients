import Foundation

/// "Object key -> plaintext bytes". Implementations dedupe in-flight fetches and keep an LRU cache; they may be called
/// concurrently from the HTTP server's worker threads. Throws on fetch or crypto failure (the server answers 502).
/// Objects above `spoolThresholdBytes` (subtitle sidecars) come back as a memory-mapped `PlaintextSpool` file and stay
/// out of the in-memory LRU.
protocol ChunkFetcher: AnyObject {
  func getObject(_ key: String) throws -> Data
  /// Warms the cache ahead of the player's own request (see `SegmentPrefetcher`).
  func prefetch(_ key: String) throws
  func shutdown()
}

extension ChunkFetcher {
  func prefetch(_ key: String) throws { _ = try getObject(key) }
}

/// Latch other threads wait on while one thread fetches a key.
final class FetchDeferred {
  private let cond = NSCondition()
  private var done = false
  private var value: Data?
  private var error: Error?

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
