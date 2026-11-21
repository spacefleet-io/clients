import Foundation

/// One stored piece of a `ChunkedFile`: the SFV1 object `objectKey` decrypts to the plaintext bytes
/// `[plainOffset, plainOffset + plainSize)`.
struct ChunkRef: Equatable {
  let objectKey: String
  let plainOffset: Int
  let plainSize: Int
}

/// The part of one chunk a byte range covers: `length` bytes from `offsetInChunk` of chunk `index`.
struct ChunkSlice: Equatable {
  let index: Int
  let offsetInChunk: Int
  let length: Int
}

/// A file stored whole but cut into plaintext chunks, each its own encrypted object (Parrot track files, PAR-FMT-01: fixed
/// 1 MiB pieces of the original audio file, the last one shorter). The proxy serves it at `/playback/chunked/{id}` and maps
/// every `Range:` request onto the chunks it covers (`slices`), so a player seeking in a long FLAC fetches and decrypts only
/// the 1 MiB pieces around the new position. Port of the Kotlin `ChunkedFile.kt` (JVM-tested there): change them together.
///
/// The chunk list must tile the file exactly: sorted by offset (the initializer sorts), starting at 0, no gap and no
/// overlap, ending at `sizeBytes`. Anything else is refused at registration (`chunked_file_invalid: …`), never discovered
/// mid-playback. `slices` and `indexOf` are pure functions of the chunk list: no I/O, no locking.
struct ChunkedFile {
  let id: String
  let mime: String
  let sizeBytes: Int
  let chunks: [ChunkRef]

  init(id: String, mime: String, sizeBytes: Int, chunks: [ChunkRef]) throws {
    let sorted = chunks.sorted { $0.plainOffset < $1.plainOffset }
    guard !id.isEmpty else { throw TunnelError(message: "chunked_file_invalid: empty id") }
    guard sizeBytes > 0 else { throw TunnelError(message: "chunked_file_invalid: sizeBytes=\(sizeBytes) id=\(id)") }
    guard !sorted.isEmpty else { throw TunnelError(message: "chunked_file_invalid: no chunks id=\(id)") }
    var expected = 0
    for (i, c) in sorted.enumerated() {
      guard c.plainSize > 0 else {
        throw TunnelError(message: "chunked_file_invalid: chunk \(i) plainSize=\(c.plainSize) id=\(id)")
      }
      guard c.plainOffset == expected else {
        throw TunnelError(message: "chunked_file_invalid: chunk \(i) plainOffset=\(c.plainOffset) expected=\(expected) id=\(id)")
      }
      expected += c.plainSize
    }
    guard expected == sizeBytes else {
      throw TunnelError(message: "chunked_file_invalid: chunks end at \(expected), sizeBytes=\(sizeBytes) id=\(id)")
    }
    self.id = id
    self.mime = mime
    self.sizeBytes = sizeBytes
    self.chunks = sorted
  }

  /// The chunk slices covering the inclusive byte range `start...endInclusive`, in file order; their lengths add up to
  /// `endInclusive - start + 1`. The range must lie inside the file (the HTTP layer clamps it first with `HttpRange`).
  func slices(start: Int, endInclusive: Int) throws -> [ChunkSlice] {
    guard start >= 0, start <= endInclusive, endInclusive < sizeBytes else {
      throw TunnelError(message: "range_outside_file: \(start)-\(endInclusive)/\(sizeBytes)")
    }
    var out: [ChunkSlice] = []
    var i = indexOf(start)
    var pos = start
    while pos <= endInclusive {
      let c = chunks[i]
      let from = pos - c.plainOffset
      let until = min(c.plainSize, endInclusive - c.plainOffset + 1)
      out.append(ChunkSlice(index: i, offsetInChunk: from, length: until - from))
      pos = c.plainOffset + until
      i += 1
    }
    return out
  }

  /// Index of the chunk holding byte `offset` (binary search over the sorted, contiguous offsets).
  func indexOf(_ offset: Int) -> Int {
    var lo = 0
    var hi = chunks.count - 1
    while lo < hi {
      let mid = (lo + hi + 1) / 2
      if chunks[mid].plainOffset <= offset { lo = mid } else { hi = mid - 1 }
    }
    return lo
  }

