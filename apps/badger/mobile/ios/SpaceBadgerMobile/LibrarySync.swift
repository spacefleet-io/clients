import Compression
import CryptoKit
import Foundation
import React

/// iOS counterpart of the Android `LibrarySyncModule` (apps/badger/mobile/android/.../LibrarySyncModule.kt).
/// Same JS contract (`src/native/LibrarySync.ts`): saved-copy (snapshot) encrypt/decrypt, whole-file + per-chunk
/// SHA-256, and the storage-tunnel `upload.data` frame builder, all off the JS thread.
///
/// Wire format of an encrypted file is `iv(12) || ciphertext || tag(16)` (AES-256-GCM), which is exactly
/// CryptoKit's `AES.GCM.SealedBox.combined`.
@objc(LibrarySync)
final class LibrarySync: RCTEventEmitter {
  /// Written on RN's observer thread, read from `run`'s background queue.
  private var hasListeners = false
  private let listenersLock = NSLock()

  private struct SyncError: LocalizedError {
    let code: String
    var errorDescription: String? { code }
  }

  override class func requiresMainQueueSetup() -> Bool { false }

  override func supportedEvents() -> [String]! { ["librarySyncProgress"] }

  override func startObserving() {
    listenersLock.lock()
    hasListeners = true
    listenersLock.unlock()
  }

  override func stopObserving() {
    listenersLock.lock()
    hasListeners = false
    listenersLock.unlock()
  }

  private func emitProgress(_ stage: String, bytesRead: Int, totalBytes: Int) {
    listenersLock.lock()
    let listening = hasListeners
    listenersLock.unlock()
    guard listening else { return }
    let pct = totalBytes <= 0 ? 0.0 : Double(bytesRead) / Double(totalBytes) * 100.0
    sendEvent(
      withName: "librarySyncProgress",
      body: ["stage": stage, "bytesRead": bytesRead, "totalBytes": totalBytes, "pct": pct]
    )
  }

  private func run(
    _ failureCode: String,
    _ resolve: @escaping RCTPromiseResolveBlock,
    _ reject: @escaping RCTPromiseRejectBlock,
    _ work: @escaping () throws -> Any
  ) {
    DispatchQueue.global(qos: .userInitiated).async {
      do {
        resolve(try work())
      } catch {
        NSLog("[LibrarySync] %@ failed: %@", failureCode, error.localizedDescription)
        reject(failureCode, error.localizedDescription, error)
      }
    }
  }

  private func key(from keyBase64: String) throws -> SymmetricKey {
    guard
      let raw = Data(base64Encoded: keyBase64.trimmingCharacters(in: .whitespacesAndNewlines)),
      raw.count == 32
    else { throw SyncError(code: "INVALID_KEY") }
    return SymmetricKey(data: raw)
  }

  /// JS numbers arrive as Doubles; `Int(_:)` traps on NaN/infinite/out-of-range values.
  private func nonNegativeInt(_ value: Double) throws -> Int {
    guard value.isFinite, value >= 0, value < Double(Int.max) else { throw SyncError(code: "INVALID_ARGUMENT") }
    return Int(value)
  }

  private func snapshotResult(_ result: SnapshotCodec.Result, startedAt: Date) -> [String: Any] {
    [
      "dbBytes": result.dbBytes,
      "storedBytes": result.storedBytes,
      "compressed": result.compressed,
      "ms": Int(Date().timeIntervalSince(startedAt) * 1000),
    ]
  }

  /// SQLite file -> saved copy of the library (LIB-FMT-07 v2), on a background queue (LIB-SYNC-14): the database
  /// never crosses into JS.
  @objc(encryptSnapshotFile:keyBase64:outputPath:resolve:reject:)
  func encryptSnapshotFile(
    _ dbPath: String, keyBase64: String, outputPath: String,
    resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock
  ) {
    run("ENCRYPT_FAILED", resolve, reject) {
      let startedAt = Date()
      NSLog("[LibrarySync] snapshot.encrypt.start db=%@ output=%@", dbPath, outputPath)
      let result = try SnapshotCodec.encrypt(
        source: dbPath, key: try self.key(from: keyBase64), target: outputPath
      ) { stage, done, total in self.emitProgress(stage, bytesRead: done, totalBytes: total) }
      NSLog("[LibrarySync] snapshot.encrypt.done dbBytes=%d storedBytes=%d", result.dbBytes, result.storedBytes)
      return self.snapshotResult(result, startedAt: startedAt)
    }
  }

