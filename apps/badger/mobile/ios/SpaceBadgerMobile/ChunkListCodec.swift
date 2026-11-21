import CryptoKit
import Foundation

/// Packed chunk lists (LIB-FMT-11), the Swift port of `packages/library-db-definition/src/chunkLists.ts`. Same bytes
/// as the TS, Kotlin and Python codecs: `packages/library-db-definition/test-vectors/chunk-lists.json` is the contract
/// (`SpaceBadgerLibraryTests/ChunkListCodecTests.swift` runs every vector). Any change edits the vectors first.
///
///   - `sizes`: one unsigned LEB128 varint per chunk holding `sizeBytes + 1`; `0` = size unknown.
///   - `starts`: nil when no chunk has a start time; else one varint per chunk: `0` = no start, else
///     `zigzag(ms - previousMs) + 1` (`ms` = start rounded to whole ms, `previousMs` = last chunk that had one, 0 first).
///   - key mode 0: UTF-8 key texts joined by `\n`. Mode 1: 16 raw UUID bytes per chunk, key i =
///     `media/<placementId>/<uuid i>`. Mode 2: a 16-byte seed, key i = `media/<placementId>/` + UUID text of the first
///     16 bytes of HMAC-SHA256(seed, "chunk:" || u32be(i)).
///
/// No React import: the unit-test target compiles this file on its own.
struct ChunkListFormatError: LocalizedError, Equatable {
  let message: String
  var errorDescription: String? { "CHUNK_LIST_FORMAT: \(message)" }
}

/// One chunk as players and `MediaDetails` see it.
struct ChunkRef: Equatable {
  let key: String
  let sizeBytes: Int64?
  let startSeconds: Double?
}

/// A packed list in memory and in `media_chunk_lists` (minus the owner columns and `updated_at`).
struct PackedChunkList: Equatable {
  var placementId: String
  var keyMode: Int
  var keyData: Data
  var count: Int
  var sizes: Data
  var starts: Data?
}

enum ChunkListCodec {
  static let keyModeTexts = 0
  static let keyModeUuidBytes = 1
  static let keyModeSeed = 2
  static let ownerKindFormat = 1
  static let ownerKindAudioTrack = 2
  static let seedBytes = 16

  private static let hexDigits = Array("0123456789abcdef".utf8)
  /// JS `Number.MAX_SAFE_INTEGER`: the TS codec refuses anything above it, so this one does too.
  private static let maxSafeInteger: UInt64 = (1 << 53) - 1

  // MARK: varints

  static func appendVarint(_ out: inout Data, _ value: UInt64) throws {
    guard value <= maxSafeInteger else { throw ChunkListFormatError(message: "varint out of range: \(value)") }
    var v = value
    while v >= 0x80 {
      out.append(UInt8(v & 0x7F) | 0x80)
      v >>= 7
    }
    out.append(UInt8(v))
  }

  static func readVarints(_ bytes: Data, count: Int, field: String) throws -> [UInt64] {
    var values: [UInt64] = []
    values.reserveCapacity(count)
    var offset = bytes.startIndex
    for i in 0..<count {
      var value: UInt64 = 0
      var shift: UInt64 = 0
      while true {
        guard offset < bytes.endIndex else {
          throw ChunkListFormatError(message: "\(field): \(i) of \(count) values, bytes ran out")
        }
        let byte = bytes[offset]
        offset += 1
        value |= UInt64(byte & 0x7F) << shift
        if byte < 0x80 { break }
        shift += 7
        // Same bound as the TS reader (`scale > 2 ** 56`): at most 9 bytes per value.
        if shift > 56 { throw ChunkListFormatError(message: "\(field): varint \(i) too long") }
      }
      values.append(value)
    }
    guard offset == bytes.endIndex else {
      throw ChunkListFormatError(message: "\(field): \(bytes.endIndex - offset) bytes left after \(count) values")
    }
    return values
  }

