import Foundation

/// "off", "all" (the queue starts over after its last song) or "one" (the same song again).
public enum RepeatMode: String {
  case off, all, one
}

/// The queue positions that play after `current`, in the order the player plays them (PAR-PLAY-06's Queue): `next`
/// is the player's step (the shuffled order when shuffle is on, wrapping to the start with repeat all) and returns a
/// negative index after the last song. Stops before coming back to `current`, so repeat all lists each song once.
/// Port of Android's `UpNext.kt`.
public func upNextIndices(current: Int, count: Int, next: (Int) -> Int) -> [Int] {
  if current < 0 || current >= count { return [] }
  var out: [Int] = []
  var at = next(current)
  while at >= 0 && at != current && out.count < count {
    out.append(at)
    at = next(at)
  }
  return out
}

/// The shuffled play order, kept so songs added to a playing queue land where the user asked even with shuffle on
/// (PAR-CARD-01), as they do with shuffle off: a queue filled from empty is drawn at random; songs added with "Play
/// next" play right after the song before them in the list (the current song); songs added with "Add to queue" play
/// last. Port of Android's `UpNextShuffleOrder.kt` (Media3 `ShuffleOrder`), with the "add to queue" choice passed in
/// rather than through a static flag.
public struct ShuffleOrder: Equatable {
  public let order: [Int]
  private let position: [Int]

  public init(_ order: [Int]) {
    self.order = order
    var position = [Int](repeating: 0, count: order.count)
    for (at, index) in order.enumerated() { position[index] = at }
    self.position = position
  }

  /// Every index of a `count`-song list in a random order, `first` (when given) ahead of the rest: the song playing
  /// keeps playing and the others are drawn after it.
  public static func drawn<G: RandomNumberGenerator>(count: Int, first: Int? = nil, using random: inout G) -> ShuffleOrder {
    guard let first, first >= 0, first < count else { return ShuffleOrder(Array(0..<count).shuffled(using: &random)) }
    return ShuffleOrder([first] + (0..<count).filter { $0 != first }.shuffled(using: &random))
  }

  public var length: Int { order.count }
  public var firstIndex: Int { order.first ?? -1 }
  public var lastIndex: Int { order.last ?? -1 }

  public func nextIndex(_ index: Int) -> Int {
    let at = position[index]
    return at + 1 < order.count ? order[at + 1] : -1
  }

  public func previousIndex(_ index: Int) -> Int {
    let at = position[index]
    return at > 0 ? order[at - 1] : -1
  }

  /// `count` songs inserted at list index `insertionIndex`. `atEnd`: "Add to queue" (they play last); otherwise they
  /// play right after the song before them in the list. Into an empty order they are drawn at random.
  public func inserting<G: RandomNumberGenerator>(
    at insertionIndex: Int, count: Int, atEnd: Bool, using random: inout G
  ) -> ShuffleOrder {
    let added = Array(insertionIndex..<(insertionIndex + count))
    if order.isEmpty { return ShuffleOrder(added.shuffled(using: &random)) }
    // Songs at or after the insertion point move up by the inserted count.
    let shifted = order.map { $0 >= insertionIndex ? $0 + count : $0 }
    let at: Int
    if atEnd {
      at = shifted.count
    } else if insertionIndex == 0 {
      at = 0
    } else {
      at = position[insertionIndex - 1] + 1
    }
    return ShuffleOrder(Array(shifted[0..<at]) + added + Array(shifted[at...]))
  }

  public func removing(from indexFrom: Int, to indexToExclusive: Int) -> ShuffleOrder {
    let count = indexToExclusive - indexFrom
    return ShuffleOrder(order.filter { $0 < indexFrom || $0 >= indexToExclusive }.map { $0 >= indexToExclusive ? $0 - count : $0 })
  }
}

/// What Previous does: the system's rule (Media3 `seekToPrevious`), restart the song past its first 3 seconds, else
/// go to the song before it.
public enum PreviousAction: Equatable {
  case restart
  case item(Int)
}

/// The queue the iPhone player plays, its order and its navigation, matching Media3's `Player` on Android: shuffle and
/// repeat modes, Next and Previous, what plays when a song ends, and the up-next list. Pure (no AVFoundation), so the
/// XCTest cases drive it directly; `AudioPlayer` holds one and follows it.
public struct PlayQueue<Item> {
  /// Media3's `maxSeekToPreviousPositionMs` default.
  public static var maxSeekToPreviousMs: Int64 { 3_000 }