  /// Saved copy (v2 framed or v1 plain) -> SQLite file, decrypted and inflated on a background queue.
  @objc(decryptSnapshotFile:keyBase64:dbPath:resolve:reject:)
  func decryptSnapshotFile(
    _ sourcePath: String, keyBase64: String, dbPath: String,
    resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock
  ) {
    run("DECRYPT_FAILED", resolve, reject) {
      let startedAt = Date()
      NSLog("[LibrarySync] snapshot.decrypt.start source=%@ db=%@", sourcePath, dbPath)
      let result = try SnapshotCodec.decrypt(
        source: sourcePath, key: try self.key(from: keyBase64), target: dbPath
      ) { stage, done, total in self.emitProgress(stage, bytesRead: done, totalBytes: total) }
      NSLog(
        "[LibrarySync] snapshot.decrypt.done storedBytes=%d dbBytes=%d compressed=%d",
        result.storedBytes, result.dbBytes, result.compressed ? 1 : 0)
      return self.snapshotResult(result, startedAt: startedAt)
    }
  }

  /// One stored library change (base64 envelope) -> its JSON text, opened on a background queue (LIB-SYNC-14).
  /// Rejects with `DECRYPT_FAILED` for a wrong key or broken envelope, otherwise with the frame error
  /// (`corrupt_compressed_frame`, `unknown_compression_codec:N`): the messages the JS reader throws.
  @objc(openOpPayload:keyBase64:resolve:reject:)
  func openOpPayload(
    _ payloadBase64: String, keyBase64: String,
    resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.global(qos: .userInitiated).async {
      let startedAt = Date()
      do {
        guard let envelope = Data(base64Encoded: payloadBase64) else { throw SyncError(code: "DECRYPT_FAILED") }
        let json = try SnapshotCodec.openPayload(envelope, key: try self.key(from: keyBase64))
        guard let text = String(data: json, encoding: .utf8) else { throw SyncError(code: "INVALID_UTF8") }
        NSLog(
          "[LibrarySync] op.open.done storedBytes=%d jsonBytes=%d ms=%d", envelope.count, json.count,
          Int(Date().timeIntervalSince(startedAt) * 1000))
        resolve(text)
      } catch let error as SnapshotCodec.CodecError {
        NSLog("[LibrarySync] op.open.failed %@", error.code)
        reject("OPEN_FAILED", error.code, error)
      } catch {
        NSLog("[LibrarySync] op.open.failed %@", error.localizedDescription)
        reject("OPEN_FAILED", "DECRYPT_FAILED", error)
      }
    }
  }

  private static func hex(_ digest: SHA256.Digest) -> String {
    digest.map { String(format: "%02x", $0) }.joined()
  }

  /// SHA-256 of a whole file plus, when `chunkSize > 0`, of every consecutive `chunkSize`-byte slice of it.
  @objc(sha256File:chunkSize:resolve:reject:)
  func sha256File(
    _ sourcePath: String, chunkSize: Double,
    resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock
  ) {
    run("SHA256_FAILED", resolve, reject) {
      guard FileManager.default.fileExists(atPath: sourcePath) else { throw SyncError(code: "SOURCE_MISSING") }
      let handle = try FileHandle(forReadingFrom: URL(fileURLWithPath: sourcePath))
      defer { try? handle.close() }
      let chunkBytes = try self.nonNegativeInt(chunkSize)
      var whole = SHA256()
      var chunk = SHA256()
      var chunkFilled = 0
      var total = 0
      var chunks: [[String: Any]] = []
      let emitChunk = {
        chunks.append(["size": chunkFilled, "hash": LibrarySync.hex(chunk.finalize())])
        chunk = SHA256()
        chunkFilled = 0
      }
      while let buffer = try handle.read(upToCount: 64 * 1024), !buffer.isEmpty {
        whole.update(data: buffer)
        total += buffer.count
        if chunkBytes <= 0 { continue }
        var pos = 0
        while pos < buffer.count {
          let take = min(buffer.count - pos, chunkBytes - chunkFilled)
          chunk.update(data: buffer.subdata(in: pos..<(pos + take)))
          chunkFilled += take
          pos += take
          if chunkFilled == chunkBytes { emitChunk() }
        }
      }
      if chunkBytes > 0 && chunkFilled > 0 { emitChunk() }
      return ["size": total, "hash": LibrarySync.hex(whole.finalize()), "chunks": chunks]
    }
  }