  /// `{ id, mime, sizeBytes, chunks: [{ objectKey, plainOffset, plainSize }] }`, as JS `MediaProxy.registerChunkedFile`
  /// sends it. A missing `mime` is `application/octet-stream`; any other missing field is `chunked_file_json_invalid: <field>`.
  static func fromJson(_ json: String) throws -> ChunkedFile {
    guard let o = try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any] else {
      throw TunnelError(message: "chunked_file_json_invalid: not an object")
    }
    guard let id = o["id"] as? String else { throw TunnelError(message: "chunked_file_json_invalid: id") }
    guard let size = (o["sizeBytes"] as? NSNumber)?.int64Value else {
      throw TunnelError(message: "chunked_file_json_invalid: sizeBytes")
    }
    guard let arr = o["chunks"] as? [[String: Any]] else { throw TunnelError(message: "chunked_file_json_invalid: chunks") }
    let chunks = try arr.enumerated().map { i, c -> ChunkRef in
      guard let key = c["objectKey"] as? String,
        let offset = (c["plainOffset"] as? NSNumber)?.int64Value,
        let plainSize = (c["plainSize"] as? NSNumber)?.int64Value
      else { throw TunnelError(message: "chunked_file_json_invalid: chunk \(i)") }
      return ChunkRef(objectKey: key, plainOffset: Int(offset), plainSize: Int(plainSize))
    }
    let mime = (o["mime"] as? String) ?? "application/octet-stream"
    return try ChunkedFile(id: id, mime: mime, sizeBytes: Int(size), chunks: chunks)
  }
}

/// A parsed `Range:` header against an object of a known length: `start...end` inclusive.
struct ByteRange: Equatable {
  let start: Int
  let end: Int
  let isRange: Bool
  var invalid = false
}

/// Port of the Kotlin `HttpRange` (same file there): change them together.
enum HttpRange {
  private static let pattern = try! NSRegularExpression(pattern: "bytes=(\\d*)-(\\d*)")

  /// `bytes=N-M`, `bytes=N-` and the suffix form `bytes=-K` (the last K bytes). No header or an unparseable one serves the
  /// whole object (200); a start at or past the end, or an end before the start, is 416 (`invalid`). An end past the
  /// object is clamped to its last byte.
  static func parse(_ header: String?, total: Int) -> ByteRange {
    let whole = ByteRange(start: 0, end: total - 1, isRange: false)
    guard let header, !header.isEmpty else { return whole }
    let ns = header as NSString
    guard let m = pattern.firstMatch(in: header, range: NSRange(location: 0, length: ns.length)) else { return whole }
    let startStr = ns.substring(with: m.range(at: 1))
    let endStr = ns.substring(with: m.range(at: 2))
    if startStr.isEmpty {
      guard let suffix = Int(endStr) else { return whole }
      if suffix <= 0 || total <= 0 { return ByteRange(start: 0, end: -1, isRange: false, invalid: true) }
      return ByteRange(start: max(0, total - suffix), end: total - 1, isRange: true)
    }
    guard let start = Int(startStr) else { return ByteRange(start: 0, end: total - 1, isRange: false, invalid: true) }
    var end = endStr.isEmpty ? total - 1 : (Int(endStr) ?? (total - 1))
    if start > end || start >= total { return ByteRange(start: start, end: end, isRange: false, invalid: true) }
    if end >= total { end = total - 1 }
    return ByteRange(start: start, end: end, isRange: true)
  }
}

/// The `ChunkedFile`s the proxy serves, by id. A registered id's file can be swapped for another (Parrot settles which copy
/// of a queued song plays, PAR-PLAY-02) only until the player first asks for that id: from then on the id keeps its file,
/// so a song never changes copy midway (PAR-PLAY-04). Thread-safe. Port of the Kotlin `ChunkedFileRegistry`.
final class ChunkedFileRegistry {
  private let lock = NSLock()
  private var files: [String: ChunkedFile] = [:]
  /// Registered ids the player has asked for: their file no longer changes.
  private var started = Set<String>()

  /// Serves `file` at its id; registering the same id again replaces it and opens it to `swap` again.
  func register(_ file: ChunkedFile) {
    lock.lock()
    defer { lock.unlock() }
    files[file.id] = file
    started.remove(file.id)
  }

  /// Serves `file` at its already registered id instead, unless the player already asked for it. True when swapped.
  func swap(_ file: ChunkedFile) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    if started.contains(file.id) || files[file.id] == nil { return false }
    files[file.id] = file
    return true
  }

  /// The file the player gets at `id`, nil when none; from now on that id keeps this file.
  func serve(_ id: String) -> ChunkedFile? {
    lock.lock()
    defer { lock.unlock() }
    guard let file = files[id] else { return nil }
    started.insert(id)
    return file
  }

  /// The file registered at `id` now, nil when none; unlike `serve` the id stays open to `swap` (loading a song's
  /// opening ahead is not the player asking, PAR-PLAY-07).
  func peek(_ id: String) -> ChunkedFile? {
    lock.lock()
    defer { lock.unlock() }
    return files[id]
  }

  /// Forgets `id`; false when it was not registered.
  func unregister(_ id: String) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    started.remove(id)
    return files.removeValue(forKey: id) != nil
  }

  func clear() {
    lock.lock()
    defer { lock.unlock() }
    files.removeAll()
    started.removeAll()
  }
}
