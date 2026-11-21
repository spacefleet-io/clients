import CryptoKit
import Foundation
import XCTest

/// @test-id MOBILE-LIB-OPS-PAGE-SWIFT-LANE-001
/// @level integration
/// @req LIB-SYNC-15
/// @req LIB-FMT-13
/// @why The unit tests build their own frames; this one reads a real API's binary changes answer (the
///   `application/vnd.space.library-ops` GET of `/library/db/ops`) page by page with the same code the bridge calls,
///   and checks that a switched account refuses a read without `x-library-op-stream-version` with 426
///   `app_update_required`. Skipped unless a lane is given (xcodebuild passes `TEST_RUNNER_<NAME>` as `<NAME>`):
///   `LIB_OPS_LANE_URL` (ops URL, e.g. `http://127.0.0.1:8200/library/db/ops`), `LIB_OPS_LANE_TOKEN` (bearer),
///   `LIB_OPS_LANE_KEY` (base64 library key), optional `LIB_OPS_LANE_EXPECT_SWITCHED=1`.
final class LibraryOpsPageLaneTests: XCTestCase {
  private let tag = "[MOBILE-LIB-OPS-PAGE-SWIFT-LANE-001]"

  private func log(_ phase: String, _ data: String = "") { print("\(tag) \(phase) \(data)") }

  private func fetch(
    _ url: String, headers: [String: String], key: SymmetricKey, since: Int, directory: URL
  ) -> Result<LibraryOpsPage.Page, Error> {
    let done = expectation(description: "page since \(since)")
    var result: Result<LibraryOpsPage.Page, Error>!
    LibraryOpsPage.fetch(url: url, headers: headers, key: key, fromVersion: since, directory: directory) {
      result = $0
      done.fulfill()
    }
    wait(for: [done], timeout: 180)
    return result
  }

  func testReadsEveryPageFromTheLane() throws {
    let env = ProcessInfo.processInfo.environment
    guard let url = env["LIB_OPS_LANE_URL"], let token = env["LIB_OPS_LANE_TOKEN"], let keyBase64 = env["LIB_OPS_LANE_KEY"]
    else { throw XCTSkip("no lane (LIB_OPS_LANE_URL / _TOKEN / _KEY)") }
    let key = SymmetricKey(data: try XCTUnwrap(Data(base64Encoded: keyBase64)))
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("ops-lane-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    // The headers the JS caller hands the bridge: bearer, app scope (`x-space-app`, required on library routes), op stream.
    let scope = ["Authorization": "Bearer \(token)", "x-space-app": "badger"]
    let headers = scope.merging(["x-library-op-stream-version": "4"]) { $1 }

    var since = 0
    var pages = 0
    var ops = 0
    var files = 0
    var bytes = 0
    var jsonBytes = 0
    var totalMs = 0
    while true {
      let page = try fetch(url, headers: headers, key: key, since: since, directory: directory).get()
      if page.head.tooOld && since < page.head.snapshotVersion {
        // Ops below the snapshot are compacted away; a client loads the snapshot and reads on from its version.
        log("tooOld", "since=\(since) snapshotVersion=\(page.head.snapshotVersion) version=\(page.head.version)")
        XCTAssertTrue(page.ops.isEmpty)
        since = page.head.snapshotVersion
        continue
      }
      pages += 1
      ops += page.ops.count
      bytes += page.bytes
      totalMs += page.ms
      for op in page.ops {
        jsonBytes += op.jsonBytes
        XCTAssertGreaterThan(op.version, since)
        if let text = op.text {
          // Each op is a JSON object.
          XCTAssertNotNil(try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any], "op \(op.version)")
        } else {
          let path = try XCTUnwrap(op.path)
          let data = try Data(contentsOf: URL(fileURLWithPath: path))
          XCTAssertEqual(data.count, op.jsonBytes)
          XCTAssertEqual(op.sliceEnds?.last, op.jsonBytes)
          XCTAssertNotNil(try? JSONSerialization.jsonObject(with: data) as? [String: Any], "file op \(op.version)")
          files += 1
          try FileManager.default.removeItem(atPath: path)
        }
        since = op.version
      }
      log(
        "page",
        "n=\(pages) ops=\(page.ops.count) inline=\(page.ops.filter { $0.text != nil }.count) bytes=\(page.bytes) ms=\(page.ms) version=\(page.head.version) hasMore=\(page.head.hasMore) tooOld=\(page.head.tooOld) opStream=\(page.head.opStreamVersion) target=\(page.head.targetOpStreamVersion.map(String.init) ?? "nil")"
      )
      XCTAssertFalse(page.head.tooOld)
      if !page.head.hasMore || page.ops.isEmpty { break }
    }
    log("done", "pages=\(pages) ops=\(ops) files=\(files) bytes=\(bytes) jsonBytes=\(jsonBytes) ms=\(totalMs)")
    XCTAssertGreaterThan(ops, 0, "the lane account has no ops")

    if env["LIB_OPS_LANE_EXPECT_SWITCHED"] == "1" {
      let refused = fetch(url, headers: scope, key: key, since: 0, directory: directory)
      guard case .failure(let error as LibraryOpsPage.PageError) = refused else {
        return XCTFail("a read without x-library-op-stream-version was not refused")
      }
      log("refused", "\(error.code) \(error.message)")
      XCTAssertEqual(error.code, "HTTP_426")
      XCTAssertTrue(error.message.contains("app_update_required"))
    }
  }
}
