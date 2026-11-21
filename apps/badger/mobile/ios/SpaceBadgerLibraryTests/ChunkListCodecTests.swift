import Foundation
import XCTest

/// @test-id MOBILE-LIB-CHUNKLIST-SWIFT-001
/// @level unit
/// @req LIB-FMT-11
/// @why The phone and TV pack and read chunk lists natively (the conversion of LIB-FMT-12 runs in Swift on iOS/tvOS),
///   so the Swift codec must produce and read the exact bytes the TS, Kotlin and Python codecs do, or a list packed on
///   one device names the wrong chunks on another. `packages/library-db-definition/test-vectors/chunk-lists.json` is
///   the shared contract: every explicit, seeded, seed-key and invalid vector runs here unchanged.
///   Run: `xcodebuild test -project apps/badger/mobile/ios/SpaceBadgerMobile.xcodeproj -scheme SpaceBadgerLibraryTests
///   -destination 'platform=iOS Simulator,name=<sim>'`.
final class ChunkListCodecTests: XCTestCase {
  private let tag = "[MOBILE-LIB-CHUNKLIST-SWIFT-001]"

  private func log(_ phase: String, _ data: String = "") { print("\(tag) \(phase) \(data)") }

  /// The repo's vectors, found from this file's own path (the simulator reads the host file system), or from
  /// `CHUNK_LIST_VECTORS` (`TEST_RUNNER_CHUNK_LIST_VECTORS` through xcodebuild).
  static func vectors() throws -> [String: Any] {
    let override = ProcessInfo.processInfo.environment["CHUNK_LIST_VECTORS"]
    let url = override.map { URL(fileURLWithPath: $0) }
      ?? URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()  // SpaceBadgerLibraryTests
      .deletingLastPathComponent()  // ios
      .deletingLastPathComponent()  // mobile
      .deletingLastPathComponent()  // badger
      .deletingLastPathComponent()  // apps
      .deletingLastPathComponent()  // repo root
      .appendingPathComponent("packages/library-db-definition/test-vectors/chunk-lists.json")
    print("[MOBILE-LIB-CHUNKLIST-SWIFT-001] vectors.path \(url.path)")
    let data = try Data(contentsOf: url)
    return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
  }

  static func hex(_ data: Data?) -> String? { data.map { $0.map { String(format: "%02x", $0) }.joined() } }

  static func bytes(hex: String) -> Data {
    var out = Data()
    var index = hex.startIndex
    while index < hex.endIndex {
      let next = hex.index(index, offsetBy: 2)
      out.append(UInt8(hex[index..<next], radix: 16)!)
      index = next
    }
    return out
  }

  private func int64(_ value: Any?) -> Int64? { (value as? NSNumber).map { $0.int64Value } }
  private func double(_ value: Any?) -> Double? { (value as? NSNumber).map { $0.doubleValue } }

  /// The list's fields against `expected` (hex blobs, JSON object, keys, decoded starts).
  private func assertMatches(_ list: PackedChunkList, _ expected: [String: Any], _ name: String) throws {
    log("assert", "\(name) keyMode=\(list.keyMode) count=\(list.count) placement=\(list.placementId) keyData=\(list.keyData.count)B sizes=\(Self.hex(list.sizes) ?? "") starts=\(Self.hex(list.starts) ?? "null")")
    XCTAssertEqual(list.placementId, expected["placementId"] as? String, "\(name) placementId")
    XCTAssertEqual(list.keyMode, (expected["keyMode"] as? NSNumber)?.intValue, "\(name) keyMode")
    XCTAssertEqual(list.count, (expected["count"] as? NSNumber)?.intValue, "\(name) count")
    XCTAssertEqual(Self.hex(list.keyData), expected["keyDataHex"] as? String, "\(name) keyData")
    XCTAssertEqual(Self.hex(list.sizes), expected["sizesHex"] as? String, "\(name) sizes")
    XCTAssertEqual(Self.hex(list.starts), expected["startsHex"] as? String, "\(name) starts")

    let json = try XCTUnwrap(expected["json"] as? [String: Any], "\(name) json")
    let ours = ChunkListCodec.toJson(list)
    for field in ["placementId", "keyData", "sizes"] {
      XCTAssertEqual(ours[field] as? String, json[field] as? String, "\(name) json.\(field)")
    }
    XCTAssertEqual(ours["keyMode"] as? Int, (json["keyMode"] as? NSNumber)?.intValue, "\(name) json.keyMode")
    XCTAssertEqual(ours["count"] as? Int, (json["count"] as? NSNumber)?.intValue, "\(name) json.count")
    XCTAssertEqual(ours["starts"] as? String, json["starts"] as? String, "\(name) json.starts")
    XCTAssertEqual(ours["starts"] is NSNull, json["starts"] is NSNull, "\(name) json.starts null")

    // The expected JSON reads back to the same list (what a v4 reader does with an op).
    XCTAssertEqual(try ChunkListCodec.fromJson(json), list, "\(name) fromJson")

    let keys = try ChunkListCodec.keys(list)
    XCTAssertEqual(keys, expected["keys"] as? [String], "\(name) keys")
    let decoded = try ChunkListCodec.decodeStarts(list.starts, count: list.count)
    let expectedStarts = try XCTUnwrap(expected["decodedStarts"] as? [Any], "\(name) decodedStarts")
    XCTAssertEqual(decoded.count, expectedStarts.count, "\(name) decodedStarts count")
    for (i, value) in expectedStarts.enumerated() where i < decoded.count {
      XCTAssertEqual(decoded[i], value is NSNull ? nil : double(value), "\(name) decodedStarts[\(i)]")
    }
  }