  private static func zigzag(_ n: Int64) -> UInt64 { n >= 0 ? UInt64(n) * 2 : UInt64(-(n + 1)) * 2 + 1 }
  private static func unzigzag(_ z: UInt64) -> Int64 { z % 2 == 0 ? Int64(z / 2) : -Int64((z - 1) / 2) - 1 }

  /// JS `Math.round`: halves go up (toward +infinity), unlike Swift's `.toNearestOrAwayFromZero`.
  private static func jsRound(_ x: Double) -> Double {
    let floor = x.rounded(.down)
    return x - floor >= 0.5 ? floor + 1 : floor
  }

  static func encodeSizes(_ sizes: [Int64?]) throws -> Data {
    var out = Data()
    out.reserveCapacity(sizes.count * 3)
    for size in sizes {
      guard let size else {
        out.append(0)
        continue
      }
      guard size >= 0 else { throw ChunkListFormatError(message: "varint out of range: \(size + 1)") }
      try appendVarint(&out, UInt64(size) + 1)
    }
    return out
  }

  static func decodeSizes(_ bytes: Data, count: Int) throws -> [Int64?] {
    try readVarints(bytes, count: count, field: "sizes").map { $0 == 0 ? nil : Int64($0 - 1) }
  }

  static func encodeStarts(_ starts: [Double?]) throws -> Data? {
    if starts.allSatisfy({ $0 == nil }) { return nil }
    var out = Data()
    out.reserveCapacity(starts.count * 3)
    var previousMs: Int64 = 0
    for start in starts {
      guard let start else {
        out.append(0)
        continue
      }
      guard start.isFinite else { throw ChunkListFormatError(message: "start not finite: \(start)") }
      let ms = Int64(jsRound(start * 1000))
      try appendVarint(&out, zigzag(ms - previousMs) + 1)
      previousMs = ms
    }
    return out
  }

  static func decodeStarts(_ bytes: Data?, count: Int) throws -> [Double?] {
    guard let bytes else { return Array(repeating: nil, count: count) }
    var previousMs: Int64 = 0
    return try readVarints(bytes, count: count, field: "starts").map { v in
      if v == 0 { return nil }
      previousMs += unzigzag(v - 1)
      return Double(previousMs) / 1000
    }
  }

  // MARK: keys

  /// `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`, lowercase hex only (an uppercase one would not round-trip).
  private static func isLowercaseUuid(_ text: Substring) -> Bool {
    let bytes = Array(text.utf8)
    guard bytes.count == 36 else { return false }
    for (i, b) in bytes.enumerated() {
      if i == 8 || i == 13 || i == 18 || i == 23 {
        if b != UInt8(ascii: "-") { return false }
      } else if !((b >= 0x30 && b <= 0x39) || (b >= 0x61 && b <= 0x66)) {
        return false
      }
    }
    return true
  }

  private static func hexValue(_ b: UInt8) -> UInt8 { b <= 0x39 ? b - 0x30 : b - 0x61 + 10 }

  private static func appendUuidBytes(_ uuid: Substring, to out: inout Data) {
    let hex = uuid.utf8.filter { $0 != UInt8(ascii: "-") }
    var i = hex.startIndex
    while i < hex.endIndex {
      out.append(hexValue(hex[i]) << 4 | hexValue(hex[i + 1]))
      i += 2
    }
  }

  private static func uuidText<C: Collection>(_ bytes: C) -> String where C.Element == UInt8 {
    var out: [UInt8] = []
    out.reserveCapacity(36)
    for (i, byte) in bytes.prefix(16).enumerated() {
      if i == 4 || i == 6 || i == 8 || i == 10 { out.append(UInt8(ascii: "-")) }
      out.append(hexDigits[Int(byte >> 4)])
      out.append(hexDigits[Int(byte & 15)])
    }
    return String(decoding: out, as: UTF8.self)
  }

