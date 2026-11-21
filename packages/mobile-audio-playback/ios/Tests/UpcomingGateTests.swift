import XCTest

/// @req PAR-PLAY-07[parrot]: the iPhone makes the next song's player item only once the playing one is loaded far enough.
final class UpcomingGateTests: XCTestCase {
  func testWaitsWhileThePlayingSongHoldsLessThan30sAhead() {
    XCTAssertFalse(UpcomingGate.ready(ranges: [(0, 20)], positionSeconds: 5, durationSeconds: 240))
    XCTAssertFalse(UpcomingGate.ready(ranges: [(0, 34.9)], positionSeconds: 5, durationSeconds: 240))
  }

  func testLoadsOnce30sAheadAreLoaded() {
    XCTAssertTrue(UpcomingGate.ready(ranges: [(0, 35)], positionSeconds: 5, durationSeconds: 240))
  }

  func testLoadsWhenThePlayingSongIsLoadedToItsEnd() {
    XCTAssertTrue(UpcomingGate.ready(ranges: [(0, 25)], positionSeconds: 5, durationSeconds: 25))
  }

  func testOnlyTheRangeHoldingThePositionCounts() {
    // After a seek: a range far ahead does not mean the position is buffered.
    XCTAssertFalse(UpcomingGate.ready(ranges: [(0, 10), (100, 200)], positionSeconds: 60, durationSeconds: 240))
    XCTAssertTrue(UpcomingGate.ready(ranges: [(0, 10), (55, 100)], positionSeconds: 60, durationSeconds: 240))
  }

  func testNothingLoadedWaits() {
    XCTAssertFalse(UpcomingGate.ready(ranges: [], positionSeconds: 0, durationSeconds: 240))
  }

  func testUnknownDurationNeeds30sAhead() {
    XCTAssertFalse(UpcomingGate.ready(ranges: [(0, 20)], positionSeconds: 0, durationSeconds: .nan))
    XCTAssertTrue(UpcomingGate.ready(ranges: [(0, 30)], positionSeconds: 0, durationSeconds: .nan))
  }

  func testTheLastSecondsLoadTheNextSongWhateverIsBuffered() {
    // The gapless step matters more than the last seconds' buffer: the song is about to end anyway.
    XCTAssertTrue(UpcomingGate.ready(ranges: [], positionSeconds: 231, durationSeconds: 240))
    XCTAssertFalse(UpcomingGate.ready(ranges: [], positionSeconds: 220, durationSeconds: 240))
  }
}