  func testExplicitVectors() throws {
    let cases = try XCTUnwrap(Self.vectors()["explicit"] as? [[String: Any]])
    log("explicit.start", "cases=\(cases.count)")
    XCTAssertFalse(cases.isEmpty)
    for vector in cases {
      let name = vector["name"] as? String ?? "?"
      let input = try XCTUnwrap((vector["input"] as? [String: Any])?["chunks"] as? [[String: Any]], name)
      let chunks = input.map { chunk in
        ChunkRef(
          key: chunk["key"] as? String ?? "",
          sizeBytes: chunk["sizeBytes"] is NSNull ? nil : int64(chunk["sizeBytes"]),
          startSeconds: chunk["startSeconds"] is NSNull ? nil : double(chunk["startSeconds"]))
      }
      let list = try ChunkListCodec.pack(chunks)
      try assertMatches(list, try XCTUnwrap(vector["expected"] as? [String: Any]), name)
      // Unpacking gives the input back: keys and sizes exactly, starts to the millisecond.
      let unpacked = try ChunkListCodec.unpack(list)
      XCTAssertEqual(unpacked.map(\.key), chunks.map(\.key), "\(name) unpack keys")
      XCTAssertEqual(unpacked.map(\.sizeBytes), chunks.map(\.sizeBytes), "\(name) unpack sizes")
      log("explicit.ok", name)
    }
  }

  func testSeededVectors() throws {
    let cases = try XCTUnwrap(Self.vectors()["seeded"] as? [[String: Any]])
    log("seeded.start", "cases=\(cases.count)")
    XCTAssertFalse(cases.isEmpty)
    for vector in cases {
      let name = vector["name"] as? String ?? "?"
      let input = try XCTUnwrap(vector["input"] as? [String: Any], name)
      let list = try ChunkListCodec.packSeeded(
        placementId: try XCTUnwrap(input["placementId"] as? String),
        seed: Self.bytes(hex: try XCTUnwrap(input["seedHex"] as? String)),
        sizes: try XCTUnwrap(input["sizes"] as? [Any]).map { $0 is NSNull ? nil : int64($0) },
        starts: try XCTUnwrap(input["starts"] as? [Any]).map { $0 is NSNull ? nil : double($0) })
      try assertMatches(list, try XCTUnwrap(vector["expected"] as? [String: Any]), name)
      log("seeded.ok", name)
    }
  }

  func testSeedKeyVectors() throws {
    let cases = try XCTUnwrap(Self.vectors()["seedKeys"] as? [[String: Any]])
    log("seedKeys.start", "cases=\(cases.count)")
    XCTAssertFalse(cases.isEmpty)
    for vector in cases {
      let key = try ChunkListCodec.seedChunkKey(
        seed: Self.bytes(hex: try XCTUnwrap(vector["seedHex"] as? String)),
        placementId: try XCTUnwrap(vector["placementId"] as? String),
        index: try XCTUnwrap((vector["index"] as? NSNumber)?.intValue))
      log("seedKeys.case", "index=\(vector["index"] ?? "?") key=\(key)")
      XCTAssertEqual(key, vector["key"] as? String)
    }
  }

  func testInvalidVectorsAreRejected() throws {
    let cases = try XCTUnwrap(Self.vectors()["invalid"] as? [[String: Any]])
    log("invalid.start", "cases=\(cases.count)")
    XCTAssertFalse(cases.isEmpty)
    for vector in cases {
      let name = vector["name"] as? String ?? "?"
      do {
        let list = try ChunkListCodec.fromJson(vector["json"])
        let chunks = try ChunkListCodec.unpack(list)
        XCTFail("\(name): decoded \(chunks.count) chunks, expected a ChunkListFormatError")
      } catch let error as ChunkListFormatError {
        log("invalid.ok", "\(name): \(error.errorDescription ?? "")")
      }
    }
  }
}
