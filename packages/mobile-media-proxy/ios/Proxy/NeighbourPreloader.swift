import Foundation

/// When and what the proxy loads ahead for the songs around the playing one (PAR-PLAY-07). Pure: `NeighbourPreloader`
/// feeds it what the proxy sees. Port of the Kotlin `PreloadGate.kt` (JVM-tested there): change them together.
///
/// The player's own reads always come first. A player asks the proxy for audio only while its buffer is below its target,
/// so the proxy taking no player read for `quietMs` means the playing song's buffer is full: only then may an opening
/// load. The moment the player reads again, a loading opening of another object is dropped (`yields`) so the two never
/// share the connection.
enum PreloadGate {
  /// How long no player read must have run before an opening loads.
  static let quietMs: Int64 = 1_000

  /// Chunks of a song's opening: one 1 MiB chunk is several seconds of any copy, and the proxy reads the next chunk as
  /// soon as the first is served.
  static let openingChunks = 1

  /// How long to wait before loading: nil while a player read runs (asked again when it ends), else the time left of the
  /// quiet period since the last player read ended, 0 when it is over.
  static func waitMs(playerReads: Int, lastPlayerReadEndMs: Int64, nowMs: Int64, quietMs: Int64 = quietMs) -> Int64? {
    if playerReads > 0 { return nil }
    return max(0, lastPlayerReadEndMs + quietMs - nowMs)
  }

  /// The objects to load, in order: the next song's opening first (the likelier press), then the previous song's, which
  /// is normally still cached from when it played. Under a high-traffic cap (STOR-BW-01) the next song's opening is not
  /// loaded: the silo's playback buffer is the playing song's whole budget.
  static func targets(next: [String], previous: [String], capped: Bool) -> [String] {
    var seen = Set<String>()
    return ((capped ? [] : next) + previous).filter { seen.insert($0).inserted }
  }

  /// The objects the cache keeps whatever else is fetched: the openings of the playing, next and previous songs.
  static func pinned(current: [String], next: [String], previous: [String]) -> Set<String> {
    Set(current + next + previous)
  }

  /// True when a player read of `playerKey` must cut the loading of `loadingKey`; the player taking that very object
  /// adopts the load instead.
  static func yields(loading: String?, playerKey: String) -> Bool { loading != nil && loading != playerKey }

  /// The object keys of `file`'s opening.
  static func opening(_ file: ChunkedFile?) -> [String] {
    guard let file else { return [] }
    return file.chunks.prefix(openingChunks).map(\.objectKey)
  }
}

/// Keeps the openings of the songs around the playing one ready, so Next and Previous start at once, without ever taking
/// the connection from the playing song (PAR-PLAY-07). JS names the playing, next and previous queue entries
/// (`setNeighbours`, after the next song's copy is settled); the server wraps every player read of a chunk in `playerRead`.
///
/// One worker thread loads one opening at a time, only when `PreloadGate.waitMs` allows (no player read for the quiet
/// period); a player read of another object cancels it at once (`PreloadGate.yields`) and it is loaded again after the
/// next quiet period. The three openings are pinned in the fetcher's cache. The entries' chunk keys are read with `peek`,
/// which leaves a song's copy open to the swap that settles it (PAR-PLAY-04): loading ahead is never the player asking.
/// Port of the Kotlin `NeighbourPreloader.kt`: change them together.
final class NeighbourPreloader {
  private let fetcher: ChunkFetcher
  private let peek: (String) -> ChunkedFile?
  private let quietMs: Int64
  private let clock: () -> Int64
  private let cond = NSCondition()
  private var current: String?
  private var next: String?
  private var previous: String?
  private var trafficHigh = false
  private var bufferCapped = false
  /// Player reads running now.
  private var readCount = 0
  private var lastReadEndMs: Int64 = 0
  /// The object the worker is loading, nil when none.
  private var loading: String?
  private var loadingYielded = false
  /// Objects loaded (or failed) for the current neighbours: not tried again until they change.
  private var done = Set<String>()
  private var lastPins = Set<String>()
  private var running = true

  init(
    fetcher: ChunkFetcher, peek: @escaping (String) -> ChunkedFile?, quietMs: Int64 = PreloadGate.quietMs,
    clock: @escaping () -> Int64 = { Int64(DispatchTime.now().uptimeNanoseconds / 1_000_000) }
  ) {
    self.fetcher = fetcher
    self.peek = peek
    self.quietMs = quietMs
    self.clock = clock
    let worker = Thread { [weak self] in self?.loop() }
    worker.name = "PlaybackHttp-preload"
    worker.qualityOfService = .utility
    worker.start()
  }

