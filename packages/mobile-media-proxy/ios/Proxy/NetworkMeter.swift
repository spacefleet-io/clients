import Foundation

/// Throughput of the proxy's upstream fetches (bits/s over the busy time of the last 15 s). Mirror of the Android
/// `NetworkMeter`: idle time is excluded on purpose, overlapping fetches are counted once.
public final class NetworkMeter {
  public static let shared = NetworkMeter()

  private static let maxAgeSeconds = 15.0
  private struct Sample {
    let bytes: Int
    let start: TimeInterval
    let end: TimeInterval
  }
  private let lock = NSLock()
  private var samples: [Sample] = []

  func record(bytes: Int, start: TimeInterval, end: TimeInterval) {
    guard bytes > 0, end > start else { return }
    lock.lock()
    defer { lock.unlock() }
    samples.append(Sample(bytes: bytes, start: start, end: end))
    prune(now: end)
  }

  public func bitsPerSecond(now: TimeInterval = Date().timeIntervalSince1970) -> Double {
    lock.lock()
    defer { lock.unlock() }
    prune(now: now)
    guard !samples.isEmpty else { return 0 }
    let sorted = samples.sorted { $0.start < $1.start }
    var bytes = 0
    var busy = 0.0
    var curStart = sorted[0].start
    var curEnd = sorted[0].end
    for s in sorted {
      bytes += s.bytes
      if s.start > curEnd {
        busy += curEnd - curStart
        curStart = s.start
        curEnd = s.end
      } else if s.end > curEnd {
        curEnd = s.end
      }
    }
    busy += curEnd - curStart
    return busy <= 0 ? 0 : Double(bytes) * 8 / busy
  }

  func reset() {
    lock.lock()
    samples.removeAll()
    lock.unlock()
  }

  private func prune(now: TimeInterval) {
    samples.removeAll { now - $0.end > Self.maxAgeSeconds }
  }
}
