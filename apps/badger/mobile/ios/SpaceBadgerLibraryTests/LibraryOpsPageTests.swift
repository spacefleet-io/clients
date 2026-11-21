import Compression
import CryptoKit
import Foundation
import XCTest

/// Serves one canned answer to `LibraryOpsPage.fetch` and records the request it saw.
final class StubOpsProtocol: URLProtocol {
  static var status = 200
  static var headers: [String: String] = [:]
  static var body = Data()
  static var lastRequest: URLRequest?

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    Self.lastRequest = request
    let response = HTTPURLResponse(url: request.url!, statusCode: Self.status, httpVersion: "HTTP/1.1", headerFields: Self.headers)!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Self.body)
    client?.urlProtocolDidFinishLoading(self)
  }

  override func stopLoading() {}
}

/// @test-id MOBILE-LIB-OPS-PAGE-SWIFT-001
/// @level unit
/// @req LIB-SYNC-15
/// @req LIB-FMT-13
/// @why The phone spent 9,388 ms of script-thread time per ~3 MB page of changes (LibrarySyncUx op9 proof,
///   2026-11-21), because base64, inflate and UTF-8 ran in Hermes. iOS/tvOS now fetch the binary page and open every
///   op natively (`LibraryOpsPage`), handing JS only JSON text or a cache file with UTF-8 slice ends. These tests pin
///   the frame parsing, both envelope versions, the error messages the JS reader already expects, the inline/file
///   split, the slice cuts (never inside a UTF-8 character), the cleanup of a failed page, and the request/426 path.
final class LibraryOpsPageTests: XCTestCase {
  private let tag = "[MOBILE-LIB-OPS-PAGE-SWIFT-001]"
  private let key = SymmetricKey(data: Data((0..<32).map { UInt8($0) }))
  private var directory: URL!

  private func log(_ phase: String, _ data: String = "") { print("\(tag) \(phase) \(data)") }