  /// The playing, next and previous queue entries (registered chunked-file ids); nil where there is none.
  func setNeighbours(current: String?, next: String?, previous: String?) {
    cond.lock()
    defer { cond.unlock() }
    if current == self.current && next == self.next && previous == self.previous { return }
    // A new playing song is about to be read from its start: its quiet period starts now, not at the last song's reads.
    if current != self.current { lastReadEndMs = clock() }
    self.current = current
    self.next = next
    self.previous = previous
    done.removeAll()
    PlaybackLog.info("preload.neighbours current=\(current ?? "-") next=\(next ?? "-") previous=\(previous ?? "-")")
    cond.broadcast()
  }

  /// The silo's high-traffic state (STOR-BW-01), heard by the tunnel.
  func setTrafficHigh(_ high: Bool) { setCapped { trafficHigh = high } }

  /// The high-traffic buffer cap JS set (`PlaybackHttpServer.setBufferCap`); a positive finite cap counts as high traffic.
  func setBufferCap(_ seconds: Double) { setCapped { bufferCapped = seconds > 0 && seconds.isFinite } }

  private func setCapped(_ change: () -> Void) {
    cond.lock()
    defer { cond.unlock() }
    let before = trafficHigh || bufferCapped
    change()
    let after = trafficHigh || bufferCapped
    if before == after { return }
    PlaybackLog.info("preload.capped capped=\(after)")
    cond.broadcast()
  }

  /// Runs one player read of `key` (a chunk the player asked for, or the server's read-ahead for it) as a player read.
  func playerRead<T>(_ key: String, _ block: () throws -> T) rethrows -> T {
    beginRead(key)
    defer { endRead() }
    return try block()
  }

  private func beginRead(_ key: String) {
    cond.lock()
    readCount += 1
    var cut: String?
    if PreloadGate.yields(loading: loading, playerKey: key) && !loadingYielded {
      loadingYielded = true
      cut = loading
    }
    cond.unlock()
    guard let cut else { return }
    let aborted = fetcher.cancelInFlight { $0 == cut }
    PlaybackLog.info("preload.yield key=\(cut) for=\(key) aborted=\(aborted)")
  }

  private func endRead() {
    cond.lock()
    readCount -= 1
    lastReadEndMs = clock()
    if readCount == 0 { cond.broadcast() }
    cond.unlock()
  }

  func stop() {
    cond.lock()
    running = false
    cond.broadcast()
    cond.unlock()
  }

  private func loop() {
    while let key = awaitTarget() {
      let startMs = clock()
      PlaybackLog.info("preload.start key=\(key)")
      do {
        try fetcher.prefetch(key)
        cond.lock()
        if loadingYielded {
          // The player read something else while this ran but the fetch was past cancelling: it is loaded all the same.
          PlaybackLog.info("preload.done_after_yield key=\(key) elapsedMs=\(clock() - startMs)")
        } else {
          PlaybackLog.info("preload.done key=\(key) elapsedMs=\(clock() - startMs)")
        }
        done.insert(key)
      } catch {
        cond.lock()
        if loadingYielded {
          PlaybackLog.info("preload.dropped key=\(key) elapsedMs=\(clock() - startMs) (loaded again after the next quiet period)")
        } else {
          done.insert(key)
          PlaybackLog.warn("preload.failed key=\(key) elapsedMs=\(clock() - startMs) msg=\(error.localizedDescription)")
        }
      }
      loading = nil
      loadingYielded = false
      cond.unlock()
    }
  }

  /// Blocks until an opening may load now and returns its key (marked `loading`); nil once stopped.
  private func awaitTarget() -> String? {
    cond.lock()
    defer { cond.unlock() }
    while running {
      let nextOpening = PreloadGate.opening(next.flatMap(peek))
      let previousOpening = PreloadGate.opening(previous.flatMap(peek))
      let pins = PreloadGate.pinned(current: PreloadGate.opening(current.flatMap(peek)), next: nextOpening, previous: previousOpening)
      if pins != lastPins {
        lastPins = pins
        fetcher.pin(pins)
      }
      let target = PreloadGate.targets(next: nextOpening, previous: previousOpening, capped: trafficHigh || bufferCapped)
        .first { !done.contains($0) }
      guard let target else {
        // Looked at again now and then: a swap that settles an entry's copy changes its opening without telling us.
        _ = cond.wait(until: Date().addingTimeInterval(Double(quietMs) / 1000))
        continue
      }
      guard let wait = PreloadGate.waitMs(playerReads: readCount, lastPlayerReadEndMs: lastReadEndMs, nowMs: clock(), quietMs: quietMs) else {
        cond.wait()
        continue
      }
      if wait > 0 {
        _ = cond.wait(until: Date().addingTimeInterval(Double(wait) / 1000))
        continue
      }
      loading = target
      loadingYielded = false
      return target
    }
    return nil
  }
}
