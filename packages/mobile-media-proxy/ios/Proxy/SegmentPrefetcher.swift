import Foundation

/// Proxy-side read-ahead for HLS segments (port of the Android `SegmentPrefetcher`). Fetches are deduplicated with the
/// player's own requests by the fetcher's in-flight map, so a request that arrives mid-prefetch just waits.
///  - `register`: init + first segments of every track the moment a session exists;
///  - `onRequest`: a request for a "live" track (read past its first two segments) pulls the time-aligned segments of
///    the other live tracks (playing video variant <-> audio; what a seek looks like from here);
///  - `onServed`: after a live segment, the next `lookahead` segments of the same track, plus the segments of the other
///    live tracks (the playing video variant and the audio) that their own look-ahead would fetch anyway and that lie
///    fully inside that stretch of the timeline: the batch mixes audio and video without any track reaching further
///    ahead than its own `lookahead`.
/// Each trigger collects its keys into one batch and requests it in a shuffled order that mixes audio and video
/// (`BatchShuffle`, PRIV-ENC-05), never track by track.
final class SegmentPrefetcher {
  private static let warmupSegments = 2
  private static let liveAfterIndex = 2
  private static let siblingSegments = 2
  private static let lookaheadSegments = 3
  /// Slack on segment boundaries: two tracks cut at the same instants can sum their EXTINFs to slightly different values.
  private static let boundaryEpsilonSeconds = 0.001

  private final class TrackIndex {
    let id: String
    let track: HlsTrack
    let isVideo: Bool
    var starts: [Double] = []
    var live = false
    /// Video only: this is the variant the player reads now. A rung switch reloads the session on another variant, whose
    /// first request clears this flag on the one left behind (which stays `live`).
    var playing = false
    /// Index of the last segment of this track written to the player, -1 before the first one.
    var servedIndex = -1
    var siblings: [TrackIndex] = []

    init(id: String, track: HlsTrack, isVideo: Bool) {
      self.id = id
      self.track = track
      self.isVideo = isVideo
      var t = 0.0
      for seg in track.segments {
        starts.append(t)
        t += seg.durationSeconds
      }
    }

    func indexAt(_ seconds: Double) -> Int {
      var lo = 0
      var hi = starts.count - 1
      var found = 0
      while lo <= hi {
        let mid = (lo + hi) / 2
        if starts[mid] <= seconds {
          found = mid
          lo = mid + 1
        } else {
          hi = mid - 1
        }
      }
      return found
    }
  }

  private struct Slot {
    let track: TrackIndex
    let index: Int  // -1 = init segment
  }

  private let fetcher: ChunkFetcher
  private let queue: OperationQueue
  private let lock = NSLock()
  private var slots: [String: Slot] = [:]
  private var scheduled = Set<String>()
  /// The gateway's `playbackBufferSeconds` while its silo is high (`TrafficBuffer.noCap` otherwise). Guarded by `lock`.
  private var bufferCapSeconds = TrafficBuffer.noCap

  init(fetcher: ChunkFetcher, queue: OperationQueue) {
    self.fetcher = fetcher
    self.queue = queue
  }

  func setBufferCap(_ seconds: Double) {
    lock.lock()
    bufferCapSeconds = seconds
    lock.unlock()
  }

  func register(_ session: HlsSession) {
    let tracks = session.videos.map { TrackIndex(id: $0.id, track: $0.track, isVideo: true) }
      + session.audio.map { TrackIndex(id: $0.id, track: $0.track, isVideo: false) }
    lock.lock()
    for t in tracks {
      t.siblings = tracks.filter { $0 !== t }
      slots[t.track.initKey] = Slot(track: t, index: -1)
      for (i, seg) in t.track.segments.enumerated() { slots[seg.key] = Slot(track: t, index: i) }
    }
    lock.unlock()
    var batch: [(key: String, reason: String)] = []
    for t in tracks {
      batch.append((key: t.track.initKey, reason: "warmup"))
      batch += t.track.segments.prefix(Self.warmupSegments).map { (key: $0.key, reason: "warmup") }
    }
    scheduleBatch(batch)
  }