  override func setUpWithError() throws {
    directory = FileManager.default.temporaryDirectory.appendingPathComponent("ops-page-\(UUID().uuidString)")
    log("setUp", directory.path)
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: directory)
  }

  private func filesLeft() -> [String] {
    (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
  }

  /// Raw DEFLATE, the same stream `node:zlib` deflateRaw / fflate write (Apple's COMPRESSION_ZLIB has no header).
  private func deflateRaw(_ input: Data) -> Data {
    let capacity = input.count + 1024
    var out = Data(count: capacity)
    let written = out.withUnsafeMutableBytes { dst in
      input.withUnsafeBytes { src in
        compression_encode_buffer(
          dst.bindMemory(to: UInt8.self).baseAddress!, capacity,
          src.bindMemory(to: UInt8.self).baseAddress!, input.count, nil, COMPRESSION_ZLIB)
      }
    }
    precondition(written > 0)
    return out.prefix(written)
  }

  private func seal(_ plain: Data, key: SymmetricKey? = nil) throws -> Data {
    try XCTUnwrap(AES.GCM.seal(plain, using: key ?? self.key).combined)
  }

  /// A v2 envelope: `00 5A 01` + raw DEFLATE(json), sealed.
  private func envelopeV2(_ json: String) throws -> Data {
    try seal(Data([0x00, 0x5A, 0x01]) + deflateRaw(Data(json.utf8)))
  }

  private func frame(_ version: UInt64, _ envelope: Data) -> Data {
    var out = Data()
    for shift in stride(from: 56, through: 0, by: -8) { out.append(UInt8(truncatingIfNeeded: version >> UInt64(shift))) }
    let length = UInt32(envelope.count)
    for shift in stride(from: 24, through: 0, by: -8) { out.append(UInt8(truncatingIfNeeded: length >> UInt32(shift))) }
    return out + envelope
  }

  private let head = LibraryOpsPage.Head(
    version: 9, snapshotVersion: 2, hasMore: false, tooOld: false, storageFormatVersion: 2, opStreamVersion: 4,
    targetOpStreamVersion: 4)

  /// JSON of about `bytes` bytes whose text has multi-byte characters everywhere (so slice cuts land mid-character
  /// unless the cut logic moves them).
  private func bigJson(_ bytes: Int) -> String {
    var s = "{\"op\":\"media.upsert\",\"title\":\""
    let unit = "é€😀a"  // 2 + 3 + 4 + 1 bytes
    s.reserveCapacity(bytes + 64)
    while s.utf8.count < bytes { s += unit }
    return s + "\"}"
  }

  private func code(_ error: Error) -> String { (error as? LibraryOpsPage.PageError).map { "\($0.code):\($0.message)" } ?? "\(error)" }

  func testFramesSplitAndRejectBadBodies() throws {
    let body = frame(3, Data([1, 2, 3])) + frame(7, Data([4]))
    let frames = try LibraryOpsPage.frames(body)
    log("frames", "\(frames)")
    XCTAssertEqual(frames.map(\.version), [3, 7])
    XCTAssertEqual(body[frames[0].range], Data([1, 2, 3]))
    XCTAssertEqual(body[frames[1].range], Data([4]))
    XCTAssertEqual(try LibraryOpsPage.frames(Data()).count, 0)

    let bad: [(String, Data)] = [
      ("truncated header", frame(3, Data([1])).prefix(8)),
      ("truncated envelope", frame(3, Data([1, 2, 3])).dropLast()),
      ("same version", frame(3, Data([1])) + frame(3, Data([2]))),
      ("falling version", frame(5, Data([1])) + frame(4, Data([2]))),
      ("version zero", frame(0, Data([1]))),
      ("empty envelope", frame(3, Data())),
    ]
    for (name, body) in bad {
      XCTAssertThrowsError(try LibraryOpsPage.frames(Data(body)), name) { error in
        log("frames.bad", "\(name) -> \(code(error))")
        XCTAssertEqual((error as? LibraryOpsPage.PageError)?.code, "BAD_FRAMES", name)
      }
    }
  }

  func testOpensV2AndV1EnvelopesInline() throws {
    let v2 = "{\"op\":\"media.file.playback.set\",\"name\":\"héllo €\"}"
    let v1 = "{\"op\":\"media.episode.delete\"}"
    let body = frame(5, try envelopeV2(v2)) + frame(6, try seal(Data(v1.utf8)))
    let page = try LibraryOpsPage.openPage(body, head: head, key: key, directory: directory, startedAt: Date())
    log("inline", "ops=\(page.ops.map { "\($0.version):\($0.jsonBytes):\($0.text ?? "nil")" }) bytes=\(page.bytes)")
    XCTAssertEqual(page.ops.map(\.version), [5, 6])
    XCTAssertEqual(page.ops.map(\.text), [v2, v1])
    XCTAssertEqual(page.ops.map(\.jsonBytes), [v2.utf8.count, v1.utf8.count])
    XCTAssertEqual(page.ops.compactMap(\.path), [])
    XCTAssertEqual(page.bytes, body.count)
    XCTAssertTrue(filesLeft().isEmpty)

    let bridge = page.bridge
    XCTAssertEqual(bridge["version"] as? Int, 9)
    XCTAssertEqual(bridge["targetOpStreamVersion"] as? Int, 4)
    XCTAssertEqual((bridge["ops"] as? [[String: Any]])?.first?["text"] as? String, v2)
    XCTAssertNil((bridge["ops"] as? [[String: Any]])?.first?["path"])
  }

  func testLargeOpGoesToFileWithUtf8SliceEnds() throws {
    let json = bigJson(5 * 1024 * 1024 + 17)
    let bytes = Data(json.utf8)
    let small = "{\"op\":\"small\"}"
    let body = frame(10, try envelopeV2(json)) + frame(11, try envelopeV2(small))
    let started = Date()
    let page = try LibraryOpsPage.openPage(body, head: head, key: key, directory: directory, startedAt: started)
    log("file", "jsonBytes=\(bytes.count) compressed=\(body.count) ms=\(page.ms)")
    let op = page.ops[0]
    XCTAssertNil(op.text)
    let path = try XCTUnwrap(op.path)
    XCTAssertTrue(path.hasPrefix(directory.path))
    XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: path)), bytes)
    let ends = try XCTUnwrap(op.sliceEnds)
    log("file.sliceEnds", "\(ends)")
    XCTAssertEqual(ends.last, bytes.count)
    var previous = 0
    for (i, end) in ends.enumerated() {
      XCTAssertGreaterThan(end, previous)
      if end < bytes.count {
        // Same cuts as SnapshotCodec's Utf8SliceSink: the first character start at or after previous cut + step.
        XCTAssertGreaterThanOrEqual(end - previous, LibraryOpsPage.sliceBytes, "slice \(i) shorter than a step")
        XCTAssertLessThan(end - previous, LibraryOpsPage.sliceBytes + 4, "slice \(i) cut too far after its step")
        XCTAssertNotEqual(bytes[end] & 0xC0, 0x80, "cut \(i) at \(end) inside a character")
      }
      // Every slice decodes on its own.
      XCTAssertNotNil(String(data: bytes[previous..<end], encoding: .utf8), "slice \(i)")
      previous = end
    }
    XCTAssertEqual(ends.count, 3)
    XCTAssertEqual(page.ops[1].text, small, "a small op after a file op stays inline")
    let bridgeOp = try XCTUnwrap((page.bridge["ops"] as? [[String: Any]])?.first)
    XCTAssertEqual(bridgeOp["path"] as? String, path)
    XCTAssertEqual(bridgeOp["sliceEnds"] as? [Int], ends)
    XCTAssertNil(bridgeOp["text"])
  }

  /// Feeds `bytes` to a file sink in odd-sized pieces (so a character also straddles an append boundary).
  private func sliceEnds(_ bytes: Data) throws -> [Int] {
    let sink = LibraryOpsPage.OpTextSink(inlineLimit: 0, directory: directory)
    var offset = 0
    while offset < bytes.count {
      let end = min(bytes.count, offset + 65_537)
      try bytes[offset..<end].withUnsafeBytes { try sink.append($0) }
      offset = end
    }
    let op = try sink.finish(version: 1)
    XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: try XCTUnwrap(op.path))), bytes)
    return try XCTUnwrap(op.sliceEnds)
  }

  func testSliceCutsMoveOffACharacterStraddlingTheMark() throws {
    let mark = LibraryOpsPage.sliceBytes
    // A 3-byte € starting at mark − 1: bytes mark and mark + 1 are continuations, the cut lands at mark + 2.
    var euro = Data(repeating: 0x61, count: mark - 1)
    euro += Data("€".utf8)
    euro += Data(repeating: 0x62, count: 100)
    let euroEnds = try sliceEnds(euro)
    log("straddle.euro", "\(euroEnds)")
    XCTAssertEqual(euroEnds, [mark + 2, euro.count])

    // A 4-byte emoji whose last byte sits on the mark (bytes mark − 3 ... mark): the cut lands right after it.
    var emoji = Data(repeating: 0x61, count: mark - 3)
    emoji += Data("😀".utf8)
    emoji += Data(repeating: 0x62, count: 100)
    let emojiEnds = try sliceEnds(emoji)
    log("straddle.emoji", "\(emojiEnds)")
    XCTAssertEqual(emojiEnds, [mark + 1, emoji.count])

    // A character start exactly on the mark: cut at the mark; nothing past it: one slice only.
    XCTAssertEqual(try sliceEnds(Data(repeating: 0x61, count: mark + 5)), [mark, mark + 5])
    XCTAssertEqual(try sliceEnds(Data(repeating: 0x61, count: mark)), [mark])
  }

  func testSweepDeletesOnlyFilesOlderThanTheCutoff() throws {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let old = directory.appendingPathComponent("old.json")
    let fresh = directory.appendingPathComponent("fresh.json")
    let other = directory.appendingPathComponent("keep.txt")
    for url in [old, fresh, other] { FileManager.default.createFile(atPath: url.path, contents: Data("{}".utf8)) }
    let twoHoursAgo = Date().addingTimeInterval(-2 * 60 * 60)
    for url in [old, other] {
      try FileManager.default.setAttributes([.modificationDate: twoHoursAgo], ofItemAtPath: url.path)
    }
    let removed = LibraryOpsPage.sweep(directory, olderThan: Date().addingTimeInterval(-LibraryOpsPage.staleFileAge))
    log("sweep", "removed=\(removed) left=\(filesLeft().sorted())")
    XCTAssertEqual(removed, 1)
    XCTAssertEqual(filesLeft().sorted(), ["fresh.json", "keep.txt"])
    // Module start: everything a previous process left (older than start − 2 s) goes; a missing directory is fine.
    XCTAssertEqual(LibraryOpsPage.sweep(directory, olderThan: Date().addingTimeInterval(5)), 1)
    XCTAssertEqual(LibraryOpsPage.sweep(directory.appendingPathComponent("missing"), olderThan: Date()), 0)
  }

  func testInlineBudgetPerOpAndPerPage() throws {
    // 300 KiB > 256 KiB per-op limit: file.
    let over = String(repeating: "x", count: 300 * 1024)
    // 20 ops of 250 KiB = 5,000 KiB: the first 16 (4,000 KiB) fit the 4 MiB page budget, later ones go to files
    // until a small op fits the rest again.
    let near = String(repeating: "y", count: 250 * 1024)
    var body = frame(1, try envelopeV2(over))
    for v in 2...21 { body += frame(UInt64(v), try envelopeV2(near)) }
    body += frame(22, try envelopeV2("{}"))
    let page = try LibraryOpsPage.openPage(body, head: head, key: key, directory: directory, startedAt: Date())
    let kinds = page.ops.map { $0.text == nil ? "F" : "I" }.joined()
    let inlineTotal = page.ops.filter { $0.text != nil }.reduce(0) { $0 + $1.jsonBytes }
    log("budget", "kinds=\(kinds) inlineTotal=\(inlineTotal) files=\(filesLeft().count)")
    XCTAssertEqual(kinds, "F" + String(repeating: "I", count: 16) + String(repeating: "F", count: 4) + "I")
    XCTAssertLessThanOrEqual(inlineTotal, LibraryOpsPage.inlinePageMaxBytes)
    XCTAssertEqual(filesLeft().count, 5)
  }

  func testOpenErrorsUseTheJsMessagesAndDeleteThePagesFiles() throws {
    let big = bigJson(LibraryOpsPage.inlineOpMaxBytes + 10)
    let cases: [(String, Data, String)] = [
      ("wrong key", try seal(Data("{}".utf8), key: SymmetricKey(size: .bits256)), "OPEN_FAILED:DECRYPT_FAILED"),
      ("tampered", { var e = try! self.seal(Data("{}".utf8)); e[e.count - 1] ^= 1; return e }(), "OPEN_FAILED:DECRYPT_FAILED"),
      ("unknown codec", try seal(Data([0x00, 0x5A, 0x07, 1, 2])), "OPEN_FAILED:unknown_compression_codec:7"),
      ("corrupt deflate", try seal(Data([0x00, 0x5A, 0x01, 0xFF, 0xFF, 0xFF, 0xFF])), "OPEN_FAILED:corrupt_compressed_frame"),
      ("truncated deflate", try seal(Data([0x00, 0x5A, 0x01]) + deflateRaw(Data(big.utf8)).prefix(200)), "OPEN_FAILED:corrupt_compressed_frame"),
      ("bad utf8", try seal(Data([0x7B, 0xFF, 0x7D])), "OPEN_FAILED:INVALID_UTF8"),
    ]
    for (name, envelope, expected) in cases {
      // A file op first: the failure must delete it too.
      let body = frame(1, try envelopeV2(big)) + frame(2, envelope)
      XCTAssertThrowsError(
        try LibraryOpsPage.openPage(body, head: head, key: key, directory: directory, startedAt: Date()), name
      ) { error in
        log("error", "\(name) -> \(code(error))")
        XCTAssertEqual(code(error), expected, name)
      }
      XCTAssertEqual(filesLeft(), [], "\(name) left files")
    }
  }

  func testHeadReadsLibraryHeaders() throws {
    let headers = [
      "x-library-version": "42", "x-library-snapshot-version": "40", "x-library-has-more": "1",
      "x-library-too-old": "0", "x-library-storage-format-version": "2", "x-library-op-stream-version": "4",
    ]
    let parsed = try LibraryOpsPage.head { headers[$0] }
    log("head", "\(parsed)")
    XCTAssertEqual(
      parsed,
      LibraryOpsPage.Head(
        version: 42, snapshotVersion: 40, hasMore: true, tooOld: false, storageFormatVersion: 2, opStreamVersion: 4,
        targetOpStreamVersion: nil))
    var withTarget = headers
    withTarget["x-library-target-op-stream-version"] = "4"
    XCTAssertEqual(try LibraryOpsPage.head { withTarget[$0] }.targetOpStreamVersion, 4)
    var missing = headers
    missing["x-library-version"] = nil
    XCTAssertThrowsError(try LibraryOpsPage.head { missing[$0] })
  }

  private func stubSession() -> URLSession {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [StubOpsProtocol.self]
    return URLSession(configuration: config)
  }

  private func fetch(_ url: String, headers: [String: String] = [:]) -> Result<LibraryOpsPage.Page, Error> {
    let done = expectation(description: "fetch")
    var result: Result<LibraryOpsPage.Page, Error>!
    LibraryOpsPage.fetch(
      url: url, headers: headers, key: key, fromVersion: 8, directory: directory, session: stubSession()
    ) {
      result = $0
      done.fulfill()
    }
    wait(for: [done], timeout: 30)
    return result
  }

  func testFetchSendsSinceAndAcceptAndOpensThePage() throws {
    StubOpsProtocol.status = 200
    StubOpsProtocol.headers = [
      "Content-Type": "application/vnd.space.library-ops", "x-library-version": "9",
      "x-library-snapshot-version": "2", "x-library-has-more": "0", "x-library-too-old": "0",
      "x-library-storage-format-version": "2", "x-library-op-stream-version": "4",
      "x-library-target-op-stream-version": "4",
    ]
    StubOpsProtocol.body = frame(9, try envelopeV2("{\"a\":1}"))
    let result = fetch(
      "https://api.example.test/library/db/ops?client=ios",
      headers: ["Authorization": "Bearer t", "accept": "application/json", "x-library-op-stream-version": "4"])
    let page = try result.get()
    let request = try XCTUnwrap(StubOpsProtocol.lastRequest)
    log("fetch", "url=\(request.url?.absoluteString ?? "") headers=\(request.allHTTPHeaderFields ?? [:]) ops=\(page.ops.count)")
    XCTAssertEqual(request.url?.absoluteString, "https://api.example.test/library/db/ops?client=ios&since=8")
    XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "application/vnd.space.library-ops")
    XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer t")
    XCTAssertEqual(request.value(forHTTPHeaderField: "x-library-op-stream-version"), "4")
    XCTAssertEqual(page.head, head)
    XCTAssertEqual(page.ops.map(\.text), ["{\"a\":1}"])
  }

  func testFetchRejectsHttpErrorsWithTheBodyAndWrongContentType() throws {
    StubOpsProtocol.status = 426
    StubOpsProtocol.headers = ["Content-Type": "application/json"]
    let upgrade = "{\"error\":\"app_update_required\",\"opStreamVersion\":4}"
    StubOpsProtocol.body = Data(upgrade.utf8)
    let failed = fetch("https://api.example.test/library/db/ops")
    guard case .failure(let error) = failed else { return XCTFail("426 resolved") }
    log("fetch.426", code(error))
    XCTAssertEqual(code(error), "HTTP_426:\(upgrade)")

    StubOpsProtocol.status = 200
    StubOpsProtocol.body = Data("{\"ops\":[]}".utf8)
    guard case .failure(let typeError) = fetch("https://api.example.test/library/db/ops") else {
      return XCTFail("JSON answer resolved")
    }
    log("fetch.json", code(typeError))
    XCTAssertEqual((typeError as? LibraryOpsPage.PageError)?.code, "BAD_FRAMES")
  }
}
