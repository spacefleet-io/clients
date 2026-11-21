import Compression
import CryptoKit
import Foundation

/// One page of the library op stream, fetched and opened natively (LIB-FMT-13, LIB-SYNC-14; vault v4 plan §1.7):
/// `GET <ops url>?since=<fromVersion>` with `Accept: application/vnd.space.library-ops` answers
///
///     body = frame*, frame = u64be version | u32be length | envelope[length]
///     envelope = iv(12) || AES-256-GCM(00 5A 01 || raw DEFLATE(op JSON), or v1 plain op JSON) || tag(16)
///
/// and the page state in `x-library-*` response headers. Each op is decrypted and inflated here, off the JS thread;
/// JS never sees base64 or compressed bytes. An op whose JSON is small rides back inline as `text`; a large one is
/// streamed to a cache file and handed back as `path` + `sliceEnds` (JS reads it with `readTextSlice`), so no heap
/// ever holds a whole large op as one string. Same contract as Android's `LibrarySyncModule.fetchOpsPage`.
///
/// No React import: the unit-test target compiles this file on its own; `LibrarySyncV4.swift` bridges it.
enum LibraryOpsPage {
  static let contentType = "application/vnd.space.library-ops"
  /// An op at most this many JSON bytes comes back inline...
  static let inlineOpMaxBytes = 256 * 1024
  /// ...while the page's inline text stays at most this many bytes; the rest goes to files.
  static let inlinePageMaxBytes = 4 * 1024 * 1024
  /// Bytes per `readTextSlice` call, cut at UTF-8 character starts (same as `OP_TEXT_SLICE_BYTES` in JS).
  static let sliceBytes = 2 * 1024 * 1024
  private static let outputBufferBytes = 64 * 1024
  private static let frameHeader: [UInt8] = [0x00, 0x5A, 0x01]

  /// Rejection with the bridge's code and message (`HTTP_<status>`, `NETWORK_FAILED`, `BAD_FRAMES`, `OPEN_FAILED`,
  /// `INVALID_KEY`).
  struct PageError: LocalizedError {
    let code: String
    let message: String
    var errorDescription: String? { message }
  }

  struct Head: Equatable {
    var version: Int
    var snapshotVersion: Int
    var hasMore: Bool
    var tooOld: Bool
    var storageFormatVersion: Int
    var opStreamVersion: Int
    var targetOpStreamVersion: Int?
  }

  struct Frame: Equatable {
    let version: Int
    /// Byte range of the envelope in the body.
    let range: Range<Int>
  }

  struct Op {
    let version: Int
    let jsonBytes: Int
    let text: String?
    let path: String?
    let sliceEnds: [Int]?

    var bridge: [String: Any] {
      var out: [String: Any] = ["version": version, "jsonBytes": jsonBytes]
      if let text { out["text"] = text }
      if let path { out["path"] = path }
      if let sliceEnds { out["sliceEnds"] = sliceEnds }
      return out
    }
  }

  struct Page {
    let head: Head
    let ops: [Op]
    let bytes: Int
    let ms: Int

    var bridge: [String: Any] {
      [
        "version": head.version,
        "snapshotVersion": head.snapshotVersion,
        "hasMore": head.hasMore,
        "tooOld": head.tooOld,
        "storageFormatVersion": head.storageFormatVersion,
        "opStreamVersion": head.opStreamVersion,
        "targetOpStreamVersion": head.targetOpStreamVersion.map { $0 as Any } ?? NSNull(),
        "ops": ops.map(\.bridge),
        "bytes": bytes,
        "ms": ms,
      ]
    }
  }

  // MARK: request

  static func request(url: String, headers: [String: String], fromVersion: Int) throws -> URLRequest {
    guard fromVersion >= 0, var components = URLComponents(string: url), components.scheme != nil else {
      throw PageError(code: "INVALID_ARGUMENT", message: "bad ops url or fromVersion")
    }
    components.queryItems = (components.queryItems ?? []) + [URLQueryItem(name: "since", value: String(fromVersion))]
    guard let full = components.url else { throw PageError(code: "INVALID_ARGUMENT", message: "bad ops url") }
    var request = URLRequest(url: full, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 120)
    request.httpMethod = "GET"
    for (name, value) in headers where name.caseInsensitiveCompare("accept") != .orderedSame {
      request.setValue(value, forHTTPHeaderField: name)
    }
    request.setValue(contentType, forHTTPHeaderField: "Accept")
    return request
  }

  // MARK: response