  /// `media/<placement>/<name>` with exactly two non-empty segments after `media/` (TS `MEDIA_KEY`).
  private static func splitMediaKey(_ key: String) -> (placement: Substring, name: Substring)? {
    guard key.hasPrefix("media/") else { return nil }
    let rest = key.dropFirst(6)
    let parts = rest.split(separator: "/", omittingEmptySubsequences: false)
    guard parts.count == 2, !parts[0].isEmpty, !parts[1].isEmpty else { return nil }
    return (parts[0], parts[1])
  }

  /// Key of chunk `index` of a key-mode-2 list.
  static func seedChunkKey(seed: Data, placementId: String, index: Int) throws -> String {
    guard seed.count == seedBytes else { throw ChunkListFormatError(message: "seed must be 16 bytes, got \(seed.count)") }
    guard index >= 0, index <= 0xFFFF_FFFF else { throw ChunkListFormatError(message: "chunk index out of range: \(index)") }
    var message = Data("chunk:".utf8)
    withUnsafeBytes(of: UInt32(index).bigEndian) { message.append(contentsOf: $0) }
    let mac = HMAC<SHA256>.authenticationCode(for: message, using: SymmetricKey(data: seed))
    return "media/\(placementId)/\(uuidText(Array(mac)))"
  }

  /// Every key of a list, in chunk order.
  static func keys(_ list: PackedChunkList) throws -> [String] {
    guard list.count >= 0 else { throw ChunkListFormatError(message: "bad count \(list.count)") }
    switch list.keyMode {
    case keyModeTexts:
      if list.count == 0 {
        guard list.keyData.isEmpty else { throw ChunkListFormatError(message: "key texts present for an empty list") }
        return []
      }
      guard let text = String(data: list.keyData, encoding: .utf8) else {
        throw ChunkListFormatError(message: "key texts are not UTF-8")
      }
      let keys = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
      guard keys.count == list.count else {
        throw ChunkListFormatError(message: "key texts: \(keys.count) keys for count \(list.count)")
      }
      return keys
    case keyModeUuidBytes:
      guard list.keyData.count == list.count * 16 else {
        throw ChunkListFormatError(message: "uuid bytes: \(list.keyData.count) bytes for count \(list.count)")
      }
      let bytes = [UInt8](list.keyData)
      return (0..<list.count).map { i in "media/\(list.placementId)/\(uuidText(bytes[(i * 16)..<(i * 16 + 16)]))" }
    case keyModeSeed:
      return try (0..<list.count).map { try seedChunkKey(seed: list.keyData, placementId: list.placementId, index: $0) }
    default:
      throw ChunkListFormatError(message: "unknown key mode \(list.keyMode)")
    }
  }

  // MARK: pack / unpack

  /// Packs explicit keys (conversion of old rows): key mode 1 when every key is `media/<one placement>/<lowercase
  /// uuid>`, so it round-trips byte for byte; key mode 0 otherwise. Never mode 2.
  static func pack(_ chunks: [ChunkRef]) throws -> PackedChunkList {
    let sizes = try encodeSizes(chunks.map(\.sizeBytes))
    let starts = try encodeStarts(chunks.map(\.startSeconds))
    var placements = Set<Substring>()
    var allUuidKeys = !chunks.isEmpty
    for chunk in chunks {
      if let parts = splitMediaKey(chunk.key) {
        placements.insert(parts.placement)
        if !isLowercaseUuid(parts.name) { allUuidKeys = false }
      } else {
        placements.insert("")
        allUuidKeys = false
      }
    }
    let placementId = placements.count == 1 ? String(placements.first!) : ""
    if allUuidKeys && !placementId.isEmpty {
      var keyData = Data(capacity: chunks.count * 16)
      for chunk in chunks { appendUuidBytes(splitMediaKey(chunk.key)!.name, to: &keyData) }
      return PackedChunkList(
        placementId: placementId, keyMode: keyModeUuidBytes, keyData: keyData, count: chunks.count, sizes: sizes,
        starts: starts)
    }
    for chunk in chunks where chunk.key.contains("\n") {
      throw ChunkListFormatError(message: "chunk key contains a line break: \(chunk.key)")
    }
    return PackedChunkList(
      placementId: placementId, keyMode: keyModeTexts, keyData: Data(chunks.map(\.key).joined(separator: "\n").utf8),
      count: chunks.count, sizes: sizes, starts: starts)
  }