  public private(set) var items: [Item] = []
  /// The song playing (or about to), -1 when the queue is empty.
  public private(set) var current = -1
  public private(set) var shuffle = false
  public var repeatMode: RepeatMode = .off
  public private(set) var order = ShuffleOrder([])

  public init() {}

  public var count: Int { items.count }
  public var isEmpty: Bool { items.isEmpty }
  public var currentItem: Item? { current >= 0 && current < items.count ? items[current] : nil }

  /// Replaces the queue; `start` plays first (its order is drawn with it first).
  public mutating func set<G: RandomNumberGenerator>(_ newItems: [Item], start: Int, using random: inout G) {
    items = newItems
    current = newItems.isEmpty ? -1 : min(max(0, start), newItems.count - 1)
    order = ShuffleOrder.drawn(count: newItems.count, first: current >= 0 ? current : nil, using: &random)
  }

  /// Adds songs without moving the one playing: `atEnd` after the last song (Add to queue), else right after the
  /// current one (Play next), also with shuffle on. Returns true when the queue was empty, so they start now (from the
  /// first song of the play order).
  @discardableResult
  public mutating func add<G: RandomNumberGenerator>(_ newItems: [Item], atEnd: Bool, using random: inout G) -> Bool {
    guard !newItems.isEmpty else { return false }
    if items.isEmpty {
      items = newItems
      order = ShuffleOrder([]).inserting(at: 0, count: newItems.count, atEnd: true, using: &random)
      current = shuffle ? order.firstIndex : 0
      return true
    }
    let at = atEnd ? items.count : current + 1
    order = order.inserting(at: at, count: newItems.count, atEnd: atEnd, using: &random)
    items.insert(contentsOf: newItems, at: at)
    if at <= current { current += newItems.count }
    return false
  }

  public mutating func clear() {
    items = []
    current = -1
    order = ShuffleOrder([])
  }

  /// Turning shuffle on keeps the current song and draws the rest after it; turning it off plays on in list order.
  public mutating func setShuffle<G: RandomNumberGenerator>(_ enabled: Bool, using random: inout G) {
    if enabled && !shuffle && !items.isEmpty {
      order = ShuffleOrder.drawn(count: items.count, first: current, using: &random)
    }
    shuffle = enabled
  }

  /// Jumps to list index `index` (Next, Previous, the next song starting).
  public mutating func move(to index: Int) {
    guard index >= 0 && index < items.count else { return }
    current = index
  }

  /// The item after `index` with `mode`: the shuffled order with shuffle on, wrapping with repeat all; -1 at the end.
  public func nextIndex(after index: Int, mode: RepeatMode) -> Int {
    guard index >= 0 && index < items.count else { return -1 }
    if mode == .one { return index }
    if shuffle {
      let next = order.nextIndex(index)
      return next >= 0 ? next : (mode == .all ? order.firstIndex : -1)
    }
    return index + 1 < items.count ? index + 1 : (mode == .all ? 0 : -1)
  }

  public func previousIndex(before index: Int, mode: RepeatMode) -> Int {
    guard index >= 0 && index < items.count else { return -1 }
    if mode == .one { return index }
    if shuffle {
      let previous = order.previousIndex(index)
      return previous >= 0 ? previous : (mode == .all ? order.lastIndex : -1)
    }
    return index > 0 ? index - 1 : (mode == .all ? items.count - 1 : -1)
  }

  /// Repeat one stays on the song when it ends but not for Next and Previous (Media3's navigation repeat mode).
  private var navigationMode: RepeatMode { repeatMode == .one ? .off : repeatMode }

  /// What the Next button and the state's `nextKey` go to; -1 when none.
  public var nextForNavigation: Int { nextIndex(after: current, mode: navigationMode) }

  /// What plays when the current song ends by itself; -1 when the queue ends.
  public var nextWhenEnded: Int { nextIndex(after: current, mode: repeatMode) }

  /// What the Previous button goes back to within the first seconds and the state's `previousKey`; -1 when none.
  public var previousForNavigation: Int { previousIndex(before: current, mode: navigationMode) }

  public func previousAction(positionMs: Int64) -> PreviousAction {
    let previous = previousForNavigation
    if previous >= 0 && positionMs <= Self.maxSeekToPreviousMs { return .item(previous) }
    return .restart
  }

  /// The list indices that play after the current song, in play order; repeat one lists what Next plays.
  public var upNext: [Int] {
    let mode: RepeatMode = repeatMode == .all ? .all : .off
    return upNextIndices(current: current, count: items.count) { nextIndex(after: $0, mode: mode) }
  }
}