  /// Page state from the response headers; `x-library-has-more` / `x-library-too-old` are `1` / `0`.
  static func head(_ header: (String) -> String?) throws -> Head {
    func int(_ name: String) throws -> Int {
      guard let text = header(name)?.trimmingCharacters(in: .whitespaces), let value = Int(text), value >= 0 else {
        throw PageError(code: "BAD_FRAMES", message: "header \(name) missing or not a number: \(header(name) ?? "nil")")
      }
      return value
    }
    func flag(_ name: String) -> Bool { header(name)?.trimmingCharacters(in: .whitespaces) == "1" }
    return Head(
      version: try int("x-library-version"),
      snapshotVersion: try int("x-library-snapshot-version"),
      hasMore: flag("x-library-has-more"),
      tooOld: flag("x-library-too-old"),
      storageFormatVersion: try int("x-library-storage-format-version"),
      opStreamVersion: try int("x-library-op-stream-version"),
      targetOpStreamVersion: header("x-library-target-op-stream-version") == nil
        ? nil : try int("x-library-target-op-stream-version"))
  }

  /// Splits the body into frames without copying any envelope. Versions must rise; anything left over is an error.
  static func frames(_ body: Data) throws -> [Frame] {
    var frames: [Frame] = []
    try body.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
      var offset = 0
      var previous = 0
      while offset < raw.count {
        guard raw.count - offset >= 12 else {
          throw PageError(code: "BAD_FRAMES", message: "frame header truncated at byte \(offset) of \(raw.count)")
        }
        var version: UInt64 = 0
        for i in 0..<8 { version = version << 8 | UInt64(raw[offset + i]) }
        var length = 0
        for i in 8..<12 { length = length << 8 | Int(raw[offset + i]) }
        let start = offset + 12
        guard version > 0, version <= UInt64(Int.max), Int(version) > previous else {
          throw PageError(code: "BAD_FRAMES", message: "frame version \(version) after \(previous)")
        }
        guard length > 0, raw.count - start >= length else {
          throw PageError(
            code: "BAD_FRAMES", message: "frame \(version): length \(length), \(raw.count - start) bytes left")
        }
        frames.append(Frame(version: Int(version), range: (body.startIndex + start)..<(body.startIndex + start + length)))
        previous = Int(version)
        offset = start + length
      }
    }
    return frames
  }

  // MARK: open

  /// Where one op's JSON goes: memory while it stays within `inlineLimit`, then a file in `directory`. Tracks the
  /// UTF-8 slice ends as bytes pass, with the same cuts as `SnapshotCodec.utf8SliceEnds` / Android's
  /// `Utf8SliceSink`: the first character start at or after every `sliceBytes` step.
  final class OpTextSink {
    private let inlineLimit: Int
    private let directory: URL
    private let sliceBytes: Int
    private var buffer = Data()
    private var handle: FileHandle?
    private(set) var path: String?
    private(set) var written = 0
    private var sliceEnds: [Int] = []
    private var nextCut: Int

    init(inlineLimit: Int, directory: URL, sliceBytes: Int = LibraryOpsPage.sliceBytes) {
      self.inlineLimit = inlineLimit
      self.directory = directory
      self.sliceBytes = sliceBytes
      nextCut = sliceBytes
    }

    func append(_ bytes: UnsafeRawBufferPointer) throws {
      guard !bytes.isEmpty else { return }
      while nextCut < written + bytes.count {
        if bytes[nextCut - written] & 0xC0 != 0x80 {
          sliceEnds.append(nextCut)
          nextCut += sliceBytes
        } else {
          nextCut += 1
        }
      }
      if handle == nil && written + bytes.count > inlineLimit { try spill() }
      if let handle {
        try handle.write(contentsOf: bytes)
      } else {
        buffer.append(bytes.bindMemory(to: UInt8.self))
      }
      written += bytes.count
    }

    private func spill() throws {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      let url = directory.appendingPathComponent("\(UUID().uuidString.lowercased()).json")
      guard FileManager.default.createFile(atPath: url.path, contents: buffer) else {
        throw PageError(code: "OPEN_FAILED", message: "CACHE_WRITE_FAILED")
      }
      path = url.path
      handle = try FileHandle(forWritingTo: url)
      try handle?.seekToEnd()
      buffer = Data()
    }

    /// The finished op. Closes the file; the caller owns (and on failure deletes) `path`.
    func finish(version: Int) throws -> Op {
      if let handle {
        try handle.close()
        self.handle = nil
        return Op(
          version: version, jsonBytes: written, text: nil, path: path,
          sliceEnds: written > 0 ? sliceEnds + [written] : [])
      }
      guard let text = String(data: buffer, encoding: .utf8) else {
        throw PageError(code: "OPEN_FAILED", message: "INVALID_UTF8")
      }
      return Op(version: version, jsonBytes: written, text: text, path: nil, sliceEnds: nil)
    }

    /// Drops a half-written file.
    func discard() {
      try? handle?.close()
      handle = nil
      if let path { try? FileManager.default.removeItem(atPath: path) }
    }
  }

  /// Opens one envelope into `sink`: AES-GCM, then the v2 frame (`00 5A 01` + raw DEFLATE) streamed through
  /// Compression, or a v1 plain JSON payload written through as is. Errors carry the messages the JS reader throws
  /// (`DECRYPT_FAILED`, `corrupt_compressed_frame`, `unknown_compression_codec:N`).
  static func openEnvelope<Envelope: DataProtocol>(_ envelope: Envelope, key: SymmetricKey, into sink: OpTextSink) throws {
    let plain: Data
    do {
      plain = try AES.GCM.open(try AES.GCM.SealedBox(combined: envelope), using: key)
    } catch {
      throw PageError(code: "OPEN_FAILED", message: "DECRYPT_FAILED")
    }
    let framed = plain.count >= frameHeader.count && plain[plain.startIndex] == frameHeader[0]
      && plain[plain.startIndex + 1] == frameHeader[1]
    guard framed else {
      try plain.withUnsafeBytes { try sink.append($0) }
      return
    }
    let codec = plain[plain.startIndex + 2]
    guard codec == frameHeader[2] else {
      throw PageError(code: "OPEN_FAILED", message: "unknown_compression_codec:\(codec)")
    }
    try inflate(plain, from: frameHeader.count, into: sink)
  }

  private static func inflate(_ input: Data, from offset: Int, into sink: OpTextSink) throws {
    let corrupt = PageError(code: "OPEN_FAILED", message: "corrupt_compressed_frame")
    let stream = UnsafeMutablePointer<compression_stream>.allocate(capacity: 1)
    defer { stream.deallocate() }
    guard compression_stream_init(stream, COMPRESSION_STREAM_DECODE, COMPRESSION_ZLIB) == COMPRESSION_STATUS_OK else {
      throw PageError(code: "OPEN_FAILED", message: "COMPRESSION_INIT_FAILED")
    }
    defer { compression_stream_destroy(stream) }
    let output = UnsafeMutableRawPointer.allocate(byteCount: outputBufferBytes, alignment: 1)
    defer { output.deallocate() }
    try input.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
      guard let base = raw.bindMemory(to: UInt8.self).baseAddress, raw.count > offset else { throw corrupt }
      stream.pointee.src_ptr = base + offset
      stream.pointee.src_size = raw.count - offset
      while true {
        stream.pointee.dst_ptr = output.assumingMemoryBound(to: UInt8.self)
        stream.pointee.dst_size = outputBufferBytes
        let status = compression_stream_process(stream, 0)
        if status == COMPRESSION_STATUS_ERROR { throw corrupt }
        let produced = outputBufferBytes - stream.pointee.dst_size
        if produced > 0 { try sink.append(UnsafeRawBufferPointer(start: output, count: produced)) }
        if status == COMPRESSION_STATUS_END { return }
        // All input consumed and nothing produced: the deflate stream is truncated.
        if produced == 0 && stream.pointee.src_size == 0 { throw corrupt }
      }
    }
  }

  /// Opens every frame of a page body. On any failure the files already written for this page are deleted.
  static func openPage(_ body: Data, head: Head, key: SymmetricKey, directory: URL, startedAt: Date) throws -> Page {
    let frames = try frames(body)
    var ops: [Op] = []
    ops.reserveCapacity(frames.count)
    var inlineTotal = 0
    do {
      for frame in frames {
        let sink = OpTextSink(
          inlineLimit: min(inlineOpMaxBytes, max(0, inlinePageMaxBytes - inlineTotal)), directory: directory)
        do {
          try openEnvelope(body[frame.range], key: key, into: sink)
          let op = try sink.finish(version: frame.version)
          if op.text != nil { inlineTotal += op.jsonBytes }
          ops.append(op)
        } catch {
          sink.discard()
          NSLog(
            "[LibrarySync] ops.page.op.failed version=%ld error=%@", frame.version, error.localizedDescription)
          throw error
        }
      }
    } catch {
      for op in ops { if let path = op.path { try? FileManager.default.removeItem(atPath: path) } }
      throw error
    }
    return Page(head: head, ops: ops, bytes: body.count, ms: Int(Date().timeIntervalSince(startedAt) * 1000))
  }

  // MARK: fetch

  /// One page: fetch, check, open. `completion` runs on a background queue.
  static func fetch(
    url: String, headers: [String: String], key: SymmetricKey, fromVersion: Int, directory: URL,
    session: URLSession = .shared, completion: @escaping (Result<Page, Error>) -> Void
  ) {
    let startedAt = Date()
    let request: URLRequest
    do {
      request = try self.request(url: url, headers: headers, fromVersion: fromVersion)
    } catch {
      completion(.failure(error))
      return
    }
    NSLog("[LibrarySync] ops.page.fetch.start since=%ld url=%@", fromVersion, request.url?.absoluteString ?? url)
    session.dataTask(with: request) { data, response, error in
      DispatchQueue.global(qos: .userInitiated).async {
        sweep(directory, olderThan: Date().addingTimeInterval(-staleFileAge))
        completion(
          Result {
            if let error {
              throw PageError(code: "NETWORK_FAILED", message: error.localizedDescription)
            }
            guard let http = response as? HTTPURLResponse else {
              throw PageError(code: "NETWORK_FAILED", message: "no HTTP response")
            }
            let body = data ?? Data()
            guard (200..<300).contains(http.statusCode) else {
              // The body (e.g. 426 `app_update_required`) goes to JS as the message, capped at 64 KiB.
              let text = String(decoding: body.prefix(64 * 1024), as: UTF8.self)
              NSLog("[LibrarySync] ops.page.fetch.http status=%ld body=%@", http.statusCode, String(text.prefix(512)))
              throw PageError(code: "HTTP_\(http.statusCode)", message: text)
            }
            let type = http.value(forHTTPHeaderField: "Content-Type") ?? ""
            guard type.lowercased().hasPrefix(contentType) else {
              throw PageError(code: "BAD_FRAMES", message: "content-type \(type), expected \(contentType)")
            }
            let head = try self.head { http.value(forHTTPHeaderField: $0) }
            let fetchedMs = Int(Date().timeIntervalSince(startedAt) * 1000)
            let page = try openPage(body, head: head, key: key, directory: directory, startedAt: startedAt)
            let files = page.ops.filter { $0.path != nil }.count
            let jsonBytes = page.ops.reduce(0) { $0 + $1.jsonBytes }
            NSLog(
              "[LibrarySync] ops.page.done since=%ld version=%ld ops=%ld inline=%ld files=%ld bytes=%ld jsonBytes=%ld hasMore=%ld tooOld=%ld opStream=%ld target=%@ fetchMs=%ld ms=%ld",
              fromVersion, head.version, page.ops.count, page.ops.count - files, files, body.count, jsonBytes,
              head.hasMore ? 1 : 0, head.tooOld ? 1 : 0, head.opStreamVersion,
              head.targetOpStreamVersion.map(String.init) ?? "none", fetchedMs, page.ms)
            return page
          })
      }
    }.resume()
  }

  /// `<Caches>/library-op-pages`, under the same Caches root the tvOS library lives in (#3452). The files live only
  /// until JS has read them (JS unlinks each one after its last slice).
  static func defaultDirectory() -> URL {
    FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("library-op-pages", isDirectory: true)
  }

  /// A file JS has not unlinked after this long belongs to a page whose apply died; every fetch sweeps them.
  static let staleFileAge: TimeInterval = 60 * 60

  /// Deletes the page files in `directory` last modified before `cutoff`; returns how many went. Runs at module
  /// start (cutoff = start − 2 s: what a previous process left) and on every fetch (cutoff = now − 1 h).
  @discardableResult
  static func sweep(_ directory: URL = defaultDirectory(), olderThan cutoff: Date) -> Int {
    let manager = FileManager.default
    guard
      let names = try? manager.contentsOfDirectory(
        at: directory, includingPropertiesForKeys: [.contentModificationDateKey], options: [.skipsHiddenFiles])
    else { return 0 }
    var removed = 0
    for url in names where url.pathExtension == "json" {
      let modified = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
      if let modified, modified < cutoff, (try? manager.removeItem(at: url)) != nil { removed += 1 }
    }
    if removed > 0 { NSLog("[LibrarySync] ops.page.sweep removed=%ld dir=%@", removed, directory.path) }
    return removed
  }
}