  /// Packs a list whose keys derive from a seed (key mode 2).
  static func packSeeded(placementId: String, seed: Data, sizes: [Int64?], starts: [Double?]) throws -> PackedChunkList {
    guard seed.count == seedBytes else { throw ChunkListFormatError(message: "seed must be 16 bytes, got \(seed.count)") }
    guard !placementId.isEmpty, !placementId.contains("/") else {
      throw ChunkListFormatError(message: "bad placement id \(placementId)")
    }
    guard sizes.count == starts.count else {
      throw ChunkListFormatError(message: "sizes (\(sizes.count)) and starts (\(starts.count)) differ in length")
    }
    return PackedChunkList(
      placementId: placementId, keyMode: keyModeSeed, keyData: seed, count: sizes.count,
      sizes: try encodeSizes(sizes), starts: try encodeStarts(starts))
  }

  static func unpack(_ list: PackedChunkList) throws -> [ChunkRef] {
    let keys = try keys(list)
    let sizes = try decodeSizes(list.sizes, count: list.count)
    let starts = try decodeStarts(list.starts, count: list.count)
    return keys.indices.map { ChunkRef(key: keys[$0], sizeBytes: sizes[$0], startSeconds: starts[$0]) }
  }

  // MARK: JSON (op stream 4)

  static func toJson(_ list: PackedChunkList) -> [String: Any] {
    [
      "placementId": list.placementId,
      "keyMode": list.keyMode,
      "keyData": list.keyData.base64EncodedString(),
      "count": list.count,
      "sizes": list.sizes.base64EncodedString(),
      "starts": list.starts.map { $0.base64EncodedString() as Any } ?? NSNull(),
    ]
  }

  /// An integral JSON number (not a bool) within JS's safe range.
  private static func integer(_ value: Any?) -> Int? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
    let double = number.doubleValue
    guard double.isFinite, double == double.rounded(), abs(double) <= Double(maxSafeInteger) else { return nil }
    return Int(double)
  }

  private static func base64(_ value: String, _ field: String) throws -> Data {
    guard let data = Data(base64Encoded: value) else { throw ChunkListFormatError(message: "\(field) is not base64") }
    return data
  }

  static func fromJson(_ json: Any?) throws -> PackedChunkList {
    guard let json = json as? [String: Any] else { throw ChunkListFormatError(message: "chunk list is not an object") }
    guard let placementId = json["placementId"] as? String else { throw ChunkListFormatError(message: "placementId missing") }
    guard let keyMode = integer(json["keyMode"]), (0...2).contains(keyMode) else {
      throw ChunkListFormatError(message: "unknown key mode \(String(describing: json["keyMode"] ?? "nil"))")
    }
    guard let count = integer(json["count"]), count >= 0 else {
      throw ChunkListFormatError(message: "bad count \(String(describing: json["count"] ?? "nil"))")
    }
    guard let keyData = json["keyData"] as? String, let sizes = json["sizes"] as? String else {
      throw ChunkListFormatError(message: "keyData/sizes must be base64 text")
    }
    let startsValue = json["starts"]
    let starts: Data?
    // Absent is an error, as in the TS reader: a writer always sends `starts`, null when no chunk has one.
    if startsValue is NSNull {
      starts = nil
    } else if let text = startsValue as? String {
      starts = try base64(text, "starts")
    } else {
      throw ChunkListFormatError(message: "starts must be base64 text or null")
    }
    let list = PackedChunkList(
      placementId: placementId, keyMode: keyMode, keyData: try base64(keyData, "keyData"), count: count,
      sizes: try base64(sizes, "sizes"), starts: starts)
    if list.keyMode == keyModeSeed && list.keyData.count != seedBytes {
      throw ChunkListFormatError(message: "seed must be 16 bytes, got \(list.keyData.count)")
    }
    return list
  }
}
