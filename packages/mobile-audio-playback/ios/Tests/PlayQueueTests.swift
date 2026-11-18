import XCTest

/// A seeded generator, so a drawn order is the same on every run.
private struct SeededRandom: RandomNumberGenerator {
  private var state: UInt64
  init(_ seed: UInt64) { state = seed }
  mutating func next() -> UInt64 {
    state &+= 0x9E37_79B9_7F4A_7C15
    var z = state
    z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
    z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
    return z ^ (z >> 31)
  }
}

private func played(_ order: ShuffleOrder) -> [Int] {
  var out: [Int] = []
  var index = order.firstIndex
  while index != -1 {
    out.append(index)
    index = order.nextIndex(index)
  }
  return out
}

/// PAR-CARD-01 on the iPhone: with shuffle on, "Play next" songs play right after the current song and "Add to queue"
/// songs play last, as with shuffle off; a queue filled from empty is still drawn at random. Mirrors Android's
/// `UpNextShuffleOrderTest.kt`.
final class ShuffleOrderTests: XCTestCase {
  private var random = SeededRandom(7)

  private func filled(_ count: Int) -> ShuffleOrder {
    ShuffleOrder([]).inserting(at: 0, count: count, atEnd: false, using: &random)
  }

  func testFillDrawsEverySongOnce() {
    let order = filled(6)
    print("[PAR-CARD-01-SHUFFLE-FILL] order=\(played(order))")
    XCTAssertEqual(played(order).sorted(), Array(0..<6))
    XCTAssertEqual(order.length, 6)
  }

  func testPlayNextGoesRightAfterTheSongBeforeIt() {
    let order = filled(5)
    let before = played(order)
    // The current song is list index 2; "Play next" inserts 2 songs at list index 3.
    let after = played(order.inserting(at: 3, count: 2, atEnd: false, using: &random))
    let shifted = before.map { $0 >= 3 ? $0 + 2 : $0 }
    let at = shifted.firstIndex(of: 2)! + 1
    print("[PAR-CARD-01-SHUFFLE-NEXT] before=\(before) after=\(after)")
    XCTAssertEqual(after, Array(shifted[..<at]) + [3, 4] + Array(shifted[at...]))
  }

  func testPlayNextOnTheLastListSongStillPlaysNext() {
    // A drawn order where list song 3 is not last: [2, 3, 0, 1].
    let order = ShuffleOrder([2, 3, 0, 1])
    let after = played(order.inserting(at: 4, count: 1, atEnd: false, using: &random))
    print("[PAR-CARD-01-SHUFFLE-NEXT-LAST] before=\(played(order)) after=\(after)")
    XCTAssertEqual(after, [2, 3, 4, 0, 1])
  }

  func testAddToQueuePlaysLast() {
    let order = ShuffleOrder([2, 3, 0, 1])
    let after = played(order.inserting(at: 4, count: 2, atEnd: true, using: &random))
    print("[PAR-CARD-01-SHUFFLE-END] before=\(played(order)) after=\(after)")
    XCTAssertEqual(after, played(order) + [4, 5])
  }

  func testRemoveKeepsTheRestInOrder() {
    let order = filled(5)
    let before = played(order)
    let after = played(order.removing(from: 1, to: 3))
    print("[PAR-CARD-01-SHUFFLE-REMOVE] before=\(before) after=\(after)")
    XCTAssertEqual(after, before.filter { !(1...2).contains($0) }.map { $0 >= 3 ? $0 - 2 : $0 })
  }

  func testDrawnWithAFirstSongKeepsItFirst() {
    let order = ShuffleOrder.drawn(count: 8, first: 5, using: &random)
    print("[PAR-PLAY-06-SHUFFLE-DRAW] first=5 order=\(played(order))")
    XCTAssertEqual(order.firstIndex, 5)
    XCTAssertEqual(played(order).sorted(), Array(0..<8))
  }
}

/// @req PAR-PLAY-06[parrot]
///
/// The full player's Queue lists the songs in the order the player will play them: in order, wrapping once with repeat
/// all, and the drawn order with shuffle on. Mirrors Android's `UpNextTest.kt`.
final class UpNextTests: XCTestCase {
  func testInOrderListsTheSongsAfterTheCurrentOne() {
    let step = { (i: Int) in i + 1 < 4 ? i + 1 : -1 }
    print("[PAR-PLAY-06-UPNEXT] from 1: \(upNextIndices(current: 1, count: 4, next: step)) from 3: \(upNextIndices(current: 3, count: 4, next: step))")
    XCTAssertEqual(upNextIndices(current: 1, count: 4, next: step), [2, 3])
    XCTAssertEqual(upNextIndices(current: 3, count: 4, next: step), [])
  }

  func testRepeatAllWrapsOnceAndStopsBeforeTheCurrentSong() {
    let out = upNextIndices(current: 1, count: 4) { ($0 + 1) % 4 }
    print("[PAR-PLAY-06-UPNEXT] repeat all from 1: \(out)")
    XCTAssertEqual(out, [2, 3, 0])
  }

  func testShuffleFollowsTheDrawnOrder() {
    let order = [2, 0, 3, 1]
    let step = { (i: Int) -> Int in
      let at = order.firstIndex(of: i)!
      return at + 1 < order.count ? order[at + 1] : -1
    }
    let out = upNextIndices(current: 0, count: 4, next: step)
    print("[PAR-PLAY-06-UPNEXT] shuffle \(order) from 0: \(out)")
    XCTAssertEqual(out, [3, 1])
  }