  /// Builds one storage-tunnel `upload.data` frame ("SFV1" + u32 BE metadata length + metadata JSON +
  /// ciphertext) from a slice of a file and parks it in React Native's blob store, returning only the blob id.
  @objc(buildUploadFrameBlob:offset:length:uploadId:seq:resolve:reject:)
  func buildUploadFrameBlob(
    _ sourcePath: String, offset: Double, length: Double, uploadId: String, seq: Double,
    resolve: @escaping RCTPromiseResolveBlock, reject: @escaping RCTPromiseRejectBlock
  ) {
    run("UPLOAD_FRAME_FAILED", resolve, reject) {
      guard let blobModule = self.bridge?.module(forName: "BlobModule") as? NSObject,
        blobModule.responds(to: NSSelectorFromString("store:"))
      else { throw SyncError(code: "BLOB_MODULE_UNAVAILABLE") }
      let sliceLength = try self.nonNegativeInt(length)
      let sliceOffset = try self.nonNegativeInt(offset)
      let frameSeq = try self.nonNegativeInt(seq)
      let handle = try FileHandle(forReadingFrom: URL(fileURLWithPath: sourcePath))
      defer { try? handle.close() }
      try handle.seek(toOffset: UInt64(sliceOffset))
      guard let slice = try handle.read(upToCount: sliceLength), slice.count == sliceLength else {
        throw SyncError(code: "SHORT_READ")
      }
      let metadata = try JSONSerialization.data(withJSONObject: [
        "frame": [
          "kind": "upload.data",
          "uploadId": uploadId,
          "seq": frameSeq,
          "checksum": "sha256:" + LibrarySync.hex(SHA256.hash(data: slice)),
          "ciphertextLength": sliceLength,
        ] as [String: Any]
      ])
      var message = Data("SFV1".utf8)
      withUnsafeBytes(of: UInt32(metadata.count).bigEndian) { message.append(contentsOf: $0) }
      message.append(metadata)
      message.append(slice)
      guard
        let blobId = blobModule.perform(NSSelectorFromString("store:"), with: message)?
          .takeUnretainedValue() as? String
      else { throw SyncError(code: "BLOB_STORE_FAILED") }
      return ["blobId": blobId, "size": message.count]
    }
  }
}

/// A saved copy of the library on disk (storage format v2, LIB-FMT-07), same bytes as Android's `SnapshotCodec.kt`:
///
///     stored = iv(12) || AES-256-GCM(frame) || tag(16)
///     frame  = 00 5A 01 || raw DEFLATE (RFC 1951) of the SQLite file
///
/// `COMPRESSION_ZLIB` is raw DEFLATE, the stream every reader inflates (desktop `node:zlib`, `fflate`, Android
/// `Inflater(nowrap)`). Compression streams from the memory-mapped file; CryptoKit has no streaming GCM, so the
/// compressed frame (a fraction of the database) is sealed and opened in one shot. Decrypt also reads a v1 copy
/// (no frame) and writes it through unchanged. Output goes to `<target>.partial`, then is renamed over `target`.
enum SnapshotCodec {
  struct Result {
    let dbBytes: Int
    let storedBytes: Int
    let compressed: Bool
  }

  struct CodecError: LocalizedError {
    let code: String
    var errorDescription: String? { code }
  }

  typealias Progress = (_ stage: String, _ done: Int, _ total: Int) -> Void

  static let frameHeader: [UInt8] = [0x00, 0x5A, 0x01]
  private static let bufferSize = 64 * 1024

  static func encrypt(source: String, key: SymmetricKey, target: String, progress: Progress = { _, _, _ in })
    throws -> Result
  {
    guard FileManager.default.fileExists(atPath: source) else { throw CodecError(code: "SOURCE_MISSING") }
    let db = try Data(contentsOf: URL(fileURLWithPath: source), options: .alwaysMapped)
    var frame = Data(frameHeader)
    progress("encrypt", 0, db.count)
    try process(COMPRESSION_STREAM_ENCODE, input: db, from: 0, stage: "encrypt", progress: progress) {
      frame.append($0)
    }
    guard let combined = try AES.GCM.seal(frame, using: key).combined else {
      throw CodecError(code: "ENCRYPT_FAILED")
    }
    try replace(target) { try combined.write(to: URL(fileURLWithPath: $0)) }
    progress("encrypt", db.count, db.count)
    return Result(dbBytes: db.count, storedBytes: combined.count, compressed: true)
  }

  static func decrypt(source: String, key: SymmetricKey, target: String, progress: Progress = { _, _, _ in })
    throws -> Result
  {
    guard FileManager.default.fileExists(atPath: source) else { throw CodecError(code: "SOURCE_MISSING") }
    let stored = try Data(contentsOf: URL(fileURLWithPath: source), options: .alwaysMapped)
    guard stored.count >= 12 else { throw CodecError(code: "INVALID_IV") }
    progress("decrypt", 0, stored.count)
    let plain = try AES.GCM.open(try AES.GCM.SealedBox(combined: stored), using: key)
    let compressed = plain.count >= frameHeader.count && plain[plain.startIndex] == frameHeader[0]
      && plain[plain.startIndex + 1] == frameHeader[1]
    var written = 0
    try replace(target) { partial in
      guard compressed else {
        try plain.write(to: URL(fileURLWithPath: partial))
        written = plain.count
        return
      }
      let codec = plain[plain.startIndex + 2]
      guard codec == frameHeader[2] else { throw CodecError(code: "unknown_compression_codec:\(codec)") }
      FileManager.default.createFile(atPath: partial, contents: nil)
      let handle = try FileHandle(forWritingTo: URL(fileURLWithPath: partial))
      defer { try? handle.close() }
      try process(COMPRESSION_STREAM_DECODE, input: plain, from: frameHeader.count, stage: nil, progress: progress) {
        try handle.write(contentsOf: $0)
        written += $0.count
      }
    }
    progress("decrypt", stored.count, stored.count)
    return Result(dbBytes: written, storedBytes: stored.count, compressed: compressed)
  }