  func onRequest(_ key: String) {
    lock.lock()
    guard let slot = slots[key], slot.index >= 0 else { lock.unlock(); return }
    let track = slot.track
    if track.isVideo && !track.playing {
      track.playing = true
      for sibling in track.siblings where sibling.isVideo { sibling.playing = false }
    }
    if slot.index >= Self.liveAfterIndex { track.live = true }
    guard track.live else { lock.unlock(); return }
    let at = track.starts[slot.index]
    var batch: [(key: String, reason: String)] = []
    for sibling in track.siblings where Self.prefetchable(sibling) {
      let first = sibling.indexAt(at)
      batch.append((key: sibling.track.initKey, reason: "sibling"))
      let end = min(first + Self.siblingSegments, sibling.track.segments.count)
      if first < end { batch += sibling.track.segments[first..<end].map { (key: $0.key, reason: "sibling") } }
    }
    lock.unlock()
    scheduleBatch(batch)
  }

  func onServed(_ key: String) {
    lock.lock()
    guard let slot = slots[key], slot.index >= 0 else { lock.unlock(); return }
    let track = slot.track
    track.servedIndex = slot.index
    guard track.live else { lock.unlock(); return }
    let segments = track.track.segments
    let from = slot.index + 1
    let to = min(slot.index + Self.lookaheadSegments, segments.count - 1)
    var batch: [(key: String, reason: String)] = []
    // High traffic (STOR-BW-01): only as many segments ahead as fit the gateway's playback buffer; the siblings follow the capped stretch.
    let ahead = from <= to ? TrafficBuffer.lookaheadCount(segments[from...to].map(\.durationSeconds), bufferCapSeconds) : 0
    if ahead > 0 {
      let to = from + ahead - 1
      batch += segments[from...to].map { (key: $0.key, reason: "lookahead") }
      // Mix in the other live tracks so the batch holds audio and video (PRIV-ENC-05), taking from each only segments its
      // own look-ahead covers (the next `lookaheadSegments` after its last served one) that lie fully inside this window:
      // no track is fetched further ahead than before. A video variant left behind by a rung switch is skipped.
      let windowStart = track.starts[from] - Self.boundaryEpsilonSeconds
      let windowEnd = track.starts[to] + segments[to].durationSeconds + Self.boundaryEpsilonSeconds
      for sibling in track.siblings where Self.prefetchable(sibling) {
        let sibSegments = sibling.track.segments
        let first = sibling.servedIndex + 1
        let last = min(sibling.servedIndex + Self.lookaheadSegments, sibSegments.count - 1)
        guard first <= last else { continue }
        for i in first...last {
          let start = sibling.starts[i]
          if start >= windowStart && start + sibSegments[i].durationSeconds <= windowEnd {
            batch.append((key: sibSegments[i].key, reason: "lookahead"))
          }
        }
      }
    }
    lock.unlock()
    scheduleBatch(batch)
  }

  /// Live, and for video the variant the player reads now: a variant left by a rung switch stays `live` but is never read again.
  private static func prefetchable(_ t: TrackIndex) -> Bool { t.live && (!t.isVideo || t.playing) }

  /// `<track id>#<segment index>@<start s>` (`#init` for an init segment) of `key`, or "-" when it is not a session
  /// segment. Logs only; the caller holds `lock`.
  private func describeLocked(_ key: String) -> String {
    guard let slot = slots[key] else { return "-" }
    if slot.index < 0 { return "\(slot.track.id)#init" }
    return "\(slot.track.id)#\(slot.index)@\(String(format: "%.1f", slot.track.starts[slot.index]))"
  }

  /// Requests one look-ahead batch in a shuffled order (PRIV-ENC-05). The queue starts operations in submission order, so
  /// shuffling the submission order shuffles the order the blocks leave the device: audio and video blocks of the batch
  /// are interleaved unpredictably instead of one track after the other.
  private func scheduleBatch(_ batch: [(key: String, reason: String)]) {
    if batch.isEmpty { return }
    let order = BatchShuffle.shuffled(batch, nextInt: BatchShuffle.systemNextInt)
    lock.lock()
    let described = order.map { describeLocked($0.key) }.joined(separator: ",")
    lock.unlock()
    PlaybackLog.debug("prefetch.batch order=\(described)")
    for item in order { schedule(item.key, reason: item.reason) }
  }

  private func schedule(_ key: String, reason: String) {
    lock.lock()
    let inserted = scheduled.insert(key).inserted
    lock.unlock()
    guard inserted else { return }
    queue.addOperation { [weak self] in
      guard let self else { return }
      defer {
        self.lock.lock()
        self.scheduled.remove(key)
        self.lock.unlock()
      }
      do { try self.fetcher.prefetch(key) } catch {
        PlaybackLog.debug("prefetch.failed reason=\(reason) key=\(key) msg=\(error.localizedDescription)")
      }
    }
  }
}