  func testAnEmptyQueueHasNothingNext() {
    XCTAssertEqual(upNextIndices(current: -1, count: 0) { _ in -1 }, [])
  }
}

/// PAR-PLAY-06 and PAR-CARD-01 through the iPhone player's queue model: shuffle keeps the song playing and draws the
/// rest, Next and Previous follow Media3's rules (repeat one only holds when a song ends, Previous restarts past 3 s),
/// and songs added while playing land where asked.
final class PlayQueueTests: XCTestCase {
  private var random = SeededRandom(11)

  private func queue(_ count: Int, start: Int) -> PlayQueue<String> {
    var queue = PlayQueue<String>()
    queue.set((0..<count).map { "s\($0)" }, start: start, using: &random)
    return queue
  }

  func testInOrderNextAndEnd() {
    var q = queue(3, start: 1)
    print("[PLAYQUEUE] in order current=\(q.current) next=\(q.nextForNavigation) upNext=\(q.upNext)")
    XCTAssertEqual(q.nextForNavigation, 2)
    XCTAssertEqual(q.upNext, [2])
    q.move(to: 2)
    print("[PLAYQUEUE] at last nextWhenEnded=\(q.nextWhenEnded)")
    XCTAssertEqual(q.nextWhenEnded, -1)
    q.repeatMode = .all
    print("[PLAYQUEUE] repeat all nextWhenEnded=\(q.nextWhenEnded) upNext=\(q.upNext)")
    XCTAssertEqual(q.nextWhenEnded, 0)
    XCTAssertEqual(q.upNext, [0, 1])
  }

  func testRepeatOneHoldsOnlyWhenTheSongEnds() {
    var q = queue(3, start: 0)
    q.repeatMode = .one
    print("[PLAYQUEUE] repeat one ended=\(q.nextWhenEnded) next=\(q.nextForNavigation) upNext=\(q.upNext)")
    XCTAssertEqual(q.nextWhenEnded, 0)
    XCTAssertEqual(q.nextForNavigation, 1)
    XCTAssertEqual(q.upNext, [1, 2])
  }

  func testShuffleOnKeepsTheCurrentSongAndPlaysEveryOtherAfterIt() {
    var q = queue(6, start: 3)
    q.setShuffle(true, using: &random)
    let up = q.upNext
    print("[PLAYQUEUE] shuffle on current=\(q.current) order=\(q.order.order) upNext=\(up)")
    XCTAssertEqual(q.current, 3)
    XCTAssertEqual(q.order.firstIndex, 3)
    XCTAssertEqual(up.sorted(), [0, 1, 2, 4, 5])
    XCTAssertEqual(q.nextForNavigation, up.first)
    // Turning it on again while on does not draw again.
    let before = q.order
    q.setShuffle(true, using: &random)
    XCTAssertEqual(q.order, before)
    q.setShuffle(false, using: &random)
    print("[PLAYQUEUE] shuffle off upNext=\(q.upNext)")
    XCTAssertEqual(q.upNext, [4, 5])
  }

  func testShuffleRepeatAllWrapsToTheDrawnStart() {
    var q = queue(4, start: 0)
    q.setShuffle(true, using: &random)
    q.repeatMode = .all
    q.move(to: q.order.lastIndex)
    print("[PLAYQUEUE] shuffle+all at last=\(q.current) order=\(q.order.order) ended=\(q.nextWhenEnded) upNext=\(q.upNext)")
    XCTAssertEqual(q.nextWhenEnded, q.order.firstIndex)
    XCTAssertEqual(q.upNext.count, 3)
  }

  func testPreviousRestartsPastThreeSeconds() {
    let q = queue(3, start: 1)
    print("[PLAYQUEUE] previous at 2999ms=\(q.previousAction(positionMs: 2_999)) at 3001ms=\(q.previousAction(positionMs: 3_001))")
    XCTAssertEqual(q.previousAction(positionMs: 3_000), .item(0))
    XCTAssertEqual(q.previousAction(positionMs: 3_001), .restart)
    let first = queue(3, start: 0)
    XCTAssertEqual(first.previousAction(positionMs: 0), .restart)
  }

  func testAddNextAndEndWithShuffleOn() {
    var q = queue(4, start: 1)
    q.setShuffle(true, using: &random)
    let before = q.upNext
    q.add(["next"], atEnd: false, using: &random)
    print("[PLAYQUEUE] play next items=\(q.items) current=\(q.current) upNext=\(q.upNext) before=\(before)")
    XCTAssertEqual(q.items[q.nextForNavigation], "next")
    q.add(["end"], atEnd: true, using: &random)
    print("[PLAYQUEUE] add to queue items=\(q.items) upNext=\(q.upNext)")
    XCTAssertEqual(q.items[q.upNext.last!], "end")
    XCTAssertEqual(q.items[q.current], "s1")
  }

  func testAddToAnEmptyQueueStartsIt() {
    var q = PlayQueue<String>()
    let started = q.add(["a", "b"], atEnd: false, using: &random)
    print("[PLAYQUEUE] empty add started=\(started) current=\(q.current) items=\(q.items)")
    XCTAssertTrue(started)
    XCTAssertEqual(q.current, 0)
    XCTAssertEqual(q.count, 2)
  }
}