  /// One library change as stored (LIB-FMT-07): `iv(12) || AES-256-GCM(frame or v1 plain JSON) || tag(16)` -> the
  /// change's JSON bytes. Throws the cipher's error for a wrong key, `CodecError` for a frame this build cannot read.
  static func openPayload(_ envelope: Data, key: SymmetricKey) throws -> Data {
    let plain = try AES.GCM.open(try AES.GCM.SealedBox(combined: envelope), using: key)
    guard plain.count >= frameHeader.count, plain[plain.startIndex] == frameHeader[0],
      plain[plain.startIndex + 1] == frameHeader[1]
    else { return plain }
    let codec = plain[plain.startIndex + 2]
    guard codec == frameHeader[2] else { throw CodecError(code: "unknown_compression_codec:\(codec)") }
    var json = Data(capacity: plain.count * 4)
    try process(COMPRESSION_STREAM_DECODE, input: plain, from: frameHeader.count, stage: nil, progress: { _, _, _ in }) {
      json.append($0)
    }
    return json
  }

  /// Writes through `<target>.partial` and renames it over `target`, so a failure never leaves a truncated file.
  private static func replace(_ target: String, _ write: (String) throws -> Void) throws {
    let url = URL(fileURLWithPath: target)
    try FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    let partial = target + ".partial"
    try? FileManager.default.removeItem(atPath: partial)
    do {
      try write(partial)
      if FileManager.default.fileExists(atPath: target) {
        _ = try FileManager.default.replaceItemAt(url, withItemAt: URL(fileURLWithPath: partial))
      } else {
        try FileManager.default.moveItem(atPath: partial, toPath: target)
      }
    } catch {
      try? FileManager.default.removeItem(atPath: partial)
      throw error
    }
  }

  /// Runs a raw-DEFLATE stream over `input[from...]`, handing each output buffer to `sink`. `stage` reports input
  /// progress (encode); decode reports nothing per buffer.
  private static func process(
    _ operation: compression_stream_operation, input: Data, from offset: Int, stage: String?,
    progress: Progress, sink: (Data) throws -> Void
  ) throws {
    let stream = UnsafeMutablePointer<compression_stream>.allocate(capacity: 1)
    defer { stream.deallocate() }
    guard compression_stream_init(stream, operation, COMPRESSION_ZLIB) == COMPRESSION_STATUS_OK else {
      throw CodecError(code: "COMPRESSION_INIT_FAILED")
    }
    defer { compression_stream_destroy(stream) }
    let output = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
    defer { output.deallocate() }
    let total = input.count - offset
    var lastReportedPct = -1
    try input.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
      guard let base = raw.bindMemory(to: UInt8.self).baseAddress else { throw CodecError(code: "EMPTY_INPUT") }
      stream.pointee.src_ptr = base + offset
      stream.pointee.src_size = total
      let flags = operation == COMPRESSION_STREAM_ENCODE ? Int32(COMPRESSION_STREAM_FINALIZE.rawValue) : 0
      while true {
        stream.pointee.dst_ptr = output
        stream.pointee.dst_size = bufferSize
        let status = compression_stream_process(stream, flags)
        let produced = bufferSize - stream.pointee.dst_size
        if status == COMPRESSION_STATUS_ERROR {
          throw CodecError(code: operation == COMPRESSION_STREAM_DECODE ? "corrupt_compressed_frame" : "COMPRESSION_FAILED")
        }
        if produced > 0 { try sink(Data(bytes: output, count: produced)) }
        if let stage, total > 0 {
          let consumed = total - stream.pointee.src_size
          let pct = consumed * 100 / total
          if pct / 5 != lastReportedPct / 5 {
            lastReportedPct = pct
            progress(stage, consumed, total)
          }
        }
        if status == COMPRESSION_STATUS_END { return }
        // Decode with all input consumed and nothing produced: the deflate stream is truncated.
        if operation == COMPRESSION_STREAM_DECODE && produced == 0 && stream.pointee.src_size == 0 {
          throw CodecError(code: "corrupt_compressed_frame")
        }
      }
    }
  }
}
